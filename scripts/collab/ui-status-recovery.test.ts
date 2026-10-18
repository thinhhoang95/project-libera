// Regressions found by the end-to-end run in the real app:
// 1. The first status request fails with 401 on the login screen; with live
//    events the store never asked again, so collaboration looked unavailable
//    (and shared files opened as plain local tabs) until "Try again".
// 2. A sign-in/register response applied after a newer status event left
//    the UI on "Connecting…".

import assert from "node:assert/strict";
import test from "node:test";

import type { HostEvent, HostStatus } from "../../src/lib/collab/local-api";
import type { CollabClient } from "../../src/lib/collab/ui/client";
import { createCollabStatusStore } from "../../src/lib/collab/ui/status-store";

function status(connection: HostStatus["connection"]): HostStatus {
  return { hostVersion: 1, connection, account: null, projects: [], pendingCommands: 0 };
}

async function until(check: () => boolean, label: string, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a failed first request is retried even when live events exist", async () => {
  let calls = 0;
  const client = {
    status: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("Authentication required.") as Error & { status: number; code: string };
        error.status = 401;
        error.code = "unauthorized";
        throw error;
      }
      return status("connected");
    },
  } as unknown as CollabClient;
  const store = createCollabStatusStore({
    client,
    subscribeEvents: () => () => {},
    hasLiveEvents: () => true,
    retryMs: 20,
  });
  const stop = store.subscribe(() => {});
  try {
    await until(() => store.getSnapshot().phase === "error", "the first request to fail");
    await until(() => store.getSnapshot().status?.connection === "connected", "the retry to succeed");
    assert.equal(calls, 2);
  } finally {
    stop();
  }
});

test("a response applied after a newer status event is confirmed with a fresh request", async () => {
  let listener: ((event: HostEvent) => void) | null = null;
  let current = status("connecting");
  const client = { status: async () => current } as unknown as CollabClient;
  const store = createCollabStatusStore({
    client,
    subscribeEvents: (next) => {
      listener = next;
      return () => {};
    },
    hasLiveEvents: () => true,
  });
  const stop = store.subscribe(() => {});
  try {
    await until(() => store.getSnapshot().phase === "ready", "the first status");
    // The host connects and says so...
    current = status("connected");
    listener!({ t: "status", status: current });
    assert.equal(store.getSnapshot().status?.connection, "connected");
    // ...then the register response, computed earlier, arrives.
    store.setStatus(status("connecting"));
    await until(() => store.getSnapshot().status?.connection === "connected", "the store to reconcile");
  } finally {
    stop();
  }
});

test("retries stop when the last subscriber leaves", async () => {
  let calls = 0;
  const client = {
    status: async () => {
      calls += 1;
      throw Object.assign(new Error("down"), { status: 503, code: "collab-unavailable" });
    },
  } as unknown as CollabClient;
  const store = createCollabStatusStore({ client, subscribeEvents: () => () => {}, hasLiveEvents: () => true, retryMs: 20 });
  const stop = store.subscribe(() => {});
  await until(() => calls >= 2, "a retry");
  stop();
  const after = calls;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls, after);
});
