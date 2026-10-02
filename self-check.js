/* Run with: node self-check.js. No npm dependencies or live WhatsApp account. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
let passed = 0;
async function test(name, run) {
  await run(); passed++; console.log(`ok ${passed} - ${name}`);
}
function schedule(id, extra = {}) {
  return { id, target: "Test", message: "Hello", recurring: "minute",
    scheduledTime: 1000000, nextRun: 1000000, status: "running", ...extra };
}
async function worker(initial = [], options = {}) {
  let data = structuredClone(initial), listener;
  const clock = { now: options.now || 1000000 };
  const alarms = new Map((options.alarms || []).map((a) => [a.name, a]));
  const sends = [];
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    Date: ClockDate, console, crypto: require("node:crypto").webcrypto,
    setTimeout: (fn) => { fn(); return 1; },
    chrome: {
      alarms: {
        create: async (name, { when }) => { alarms.set(name, { name, scheduledTime: when }); },
        clear: async (name) => alarms.delete(name),
        getAll: async () => [...alarms.values()],
        onAlarm: { addListener() {} },
      },
      storage: { local: {
        get: async () => ({ schedules: structuredClone(data) }),
        set: async (value) => {
          if (options.beforeSave) options.beforeSave(value.schedules);
          data = structuredClone(value.schedules);
        },
      } },
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
        onStartup: { addListener() {} }, onInstalled: { addListener() {} },
      },
      tabs: {
        query: async () => [{ id: 1, windowId: 1, active: true }],
        update: async () => ({ id: 1, windowId: 1 }),
        create: async () => ({ id: 1, windowId: 1 }),
        sendMessage: async (_id, msg) => {
          if (msg.action === "status") return options.status ? options.status() : { ready: true };
          if (msg.action === "cancelSend") return { ok: true };
          sends.push(msg);
          return options.send ? options.send(msg) : { outcome: "observed", messageId: `sent-${sends.length}` };
        },
      },
      windows: { update: async () => {} }, scripting: { executeScript: async () => {} },
    },
  });
  vm.runInContext(source("background.js"), context);
  const flush = () => vm.runInContext("queue", context);
  await flush();
  return {
    context, clock, alarms, sends, data: () => structuredClone(data), flush,
    run: (id, time = clock.now) => vm.runInContext(`executeSchedule(${JSON.stringify(id)}, ${time})`, context),
    message: (msg) => new Promise((resolve) => listener(msg, {}, resolve)),
    reconcile: () => vm.runInContext("enqueue(reconcile)", context),
  };
}
function contentFixture(options = {}) {
  let listener, enterCount = 0, commandCount = 0, delayCount = 0;
  let title = "Test";
  const bubbles = [...(options.old || [])];
  const handlers = {};
  const box = {
    textContent: options.draft || "", isConnected: true,
    get innerText() { return this.textContent; },
    focus() {}, querySelector() { return null; },
    dispatchEvent(event) {
      if (event.key === "Enter") {
        enterCount++;
        if (options.enter) options.enter({ box, bubbles, changeChat: () => { title = "Other"; } });
        else { bubbles.push({ id: "new-1", text: box.textContent }); box.textContent = ""; }
      }
    },
  };
  const header = { getAttribute: () => title, get innerText() { return title; } };
  const doc = {
    querySelector(selector) {
      if (selector.includes("#main header")) return header;
      if (selector.includes("#main footer")) return box;
      if (selector === "#pane-side") return {};
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "#main .message-out") return bubbles.map((bubble) => ({
        closest: () => ({ getAttribute: () => bubble.id }),
        getAttribute: () => bubble.id,
        querySelector: () => ({ innerText: bubble.text }),
      }));
      return [];
    },
    addEventListener(name, fn) { handlers[name] = fn; },
    removeEventListener(name) { delete handlers[name]; },
    execCommand(command, _ui, value) {
      commandCount++;
      if (options.insertFails) return false;
      box.textContent += value;
      handlers.input?.({ isTrusted: true, type: "input" });
      return true;
    },
  };
  class FakeEvent { constructor(type, values) { this.type = type; Object.assign(this, values); } }
  vm.runInNewContext(source("content.js"), {
    window: {}, document: doc, Event: FakeEvent, KeyboardEvent: FakeEvent,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    setTimeout(fn) {
      delayCount++;
      if (options.onDelay) options.onDelay({
        delayCount, box, changeChat: () => { title = "Other"; },
        interact: () => handlers.input?.({ isTrusted: true }),
        cancel: () => listener({ action: "cancelSend" }, {}, () => {}),
      });
      fn();
    },
  });
  return {
    send: (message = "Hello") => new Promise((resolve) => listener({ action: "send", target: "Test", message }, {}, resolve)),
    box, enters: () => enterCount, commands: () => commandCount,
  };
}
async function main() {
  await test("restores missing alarms and keeps unrelated alarms", async () => {
    const w = await worker([schedule("a")], { alarms: [{ name: "unrelated", scheduledTime: 10 }] });
    assert.equal(w.alarms.get("msg_a").scheduledTime, 1000000);
    assert.ok(w.alarms.has("unrelated"));
    await w.reconcile(); assert.equal(w.alarms.size, 2);
  });
  await test("corrects mismatched alarms and removes orphan/non-runnable alarms", async () => {
    const w = await worker([schedule("a"), schedule("stopped", { status: "stopped" })], {
      alarms: [{ name: "msg_a", scheduledTime: 9 }, { name: "msg_stopped" }, { name: "msg_deleted" }],
    });
    assert.deepEqual([...w.alarms.keys()], ["msg_a"]);
    assert.equal(w.alarms.get("msg_a").scheduledTime, 1000000);
  });
  await test("overdue recurring skips forward and one-time becomes missed without sends", async () => {
    const w = await worker([schedule("a"), schedule("once", { recurring: "none", status: "pending" })], { now: 1200000 });
    assert.equal(w.data()[0].nextRun, 1240000);
    assert.equal(w.data()[1].status, "missed"); assert.equal(w.sends.length, 0);
  });
  await test("restart after dispatch is unconfirmed, never automatically retried", async () => {
    const w = await worker([schedule("a", { attempt: { phase: "dispatching" } })]);
    assert.equal(w.data()[0].status, "unconfirmed");
    assert.equal(w.alarms.size, 0); await w.run("a"); assert.equal(w.sends.length, 0);
  });
  await test("restart before dispatch safely restores a prepared job", async () => {
    const w = await worker([schedule("a", { attempt: { phase: "preparing" } })]);
    assert.equal(w.data()[0].attempt, undefined);
    await w.run("a"); assert.equal(w.sends.length, 1);
  });
  await test("duplicate callbacks cannot send the same recurring occurrence twice", async () => {
    const w = await worker([schedule("a")]);
    await Promise.all([w.run("a"), w.run("a")]);
    assert.equal(w.sends.length, 1); assert.equal(w.data()[0].sendCount, 1);
    assert.equal(w.data()[0].nextRun, 1060000);
  });
  await test("simultaneous schedules serialize and preserve both histories", async () => {
    let active = 0, max = 0;
    const w = await worker([schedule("a"), schedule("b", { target: "Other" })], {
      send: async () => { active++; max = Math.max(max, active); await Promise.resolve(); active--; return { outcome: "observed", messageId: "new" }; },
    });
    await Promise.all([w.run("a"), w.run("b")]);
    assert.equal(max, 1); assert.equal(w.sends[1].target, "Other");
    assert.deepEqual(w.data().map((s) => s.sendCount), [1, 1]);
  });
  await test("queued stop/delete prevent dispatch", async () => {
    for (const action of ["stopSchedule", "deleteSchedule"]) {
      const w = await worker([schedule("a")]);
      const run = w.run("a");
      await w.message({ action, id: "a" }); await run;
      assert.equal(w.sends.length, 0);
      assert.equal(w.data().length, action === "deleteSchedule" ? 0 : 1);
      assert.equal(w.alarms.size, 0);
    }
  });
  await test("queued edit prevents stale message and preserves history", async () => {
    const w = await worker([schedule("a", { sendCount: 3, sentHistory: [1, 2, 3] })]);
    const run = w.run("a");
    assert.equal((await w.message({ action: "updateSchedule", id: "a", message: "Updated",
      recurring: "daily", nextRun: 2000000 })).ok, true);
    await run;
    assert.equal(w.sends.length, 0); assert.equal(w.data()[0].message, "Updated");
    assert.equal(w.data()[0].sendCount, 3);
  });
  await test("create during execution is not lost", async () => {
    const w = await worker([schedule("a")]);
    await Promise.all([w.run("a"), w.message({ action: "createSchedule",
      schedule: schedule("b", { scheduledTime: 2000000 }) })]);
    assert.equal(w.data().length, 2); assert.equal(w.data()[0].sendCount, 1);
  });
  await test("legacy boolean success is not accepted as observed send", async () => {
    const w = await worker([schedule("a")], { send: async () => ({ ok: true }) });
    await w.run("a"); assert.equal(w.data()[0].status, "unconfirmed");
    assert.equal(w.data()[0].sendCount, 0);
  });
  await test("message-channel failure after dispatch is uncertain", async () => {
    const w = await worker([schedule("a")], { send: async () => { throw new Error("Port closed"); } });
    await w.run("a"); assert.equal(w.data()[0].status, "unconfirmed");
    assert.equal(w.data()[0].retryAt, undefined);
  });
  await test("failed result persistence cannot cause a duplicate send in the same worker", async () => {
    let failOnce = true;
    const w = await worker([schedule("a")], { beforeSave: (rows) => {
      if (rows[0]?.sendCount === 1 && failOnce) { failOnce = false; throw new Error("Storage unavailable"); }
    } });
    await assert.rejects(w.run("a"));
    await w.run("a");
    assert.equal(w.sends.length, 1); assert.equal(w.data()[0].status, "unconfirmed");
  });
  await test("logged-out sessions pause without automatic retries", async () => {
    const w = await worker([schedule("a")], { status: () => ({ loggedOut: true }) });
    await w.run("a"); assert.equal(w.data()[0].status, "login_required");
    assert.equal(w.sends.length, 0); assert.equal(w.data()[0].retryAt, undefined);
  });
  await test("readiness delay cannot send after the lateness grace window", async () => {
    let w;
    w = await worker([schedule("a")], { status: () => { w.clock.now += 61000; return { ready: true }; } });
    await w.run("a"); assert.equal(w.sends.length, 0);
    assert.equal(w.data()[0].lastMissedAt, 1000000);
  });
  await test("pre-send timeouts retry twice with backoff then pause", async () => {
    const w = await worker([schedule("a")], { status: () => ({ ready: false }) });
    await w.run("a"); assert.equal(w.data()[0].retryAt, 1030000);
    w.clock.now = 1030000; await w.run("a"); assert.equal(w.data()[0].retryAt, 1090000);
    w.clock.now = 1090000; await w.run("a");
    assert.equal(w.data()[0].status, "failed"); assert.equal(w.sends.length, 0);
  });
  await test("uncertain runs cannot be resumed; reviewed skip preserves count", async () => {
    const w = await worker([schedule("a", { status: "unconfirmed", sendCount: 2 })]);
    assert.equal((await w.message({ action: "resumeSchedule", id: "a", nextRun: 2000000 })).ok, false);
    assert.equal((await w.message({ action: "skipUnconfirmed", id: "a" })).ok, false);
    assert.equal((await w.message({ action: "skipUnconfirmed", id: "a", reviewed: true })).ok, true);
    assert.equal(w.data()[0].sendCount, 2); assert.equal(w.data()[0].nextRun, 1060000);
  });
  await test("terminal pre-send failures can be deliberately resumed", async () => {
    const w = await worker([schedule("a", { status: "failed", sendCount: 2 })]);
    assert.equal((await w.message({ action: "resumeSchedule", id: "a", nextRun: 2000000 })).ok, true);
    assert.equal(w.data()[0].status, "running"); assert.equal(w.data()[0].sendCount, 2);
  });
  await test("clearing history retains recoverable and uncertain schedules", async () => {
    const states = ["sent", "reviewed", "failed", "missed", "unconfirmed", "stopped", "running"];
    const w = await worker(states.map((status) => schedule(status, { status })));
    await w.message({ action: "clearHistory" });
    assert.deepEqual(w.data().map((s) => s.status), states.slice(2));
  });
  await test("monthly recurrence clamps month-end and retains original day", async () => {
    const w = await worker();
    const jan = new Date(2026, 0, 31, 12).getTime();
    const feb = w.context.computeNextRun(schedule("a", { recurring: "monthly", scheduledTime: jan, nextRun: jan }), jan);
    assert.equal(new Date(feb).getDate(), 28); assert.equal(new Date(feb).getMonth(), 1);
    const mar = w.context.computeNextRun(schedule("a", { recurring: "monthly", scheduledTime: jan, nextRun: feb }), feb);
    assert.equal(new Date(mar).getDate(), 31);
  });
  await test("history stays bounded and legacy history is normalized", async () => {
    const w = await worker([schedule("a", { sentHistory: Array.from({ length: 50 }, (_, i) => i), sendCount: 50 })]);
    await w.run("a"); assert.equal(w.data()[0].sendCount, 51); assert.equal(w.data()[0].sentHistory.length, 50);
    assert.equal(w.context.normalizeSchedule({ sentAt: 123 }).sendCount, 1);
  });
  await test("invalid creation and edit are rejected without losing active alarms", async () => {
    const w = await worker([schedule("a")]);
    assert.equal((await w.message({ action: "createSchedule", schedule: {} })).ok, false);
    assert.equal((await w.message({ action: "updateSchedule", id: "a", nextRun: 0 })).ok, false);
    assert.ok(w.alarms.has("msg_a"));
  });
  await test("existing draft is never altered or dispatched", async () => {
    const c = contentFixture({ draft: "Personal draft" });
    assert.equal((await c.send()).outcome, "blocked");
    assert.equal(c.box.textContent, "Personal draft"); assert.equal(c.commands(), 0); assert.equal(c.enters(), 0);
  });
  await test("new outgoing bubble and cleared composer confirm observation", async () => {
    const c = contentFixture();
    const result = await c.send(); assert.equal(result.outcome, "observed"); assert.equal(result.messageId, "new-1");
  });
  await test("old identical bubble cannot confirm an ignored Enter", async () => {
    const c = contentFixture({ old: [{ id: "old", text: "Hello" }], enter() {} });
    assert.equal((await c.send()).outcome, "unconfirmed");
  });
  await test("composer clearing without a matching new bubble is uncertain", async () => {
    const c = contentFixture({ enter: ({ box }) => { box.textContent = ""; } });
    assert.equal((await c.send()).outcome, "unconfirmed");
  });
  await test("chat switch before Enter prevents sending", async () => {
    const c = contentFixture({ onDelay: ({ delayCount, changeChat }) => { if (delayCount === 1) changeChat(); } });
    assert.equal((await c.send()).outcome, "blocked"); assert.equal(c.enters(), 0);
  });
  await test("chat switch after Enter becomes uncertain", async () => {
    const c = contentFixture({ enter: ({ changeChat }) => changeChat() });
    assert.equal((await c.send()).outcome, "unconfirmed");
  });
  await test("trusted user interaction aborts before Enter", async () => {
    const c = contentFixture({ onDelay: ({ delayCount, interact }) => { if (delayCount === 1) interact(); } });
    assert.equal((await c.send()).outcome, "blocked"); assert.equal(c.enters(), 0);
  });
  await test("cancel before Enter leaves unsent text for review", async () => {
    const c = contentFixture({ onDelay: ({ delayCount, cancel }) => { if (delayCount === 1) cancel(); } });
    assert.equal((await c.send()).outcome, "cancelled"); assert.equal(c.enters(), 0);
  });
  await test("content script rejects overlapping send requests", async () => {
    const c = contentFixture();
    const first = c.send(); const second = c.send();
    assert.equal((await second).outcome, "blocked");
    assert.equal((await first).outcome, "observed"); assert.equal(c.enters(), 1);
  });
  await test("multiline and emoji are verified as exact outgoing content", async () => {
    const c = contentFixture();
    assert.equal((await c.send("Hello\n🙂")).outcome, "observed");
  });
  console.log(`\n${passed} self-checks passed. Mocked browser/DOM only; live WhatsApp validation still required.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
