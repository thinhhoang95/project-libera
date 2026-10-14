import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredSave, flushPendingState, registerStateFlusher } from "../../src/components/libera/deferred-save";
import { JSDOM } from "jsdom";

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("typing and streaming are coalesced, with a bounded checkpoint and immediate final flush", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: string[] = [];
  const saver = createDeferredSave(async (body) => { writes.push(body); });
  for (let i = 0; i < 100; i++) {
    saver.schedule({ prompt: String(i) });
    context.mock.timers.tick(5);
  }
  assert.equal(writes.length, 0);
  context.mock.timers.tick(1000); await settle();
  assert.deepEqual(writes.map((body) => JSON.parse(body)), [{ prompt: "99" }]);
  saver.schedule({ prompt: "99" });
  context.mock.timers.tick(30_000); await settle();
  assert.equal(writes.length, 1, "unchanged state causes no writes");
  for (let i = 0; i < 30; i++) {
    saver.schedule({ response: String(i) }, 30_000);
    context.mock.timers.tick(1000); await settle();
  }
  assert.equal(writes.length, 2, "streaming checkpoints at most once per thirty seconds");
  saver.schedule({ response: "final" }, 30_000);
  saver.schedule({ response: "final" }, 1000);
  context.mock.timers.tick(1000); await settle();
  assert.equal(writes.at(-1), '{"response":"final"}', "completion shortens the stream delay");
  saver.schedule({ prompt: "last keystroke" });
  await saver.flush();
  assert.equal(writes.at(-1), '{"prompt":"last keystroke"}');
});

test("in-flight saves serialize the latest state; errors remain retryable", async () => {
  const writes: string[] = [];
  let release!: () => void;
  let fail = false;
  const saver = createDeferredSave(async (body) => {
    if (fail) throw new Error("Disk unavailable");
    writes.push(body);
    if (writes.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  });
  saver.schedule("first");
  const first = saver.flush();
  saver.schedule("intermediate");
  saver.schedule("latest");
  release(); await first;
  assert.deepEqual(writes, ['"first"', '"latest"']);
  fail = true;
  saver.schedule("retry");
  await assert.rejects(saver.flush(), /Disk unavailable/);
  fail = false;
  await saver.flush();
  assert.equal(writes.at(-1), '"retry"');
});

test("close flush invokes synchronous recovery immediately and awaits all asynchronous saves", async () => {
  const dom = new JSDOM("", { url: "http://localhost" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  let nativeFlush: (() => Promise<void>) | undefined;
  window.liberaPersistence = { onFlush: (flush) => { nativeFlush = flush; return () => { nativeFlush = undefined; }; } };
  let checkpoint = 0;
  let release!: () => void;
  const unregisterSync = registerStateFlusher(() => { checkpoint++; });
  const unregisterAsync = registerStateFlusher(() => new Promise<void>((resolve) => { release = resolve; }));
  try {
    let finished = false;
    const flush = nativeFlush!().then(() => { finished = true; });
    assert.equal(checkpoint, 1);
    await settle(); assert.equal(finished, false);
    release(); await flush;
    assert.equal(finished, true);
    unregisterAsync();
    window.dispatchEvent(new dom.window.Event("pagehide"));
    assert.equal(checkpoint, 2, "recovery runs inside the pagehide event");
    const unregisterFailure = registerStateFlusher(() => { throw new Error("Save failed"); });
    await assert.rejects(flushPendingState(), /Save failed/);
    unregisterFailure();
  } finally { unregisterSync(); unregisterAsync(); dom.window.close(); }
});

test("a slow stream checkpoint does not turn later tokens into continuous disk writes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: string[] = [];
  let release!: () => void;
  const saver = createDeferredSave(async (body) => {
    writes.push(body);
    if (writes.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  });
  saver.schedule("first chunk", 30_000);
  context.mock.timers.tick(30_000); await settle();
  assert.equal(writes.length, 1);
  saver.schedule("next chunk", 30_000);
  context.mock.timers.tick(1000); await settle();
  release(); await settle();
  assert.equal(writes.length, 1, "new chunks wait for their next checkpoint");
  context.mock.timers.tick(29_000); await settle();
  assert.equal(writes.length, 2);
  saver.schedule("last chunk", 30_000);
  await saver.flush();
  assert.equal(writes.at(-1), '"last chunk"');
});

test("workspace snapshots include editor changes from an in-flight review decision", async () => {
  const dom = new JSDOM("", { url: "http://localhost" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  let text = "before acceptance";
  const snapshots: string[] = [];
  let release!: () => void;
  const decision = new Promise<void>((resolve) => { release = resolve; }).then(() => { text = "accepted text"; });
  const unregisterWorkspace = registerStateFlusher(() => { snapshots.push(text); }, true);
  const unregisterReview = registerStateFlusher(() => decision);
  try {
    const flush = flushPendingState();
    assert.deepEqual(snapshots, ["before acceptance"]);
    release(); await flush;
    assert.deepEqual(snapshots, ["before acceptance", "accepted text"]);
  } finally { unregisterReview(); unregisterWorkspace(); dom.window.close(); }
});
