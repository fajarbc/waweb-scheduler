// popup.js - Interface for creating schedules

const STORAGE_KEY = "schedules";

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-save").addEventListener("click", createSchedule);
  document.getElementById("btn-capture").addEventListener("click", captureOpenChat);
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
  const listEl = document.getElementById("schedule-list");
  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const schedules = (data[STORAGE_KEY] || []).sort((a, b) => a.scheduledTime - b.scheduledTime);

    if (schedules.length === 0) {
      listEl.innerHTML = "<p style='font-size:0.85rem;color:#666;'>No schedules yet.</p>";
      return;
    }

    listEl.innerHTML = "";
    schedules.forEach((s) => {
      const item = document.createElement("div");
      item.className = "schedule-item";

      const dateStr = new Date(s.nextRun || s.scheduledTime).toLocaleString();
      const recLabel = s.recurring !== "none" ? ` | ${s.recurring}` : "";

      item.innerHTML = `
        <div class="schedule-header">
          <span class="status-badge status-${s.status}">${s.status}</span>
          <button class="delete-btn" data-id="${s.id}">Delete</button>
        </div>
        <div><strong>To:</strong> ${escapeHtml(s.target)}</div>
        <div><strong>When:</strong> ${dateStr}${recLabel}</div>
        <div><strong>Msg:</strong> ${escapeHtml(s.message)}</div>
        ${s.error ? `<div class="error-msg">Error: ${escapeHtml(s.error)}</div>` : ""}
      `;

      listEl.appendChild(item);
    });

    listEl.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        chrome.runtime.sendMessage({ action: "deleteSchedule", id }, () => renderSchedules());
      });
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Pre-fill the time field with "now + 5 mins" for convenience
document.getElementById("time").value = formatDateTimeLocal(new Date(Date.now() + 5 * 60 * 1000));
