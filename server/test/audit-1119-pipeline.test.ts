// Audit 2026-11-19 finding 6: after the server fails to store an update, a
// later pipelined update that depends on it must be refused as a retryable
// error, never as a permanent `invalid-update` (which makes the host roll the
// sub-document back and discard its queue).

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { MessageType } from "../src/protocol.js";
import { startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

interface PersistHook {
  persist: (...args: unknown[]) => Promise<number | null>;
}

describe("audit 1119: pipelined updates after a failed write", () => {
  let env: SyncEnv;
  before(async () => {
    env = await startSyncEnv();
  });
  after(() => env.close());

  test("a dependent update after a failed write gets a retryable error, then both apply on resend", async () => {
    const client = await env.connect();
    await client.open(env.docId);
    const hook = env.server.server.sync as unknown as PersistHook;
    const original = hook.persist;
    let failures = 1;
    hook.persist = function (this: unknown, ...args: unknown[]) {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("simulated write failure"));
      }
      return original.apply(this, args);
    };
    try {
      const first = client.edit(env.docId, "content", (doc) => doc.getText("source").insert(0, "one "));
      const second = client.edit(env.docId, "content", (doc) => doc.getText("source").insert(0, "two "));
      await client.waitFor((m) => m.type === MessageType.Error && m.code === "internal");
      // The dependent update must be refused as retryable, never as malformed.
      await client.waitFor((m) => m.type === MessageType.Error && m.code === "internal");
      assert.equal(
        client.received.some((m) => m.type === MessageType.Reject && m.docId === env.docId),
        false,
        "no permanent reject for a dependent update",
      );
      // The host resends its window from the oldest unacknowledged batch.
      client.sendUpdate(first);
      client.sendUpdate(second);
      await client.acked(first);
      await client.acked(second);
      const other = await env.connect();
      await other.open(env.docId);
      assert.equal(other.text(env.docId), "two one ");
    } finally {
      hook.persist = original;
    }
  });
});
