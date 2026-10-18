import assert from "node:assert/strict";
import test from "node:test";

import type { Command, CommandResult } from "../../src/lib/collab/protocol/api";
import { ApiClient, ApiClientError, sha256Hex } from "../../electron/collab/core/api-client";
import { PendingCommands, type PendingCommandEvent } from "../../electron/collab/core/pending-commands";
import { HostStore } from "../../electron/collab/core/store";
import { ManualClock, TestTokens, quietLogger, tempDir, waitFor } from "./support/host-helpers";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const raw = init.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    const call = { method: init.method ?? "GET", url, headers, body };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

test("the API client sends bearer tokens and retries once after refreshing an expired token", async () => {
  const tokens = new TestTokens("old", "new");
  const { fetch, calls } = fakeFetch((call) => {
    if (call.headers.Authorization === "Bearer old") return json(401, { error: { code: "token-expired", message: "expired" } });
    return json(200, { id: "u1", email: "a@b.c", displayName: "A", color: "#000", createdAt: "x" });
  });
  const api = new ApiClient({ baseUrl: "https://collab.test/", tokenProvider: tokens, fetch });
  const me = await api.me();
  assert.equal(me.id, "u1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://collab.test/v1/me");
  assert.equal(calls[1].headers.Authorization, "Bearer new");
  assert.equal(tokens.refreshCalls, 1);
});

test("API errors carry the server's code and status; network failures are typed too", async () => {
  const tokens = new TestTokens("t", null);
  const responses: Array<() => Response | Promise<Response>> = [
    () => json(403, { error: { code: "forbidden", message: "nope", details: { role: "viewer" } } }),
    () => json(401, { error: { code: "token-expired", message: "expired" } }),
    () => Promise.reject(new TypeError("fetch failed")),
    () => new Response("<html>", { status: 502 }),
  ];
  const { fetch } = fakeFetch(() => (responses.shift() as () => Response)());
  const api = new ApiClient({ baseUrl: "https://collab.test", tokenProvider: tokens, fetch });
  await assert.rejects(api.listProjects(), (error: unknown) => {
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.code, "forbidden");
    assert.equal(error.status, 403);
    assert.deepEqual(error.details, { role: "viewer" });
    assert.equal(error.transient, false);
    return true;
  });
  await assert.rejects(api.listProjects(), (error: unknown) => error instanceof ApiClientError && error.code === "needs-sign-in");
  // The failed refresh cleared the session; sign back in for the next cases.
  tokens.token = "t";
  await assert.rejects(api.listProjects(), (error: unknown) => error instanceof ApiClientError && error.code === "network" && error.status === 0 && error.transient);
  await assert.rejects(api.listProjects(), (error: unknown) => error instanceof ApiClientError && error.status === 502 && error.transient);
});

test("anonymous routes send no token; routes and query strings are built from ApiRoutes", async () => {
  const tokens = new TestTokens("t");
  const { fetch, calls } = fakeFetch(() => json(200, {}));
  const api = new ApiClient({ baseUrl: "https://collab.test", tokenProvider: tokens, fetch });
  await api.version();
  await api.login({ email: "a@b.c", password: "pw" });
  await api.getUpdates("doc 1", { fromSeq: 5, limit: 10 });
  await api.decideSuggestions("d1", { decisions: [{ suggestionId: "s1", decision: "accept" }] });
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[2].url, "https://collab.test/v1/documents/doc%201/updates?fromSeq=5&limit=10");
  assert.equal(calls[2].headers.Authorization, "Bearer t");
  assert.equal(calls[3].method, "POST");
  assert.equal(calls[3].url, "https://collab.test/v1/documents/d1/suggestions/decisions");
});

test("blobs upload under their sha256 and downloads are verified", async () => {
  const bytes = new TextEncoder().encode("image bytes");
  const hash = sha256Hex(bytes);
  const stored = new Map<string, Uint8Array>();
  const { fetch, calls } = fakeFetch((call) => {
    const key = call.url.split("/").pop() as string;
    if (call.method === "PUT") {
      stored.set(key, call.body as Uint8Array);
      return json(201, { hash: key, size: (call.body as Uint8Array).length, mime: call.headers["Content-Type"], createdAt: "now" });
    }
    if (key === "bad") return new Response(new Uint8Array([1, 2, 3]) as unknown as BodyInit, { status: 200 });
    return new Response(stored.get(key) as unknown as BodyInit, { status: 200 });
  });
  const api = new ApiClient({ baseUrl: "https://collab.test", tokenProvider: new TestTokens(), fetch });
  const info = await api.uploadBlob("p1", bytes, "image/png");
  assert.equal(info.hash, hash);
  assert.equal(calls[0].url, `https://collab.test/v1/projects/p1/blobs/${hash}`);
  assert.equal(calls[0].headers["Content-Type"], "image/png");
  assert.deepEqual(await api.downloadBlob("p1", hash), bytes);
  await assert.rejects(api.downloadBlob("p1", "bad"), (error: unknown) => error instanceof ApiClientError && error.code === "hash-mismatch");
});

/** A fake /v1/commands endpoint with idempotency keyed on command id. */
function commandServer() {
  const results = new Map<string, CommandResult>();
  const applied: string[] = [];
  let failNext: "network-after-apply" | "503" | null = null;
  const { fetch, calls } = fakeFetch(async (call) => {
    const command = call.body as Command;
    if (failNext === "503") {
      failNext = null;
      return json(503, { error: { code: "internal", message: "busy" } });
    }
    let result = results.get(command.id);
    if (!result) {
      applied.push(command.id);
      result =
        command.kind === "suggestions.decide"
          ? { id: command.id, status: 409, body: { error: { code: "already-decided", message: "decided" } } }
          : { id: command.id, status: 201, body: { ok: command.id } };
      results.set(command.id, result);
    }
    if (failNext === "network-after-apply") {
      failNext = null;
      throw new TypeError("connection reset");
    }
    return json(200, result);
  });
  return {
    fetch,
    calls,
    applied,
    fail(mode: "network-after-apply" | "503") {
      failNext = mode;
    },
  };
}

function thread(id: string): Command {
  return { id, kind: "thread.create", docId: "d1", body: { id: `t-${id}`, anchorId: "a1", quote: "q", body: "hello" } };
}

test("commands persist before anything else and replay in order once online", async () => {
  const temp = tempDir();
  try {
    let store = new HostStore({ path: temp.file("c.sqlite") });
    let queue = new PendingCommands({ store, logger: quietLogger });
    const events: PendingCommandEvent[] = [];
    queue.on((event) => events.push(event));
    assert.equal(queue.enqueue(thread("c1")), true);
    assert.equal(queue.enqueue(thread("c1")), false, "the same id is queued once");
    queue.enqueue(thread("c2"));
    assert.deepEqual(events.map((event) => event.type), ["pending", "pending"]);
    // Offline: nothing is sent and the queue survives a restart.
    store.close();
    store = new HostStore({ path: temp.file("c.sqlite") });
    queue = new PendingCommands({ store, logger: quietLogger });
    queue.on((event) => events.push(event));
    assert.deepEqual(queue.list().map((row) => row.id), ["c1", "c2"]);

    const server = commandServer();
    queue.setApi(new ApiClient({ baseUrl: "https://collab.test", tokenProvider: new TestTokens(), fetch: server.fetch }));
    queue.setOnline(true);
    await waitFor(() => queue.list().length === 0);
    await queue.idle();
    assert.deepEqual(server.applied, ["c1", "c2"]);
    const settled = events.filter((event): event is Extract<PendingCommandEvent, { type: "settled" }> => event.type === "settled");
    assert.deepEqual(settled.map((event) => [event.id, event.ok, event.status]), [
      ["c1", true, 201],
      ["c2", true, 201],
    ]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("a lost response is retried with the same id and the server applies the command once", async () => {
  const store = new HostStore({ path: ":memory:" });
  const clock = new ManualClock();
  const queue = new PendingCommands({ store, clock, random: () => 0.5, logger: quietLogger, backoffBaseMs: 1000 });
  const events: PendingCommandEvent[] = [];
  queue.on((event) => events.push(event));
  const server = commandServer();
  queue.setApi(new ApiClient({ baseUrl: "https://collab.test", tokenProvider: new TestTokens(), fetch: server.fetch }));
  server.fail("network-after-apply");
  queue.enqueue(thread("c1"));
  queue.enqueue(thread("c2"));
  queue.setOnline(true);
  await waitFor(() => events.some((event) => event.type === "retrying"));
  await queue.idle();
  assert.equal(queue.list().length, 2, "kept after a network error");
  assert.equal(queue.list()[0].attempts, 1);
  assert.match(queue.list()[0].lastError ?? "", /connection reset/);
  const retry = events.find((event) => event.type === "retrying");
  assert.ok(retry && retry.type === "retrying" && retry.delayMs === 500);
  assert.equal(server.calls.length, 1, "c2 waits behind c1");

  clock.advance(500);
  await waitFor(() => queue.list().length === 0);
  await queue.idle();
  assert.deepEqual(server.applied, ["c1", "c2"], "c1 was applied once despite two posts");
  assert.equal(server.calls.filter((call) => (call.body as Command).id === "c1").length, 2);
  store.close();
});

test("5xx keeps the command and backs off; a permanent 4xx settles it as failed", async () => {
  const store = new HostStore({ path: ":memory:" });
  const clock = new ManualClock();
  const queue = new PendingCommands({ store, clock, random: () => 1, logger: quietLogger, backoffBaseMs: 100, backoffMaxMs: 1000 });
  const events: PendingCommandEvent[] = [];
  queue.on((event) => events.push(event));
  const server = commandServer();
  queue.setApi(new ApiClient({ baseUrl: "https://collab.test", tokenProvider: new TestTokens(), fetch: server.fetch }));
  server.fail("503");
  queue.enqueue({ id: "d1", kind: "suggestions.decide", docId: "doc", body: { decisions: [{ suggestionId: "s", decision: "accept" }] } });
  queue.setOnline(true);
  await waitFor(() => events.some((event) => event.type === "retrying"));
  await queue.idle();
  assert.equal(queue.list().length, 1);
  clock.advance(100);
  await waitFor(() => queue.list().length === 0);
  const settled = events.find((event) => event.type === "settled");
  assert.ok(settled && settled.type === "settled");
  assert.equal(settled.ok, false);
  assert.equal(settled.status, 409);
  assert.equal(settled.error?.code, "already-decided");
  store.close();
});
