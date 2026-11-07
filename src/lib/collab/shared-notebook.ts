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

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { ARCHIVE_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getAdminRoot, getLinkedFolder } from "@/lib/storage/paths";
import { MAX_MARKER_BYTES, parseNotebookMarker, readNotebookBinding, readNotebookLifecycle, sameNotebookIdentity } from "./local-notebook-state";

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
  /** Live PDFs are on, for when the host cannot be asked. */
  pdfLive?: boolean;
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
// A present unreadable marker is guarded, but cannot supply a routing identity.
const UNREADABLE: SharedNotebookMarker = { projectId: "", serverUrl: "", accountId: "", manifestDocId: "", sharedAt: "" };

function cache(): Map<string, CacheEntry> {
  const holder = globalThis as { [CACHE_KEY]?: Map<string, CacheEntry> };
  holder[CACHE_KEY] ??= new Map();
  return holder[CACHE_KEY];
}

/** Forgets cached answers (after this process changes a marker itself, and in tests). */
export function invalidateSharedNotebookCache(): void {
  cache().clear();
}

function readMarker(root: string): SharedNotebookMarker {
  try {
    const bytes = readFileSync(path.join(root, SHARED_MARKER_FILE));
    if (bytes.length > MAX_MARKER_BYTES) return UNREADABLE;
    return parseNotebookMarker(JSON.parse(bytes.toString("utf8"))) ?? UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

function effectiveMarker(root: string, marker: SharedNotebookMarker | null): SharedNotebookMarker | null {
  const directory = process.env.LIBERA_COLLAB_LIFECYCLE_DIR;
  const binding = readNotebookBinding(directory, root);
  if (binding && readNotebookLifecycle(directory, binding) === null &&
      (!marker?.projectId || !sameNotebookIdentity(binding, marker))) return UNREADABLE;
  if (!marker?.projectId) return marker;
  const outcome = readNotebookLifecycle(directory, marker);
  if (outcome === "local") return null;
  return outcome === "revoked" ? { ...marker, revoked: true } : marker;
}

/** The marker of a top-level notebook, or null when it is not shared. Linked folders are never shared. */
export function sharedNotebookMarker(notebook: string): SharedNotebookMarker | null {
  if (!notebook || notebook.startsWith(".") || /[\\/\0]/.test(notebook) || notebook === "..") return null;
  if (getLinkedFolder(notebook)) return null;
  const root = path.join(getAdminRoot(), notebook);
  let identity: string;
  try {
    const stats = lstatSync(path.join(root, SHARED_MARKER_FILE));
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_MARKER_BYTES) return UNREADABLE;
    identity = `${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
  } catch (error) {
    cache().delete(root);
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? effectiveMarker(root, null) : UNREADABLE;
  }
  const now = Date.now();
  const cached = cache().get(root);
  if (cached && cached.identity === identity && now - cached.checkedAt < MAX_AGE_MS) return effectiveMarker(root, cached.marker);
  const marker = readMarker(root);
  cache().set(root, { identity, checkedAt: now, marker });
  return effectiveMarker(root, marker);
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

/** Whether this notebook's marker says live PDFs are on. */
export function notebookHasLivePdfs(liberaPath: string): boolean {
  const [notebook] = splitLiberaPath(liberaPath);
  return Boolean(notebook && sharedNotebookMarker(notebook)?.pdfLive);
}

/** Throws SharedDocumentError (409 shared-document) for a path in a shared notebook. */
export function assertNotSharedPath(liberaPath: string): void {
  if (isSharedNotebookPath(liberaPath)) throw new SharedDocumentError(liberaPath);
}

/** The guard for storage functions that work with a notebook name and path segments. */
/** Guard an absolute writer target, including an existing symlink's destination. */
export function assertNotSharedAbsolutePath(absolute: string): void {
  const candidates = new Set([path.resolve(absolute)]);
  try { candidates.add(realpathSync(absolute)); } catch { /* A new file uses its real parent. */ }
  try { candidates.add(path.join(realpathSync(path.dirname(absolute)), path.basename(absolute))); } catch { /* The writer will report the missing parent. */ }
  const roots = new Set([path.resolve(getAdminRoot())]);
  try { roots.add(realpathSync(getAdminRoot())); } catch { /* Root may be unavailable. */ }
  for (const candidate of candidates) for (const root of roots) {
    const relative = path.relative(root, candidate);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
      assertNotSharedPath(relative.split(path.sep).join("/"));
    }
  }
}

export function assertNotSharedItem(notebook: string, pathParts: readonly string[] = []): void {
  assertNotSharedPath([notebook, ...pathParts].join("/"));
}

/** Splits a Libera path into the shared notebook and the manifest path inside it, for the host's file routes. */
export function sharedManifestPath(liberaPath: string): { notebook: string; projectId: string; path: string } | null {
  const [notebook, ...rest] = splitLiberaPath(liberaPath);
  if (!notebook || rest.length === 0 || rest[0] === ARCHIVE_DIR) return null;
  const marker = sharedNotebookMarker(notebook);
  return marker?.projectId ? { notebook, projectId: marker.projectId, path: rest.join("/") } : null;
}
