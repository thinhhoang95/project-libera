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
import { fileExistence } from "@/lib/storage/library-links";
import { isNotebookMigrating, isPathMigrating } from "@/lib/storage/migration-fence";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { notifySearchReferenceChanges } from "@/lib/storage/search-updates";
import {
  filePathFromParts,
  getAdminRoot,
  getLinkedFolders,
  getLocalLockDir,
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
  // Local, never beside the (synced) file: a remote machine's PID means nothing here.
  const lockPath = path.join(getLocalLockDir(), `reflib-${createHash("sha256").update(target).digest("hex").slice(0, 32)}.lock`);
  await mkdir(path.dirname(lockPath), { recursive: true });
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

/**
 * The lock is local, so another device's write can land through the sync
 * folder while this one is in flight. Just before publishing, the file's
 * revision must still be the one this change was built on.
 */
async function assertRevisionUnchanged(target: string, revision: number) {
  const latest = await readLibraryFile(target).catch(() => null);
  if (latest && latest.revision !== revision) throw new ReferenceRevisionConflict(latest);
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
/**
 * A notebook's library as the app reads it, for checks: never set aside when
 * damaged (readReferenceLibrary does that), only reported. `library` is null
 * when the notebook has none.
 */
export async function inspectReferenceLibrary(notebook: string): Promise<{ library: ReferenceLibrary | null } | { damaged: string }> {
  try { return { library: await readLibraryFile(referenceLibraryPath(notebook)) }; }
  catch (error) {
    if (error instanceof CorruptLibraryError || error instanceof StorageError) return { damaged: error.message };
    throw error;
  }
}

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
    for (let attempt = 0; ; attempt++) {
      const current = await readForWrite(target);
      if (expectedRevision !== null && current.revision !== expectedRevision) throw new ReferenceRevisionConflict(current);
      const { library, changed } = applyLibraryOps(current, prepared, new Date().toISOString());
      if (!changed) { await beforeCommit?.(); return current; }
      const next = { ...library, revision: current.revision + 1 };
      try {
        // Prepare the JSON before the tether writes its file, under the same
        // revision lock. A full disk or failed .bib write commits neither side.
        await writeJsonAtomically(target, next, async () => {
          await assertRevisionUnchanged(target, current.revision);
          await beforeCommit?.();
        });
      } catch (error) {
        // A server-side job applies to the latest library: merge by re-applying onto what arrived.
        if (error instanceof ReferenceRevisionConflict && expectedRevision === null && attempt < 3) continue;
        throw error;
      }
      // The notebook's generated references.bib follows the library when it is turned on.
      scheduleBibMirror(notebook, next);
      // Global Search indexes the entries as their own source.
      notifySearchReferenceChanges([notebook]);
      // A tethered .bib follows (bib-tether.ts), and open windows reload.
      publishReferenceEvent({ type: "library", notebook, revision: next.revision });
      return next;
    }
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

/** Linked folders not connected on this computer: their libraries can't be read or remapped now. */
export function offlineLinkedFolderNames() {
  return getLinkedFolders().filter((folder) => folder.unresolved).map((folder) => folder.name);
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
export async function remapReferenceAttachments(transform: (path: string) => string | null, failures?: { notebook: string; error: unknown }[]): Promise<string[]> {
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
      await writeJsonAtomically(target, { ...library, revision: library.revision + 1 }, () => assertRevisionUnchanged(target, library.revision));
      return true;
    }).catch((error: unknown) => {
      // With `failures`, one library that cannot be written does not stop the others.
      if (!failures) throw error;
      failures.push({ notebook, error });
      return false;
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
 * A file or folder moved from `from` to `to` (library-relative). The
 * attachments are remapped and a tethered .bib inside follows, both finished
 * before this returns (the move's rollback and the check run after it). The
 * tether follows even when the attachments could not; that error is then
 * thrown, so the caller reports the step as unfinished or rolls back.
 */
export async function moveReferenceAttachments(from: string, to: string) {
  if (from === to) return;
  let failure: unknown = null;
  try {
    await remapReferenceAttachments((current) => underPath(current, from) ? to + current.slice(from.length) : current);
  } catch (error) {
    failure = error;
  }
  // Called here, not through a "moved" event: that listener exists only once bib-tether.ts happens to be loaded. Imported lazily because bib-tether.ts imports this module.
  try {
    const { moveTetheredFiles } = await import("@/lib/references/bib-tether");
    await moveTetheredFiles(from, to);
  } catch (error) {
    console.error(`[references] Could not follow the tethered .bib from ${from} to ${to}:`, error);
  }
  if (failure) throw failure;
}

/**
 * A shared file moved: like moveReferenceAttachments, but says what could not follow.
 * `failures`: libraries that could not be updated (retry later); `offline`: libraries in linked
 * folders that are not connected (they keep the old pointer until they are).
 */
export async function moveReferenceAttachmentsChecked(from: string, to: string) {
  if (from === to) return { failures: [] as { notebook: string; error: unknown }[], offline: [] as string[] };
  const result = await moveReferenceAttachmentsBatch(new Map([[from, to]]));
  // Open References panels of the libraries that changed reload.
  for (const notebook of result.changed) {
    try { publishReferenceEvent({ type: "library", notebook, revision: (await readReferenceLibrary(notebook)).revision }); }
    catch { /* The panel catches up when it next loads. */ }
  }
  return { failures: result.failures, offline: result.offline };
}

/**
 * Many files moved at once (notebook migration): one pass over each library
 * instead of one per file. `moves` maps exact library paths. Never fails the
 * caller: libraries that could not be updated are returned, with those that changed.
 */
export async function moveReferenceAttachmentsBatch(moves: ReadonlyMap<string, string>) {
  const failures: { notebook: string; error: unknown }[] = [];
  // A library in an unconnected linked folder keeps its old pointers; Check Notebook's reference check finds them once it is back.
  const offline = moves.size ? offlineLinkedFolderNames() : [];
  if (!moves.size) return { changed: [] as string[], failures, offline };
  // Tethered files follow through moveTetheredFilesBatch (the caller), not one "moved" event per file.
  let changed: string[] = [];
  try {
    changed = await remapReferenceAttachments((current) => moves.get(current) ?? current, failures);
  } catch (error) {
    failures.push({ notebook: "", error });
  }
  for (const failure of failures) console.error(`[references] Could not update attachments in ${failure.notebook || "the libraries"}:`, failure.error);
  return { changed, failures, offline };
}

/** A shared file was deleted: like detachReferenceAttachments, but says what could not follow (see moveReferenceAttachmentsChecked). */
export async function detachReferenceAttachmentsChecked(removed: string) {
  const failures: { notebook: string; error: unknown }[] = [];
  try {
    await remapReferenceAttachments((current) => underPath(current, removed) ? null : current, failures);
  } catch (error) {
    failures.push({ notebook: "", error });
  }
  return { failures, offline: offlineLinkedFolderNames() };
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

type CandidateFile = { path: string; absolutePath: string; size: number; mtimeMs: number };

/**
 * Files in every notebook whose extension is one of `extensions`. `complete`
 * is false when the search missed somewhere (entry cap, unreadable folder,
 * linked folder not connected): a match then can't be called the only one.
 */
async function candidateFiles(extensions: Set<string>) {
  const files: CandidateFile[] = [];
  let complete = !getLinkedFolders().some((folder) => folder.unresolved);
  let remaining = WALK_ENTRY_LIMIT;
  async function walk(directory: string, relative: string) {
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { complete = false; return; }
    for (const entry of entries) {
      if (remaining-- <= 0) { complete = false; return; }
      if (entry.name.startsWith(".") || SKIPPED_ENTRIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(absolutePath, childRelative);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        try { const stats = await stat(absolutePath); files.push({ path: childRelative, absolutePath, size: stats.size, mtimeMs: stats.mtimeMs }); } catch { complete = false; }
      }
    }
  }
  for (const notebook of await libraryNotebookNames()) {
    let root: string;
    try { root = notebookPath(notebook); } catch { complete = false; continue; }
    await walk(root, notebook);
  }
  return { files, complete };
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
  // "Gone" is Check Notebook's own test (an exact name in its folder's listing, a file): a case-only rename reads as moved here as it does there.
  const disk = fileExistence();
  for (const { notebook: name, target } of await existingLibraries(notebook ? [notebook] : undefined)) {
    let library: ReferenceLibrary | null;
    try { library = await readLibraryFile(target); } catch { continue; }
    for (const entry of Object.values(library?.entries ?? {})) {
      for (const attachment of entry.attachments) {
        if (attachment.kind === "url" || !attachment.sha256 || typeof attachment.size !== "number") continue;
        try { absoluteLibraryFile(attachment.path); } catch { continue; }
        if (await disk.isFile(attachment.path) === false && await rootAvailable(attachment.path)) {
          missing.push({ notebook: name, target, entryId: entry.id, path: attachment.path, sha256: attachment.sha256, size: attachment.size });
        }
      }
    }
  }
  return missing;
}

/**
 * Drops attachments that are not known to be moved: a file of a shared notebook
 * the manifest lists (or that cannot be told: the manifest is unavailable) is
 * still being delivered, not moved; and nothing is judged while a migration
 * involves the attachment's notebook or path.
 */
async function settledMissing(missing: MissingAttachment[]) {
  type Manifest = { state: string; files?: Map<string, unknown> };
  const manifests = new Map<string, Promise<Manifest>>();
  const manifestOf = (name: string) => {
    if (!manifests.has(name)) manifests.set(name, import("@/lib/storage/shared-manifest-view").then((view) => view.readManifestView(name) as Promise<Manifest>).catch((): Manifest => ({ state: "unavailable" })));
    return manifests.get(name)!;
  };
  const settled: MissingAttachment[] = [];
  for (const item of missing) {
    if (await isNotebookMigrating(item.notebook) || await isNotebookMigrating(item.path.split("/")[0]) || await isPathMigrating(item.path)) continue;
    if (isSharedNotebookPath(item.path)) {
      const manifest = await manifestOf(item.path.split("/")[0]);
      if (manifest.state !== "ok" || manifest.files!.has(item.path)) continue;
    }
    settled.push(item);
  }
  return settled;
}

/**
 * Re-point attachments whose file is gone to the one file in the library with
 * the same size, extension and SHA-256. Ambiguous or absent matches are left
 * alone. Searches the folders only when an attachment is missing.
 */
export async function reattachMissingReferenceFiles(notebook?: string): Promise<ReattachResult> {
  const missing = await settledMissing(await missingAttachments(notebook));
  if (!missing.length) return { missing: 0, walked: false, reattached: 0 };
  const { files: candidates, complete } = await candidateFiles(new Set(missing.map((item) => path.extname(item.path).toLowerCase())));
  const hashes = new Map<string, Promise<string | null>>();
  const hashOf = (file: CandidateFile) => {
    if (!hashes.has(file.absolutePath)) hashes.set(file.absolutePath, hashFile(file.absolutePath).catch(() => null));
    return hashes.get(file.absolutePath)!;
  };
  type Repoint = { next: string; sha256: string; size: number; absolutePath: string; mtimeMs: number };
  const repoint = new Map<string, Map<string, Map<string, Repoint>>>(); // target → entry → old path → new path and what chose it
  // Without a complete search, "the only match" can't be told: leave every pointer alone.
  for (const item of complete ? missing : []) {
    const extension = path.extname(item.path).toLowerCase();
    const matches: string[] = [];
    let unreadable = false;
    for (const file of candidates) {
      if (file.size !== item.size || path.extname(file.path).toLowerCase() !== extension) continue;
      const hash = await hashOf(file);
      if (hash === null) unreadable = true; // It could be a second copy.
      else if (hash === item.sha256) matches.push(file.path);
    }
    if (matches.length !== 1 || unreadable) continue;
    const chosenFile = candidates.find((file) => file.path === matches[0])!;
    const byEntry = repoint.get(item.target) ?? new Map<string, Map<string, Repoint>>();
    const byPath = byEntry.get(item.entryId) ?? new Map<string, Repoint>();
    byPath.set(item.path, { next: matches[0], sha256: item.sha256, size: item.size, absolutePath: chosenFile.absolutePath, mtimeMs: chosenFile.mtimeMs });
    byEntry.set(item.entryId, byPath);
    repoint.set(item.target, byEntry);
  }

  let reattached = 0;
  for (const [target, byEntry] of repoint) {
    const committed = await withLibraryLock(target, async (): Promise<{ count: number; library: ReferenceLibrary } | null> => {
      let library: ReferenceLibrary | null;
      try { library = await readLibraryFile(target); } catch { return null; }
      if (!library) return null;
      // The scan ran outside this lock: what it saw is rechecked here, under it.
      // Same test as the check's. The old path counts as present unless it is known to be gone, the new one as absent unless known to be a file: when it can't be told, nothing moves.
      const present = new Map<string, boolean>();
      const disk = fileExistence();
      for (const byPath of byEntry.values()) {
        for (const [old, { next }] of byPath) {
          present.set(old, await disk.isFile(old) !== false);
          present.set(next, await disk.isFile(next) === true);
        }
      }
      // The copy the scan chose is the one that is there now: same size and time, or (changed since) the same bytes.
      // Nothing is judged while a migration moves either path.
      const trusted = new Map<string, boolean>();
      for (const byPath of byEntry.values()) {
        for (const [old, chosen] of byPath) {
          let ok = !(await isPathMigrating(old)) && !(await isPathMigrating(chosen.next));
          if (ok) {
            try {
              const stats = await stat(chosen.absolutePath);
              if (stats.size !== chosen.size) ok = false;
              else if (stats.mtimeMs !== chosen.mtimeMs) ok = await hashFile(chosen.absolutePath) === chosen.sha256;
            } catch { ok = false; }
          }
          trusted.set(`${old}\0${chosen.next}`, ok);
        }
      }
      const existsAtCommit = (file: string) => present.get(file) ?? true;
      const now = new Date().toISOString();
      let count = 0;
      for (const [entryId, byPath] of byEntry) {
        const entry = library.entries[entryId];
        if (!entry) continue;
        let entryChanged = false;
        entry.attachments = entry.attachments.map((attachment): ReferenceAttachment => {
          if (attachment.kind === "url") return attachment;
          const chosen = byPath.get(attachment.path);
          if (!chosen) return attachment;
          const { next } = chosen;
          // Changed meanwhile (the original is back, or the record was replaced), or the entry already points at that file.
          if (!trusted.get(`${attachment.path}\0${next}`) || attachment.sha256 !== chosen.sha256 || attachment.size !== chosen.size || existsAtCommit(attachment.path) || !existsAtCommit(next)
            || entry.attachments.some((other) => other.kind !== "url" && other.path === next)) return attachment;
          entryChanged = true;
          count += 1;
          return { ...attachment, path: next };
        });
        if (entryChanged) entry.updatedAt = now;
      }
      if (!count) return null;
      const next = { ...library, revision: library.revision + 1 };
      await writeJsonAtomically(target, next, () => assertRevisionUnchanged(target, library.revision));
      return { count, library: next };
    });
    if (!committed) continue;
    reattached += committed.count;
    // Like any other library change: the generated .bib, Global Search, the tether and open windows follow.
    const owner = missing.find((item) => item.target === target)!.notebook;
    scheduleBibMirror(owner, committed.library);
    notifySearchReferenceChanges([owner]);
    publishReferenceEvent({ type: "library", notebook: owner, revision: committed.library.revision });
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
