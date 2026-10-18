// Read-only and additive document commands: docs list, doc inspect, doc text,
// doc export, project export, doc snapshot.

import { createWriteStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { sql, type Kysely } from "kysely";
import type * as Y from "yjs";

import { createBlobStore } from "../blobs/index.js";
import type { DB, DocumentRow } from "../db/types.js";
import {
  ContentKeys,
  ManifestKeys,
  manifestPathError,
  manifestPathKey,
  type ManifestEntry,
  type Subdoc,
} from "../protocol.js";
import { consistentRead, loadSubdocState, subdocsForKind, writeSnapshot } from "../sync/store.js";
import { bytes, isoTime, table, type AdminContext, type CommandResult } from "./context.js";
import { CliError, parseRange, parseSeq, requireReconstructible } from "./history.js";

export async function findDocument(db: Kysely<DB>, docId: string): Promise<DocumentRow> {
  const row = await db.selectFrom("documents").selectAll().where("id", "=", docId).executeTakeFirst();
  if (!row) throw new CliError(`Document ${docId} does not exist.`);
  return row;
}

/** Manifest entries of a project, keyed by fileId. */
export async function manifestEntries(db: Kysely<DB>, manifestDocId: string): Promise<ManifestEntry[]> {
  const doc = await loadSubdocState(db, manifestDocId, "manifest");
  try {
    return Object.values(doc.getMap(ManifestKeys.files).toJSON() as Record<string, ManifestEntry>);
  } finally {
    doc.destroy();
  }
}

async function projectManifest(db: Kysely<DB>, projectId: string): Promise<{ manifestDocId: string; entries: ManifestEntry[] }> {
  const project = await db.selectFrom("projects").select(["manifest_doc_id"]).where("id", "=", projectId).executeTakeFirst();
  if (!project) throw new CliError(`Project ${projectId} does not exist.`);
  return { manifestDocId: project.manifest_doc_id, entries: await manifestEntries(db, project.manifest_doc_id) };
}

/** docId -> path, from the first valid entry (by path) that points at each document. */
function docPaths(entries: ManifestEntry[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (entry.kind !== "doc" || !entry.docId || paths.has(entry.docId) || manifestPathError(entry.path)) continue;
    paths.set(entry.docId, entry.path);
  }
  return paths;
}

async function pathOf(db: Kysely<DB>, document: DocumentRow): Promise<string | null> {
  if (document.kind === "manifest") return null;
  const { entries } = await projectManifest(db, document.project_id);
  return docPaths(entries).get(document.id) ?? null;
}

/** The text of a text document, or the manifest entries as lines, at `seq`. */
async function textAt(db: Kysely<DB>, document: DocumentRow, seq: number): Promise<string> {
  const subdoc: Subdoc = document.kind === "manifest" ? "manifest" : "content";
  await requireReconstructible(db, document.id, [subdoc], seq);
  const doc = await loadSubdocState(db, document.id, subdoc, seq);
  try {
    if (subdoc === "content") return doc.getText(ContentKeys.source).toString();
    const entries = Object.values(doc.getMap(ManifestKeys.files).toJSON() as Record<string, ManifestEntry>);
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    return entries.map((entry) => `${entry.path}\t${entry.kind}\t${entry.docId ?? entry.blobHash ?? ""}`).join("\n");
  } finally {
    doc.destroy();
  }
}

// ------------------------------------------------------------------ docs list

export async function docsList(ctx: AdminContext): Promise<CommandResult> {
  const projectId = ctx.args.required("project");
  const { manifestDocId, entries } = await projectManifest(ctx.db, projectId);
  const paths = docPaths(entries);
  let query = ctx.db
    .selectFrom("documents as d")
    .leftJoin("doc_updates as u", "u.doc_id", "d.id")
    .select([
      "d.id",
      "d.kind",
      "d.last_server_seq",
      "d.deleted_at",
      "d.created_at",
      (eb) => eb.fn.count<number>("u.server_seq").as("updates"),
      (eb) => eb.fn.coalesce(eb.fn.sum<number>("u.size"), sql<number>`0`).as("bytes"),
    ])
    .where("d.project_id", "=", projectId)
    .groupBy(["d.id", "d.kind", "d.last_server_seq", "d.deleted_at", "d.created_at"])
    .orderBy("d.created_at");
  if (!ctx.args.has("include-deleted")) query = query.where("d.deleted_at", "is", null);
  const rows = await query.execute();
  const documents = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    path: row.id === manifestDocId ? "(manifest)" : (paths.get(row.id) ?? null),
    lastServerSeq: Number(row.last_server_seq),
    updates: Number(row.updates),
    bytes: Number(row.bytes),
    deletedAt: isoTime(row.deleted_at),
  }));
  return {
    data: { projectId, documents },
    text: table(
      ["DOC", "KIND", "PATH", "SEQ", "UPDATES", "LOG", "DELETED"],
      documents.map((doc) => [doc.id, doc.kind, doc.path, doc.lastServerSeq, doc.updates, bytes(doc.bytes), doc.deletedAt]),
    ),
  };
}

// ------------------------------------------------------------------ doc inspect

function actorLabel(actor: unknown): string {
  if (!actor || typeof actor !== "object") return "-";
  const value = actor as { kind?: string; feature?: string; reason?: string };
  if (value.kind === "ai") return `ai:${value.feature ?? "?"}`;
  if (value.kind === "system") return `system:${value.reason ?? "?"}`;
  return value.kind ?? "-";
}

export async function docInspect(ctx: AdminContext): Promise<CommandResult> {
  const docId = ctx.args.positional(2, "docId");
  const { db } = ctx;
  const document = await findDocument(db, docId);
  const path = await pathOf(db, document);

  const snapshots = await db
    .selectFrom("doc_snapshots")
    .select(["subdoc", "upto_server_seq", "created_at", sql<number>`octet_length(state)`.as("bytes")])
    .where("doc_id", "=", docId)
    .orderBy("upto_server_seq")
    .orderBy("subdoc")
    .execute();
  const bySubdoc = await db
    .selectFrom("doc_updates")
    .select([
      "subdoc",
      (eb) => eb.fn.countAll<number>().as("updates"),
      (eb) => eb.fn.sum<number>("size").as("bytes"),
      (eb) => eb.fn.min<number>("server_seq").as("min_seq"),
      (eb) => eb.fn.max<number>("server_seq").as("max_seq"),
    ])
    .where("doc_id", "=", docId)
    .groupBy("subdoc")
    .orderBy("subdoc")
    .execute();
  const byUser = await db
    .selectFrom("doc_updates")
    .select([
      "account_id",
      sql<string>`coalesce(actor->>'kind', '-')`.as("actor_kind"),
      sql<string>`coalesce(actor->>'feature', actor->>'reason', '')`.as("actor_detail"),
      (eb) => eb.fn.countAll<number>().as("updates"),
      (eb) => eb.fn.sum<number>("size").as("bytes"),
      (eb) => eb.fn.min("received_at").as("first"),
      (eb) => eb.fn.max("received_at").as("last"),
    ])
    .where("doc_id", "=", docId)
    .groupBy(["account_id", sql`actor->>'kind'`, sql`coalesce(actor->>'feature', actor->>'reason', '')`])
    .orderBy("updates", "desc")
    .execute();
  const accountIds = [...new Set(byUser.map((row) => row.account_id).filter((id): id is string => id !== null))];
  const emails = new Map(
    accountIds.length === 0
      ? []
      : (await db.selectFrom("accounts").select(["id", "email"]).where("id", "in", accountIds).execute()).map((row) => [row.id, row.email]),
  );
  const byDay = await db
    .selectFrom("doc_updates")
    .select([
      sql<string>`to_char(received_at at time zone 'UTC', 'YYYY-MM-DD')`.as("day"),
      (eb) => eb.fn.countAll<number>().as("updates"),
      (eb) => eb.fn.sum<number>("size").as("bytes"),
    ])
    .where("doc_id", "=", docId)
    .groupBy(sql`to_char(received_at at time zone 'UTC', 'YYYY-MM-DD')`)
    .orderBy("day")
    .execute();
  const byProvenance = await db
    .selectFrom("doc_updates")
    .select([
      sql<string>`coalesce(provenance->>'source', '-')`.as("source"),
      (eb) => eb.fn.countAll<number>().as("updates"),
      (eb) => eb.fn.sum<number>("size").as("bytes"),
    ])
    .where("doc_id", "=", docId)
    .groupBy(sql`coalesce(provenance->>'source', '-')`)
    .orderBy("updates", "desc")
    .execute();
  const revisions = await db.selectFrom("revisions").select((eb) => eb.fn.countAll<number>().as("n")).where("doc_id", "=", docId).executeTakeFirst();
  const quarantined = await db
    .selectFrom("quarantined_updates")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("doc_id", "=", docId)
    .executeTakeFirst();

  let updates: unknown[] | undefined;
  const rangeText = ctx.args.string("updates");
  if (rangeText !== undefined) {
    const range = parseRange(rangeText, "--updates");
    let query = db
      .selectFrom("doc_updates")
      .select(["server_seq", "subdoc", "account_id", "client_id", "client_seq", "actor", "provenance", "size", "received_at"])
      .where("doc_id", "=", docId)
      .where("server_seq", ">=", range.from)
      .orderBy("server_seq")
      .limit(ctx.args.int("limit", 500));
    if (range.to !== null) query = query.where("server_seq", "<=", range.to);
    updates = (await query.execute()).map((row) => ({
      serverSeq: Number(row.server_seq),
      subdoc: row.subdoc,
      accountId: row.account_id,
      clientId: row.client_id,
      clientSeq: Number(row.client_seq),
      actor: actorLabel(row.actor),
      provenance: row.provenance?.source ?? null,
      size: row.size,
      receivedAt: isoTime(row.received_at),
    }));
  }

  const data = {
    id: document.id,
    projectId: document.project_id,
    kind: document.kind,
    fileId: document.file_id,
    path,
    schemaVersion: document.schema_version,
    lastServerSeq: Number(document.last_server_seq),
    createdAt: isoTime(document.created_at),
    deletedAt: isoTime(document.deleted_at),
    revisions: Number(revisions?.n ?? 0),
    quarantinedUpdates: Number(quarantined?.n ?? 0),
    snapshots: snapshots.map((row) => ({
      subdoc: row.subdoc,
      uptoServerSeq: Number(row.upto_server_seq),
      bytes: Number(row.bytes),
      createdAt: isoTime(row.created_at),
    })),
    log: bySubdoc.map((row) => ({
      subdoc: row.subdoc,
      updates: Number(row.updates),
      bytes: Number(row.bytes),
      minSeq: Number(row.min_seq),
      maxSeq: Number(row.max_seq),
    })),
    byUser: byUser.map((row) => ({
      accountId: row.account_id,
      email: row.account_id ? (emails.get(row.account_id) ?? null) : null,
      actor: row.actor_detail ? `${row.actor_kind}:${row.actor_detail}` : row.actor_kind,
      updates: Number(row.updates),
      bytes: Number(row.bytes),
      first: isoTime(row.first as Date),
      last: isoTime(row.last as Date),
    })),
    byDay: byDay.map((row) => ({ day: row.day, updates: Number(row.updates), bytes: Number(row.bytes) })),
    byProvenance: byProvenance.map((row) => ({ source: row.source, updates: Number(row.updates), bytes: Number(row.bytes) })),
    ...(updates ? { updates } : {}),
  };

  const text = [
    `Document ${data.id} (${data.kind}) in project ${data.projectId}`,
    `  path: ${data.path ?? "-"}   schema: ${data.schemaVersion}   last serverSeq: ${data.lastServerSeq}`,
    `  created: ${data.createdAt}   deleted: ${data.deletedAt ?? "no"}   revisions: ${data.revisions}   quarantined updates: ${data.quarantinedUpdates}`,
    "",
    "Snapshots",
    ...table(["SUBDOC", "UPTO", "SIZE", "CREATED"], data.snapshots.map((s) => [s.subdoc, s.uptoServerSeq, bytes(s.bytes), s.createdAt])),
    "",
    "Retained log by sub-document",
    ...table(["SUBDOC", "UPDATES", "SIZE", "SEQS"], data.log.map((l) => [l.subdoc, l.updates, bytes(l.bytes), `${l.minSeq}..${l.maxSeq}`])),
    "",
    "By user",
    ...table(
      ["ACCOUNT", "EMAIL", "ACTOR", "UPDATES", "SIZE", "FIRST", "LAST"],
      data.byUser.map((u) => [u.accountId, u.email, u.actor, u.updates, bytes(u.bytes), u.first, u.last]),
    ),
    "",
    "By day (UTC)",
    ...table(["DAY", "UPDATES", "SIZE"], data.byDay.map((d) => [d.day, d.updates, bytes(d.bytes)])),
    "",
    "By provenance",
    ...table(["SOURCE", "UPDATES", "SIZE"], data.byProvenance.map((p) => [p.source, p.updates, bytes(p.bytes)])),
  ];
  if (data.updates) {
    text.push(
      "",
      `Updates ${rangeText}`,
      ...table(
        ["SEQ", "SUBDOC", "ACCOUNT", "CLIENT", "CSEQ", "ACTOR", "PROVENANCE", "SIZE", "RECEIVED"],
        (data.updates as Array<Record<string, string | number | null>>).map((u) => [
          u.serverSeq,
          u.subdoc,
          u.accountId,
          u.clientId,
          u.clientSeq,
          u.actor,
          u.provenance,
          u.size,
          u.receivedAt,
        ]),
      ),
    );
  }
  return { data, text };
}

// ------------------------------------------------------------------ doc text / export

export async function docText(ctx: AdminContext): Promise<CommandResult> {
  const docId = ctx.args.positional(2, "docId");
  const document = await findDocument(ctx.db, docId);
  const at = ctx.args.has("at") ? parseSeq(ctx.args.string("at"), "--at") : Number(document.last_server_seq);
  if (at > document.last_server_seq) throw new CliError(`--at ${at} is after the last serverSeq ${document.last_server_seq}.`);
  const text = await textAt(ctx.db, document, at);
  return { data: { docId, serverSeq: at, text }, text: [text] };
}

export async function docExport(ctx: AdminContext): Promise<CommandResult> {
  const docId = ctx.args.positional(2, "docId");
  const out = resolve(ctx.args.required("out"));
  const document = await findDocument(ctx.db, docId);
  const at = ctx.args.has("at") ? parseSeq(ctx.args.string("at"), "--at") : Number(document.last_server_seq);
  const text = await textAt(ctx.db, document, at);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text, "utf8");
  const size = Buffer.byteLength(text);
  return { data: { docId, serverSeq: at, out, bytes: size }, text: [`Wrote ${out} (${bytes(size)}, serverSeq ${at}).`] };
}

const EXPORT_META = ".libera-export";

async function requireEmptyDir(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir);
    if (entries.length > 0) throw new CliError(`${dir} is not empty; export into a new directory.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dir, { recursive: true });
}

async function contentText(db: Kysely<DB>, docId: string): Promise<string> {
  const doc: Y.Doc = await loadSubdocState(db, docId, "content");
  try {
    return doc.getText(ContentKeys.source).toString();
  } finally {
    doc.destroy();
  }
}

/**
 * Writes every manifest entry at its path (documents as text, blobs as their
 * bytes), then the export's own files under .libera-export/: the manifest,
 * blobs of the project that no entry references, and live documents that
 * are not in the manifest.
 */
export async function projectExport(ctx: AdminContext): Promise<CommandResult> {
  const projectId = ctx.args.positional(2, "projectId");
  const out = resolve(ctx.args.required("out"));
  const { db } = ctx;
  const { manifestDocId, entries } = await projectManifest(db, projectId);
  await requireEmptyDir(out);
  const store = createBlobStore(ctx.config);
  const written: Array<{ path: string; kind: string; bytes: number }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const taken = new Set<string>();
  const referencedBlobs = new Set<string>();
  const listedDocs = new Set<string>();

  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const entry of sorted) {
    const problem = manifestPathError(entry.path);
    if (problem) {
      skipped.push({ path: entry.path, reason: problem });
      continue;
    }
    const key = manifestPathKey(entry.path);
    if (taken.has(key)) {
      skipped.push({ path: entry.path, reason: "Clashes with another entry on a case-insensitive disk." });
      continue;
    }
    taken.add(key);
    const target = join(out, ...entry.path.split("/"));
    if (entry.kind === "folder") {
      await mkdir(target, { recursive: true });
      written.push({ path: entry.path, kind: "folder", bytes: 0 });
    } else if (entry.kind === "doc" && entry.docId) {
      listedDocs.add(entry.docId);
      const document = await db.selectFrom("documents").select(["id", "deleted_at"]).where("id", "=", entry.docId).executeTakeFirst();
      if (!document) {
        skipped.push({ path: entry.path, reason: `Document ${entry.docId} does not exist.` });
        continue;
      }
      const text = await contentText(db, entry.docId);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
      written.push({ path: entry.path, kind: "doc", bytes: Buffer.byteLength(text) });
    } else if (entry.kind === "blob" && entry.blobHash) {
      referencedBlobs.add(entry.blobHash);
      const stream = await store.get(entry.blobHash);
      if (!stream) {
        skipped.push({ path: entry.path, reason: `Blob ${entry.blobHash} is missing from the blob store.` });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await pipeline(stream, createWriteStream(target));
      written.push({ path: entry.path, kind: "blob", bytes: entry.size ?? 0 });
    } else {
      skipped.push({ path: entry.path, reason: `Entry of kind ${entry.kind} has no target.` });
    }
  }

  const meta = join(out, EXPORT_META);
  await mkdir(meta, { recursive: true });
  await writeFile(join(meta, "manifest.json"), `${JSON.stringify({ projectId, manifestDocId, entries: sorted }, null, 2)}\n`, "utf8");

  const blobs = await db.selectFrom("blobs").select(["hash"]).where("project_id", "=", projectId).execute();
  let extraBlobs = 0;
  for (const { hash } of blobs) {
    if (referencedBlobs.has(hash)) continue;
    const stream = await store.get(hash);
    if (!stream) {
      skipped.push({ path: `${EXPORT_META}/blobs/${hash}`, reason: "Missing from the blob store." });
      continue;
    }
    await mkdir(join(meta, "blobs"), { recursive: true });
    await pipeline(stream, createWriteStream(join(meta, "blobs", hash)));
    extraBlobs += 1;
  }

  const unlisted = await db
    .selectFrom("documents")
    .select(["id", "kind"])
    .where("project_id", "=", projectId)
    .where("kind", "!=", "manifest")
    .where("deleted_at", "is", null)
    .execute();
  let extraDocs = 0;
  for (const document of unlisted) {
    if (listedDocs.has(document.id)) continue;
    const extension = document.kind === "markdown" ? "md" : document.kind === "latex" ? "tex" : "txt";
    await mkdir(join(meta, "unlisted"), { recursive: true });
    await writeFile(join(meta, "unlisted", `${document.id}.${extension}`), await contentText(db, document.id), "utf8");
    extraDocs += 1;
  }

  const text = [
    `Exported project ${projectId} to ${out}`,
    `  ${written.filter((w) => w.kind === "doc").length} documents, ${written.filter((w) => w.kind === "blob").length} blobs, ` +
      `${written.filter((w) => w.kind === "folder").length} folders`,
    `  ${extraBlobs} unreferenced blobs and ${extraDocs} unlisted documents under ${EXPORT_META}/`,
    ...skipped.map((skip) => `  skipped ${skip.path}: ${skip.reason}`),
  ];
  return { data: { projectId, out, written, skipped, unreferencedBlobs: extraBlobs, unlistedDocuments: extraDocs }, text };
}

// ------------------------------------------------------------------ doc snapshot

/**
 * Writes a snapshot of every sub-document at the current serverSeq, like the
 * compaction job does. Safe while the document is live: a snapshot at S is
 * exactly the log up to S.
 */
export async function docSnapshot(ctx: AdminContext): Promise<CommandResult> {
  const docId = ctx.args.positional(2, "docId");
  const document = await findDocument(ctx.db, docId);
  const written = await consistentRead(ctx.db, async (trx) => {
    const row = await trx.selectFrom("documents").select("last_server_seq").where("id", "=", docId).executeTakeFirstOrThrow();
    const seq = Number(row.last_server_seq);
    const result: Array<{ subdoc: Subdoc; uptoServerSeq: number }> = [];
    for (const subdoc of subdocsForKind(document.kind)) {
      const doc = await loadSubdocState(trx, docId, subdoc, seq);
      try {
        await writeSnapshot(trx, docId, subdoc, seq, doc);
      } finally {
        doc.destroy();
      }
      result.push({ subdoc, uptoServerSeq: seq });
    }
    return result;
  });
  return {
    data: { docId, snapshots: written },
    text: written.map((snapshot) => `Snapshot ${docId}/${snapshot.subdoc} at serverSeq ${snapshot.uptoServerSeq}.`),
  };
}
