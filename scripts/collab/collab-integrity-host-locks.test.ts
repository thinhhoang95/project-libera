// Package H4 (host locks, queues and stalls): S51, S56, S57 of the shared
// notebook integrity review (docs/audits/2026-11-20-collab-integrity-triage.md).

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";

import type { Command, CommandResult } from "../../src/lib/collab/protocol/api";
import { ApiClient } from "../../electron/collab/core/api-client";
import { CollabHost } from "../../electron/collab/core/host";
import { PendingCommands, commandKeys, type PendingCommandEvent } from "../../electron/collab/core/pending-commands";
import { HostStore, HostStoreLockedError } from "../../electron/collab/core/store";
import { SLOW_READ } from "../../electron/collab/notebooks/fs-ops";
import { withinMs } from "../../electron/collab/notebooks/scan-reads";
import { CollabHostError, fetchCollabHost } from "../../src/lib/collab/host-client";
import { INK_LOCK_WAIT_MS, withInkLock } from "../../src/lib/storage/ink";
import { TestTokens, quietLogger, sleep, tempDir, waitFor } from "./support/host-helpers";

// ------------------------------------------------------------------ S56

test("S56: a lock that is created but not yet filled is held, not taken over", () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    // What a second process sees between another's exclusive create and its payload write.
    writeFileSync(`${path}.lock`, "");
    assert.throws(() => new HostStore({ path }), HostStoreLockedError);
    assert.ok(existsSync(`${path}.lock`), "the half-written lock was left alone");
  } finally {
    temp.cleanup();
  }
});

test("S56: the lock is published with its payload in one step, and two stores cannot both own it", () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    const first = new HostStore({ path });
    const payload = JSON.parse(readFileSync(`${path}.lock`, "utf8")) as { pid: number; token: string };
    assert.equal(payload.pid, process.pid);
    assert.ok(payload.token);
    assert.throws(() => new HostStore({ path }), HostStoreLockedError);
    first.close();
    assert.equal(existsSync(`${path}.lock`), false);
  } finally {
    temp.cleanup();
  }
});

test("S56: an owner whose lock was taken over stops writing and says so", async () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    let lost = 0;
    const store = new HostStore({ path, lockHeartbeatMs: 20, lockStaleMs: 5000, onLockLost: () => (lost += 1) });
    store.appendLocal("doc", "content", new Uint8Array([1]));
    // Another host took over while this one was suspended.
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, host: "x", token: "someone-else" }));
    await waitFor(() => lost === 1, 3000, "the owner to notice the takeover");
    assert.equal(store.isClosed, true);
    assert.throws(() => store.appendLocal("doc", "content", new Uint8Array([2])));
    assert.throws(() => store.transaction(() => 1));
    assert.equal(store.ownsDatabase(), false);
    store.close();
    assert.equal(JSON.parse(readFileSync(`${path}.lock`, "utf8")).token, "someone-else", "the new owner's lock is untouched");
    await sleep(60);
    assert.equal(lost, 1);
  } finally {
    temp.cleanup();
  }
});

test("S56: a lock file that vanished (removed by a contender) also fences the old owner", async () => {
  const temp = tempDir();
  try {
    const path = temp.file("a.sqlite");
    const store = new HostStore({ path, lockHeartbeatMs: 20, lockStaleMs: 5000 });
    rmSync(`${path}.lock`);
    await waitFor(() => store.isClosed, 3000, "the store to be fenced");
  } finally {
    temp.cleanup();
  }
});

test("S56: the host stops its hubs and sync when its store is fenced", async () => {
  const temp = tempDir();
  try {
    const path = temp.file("h.sqlite");
    const host = new CollabHost({ dbPath: path, appVersion: "test", installationId: "i1", logger: quietLogger, random: () => 0, compaction: false, telemetry: false, divergence: false });
    host.start();
    const store = host.store;
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, host: "x", token: "someone-else" }));
    assert.equal(store.ownsDatabase(), false, "an immediate check does not wait for the next heartbeat");
    assert.equal(store.isClosed, true);
    await host.stop();
    assert.throws(() => host.store);
  } finally {
    temp.cleanup();
  }
});

// ------------------------------------------------------------------ S57

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function thread(id: string, docId: string): Command {
  return { id, kind: "thread.create", docId, body: { id: `t-${id}`, anchorId: "a", quote: "q", body: "hi" } };
}

test("S57: a command that cannot be sent does not hold unrelated commands back", async () => {
  const store = new HostStore({ path: ":memory:" });
  const applied: string[] = [];
  const queue = new PendingCommands({
    store,
    logger: quietLogger,
    random: () => 1,
    backoffBaseMs: 60_000,
    // The PDF "never opens".
    beforeSend: (command) => {
      if (command.kind === "thread.create" && command.docId === "pdf-stuck") throw Object.assign(new Error("Waiting for the PDF document to open."), { status: 0 });
    },
  });
  const events: PendingCommandEvent[] = [];
  queue.on((event) => events.push(event));
  const fetch = async (_url: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body)) as Command;
    applied.push(command.id);
    return json(201, { id: command.id, status: 201, body: {} } satisfies CommandResult);
  };
  queue.setApi(new ApiClient({ baseUrl: "https://collab.test", tokenProvider: new TestTokens(), fetch }));
  queue.enqueue(thread("stuck", "pdf-stuck"));
  queue.enqueue({ id: "reply", kind: "message.create", threadId: "t-stuck", body: { id: "m1", body: "later" } });
  queue.enqueue(thread("free", "doc-free"));
  queue.enqueue({ id: "decide", kind: "suggestions.decide", docId: "doc-free", body: { decisions: [{ suggestionId: "s", decision: "accept" }] } });
  queue.setOnline(true);
  await waitFor(() => queue.list().length === 2, 3000, "the independent commands to settle");
  await queue.idle();
  assert.deepEqual(applied, ["free", "decide"]);
  assert.deepEqual(queue.list().map((row) => row.id), ["stuck", "reply"], "the dependent reply stays behind its thread");
  assert.deepEqual(queue.blocked().map((row) => row.id), ["stuck"], "the blocked command is visible with its reason");
  assert.match(queue.blocked()[0].lastError ?? "", /PDF/);
  assert.ok(events.some((event) => event.type === "retrying" && event.id === "stuck"));
  queue.stop();
  store.close();
});

test("S57: the blocked-command backoff is longer on battery and normal again on AC", async () => {
  const delays: number[] = [];
  let scale = 1;
  const store = new HostStore({ path: ":memory:" });
  const queue = new PendingCommands({ store, logger: quietLogger, random: () => 1, backoffBaseMs: 1000, backoffMaxMs: 1_000_000, delayScale: () => scale, beforeSend: () => { throw Object.assign(new Error("wait"), { status: 0 }); } });
  queue.on((event) => { if (event.type === "retrying") delays.push(event.delayMs); });
  queue.setApi(new ApiClient({ baseUrl: "https://collab.test", tokenProvider: new TestTokens(), fetch: async () => json(500, {}) }));
  queue.enqueue(thread("a", "doc-a"));
  queue.setOnline(true);
  await waitFor(() => delays.length === 1);
  await queue.idle();
  scale = 4;
  queue.retryNow();
  await waitFor(() => delays.length === 2);
  await queue.idle();
  scale = 1;
  queue.retryNow();
  await waitFor(() => delays.length === 3);
  assert.equal(delays[0], 1000);
  assert.equal(delays[1], 4000, "on battery the same backoff step is four times longer");
  assert.equal(delays[2], 1000, "and normal again on AC");
  queue.stop();
  store.close();
});

test("S57: commands about the same thing share a key; unrelated ones do not", () => {
  const keys = (command: Command) => new Set(commandKeys(command));
  const create = keys(thread("a", "d1"));
  const reply = keys({ id: "r", kind: "message.create", threadId: "t-a", body: { id: "m", body: "x" } });
  const other = keys(thread("b", "d2"));
  assert.ok([...create].some((key) => reply.has(key)));
  assert.ok(![...create].some((key) => other.has(key)));
});

// ------------------------------------------------------------------ S51

test("S51: a provider operation that never answers is given up on, not awaited", async () => {
  const keepAlive = setInterval(() => undefined, 1000);
  const never = new Promise<number>(() => undefined);
  const started = Date.now();
  assert.equal(await withinMs(never, 30), SLOW_READ);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await withinMs(Promise.resolve(7), 1000), 7);
  await assert.doesNotReject(withinMs(Promise.reject(new Error("late")), 1000).catch(() => undefined));
  clearInterval(keepAlive);
});

test("S51: a control call has a deadline and a timed-out mutation says its outcome is unknown", async () => {
  const { createServer } = await import("node:http");
  const server = createServer(() => undefined); // never answers
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const config = { url: `http://127.0.0.1:${port}`, token: "t" };
    await assert.rejects(fetchCollabHost("/x", { config, timeoutMs: 40 }), (error: unknown) => error instanceof CollabHostError && error.code === "collab-timeout" && error.status === 504);
    await assert.rejects(
      fetchCollabHost("/x", { config, method: "POST", body: { a: 1 }, timeoutMs: 40 }),
      (error: unknown) => error instanceof CollabHostError && /may or may not have been applied/.test(error.message),
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("S51: a save waits a bounded time for a stuck earlier save of the same record, and never runs beside it", async () => {
  assert.ok(INK_LOCK_WAIT_MS > 0);
  const keepAlive = setInterval(() => undefined, 1000);
  let release!: () => void;
  const stuck = withInkLock("record-1", () => new Promise<string>((resolve) => { release = () => resolve("first"); }), 1000);
  const ran: string[] = [];
  const second = withInkLock("record-1", async () => { ran.push("second"); return "second"; }, 30);
  await assert.rejects(second, (error: unknown) => (error as { status?: number }).status === 503);
  // A later save still queues behind the stuck one rather than running beside it.
  const third = withInkLock("record-1", async () => { ran.push("third"); return "third"; }, 2000);
  await sleep(50);
  assert.deepEqual(ran, []);
  release();
  assert.equal(await stuck, "first");
  assert.equal(await third, "third");
  assert.deepEqual(ran, ["third"]);
  // Other records are never held up.
  assert.equal(await withInkLock("record-2", async () => "free", 30), "free");
  clearInterval(keepAlive);
});
