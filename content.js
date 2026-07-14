// content.js - Injected into web.whatsapp.com
// Handles interacting with the WhatsApp Web DOM.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ensure React recognizes inputs by dispatching input events.
function triggerInputEvent(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function simulateType(element, text) {
  element.focus();
  document.execCommand("insertText", false, text);
  triggerInputEvent(element);
}

// Query DOM repeatedly until element appears
async function waitForElement(selector, maxTries = 20, delayMs = 500) {
  for (let i = 0; i < maxTries; i++) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(delayMs);
  }
  throw new Error(`Timeout waiting for element: ${selector}`);
}

async function findContactInList(targetName) {
  const spans = Array.from(document.querySelectorAll('span[title]'));
  const match = spans.find((s) => s.getAttribute("title").toLowerCase() === targetName.toLowerCase());
  return match;
}

async function doSendFlow(target, message) {
  try {
    // 1. Locate and focus the search box. It usually has contenteditable and is located in the left pane (data-tab="3")
    const searchBox = await waitForElement('div[contenteditable="true"][data-tab="3"]');

    // Clear search box first just in case
    searchBox.focus();
    document.execCommand("selectAll");
    document.execCommand("delete");
    await sleep(500);

    simulateType(searchBox, target);
    await sleep(1500); // give WA time to fetch search results

    // 2. Find the contact/group in search results list and click
    const contactSpan = await findContactInList(target);
    if (!contactSpan) {
      throw new Error(`Contact/Group '${target}' not found in search results.`);
    }

    // The clickable area is usually the parent or ancestor of the span
    const clickableArea = contactSpan.closest('div[role="row"]') || contactSpan.parentElement;
    clickableArea.click();
    await sleep(1500); // wait for chat view to load on the right

    // 3. Locate the chat message box (usually the contenteditable inside footer)
    const msgBoxSelector = 'footer div[contenteditable="true"]';
    const msgBox = await waitForElement(msgBoxSelector);

    // 4. Type the message
    simulateType(msgBox, message);
    await sleep(500);

    // 5. Click the Send button
    const sendIcon = await waitForElement('span[data-icon="send"]');
    const sendButton = sendIcon.closest('button') || sendIcon.parentElement;
    sendButton.click();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "status") {
    // Check if the chat list pane exists (means we are ready).
    const isReady = !!document.querySelector('div[contenteditable="true"][data-tab="3"]');
    // Check if QR code is visible (means we are logged out).
    const isLoggedOut = !!document.querySelector('canvas[aria-label="Scan me!"]');

    sendResponse({ ready: isReady, loggedOut: isLoggedOut });
    return;
  }

  if (msg.action === "capture") {
    // We try to capture the title from the chat header
    const headerTitleSpan = document.querySelector('header span[title]');
    if (headerTitleSpan) {
      sendResponse({ ok: true, title: headerTitleSpan.getAttribute("title") });
    } else {
      sendResponse({ ok: false, error: "No open chat detected." });
    }
    return;
  }

  if (msg.action === "send") {
    // Perform automation
    doSendFlow(msg.target, msg.message).then(sendResponse);
    return true; // indicates asynchronous response
  }
});
