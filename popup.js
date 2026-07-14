/**
 * popup.js - Interface for creating schedules
 *
 * Copyright (c) 2026 Fajar BC (https://github.com/fajarbc)
 * Licensed under MIT License
 */

const STORAGE_KEY = "schedules";
let currentFilter = "all";

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-save").addEventListener("click", createSchedule);
  document.getElementById("btn-capture").addEventListener("click", captureOpenChat);
  document.getElementById("btn-clear-history").addEventListener("click", clearHistory);
  document.querySelectorAll(".filter-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentFilter = btn.dataset.filter;
      document.querySelectorAll(".filter-tab").forEach((item) => item.classList.toggle("active", item === btn));
      renderSchedules();
    });
  });
  renderSchedules();
});

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

async function createSchedule() {
  const errEl = document.getElementById("form-error");
  errEl.textContent = "";

  const target = document.getElementById("target").value.trim();
  const message = document.getElementById("message").value.trim();
  const timeStr = document.getElementById("time").value;
  const recurring = document.getElementById("recurring").value;

  if (!target || !message || !timeStr) {
    errEl.textContent = "Target, message, and time are required.";
    return;
  }

  const scheduledTime = new Date(timeStr).getTime();
  if (isNaN(scheduledTime)) {
    errEl.textContent = "Invalid time format.";
    return;
  }
  if (scheduledTime <= Date.now()) {
    errEl.textContent = "Time must be in the future.";
    return;
  }

  const schedule = {
    id: String(Date.now()) + Math.floor(Math.random() * 1000),
    target,
    targetType: "name", // Default to name for simplicity; capture fills name.
    message,
    scheduledTime,
    nextRun: scheduledTime,
    recurring,
    status: "pending",
  };

  chrome.runtime.sendMessage({ action: "createSchedule", schedule }, (response) => {
    if (response?.ok) {
      document.getElementById("target").value = "";
      document.getElementById("message").value = "";
      renderSchedules();
    } else {
      errEl.textContent = "Failed to save schedule.";
    }
  });
}

async function renderSchedules() {
  const listContainer = document.getElementById("schedule-list-container");

  chrome.storage.local.get(STORAGE_KEY, (data) => {
    let schedules = data[STORAGE_KEY] || [];
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

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.onclick = () => {
        chrome.runtime.sendMessage({ action: "deleteSchedule", id: s.id }, () => renderSchedules());
      };

      header.appendChild(statusBadge);
      header.appendChild(deleteBtn);

      const targetRow = document.createElement("div");
      targetRow.innerHTML = "<strong>To:</strong> ";
      targetRow.appendChild(document.createTextNode(s.target));

      const dateStr = new Date(s.nextRun || s.scheduledTime).toLocaleString();
      const recLabel = s.recurring !== "none" ? ` | ${s.recurring}` : "";
      const timeRow = document.createElement("div");
      timeRow.innerHTML = "<strong>When:</strong> ";
      timeRow.appendChild(document.createTextNode(dateStr + recLabel));

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
  if (confirm("Clear all Sent and Failed messages? Pending schedules will be kept.")) {
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
