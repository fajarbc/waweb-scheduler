/* node race-check.js: adversarial interleavings using the self-check VM harness. */
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "self-check.js"), "utf8");
// Reuse the isolated worker/clock factory without starting the baseline suite.
const entry = source.lastIndexOf("main().catch");
assert.ok(entry > 0, "self-check harness entry point changed");
const harness = { require, __dirname, console, structuredClone };
vm.runInNewContext(source.slice(0, entry) +
  "\nglobalThis.helpers = { worker, schedule };", harness);
const { worker, schedule } = harness.helpers;
let passed = 0;
async function test(name, run) {
  await run(); console.log(`ok ${++passed} - ${name}`);
}
async function main() {
  for (const action of ["stopSchedule", "deleteSchedule"]) {
    await test(`Edit cannot release a later ${action} cancellation`, async () => {
      const w = await worker([schedule("a")]);
      const create = w.context.chrome.alarms.create;
      w.context.chrome.alarms.create = async (name, info) => {
        await create(name, info);
        if (info.when === 1000001) w.clock.now = 1000001;
      };
      const edit = w.message({ action: "updateSchedule", id: "a", message: "Edited",
        recurring: "minute", nextRun: 1000001 });
      const run = w.run("a", 1000001);
      const stop = w.message({ action, id: "a" });
      const result = await Promise.all([edit, run, stop]);
      assert.equal(result[0].ok, true);
      assert.equal(result[2].ok, true);
      assert.equal(w.sends.length, 0);
      assert.equal(w.alarms.size, 0);
      if (action === "stopSchedule") assert.equal(w.data()[0].status, "stopped");
      else assert.equal(w.data().length, 0);
    });
  }
  for (const action of ["updateSchedule", "stopSchedule", "resumeSchedule"]) {
    await test(`failed result persistence stays uncertain across ${action}`, async () => {
      let failOnce = true;
      const w = await worker([schedule("a")], { beforeSave: (rows) => {
        if (rows[0]?.sendCount === 1 && failOnce) {
          failOnce = false; throw new Error("Injected result-persistence failure");
        }
      } });
      await assert.rejects(w.run("a"));
      assert.equal(w.data()[0].attempt.phase, "dispatching");
      const result = await w.message({ action, id: "a", message: "Hello",
        recurring: "minute", nextRun: 1001000 });
      assert.equal(result.ok, action === "stopSchedule");
      assert.equal(w.data()[0].status, "unconfirmed");
      assert.equal(w.data()[0].attempt.phase, "dispatching");
      w.clock.now = 1001000; await w.run("a");
      assert.equal(w.sends.length, 1);
      const reviewed = await w.message({ action: "skipUnconfirmed", id: "a", reviewed: true });
      assert.equal(reviewed.ok, true);
      assert.equal(w.data()[0].attempt, undefined);
      assert.equal(w.data()[0].sendCount, 0); // Failed persistence is never invented as confirmed.
    });
  }
  for (const action of ["stopSchedule", "updateSchedule", "deleteSchedule"]) {
    await test(`restart before queued ${action} cannot revive a cancelled occurrence`, async () => {
      let resolveStatus, readySeen, snapshot;
      const seen = new Promise((resolve) => { readySeen = resolve; });
      const w = await worker([schedule("a")], {
        status: () => new Promise((resolve) => { resolveStatus = resolve; readySeen(); }),
        beforeSave: (rows) => {
          if (rows[0]?.cancellationPending) snapshot = structuredClone(rows);
        },
      });
      const run = w.run("a"); await seen;
      const change = w.message({ action, id: "a", message: "Edited",
        recurring: "minute", nextRun: 2000000 });
      resolveStatus({ ready: true });
      const [, result] = await Promise.all([run, change]);
      assert.equal(result.ok, true);
      assert.ok(snapshot);
      assert.equal(snapshot[0].status, "stopped");
      const restarted = await worker(snapshot);
      await restarted.run("a");
      assert.equal(restarted.sends.length, 0);
      assert.equal(restarted.alarms.size, 0);
      if (action === "updateSchedule") {
        assert.equal(w.data()[0].status, "running");
        assert.equal(w.data()[0].nextRun, 2000000);
        assert.equal(w.data()[0].cancellationPending, undefined);
      }
    });
  }
  await test("observed completion racing Stop is durable as stopped before Stop's own save", async () => {
    let resolveSend, sendSeen, snapshot;
    const seen = new Promise((resolve) => { sendSeen = resolve; });
    const w = await worker([schedule("a")], {
      send: () => new Promise((resolve) => { resolveSend = resolve; sendSeen(); }),
      beforeSave: (rows) => {
        if (rows[0]?.cancellationPending) snapshot = structuredClone(rows);
      },
    });
    const run = w.run("a"); await seen;
    const stop = w.message({ action: "stopSchedule", id: "a" });
    resolveSend({ outcome: "observed", messageId: "already-sent" });
    await Promise.all([run, stop]);
    assert.equal(snapshot[0].status, "stopped");
    assert.equal(snapshot[0].sendCount, 1);
    const restarted = await worker(snapshot);
    restarted.clock.now = 1060000; await restarted.run("a");
    assert.equal(restarted.sends.length, 0);
    assert.equal(restarted.data()[0].sendCount, 1);
  });
  console.log(`\n${passed} race regression checks passed (mocked Chrome APIs).`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
