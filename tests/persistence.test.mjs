import test from "node:test";
import assert from "node:assert/strict";
import { createSaver } from "../web/persistence.js";

function harness(responses) {
  const calls = [];
  const events = { status: [], conflict: 0 };
  const queue = [...responses];
  const saver = createSaver({
    getState: () => ({ custom: ["a"], rev: saver.rev }),
    setRev: (rev) => { saver.rev = rev; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const next = queue.shift() || { status: 200, body: { ok: true, rev: (saver.rev || 0) + 1 } };
      return { ok: next.status < 300, status: next.status, json: async () => next.body };
    },
    onStatus: (status) => events.status.push(status),
    onConflict: () => { events.conflict += 1; },
    delayMs: 0
  });
  saver.rev = 0;
  return { saver, calls, events };
}

test("a save sends the whole state and remembers the revision", async () => {
  const { saver, calls, events } = harness([]);
  saver.schedule();
  await saver.idle();
  assert.equal(calls.length, 1);
  assert.equal(saver.rev, 1);
  assert.deepEqual(events.status.at(-1), "saved");
});

test("saving is blocked until the state has been loaded successfully", async () => {
  const { saver, calls } = harness([]);
  saver.block();
  saver.schedule();
  await saver.idle();
  assert.equal(calls.length, 0);
});

test("a 409 conflict blocks further saves and reports it", async () => {
  const { saver, calls, events } = harness([{ status: 409, body: { error: "stale" } }]);
  saver.schedule();
  await saver.idle();
  assert.equal(events.conflict, 1);
  saver.schedule();
  await saver.idle();
  assert.equal(calls.length, 1);
});

test("flush sends a pending save immediately with keepalive", async () => {
  const { saver, calls } = harness([]);
  saver.delayMs = 10_000;
  saver.schedule();
  saver.flush();
  await saver.idle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.keepalive, true);
});

test("a failed request reports an error and a later change retries", async () => {
  const { saver, calls, events } = harness([{ status: 500, body: {} }]);
  saver.schedule();
  await saver.idle();
  assert.equal(events.status.at(-1), "error");
  saver.schedule();
  await saver.idle();
  assert.equal(calls.length, 2);
  assert.equal(events.status.at(-1), "saved");
});
