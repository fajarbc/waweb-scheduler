const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = {
  chrome: {
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    storage: { local: { get() {}, set() {} } },
  },
  console,
  Date,
  setTimeout,
};
vm.runInNewContext(fs.readFileSync("background.js", "utf8"), context);

const start = Date.now() + 10 * 60 * 1000;
assert.equal(context.computeNextRun({ recurring: "minute", scheduledTime: start }), start + 60 * 1000);
console.log("Self-check passed.");
