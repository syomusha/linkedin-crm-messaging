const statusEl = document.getElementById("status");
const webhookInput = document.getElementById("webhookUrl");

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Ask the page for extracted LinkedIn data
async function extractFromLinkedIn(tabId, extractAll = false) {
  return await chrome.scripting.executeScript({
    target: { tabId },
    func: (extractAllMessages) => {
      // Best-effort selectors (LinkedIn changes often)
      const getText = (el) => (el ? el.textContent.trim() : "");

      // Thread URL
      const threadUrl = location.href;

      // Attempt to find the "other party" name in header
      const nameCandidates = [
        document.querySelector("h2"),
        document.querySelector("[data-control-name='thread_details_name']"),
        document.querySelector(".msg-thread__link-to-profile"),
        document.querySelector(".msg-thread__name"),
      ];
      const otherPartyName =
        nameCandidates.map(getText).find((t) => t && t.length < 80) || "";

      // Attempt to find profile URL from "View profile" link or header anchor
      const linkCandidates = Array.from(document.querySelectorAll("a")).filter(
        (a) => a.href && a.href.includes("linkedin.com/in/"),
      );

      // Prefer link near messaging header
      let profileUrl = "";
      for (const a of linkCandidates) {
        // heuristics: visible text includes name or "View profile"
        const t = (a.textContent || "").toLowerCase();
        if (
          t.includes("view") ||
          t.includes("profile") ||
          (otherPartyName &&
            t.includes(otherPartyName.toLowerCase().split(" ")[0]))
        ) {
          profileUrl = a.href;
          break;
        }
      }
      if (!profileUrl && linkCandidates.length)
        profileUrl = linkCandidates[0].href;

      // Extract messages
      let lastMessage = "";
      let allMessages = [];

      if (extractAllMessages) {
        // Debug: Log what we're working with
        console.log("=== LinkedIn Message Extraction Debug ===");

        // Try to extract all messages with sender info
        // Try multiple selectors as LinkedIn structure varies
        const msgContainers = Array.from(
          document.querySelectorAll(
            ".msg-s-event-listitem, .msg-s-message-list__event, [class*='msg-s-event']",
          ),
        );

        console.log(`Found ${msgContainers.length} message containers`);

        allMessages = msgContainers
          .map((container, index) => {
            // Try multiple selectors for message text
            let messageText = "";
            const textSelectors = [
              ".msg-s-event-listitem__body",
              ".msg-s-message-group__text",
              ".msg-s-event-listitem__message-bubble",
              "[class*='message-body']",
              "[class*='msg-s-event-listitem__body']",
            ];

            for (const selector of textSelectors) {
              const el = container.querySelector(selector);
              if (el?.innerText?.trim()) {
                messageText = el.innerText.trim();
                console.log(
                  `Message ${index + 1} found with selector: ${selector}`,
                );
                break;
              }
            }

            // If no text found with selectors, try container's innerText as fallback
            if (!messageText) {
              messageText = container.innerText?.trim() || "";
              if (messageText) {
                console.log(
                  `Message ${index + 1} found with fallback innerText`,
                );
              }
            }

            // Try to determine if it's from the user or the other party
            // LinkedIn uses different classes for sent vs received messages
            const isSent =
              container.closest(".msg-s-message-list__event--outgoing") !==
                null ||
              container.classList.contains(
                "msg-s-message-list__event--outgoing",
              ) ||
              container.querySelector("[class*='outgoing']") !== null;
            const sender = isSent ? "You" : otherPartyName || "Other";

            // Try to get timestamp if available
            const timeEl = container.querySelector("time");
            const timestamp = timeEl
              ? timeEl.getAttribute("datetime") || timeEl.textContent.trim()
              : "";

            console.log(
              `Message ${index + 1}: sender=${sender}, textLength=${messageText.length}`,
            );

            return {
              index: index + 1,
              sender,
              message: messageText,
              timestamp,
              direction: isSent ? "Outbound" : "Inbound",
            };
          })
          .filter((msg) => msg.message && msg.message.length > 0);

        console.log(
          `After filtering: ${allMessages.length} messages with content`,
        );
        console.log("=== End Debug ===");
      } else {
        // Attempt to find the latest message bubble text
        // LinkedIn message bubbles vary; try common containers
        const msgCandidates = Array.from(
          document.querySelectorAll(
            ".msg-s-event-listitem__body, .msg-s-message-list__event, .msg-s-event-listitem",
          ),
        ).slice(-10);

        for (let i = msgCandidates.length - 1; i >= 0; i--) {
          const t = msgCandidates[i].innerText?.trim();
          if (t && t.length > 0) {
            lastMessage = t;
            break;
          }
        }
      }

      return {
        profileUrl,
        otherPartyName,
        threadUrl,
        message: lastMessage,
        allMessages: extractAllMessages ? allMessages : [],
      };
    },
    args: [extractAll],
  });
}

async function loadSavedWebhook() {
  const { webhookUrl } = await chrome.storage.sync.get(["webhookUrl"]);
  if (webhookUrl) webhookInput.value = webhookUrl;
}

async function saveWebhook(url) {
  await chrome.storage.sync.set({ webhookUrl: url });
}

document.getElementById("logBtn").addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;

    const webhookUrl = webhookInput.value.trim();
    if (!webhookUrl) {
      setStatus("Please paste your Apps Script Web App URL first.");
      return;
    }
    await saveWebhook(webhookUrl);

    const [result] = await extractFromLinkedIn(tab.id);
    const extracted = result?.result || {};

    // Fill UI if blank (so user sees what we got)
    const profileUrlEl = document.getElementById("profileUrl");
    const otherPartyEl = document.getElementById("otherPartyName");
    const threadUrlEl = document.getElementById("threadUrl");
    const messageEl = document.getElementById("message");

    if (!profileUrlEl.value) profileUrlEl.value = extracted.profileUrl || "";
    if (!otherPartyEl.value)
      otherPartyEl.value = extracted.otherPartyName || "";
    if (!threadUrlEl.value) threadUrlEl.value = extracted.threadUrl || "";
    if (!messageEl.value) messageEl.value = extracted.message || "";

    const payload = {
      platform: "linkedin",
      direction: document.getElementById("direction").value,
      personType: document.getElementById("personType").value, // optional override
      profileUrl: profileUrlEl.value.trim(),
      otherPartyName: otherPartyEl.value.trim(),
      threadUrl: threadUrlEl.value.trim(),
      message: messageEl.value.trim(),
    };

    // Display the payload in the message field
    messageEl.value = JSON.stringify(payload, null, 2);

    if (!payload.profileUrl) {
      setStatus(
        "Couldn't detect profile URL. Click into the person's profile or ensure their /in/ link is visible, then try again.",
      );
      return;
    }

    setStatus("Sending to CRM...");

    // CORS note: Apps Script web app often won’t allow reading response cross-origin.
    // Using no-cors still sends the request; we treat it as success if fetch doesn't throw.
    await fetch(webhookUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setStatus("Sent ✅ (check your CH tab + WebhookLogs)");
  } catch (err) {
    setStatus("Error: " + (err?.message || String(err)));
  }
});

// Extract All Messages button handler
document.getElementById("extractBtn").addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;

    setStatus("Extracting all messages...");

    const [result] = await extractFromLinkedIn(tab.id, true);
    const extracted = result?.result || {};

    // Fill basic fields
    const profileUrlEl = document.getElementById("profileUrl");
    const otherPartyEl = document.getElementById("otherPartyName");
    const threadUrlEl = document.getElementById("threadUrl");
    const messageEl = document.getElementById("message");

    if (!profileUrlEl.value) profileUrlEl.value = extracted.profileUrl || "";
    if (!otherPartyEl.value)
      otherPartyEl.value = extracted.otherPartyName || "";
    if (!threadUrlEl.value) threadUrlEl.value = extracted.threadUrl || "";

    // Display all messages in the message field
    if (extracted.allMessages && extracted.allMessages.length > 0) {
      const formattedMessages = extracted.allMessages
        .map(
          (msg) =>
            `[${msg.index}] ${msg.sender} (${msg.direction})${msg.timestamp ? " - " + msg.timestamp : ""}:\n${msg.message}`,
        )
        .join("\n\n" + "=".repeat(50) + "\n\n");

      messageEl.value = formattedMessages;
      setStatus(`Extracted ${extracted.allMessages.length} messages ✅`);
    } else {
      messageEl.value = "No messages found";
      setStatus("No messages found");
    }
  } catch (err) {
    setStatus("Error: " + (err?.message || String(err)));
  }
});

// Latest Message button handler
document.getElementById("latestBtn").addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;

    setStatus("Fetching latest message...");

    const [result] = await extractFromLinkedIn(tab.id, false);
    const extracted = result?.result || {};

    const messageEl = document.getElementById("message");
    if (extracted.message) {
      messageEl.value = extracted.message;
      setStatus("Latest message loaded ✅");
    } else {
      messageEl.value = "";
      setStatus("No message found");
    }
  } catch (err) {
    setStatus("Error: " + (err?.message || String(err)));
  }
});

loadSavedWebhook();
