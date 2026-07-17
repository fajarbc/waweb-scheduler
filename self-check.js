const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

(async () => {
  let schedules = [];
  let alarmListener;
  let messageListener;
  let sends = 0;
  const createdAlarms = [];
  const context = {
    chrome: {
      alarms: {
        create: (name) => createdAlarms.push(name),
        clear: async () => true,
        onAlarm: { addListener: (listener) => { alarmListener = listener; } },
      },
      runtime: { onMessage: { addListener: (listener) => { messageListener = listener; } } },
      storage: {
        local: {
          get: async () => ({ schedules: structuredClone(schedules) }),
          set: async (data) => { schedules = structuredClone(data.schedules); },
        },
      },
      tabs: {
        query: async () => [{ id: 1, active: true, windowId: 1 }],
        update: async () => ({ id: 1, active: true, windowId: 1 }),
        sendMessage: async (_id, message) => {
          if (message.action === "status") return { ready: true };
          if (message.action === "send") sends += 1;
          return { ok: true };
        },
      },
      windows: { update: async () => {} },
      scripting: { executeScript: async () => {} },
    },
    console,
    Date,
    setTimeout: (callback) => callback(),
    structuredClone,
  };
  vm.runInNewContext(fs.readFileSync("background.js", "utf8"), context);

  const sendAction = (action, id) => new Promise((resolve) => {
    messageListener({ action, id }, {}, resolve);
  });
  const start = Date.now() + 10 * 60 * 1000;
  const recurring = (id) => ({
    id,
    target: "Test",
    targetType: "name",
    message: "Test message",
    scheduledTime: start,
    nextRun: start,
    recurring: "minute",
    status: "running",
  });

  assert.equal(context.computeNextRun(recurring("next")), start + 60 * 1000);

  schedules = [recurring("repeat")];
  await context.executeSchedule("repeat");
  assert.equal(sends, 1);
  assert.equal(schedules[0].status, "running");
  assert.deepEqual(createdAlarms, ["msg_repeat"]);

  sends = 0;
  createdAlarms.length = 0;
  schedules = [recurring("delete-race")];
  alarmListener({ name: "msg_delete-race" });
  await sendAction("deleteSchedule", "delete-race");
  assert.equal(sends, 0);
  assert.equal(schedules.length, 0);
  assert.equal(createdAlarms.length, 0);

  schedules = [recurring("stop-race")];
  alarmListener({ name: "msg_stop-race" });
  await sendAction("stopSchedule", "stop-race");
  assert.equal(sends, 0);
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].status, "stopped");
  assert.equal(createdAlarms.length, 0);

  schedules = [
    { ...recurring("running"), status: "running" },
    { ...recurring("stopped"), status: "stopped" },
    { ...recurring("pending"), recurring: "none", status: "pending" },
    { ...recurring("sent"), recurring: "none", status: "sent" },
    { ...recurring("failed"), recurring: "none", status: "failed" },
  ];
  await sendAction("clearHistory");
  assert.deepEqual(schedules.map((item) => item.status), ["running", "stopped", "pending"]);

  console.log("Self-check passed.");
})();
