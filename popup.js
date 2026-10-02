/**
 * Schedule controls and explicit recovery. Copyright (c) 2026 Fajar BC, MIT.
 */
const STORAGE_KEY = "schedules";
const RECURRING_OPTIONS = ["minute", "daily", "weekly", "monthly"];
let currentFilter = "all";
let editingScheduleId = null;
const $ = (id) => document.getElementById(id);
const request = (message) => chrome.runtime.sendMessage(message).then((response) => {
  if (!response?.ok) throw new Error(response?.error || "Scheduler did not respond.");
  return response;
});
function showError(error) { $("form-error").textContent = error.message || String(error); }
function formatDateTimeLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function resetScheduleForm() {
  editingScheduleId = null;
  $("target").value = ""; $("target").readOnly = false; $("btn-capture").disabled = false;
  $("message").value = ""; $("recurring").value = "none";
  $("time").value = formatDateTimeLocal(new Date(Date.now() + 300000));
  $("btn-save").textContent = "Schedule"; $("btn-cancel-edit").hidden = true;
  $("edit-hint").hidden = true; $("form-error").textContent = "";
}
function editSchedule(s) {
  editingScheduleId = s.id; $("target").value = s.target;
  $("target").readOnly = true; $("btn-capture").disabled = true;
  $("message").value = s.message; $("recurring").value = s.recurring;
  $("time").value = formatDateTimeLocal(new Date(s.nextRun || s.scheduledTime));
  $("btn-save").textContent = "Update"; $("btn-cancel-edit").hidden = false;
  $("edit-hint").hidden = false; $("edit-hint").textContent = `Editing recurring schedule for ${s.target}`;
}
async function saveSchedule() {
  $("form-error").textContent = "";
  const target = $("target").value.trim();
  const message = $("message").value.trim();
  const nextRun = new Date($("time").value).getTime();
  const recurring = $("recurring").value;
  if (!target || !message || !Number.isFinite(nextRun) || nextRun <= Date.now()) {
    throw new Error("Target, message, and a future time are required.");
  }
  if (editingScheduleId) {
    await request({ action: "updateSchedule", id: editingScheduleId, message, nextRun, recurring });
  } else {
    await request({ action: "createSchedule", schedule: {
      id: crypto.randomUUID(), target, message, recurring, scheduledTime: nextRun,
    } });
  }
  resetScheduleForm(); await renderSchedules();
}
async function captureOpenChat() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://web.whatsapp.com/")) throw new Error("Open WhatsApp Web in the active tab first.");
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  const response = await chrome.tabs.sendMessage(tab.id, { action: "capture" });
  if (!response?.ok) throw new Error(response?.error || "Cannot capture chat.");
  $("target").value = response.title;
}
function applyFormatting(ta, cmd) {
  const start = ta.selectionStart, end = ta.selectionEnd;
  const selected = ta.value.slice(start, end) || "text";
  const markers = { bold: "*", italic: "_", strike: "~", code: "`" };
  let replacement;
  if (markers[cmd]) replacement = markers[cmd] + selected + markers[cmd];
  else replacement = selected.split("\n").map((line, index) =>
    (cmd === "number" ? `${index + 1}. ` : cmd === "quote" ? "> " : "- ") + line).join("\n");
  ta.setRangeText(replacement, start, end, "select"); ta.focus();
}
function setupAutoList(ta) {
  ta.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || ta.selectionStart !== ta.selectionEnd) return;
    const pos = ta.selectionStart;
    const start = ta.value.lastIndexOf("\n", pos - 1) + 1;
    const line = ta.value.slice(start, pos);
    const match = line.match(/^(\d+\.|[-*•])\s(.*)$/);
    if (!match) return;
    event.preventDefault();
    if (!match[2].trim()) ta.setRangeText("", start, pos, "end");
    else {
      const prefix = /^\d/.test(match[1]) ? `${parseInt(match[1], 10) + 1}.` : match[1];
      ta.setRangeText(`\n${prefix} `, pos, pos, "end");
    }
  });
}
function element(tag, value, className) {
  const el = document.createElement(tag);
  if (value !== undefined) el.textContent = value;
  if (className) el.className = className;
  return el;
}
function actionButton(container, label, action) {
  const button = element("button", label);
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await action(); await renderSchedules(); }
    catch (error) { showError(error); }
    finally { button.disabled = false; }
  });
  container.appendChild(button);
}
async function renderSchedules() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const schedules = data[STORAGE_KEY] || [];
  const edited = schedules.find((s) => s.id === editingScheduleId);
  if (editingScheduleId && (!edited || !["running", "retrying", "pending"].includes(edited.status))) resetScheduleForm();
  const container = $("schedule-list-container");
  container.replaceChildren();
  const visible = schedules.filter((s) => currentFilter === "all" || s.status === currentFilter)
    .sort((a, b) => (a.retryAt || a.nextRun || a.scheduledTime) - (b.retryAt || b.nextRun || b.scheduledTime));
  if (!visible.length) container.appendChild(element("p", "No schedules found."));
  for (const s of visible) {
    const item = element("div", undefined, "schedule-item");
    item.appendChild(element("strong", `${s.status.replaceAll("_", " ")}: ${s.target}`));
    item.appendChild(element("div", `Planned: ${new Date(s.nextRun || s.scheduledTime).toLocaleString()} | ${s.recurring}`));
    item.appendChild(element("div", `Observed outgoing: ${s.sendCount || 0} (not delivery confirmation)`));
    item.appendChild(element("div", s.message, "msg-preview"));
    if (s.retryAt) item.appendChild(element("div",
      `Automatic pre-send retry ${s.retryCount}/2 at ${new Date(s.retryAt).toLocaleString()}`));
    if (s.lastMissedAt) item.appendChild(element("div", `Last skipped run: ${new Date(s.lastMissedAt).toLocaleString()}`));
    if (s.lastAttemptAt) item.appendChild(element("div", `Last attempt: ${new Date(s.lastAttemptAt).toLocaleString()}`));
    if (s.error) item.appendChild(element("div", s.error, "error-msg"));
    const history = Array.isArray(s.sentHistory) ? s.sentHistory :
      Number.isFinite(s.sentAt) ? [s.sentAt] : [];
    if (history.length) {
      const details = element("details", undefined, "send-history");
      details.appendChild(element("summary", `Recent outgoing observations (${history.length})`));
      const list = element("ul");
      [...history].reverse().forEach((time) => list.appendChild(element("li", new Date(time).toLocaleString())));
      details.appendChild(list); item.appendChild(details);
    }
    const actions = element("div", undefined, "schedule-actions");
    actions.style.flexWrap = "wrap";
    if (["pending", "running", "retrying"].includes(s.status)) {
      if (s.recurring !== "none") actionButton(actions, "Edit", () => editSchedule(s));
      actionButton(actions, "Stop", () => request({ action: "stopSchedule", id: s.id }));
    }
    if (["failed", "login_required", "missed", "stopped"].includes(s.status)) {
      actionButton(actions, "Retry / resume in 1 min", async () => {
        if (confirm(`Schedule a new attempt for ${s.target} in one minute? Log in and clear any unsent draft first. Recurring schedules pause on terminal failure.`)) {
          await request({ action: "resumeSchedule", id: s.id, nextRun: Date.now() + 60000 });
        }
      });
    }
    if (s.status === "unconfirmed") {
      actionButton(actions, "Reviewed: skip uncertain run", async () => {
        if (confirm("Check WhatsApp first: this message may already have been sent. Skip this uncertain occurrence without retrying? Recurring schedules will continue at their next future run.")) {
          await request({ action: "skipUnconfirmed", id: s.id, reviewed: true });
        }
      });
    }
    actionButton(actions, "Delete", async () => {
      if (confirm("Delete this schedule and its history? An already-dispatched message cannot be recalled.")) {
        await request({ action: "deleteSchedule", id: s.id });
      }
    });
    item.appendChild(actions); container.appendChild(item);
  }
}
async function clearHistory() {
  if (confirm("Clear completed and reviewed one-time history? Failed, missed, uncertain, active, and stopped schedules are kept.")) {
    await request({ action: "clearHistory" }); await renderSchedules();
  }
}
document.addEventListener("DOMContentLoaded", () => {
  for (const [id, handler] of [
    ["btn-save", saveSchedule], ["btn-capture", captureOpenChat],
    ["btn-clear-history", clearHistory],
  ]) $(id).addEventListener("click", () => handler().catch(showError));
  $("btn-cancel-edit").addEventListener("click", resetScheduleForm);
  $("btn-clear-history").title = "Clear completed/reviewed one-time history. Recoverable schedules are kept.";
  document.querySelectorAll(".rt-btn").forEach((button) =>
    button.addEventListener("click", () => applyFormatting($("message"), button.dataset.cmd)));
  setupAutoList($("message"));
  const hint = element("p",
    "Chrome must be running and WhatsApp logged in. Runs over 60 seconds late are skipped; recurring jobs move to their next future run. Terminal failures pause recurrence. A new outgoing bubble is not proof of delivery.",
    "hint");
  $("schedule-list-container").before(hint);
  for (const status of ["retrying", "missed", "login_required", "unconfirmed", "reviewed"]) {
    const button = element("button", status.replaceAll("_", " "), "filter-tab");
    button.dataset.filter = status; $("filter-tabs").appendChild(button);
  }
  document.querySelectorAll(".filter-tab").forEach((button) => button.addEventListener("click", () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll(".filter-tab").forEach((item) => item.classList.toggle("active", item === button));
    renderSchedules().catch(showError);
  }));
  resetScheduleForm(); renderSchedules().catch(showError);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) renderSchedules().catch(showError);
  });
});
