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
  const start = Date.now() + 10 * 60 * 1000;
  assert.equal(context.computeNextRun({ recurring: "minute", scheduledTime: start }), start + 60 * 1000);

  schedules = [{
    id: "race",
    target: "Test",
    targetType: "name",
    message: "Do not send",
    scheduledTime: start,
    nextRun: start,
    recurring: "minute",
    status: "pending",
  }];
  alarmListener({ name: "msg_race" });
  await new Promise((resolve) => messageListener(
    { action: "deleteSchedule", id: "race" },
    {},
    resolve,
  ));
  await Promise.resolve();

  assert.equal(sends, 0);
  assert.equal(schedules.length, 0);
  assert.equal(createdAlarms.length, 0);
  console.log("Self-check passed.");
})();
