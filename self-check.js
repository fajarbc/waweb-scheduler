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
        create: (name, info) => createdAlarms.push({ name, ...info }),
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

  const sendMessage = (message) => new Promise((resolve) => messageListener(message, {}, resolve));
  const sendAction = (action, id) => sendMessage({ action, id });
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
  assert.equal(schedules[0].sendCount, 1);
  assert.equal(schedules[0].sentHistory.length, 1);
  assert.equal(schedules[0].sentHistory[0], schedules[0].sentAt);
  assert.deepEqual(createdAlarms.map((alarm) => alarm.name), ["msg_repeat"]);

  createdAlarms.length = 0;
  const history = Array.from({ length: 50 }, (_, index) => index + 1);
  schedules = [{ ...recurring("cap"), sendCount: 50, sentHistory: history }];
  await context.executeSchedule("cap");
  assert.equal(schedules[0].sendCount, 51);
  assert.equal(schedules[0].sentHistory.length, 50);
  assert.equal(schedules[0].sentHistory.includes(1), false);

  const legacy = context.normalizeSchedule({ ...recurring("legacy"), sentAt: 123 });
  assert.equal(legacy.sendCount, 1);
  assert.deepEqual(Array.from(legacy.sentHistory), [123]);

  createdAlarms.length = 0;
  schedules = [{ ...recurring("edit"), sendCount: 3, sentHistory: [1, 2, 3] }];
  const editedTime = Date.now() + 20 * 60 * 1000;
  const edited = await sendMessage({
    action: "updateSchedule",
    id: "edit",
    message: "Updated message",
    recurring: "daily",
    nextRun: editedTime,
    target: "Ignored target",
  });
  assert.equal(edited.ok, true);
  assert.equal(schedules[0].target, "Test");
  assert.equal(schedules[0].message, "Updated message");
  assert.equal(schedules[0].recurring, "daily");
  assert.equal(schedules[0].nextRun, editedTime);
  assert.equal(schedules[0].sendCount, 3);
  assert.deepEqual(schedules[0].sentHistory, [1, 2, 3]);
  assert.deepEqual(createdAlarms, [{ name: "msg_edit", when: editedTime }]);
  await context.executeSchedule("edit");
  assert.equal(schedules[0].sendCount, 4);

  schedules = [{ ...recurring("legacy-edit"), status: "pending" }];
  assert.equal((await sendMessage({
    action: "updateSchedule",
    id: "legacy-edit",
    message: "Migrated",
    recurring: "weekly",
    nextRun: editedTime,
  })).ok, true);
  assert.equal(schedules[0].status, "running");

  for (const invalid of [
    { id: "edit", message: "", recurring: "daily", nextRun: editedTime },
    { id: "edit", message: "x", recurring: "none", nextRun: editedTime },
    { id: "edit", message: "x", recurring: "daily", nextRun: Date.now() - 1 },
    { id: "missing", message: "x", recurring: "daily", nextRun: editedTime },
  ]) {
    assert.equal((await sendMessage({ action: "updateSchedule", ...invalid })).ok, false);
  }
  schedules[0].status = "stopped";
  assert.equal((await sendMessage({ action: "updateSchedule", id: "legacy-edit", message: "x", recurring: "daily", nextRun: editedTime })).ok, false);

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
