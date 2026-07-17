/**
 * popup.js - Interface for creating schedules
 *
 * Copyright (c) 2026 Fajar BC (https://github.com/fajarbc)
 * Licensed under MIT License
 */

const STORAGE_KEY = "schedules";
const RECURRING_OPTIONS = ["minute", "daily", "weekly", "monthly"];
let currentFilter = "all";
let editingScheduleId = null;

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-save").addEventListener("click", saveSchedule);
  document.getElementById("btn-cancel-edit").addEventListener("click", resetScheduleForm);
  document.getElementById("btn-capture").addEventListener("click", captureOpenChat);
  document.getElementById("btn-clear-history").addEventListener("click", clearHistory);
  document.querySelectorAll(".filter-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentFilter = btn.dataset.filter;
      document.querySelectorAll(".filter-tab").forEach((item) => item.classList.toggle("active", item === btn));
      renderSchedules();
    });
  });
  setupRichTextToolbar();
  renderSchedules();
});

function setupRichTextToolbar() {
  const ta = document.getElementById("message");
  document.querySelectorAll(".rt-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyFormatting(ta, btn.dataset.cmd));
  });
  setupAutoList(ta);
}

function setupAutoList(ta) {
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;

    const pos = ta.selectionStart;
    const val = ta.value;
    const lineStart = val.lastIndexOf("\n", pos - 1) + 1;
    const lineEnd = val.indexOf("\n", pos);
    const line = val.slice(lineStart, lineEnd === -1 ? val.length : lineEnd);

    const numMatch = line.match(/^(\d+)\.\s(.*)$/);
    const bulletMatch = line.match(/^([-*•])\s(.*)$/);

    if (numMatch) {
      e.preventDefault();
      const n = parseInt(numMatch[1], 10);
      const content = numMatch[2];
      if (content.trim() === "") {
        exitList(ta, val, lineStart, line.length);
      } else {
        insertAtCaret(ta, pos, `\n${n + 1}. `);
      }
    } else if (bulletMatch) {
      e.preventDefault();
      const sym = bulletMatch[1];
      const content = bulletMatch[2];
      if (content.trim() === "") {
        exitList(ta, val, lineStart, line.length);
      } else {
        insertAtCaret(ta, pos, `\n${sym} `);
      }
    }
  });
}

function insertAtCaret(ta, pos, insert) {
  const val = ta.value;
  ta.value = val.slice(0, pos) + insert + val.slice(pos);
  const caret = pos + insert.length;
  ta.focus();
  ta.setSelectionRange(caret, caret);
}

function exitList(ta, val, lineStart, lineLength) {
  const removeStart = lineStart > 0 ? lineStart - 1 : lineStart;
  ta.value = val.slice(0, removeStart) + val.slice(lineStart + lineLength);
  ta.focus();
  ta.setSelectionRange(removeStart, removeStart);
}

function applyFormatting(ta, cmd) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = ta.value;
  const selected = value.slice(start, end);

  const wrap = (marker) => {
    const text = selected || "text";
    return { text: `${marker}${text}${marker}`, offset: marker.length, selLen: text.length };
  };
  const prefixLines = (prefix) => {
    const lines = (selected || "text").split("\n");
    return { text: lines.map((l) => prefix + l).join("\n"), offset: prefix.length, selLen: 0 };
  };

  let result;
  switch (cmd) {
    case "bold": result = wrap("*"); break;
    case "italic": result = wrap("_"); break;
    case "strike": result = wrap("~"); break;
    case "code": result = wrap("`"); break;
    case "bullet": result = prefixLines("- "); break;
    case "number": result = prefixLines("1. "); break;
    case "quote": result = prefixLines("> "); break;
    default: return;
  }

  const before = value.slice(0, start);
  const after = value.slice(end);
  ta.value = before + result.text + after;

  ta.focus();
  if (selected) {
    ta.setSelectionRange(start + result.offset, start + result.offset + result.selLen);
  } else {
    const caret = start + result.offset;
    ta.setSelectionRange(caret, caret + result.selLen);
  }
}

function getActiveWhatsAppTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const active = tabs[0];
      if (!active) return reject(new Error("No active tab."));

      if (active.url && active.url.includes("web.whatsapp.com")) {
        resolve(active);
      } else {
        reject(new Error("Open WhatsApp Web in the active tab first."));
      }
    });
  });
}

async function captureOpenChat() {
  const errEl = document.getElementById("form-error");
  errEl.textContent = "";
  try {
    const tab = await getActiveWhatsAppTab();

    // Inject script first to ensure it's there
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    chrome.tabs.sendMessage(tab.id, { action: "capture" }, (response) => {
      if (chrome.runtime.lastError) {
        errEl.textContent = "Cannot capture: WhatsApp Web not fully loaded.";
        return;
      }
      if (response && response.ok) {
        document.getElementById("target").value = response.title;
      } else {
        errEl.textContent = response?.error || "Failed to capture chat.";
      }
    });
  } catch (e) {
    errEl.textContent = e.message;
  }
}

function formatDateTimeLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getFormValues() {
  const target = document.getElementById("target").value.trim();
  const message = document.getElementById("message").value.trim();
  const nextRun = new Date(document.getElementById("time").value).getTime();
  const recurring = document.getElementById("recurring").value;

  if ((!editingScheduleId && !target) || !message || !Number.isFinite(nextRun)) {
    return { error: "Target, message, and time are required." };
  }
  if (nextRun <= Date.now()) return { error: "Time must be in the future." };
  if (editingScheduleId && !RECURRING_OPTIONS.includes(recurring)) {
    return { error: "Choose a recurring frequency." };
  }

  return { target, message, nextRun, recurring };
}

function resetScheduleForm() {
  editingScheduleId = null;
  document.getElementById("target").value = "";
  document.getElementById("target").readOnly = false;
  document.getElementById("btn-capture").disabled = false;
  document.getElementById("message").value = "";
  document.getElementById("recurring").value = "none";
  document.getElementById("time").value = formatDateTimeLocal(new Date(Date.now() + 5 * 60 * 1000));
  document.getElementById("btn-save").textContent = "Schedule";
  document.getElementById("btn-cancel-edit").hidden = true;
  document.getElementById("edit-hint").hidden = true;
  document.getElementById("form-error").textContent = "";
}

function editSchedule(schedule) {
  editingScheduleId = schedule.id;
  document.getElementById("target").value = schedule.target;
  document.getElementById("target").readOnly = true;
  document.getElementById("btn-capture").disabled = true;
  document.getElementById("message").value = schedule.message;
  document.getElementById("time").value = formatDateTimeLocal(new Date(schedule.nextRun || schedule.scheduledTime));
  document.getElementById("recurring").value = schedule.recurring;
  document.getElementById("btn-save").textContent = "Update";
  document.getElementById("btn-cancel-edit").hidden = false;
  const hint = document.getElementById("edit-hint");
  hint.textContent = `Editing recurring schedule for ${schedule.target}`;
  hint.hidden = false;
  document.getElementById("form-error").textContent = "";
}

function saveSchedule() {
  const errEl = document.getElementById("form-error");
  errEl.textContent = "";
  const values = getFormValues();
  if (values.error) {
    errEl.textContent = values.error;
    return;
  }

  if (editingScheduleId) {
    chrome.runtime.sendMessage({
      action: "updateSchedule",
      id: editingScheduleId,
      message: values.message,
      nextRun: values.nextRun,
      recurring: values.recurring,
    }, (response) => {
      if (!response?.ok) {
        errEl.textContent = response?.error || "Failed to update schedule.";
        return;
      }
      resetScheduleForm();
      renderSchedules();
    });
    return;
  }

  const schedule = {
    id: String(Date.now()) + Math.floor(Math.random() * 1000),
    target: values.target,
    targetType: "name",
    message: values.message,
    scheduledTime: values.nextRun,
    nextRun: values.nextRun,
    recurring: values.recurring,
    status: values.recurring === "none" ? "pending" : "running",
  };

  chrome.runtime.sendMessage({ action: "createSchedule", schedule }, (response) => {
    if (!response?.ok) {
      errEl.textContent = "Failed to save schedule.";
      return;
    }
    resetScheduleForm();
    renderSchedules();
  });
}

async function renderSchedules() {
  const listContainer = document.getElementById("schedule-list-container");

  chrome.storage.local.get(STORAGE_KEY, (data) => {
    let schedules = data[STORAGE_KEY] || [];
    schedules.forEach((schedule) => {
      if (schedule.recurring !== "none" && schedule.status === "pending") schedule.status = "running";
    });
    const editing = schedules.find((schedule) => schedule.id === editingScheduleId);
    if (editingScheduleId && (!editing || editing.recurring === "none" || editing.status !== "running")) {
      resetScheduleForm();
    }
    schedules = schedules.sort((a, b) => (b.nextRun || b.scheduledTime) - (a.nextRun || a.scheduledTime));

    if (currentFilter !== "all") {
      schedules = schedules.filter((s) => s.status === currentFilter);
    }

    listContainer.innerHTML = "";
    if (schedules.length === 0) {
      listContainer.innerHTML = "<p style='font-size:0.85rem;color:#666;'>No schedules found.</p>";
      return;
    }

    schedules.forEach((s) => {
      const item = document.createElement("div");
      item.className = "schedule-item";

      const header = document.createElement("div");
      header.className = "schedule-header";

      const statusBadge = document.createElement("span");
      statusBadge.className = `status-badge status-${s.status}`;
      statusBadge.textContent = s.status;

      const actions = document.createElement("div");
      actions.className = "schedule-actions";

      if (s.recurring !== "none" && s.status === "running") {
        const editBtn = document.createElement("button");
        editBtn.className = "edit-btn";
        editBtn.textContent = "Edit";
        editBtn.title = `Edit recurring schedule for ${s.target}`;
        editBtn.onclick = () => editSchedule(s);
        actions.appendChild(editBtn);

        const stopBtn = document.createElement("button");
        stopBtn.className = "stop-btn";
        stopBtn.textContent = "Stop";
        stopBtn.title = `Stop recurring schedule for ${s.target}`;
        stopBtn.onclick = () => {
          chrome.runtime.sendMessage({ action: "stopSchedule", id: s.id }, () => renderSchedules());
        };
        actions.appendChild(stopBtn);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.title = `Delete schedule for ${s.target}`;
      deleteBtn.onclick = () => {
        chrome.runtime.sendMessage({ action: "deleteSchedule", id: s.id }, () => renderSchedules());
      };
      actions.appendChild(deleteBtn);

      header.appendChild(statusBadge);
      header.appendChild(actions);

      const targetRow = document.createElement("div");
      targetRow.innerHTML = "<strong>To:</strong> ";
      targetRow.appendChild(document.createTextNode(s.target));

      const dateStr = new Date(s.nextRun || s.scheduledTime).toLocaleString();
      const recLabel = s.recurring !== "none" ? ` | ${s.recurring}` : "";
      const timeRow = document.createElement("div");
      timeRow.innerHTML = "<strong>When:</strong> ";
      timeRow.appendChild(document.createTextNode(dateStr + recLabel));

      const history = Array.isArray(s.sentHistory)
        ? s.sentHistory.filter(Number.isFinite)
        : (Number.isFinite(s.sentAt) ? [s.sentAt] : []);
      const sendCount = Number.isInteger(s.sendCount) ? s.sendCount : history.length;
      const sentRow = document.createElement("div");
      sentRow.innerHTML = "<strong>Sent:</strong> ";
      sentRow.appendChild(document.createTextNode(`${sendCount} time${sendCount === 1 ? "" : "s"}`));

      let historyDetails;
      if (history.length > 0) {
        historyDetails = document.createElement("details");
        historyDetails.className = "send-history";
        const summary = document.createElement("summary");
        summary.textContent = `Recent sends (${history.length})`;
        const historyList = document.createElement("ul");
        [...history].reverse().forEach((sentAt) => {
          const entry = document.createElement("li");
          entry.textContent = new Date(sentAt).toLocaleString();
          historyList.appendChild(entry);
        });
        historyDetails.appendChild(summary);
        historyDetails.appendChild(historyList);
      }

      const msgRow = document.createElement("div");
      msgRow.innerHTML = "<strong>Msg:</strong> ";

      const msgPreview = document.createElement("div");
      msgPreview.className = "msg-preview collapsed";

      // XSS Safe: setting textContent instead of innerHTML
      msgPreview.textContent = s.message;

      msgRow.appendChild(msgPreview);

      // Expand/Collapse logic
      const numLines = s.message.split('\n').length;
      if (numLines > 2 || s.message.length > 80) {
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "expand-btn";
        toggleBtn.textContent = "View complete message ▼";
        toggleBtn.onclick = () => {
          const isCollapsed = msgPreview.classList.contains("collapsed");
          if (isCollapsed) {
            msgPreview.classList.remove("collapsed");
            msgPreview.style.whiteSpace = "pre-wrap"; // shows newlines
            toggleBtn.textContent = "Collapse ▲";
          } else {
            msgPreview.classList.add("collapsed");
            msgPreview.style.whiteSpace = "normal";
            toggleBtn.textContent = "View complete message ▼";
          }
        };
        msgRow.appendChild(toggleBtn);
      }

      item.appendChild(header);
      item.appendChild(targetRow);
      item.appendChild(timeRow);
      if (s.recurring !== "none") item.appendChild(sentRow);
      if (historyDetails) item.appendChild(historyDetails);
      item.appendChild(msgRow);

      if (s.error) {
        const errRow = document.createElement("div");
        errRow.className = "error-msg";
        errRow.textContent = `Error: ${s.error}`;
        item.appendChild(errRow);
      }

      listContainer.appendChild(item);
    });
  });
}

function clearHistory() {
  if (confirm("Clear all Sent and Failed messages? Active and stopped schedules will be kept.")) {
    chrome.runtime.sendMessage({ action: "clearHistory" }, () => renderSchedules());
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Pre-fill the time field with "now + 5 mins" for convenience
document.getElementById("time").value = formatDateTimeLocal(new Date(Date.now() + 5 * 60 * 1000));
