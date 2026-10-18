// doc rebuild <docId> --to <serverSeq> [--subdoc s] [--dry-run]
//
// Restores a document to its state at a serverSeq as a new forward update,
// the way restore (M2.5) does: history is never rewritten. The update is
// applied through a collab server started inside this process on the same
// database, so it goes through the room lock and persistUpdate like any
// other server change, with actor system:migration. A pre-restore revision
// marks the state before it, so the rebuild itself can be undone with the
// normal restore.

import type * as Y from "yjs";

import { buildServer } from "../app.js";
import { writeAudit } from "../auth/access.js";
import { insertRevision } from "../api/revisions.js";
import { canonicalJson, isSubdoc, type Actor, type Subdoc } from "../protocol.js";
import { loadSubdocState, subdocsForKind } from "../sync/store.js";
import type { AdminContext, CommandResult } from "./context.js";
import { findDocument } from "./documents.js";
import {
  applyState,
  CliError,
  compareStates,
  describeChange,
  isEmptyChange,
  parseSeq,
  plainState,
  requireReconstructible,
  type StateChange,
} from "./history.js";
import { liveServer, requireRoomUnloaded, roomStatus } from "./live.js";

export const MIGRATION_ACTOR: Actor = { kind: "system", reason: "migration" };

function serializeChange(change: StateChange) {
  return {
    subdoc: change.subdoc,
    texts: change.texts.map((text) => ({ name: text.name, beforeLength: text.before.length, afterLength: text.after.length })),
    maps: change.maps,
    skipped: change.skipped,
  };
}

export async function docRebuild(ctx: AdminContext): Promise<CommandResult> {
  const docId = ctx.args.positional(2, "docId");
  const toSeq = parseSeq(ctx.args.string("to"), "--to");
  const dryRun = ctx.args.has("dry-run");
  const { db } = ctx;
  const document = await findDocument(db, docId);
  if (document.deleted_at) throw new CliError(`Document ${docId} is deleted.`);
  const lastSeq = Number(document.last_server_seq);
  if (toSeq > lastSeq) throw new CliError(`--to ${toSeq} is after the last serverSeq ${lastSeq}.`);

  let subdocs = subdocsForKind(document.kind);
  const only = ctx.args.string("subdoc");
  if (only !== undefined) {
    if (!isSubdoc(only) || !subdocs.includes(only)) throw new CliError(`A ${document.kind} document has no ${only} sub-document.`);
    subdocs = [only];
  }
  await requireReconstructible(db, docId, subdocs, toSeq);

  const targets = new Map<Subdoc, Y.Doc>();
  for (const subdoc of subdocs) targets.set(subdoc, await loadSubdocState(db, docId, subdoc, toSeq));
  try {
    if (dryRun) {
      const changes: StateChange[] = [];
      for (const subdoc of subdocs) {
        const current = await loadSubdocState(db, docId, subdoc, lastSeq);
        try {
          changes.push(compareStates(subdoc, current, targets.get(subdoc) as Y.Doc));
        } finally {
          current.destroy();
        }
      }
      return report(docId, toSeq, lastSeq, lastSeq, changes, true, null);
    }

    const live = liveServer(ctx.config, ctx.args.string("server"));
    await requireRoomUnloaded(live, docId, ctx.args.has("server-stopped"));

    // A server in this process, on the same database: no listener, no jobs.
    const server = await buildServer({
      config: { ...ctx.config, LOG_LEVEL: process.env.ADMIN_LOG_LEVEL ?? "silent", ERROR_REPORT_DSN: undefined },
      database: ctx.database,
      skipMigrations: true,
      jobs: false,
    });
    try {
      const context = server.context;
      const outcome = await context.rooms.batch(docId, async (batch) => {
        const changes = subdocs.map((subdoc) => compareStates(subdoc, batch.docs[subdoc], targets.get(subdoc) as Y.Doc));
        if (changes.every(isEmptyChange)) return { changes, serverSeq: batch.serverSeq(), checkpoint: null };
        const checkpoint =
          document.kind === "manifest"
            ? null
            : await insertRevision(context, { docId, serverSeq: batch.serverSeq(), kind: "pre-restore", label: `before admin rebuild to ${toSeq}`, createdBy: null });
        for (const change of changes) {
          if (isEmptyChange(change)) continue;
          const target = targets.get(change.subdoc) as Y.Doc;
          await batch.transact(change.subdoc, MIGRATION_ACTOR, { source: "system" }, (doc) => applyState(doc, target, change.subdoc));
        }
        // The rebuilt state must now match the target.
        for (const subdoc of subdocs) {
          const after = canonicalJson(plainState(batch.docs[subdoc], subdoc));
          if (after !== canonicalJson(plainState(targets.get(subdoc) as Y.Doc, subdoc))) {
            throw new CliError(`${subdoc} does not match serverSeq ${toSeq} after the rebuild; see the log.`);
          }
        }
        return { changes, serverSeq: batch.serverSeq(), checkpoint: checkpoint?.id ?? null };
      });
      if (!outcome.changes.every(isEmptyChange)) {
        await writeAudit(db, {
          projectId: document.project_id,
          actor: MIGRATION_ACTOR,
          accountId: null,
          action: "admin.document.rebuild",
          target: docId,
          details: { toSeq, fromSeq: lastSeq, serverSeq: outcome.serverSeq, subdocs, checkpointRevisionId: outcome.checkpoint },
        });
      }
      const after = await roomStatus(live, docId).catch(() => null);
      if (after?.loaded) ctx.note(`Warning: ${docId} was opened on the running server during the rebuild; restart it so clients see the new state.`);
      return report(docId, toSeq, lastSeq, outcome.serverSeq, outcome.changes, false, outcome.checkpoint);
    } finally {
      await server.close();
    }
  } finally {
    for (const doc of targets.values()) doc.destroy();
  }
}

function report(
  docId: string,
  toSeq: number,
  fromSeq: number,
  serverSeq: number,
  changes: StateChange[],
  dryRun: boolean,
  checkpoint: string | null,
): CommandResult {
  const empty = changes.every(isEmptyChange);
  const text = [
    dryRun
      ? `Dry run: rebuilding ${docId} to serverSeq ${toSeq} (now at ${fromSeq}) would change:`
      : empty
        ? `${docId} already matches serverSeq ${toSeq}; nothing written.`
        : `Rebuilt ${docId} to its state at serverSeq ${toSeq} as serverSeq ${serverSeq} (actor system:migration).`,
  ];
  if (checkpoint) text.push(`Checkpoint before the rebuild: revision ${checkpoint} (restore it to undo).`);
  for (const change of changes) text.push(...describeChange(change));
  if (dryRun && empty) text.push("  nothing");
  return {
    data: { docId, toSeq, fromSeq, serverSeq, dryRun, changed: !empty, checkpointRevisionId: checkpoint, changes: changes.map(serializeChange) },
    text,
  };
}
