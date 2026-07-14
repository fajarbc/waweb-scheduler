/**
 * background.js - Manifest V3 service worker
 * Handles alarms, opens/navigates WhatsApp Web, and orchestrates sending.
 *
 * Copyright (c) 2026 Fajar BC (https://github.com/fajarbc)
 * Licensed under MIT License
 */

const WHATSAPP_URL = "https://web.whatsapp.com/";
const STORAGE_KEY = "schedules";

async function getSchedules() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
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
  const d = new Date(schedule.nextRun || schedule.scheduledTime);

  if (schedule.recurring === "daily") d.setDate(d.getDate() + 1);
  if (schedule.recurring === "weekly") d.setDate(d.getDate() + 7);
  if (schedule.recurring === "monthly") d.setMonth(d.getMonth() + 1);

  return d.getTime();
}

async function executeSchedule(id) {
  const schedules = await getSchedules();
  const schedule = schedules.find((item) => item.id === id);
  if (!schedule || schedule.status !== "pending") return;

  const tab = await ensureWhatsAppTab();
  await sleep(3000);

  const ready = await waitForWhatsAppReady(tab.id);
  if (!ready) {
    schedule.status = "failed";
    schedule.error = "WhatsApp Web is not ready. Log in once, then leave Chrome able to open web.whatsapp.com.";
    await saveSchedules(schedules);
    return;
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      action: "send",
      target: schedule.target,
      targetType: schedule.targetType,
      message: schedule.message,
    });

    if (res?.ok) {
      schedule.status = "sent";
      schedule.sentAt = Date.now();
    } else {
      schedule.status = "failed";
      schedule.error = res?.error || "Send failed.";
    }
  } catch (e) {
    schedule.status = "failed";
    schedule.error = String(e?.message || e);
  }

  if (schedule.recurring !== "none" && schedule.status === "sent") {
    schedule.nextRun = computeNextRun(schedule);
    schedule.status = "pending";
    chrome.alarms.create(alarmNameFor(schedule.id), { when: schedule.nextRun });
  }

  await saveSchedules(schedules);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("msg_")) return;
  executeSchedule(alarm.name.replace("msg_", ""));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.action === "createSchedule") {
      const schedules = await getSchedules();
      schedules.push(msg.schedule);
      await saveSchedules(schedules);
      chrome.alarms.create(alarmNameFor(msg.schedule.id), { when: msg.schedule.scheduledTime });
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "deleteSchedule") {
      const schedules = (await getSchedules()).filter((item) => item.id !== msg.id);
      await saveSchedules(schedules);
      await chrome.alarms.clear(alarmNameFor(msg.id));
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "clearHistory") {
      const schedules = (await getSchedules()).filter((item) => item.status === "pending");
      await saveSchedules(schedules);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unknown action." });
  })();

  return true;
});
