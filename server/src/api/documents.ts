// Documents: creation with the one-time import, info, deletion, and the
// update feed used for history reconstruction and attribution.

import type { FastifyInstance } from "fastify";
import type { Kysely, Selectable } from "kysely";
import * as Y from "yjs";
import { z } from "zod";

import { requireDocumentAction, requireProjectAction, writeAudit } from "../auth/access.js";
import type { ServerContext } from "../context.js";
import type { DB, DocumentsTable, SubdocColumn } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import {
  ApiRoutes,
  bindActor,
  isSubdoc,
  SyncLimits,
  type Actor,
  type DocumentInfo,
  type Provenance,
  type UpdatesPage,
} from "../protocol.js";
import { clientIdSchema, decodeBase64, encodeBase64, iso, isoOrNull, notifyRooms, pathId, requireAccount, route } from "./common.js";

const base64Field = z.string().max(Math.ceil((SyncLimits.maxUpdateBytes * 4) / 3) + 4);

const createBody = z.object({
  docId: clientIdSchema,
  fileId: clientIdSchema,
  kind: z.enum(["markdown", "latex", "text"]),
  initial: z
    .object({ content: base64Field.optional(), annotations: base64Field.optional(), meta: base64Field.optional() })
    .optional(),
});
const projectParams = z.object({ projectId: pathId });
const docParams = z.object({ docId: pathId });
const updatesQuery = z.object({
  fromSeq: z.coerce.number().int().min(0).default(1),
  toSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  subdoc: z.string().refine(isSubdoc, "Unknown subdoc.").optional(),
});

/** The import's client id in doc_updates; client_seq is the serverSeq it got. */
const IMPORT_CLIENT_ID = "server:import";

export function documentInfo(row: Selectable<DocumentsTable>): DocumentInfo {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    fileId: row.file_id,
    schemaVersion: row.schema_version,
    lastServerSeq: row.last_server_seq,
    createdBy: row.created_by ?? "",
    createdAt: iso(row.created_at),
    deletedAt: isoOrNull(row.deleted_at),
  };
}

/** Decodes and checks each initial update before anything is written. */
function parseInitial(initial: z.infer<typeof createBody>["initial"]): { subdoc: SubdocColumn; update: Uint8Array }[] {
  const updates: { subdoc: SubdocColumn; update: Uint8Array }[] = [];
  for (const subdoc of ["content", "annotations", "meta"] as const) {
    const text = initial?.[subdoc];
    if (text === undefined) continue;
    const update = decodeBase64(text, `initial.${subdoc}`);
    if (update.byteLength > SyncLimits.maxUpdateBytes) {
      throw new HttpError("too-large", `initial.${subdoc} is larger than ${SyncLimits.maxUpdateBytes} bytes.`);
    }
    try {
      Y.applyUpdate(new Y.Doc(), update);
    } catch {
      throw new HttpError("bad-request", `initial.${subdoc} is not a valid Yjs update.`);
    }
    updates.push({ subdoc, update });
  }
  return updates;
}

async function sameDocument(
  db: Kysely<DB>,
  body: z.infer<typeof createBody>,
  projectId: string,
  accountId: string,
): Promise<DocumentInfo | null> {
  const existing = await db.selectFrom("documents").selectAll().where("id", "=", body.docId).executeTakeFirst();
  if (!existing) return null;
  const same =
    existing.project_id === projectId &&
    existing.created_by === accountId &&
    existing.kind === body.kind &&
    existing.file_id === body.fileId &&
    existing.deleted_at === null;
  if (!same) throw new HttpError("conflict", "A document with this id already exists.");
  return documentInfo(existing);
}

export function registerDocumentRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db } = context;

  app.post(route(ApiRoutes.documents, "projectId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    const body = createBody.parse(request.body);
    await requireProjectAction(db, projectId, accountId, "manage-files");

    // A replay of the same create (offline client retrying) returns the original.
    const replay = await sameDocument(db, body, projectId, accountId);
    if (replay) return reply.status(200).send(replay);

    const updates = parseInitial(body.initial);
    const actor: Actor = { kind: "system", reason: "import", onBehalfOf: accountId };
    const provenance: Provenance = { source: "import" };
    const created = await db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("documents")
        .values({
          id: body.docId,
          project_id: projectId,
          kind: body.kind,
          file_id: body.fileId,
          created_by: accountId,
          last_server_seq: updates.length,
        })
        .onConflict((conflict) => conflict.column("id").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!inserted) return null;
      if (updates.length > 0) {
        await trx
          .insertInto("doc_updates")
          .values(
            updates.map((entry, index) => ({
              doc_id: body.docId,
              subdoc: entry.subdoc,
              server_seq: index + 1,
              account_id: accountId,
              client_id: IMPORT_CLIENT_ID,
              client_seq: index + 1,
              actor: JSON.stringify(actor),
              provenance: JSON.stringify(provenance),
              update: entry.update,
              size: entry.update.byteLength,
            })),
          )
          .execute();
      }
      return inserted;
    });
    if (!created) {
      // Lost a race with a concurrent create of the same id.
      const raced = await sameDocument(db, body, projectId, accountId);
      if (raced) return reply.status(200).send(raced);
      throw new HttpError("conflict", "A document with this id already exists.");
    }
    return reply.status(201).send(documentInfo(created));
  });

  // Every live document of a project except its manifest, for members. The
  // desktop host uses it to find documents the manifest does not list yet.
  app.get(route(ApiRoutes.documents, "projectId"), async (request): Promise<DocumentInfo[]> => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    await requireProjectAction(db, projectId, accountId, "read");
    const rows = await db
      .selectFrom("documents")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("deleted_at", "is", null)
      .where("kind", "!=", "manifest")
      .orderBy("created_at")
      .execute();
    return rows.map(documentInfo);
  });

  app.get(route(ApiRoutes.document, "docId"), async (request): Promise<DocumentInfo> => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    await requireDocumentAction(db, docId, accountId, "read");
    const row = await db.selectFrom("documents").selectAll().where("id", "=", docId).executeTakeFirstOrThrow();
    return documentInfo(row);
  });

  app.delete(route(ApiRoutes.document, "docId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    const actor = bindActor(accountId, undefined);
    const access = await requireDocumentAction(db, docId, accountId, "manage-files", actor);
    if (access.kind === "manifest") throw new HttpError("bad-request", "The manifest is deleted with its project.");
    await db.updateTable("documents").set({ deleted_at: new Date() }).where("id", "=", docId).execute();
    await writeAudit(db, { projectId: access.projectId, actor, accountId, action: "document.delete", target: docId });
    notifyRooms(context, "documentDeleted", (rooms) => rooms.documentDeleted(docId));
    return reply.status(204).send();
  });

  app.get(route(ApiRoutes.documentUpdates, "docId"), async (request): Promise<UpdatesPage> => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = docParams.parse(request.params);
    const query = updatesQuery.parse(request.query);
    const access = await requireDocumentAction(db, docId, accountId, "read");
    const subdoc = query.subdoc as SubdocColumn | undefined;
    let fromSeq = Math.max(query.fromSeq, 1);

    // serverSeq is dense per document across sub-documents, so anything below
    // the oldest retained update (over all sub-documents) was compacted away.
    const document = await db.selectFrom("documents").select("last_server_seq").where("id", "=", docId).executeTakeFirstOrThrow();
    const oldest = await db
      .selectFrom("doc_updates")
      .select((eb) => eb.fn.min("server_seq").as("seq"))
      .where("doc_id", "=", docId)
      .executeTakeFirst();
    const oldestSeq = oldest?.seq === null || oldest?.seq === undefined ? null : Number(oldest.seq);
    const pruned = oldestSeq === null ? document.last_server_seq >= fromSeq : fromSeq < oldestSeq;

    let baseSnapshot: UpdatesPage["baseSnapshot"] = null;
    if (pruned) {
      const snapshotSubdoc: SubdocColumn = subdoc ?? (access.kind === "manifest" ? "manifest" : "content");
      // The earliest snapshot that covers the gap; with nothing retained, the latest.
      let select = db
        .selectFrom("doc_snapshots")
        .select(["upto_server_seq", "subdoc", "state"])
        .where("doc_id", "=", docId)
        .where("subdoc", "=", snapshotSubdoc);
      select =
        oldestSeq === null
          ? select.orderBy("upto_server_seq", "desc")
          : select.where("upto_server_seq", ">=", oldestSeq - 1).orderBy("upto_server_seq", "asc");
      const snapshot = await select.limit(1).executeTakeFirst();
      if (snapshot) {
        baseSnapshot = { uptoServerSeq: snapshot.upto_server_seq, subdoc: snapshot.subdoc, state: encodeBase64(snapshot.state) };
      }
      // Yjs updates are idempotent, so overlap between the snapshot and the
      // retained updates is harmless; every retained update is returned.
      if (oldestSeq !== null) fromSeq = Math.max(fromSeq, oldestSeq);
    }

    let select = db
      .selectFrom("doc_updates")
      .selectAll()
      .where("doc_id", "=", docId)
      .where("server_seq", ">=", fromSeq)
      .orderBy("server_seq")
      .limit(query.limit + 1);
    if (query.toSeq !== undefined) select = select.where("server_seq", "<=", query.toSeq);
    if (subdoc) select = select.where("subdoc", "=", subdoc);
    const rows = await select.execute();
    const more = rows.length > query.limit;
    const page = more ? rows.slice(0, query.limit) : rows;
    return {
      updates: page.map((row) => ({
        serverSeq: row.server_seq,
        subdoc: row.subdoc,
        userId: row.account_id,
        clientId: row.client_id,
        actor: row.actor,
        provenance: row.provenance,
        receivedAt: iso(row.received_at),
        update: encodeBase64(row.update),
      })),
      nextFromSeq: more ? rows[query.limit].server_seq : null,
      baseSnapshot,
    };
  });
}
