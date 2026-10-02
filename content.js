/**
 * Conservative WhatsApp DOM adapter. An observed outgoing bubble is NOT delivery.
 * Copyright (c) 2026 Fajar BC. Licensed under MIT.
 */
(() => {
  if (window.__waSchedulerRegistered) return;
  window.__waSchedulerRegistered = true;
  let busy = false;
  let cancelled = false;
  let inserting = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (el) => (el?.innerText ?? el?.textContent ?? "").replace(/\r\n?/g, "\n");
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  function captureChatTitle() {
    const el = document.querySelector('#main header span[data-testid="conversation-info-header-chat-title"]') ||
      document.querySelector('#main header span[title]');
    return (el?.getAttribute("title") || text(el)).trim();
  }
  function composer() {
    return document.querySelector('#main footer div[contenteditable="true"]');
  }
  function fail(outcome, error) { return { outcome, error, ok: false }; }
  function hasDraft(el) {
    return Boolean(el && (el.textContent || el.querySelector("img,video,audio,[data-lexical-decorator]")));
  }
  function outgoing() {
    return Array.from(document.querySelectorAll("#main .message-out")).map((el) => ({
      id: el.closest("[data-id]")?.getAttribute("data-id") || el.getAttribute("data-id"),
      text: text(el.querySelector(".selectable-text")),
    })).filter((item) => item.id);
  }
  async function openTarget(target) {
    if (same(captureChatTitle(), target)) return;
    const search = document.querySelector('#side input[aria-label="Search or start a new chat"]') ||
      document.querySelector('#side div[contenteditable="true"][data-tab="3"]') ||
      document.querySelector('#side div[contenteditable="true"]');
    if (!search) throw new Error("Search box not found. WhatsApp's layout may have changed.");
    search.focus();
    if (search.tagName === "INPUT") {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(search, target);
    } else {
      inserting = true;
      try {
        document.execCommand("selectAll");
        document.execCommand("insertText", false, target);
      } finally { inserting = false; }
    }
    search.dispatchEvent(new Event("input", { bubbles: true }));
    // Wait for search to settle; never send to the unverified first result.
    await sleep(1000);
    for (let i = 0; i < 20; i++) {
      if (cancelled) throw new Error("Cancelled before opening chat.");
      const matches = Array.from(document.querySelectorAll("#pane-side span[title]"))
        .filter((el) => same(el.getAttribute("title") || "", target));
      const rows = [...new Set(matches.map((el) => el.closest('[role="row"]') || el.parentElement))];
      if (rows.length > 1) throw new Error("Multiple chats have this name. Use a unique chat name.");
      if (rows.length === 1) {
        rows[0].click();
        for (let j = 0; j < 20; j++) {
          if (cancelled) throw new Error("Cancelled while opening chat.");
          if (same(captureChatTitle(), target) && composer()) return;
          await sleep(250);
        }
        throw new Error("Could not verify the target chat.");
      }
      await sleep(250);
    }
    throw new Error("Exact target chat not found.");
  }
  async function doSendFlow(target, message) {
    if (busy) return fail("blocked", "Another send is using WhatsApp. Retry manually after it finishes.");
    if (typeof target !== "string" || !target.trim() || typeof message !== "string" || !message.trim()) {
      return fail("blocked", "Target and message are required.");
    }
    busy = true; cancelled = false;
    let dispatched = false;
    let userInteracted = false;
    const onInput = (event) => {
      // execCommand emits a browser-trusted input event synchronously.
      if (event.isTrusted && !(inserting && event.type === "input")) userInteracted = true;
    };
    document.addEventListener("pointerdown", onInput, true);
    document.addEventListener("keydown", onInput, true);
    document.addEventListener("input", onInput, true);
    try {
      await openTarget(target);
      if (cancelled) return fail("cancelled", "Cancelled before composing.");
      if (userInteracted) return fail("blocked", "WhatsApp was used during preparation. Retry when idle.");
      const box = composer();
      if (!box || !same(captureChatTitle(), target)) return fail("blocked", "Target chat changed.");
      if (hasDraft(box)) return fail("blocked", "Existing draft left untouched. Save or remove it before retrying.");
      const before = new Set(outgoing().map((item) => item.id));
      box.focus();
      // Insert as one text operation, then verify instead of assuming newline handling worked.
      let inserted;
      inserting = true;
      try { inserted = document.execCommand("insertText", false, message); }
      finally { inserting = false; }
      if (!inserted) {
        return fail("blocked", "Could not insert message. Check the composer before retrying.");
      }
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(250);
      if (cancelled) return fail("cancelled", "Cancelled before Enter; check the unsent composer text.");
      if (userInteracted || !box.isConnected || composer() !== box ||
          !same(captureChatTitle(), target) || text(box) !== message) {
        return fail("blocked", "Composer or chat changed. Nothing was sent by the scheduler; inspect the draft.");
      }
      // No await between final checks and dispatch.
      dispatched = true;
      box.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13,
      }));
      for (let i = 0; i < 60; i++) {
        if (userInteracted || !same(captureChatTitle(), target) || cancelled) {
          return fail("unconfirmed", "Chat changed or send was interrupted after Enter. Check WhatsApp; do not blindly retry.");
        }
        const observed = outgoing().find((item) => !before.has(item.id) && item.text === message);
        if (observed && composer() === box && !text(box).trim()) {
          return { ok: true, outcome: "observed", messageId: observed.id };
        }
        await sleep(250);
      }
      return fail("unconfirmed", "No matching new outgoing message was observed. Check WhatsApp before any further action.");
    } catch (error) {
      return fail(dispatched ? "unconfirmed" : cancelled ? "cancelled" : "blocked", error.message);
    } finally {
      busy = false;
      document.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("keydown", onInput, true);
      document.removeEventListener("input", onInput, true);
    }
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "status") {
      sendResponse({
        ready: Boolean(document.querySelector("#pane-side")),
        loggedOut: Boolean(document.querySelector('canvas[aria-label="Scan me!"], div[data-ref] canvas')),
      }); return;
    }
    if (msg.action === "capture") {
      const title = captureChatTitle();
      sendResponse(title ? { ok: true, title } : { ok: false, error: "No open chat detected." }); return;
    }
    if (msg.action === "cancelSend") { cancelled = true; sendResponse({ ok: true }); return; }
    if (msg.action === "send") {
      doSendFlow(msg.target, msg.message).then(sendResponse);
      return true;
    }
  });
})();
