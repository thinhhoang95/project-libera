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
import type { DocKind, ManifestEntryKind } from "../../../src/lib/collab/protocol/schema";
import { SHARED_MARKER_FILE, SHARE_PENDING_FILE, STATE_DIRECTORY, readIfExists, writeFileAtomic } from "./fs-ops";

export interface SharedMarker {
  projectId: string;
  serverUrl: string;
  accountId: string;
  manifestDocId: string;
  sharedAt: string;
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
}

export interface ProjectState {
  version: 1;
  layout: Record<string, LayoutRecord>;
  reconciliations: Reconciliation[];
}

function stateDirectory(root: string): string {
  return path.join(root, ...STATE_DIRECTORY);
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await writeFileAtomic(target, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
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
  const value = await readJson<SharedMarker>(path.join(root, SHARED_MARKER_FILE));
  if (!value || typeof value.projectId !== "string" || typeof value.manifestDocId !== "string") return null;
  return value;
}

export async function writeMarker(root: string, marker: SharedMarker): Promise<void> {
  await writeJson(path.join(root, SHARED_MARKER_FILE), marker);
}

export async function deleteMarker(root: string): Promise<void> {
  await fs.rm(path.join(root, SHARED_MARKER_FILE), { force: true });
}

export function emptyState(): ProjectState {
  return { version: 1, layout: {}, reconciliations: [] };
}

export async function readState(root: string): Promise<ProjectState> {
  const value = await readJson<ProjectState>(path.join(stateDirectory(root), "state.json"));
  if (!value || value.version !== 1 || typeof value.layout !== "object") return emptyState();
  return { version: 1, layout: value.layout ?? {}, reconciliations: Array.isArray(value.reconciliations) ? value.reconciliations : [] };
}

export async function writeState(root: string, state: ProjectState): Promise<void> {
  await writeJson(path.join(stateDirectory(root), "state.json"), state);
}

function baseFile(root: string, docId: string): string {
  return path.join(stateDirectory(root), "base", `${docId}.txt`);
}

export async function readBase(root: string, docId: string): Promise<string | null> {
  const bytes = await readIfExists(baseFile(root, docId));
  return bytes ? bytes.toString("utf8") : null;
}

export async function writeBase(root: string, docId: string, text: string): Promise<void> {
  await writeFileAtomic(baseFile(root, docId), Buffer.from(text, "utf8"));
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
  /** Uploaded (document created or blob stored) on the server. */
  uploaded?: boolean;
}

export interface SharePlan {
  version: 1;
  name: string;
  startedAt: number;
  /** Set as soon as the server created the project. */
  projectId?: string;
  manifestDocId?: string;
  files: PlannedFile[];
}

export async function readSharePlan(root: string): Promise<SharePlan | null> {
  const value = await readJson<SharePlan>(path.join(root, SHARE_PENDING_FILE));
  return value && value.version === 1 && Array.isArray(value.files) ? value : null;
}

export async function writeSharePlan(root: string, plan: SharePlan): Promise<void> {
  await writeJson(path.join(root, SHARE_PENDING_FILE), plan);
}

export async function deleteSharePlan(root: string): Promise<void> {
  await fs.rm(path.join(root, SHARE_PENDING_FILE), { force: true });
}
