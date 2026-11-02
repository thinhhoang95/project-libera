import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { chmod, link, lstat, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { pathExists, writeJsonAtomically } from "@/lib/storage/fs-utils";
import { filePathFromParts, getAdminRoot, getLinkedFolders, notebookPath, notebookSystemDirectoryPath, splitFilePath } from "@/lib/storage/paths";
import { readReferenceLibrary, ReferenceRevisionConflict, updateReferenceLibrary, withReferenceFileLock } from "@/lib/storage/references";
import {
  detectBibDialect,
  planTetherSync,
  tetherSummaryHasChanges,
  type TetherBaseEntry,
  type TetherDeletionChoice,
  type TetherPrefer,
  type TetherSummary,
} from "./bib-tether-merge";
import type { TetherChangeCounts, TetherPreview, TetherState, TetherStatus } from "./bib-tether-types";
import { parseBibtex } from "./bibtex";
import type { LatexDialect } from "./latex-text";
import { publishReferenceEvent, subscribeReferenceEvents } from "./library-events";

// A notebook's library tethered to a .bib file the user chose, kept in step
// both ways like a synced folder (the merge itself is bib-tether-merge.ts).
//
// Nothing polls. The file's folder is watched (fs.watch: FSEvents, inotify,
// ReadDirectoryChangesW); a burst of events settles for BIB_TETHER_SETTLE_MS
// before one sync. Library commits reach the file after BIB_TETHER_DEBOUNCE_MS,
// so a batch import is one write, and the file is written only when its text
// changes. Watching can miss events (some network shares and exFAT drives,
// after sleep), so the panel also checks when the window
// regains focus. It hashes the file once to catch edits with preserved or
// coarse mtimes; unchanged checks do not write state or lock files.
//
// Writes are atomic (a temporary file in the same folder, fsynced, renamed
// over the file through any symlink) and keep the file's permissions. Just
// before the rename the file is read again; if someone else changed it since
// the merge read it, the merge runs again on the new text instead. The
// rename itself cannot be made atomic with that check, so a write landing in
// the few milliseconds between them is the one case that can be lost.
//
// What is kept: `<system>/references/bib-tether.json` holds the target, the
// base of the three-way merge (each shared entry as it was after the last
// sync), the hash of the file as last synced, and the last status.
//
// Failure is never destructive: a missing file (deleted, moved, unplugged
// drive) pauses the tether without touching the library; an unreadable file
// (not UTF-8, too large, invalid keys or blocks that do not parse) pauses
// without changing either side; a refused write is retried a few times with backoff and
// then on the next change. Collaboration needs nothing special: a shared
// notebook's .bib is rewritten on disk by the collaboration host as others
// edit it, and that is one more change to the file.

export const BIB_TETHER_FILE = "bib-tether.json";
/** Library commits within this window become one write of the file. */
export const BIB_TETHER_DEBOUNCE_MS = 1_000;
/** File events within this window (an editor's save is several) become one sync. */
export const BIB_TETHER_SETTLE_MS = 400;
export const BIB_TETHER_MAX_BYTES = 16 * 1024 * 1024;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
const MAX_ATTEMPTS = 4;
const STATE_VERSION = 1;

type TetherTarget =
  /** Notebook-relative ("refs/main.bib"): follows renames of the notebook. */
  | { kind: "notebook"; path: string }
  /** Library-relative ("Other/refs.bib"): a file in another notebook or linked folder. */
  | { kind: "library"; path: string }
  | { kind: "absolute"; path: string };

type TetherConfig = {
  version: typeof STATE_VERSION;
  target: TetherTarget;
  dialect: LatexDialect;
  tetheredAt: string;
  /** Who wins differences on the first sync. */
  prefer: TetherPrefer;
  base: {
    fileHash: string;
    size: number;
    mtimeMs: number;
    libraryRevision: number;
    entries: Record<string, TetherBaseEntry>;
  } | null;
  status: {
    state: TetherState;
    message?: string;
    lastSyncedAt?: string;
    lastChange?: TetherChangeCounts & { at: string };
    pendingDeletion?: { keys: string[]; token: string };
    warnings: string[];
  };
};

export class TetherError extends StorageError {
  constructor(message: string, status = 400, readonly transient = false) {
    super(message, status);
    this.name = "TetherError";
  }
}

export type TetherSyncOptions = {
  deletions?: TetherDeletionChoice;
  deletionToken?: string;
  recreate?: boolean;
  /** Only the library changed: nothing to do while its revision is the one last synced. */
  libraryOnly?: boolean;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function bibTetherStatePath(notebook: string) {
  return path.join(notebookSystemDirectoryPath(notebook), "references", BIB_TETHER_FILE);
}

function inside(relative: string) {
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const posix = (relative: string) => relative.split(path.sep).join("/");

function assertBibPath(candidate: string) {
  if (candidate.includes("\0")) throw new TetherError("The file path is invalid.");
  if (path.extname(candidate).toLowerCase() !== ".bib") throw new TetherError("Only .bib files can be tethered.");
  if (candidate.split(/[\\/]/).some((segment) => segment.toLowerCase().startsWith(LIBERA_SYSTEM_DIR.toLowerCase()))) throw new TetherError("Libera's own folders cannot hold a tethered file.");
}

/**
 * Where a chosen path points: an absolute path from the file dialog, or a
 * library-relative path ("Notebook/refs.bib"). Files inside the library are
 * kept relative so they follow moves made in Libera.
 */
export function tetherTargetFor(notebook: string, input: string): TetherTarget {
  const chosen = input.trim();
  if (!chosen) throw new TetherError("Choose a .bib file.");
  assertBibPath(chosen);
  if (path.isAbsolute(chosen)) {
    const absolute = path.resolve(chosen);
    assertBibPath(absolute);
    try {
      const relative = path.relative(notebookPath(notebook), absolute);
      if (inside(relative)) return { kind: "notebook", path: posix(relative) };
    } catch { /* An unavailable linked folder: not inside it. */ }
    for (const folder of getLinkedFolders()) {
      if (folder.unresolved) continue;
      const relative = path.relative(folder.path, absolute);
      if (inside(relative)) return { kind: "library", path: `${folder.name}/${posix(relative)}` };
    }
    const relative = path.relative(getAdminRoot(), absolute);
    if (inside(relative) && relative.includes(path.sep) && !relative.startsWith(".")) return { kind: "library", path: posix(relative) };
    return { kind: "absolute", path: absolute };
  }
  const { notebook: owner, pathParts } = splitFilePath(chosen.replace(/\\/g, "/"));
  if (owner.startsWith(".")) throw new StorageError("Path segment is reserved.");
  filePathFromParts(owner, pathParts); // The same checks as every file route.
  return owner === notebook ? { kind: "notebook", path: pathParts.join("/") } : { kind: "library", path: [owner, ...pathParts].join("/") };
}

function displayPath(notebook: string, target: TetherTarget) {
  return target.kind === "notebook" ? `${notebook}/${target.path}` : target.path;
}

/** The file on disk. Throws TetherError when its notebook or linked folder is not available. */
function resolveTarget(notebook: string, target: TetherTarget) {
  try {
    if (target.kind === "notebook") return filePathFromParts(notebook, target.path.split("/"));
    if (target.kind === "library") {
      const { notebook: owner, pathParts } = splitFilePath(target.path);
      return filePathFromParts(owner, pathParts);
    }
    return target.path;
  } catch (error) {
    if (error instanceof StorageError) throw new TetherError(`${displayPath(notebook, target)} is not available: ${error.message}`, 404, true);
    throw error;
  }
}

async function realBibPath(absolute: string): Promise<string> {
  assertBibPath(absolute);
  let resolved: string;
  try { resolved = await realpath(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if ((await lstat(absolute).catch(() => null))?.isSymbolicLink()) throw new TetherError("The .bib file's symbolic link is broken; reconnect it before syncing.", 404);
    // Resolve existing ancestors too, including for a new file in a symlinked folder.
    const parent = path.dirname(absolute);
    resolved = parent === absolute ? absolute : path.join(await realDirectory(parent), path.basename(absolute));
  }
  assertBibPath(resolved);
  return resolved;
}

async function realDirectory(directory: string): Promise<string> {
  try { return await realpath(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await realDirectory(parent), path.basename(directory));
  }
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

type FileSnapshot = { text: string; hash: string; size: number; mtimeMs: number; mode: number };

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fileErrorMessage(error: unknown, name: string) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return `Libera is not allowed to open ${name}.`;
  if (code === "EBUSY") return `${name} is in use by another program.`;
  if (code === "ENOSPC") return `The disk holding ${name} is full.`;
  if (code === "EROFS") return `${name} is on a read-only disk.`;
  return `${name} could not be opened (${code ?? (error instanceof Error ? error.message : "unknown error")}).`;
}

/** The file, or null when it does not exist. A file still being written is read again once it settles. */
async function readTetherFile(absolute: string): Promise<FileSnapshot | null> {
  await realBibPath(absolute);
  const name = path.basename(absolute);
  for (let attempt = 0; ; attempt += 1) {
    let before;
    try { before = await stat(absolute); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw new TetherError(fileErrorMessage(error, name), 500, true);
    }
    if (!before.isFile()) throw new TetherError(`${name} is not a file.`);
    if (before.size > BIB_TETHER_MAX_BYTES) throw new TetherError(`${name} is larger than ${BIB_TETHER_MAX_BYTES / 1024 / 1024} MB, which is more than Libera syncs.`, 413);
    let bytes: Buffer;
    try {
      const handle = await open(absolute, "r");
      try {
        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new TetherError(fileErrorMessage(error, name), 500, true);
    }
    const after = await stat(absolute).catch(() => null);
    const settled = after && after.dev === before.dev && after.ino === before.ino && after.ctimeMs === before.ctimeMs && after.size === before.size && after.mtimeMs === before.mtimeMs && bytes.length === before.size;
    if (!settled && attempt < 3) { await delay(150 * (attempt + 1)); continue; }
    if (!settled) throw new TetherError(`${name} keeps changing; Libera will sync it once it settles.`, 409, true);
    let text: string;
    try { text = decoder.decode(bytes); } catch {
      throw new TetherError(`${name} is not UTF-8 text. Save it as UTF-8 to sync it; Libera leaves it unchanged until then.`, 415);
    }
    if (text.includes("\u0000")) throw new TetherError(`${name} is not a text file.`, 415);
    return { text, hash: sha256(bytes), size: bytes.length, mtimeMs: (after ?? before).mtimeMs, mode: before.mode };
  }
}

async function currentHash(absolute: string) {
  return (await readTetherFile(absolute))?.hash ?? null;
}

/** Replace the file atomically, through a symlink, keeping its permissions. */
async function writeTetherFile(absolute: string, text: string, mode: number | null, expectedHash: string | null) {
  const target = await realBibPath(absolute);
  if (Buffer.byteLength(text, "utf8") > BIB_TETHER_MAX_BYTES) throw new TetherError("The merged .bib file exceeds the 16 MB sync limit.", 413);
  // ".libera…" names are ignored by the collaboration host's folder scan.
  const temporary = path.join(path.dirname(target), `.libera-${path.basename(target)}.${randomUUID()}.tmp`);
  const permissions = mode === null ? 0o644 : mode & 0o777;
  try {
    const handle = await open(temporary, "wx", permissions);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== null && process.platform !== "win32") await chmod(temporary, permissions);
    for (let attempt = 0; ; attempt += 1) {
      // Check after fsync, and again after every Windows sharing-violation delay.
      if (await realBibPath(absolute) !== target || await currentHash(absolute) !== expectedHash) {
        throw new TetherError(`${path.basename(absolute)} changed before it could be saved.`, 409, true);
      }
      try {
        if (expectedHash === null) {
          try { await link(temporary, target); } catch (error) {
            if (!["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            // FAT/exFAT cannot hard-link. Exclusive creation still protects a
            // file that appeared meanwhile, though the new file is visible during writing.
            const created = await open(target, "wx", permissions);
            try { await created.writeFile(text, "utf8"); await created.sync(); } finally { await created.close(); }
          }
        }
        else await rename(temporary, target);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TetherError(`${path.basename(absolute)} appeared before it could be created.`, 409, true);
        const code = (error as NodeJS.ErrnoException).code;
        // Windows refuses to replace a file another program holds open; that program usually lets go quickly.
        if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 4) { await delay(100 * (attempt + 1)); continue; }
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof TetherError) throw error;
    throw new TetherError(fileErrorMessage(error, path.basename(absolute)), 500, true);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return stat(target);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readConfig(notebook: string): Promise<TetherConfig | null> {
  let text: string;
  try { text = await readFile(bibTetherStatePath(notebook), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(text) as TetherConfig;
    if (!isRecord(value) || value.version !== STATE_VERSION || !isRecord(value.target) ||
      !["notebook", "library", "absolute"].includes(value.target.kind) || typeof value.target.path !== "string" ||
      (value.target.kind === "absolute" && !path.isAbsolute(value.target.path)) ||
      !["bibtex", "biblatex"].includes(value.dialect) || !["library", "file"].includes(value.prefer) ||
      typeof value.tetheredAt !== "string" || !isRecord(value.status) ||
      !["synced", "paused", "missing", "error"].includes(value.status.state) ||
      !Array.isArray(value.status.warnings) || value.status.warnings.some((warning) => typeof warning !== "string")) throw new Error("invalid");
    assertBibPath(value.target.path);
    if (value.target.kind !== "absolute") {
      splitFilePath(value.target.kind === "notebook" ? `${notebook}/${value.target.path}` : value.target.path);
    }
    if (value.base !== null) {
      if (!isRecord(value.base) || typeof value.base.fileHash !== "string" || !/^[a-f0-9]{64}$/.test(value.base.fileHash) ||
        !Number.isSafeInteger(value.base.libraryRevision) || value.base.libraryRevision < 0 ||
        !Number.isFinite(value.base.size) || !Number.isFinite(value.base.mtimeMs) || !isRecord(value.base.entries)) throw new Error("invalid");
      for (const entry of Object.values(value.base.entries)) {
        if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.lib !== "string" ||
          [entry.file, entry.raw, entry.restore].some((field) => field !== undefined && typeof field !== "string") ||
          (entry.held !== undefined && typeof entry.held !== "boolean") ||
          (entry.libraryHash !== undefined && (typeof entry.libraryHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.libraryHash))) ||
          (entry.fileFields !== undefined && (!isRecord(entry.fileFields) || Object.values(entry.fileFields).some((field) => typeof field !== "string")))) throw new Error("invalid");
      }
    }
    if (value.status.pendingDeletion !== undefined) {
      const pending = value.status.pendingDeletion;
      if (!isRecord(pending) || !Array.isArray(pending.keys) || pending.keys.some((key) => typeof key !== "string") || !value.base) throw new Error("invalid");
      pending.token ??= value.base.fileHash; // State written before guarded deletion approval.
      if (typeof pending.token !== "string" || !/^[a-f0-9]{64}$/.test(pending.token)) throw new Error("invalid");
    }
    return value;
  } catch (error) {
    // A read must not race a writer by moving its state file aside, or silently
    // turn a newer/damaged sync history into deletions. Explicit retethering repairs it.
    if (error instanceof TetherError && error.status === 404) throw error;
    throw new TetherError("The .bib tether state is damaged or from a newer Libera. Choose the file again to rebuild its sync history; both sides were left unchanged.", 409);
  }
}

async function saveConfig(notebook: string, config: TetherConfig) {
  await writeJsonAtomically(bibTetherStatePath(notebook), config);
}

function hasBaseSnapshots(config: TetherConfig) {
  return config.base && Object.values(config.base.entries).every((entry) => entry.held ||
    entry.fileFields && entry.raw !== undefined && entry.restore !== undefined && entry.libraryHash !== undefined);
}

// ---------------------------------------------------------------------------
// Runtime: watchers, timers, one sync at a time per notebook
// ---------------------------------------------------------------------------

type Runtime = {
  started: boolean;
  watchComplete: boolean;
  watchers: Map<string, { watcher: FSWatcher; names: string[]; ino: number }>;
  settleTimer: ReturnType<typeof setTimeout> | null;
  libraryTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryIndex: number;
  chain: Promise<unknown>;
  queued: { options: TetherSyncOptions; promise: Promise<TetherStatus | null> } | null;
};

type Registry = { runtimes: Map<string, Runtime>; tethered: Map<string, boolean>; unsubscribe: (() => void) | null };

const REGISTRY_KEY = Symbol.for("libera.referenceBibTether");
const registryHolder = globalThis as { [REGISTRY_KEY]?: Registry };
const registry = registryHolder[REGISTRY_KEY] ??= { runtimes: new Map(), tethered: new Map(), unsubscribe: null };

function runtimeFor(notebook: string) {
  let runtime = registry.runtimes.get(notebook);
  if (!runtime) {
    runtime = {
      started: false, watchComplete: false, watchers: new Map(), settleTimer: null, libraryTimer: null, retryTimer: null,
      retryIndex: 0, chain: Promise.resolve(), queued: null,
    };
    registry.runtimes.set(notebook, runtime);
  }
  return runtime;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null) {
  if (timer) clearTimeout(timer);
}

function stopWatching(runtime: Runtime) {
  for (const { watcher } of runtime.watchers.values()) watcher.close();
  runtime.watchers.clear();
  runtime.watchComplete = false;
  clearTimer(runtime.settleTimer);
  runtime.settleTimer = null;
}

function sameName(left: string, right: string) {
  // Linux can also mount case-insensitive FAT or network volumes. An extra
  // event for a case-distinct sibling is harmless; missing a save is not.
  return left.toLowerCase() === right.toLowerCase();
}

/** Watch both a symlink's name and its destination; climb to an existing ancestor when a folder is gone. */
async function watchFile(notebook: string, absolute: string) {
  const runtime = runtimeFor(notebook);
  let real = absolute;
  try { real = await realpath(absolute); } catch { /* Watch where it will return. */ }
  const desired = new Map<string, { names: string[]; ino: number }>();
  for (const candidate of new Set([absolute, real])) {
    let directory = path.dirname(candidate);
    let name = path.basename(candidate);
    for (;;) {
      try {
        const stats = await stat(directory);
        desired.set(directory, { names: [...new Set([...desired.get(directory)?.names ?? [], name])].sort(), ino: stats.ino });
        break;
      } catch {
        const parent = path.dirname(directory);
        if (parent === directory) break;
        name = path.basename(directory);
        directory = parent;
      }
    }
  }
  for (const [directory, current] of runtime.watchers) {
    const next = desired.get(directory);
    if (next && next.names.join("\0") === current.names.join("\0") && next.ino === current.ino) continue;
    current.watcher.close();
    runtime.watchers.delete(directory);
  }
  for (const [directory, { names, ino }] of desired) {
    if (runtime.watchers.has(directory)) continue;
    try {
      const watcher = watch(directory, { persistent: false }, (_event, filename) => {
        // A directory's own deletion may be reported under its basename.
        if (filename && !names.some((name) => sameName(String(filename), name)) && !sameName(String(filename), path.basename(directory))) return;
        clearTimer(runtime.settleTimer);
        runtime.settleTimer = setTimeout(() => {
          runtime.settleTimer = null;
          void checkTether(notebook).catch(() => undefined);
        }, BIB_TETHER_SETTLE_MS);
        runtime.settleTimer.unref?.();
      });
      watcher.on("error", (error) => {
        console.warn(`[references] Watching the tethered .bib of ${notebook} stopped; it is checked when Libera regains focus.`, error);
        watcher.close();
        runtime.watchComplete = false;
        if (runtime.watchers.get(directory)?.watcher === watcher) runtime.watchers.delete(directory);
        void publishStatus(notebook);
      });
      runtime.watchers.set(directory, { watcher, names, ino });
    } catch (error) {
      console.warn(`[references] The tethered .bib of ${notebook} cannot be watched; it is checked when Libera regains focus.`, error);
    }
  }
  runtime.watchComplete = desired.size > 0 && runtime.watchers.size === desired.size;
  return runtime.watchComplete;
}

function scheduleRetry(notebook: string) {
  const runtime = runtimeFor(notebook);
  if (runtime.retryTimer || runtime.retryIndex >= RETRY_DELAYS_MS.length) return;
  runtime.retryTimer = setTimeout(() => {
    runtime.retryTimer = null;
    runtime.retryIndex += 1;
    void requestTetherSync(notebook).catch(() => undefined);
  }, RETRY_DELAYS_MS[runtime.retryIndex]);
  runtime.retryTimer.unref?.();
}

function resetRetry(runtime: Runtime) {
  clearTimer(runtime.retryTimer);
  runtime.retryTimer = null;
  runtime.retryIndex = 0;
}

/** Library commits: write them to the file after the debounce. */
function onLibraryEvent(notebook: string) {
  void (async () => {
    if (!(await isTethered(notebook))) return;
    const current = runtimeFor(notebook);
    clearTimer(current.libraryTimer);
    current.libraryTimer = setTimeout(() => {
      current.libraryTimer = null;
      void requestTetherSync(notebook, { libraryOnly: true }).catch(() => undefined);
    }, BIB_TETHER_DEBOUNCE_MS);
    current.libraryTimer.unref?.();
  })().catch(() => undefined);
}

registry.unsubscribe?.();
registry.unsubscribe = subscribeReferenceEvents((event) => {
  if (event.type === "library") onLibraryEvent(event.notebook);
  else if (event.type === "moved") void moveTetheredFiles(event.from, event.to);
});

async function isTethered(notebook: string) {
  const known = registry.tethered.get(notebook);
  if (known !== undefined) return known;
  let tethered = false;
  try { tethered = await pathExists(bibTetherStatePath(notebook)); } catch { tethered = false; }
  registry.tethered.set(notebook, tethered);
  return tethered;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function toCounts(summary: TetherSummary): TetherChangeCounts {
  return {
    toLibrary: { added: summary.library.added.length, updated: summary.library.updated.length + summary.library.renamed.length, deleted: summary.library.deleted.length },
    toFile: { added: summary.file.added.length, updated: summary.file.updated.length + summary.file.renamed.length, deleted: summary.file.deleted.length },
    conflicts: summary.conflicts.slice(0, 50),
    kept: summary.kept.slice(0, 50),
  };
}

function statusOf(notebook: string, config: TetherConfig): TetherStatus {
  const runtime = registry.runtimes.get(notebook);
  const shown = displayPath(notebook, config.target);
  return {
    displayPath: shown,
    fileName: shown.split(/[\\/]/).pop() ?? shown,
    insideLibrary: config.target.kind !== "absolute",
    dialect: config.dialect,
    state: config.status.state,
    ...(config.status.message ? { message: config.status.message } : {}),
    tetheredAt: config.tetheredAt,
    ...(config.status.lastSyncedAt ? { lastSyncedAt: config.status.lastSyncedAt } : {}),
    ...(config.status.lastChange ? { lastChange: config.status.lastChange } : {}),
    ...(config.status.pendingDeletion ? { pendingDeletion: { count: config.status.pendingDeletion.keys.length, keys: config.status.pendingDeletion.keys.slice(0, 50), token: config.status.pendingDeletion.token } } : {}),
    warnings: config.status.warnings,
    watching: Boolean(runtime?.watchComplete),
    entries: Object.keys(config.base?.entries ?? {}).length,
    ...(config.base ? { libraryRevision: config.base.libraryRevision } : {}),
  };
}

async function publishStatus(notebook: string) {
  try {
    const config = await readConfig(notebook);
    publishReferenceEvent({ type: "tether", notebook, status: config ? statusOf(notebook, config) : null });
  } catch { /* The next sync publishes again. */ }
}

/** The notebook's tether, or null when it has none. Starts watching it (and a catch-up sync) on first use in this process. */
export async function getTetherStatus(notebook: string): Promise<TetherStatus | null> {
  const config = await readConfig(notebook);
  registry.tethered.set(notebook, Boolean(config));
  if (!config) return null;
  ensureTetherStarted(notebook);
  return statusOf(notebook, config);
}

/**
 * Start watching the notebook's tethered file, if it has one, and catch up
 * with changes made while Libera was closed. Cheap after the first call;
 * never throws, never waits.
 */
export function ensureTetherStarted(notebook: string) {
  const runtime = runtimeFor(notebook);
  if (runtime.started) return;
  runtime.started = true;
  void (async () => {
    if (!(await isTethered(notebook))) { runtime.started = false; registry.runtimes.delete(notebook); return; }
    await requestTetherSync(notebook);
  })().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Syncing
// ---------------------------------------------------------------------------

/**
 * Sync the notebook's tether now (after a sync in progress). Requests made
 * while one waits join it. Resolves with the status, or null when the
 * notebook has no tether.
 */
export function requestTetherSync(notebook: string, options: TetherSyncOptions = {}): Promise<TetherStatus | null> {
  const runtime = runtimeFor(notebook);
  if (runtime.queued) {
    if (options.deletions) runtime.queued.options.deletions = options.deletions;
    if (options.deletionToken) runtime.queued.options.deletionToken = options.deletionToken;
    if (options.recreate) runtime.queued.options.recreate = true;
    if (!options.libraryOnly) delete runtime.queued.options.libraryOnly;
    return runtime.queued.promise;
  }
  const queued = { options: { ...options }, promise: null as unknown as Promise<TetherStatus | null> };
  queued.promise = runtime.chain.catch(() => undefined).then(async () => {
    if (runtime.queued === queued) runtime.queued = null;
    if (!(await pathExists(notebookPath(notebook)))) { stopWatching(runtime); return null; }
    // Untethered panels and our own library-commit echo need no lock-file writes.
    if (!(await pathExists(bibTetherStatePath(notebook)))) return noTether(notebook);
    if (queued.options.libraryOnly) {
      const config = await readConfig(notebook);
      if (config?.base && hasBaseSnapshots(config) && config.status.state === "synced" && (await readReferenceLibrary(notebook)).revision === config.base.libraryRevision) return statusOf(notebook, config);
    }
    return withReferenceFileLock(bibTetherStatePath(notebook), () => syncOnce(notebook, queued.options));
  });
  runtime.queued = queued;
  runtime.chain = queued.promise;
  return queued.promise;
}

function setState(config: TetherConfig, state: TetherState, message?: string) {
  config.status.state = state;
  if (message) config.status.message = message;
  else delete config.status.message;
}

async function saveIfChanged(notebook: string, config: TetherConfig, before: string) {
  if (JSON.stringify(config) !== before) await saveConfig(notebook, config);
}

function noTether(notebook: string) {
  const wasTethered = registry.tethered.get(notebook);
  registry.tethered.set(notebook, false);
  stopWatching(runtimeFor(notebook));
  if (wasTethered) publishReferenceEvent({ type: "tether", notebook, status: null });
  return null;
}

async function syncOnce(notebook: string, options: TetherSyncOptions): Promise<TetherStatus | null> {
  const config = await readConfig(notebook);
  if (!config) return noTether(notebook);
  registry.tethered.set(notebook, true);
  const runtime = runtimeFor(notebook);
  runtime.started = true;
  const saved = JSON.stringify(config);
  const shownBefore = JSON.stringify(statusOf(notebook, config));
  const name = displayPath(notebook, config.target);
  let changed = false;
  try {
    const absolute = resolveTarget(notebook, config.target);
    await watchFile(notebook, absolute);
    const identity = await realBibPath(absolute);
    const targetLock = path.join(getAdminRoot(), LIBERA_SYSTEM_DIR, "bib-tether-locks", sha256(identity.toLowerCase()));
    changed = await withReferenceFileLock(targetLock, () => mergeOnce(notebook, config, absolute, options));
    resetRetry(runtime);
  } catch (error) {
    const transient = error instanceof TetherError ? error.transient : error instanceof ReferenceRevisionConflict || !(error instanceof StorageError);
    const message = error instanceof StorageError ? error.message : `${name} could not be synced.`;
    if (!(error instanceof StorageError)) console.error(`[references] Syncing ${name} failed:`, error);
    setState(config, (error as StorageError).status === 404 ? "missing" : "error", message);
    // A refused write or an unavailable disk may clear up by itself; a malformed file waits for its next change.
    if (transient) scheduleRetry(notebook);
  }
  await saveIfChanged(notebook, config, saved);
  const status = statusOf(notebook, config);
  // Also when only `watching` changed (the first sync in this process starts the watcher).
  if (changed || JSON.stringify(status) !== shownBefore) publishReferenceEvent({ type: "tether", notebook, status });
  return status;
}

/** One merge of the file and the library. Returns whether either side changed. */
async function mergeOnce(notebook: string, config: TetherConfig, absolute: string, options: TetherSyncOptions) {
  const name = path.basename(absolute);
  if (options.libraryOnly && config.base && config.status.state === "synced") {
    // A library event: the file's own changes come through the watcher.
    const library = await readReferenceLibrary(notebook);
    if (config.base && library.revision < config.base.libraryRevision) {
      throw new TetherError("The library was replaced by an older or empty copy. Choose the .bib file again to merge both sides without applying old deletions.", 409);
    }
    if (library.revision === config.base.libraryRevision) return false;
  }
  for (let attempt = 1; ; attempt += 1) {
    let file = await readTetherFile(absolute);
    if (options.recreate && file) throw new TetherError(`${name} exists again. Sync and review it before recreating it.`, 409);
    if (!file) {
      if (config.base && !options.recreate) {
        const folder = await pathExists(path.dirname(absolute));
        setState(config, "missing", folder
          ? `${name} was deleted or moved. The library is unchanged; choose the file again, or recreate it from the library.`
          : `The folder of ${name} is not available (a disconnected drive or share?). Syncing resumes when it is back.`);
        return false;
      }
      // Tethering to a new file: start from an empty one.
      file = { text: "", hash: sha256(""), size: 0, mtimeMs: Date.now(), mode: -1 };
    }
    if (options.deletions && !options.recreate && (options.deletionToken !== config.status.pendingDeletion?.token || file.hash !== options.deletionToken)) {
      throw new TetherError("The file changed since these removals were shown. Sync and review the removals again.", 409);
    }
    const library = await readReferenceLibrary(notebook);
    if (config.base && library.revision < config.base.libraryRevision) {
      throw new TetherError("The library was replaced by an older or empty copy. Choose the .bib file again to merge both sides without applying old deletions.", 409);
    }
    if (config.base && hasBaseSnapshots(config) && !options.deletions && file.hash === config.base.fileHash && library.revision === config.base.libraryRevision) {
      if (config.status.state !== "paused") setState(config, "synced");
      return false;
    }

    const now = new Date().toISOString();
    const plan = planTetherSync({
      library,
      fileText: file.text,
      base: config.base?.entries ?? null,
      dialect: config.dialect,
      now,
      fileModifiedAt: new Date(file.mtimeMs).toISOString(),
      prefer: config.prefer,
      deletions: options.deletions,
    });
    if (plan.blocked) {
      config.status.warnings = plan.warnings;
      setState(config, "error", "The .bib file has invalid keys or parse errors. Fix them to resume syncing; neither side was changed.");
      return false;
    }

    let revision = library.revision;
    let written = file;
    const mustCreate = file.mode === -1;
    try {
      revision = (await updateReferenceLibrary(notebook, library.revision, plan.ops, async () => {
        if (plan.fileText !== null || mustCreate) {
          const text = plan.fileText ?? "";
          const stats = await writeTetherFile(absolute, text, mustCreate ? null : file.mode, mustCreate ? null : file.hash);
          written = { text, hash: sha256(text), size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode };
        } else if (await currentHash(absolute) !== file.hash) {
          throw new TetherError(`${name} changed while it was being synced.`, 409, true);
        }
      })).revision;
    } catch (error) {
      if (attempt < MAX_ATTEMPTS && (error instanceof ReferenceRevisionConflict || error instanceof TetherError && error.status === 409 && error.transient)) continue;
      throw error;
    }
    if (written !== file) await watchFile(notebook, absolute);

    config.base = { fileHash: written.hash, size: written.size, mtimeMs: written.mtimeMs, libraryRevision: revision, entries: plan.base };
    config.status.warnings = plan.warnings;
    const changed = tetherSummaryHasChanges(plan.summary) || plan.summary.conflicts.length > 0;
    if (changed) config.status.lastChange = { ...toCounts(plan.summary), at: now };
    if (changed || !config.status.lastSyncedAt) config.status.lastSyncedAt = now;
    if (plan.pendingDeletion) {
      config.status.pendingDeletion = { keys: plan.pendingDeletion.keys, token: written.hash };
      setState(config, "paused", `${plan.pendingDeletion.keys.length} references were removed from ${name}. Remove them from Libera too, or put them back in the file?`);
    } else {
      delete config.status.pendingDeletion;
      setState(config, "synced");
    }
    return changed;
  }
}

// ---------------------------------------------------------------------------
// Tethering
// ---------------------------------------------------------------------------

/** What tethering `input` would do, without changing anything. */
export async function previewTether(notebook: string, input: string): Promise<TetherPreview> {
  const target = tetherTargetFor(notebook, input);
  const absolute = resolveTarget(notebook, target);
  const file = await readTetherFile(absolute);
  if (!file && !(await pathExists(path.dirname(absolute)))) throw new TetherError("The folder for that file does not exist.", 404);
  const text = file?.text ?? "";
  const dialect = detectBibDialect(text);
  const library = await readReferenceLibrary(notebook);
  const plan = planTetherSync({ library, fileText: text, base: null, dialect, now: new Date().toISOString(), fileModifiedAt: new Date().toISOString(), prefer: "library" });
  const shown = displayPath(notebook, target);
  return {
    displayPath: shown,
    fileName: shown.split(/[\\/]/).pop() ?? shown,
    exists: Boolean(file),
    dialect,
    fileEntries: parseBibtex(text).entries.filter((entry) => entry.input.key).length,
    libraryEntries: Object.keys(library.entries).length,
    toLibrary: plan.summary.library.added.length,
    toFile: plan.summary.file.added.length,
    differing: plan.summary.decided.length,
    warnings: plan.warnings,
  };
}

/**
 * Tether the notebook to `input` (replacing an earlier tether) and run the
 * first sync: entries on one side only are copied to the other, entries in
 * both are merged, and `prefer` decides fields whose values differ. With
 * `create`, a file that does not exist is created.
 */
export async function tetherBibFile(notebook: string, input: string, { prefer, create = false }: { prefer: TetherPrefer; create?: boolean }) {
  await readReferenceLibrary(notebook); // Never create a notebook as a side effect of tethering.
  const target = tetherTargetFor(notebook, input);
  const absolute = resolveTarget(notebook, target);
  const file = await readTetherFile(absolute);
  if (!file) {
    if (!create) throw new TetherError("That file was not found.", 404);
    if (!(await pathExists(path.dirname(absolute)))) throw new TetherError("The folder for that file does not exist.", 404);
  }
  await withReferenceFileLock(bibTetherStatePath(notebook), async () => {
    const config: TetherConfig = {
      version: STATE_VERSION,
      target,
      dialect: detectBibDialect(file?.text ?? ""),
      tetheredAt: new Date().toISOString(),
      prefer,
      base: null,
      status: { state: "synced", warnings: [] },
    };
    await saveConfig(notebook, config);
  });
  registry.tethered.set(notebook, true);
  const runtime = runtimeFor(notebook);
  resetRetry(runtime);
  stopWatching(runtime);
  runtime.started = true;
  return requestTetherSync(notebook);
}

/**
 * The tethered file is gone: write the library to its path again and carry
 * on syncing, using saved raw fields to restore entries without losing custom metadata.
 */
export async function recreateTetheredFile(notebook: string) {
  if (!(await pathExists(notebookPath(notebook)))) throw new TetherError("Notebook was not found.", 404);
  await withReferenceFileLock(bibTetherStatePath(notebook), async () => {
    const config = await readConfig(notebook);
    if (!config) throw new TetherError("This notebook's references are not tethered to a file.", 404);
    const absolute = resolveTarget(notebook, config.target);
    if (await readTetherFile(absolute)) throw new TetherError(`${path.basename(absolute)} exists again; it is synced as it is.`, 409);
    if (!(await pathExists(path.dirname(absolute)))) throw new TetherError("The folder for that file does not exist.", 404);
  });
  resetRetry(runtimeFor(notebook));
  return requestTetherSync(notebook, { recreate: true, deletions: "restore" });
}

/** Stop syncing. The file and the library stay as they are. */
export async function untetherBibFile(notebook: string) {
  const runtime = registry.runtimes.get(notebook);
  if (runtime) {
    stopWatching(runtime);
    clearTimer(runtime.libraryTimer);
    resetRetry(runtime);
  }
  if (await pathExists(notebookPath(notebook))) {
    await withReferenceFileLock(bibTetherStatePath(notebook), () => rm(bibTetherStatePath(notebook), { force: true }));
  }
  if (runtime) {
    stopWatching(runtime);
    clearTimer(runtime.libraryTimer);
    resetRetry(runtime);
  }
  registry.runtimes.delete(notebook);
  registry.tethered.set(notebook, false);
  publishReferenceEvent({ type: "tether", notebook, status: null });
}

/**
 * Check for changes a watcher may have missed when the window regains focus.
 * An unchanged hash and library revision need no lock or state writes.
 */
export async function checkTether(notebook: string): Promise<TetherStatus | null> {
  // A focus/reconnect is an event, not a poll. Hash once: same-size edits can
  // retain mtimes on FAT, network shares and copies restored from backup.
  const config = await readConfig(notebook);
  if (!config) return noTether(notebook);
  registry.tethered.set(notebook, true);
  if (config.base && hasBaseSnapshots(config) && (config.status.state === "synced" || config.status.state === "paused")) {
    try {
      const absolute = resolveTarget(notebook, config.target);
      const [file, library] = await Promise.all([readTetherFile(absolute), readReferenceLibrary(notebook)]);
      if (file?.hash === config.base.fileHash && library.revision === config.base.libraryRevision) {
        const wasWatching = runtimeFor(notebook).watchComplete;
        await watchFile(notebook, absolute);
        runtimeFor(notebook).started = true;
        const status = statusOf(notebook, config);
        if (status.watching !== wasWatching) publishReferenceEvent({ type: "tether", notebook, status });
        return status;
      }
    } catch { /* The locked sync records and reports the error. */ }
  }
  return requestTetherSync(notebook);
}

/**
 * Files moved in Libera (a file, a folder, or a renamed notebook): a
 * tethered file inside follows. Never fails the move.
 */
export async function moveTetheredFiles(from: string, to: string) {
  const directories = await readdir(getAdminRoot(), { withFileTypes: true }).catch(() => []);
  const notebooks = new Set([...registry.runtimes.keys(), ...directories.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name),
    ...getLinkedFolders().filter((folder) => !folder.unresolved).map((folder) => folder.name)]);
  if (registry.runtimes.has(from) && !from.includes("/")) {
    const old = registry.runtimes.get(from)!;
    stopWatching(old);
    clearTimer(old.libraryTimer);
    resetRetry(old);
    registry.runtimes.delete(from);
    registry.tethered.delete(from);
    notebooks.delete(from);
    notebooks.add(to);
  }
  for (const notebook of notebooks) {
    try {
      if (!(await pathExists(bibTetherStatePath(notebook)))) continue;
      const ownerMoved = !from.includes("/") && notebook === to;
      const snapshot = await readConfig(notebook);
      if (!snapshot) continue;
      const shown = displayPath(notebook, snapshot.target);
      if (!ownerMoved && (snapshot.target.kind === "absolute" || shown !== from && !shown.startsWith(`${from}/`))) continue;
      const followed = await withReferenceFileLock(bibTetherStatePath(notebook), async () => {
        const config = await readConfig(notebook);
        if (!config || config.target.kind === "absolute") return ownerMoved;
        const current = displayPath(notebook, config.target);
        if (current !== from && !current.startsWith(`${from}/`)) return ownerMoved;
        const moved = to + current.slice(from.length);
        const owner = moved.split("/")[0];
        config.target = owner === notebook ? { kind: "notebook", path: moved.slice(owner.length + 1) } : { kind: "library", path: moved };
        await saveConfig(notebook, config);
        return true;
      });
      if (!followed) continue;
      stopWatching(runtimeFor(notebook));
      void requestTetherSync(notebook).catch(() => undefined);
    } catch (error) {
      console.error(`[references] Could not follow the tethered file of ${notebook} from ${from} to ${to}:`, error);
    }
  }
}

/** Stop every watcher and timer (tests, before the data directory changes). */
export function resetBibTethers() {
  for (const runtime of registry.runtimes.values()) {
    stopWatching(runtime);
    clearTimer(runtime.libraryTimer);
    clearTimer(runtime.retryTimer);
  }
  registry.runtimes.clear();
  registry.tethered.clear();
}

/** Wait until the notebook's pending and running syncs are done (tests). */
export async function settleBibTether(notebook: string) {
  const runtime = registry.runtimes.get(notebook);
  if (!runtime) return;
  if (runtime.settleTimer || runtime.libraryTimer) {
    clearTimer(runtime.settleTimer);
    clearTimer(runtime.libraryTimer);
    runtime.settleTimer = null;
    runtime.libraryTimer = null;
    await requestTetherSync(notebook);
  }
  await runtime.chain.catch(() => undefined);
}
