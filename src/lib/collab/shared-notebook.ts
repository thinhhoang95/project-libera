// Next-side view of shared notebooks (collaboration map §7.3).
//
// A shared notebook's files are a working copy the collab host writes from
// the CRDT. If Libera's own writers (saving, the agent, OCR, uploads,
// rename/move/delete) wrote them directly, the next materialization would
// overwrite the change or turn it into an unattributed "external" edit. So
// every writer in src/lib/storage (and the agent) calls the guard below and
// refuses with 409 `shared-document`; the callers will route through the
// host's control API instead.
//
// The check is synchronous and cheap: one stat of the marker per call,
// with its contents read only when its identity changes or the cached
// answer is a few seconds old. Folder mtimes can be coarse, so they cannot
// reliably tell us when a takedown removed the marker.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { ARCHIVE_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getAdminRoot, getLinkedFolder } from "@/lib/storage/paths";

/** Marker the collab host writes in a shared notebook's root (electron/collab/notebooks). */
export const SHARED_MARKER_FILE = ".libera-shared.json";
export const SHARED_DOCUMENT_ERROR = "shared-document";

export interface SharedNotebookMarker {
  projectId: string;
  serverUrl: string;
  accountId: string;
  manifestDocId: string;
  sharedAt: string;
  /** Access was revoked: the folder is kept read-only. */
  revoked?: boolean;
}

/** A write to a shared notebook through a path that would bypass the collab host. */
export class SharedDocumentError extends StorageError {
  readonly code = SHARED_DOCUMENT_ERROR;
  readonly path: string;

  constructor(liberaPath: string) {
    // The message doubles as the API error: routes answer { error: message }.
    super(SHARED_DOCUMENT_ERROR, 409);
    this.name = "SharedDocumentError";
    this.path = liberaPath;
  }
}

export function isSharedDocumentError(error: unknown): error is SharedDocumentError {
  return error instanceof SharedDocumentError || (error instanceof StorageError && error.message === SHARED_DOCUMENT_ERROR && error.status === 409);
}

type CacheEntry = { identity: string; checkedAt: number; marker: SharedNotebookMarker | null };

const CACHE_KEY = Symbol.for("libera.sharedNotebooks");
const MAX_AGE_MS = 2000;

function cache(): Map<string, CacheEntry> {
  const holder = globalThis as { [CACHE_KEY]?: Map<string, CacheEntry> };
  holder[CACHE_KEY] ??= new Map();
  return holder[CACHE_KEY];
}

/** Forgets cached answers (after this process changes a marker itself, and in tests). */
export function invalidateSharedNotebookCache(): void {
  cache().clear();
}

function readMarker(root: string): SharedNotebookMarker | null {
  try {
    const value = JSON.parse(readFileSync(path.join(root, SHARED_MARKER_FILE), "utf8")) as SharedNotebookMarker;
    return value && typeof value.projectId === "string" ? value : null;
  } catch {
    return null;
  }
}

/** The marker of a top-level notebook, or null when it is not shared. Linked folders are never shared. */
export function sharedNotebookMarker(notebook: string): SharedNotebookMarker | null {
  if (!notebook || notebook.startsWith(".") || /[\\/\0]/.test(notebook) || notebook === "..") return null;
  if (getLinkedFolder(notebook)) return null;
  const root = path.join(getAdminRoot(), notebook);
  let identity: string;
  try {
    const stats = statSync(path.join(root, SHARED_MARKER_FILE));
    identity = `${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
  } catch {
    cache().delete(root);
    return null;
  }
  const now = Date.now();
  const cached = cache().get(root);
  if (cached && cached.identity === identity && now - cached.checkedAt < MAX_AGE_MS) return cached.marker;
  const marker = readMarker(root);
  cache().set(root, { identity, checkedAt: now, marker });
  return marker;
}

function splitLiberaPath(liberaPath: string): string[] {
  return liberaPath.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== ".");
}

/**
 * Whether a Libera path ("Notebook/sub/file.md", or just "Notebook") is in a
 * shared notebook. The notebook's `_archive` folder is local-only (remote
 * deletes are archived there), so it does not count.
 */
export function isSharedNotebookPath(liberaPath: string): boolean {
  if (typeof liberaPath !== "string") return false;
  const [notebook, first] = splitLiberaPath(liberaPath);
  if (!notebook || first === ARCHIVE_DIR) return false;
  return sharedNotebookMarker(notebook) !== null;
}

/** Throws SharedDocumentError (409 shared-document) for a path in a shared notebook. */
export function assertNotSharedPath(liberaPath: string): void {
  if (isSharedNotebookPath(liberaPath)) throw new SharedDocumentError(liberaPath);
}

/** The guard for storage functions that work with a notebook name and path segments. */
export function assertNotSharedItem(notebook: string, pathParts: readonly string[] = []): void {
  assertNotSharedPath([notebook, ...pathParts].join("/"));
}

/** Splits a Libera path into the shared notebook and the manifest path inside it, for the host's file routes. */
export function sharedManifestPath(liberaPath: string): { notebook: string; projectId: string; path: string } | null {
  const [notebook, ...rest] = splitLiberaPath(liberaPath);
  if (!notebook || rest.length === 0 || rest[0] === ARCHIVE_DIR) return null;
  const marker = sharedNotebookMarker(notebook);
  return marker ? { notebook, projectId: marker.projectId, path: rest.join("/") } : null;
}
