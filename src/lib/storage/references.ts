import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { scheduleBibMirror } from "@/lib/references/bib-mirror";
import { publishReferenceEvent } from "@/lib/references/library-events";
import { applyLibraryOps, attachmentIdentity, emptyReferenceLibrary, LibraryOpError } from "@/lib/references/library-ops";
import { REFERENCE_LIBRARY_VERSION, type ReferenceAttachment, type ReferenceLibrary, type ReferenceLibraryOp } from "@/lib/references/types";
import { StorageError } from "@/lib/storage/errors";
import { pathExists, writeJsonAtomically } from "@/lib/storage/fs-utils";
import { notifySearchReferenceChanges } from "@/lib/storage/search-updates";
import {
  filePathFromParts,
  getAdminRoot,
  getLinkedFolders,
  notebookPath,
  referenceLibraryPath,
  splitFilePath,
} from "@/lib/storage/paths";

// Per-notebook reference libraries (docs/references/plan.md §2, §4.1). Each
// library is one JSON file in the notebook's system folder, changed only in a
// locked, revision-checked transaction that is published by atomic rename.

export { applyLibraryOps, emptyReferenceLibrary, LibraryOpError };

/** The library changed since the caller read it. Carries the current library. */
export class ReferenceRevisionConflict extends StorageError {
  library: ReferenceLibrary;

  constructor(library: ReferenceLibrary) {
    super("The reference library changed in another window. Your change was not saved; try again.", 409);
    this.name = "ReferenceRevisionConflict";
    this.library = library;
  }
}

class CorruptLibraryError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseLibrary(text: string): ReferenceLibrary {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new CorruptLibraryError("The library is not valid JSON."); }
  if (!isRecord(value)) throw new CorruptLibraryError("The library is not an object.");
  if (typeof value.version === "number" && value.version > REFERENCE_LIBRARY_VERSION) {
    // Written by a newer Libera. Leave it in place rather than discarding it.
    throw new StorageError("This reference library was saved by a newer version of Libera. Update Libera to open it.", 409);
  }
  if (value.version !== REFERENCE_LIBRARY_VERSION) throw new CorruptLibraryError("The library version is unsupported.");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new CorruptLibraryError("The library revision is invalid.");
  if (typeof value.style !== "string" || !isRecord(value.entries)) throw new CorruptLibraryError("The library is incomplete.");
  if (value.settings !== undefined && !isRecord(value.settings)) throw new CorruptLibraryError("The library settings are invalid.");
  for (const [id, entry] of Object.entries(value.entries)) {
    if (!isRecord(entry) || entry.id !== id || typeof entry.key !== "string" || !Array.isArray(entry.aliases) ||
      !isRecord(entry.csl) || !Array.isArray(entry.attachments)) {
      throw new CorruptLibraryError(`Entry ${id} is malformed.`);
    }
  }
  return value as ReferenceLibrary;
}

/** null when the file does not exist. */
async function readLibraryFile(target: string): Promise<ReferenceLibrary | null> {
  let text: string;
  try { text = await readFile(target, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseLibrary(text);
}

/** Never overwrite a damaged library silently: keep it beside the new one. */
async function quarantineLibrary(target: string, reason: string) {
  const aside = `${target}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await rename(target, aside);
  console.warn(`[references] ${target} could not be read (${reason}). It was moved to ${aside} and an empty library was started.`);
}

async function assertNotebookExists(notebook: string) {
  if (!(await pathExists(notebookPath(notebook)))) throw new StorageError("Notebook was not found.", 404);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

const LOCK_CHAINS = Symbol.for("libera.referenceLibraryLocks");
const lockState = globalThis as { [LOCK_CHAINS]?: Map<string, Promise<unknown>> };
const lockChains = lockState[LOCK_CHAINS] ??= new Map<string, Promise<unknown>>();

/** One writer per library: queued in this process, and an OS lock file across Next workers. */
export { withLibraryLock as withReferenceFileLock };

async function withLibraryLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const previous = lockChains.get(target) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => withFileLock(target, fn));
  lockChains.set(target, task);
  try { return await task; } finally { if (lockChains.get(target) === task) lockChains.delete(target); }
}

async function withFileLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`;
  await mkdir(path.dirname(target), { recursive: true });
  let lock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lock = await open(lockPath, "wx", 0o600); await lock.writeFile(String(process.pid)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Recover a lock left by a dead worker. Never steal from a live owner.
      try {
        const owner = Number(await readFile(lockPath, "utf8"));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") await rm(lockPath, { force: true }); }
        } else if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await rm(lockPath, { force: true });
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      await delay(50);
    }
  }
  if (!lock) throw new StorageError("The reference library is busy. Retry; if the app crashed, restart it.", 409);
  try { return await fn(); } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

/** Read under the lock; a damaged file is moved aside and replaced by an empty library. */
async function readForWrite(target: string) {
  try {
    return (await readLibraryFile(target)) ?? emptyReferenceLibrary();
  } catch (error) {
    if (!(error instanceof CorruptLibraryError)) throw error;
    await quarantineLibrary(target, error.message);
    return emptyReferenceLibrary();
  }
}

/** The notebook's library. A missing library is an empty one at revision 0 and is not written. */
export async function readReferenceLibrary(notebook: string): Promise<ReferenceLibrary> {
  const target = referenceLibraryPath(notebook);
  await assertNotebookExists(notebook);
  // Atomic replacement makes an unlocked read safe.
  try {
    return (await readLibraryFile(target)) ?? emptyReferenceLibrary();
  } catch (error) {
    if (!(error instanceof CorruptLibraryError)) throw error;
    return withLibraryLock(target, () => readForWrite(target));
  }
}

/**
 * Apply ops in one transaction. `expectedRevision` null applies them to the
 * latest revision (server-side jobs); otherwise a different stored revision
 * throws ReferenceRevisionConflict. Invalid ops throw LibraryOpError and
 * nothing is written.
 */
export async function updateReferenceLibrary(notebook: string, expectedRevision: number | null, ops: ReferenceLibraryOp[], beforeCommit?: () => Promise<void>): Promise<ReferenceLibrary> {
  const target = referenceLibraryPath(notebook);
  await assertNotebookExists(notebook);
  if (!Array.isArray(ops)) throw new LibraryOpError("Library changes must be a list.");
  const prepared = await withAttachmentHashes(ops);
  return withLibraryLock(target, async () => {
    const current = await readForWrite(target);
    if (expectedRevision !== null && current.revision !== expectedRevision) throw new ReferenceRevisionConflict(current);
    const { library, changed } = applyLibraryOps(current, prepared, new Date().toISOString());
    if (!changed) { await beforeCommit?.(); return current; }
    const next = { ...library, revision: current.revision + 1 };
    // Prepare the JSON before the tether writes its file, under the same
    // revision lock. A full disk or failed .bib write commits neither side.
    await writeJsonAtomically(target, next, beforeCommit);
    // The notebook's generated references.bib follows the library when it is turned on.
    scheduleBibMirror(notebook, next);
    // Global Search indexes the entries as their own source.
    notifySearchReferenceChanges([notebook]);
    // A tethered .bib follows (bib-tether.ts), and open windows reload.
    publishReferenceEvent({ type: "library", notebook, revision: next.revision });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Attachment hashing
// ---------------------------------------------------------------------------

async function hashFile(absolutePath: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(absolutePath)) hash.update(bytes);
  return hash.digest("hex");
}

/** Absolute path of a library-relative file, through the same checks as every file route. */
function absoluteLibraryFile(relativePath: string) {
  const { notebook, pathParts } = splitFilePath(relativePath);
  return filePathFromParts(notebook, pathParts);
}

async function hashedAttachment(attachment: unknown) {
  if (!isRecord(attachment) || (attachment.kind !== "pdf" && attachment.kind !== "markdown") || typeof attachment.path !== "string") {
    return attachment; // applyLibraryOps reports the shape error.
  }
  if (typeof attachment.sha256 === "string" && typeof attachment.size === "number") return attachment;
  const absolutePath = absoluteLibraryFile(attachment.path);
  let size: number;
  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile()) throw new StorageError(`“${attachment.path}” is not a file.`, 400);
    size = stats.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StorageError(`The attached file “${attachment.path}” was not found.`, 400);
    throw error;
  }
  return { ...attachment, sha256: await hashFile(absolutePath), size };
}

/** Record the hash and size of attached files that arrive without them. */
async function withAttachmentHashes(ops: ReferenceLibraryOp[]) {
  const prepared: ReferenceLibraryOp[] = [];
  for (const op of ops) {
    if (isRecord(op) && op.op === "attach") {
      prepared.push({ ...op, attachment: await hashedAttachment(op.attachment) as ReferenceAttachment });
    } else if (isRecord(op) && op.op === "add" && isRecord(op.entry) && Array.isArray(op.entry.attachments)) {
      const attachments: ReferenceAttachment[] = [];
      for (const attachment of op.entry.attachments) attachments.push(await hashedAttachment(attachment) as ReferenceAttachment);
      prepared.push({ ...op, entry: { ...op.entry, attachments } });
    } else prepared.push(op);
  }
  return prepared;
}

// ---------------------------------------------------------------------------
// Attachments follow file operations
// ---------------------------------------------------------------------------

/** Every notebook and linked folder, the way the tree lists them. */
async function libraryNotebookNames() {
  const linkedFolders = getLinkedFolders();
  const linkedNames = new Set(linkedFolders.map((folder) => folder.name));
  let entries: Dirent[] = [];
  try { entries = await readdir(getAdminRoot(), { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [
    ...entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !linkedNames.has(entry.name)).map((entry) => entry.name),
    ...linkedFolders.filter((folder) => !folder.unresolved).map((folder) => folder.name),
  ];
}

/** The notebooks (and linked folders) that have a References library file. */
export async function referenceLibraryNotebooks() {
  return (await existingLibraries()).map(({ notebook }) => notebook);
}

async function existingLibraries(notebooks?: string[]) {
  const libraries: { notebook: string; target: string }[] = [];
  for (const notebook of notebooks ?? await libraryNotebookNames()) {
    let target: string;
    try { target = referenceLibraryPath(notebook); } catch { continue; }
    if (await pathExists(target)) libraries.push({ notebook, target });
  }
  return libraries;
}

/**
 * Rewrite every pdf/markdown attachment path in every library. `transform`
 * returns the new path, the same path, or null when the file is gone (the
 * pointer is detached and the entry kept). Returns the notebooks whose
 * libraries changed.
 */
export async function remapReferenceAttachments(transform: (path: string) => string | null): Promise<string[]> {
  const changedNotebooks: string[] = [];
  for (const { notebook, target } of await existingLibraries()) {
    const changed = await withLibraryLock(target, async () => {
      let library: ReferenceLibrary | null;
      try { library = await readLibraryFile(target); } catch (error) {
        // A damaged library is quarantined by its next read, not by a file move.
        if (error instanceof CorruptLibraryError) return false;
        throw error;
      }
      if (!library) return false;
      const now = new Date().toISOString();
      let dirty = false;
      for (const entry of Object.values(library.entries)) {
        let entryDirty = false;
        const attachments: ReferenceAttachment[] = [];
        for (const attachment of entry.attachments) {
          if (attachment.kind === "url") { attachments.push(attachment); continue; }
          const next = transform(attachment.path);
          if (next === attachment.path) attachments.push(attachment);
          else {
            entryDirty = true;
            if (next !== null) attachments.push({ ...attachment, path: next });
          }
        }
        if (entryDirty) { entry.attachments = uniqueAttachments(attachments); entry.updatedAt = now; dirty = true; }
      }
      if (!dirty) return false;
      await writeJsonAtomically(target, { ...library, revision: library.revision + 1 });
      return true;
    });
    if (changed) changedNotebooks.push(notebook);
  }
  return changedNotebooks;
}

function uniqueAttachments(attachments: ReferenceAttachment[]) {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const identity = attachmentIdentity(attachment);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function underPath(candidate: string, root: string) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * A file or folder moved from `from` to `to` (library-relative). Never fails
 * the file operation that called it.
 */
export async function moveReferenceAttachments(from: string, to: string) {
  if (from === to) return;
  publishReferenceEvent({ type: "moved", from, to });
  try {
    await remapReferenceAttachments((current) => underPath(current, from) ? to + current.slice(from.length) : current);
  } catch (error) {
    console.error(`[references] Could not update attachments moved from ${from} to ${to}:`, error);
  }
}

/** A file or folder at `removed` was deleted: detach every pointer into it. Never fails the caller. */
export async function detachReferenceAttachments(removed: string) {
  try {
    await remapReferenceAttachments((current) => underPath(current, removed) ? null : current);
  } catch (error) {
    console.error(`[references] Could not detach attachments under ${removed}:`, error);
  }
}

// ---------------------------------------------------------------------------
// Re-attach files moved outside Libera
// ---------------------------------------------------------------------------

const SKIPPED_ENTRIES = new Set(["__MACOSX", "_assets", "node_modules", "__pycache__", "bower_components"]);
const WALK_ENTRY_LIMIT = 100_000;

type CandidateFile = { path: string; absolutePath: string; size: number };

/** Files in every notebook whose extension is one of `extensions`. */
async function candidateFiles(extensions: Set<string>) {
  const files: CandidateFile[] = [];
  let remaining = WALK_ENTRY_LIMIT;
  async function walk(directory: string, relative: string) {
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (remaining-- <= 0) return;
      if (entry.name.startsWith(".") || SKIPPED_ENTRIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(absolutePath, childRelative);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        try { files.push({ path: childRelative, absolutePath, size: (await stat(absolutePath)).size }); } catch { /* Gone meanwhile. */ }
      }
    }
  }
  for (const notebook of await libraryNotebookNames()) {
    let root: string;
    try { root = notebookPath(notebook); } catch { continue; }
    await walk(root, notebook);
  }
  return files;
}

type MissingAttachment = { notebook: string; target: string; entryId: string; path: string; sha256: string; size: number };

export type ReattachResult = {
  /** Attachments with a hash whose file is missing. */
  missing: number;
  /** Whether the library folders were searched. Only when something is missing. */
  walked: boolean;
  /** Attachments re-pointed to a file with the same bytes. */
  reattached: number;
};

async function missingAttachments(notebook?: string) {
  const missing: MissingAttachment[] = [];
  // A linked folder on an unplugged drive is unavailable, not moved.
  const availableRoots = new Map<string, Promise<boolean>>();
  const rootAvailable = (relativePath: string) => {
    const name = relativePath.split("/")[0];
    if (!availableRoots.has(name)) {
      availableRoots.set(name, (async () => { try { return await pathExists(notebookPath(name)); } catch { return false; } })());
    }
    return availableRoots.get(name)!;
  };
  for (const { notebook: name, target } of await existingLibraries(notebook ? [notebook] : undefined)) {
    let library: ReferenceLibrary | null;
    try { library = await readLibraryFile(target); } catch { continue; }
    for (const entry of Object.values(library?.entries ?? {})) {
      for (const attachment of entry.attachments) {
        if (attachment.kind === "url" || !attachment.sha256 || typeof attachment.size !== "number") continue;
        let absolutePath: string;
        try { absolutePath = absoluteLibraryFile(attachment.path); } catch { continue; }
        if (!(await pathExists(absolutePath)) && await rootAvailable(attachment.path)) {
          missing.push({ notebook: name, target, entryId: entry.id, path: attachment.path, sha256: attachment.sha256, size: attachment.size });
        }
      }
    }
  }
  return missing;
}

/**
 * Re-point attachments whose file is gone to the one file in the library with
 * the same size, extension and SHA-256. Ambiguous or absent matches are left
 * alone. Searches the folders only when an attachment is missing.
 */
export async function reattachMissingReferenceFiles(notebook?: string): Promise<ReattachResult> {
  const missing = await missingAttachments(notebook);
  if (!missing.length) return { missing: 0, walked: false, reattached: 0 };
  const candidates = await candidateFiles(new Set(missing.map((item) => path.extname(item.path).toLowerCase())));
  const hashes = new Map<string, Promise<string | null>>();
  const hashOf = (file: CandidateFile) => {
    if (!hashes.has(file.absolutePath)) hashes.set(file.absolutePath, hashFile(file.absolutePath).catch(() => null));
    return hashes.get(file.absolutePath)!;
  };
  const repoint = new Map<string, Map<string, Map<string, string>>>(); // target → entry → old path → new path
  for (const item of missing) {
    const extension = path.extname(item.path).toLowerCase();
    const matches: string[] = [];
    for (const file of candidates) {
      if (file.size !== item.size || path.extname(file.path).toLowerCase() !== extension) continue;
      if (await hashOf(file) === item.sha256) matches.push(file.path);
    }
    if (matches.length !== 1) continue;
    const byEntry = repoint.get(item.target) ?? new Map<string, Map<string, string>>();
    const byPath = byEntry.get(item.entryId) ?? new Map<string, string>();
    byPath.set(item.path, matches[0]);
    byEntry.set(item.entryId, byPath);
    repoint.set(item.target, byEntry);
  }

  let reattached = 0;
  for (const [target, byEntry] of repoint) {
    reattached += await withLibraryLock(target, async () => {
      let library: ReferenceLibrary | null;
      try { library = await readLibraryFile(target); } catch { return 0; }
      if (!library) return 0;
      const now = new Date().toISOString();
      let count = 0;
      for (const [entryId, byPath] of byEntry) {
        const entry = library.entries[entryId];
        if (!entry) continue;
        let entryChanged = false;
        entry.attachments = entry.attachments.map((attachment): ReferenceAttachment => {
          if (attachment.kind === "url") return attachment;
          const next = byPath.get(attachment.path);
          // Changed meanwhile, or the entry already points at that file.
          if (!next || entry.attachments.some((other) => other.kind !== "url" && other.path === next)) return attachment;
          entryChanged = true;
          count += 1;
          return { ...attachment, path: next };
        });
        if (entryChanged) entry.updatedAt = now;
      }
      if (count) await writeJsonAtomically(target, { ...library, revision: library.revision + 1 });
      return count;
    });
  }
  return { missing: missing.length, walked: true, reattached };
}

const REATTACH_STATE = Symbol.for("libera.referenceReattach");
type ReattachState = { running: Promise<ReattachResult | null> | null; lastStartedAt: number };
const reattachHolder = globalThis as { [REATTACH_STATE]?: ReattachState };
const reattachState = reattachHolder[REATTACH_STATE] ??= { running: null, lastStartedAt: 0 };
const REATTACH_INTERVAL_MS = 30_000;

/**
 * Start a background re-attach run without waiting for it. At most one runs at
 * a time, and at most once every 30 seconds unless `force` is set.
 */
export function scheduleReferenceReattach({ force = false }: { force?: boolean } = {}) {
  if (reattachState.running) return reattachState.running;
  if (!force && Date.now() - reattachState.lastStartedAt < REATTACH_INTERVAL_MS) return null;
  reattachState.lastStartedAt = Date.now();
  const run = reattachMissingReferenceFiles().catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[references] Re-attaching moved files failed:", error);
    return null;
  }).finally(() => { if (reattachState.running === run) reattachState.running = null; });
  reattachState.running = run;
  return run;
}

/** The background re-attach run in progress, if any. */
export function pendingReferenceReattach() {
  return reattachState.running;
}

/** Forget the last run, so tests can schedule again within 30 seconds. */
export function resetReferenceReattachSchedule() {
  reattachState.running = null;
  reattachState.lastStartedAt = 0;
}
