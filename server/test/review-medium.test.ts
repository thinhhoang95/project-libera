// Regressions for the November 2026 collaboration review's Medium server
// findings: PDF document capacity (R36) and the REST membership fence (R37).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { lockProjectAction } from "../src/auth/access.js";
import type { SyncServer } from "../src/sync/server.js";
import { PdfLimits, pdfDocIdFromDigest, pdfDocIdSeed } from "../src/protocol.js";
import { startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

const pdfDocId = (projectId: string, fileId: string) =>
  pdfDocIdFromDigest(createHash("sha256").update(pdfDocIdSeed(projectId, fileId)).digest("base64url"));

const LONG_AGO = new Date(Date.now() - 24 * 60 * 60_000);

describe("review: medium server findings", () => {
  let env: SyncEnv;
  let sync: SyncServer;
  before(async () => {
    env = await startSyncEnv();
    sync = env.server.server.sync as unknown as SyncServer;
  });
  after(async () => {
    await env.close();
  });

  async function insertPdf(fileId: string, fields: { createdAt?: Date; lastServerSeq?: number } = {}) {
    const id = pdfDocId(env.project.id, fileId);
    await env.db.insertInto("documents").values({
      id, project_id: env.project.id, kind: "pdf", file_id: fileId, created_by: env.owner.id,
      last_server_seq: fields.lastServerSeq ?? 0, created_at: fields.createdAt ?? LONG_AGO,
    }).execute();
    return id;
  }
  const exists = async (id: string) => Boolean(await env.db.selectFrom("documents").select("id").where("id", "=", id).executeTakeFirst());

  test("R36: only old, never-written, comment-free PDF documents are reclaimed", async () => {
    const empty = await insertPdf("fil_reclaim_empty");
    const written = await insertPdf("fil_reclaim_written", { lastServerSeq: 3 });
    const recent = await insertPdf("fil_reclaim_recent", { createdAt: new Date() });
    const commented = await insertPdf("fil_reclaim_commented");
    await env.db.insertInto("threads").values({
      id: "thr_reclaim", doc_id: commented, project_id: env.project.id, anchor_id: "anc_reclaim", quote_text: "q",
      status: "open", actor: JSON.stringify({ kind: "human", accountId: env.owner.id }), account_id: env.owner.id,
    }).execute();

    assert.equal(await sync.reclaimEmptyPdfDocuments(env.project.id), 1);
    assert.deepEqual(await Promise.all([empty, written, recent, commented].map(exists)), [false, true, true, true]);
    await env.db.deleteFrom("documents").where("id", "in", [written, recent, commented]).execute();
  });

  test("R36: a project full of unwritten documents still opens a real PDF", async () => {
    const rows = Array.from({ length: PdfLimits.maxDocuments }, (_, index) => {
      const fileId = `fil_flood_${index}`;
      return { id: pdfDocId(env.project.id, fileId), project_id: env.project.id, kind: "pdf" as const, file_id: fileId, created_by: env.owner.id, last_server_seq: 0, created_at: LONG_AGO };
    });
    for (let start = 0; start < rows.length; start += 2_000) await env.db.insertInto("documents").values(rows.slice(start, start + 2_000)).execute();

    const fileId = "fil_wanted_pdf";
    const docId = pdfDocId(env.project.id, fileId);
    await sync.ensurePdfDocument(env.owner.id, docId, { projectId: env.project.id, fileId });
    assert.equal(await exists(docId), true, "the flood was reclaimed and the PDF's document made");
    await env.db.deleteFrom("documents").where("project_id", "=", env.project.id).where("kind", "=", "pdf").execute();
  });

  test("R37: a write transaction refuses a membership removed or demoted after the first check", async () => {
    const member = await env.member("editor");
    const inTransaction = (action: "comment" | "manage-files") =>
      env.db.transaction().execute((trx) => lockProjectAction(trx, env.project.id, member.id, action));

    assert.equal(await inTransaction("manage-files"), "editor");
    await env.db.updateTable("memberships").set({ role: "viewer" }).where("project_id", "=", env.project.id).where("account_id", "=", member.id).execute();
    await assert.rejects(inTransaction("comment"), { code: "forbidden" });
    await env.db.deleteFrom("memberships").where("project_id", "=", env.project.id).where("account_id", "=", member.id).execute();
    await assert.rejects(inTransaction("comment"), { code: "forbidden" });
  });
});
