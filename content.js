/**
 * content.js - Injected into web.whatsapp.com
 * Handles interacting with the WhatsApp Web DOM.
 *
 * Copyright (c) 2026 Fajar BC (https://github.com/fajarbc)
 * Licensed under MIT License
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ensure React recognizes inputs by dispatching input events.
function triggerInputEvent(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function simulateType(element, text) {
  element.focus();

  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    element.value = text;
    triggerInputEvent(element);
  } else {
    // For contenteditable, document.execCommand('insertText') handles newlines poorly across browsers
    // We split by newline, insert text, and for each line break we simulate Shift+Enter
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) {
        document.execCommand("insertText", false, lines[i]);
      }
      if (i < lines.length - 1) {
        // Dispatch Shift+Enter to create a newline in WhatsApp
        element.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true, cancelable: true,
          key: "Enter", code: "Enter", keyCode: 13,
          shiftKey: true // Important for WhatsApp to register as newline instead of send
        }));
      }
    }
    triggerInputEvent(element);
  }
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
    // 1. Locate and focus the search box. WhatsApp frequently updates DOM classes.
    const searchBoxSelectors = [
      'input[aria-label="Search or start a new chat"]', // The new input element
      'div[contenteditable="true"][data-tab="3"]',      // Old fallback
      '#side div[contenteditable="true"]',
      'div[title="Search input textbox"]',
      'input[type="text"][data-tab="3"]'
    ];

    let searchBox;
    for (let i = 0; i < 30; i++) {
      for (const sel of searchBoxSelectors) {
        searchBox = document.querySelector(sel);
        if (searchBox) break;
      }
      if (searchBox) break;
      await sleep(500);
    }

    if (!searchBox) {
      throw new Error(`Could not find search box. WhatsApp may have updated its layout.`);
    }

    // Clear search box first just in case
    searchBox.focus();
    if (searchBox.tagName === "INPUT") {
      searchBox.value = "";
      triggerInputEvent(searchBox);
    } else {
      document.execCommand("selectAll");
      document.execCommand("delete");
    }
    await sleep(500);

    simulateType(searchBox, target);
    await sleep(1000); // give WA time to fetch search results

    // 2. Click the top search result simply by pressing Enter on the search box
    searchBox.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13
    }));
    await sleep(2000); // wait for chat view to load on the right

    // Verify chat opened correctly
    let chatTitleSpan = document.querySelector('span[data-testid="conversation-info-header-chat-title"]');
    if (!chatTitleSpan || chatTitleSpan.textContent.trim().toLowerCase() !== target.toLowerCase()) {
      // If pressing Enter didn't work, we try clicking the list.
      const contactSpan = await findContactInList(target);
      if (!contactSpan) {
        throw new Error(`Contact/Group '${target}' not found in search results.`);
      }
      const clickableArea = contactSpan.closest('div[role="row"]') || contactSpan.parentElement;
      clickableArea.click();
      await sleep(1500);

      // Verify again after click
      chatTitleSpan = document.querySelector('span[data-testid="conversation-info-header-chat-title"]');
    }

    // Hard fail if we are not in the correct room
    if (!chatTitleSpan || chatTitleSpan.textContent.trim().toLowerCase() !== target.toLowerCase()) {
      throw new Error(`Failed to open target chat room. Active room is: ${chatTitleSpan ? chatTitleSpan.textContent.trim() : 'Unknown'}`);
    }

    // 3. Locate the chat message box (usually the contenteditable inside footer)
    const msgBoxSelectors = [
      'footer div[contenteditable="true"]',
      '#main div[title="Type a message"]',
      '#main footer .copyable-text[contenteditable="true"]',
      '#main div[contenteditable="true"][data-tab="10"]'
    ];
    let msgBox;
    for (let i = 0; i < 30; i++) {
      for (const sel of msgBoxSelectors) {
        msgBox = document.querySelector(sel);
        if (msgBox) break;
      }
      if (msgBox) break;
      await sleep(500);
    }
    if (!msgBox) throw new Error("Could not find message input box.");

    // 4. Type the message
    simulateType(msgBox, message);
    await sleep(250);

    // 5. Send with Enter instead of relying on WhatsApp's changing send button DOM.
    msgBox.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13
    }));

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function captureChatTitle() {
  // First priority: use the exact testid attribute WhatsApp puts on the main chat room title
  const exactHeader = document.querySelector('span[data-testid="conversation-info-header-chat-title"]');
  if (exactHeader) {
    const t = (exactHeader.getAttribute('title') || exactHeader.textContent || '').trim();
    if (t) return t;
  }

  // Fallbacks scoped strictly to the #main conversation header
  const candidates = [
    document.querySelector('#main header span[data-testid="conversation-info-header-chat-title"]'),
    document.querySelector('#main header span[title]'),
    document.querySelector('#main header .copyable-text span'),
  ];
  for (const el of candidates) {
    if (el) {
      const t = (el.getAttribute('title') || el.textContent || '').trim();
      if (t) return t;
    }
  }
  return null;
}

if (!window.__waSchedulerRegistered) {
  window.__waSchedulerRegistered = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "status") {
      const isReady = !!document.querySelector('input[aria-label="Search or start a new chat"], div[contenteditable="true"][data-tab="3"], #pane-side');
      const isLoggedOut = !!document.querySelector('canvas[aria-label="Scan me!"], div[data-ref] canvas');

      sendResponse({ ready: isReady, loggedOut: isLoggedOut });
      return;
    }

    if (msg.action === "capture") {
      const title = captureChatTitle();
      sendResponse(title ? { ok: true, title } : { ok: false, error: "No open chat detected." });
      return;
    }

    if (msg.action === "send") {
      doSendFlow(msg.target, msg.message).then(sendResponse);
      return true;
    }
  });
}
