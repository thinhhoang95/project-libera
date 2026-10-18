// Automatic checkpoints (M2.4): an `auto` revision for every document that
// has been idle for IDLE_MS and whose text changed after its latest revision.
//
// "Changed" looks at content updates only: annotation traffic (comments,
// suggestions) does not change the text, and a revision per comment would
// bury the real versions. "Idle" looks at every sub-document, so a document
// still being discussed is not checkpointed in the middle of a session.

import { sql } from "kysely";

import { insertRevision } from "../api/revisions.js";
import type { ServerContext } from "../context.js";
import type { Job } from "./index.js";

export const CHECKPOINT_IDLE_MS = 5 * 60_000;

export const checkpointJob: Job = {
  name: "checkpoints",
  intervalMs: 60_000,
  async run(context) {
    await createIdleCheckpoints(context);
  },
};

export async function createIdleCheckpoints(context: ServerContext, now = new Date()): Promise<number> {
  const { db } = context;
  const idleBefore = new Date(now.getTime() - CHECKPOINT_IDLE_MS);
  const candidates = await db
    .selectFrom("documents as d")
    .innerJoin("projects as p", "p.id", "d.project_id")
    .select("d.id")
    .where("d.kind", "!=", "manifest")
    .where("d.deleted_at", "is", null)
    .where("p.deleted_at", "is", null)
    .where(
      sql<number>`(select max(u.server_seq) from doc_updates u where u.doc_id = d.id and u.subdoc = 'content')`,
      ">",
      sql<number>`coalesce((select max(r.server_seq) from revisions r where r.doc_id = d.id), 0)`,
    )
    .where(sql<Date>`(select max(u.received_at) from doc_updates u where u.doc_id = d.id)`, "<=", idleBefore)
    .execute();

  let created = 0;
  for (const { id } of candidates) {
    // The documents row holds the last persisted seq; a write that lands
    // after this read gets its own checkpoint once it has been idle.
    const row = await db.selectFrom("documents").select("last_server_seq").where("id", "=", id).executeTakeFirst();
    if (!row) continue;
    await insertRevision(context, { docId: id, serverSeq: row.last_server_seq, kind: "auto", label: null, createdBy: null });
    created += 1;
  }
  return created;
}
