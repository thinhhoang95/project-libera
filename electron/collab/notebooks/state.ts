// What the host remembers about a shared notebook folder between runs.
//
// - The marker (.libera-shared.json) says the folder is shared; the Next
//   write guard keys on it.
// - state.json (in the notebook's .libera/collab) records the layout last
//   applied to disk: where each entry was written and the hash, size and
//   mtime of those bytes. It is what lets the host tell its own writes from
//   other programs' and notice renames and edits made while the app was
//   closed. It also keeps open reconciliations.
// - base/<docId> holds the text last written for each document: the common
//   base of a reconciliation.

import { promises as fs } from "node:fs";
import path from "node:path";

import type { Reconciliation } from "../../../src/lib/collab/local-api";
import type { DocKind, ManifestEntryKind, ProjectKind } from "../../../src/lib/collab/protocol/schema";
import { manifestPathError } from "../../../src/lib/collab/protocol/schema";
import { MAX_MARKER_BYTES, parseNotebookMarker } from "../../../src/lib/collab/local-notebook-state";
import { SHARED_MARKER_FILE, SHARE_PENDING_FILE, STATE_DIRECTORY, checkWriteGuard, readIfExists, sha256, writeFileAtomic, type WriteGuard } from "./fs-ops";

export interface SharedMarker {
  projectId: string;
  serverUrl: string;
  accountId: string;
  manifestDocId: string;
  sharedAt: string;
  /** "album": a shared album's folder in the gallery. Missing for notebooks. */
  kind?: ProjectKind;
  /**
   * Live PDFs are on. The manifest decides; this copy is for when the host
   * cannot be asked, so sidecar writes know whether they are safe.
   */
  pdfLive?: boolean;
  /**
   * The installation that keeps this folder in sync. A folder synced to
   * other devices (OneDrive and the like) carries the marker there too; their
   * hosts leave the folder alone. Missing in markers written before this
   * field; the first host to load such a marker claims it.
   */
  writer?: string;
  /**
   * The folder's identity, the same on every device that syncs it: the key
   * of its writer lease on the server. Missing in older markers; the writer
   * adds one.
   */
  folderId?: string;
  /**
   * More than one installation has used this folder (it syncs to other
   * devices or Libera profiles). A signed-out host then never writes it:
   * it cannot hold the lease, and another installation may.
   */
  syncedElsewhere?: boolean;
  /** Access was revoked: the folder is kept, read-only, and no longer synced. */
  revoked?: boolean;
  revokedAt?: string;
}

export interface LayoutRecord {
  /** Disk path relative to the notebook root. */
  path: string;
  kind: ManifestEntryKind;
  docId?: string;
  docKind?: DocKind;
  /** SHA-256 of the bytes last written or adopted (documents: materialized hash; blobs: blob hash). */
  hash?: string;
  size?: number;
  mtimeMs?: number;
  /**
   * Earlier bytes this host wrote or adopted here, newest first. A file that
   * comes back with one of these hashes and that version's mtime is an old
   * copy put back by a sync client, not an edit (see isStaleCopy).
   */
  previous?: Array<{ hash: string; mtimeMs: number }>;
}

const MAX_PREVIOUS = 8;
/** FAT and ExFAT keep mtimes in 2 s steps. */
const MTIME_SLACK_MS = 2000;

/** Sets the bytes now on disk for a record, remembering the version they replace. */
export function setMaterialized(record: LayoutRecord, hash: string, size: number | undefined, mtimeMs: number | undefined): void {
  if (record.hash && record.hash !== hash && record.mtimeMs !== undefined) {
    const earlier = (record.previous ?? []).filter((item) => item.hash !== record.hash);
    record.previous = [{ hash: record.hash, mtimeMs: record.mtimeMs }, ...earlier].slice(0, MAX_PREVIOUS);
  }
  Object.assign(record, { hash, size, mtimeMs });
}

/**
 * Whether bytes on disk are an earlier version this host wrote, put back
 * with its original mtime (a sync client restoring or delivering a stale
 * copy) rather than an edit. A person's edit, even one that restores the
 * same text, gets a new mtime, newer than the current version's.
 */
export function isStaleCopy(record: LayoutRecord, hash: string, mtimeMs: number): boolean {
  if (!record.previous || hash === record.hash) return false;
  if (record.mtimeMs !== undefined && mtimeMs > record.mtimeMs) return false;
  return record.previous.some((item) => item.hash === hash && Math.abs(item.mtimeMs - mtimeMs) <= MTIME_SLACK_MS);
}

/** Older unexplained bytes (including equal/coarse mtimes) need user intent. */
export function isUncertainCopy(record: LayoutRecord, hash: string, mtimeMs: number): boolean {
  return record.hash !== undefined && hash !== record.hash &&
    (record.previous?.some((item) => item.hash === hash) === true || record.mtimeMs !== undefined && mtimeMs <= record.mtimeMs);
}

export interface ProjectState {
  version: 1;
  layout: Record<string, LayoutRecord>;
  reconciliations: Reconciliation[];
  /** Missing bookkeeping cannot authorize automatic adoption of unexplained files. */
  externalAdoptionRequired?: boolean;
  /**
   * The project/folder this bookkeeping belongs to, stamped on every write.
   * Files written before the stamp existed have none and are accepted once.
   */
  identity?: StateIdentity;
}

export interface StateIdentity {
  projectId: string;
  manifestDocId: string;
  folderId?: string;
}

/** Whether bookkeeping stamped for another project/folder is being read as this one's. */
function identityMismatch(stamped: StateIdentity | undefined, expected: StateIdentity | undefined): boolean {
  if (!stamped || !expected) return false;
  if (stamped.projectId !== expected.projectId || stamped.manifestDocId !== expected.manifestDocId) return true;
  return stamped.folderId !== undefined && expected.folderId !== undefined && stamped.folderId !== expected.folderId;
}

function stateDirectory(root: string): string {
  return path.join(root, ...STATE_DIRECTORY);
}

async function writeJson(target: string, value: unknown, guard?: WriteGuard): Promise<void> {
  await writeFileAtomic(target, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), guard);
}

async function readJson<T>(target: string): Promise<T | null> {
  const bytes = await readIfExists(target);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function readMarker(root: string): Promise<SharedMarker | null> {
  const file = path.join(root, SHARED_MARKER_FILE);
  const stats = await fs.lstat(file).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > MAX_MARKER_BYTES) return null;
  return parseNotebookMarker(await readJson<unknown>(file));
}

export async function writeMarker(root: string, marker: SharedMarker, guard?: WriteGuard): Promise<void> {
  await writeJson(path.join(root, SHARED_MARKER_FILE), marker, guard);
}

export async function deleteMarker(root: string): Promise<void> {
  await fs.rm(path.join(root, SHARED_MARKER_FILE), { force: true });
}

export function emptyState(): ProjectState {
  return { version: 1, layout: {}, reconciliations: [] };
}

export async function readState(root: string, guard?: WriteGuard, expected?: StateIdentity): Promise<ProjectState> {
  const file = path.join(stateDirectory(root), "state.json");
  const bytes = await readIfExists(file);
  if (!bytes) return { ...emptyState(), externalAdoptionRequired: true };
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { /* Preserve the unreadable input below. */ }
  if (validState(value) && !identityMismatch(value.identity, expected)) return value;
  // Keep the exact bytes before rebuilding an uncertain baseline. Creating a
  // sibling never recreates a missing root, and never overwrites an earlier copy.
  if (guard) {
    await checkWriteGuard(guard);
    await fs.writeFile(`${file}.invalid-${sha256(bytes).slice(0, 16)}`, bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  return { ...emptyState(), externalAdoptionRequired: true };
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const hashValue = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function validState(value: unknown): value is ProjectState {
  if (!plain(value) || value.version !== 1 || !plain(value.layout) || !Array.isArray(value.reconciliations)) return false;
  if (value.identity !== undefined && !(plain(value.identity) && safeId(value.identity.projectId) && safeId(value.identity.manifestDocId) &&
      (value.identity.folderId === undefined || typeof value.identity.folderId === "string"))) return false;
  const entries = Object.entries(value.layout);
  if (entries.length > 50_000 || value.reconciliations.length > 50_000) return false;
  for (const [fileId, record] of entries) {
    if (!safeId(fileId) || !plain(record) || typeof record.path !== "string" || manifestPathError(record.path) !== null ||
        !["doc", "blob", "folder"].includes(String(record.kind))) return false;
    if (record.kind === "doc" && (!safeId(record.docId) || !["markdown", "latex", "text"].includes(String(record.docKind)))) return false;
    if (record.hash !== undefined && !hashValue(record.hash)) return false;
    for (const key of ["size", "mtimeMs"]) if (record[key] !== undefined && !finite(record[key])) return false;
    if (record.previous !== undefined && (!Array.isArray(record.previous) || record.previous.length > MAX_PREVIOUS ||
        !record.previous.every((item: unknown) => plain(item) && hashValue(item.hash) && finite(item.mtimeMs)))) return false;
  }
  return value.reconciliations.every((item: unknown) => plain(item) && safeId(item.id) && safeId(item.docId) &&
    typeof item.path === "string" && manifestPathError(item.path) === null && finite(item.detectedAt) &&
    [item.shared, item.disk, item.base].every((part) => typeof part === "string"));
}

export async function writeState(root: string, state: ProjectState, guard?: WriteGuard): Promise<void> {
  await writeJson(path.join(stateDirectory(root), "state.json"), state, guard);
}

function baseFile(root: string, docId: string): string {
  // Document ids come from the shared manifest; never let one name a path.
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(docId)) throw new Error("Refusing a base file for a malformed document id.");
  const directory = path.join(stateDirectory(root), "base");
  const target = path.join(directory, `${docId}.txt`);
  const relative = path.relative(directory, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error("Refusing a base file outside the base directory.");
  }
  return target;
}

export async function readBase(root: string, docId: string): Promise<string | null> {
  const bytes = await readIfExists(baseFile(root, docId));
  return bytes ? bytes.toString("utf8") : null;
}

export async function writeBase(root: string, docId: string, text: string, guard?: WriteGuard): Promise<void> {
  await writeFileAtomic(baseFile(root, docId), Buffer.from(text, "utf8"), guard);
}

export async function deleteBase(root: string, docId: string): Promise<void> {
  await fs.rm(baseFile(root, docId), { force: true });
}

/** One file of an interrupted-safe share plan. Ids are chosen once and reused on retry. */
export interface PlannedFile {
  path: string;
  kind: ManifestEntryKind;
  fileId: string;
  docId?: string;
  docKind?: DocKind;
  blobHash?: string;
  size?: number;
  mime?: string;
  /** Immutable document payload saved before its first creation attempt. */
  initialText?: string;
  /** Uploaded (document created or blob stored) on the server. */
  uploaded?: boolean;
}

export interface SharePlan {
  version: 1;
  operationId?: string;
  accountId?: string;
  serverUrl?: string;
  kind?: ProjectKind;
  name: string;
  startedAt: number;
  /** Set as soon as the server created the project. */
  projectId?: string;
  manifestDocId?: string;
  files: PlannedFile[];
}

const SHARE_UPLOADS_FILE = ".libera-share-uploaded.jsonl";

export async function readSharePlan(root: string): Promise<SharePlan | null> {
  const value = await readJson<SharePlan>(path.join(root, SHARE_PENDING_FILE));
  if (!value || value.version !== 1 || !Array.isArray(value.files)) return null;
  const journal = await readIfExists(path.join(root, SHARE_UPLOADS_FILE));
  const byId = new Map(value.files.map((file) => [file.fileId, file]));
  for (const line of journal?.toString("utf8").split("\n") ?? []) {
    try {
      const upload = JSON.parse(line) as { fileId: string; blobHash: string };
      const file = byId.get(upload.fileId);
      if (file?.kind === "blob" && file.blobHash === upload.blobHash) file.uploaded = true;
    } catch { /* An interrupted append must not prevent resuming the other uploads. */ }
  }
  return value;
}

export async function writeSharePlan(root: string, plan: SharePlan, guard?: WriteGuard): Promise<void> {
  await writeJson(path.join(root, SHARE_PENDING_FILE), plan, guard);
}

/** One small checkpoint per album photo, instead of rewriting every planned photo. */
export async function recordShareUpload(root: string, file: PlannedFile, guard?: WriteGuard): Promise<void> {
  await checkWriteGuard(guard);
  // The leading newline separates a prior interrupted record from this one.
  await fs.appendFile(path.join(root, SHARE_UPLOADS_FILE), `\n${JSON.stringify({ fileId: file.fileId, blobHash: file.blobHash })}\n`);
}

export async function deleteSharePlan(root: string, guard?: WriteGuard): Promise<void> {
  await checkWriteGuard(guard);
  await fs.rm(path.join(root, SHARE_UPLOADS_FILE), { force: true });
  await checkWriteGuard(guard);
  await fs.rm(path.join(root, SHARE_PENDING_FILE), { force: true });
}
