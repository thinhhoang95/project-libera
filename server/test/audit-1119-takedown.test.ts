// Audit 2026-11-19, findings 8 and 32: takedown fences text and comment writes
// (not only the manifest sequence), and takedown and a document update take
// their row locks in one order.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { MessageType, type ProjectClosingResponse } from "../src/protocol.js";
import { json } from "./helpers.js";
import { startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

let env: SyncEnv;
before(async () => {
  env = await startSyncEnv();
});
after(() => env.close());

const project = () => `/v1/projects/${env.project.id}`;
const thread = (id: string) => ({ id, anchorId: `anc_${id}`, quote: "text", body: "A comment" });

describe("audit 1119: takedown write fence", () => {
  test("after the fence, document updates and comments are refused; lifting it restores them", async () => {
    const client = await env.connect();
    await client.open(env.docId);
    await client.acked(client.edit(env.docId, "content", (doc) => doc.getText("source").insert(0, "before ")));

    const closing = await json<ProjectClosingResponse>(env.server.url, `${project()}/closing`, { method: "POST", token: env.owner.token, body: {} });
    assert.equal(closing.status, 200);
    const doc = closing.body.docs.find((entry) => entry.docId === env.docId);
    assert.ok(doc && doc.serverSeq >= 1, "the fence reports each document's final sequence");
    assert.ok(closing.body.docs.some((entry) => entry.docId === env.project.manifestDocId));

    // A text update after the fence is not stored: the client keeps it queued (retryable error, no ack, no reject).
    const refused = client.edit(env.docId, "content", (d) => d.getText("source").insert(0, "late "));
    await client.waitFor((m) => m.type === MessageType.Error && m.code === "internal");
    assert.equal(client.received.some((m) => m.type === MessageType.Reject), false);
    const seqAfter = await env.db.selectFrom("documents").select("last_server_seq").where("id", "=", env.docId).executeTakeFirstOrThrow();
    assert.equal(seqAfter.last_server_seq, doc.serverSeq, "the document did not move past the fenced sequence");

    // A comment is refused as well, with a conflict that says why.
    const comment = await json<{ error: { code: string; details?: { closing?: boolean } } }>(env.server.url, `/v1/documents/${env.docId}/threads`, {
      token: env.owner.token, body: thread("thr_fenced_0001"),
    });
    assert.equal(comment.status, 409);
    assert.equal(comment.body.error.details?.closing, true);

    // The takedown is abandoned: the fence lifts, the queued update is resent and applies, comments work again.
    assert.equal((await json(env.server.url, `${project()}/closing`, { method: "DELETE", token: env.owner.token })).status, 204);
    client.sendUpdate(refused);
    await client.acked(refused);
    const comment2 = await json(env.server.url, `/v1/documents/${env.docId}/threads`, { token: env.owner.token, body: thread("thr_fenced_0002") });
    assert.equal(comment2.status, 201);
    await client.close();
  });

  test("only the owner can fence a project", async () => {
    const editor = await env.member("editor");
    const response = await json(env.server.url, `${project()}/closing`, { method: "POST", token: editor.token, body: {} });
    assert.equal(response.status, 403);
    const row = await env.db.selectFrom("projects").select("closing_at").where("id", "=", env.project.id).executeTakeFirstOrThrow();
    assert.equal(row.closing_at, null);
  });
});

describe("audit 1119: lock order", () => {
  /** Records the SQL PGlite runs (also inside transactions) while `run` executes. */
  async function recordSql(run: () => Promise<void>): Promise<string[]> {
    const proto = PGlite.prototype as unknown as {
      query: (sql: string, ...rest: unknown[]) => Promise<unknown>;
      transaction: (callback: (tx: { query: (sql: string, ...rest: unknown[]) => Promise<unknown> }) => Promise<unknown>) => Promise<unknown>;
    };
    const originalQuery = proto.query;
    const originalTransaction = proto.transaction;
    const statements: string[] = [];
    proto.query = function (this: unknown, sql: string, ...rest: unknown[]) {
      statements.push(String(sql));
      return originalQuery.call(this, sql, ...rest);
    };
    proto.transaction = function (this: unknown, callback) {
      return originalTransaction.call(this, (tx) => {
        const query = tx.query.bind(tx);
        tx.query = (sql: string, ...rest: unknown[]) => { statements.push(String(sql)); return query(sql, ...rest); };
        return callback(tx);
      });
    };
    try { await run(); } finally {
      proto.query = originalQuery;
      proto.transaction = originalTransaction;
    }
    return statements;
  }

  const firstIndex = (statements: string[], pattern: RegExp) => statements.findIndex((sql) => pattern.test(sql));

  test("a document update locks the document row before the membership row", async () => {
    const client = await env.connect();
    await client.open(env.docId);
    const statements = await recordSql(async () => {
      await client.acked(client.edit(env.docId, "content", (doc) => doc.getText("source").insert(0, "x")));
    });
    await client.close();
    const document = firstIndex(statements, /update "documents" set "last_server_seq"/);
    const membership = firstIndex(statements, /from "memberships"[\s\S]*for share/i);
    assert.ok(document >= 0 && membership >= 0, "both locks were taken");
    assert.ok(document < membership, "document row first, then membership");
  });

  test("guarded takedown locks documents (the manifest included) before memberships", async () => {
    const other = await startSyncEnv();
    try {
      const statements = await recordSql(async () => {
        const response = await json(other.server.url, `/v1/projects/${other.project.id}`, { method: "DELETE", token: other.owner.token, body: { expectedManifestSeq: 0 } });
        assert.equal(response.status, 204);
      });
      const documents = firstIndex(statements, /from "documents"[\s\S]*for update/i);
      const memberships = firstIndex(statements, /from "memberships"[\s\S]*for update/i);
      assert.ok(documents >= 0 && memberships >= 0, "both locks were taken");
      assert.ok(documents < memberships, "documents first, then memberships (the order persistUpdate uses)");
    } finally { await other.close(); }
  });
});
