/**
 * Manifest V3 scheduler. All storage mutations and UI sends share one queue.
 * Copyright (c) 2026 Fajar BC. Licensed under MIT.
 */
const STORAGE_KEY = "schedules";
const RECURRING_OPTIONS = ["minute", "daily", "weekly", "monthly"];
const ACTIVE = ["pending", "running", "retrying"];
const GRACE_MS = 60000;
const MAX_RETRIES = 2;
// Each queued mutation owns a token; finishing one cannot release another's fence.
const cancelled = new Map();
function acquireCancellation(id) {
  const token = Symbol();
  if (!cancelled.has(id)) cancelled.set(id, new Set());
  cancelled.get(id).add(token);
  return token;
}
function releaseCancellation(id, token) {
  const owners = cancelled.get(id);
  if (!owners) return;
  owners.delete(token);
  if (!owners.size) cancelled.delete(id);
}
let queue = Promise.resolve();
let activeSend = null;
function enqueue(work) {
  const result = queue.then(work);
  queue = result.catch((error) => console.error("Scheduler:", error));
  return result;
}
function normalizeSchedule(s) {
  const history = (Array.isArray(s.sentHistory) ? s.sentHistory :
    Number.isFinite(s.sentAt) ? [s.sentAt] : []).filter(Number.isFinite).slice(-50);
  return { ...s, sentHistory: history,
    sendCount: Number.isInteger(s.sendCount) && s.sendCount >= 0 ? s.sendCount : history.length,
    retryCount: Number.isInteger(s.retryCount) ? s.retryCount : 0 };
}
async function getSchedules() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data[STORAGE_KEY] || []).map(normalizeSchedule);
}
const saveSchedules = (s) => chrome.storage.local.set({ [STORAGE_KEY]: s });
const alarmNameFor = (id) => "msg_" + id;
const dueAt = (s) => s.retryAt || s.nextRun || s.scheduledTime;
const activeStatus = (s) => s.recurring === "none" ? "pending" : "running";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function computeNextRun(s, now = Date.now()) {
  if (!RECURRING_OPTIONS.includes(s.recurring)) return NaN;
  const start = s.nextRun || s.scheduledTime;
  if (!Number.isFinite(start)) return NaN;
  if (s.recurring === "minute") {
    return start + Math.max(1, Math.floor((now - start) / 60000) + 1) * 60000;
  }
  const d = new Date(start);
  const anchorDay = new Date(Number.isFinite(s.scheduledTime) ? s.scheduledTime : start).getDate();
  if (s.recurring === "daily" || s.recurring === "weekly") {
    const days = s.recurring === "weekly" ? 7 : 1;
    const jumps = Math.max(0, Math.floor((now - start) / (days * 86400000)) - 1);
    d.setDate(d.getDate() + jumps * days);
    do { d.setDate(d.getDate() + days); } while (d.getTime() <= now);
  } else {
    do {
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(anchorDay, lastDay));
    } while (d.getTime() <= now);
  }
  return d.getTime();
}
async function arm(s) {
  if (!ACTIVE.includes(s.status)) return;
  const when = dueAt(s);
  if (!Number.isFinite(when)) throw new Error("Invalid schedule time.");
  await chrome.alarms.create(alarmNameFor(s.id), { when });
}
function miss(s, now = Date.now()) {
  s.lastMissedAt = s.nextRun || s.scheduledTime;
  s.error = "Missed the 60-second grace window. No catch-up message was sent.";
  s.retryCount = 0;
  delete s.retryAt;
  delete s.attempt;
  if (s.recurring === "none") s.status = "missed";
  else { s.nextRun = computeNextRun(s, now); s.status = "running"; }
}

async function reconcile() {
  const schedules = await getSchedules();
  for (const s of schedules) {
    if (s.attempt?.phase === "dispatching") {
      s.status = "unconfirmed";
      s.error = "Interrupted send: check WhatsApp before skipping this occurrence. It will not be retried.";
      delete s.retryAt;
    } else if (s.attempt?.phase === "preparing") {
      delete s.attempt; // No send request was dispatched.
    }
    if (ACTIVE.includes(s.status) && dueAt(s) < Date.now() - GRACE_MS) miss(s);
    if (ACTIVE.includes(s.status) && !Number.isFinite(dueAt(s))) {
      s.status = "failed"; s.error = "Invalid persisted schedule time.";
    }
  }
  // Persist recovery decisions BEFORE changing alarms.
  await saveSchedules(schedules);
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    if (!alarm.name.startsWith("msg_")) continue;
    const s = schedules.find((item) => alarmNameFor(item.id) === alarm.name);
    if (!s || !ACTIVE.includes(s.status)) await chrome.alarms.clear(alarm.name);
  }
  for (const s of schedules.filter((item) => ACTIVE.includes(item.status))) {
    const alarm = alarms.find((item) => item.name === alarmNameFor(s.id));
    if (!alarm || alarm.scheduledTime !== dueAt(s)) await arm(s);
  }
}
async function ensureWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  let tab = tabs.find((item) => item.active) || tabs[0];
  if (tab) {
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    tab = await chrome.tabs.update(tab.id, { active: true });
  } else tab = await chrome.tabs.create({ url: "https://web.whatsapp.com/", active: true });
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); }
  catch { /* Manifest injection handles tabs still navigating. */ }
  return tab;
}
async function waitForReady(tabId, id) {
  for (let i = 0; i < 40; i++) {
    if (cancelled.has(id)) return { outcome: "cancelled" };
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: "status" });
      if (res?.loggedOut) return { outcome: "login_required", error: "Log into WhatsApp, then retry." };
      if (res?.ready) return { outcome: "ready" };
    } catch { /* Wait for content script. */ }
    await sleep(1000);
  }
  return { outcome: "retryable", error: "WhatsApp did not become ready before sending." };
}
async function execute(id, alarmTime) {
  if (cancelled.has(id)) return;
  const schedules = await getSchedules();
  const s = schedules.find((item) => item.id === id);
  if (!s || !ACTIVE.includes(s.status)) return;
  if (s.attempt?.phase === "dispatching") {
    s.status = "unconfirmed";
    s.error = "Previous dispatch has no durable result. Check WhatsApp; no automatic retry.";
    await saveSchedules(schedules);
    await chrome.alarms.clear(alarmNameFor(id));
    return;
  }
  // A consumed/stale callback must not execute a later occurrence.
  if (alarmTime !== undefined && alarmTime !== dueAt(s)) return;
  if (dueAt(s) > Date.now()) { await arm(s); return; }
  if (dueAt(s) < Date.now() - GRACE_MS) {
    miss(s); await saveSchedules(schedules); await arm(s); return;
  }
  s.attempt = { key: crypto.randomUUID(), occurrence: s.nextRun || s.scheduledTime, phase: "preparing" };
  await saveSchedules(schedules);
  let result;
  try {
    const tab = await ensureWhatsAppTab();
    result = await waitForReady(tab.id, id);
    if (result.outcome === "ready" && !cancelled.has(id)) {
      if (dueAt(s) < Date.now() - GRACE_MS) {
        miss(s); await saveSchedules(schedules); await arm(s); return;
      }
      s.attempt.phase = "dispatching";
      // A crash after this durable marker is ambiguous, never an automatic retry.
      await saveSchedules(schedules);
      if (cancelled.has(id)) result = { outcome: "cancelled" };
      else {
        activeSend = { id, tabId: tab.id };
        result = await chrome.tabs.sendMessage(tab.id, {
          action: "send", attemptKey: s.attempt.key, target: s.target, message: s.message,
        });
      }
    }
  } catch (error) {
    result = { outcome: s.attempt?.phase === "dispatching" ? "unconfirmed" : "retryable",
      error: String(error.message || error) };
  } finally { activeSend = null; }
  const outcome = result?.outcome === "observed" && !result.messageId
    ? "unconfirmed" : result?.outcome || "unconfirmed";
  s.lastOutcome = outcome;
  s.lastAttemptAt = Date.now();
  delete s.retryAt;
  if (outcome === "observed") {
    const now = Date.now();
    s.sentAt = now; s.sendCount += 1;
    s.sentHistory = [...s.sentHistory, now].slice(-50);
    s.lastMessageId = result.messageId;
    s.retryCount = 0;
    delete s.error; delete s.attempt;
    if (s.recurring === "none") s.status = "sent";
    else { s.nextRun = computeNextRun(s); s.status = "running"; }
  } else if (outcome === "cancelled" || cancelled.has(id) && outcome === "ready") {
    delete s.attempt; s.status = activeStatus(s);
    s.error = "Stopped before sending.";
  } else if (outcome === "retryable" && !cancelled.has(id) && s.retryCount < MAX_RETRIES) {
    delete s.attempt;
    s.retryCount += 1; s.status = "retrying";
    s.retryAt = Date.now() + 30000 * 2 ** (s.retryCount - 1);
    s.error = result.error || "Pre-send failure; retry scheduled.";
  } else {
    s.status = outcome === "login_required" ? "login_required" :
      ["blocked", "retryable"].includes(outcome) ? "failed" : "unconfirmed";
    s.error = result?.error || "Send not confirmed. Check WhatsApp; no automatic retry.";
    if (s.status !== "unconfirmed") delete s.attempt;
  }
  if (cancelled.has(id) && ACTIVE.includes(s.status)) {
    // Persist a blocked state BEFORE the queued edit/stop/delete runs. A worker
    // restart must not revive the occurrence in this intermediate snapshot.
    s.status = "stopped";
    s.cancellationPending = true;
    delete s.retryAt;
  }
  await saveSchedules(schedules);
  if (!cancelled.has(id)) await arm(s);
}
const executeSchedule = (id, alarmTime) => enqueue(() => execute(id, alarmTime));

async function handleMessage(msg) {
  const schedules = await getSchedules();
  const s = schedules.find((item) => item.id === msg.id);
  const validTime = (time) => Number.isFinite(time) && time > Date.now();
  if (msg.action === "createSchedule") {
    const input = msg.schedule || {};
    if (typeof input.id !== "string" || !input.id || schedules.some((item) => item.id === input.id) ||
        typeof input.target !== "string" || !input.target.trim() ||
        typeof input.message !== "string" || !input.message.trim() ||
        !["none", ...RECURRING_OPTIONS].includes(input.recurring) || !validTime(input.scheduledTime)) {
      throw new Error("Invalid schedule.");
    }
    const created = normalizeSchedule({ id: input.id, target: input.target.trim(),
      targetType: "name", message: input.message.trim(), recurring: input.recurring,
      scheduledTime: input.scheduledTime, nextRun: input.scheduledTime,
      status: input.recurring === "none" ? "pending" : "running" });
    schedules.push(created); await saveSchedules(schedules); await arm(created);
  } else if (msg.action === "clearHistory") {
    await saveSchedules(schedules.filter((item) => !["sent", "reviewed"].includes(item.status)));
  } else {
    if (!s) throw new Error("Schedule not found.");
    // Result persistence can fail without restarting the worker. Mutations must
    // honor the durable dispatch marker too, not just execute()/reconcile().
    if (s.attempt?.phase === "dispatching" && s.status !== "unconfirmed") {
      s.status = "unconfirmed";
      s.error = "Previous dispatch has no durable result. Review it in WhatsApp before continuing.";
      delete s.retryAt;
      await saveSchedules(schedules);
    }
    await chrome.alarms.clear(alarmNameFor(s.id));
    if (msg.action === "deleteSchedule") {
      await saveSchedules(schedules.filter((item) => item.id !== s.id)); return { ok: true };
    }
    if (msg.action === "stopSchedule") {
      if (ACTIVE.includes(s.status)) s.status = "stopped";
      // Preserve ambiguous evidence even if the user presses Stop.
    } else if (msg.action === "updateSchedule") {
      const editable = ["running", "retrying", "pending"].includes(s.status) ||
        (s.status === "stopped" && s.cancellationPending === true);
      if (!editable || s.recurring === "none" ||
          !RECURRING_OPTIONS.includes(msg.recurring) || !validTime(msg.nextRun) ||
          typeof msg.message !== "string" || !msg.message.trim()) {
        await arm(s); throw new Error("Only active recurring schedules can be edited with a future time.");
      }
      s.message = msg.message.trim(); s.recurring = msg.recurring;
      s.scheduledTime = msg.nextRun; s.nextRun = msg.nextRun; s.status = "running";
      s.retryCount = 0; delete s.error; delete s.attempt;
    } else if (msg.action === "resumeSchedule") {
      if (!["failed", "login_required", "missed", "stopped"].includes(s.status) || !validTime(msg.nextRun)) {
        await arm(s); throw new Error("Choose a recoverable schedule and a future time.");
      }
      s.nextRun = msg.nextRun; s.status = activeStatus(s);
      s.retryCount = 0; delete s.error; delete s.attempt;
    } else if (msg.action === "skipUnconfirmed") {
      if (s.status !== "unconfirmed" || msg.reviewed !== true) {
        await arm(s); throw new Error("Review the uncertain send in WhatsApp first.");
      }
      s.lastUnconfirmedAt = s.lastAttemptAt || Date.now();
      delete s.attempt;
      if (s.recurring === "none") s.status = "reviewed";
      else { s.nextRun = computeNextRun(s); s.status = "running"; }
      s.error = "Uncertain occurrence reviewed and skipped, not counted as confirmed.";
    } else {
      await arm(s); throw new Error("Unknown action.");
    }
    delete s.cancellationPending;
    delete s.retryAt;
    await saveSchedules(schedules); await arm(s);
  }
  return { ok: true };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("msg_")) executeSchedule(alarm.name.slice(4), alarm.scheduledTime).catch(() => {});
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const actions = ["createSchedule", "updateSchedule", "stopSchedule", "deleteSchedule",
    "clearHistory", "resumeSchedule", "skipUnconfirmed"];
  if (!actions.includes(msg.action)) { sendResponse({ ok: false, error: "Unknown action." }); return; }
  const cancels = ["updateSchedule", "stopSchedule", "deleteSchedule"].includes(msg.action);
  const cancellationToken = cancels ? acquireCancellation(msg.id) : null;
  if (cancels) {
    if (activeSend?.id === msg.id) {
      chrome.tabs.sendMessage(activeSend.tabId, { action: "cancelSend" }).catch(() => {});
    }
  }
  enqueue(async () => {
    try { return await handleMessage(msg); }
    finally { if (cancels) releaseCancellation(msg.id, cancellationToken); }
  }).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.runtime.onStartup.addListener(() => enqueue(reconcile).catch(() => {}));
chrome.runtime.onInstalled.addListener(() => enqueue(reconcile).catch(() => {}));
// Also runs on a service-worker restart, not just a browser restart.
enqueue(reconcile).catch(() => {});
