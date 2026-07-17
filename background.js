/**
 * background.js - Manifest V3 service worker
 * Handles alarms, opens/navigates WhatsApp Web, and orchestrates sending.
 *
 * Copyright (c) 2026 Fajar BC (https://github.com/fajarbc)
 * Licensed under MIT License
 */

const WHATSAPP_URL = "https://web.whatsapp.com/";
const STORAGE_KEY = "schedules";
const cancelledScheduleIds = new Set();
const runningExecutions = new Map();
const RECURRING_OPTIONS = ["minute", "daily", "weekly", "monthly"];
const HISTORY_LIMIT = 50;

function normalizeSchedule(schedule) {
  const legacyHistory = Number.isFinite(schedule.sentAt) ? [schedule.sentAt] : [];
  const sentHistory = Array.isArray(schedule.sentHistory)
    ? schedule.sentHistory.filter(Number.isFinite).slice(-HISTORY_LIMIT)
    : legacyHistory;

  return {
    ...schedule,
    sendCount: Number.isInteger(schedule.sendCount) && schedule.sendCount >= 0
      ? schedule.sendCount
      : sentHistory.length,
    sentHistory,
  };
}

async function getSchedules() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data[STORAGE_KEY] || []).map(normalizeSchedule);
}

async function saveSchedules(schedules) {
  await chrome.storage.local.set({ [STORAGE_KEY]: schedules });
}

function alarmNameFor(id) {
  return "msg_" + id;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  let tab;

  if (tabs.length > 0) {
    tab = tabs.find((item) => item.active) || tabs[0];
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    tab = await chrome.tabs.update(tab.id, { active: true });
  } else {
    tab = await chrome.tabs.create({ url: WHATSAPP_URL, active: true });
  }

  // Ensure content script is injected even for pre-existing tabs
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } catch (e) {
    // might fail if it's still navigating, that's fine, manifest handles auto-inject on load
  }

  return tab;
}

async function waitForWhatsAppReady(tabId, timeoutMs = 45000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: "status" });
      if (res?.ready) return true;
      if (res?.loggedOut) return false;
    } catch (e) {
      // The tab or content script may still be loading.
    }
    await sleep(1000);
  }

  return false;
}

function computeNextRun(schedule) {
  if (!RECURRING_OPTIONS.includes(schedule.recurring)) return NaN;
  const d = new Date(schedule.nextRun || schedule.scheduledTime);

  do {
    if (schedule.recurring === "minute") d.setMinutes(d.getMinutes() + 1);
    if (schedule.recurring === "daily") d.setDate(d.getDate() + 1);
    if (schedule.recurring === "weekly") d.setDate(d.getDate() + 7);
    if (schedule.recurring === "monthly") d.setMonth(d.getMonth() + 1);
  } while (d.getTime() <= Date.now());

  return d.getTime();
}

async function executeSchedule(id) {
  const execution = (async () => {
    const schedules = await getSchedules();
    const schedule = schedules.find((item) => item.id === id);
    const runnable = schedule?.recurring === "none"
      ? schedule.status === "pending"
      : ["pending", "running"].includes(schedule?.status);
    if (!runnable || cancelledScheduleIds.has(id)) return;

    const tab = await ensureWhatsAppTab();
    await sleep(3000);
    if (cancelledScheduleIds.has(id)) return;

    const ready = await waitForWhatsAppReady(tab.id);
    if (cancelledScheduleIds.has(id)) return;
    if (!ready) {
      schedule.status = "failed";
      schedule.error = "WhatsApp Web is not ready. Log in once, then leave Chrome able to open web.whatsapp.com.";
    } else {
      try {
        if (cancelledScheduleIds.has(id)) return;
        const res = await chrome.tabs.sendMessage(tab.id, {
          action: "send",
          target: schedule.target,
          targetType: schedule.targetType,
          message: schedule.message,
        });

        if (res?.ok) {
          const sentAt = Date.now();
          schedule.status = "sent";
          schedule.sentAt = sentAt;
          schedule.sendCount += 1;
          // ponytail: keep recent history bounded; use IndexedDB if a full audit trail is needed.
          schedule.sentHistory = [...schedule.sentHistory, sentAt].slice(-HISTORY_LIMIT);
        } else {
          schedule.status = "failed";
          schedule.error = res?.error || "Send failed.";
        }
      } catch (e) {
        schedule.status = "failed";
        schedule.error = String(e?.message || e);
      }
    }

    if (cancelledScheduleIds.has(id)) {
      if (schedule.recurring !== "none") {
        schedule.status = "running";
        const currentSchedules = await getSchedules();
        await saveSchedules(currentSchedules.map((item) => item.id === id ? schedule : item));
      }
      return;
    }
    const currentSchedules = await getSchedules();
    if (!currentSchedules.some((item) => item.id === id)) return;

    if (schedule.recurring !== "none" && schedule.status === "sent") {
      schedule.nextRun = computeNextRun(schedule);
      schedule.status = "running";
      chrome.alarms.create(alarmNameFor(schedule.id), { when: schedule.nextRun });
    }

    await saveSchedules(currentSchedules.map((item) => item.id === id ? schedule : item));
  })();

  runningExecutions.set(id, execution);
  try {
    await execution;
  } finally {
    if (runningExecutions.get(id) === execution) runningExecutions.delete(id);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("msg_")) return;
  executeSchedule(alarm.name.replace("msg_", ""));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.action === "createSchedule") {
      cancelledScheduleIds.delete(msg.schedule.id);
      const schedules = await getSchedules();
      schedules.push(msg.schedule);
      await saveSchedules(schedules);
      chrome.alarms.create(alarmNameFor(msg.schedule.id), { when: msg.schedule.scheduledTime });
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "updateSchedule") {
      const message = String(msg.message || "").trim();
      const nextRun = Number(msg.nextRun);
      if (!message || !RECURRING_OPTIONS.includes(msg.recurring) || !Number.isFinite(nextRun) || nextRun <= Date.now()) {
        sendResponse({ ok: false, error: "Invalid schedule update." });
        return;
      }

      cancelledScheduleIds.add(msg.id);
      try {
        await chrome.alarms.clear(alarmNameFor(msg.id));
        const running = runningExecutions.get(msg.id);
        if (running) await running;

        const schedules = await getSchedules();
        const schedule = schedules.find((item) =>
          item.id === msg.id && ["pending", "running"].includes(item.status) && RECURRING_OPTIONS.includes(item.recurring)
        );
        if (!schedule) {
          sendResponse({ ok: false, error: "Only Running recurring schedules can be edited." });
          return;
        }

        schedule.status = "running";
        schedule.message = message;
        schedule.recurring = msg.recurring;
        schedule.scheduledTime = nextRun;
        schedule.nextRun = nextRun;
        delete schedule.error;
        await saveSchedules(schedules);
        chrome.alarms.create(alarmNameFor(msg.id), { when: nextRun });
        sendResponse({ ok: true });
      } finally {
        cancelledScheduleIds.delete(msg.id);
      }
      return;
    }

    if (msg.action === "stopSchedule") {
      cancelledScheduleIds.add(msg.id);
      await chrome.alarms.clear(alarmNameFor(msg.id));
      const running = runningExecutions.get(msg.id);
      if (running) await running;
      const schedules = await getSchedules();
      const schedule = schedules.find((item) =>
        item.id === msg.id && item.recurring !== "none" && ["pending", "running"].includes(item.status)
      );
      if (schedule) schedule.status = "stopped";
      await saveSchedules(schedules);
      await chrome.alarms.clear(alarmNameFor(msg.id));
      sendResponse({ ok: Boolean(schedule) });
      return;
    }

    if (msg.action === "deleteSchedule") {
      cancelledScheduleIds.add(msg.id);
      await chrome.alarms.clear(alarmNameFor(msg.id));
      const running = runningExecutions.get(msg.id);
      if (running) await running;
      const schedules = (await getSchedules()).filter((item) => item.id !== msg.id);
      await saveSchedules(schedules);
      await chrome.alarms.clear(alarmNameFor(msg.id));
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "clearHistory") {
      const schedules = (await getSchedules()).filter((item) => !["sent", "failed"].includes(item.status));
      await saveSchedules(schedules);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown action." });
  })();

  return true;
});
