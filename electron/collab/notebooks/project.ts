// One shared notebook while the app runs: the materializer (CRDT → disk),
// the watcher (disk → CRDT), file operations and reconciliations.
//
// Everything that touches the notebook folder or the layout runs on one
// queue per project. That serializes writes per file (and across files, which
// keeps renames and creates from racing each other), and it is what makes
// self-writes invisible: a scan never runs between a write and the layout
// update that records its hash.

import { promises as fs, watch, type FSWatcher } from "node:fs";
import path from "node:path";

import type * as Y from "yjs";

import type { FileBlobResponse, FileOpRequest, HostEvent, LocalAlbum, LocalAlbumPhoto, Reconciliation, UpdateAlbumRequest } from "../../../src/lib/collab/local-api";
import type { Provenance } from "../../../src/lib/collab/protocol/actor";
import type { Role } from "../../../src/lib/collab/protocol/roles";
import { roleAtLeast } from "../../../src/lib/collab/protocol/roles";
import {
  AlbumSettingKeys,
  ContentKeys,
  MAX_ALBUM_CAPTION_LENGTH,
  ManifestKeys,
  albumImageType,
  albumPathError,
  manifestPathKey,
  type AlbumPhotoRecord,
  type ManifestEntry,
} from "../../../src/lib/collab/protocol/schema";
import { stripPhotoMetadata } from "../../../src/lib/collab/photo-metadata";
import type { Logger } from "../core/clock";
import type { DocHub } from "../core/doc-hub";
import type { CollabHost } from "../core/host";
import { ControlError } from "../control/types";
import { classifyFile, createSharedDocument, mimeForPath } from "./documents";
import { clearMoveJournal, recoverInterruptedMoves, writeMoveJournal } from "./move-journal";
import {
  ARCHIVE_DIRECTORY,
  PathRefusedError,
  WriteCancelledError,
  STATE_DIRECTORY,
  FileBusyError,
  flushToDisk,
  movePathUnique,
  writeFileUnique,
  contentGuard,
  decodeText,
  encodeText,
  ensureDirectory,
  isActiveSqliteDatabase,
  isExcludedPath,
  isFinderCopy,
  isGeneratedPath,
  isNotFound,
  isShareablePath,
  mayStillBeCopying,
  movePath,
  pruneEmptyDirectories,
  randomId,
  readIfExists,
  readWithin,
  resolveInside,
  SLOW_READ,
  sha256,
  statIfExists,
  walkNotebook,
  writeFileAtomic,
  type WalkEntry,
  type NotebookWalk,
  type WriteGuard,
} from "./fs-ops";
import { computeLayout, entriesUnder, entryRecord, readManifest } from "./layout";
import { PdfCommentService } from "./pdf-comments";
import { PdfMarksRuntime } from "./pdf-marks";
import { PDF_LIVE_SETTING } from "../../../src/lib/collab/protocol/pdf";
import { emptyState, isStaleCopy, isUncertainCopy, readBase, readMarker, readState, setMaterialized, writeBase, writeMarker, writeState, deleteBase, type LayoutRecord, type ProjectState } from "./state";
import { diffText } from "./text-diff";

/** Where a notebook keeps its files' ink (INK_DIR in src/lib/storage/constants.ts). */
const INK_DIRECTORY = "_ink";

/**
 * How long a scan waits for one file's bytes before moving on and retrying:
 * an online-only file downloads on first read, and the scan holds the
 * notebook's queue (stopping and lease changes wait on it).
 */
const HYDRATION_WAIT_MS = 10_000;

/**
 * Files at least this large are verified against their stats every
 * largeFileVerifyMs instead of every verifyMs: hashing a folder of figures
 * and PDFs each minute costs more battery than everything else the sync
 * does. The bound stays finite because no stat proves the bytes unchanged:
 * Linux FAT derives ctime from mtime, and sync clients can set ChangeTime.
 */
export const LARGE_FILE_BYTES = 1024 * 1024;

/** Watcher events at most delay a scan this long while they keep coming; a scan still runs during a long burst. */
const SCAN_MAX_WAIT_MS = 5000;

/** Distinct paths kept for the missed-event check between two walks; later events count for their top-level entry. */
const MAX_REPORTED_PATHS = 10_000;

/** Longest wait between retries of a failed state.json write. */
const MAX_SAVE_RETRY_MS = 5 * 60_000;

/** How long a follower keeps watching for one path, for a slow sync client or a writer that is away. */
const FOLLOWER_DISK_WAIT_MS = 10 * 60_000;

export interface Timings {
  /**
   * Quiet time after a change before a document's working copy is written.
   * The CRDT in the host's SQLite is the real copy (every edit is committed
   * there first), so the disk copy only needs to be fresh enough for search,
   * builds and other programs: a collaborator typing must not mean a disk
   * write per keystroke.
   */
  writeDebounceMs: number;
  /** Longest a document's working copy waits while changes keep coming. */
  writeMaxWaitMs: number;
  /** Quiet time after a watcher event before scanning. */
  settleMs: number;
  /** How long a file must stay missing before it counts as deleted (lets delete+create pair into a rename). */
  deleteGraceMs: number;
  /** Fallback poll for file systems where fs.watch misses events (ExFAT, network drives). */
  pollMs: number;
  /**
   * The poll while fs.watch appears to work here: a safety net then. A
   * change the walk finds without a watcher event drops back to pollMs (a
   * heuristic: see noticeMissedEvents for what it cannot see).
   */
  watchedPollMs: number;
  /** How long an unexplained change may wait for its watcher event before fs.watch counts as missing events. */
  watchGraceMs: number;
  /** On battery, the poll and the content verifications run this many times less often. */
  batteryScale: number;
  /** How often a follower checks whether the writer's disk has caught up with the manifest. */
  followerDiskMs: number;
  /** Retry delay for downloads and creates that failed (offline). */
  retryMs: number;
  /**
   * Age after which a file below LARGE_FILE_BYTES is read and hashed again
   * even if every stat is unchanged (times batteryScale on battery). Also
   * the retry bound for a file whose change could not be handled yet.
   */
  verifyMs: number;
  /** The same for files of LARGE_FILE_BYTES or more, spread ±25% per file so they do not all come due together. */
  largeFileVerifyMs: number;
  /** Delay before a shared PDF's sidecar copy is rewritten. */
  pdfWriteMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  writeDebounceMs: 2000,
  writeMaxWaitMs: 15_000,
  settleMs: 250,
  deleteGraceMs: 1200,
  pollMs: 5000,
  watchedPollMs: 30_000,
  watchGraceMs: 2000,
  batteryScale: 4,
  followerDiskMs: 1000,
  retryMs: 5000,
  verifyMs: 60_000,
  largeFileVerifyMs: 30 * 60_000,
  pdfWriteMs: 60_000,
};

export interface ProjectInfo {
  projectId: string;
  name: string;
  /** Folder name under the library root. */
  notebook: string;
  root: string;
  role: Role;
  manifestDocId: string;
  /** Identity of the working copy; a replacement folder must never be imported. */
  folderId?: string;
  /** Identity captured when this runtime was authorized/opened. */
  accountId?: string;
  serverUrl?: string;
  /**
   * Another installation writes this folder (it reaches this device through
   * OneDrive or the like). The project still syncs, so the app, the agent
   * and file operations work, but this host never writes the working copy,
   * state.json, base/ or the marker, and it does not import disk changes.
   */
  follower?: boolean;
  /**
   * A shared album: the folder holds photos only (top-level PNG, JPEG, WebP
   * and GIF files; anything else stays local), new photos lose their
   * location details unless the album keeps them, and each photo has a
   * record in the manifest's `photos` map.
   */
  album?: boolean;
}

export interface ProjectContext {
  host: CollabHost;
  logger: Logger;
  timings: Timings;
  /** Running on battery: the folder is checked less often. */
  onBattery?(): boolean;
  emit(event: HostEvent): void;
  /** The signed-in account (manifest createdBy). */
  accountId(): Promise<string>;
  /** Access to the project was revoked (a doc or the manifest was closed with access-revoked). */
  revoked(projectId: string): void;
  /** The role changed (from a hub's meta). */
  roleChanged(projectId: string, role: Role): void;
  /** The layout changed; the resolvePath index must be rebuilt. */
  layoutChanged(projectId: string): void;
  /** Fresh local writer lease; editor/explicit manifest operations do not need it. */
  canWriteDisk?(projectId: string): boolean;
}

interface DocRuntime {
  docId: string;
  fileId: string;
  hub: DocHub;
  unsubscribe: Array<() => void>;
  writeTimer: ReturnType<typeof setTimeout> | null;
  /** When the oldest change not yet written arrived (for writeMaxWaitMs). */
  pendingSince: number | null;
  /** The content was rolled back and is empty until the server sends it again. */
  rebuilt: boolean;
  wasReady: boolean;
}

const EXTERNAL: Provenance = { source: "external-file" };

export interface IndexedDoc {
  fileId: string;
  docId: string;
  path: string;
  docKind: NonNullable<LayoutRecord["docKind"]>;
}

export class SharedProject {
  readonly info: ProjectInfo;
  private readonly ctx: ProjectContext;
  private state: ProjectState;
  private entries = new Map<string, ManifestEntry>();
  private manifestHub: DocHub | null = null;
  private manifestRebuilt = false;
  private manifestConnected = false;
  private manifestWasReady = false;
  private readonly docs = new Map<string, DocRuntime>();
  private readonly unsubscribe: Array<() => void> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private watcher: FSWatcher | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private manifestTimer: ReturnType<typeof setTimeout> | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the armed scan timer fires (performance.now()), and when its first request came. */
  private scanDueAt = 0;
  private scanFirstAt = 0;
  /** The armed scan was asked for without delay (poll, resume, retry); watcher debouncing never postpones it. */
  private scanForced = false;
  /** A scan is queued and has not started; it will see everything recorded until then. */
  private scanQueued = false;
  /** A scan was refused while the writer lease had lapsed; it runs once the lease is confirmed. */
  private scanDeferred = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the current poll wait began (performance.now()); a new interval counts from here. */
  private pollArmedAt = 0;
  /** fs.watch has not been caught missing a change here (see noticeMissedEvents). */
  private watcherTrusted = true;
  /**
   * The missed-event check's view of the folder, by manifestPathKey: the
   * stats last accounted for, since when events explain a change, and when
   * an unexplained change was first seen (performance.now() times).
   */
  private watchBaseline: Map<string, { entry: WalkEntry | null; since: number; unexplainedAt?: number }> | null = null;
  /** Start of the walk the baseline came from: events since then explain paths it does not hold. */
  private watchBaselineAt = 0;
  /** manifestPathKey of each path fs.watch reported, with when (performance.now()). */
  private readonly reportedAt = new Map<string, number>();
  /** Paths a follower is waiting on: whether each should be on disk, and until when to wait. */
  private readonly awaitedOnDisk = new Map<string, { present: boolean; until: number }>();
  private followerDiskTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** state.json is behind the in-memory state; kept until a write succeeds. */
  private stateDirty = false;
  private saveFailures = 0;
  private readonly missingSince = new Map<string, number>();
  private readonly refusedLogged = new Set<string>();
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private started = false;
  private rootUnavailable = false;
  private albumSnapshot: string | null = null;
  private pdfLiveSnapshot = false;
  private readonly baselineMissing = new Set<string>();
  private readonly uploadedBlobs = new Map<string, Uint8Array>();
  /** IDs chosen for an automatic import of a path+content, kept across uncertain outcomes. */
  private readonly importAttempts = new Map<string, { fileId: string; docId: string }>();
  private dirtyPaths = new Set<string>();
  private verifyAll = false;
  /**
   * The last content read of each file. `pending`: what it found is not
   * handled yet (a failed download or upload, a document not ready), so it
   * is retried every verifyMs whatever the file's size.
   */
  private readonly verified = new Map<string, { ctimeMs: number | undefined; at: number; pending?: boolean }>();
  /** Retired path keys, each with the content hashes known for it. */
  private readonly retired: Map<string, Set<string>>;
  private observedEntries = new Map<string, ManifestEntry>();
  readonly pdfs: PdfMarksRuntime;

  private constructor(ctx: ProjectContext, info: ProjectInfo, state: ProjectState) {
    this.ctx = ctx;
    this.info = info;
    this.state = state;
    this.retired = ctx.host.store.retiredPaths(info.projectId);
    this.pdfs = new PdfMarksRuntime({
      host: ctx.host,
      logger: ctx.logger,
      projectId: info.projectId,
      notebook: info.notebook,
      root: info.root,
      writeMs: ctx.timings.pdfWriteMs,
      role: () => this.info.role,
      canWriteDisk: () => !this.follower,
      guard: (finalizing) => this.diskGuard(finalizing),
      authorityReady: () => this.manifestReady(),
      recordLive: async () => {
        const marker = await readMarker(info.root);
        if (marker && !marker.pdfLive) await writeMarker(info.root, { ...marker, pdfLive: true }, this.diskGuard());
      },
      commentsChanged: (docId) => ctx.emit({ t: "pdf-comments-changed", docId }),
      filesChanged: (paths) => this.filesChanged(paths),
      manifest: () => (this.manifestHub && !this.manifestHub.isClosed ? this.manifestHub.getDoc("manifest") : null),
      listComments: (docId) => this.pdfComments().list(docId),
    });
  }

  static async open(ctx: ProjectContext, info: ProjectInfo): Promise<SharedProject> {
    // A follower's layout comes from the manifest alone; state.json and its
    // reconciliations belong to the writer.
    const project = new SharedProject(ctx, info, emptyState());
    if (!project.follower) {
      const identity = { projectId: info.projectId, manifestDocId: info.manifestDocId, ...(info.folderId ? { folderId: info.folderId } : {}) };
      project.state = await readState(info.root, project.diskGuard(), identity);
      project.state.identity = identity;
    }
    if (project.state.externalAdoptionRequired) ctx.host.store.requireExternalAdoption(info.projectId);
    if (ctx.host.store.requiresExternalAdoption(info.projectId)) project.state.externalAdoptionRequired = true;
    if (!project.follower && !info.album) {
      // Staged bytes of a move an earlier run never finished (STALE-3).
      const recovered = await recoverInterruptedMoves(info.root, project.diskGuard()).catch((error) => {
        ctx.logger.warn(`Shared notebook ${info.notebook}: could not resolve interrupted moves`, error);
        return [];
      });
      for (const move of recovered) if (move.outcome === "archived") ctx.logger.warn(`Shared notebook ${info.notebook}: an interrupted move's file was kept in the archive as ${move.archivedAs}`);
    }
    if (!info.follower) {
      // State/marker can arrive ahead of files through a cloud provider.
      // Absence at startup or takeover is not an observed user deletion.
      for (const [fileId, record] of Object.entries(project.state.layout)) {
        if (record.kind === "folder") continue;
        const target = await resolveInside(info.root, record.path).catch(() => null);
        if (target && (await statIfExists(target)) === null) project.baselineMissing.add(fileId);
      }
    }
    return project;
  }

  get follower(): boolean {
    return this.info.follower === true || this.ctx.canWriteDisk?.(this.info.projectId) === false;
  }

  get role(): Role {
    return this.info.role;
  }

  set role(role: Role) {
    this.info.role = role;
    this.pdfs.roleChanged();
  }

  private get canEdit(): boolean {
    return roleAtLeast(this.info.role, "editor");
  }

  /** A missing/moved/replaced notebook is not a notebook with every file deleted. */
  private async rootAvailable(): Promise<boolean> {
    let available = false;
    try {
      const stats = await fs.lstat(this.info.root);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        const marker = await readMarker(this.info.root);
        available = marker !== null && !marker.revoked && marker.projectId === this.info.projectId &&
          marker.manifestDocId === this.info.manifestDocId && (!this.info.folderId || marker.folderId === this.info.folderId) &&
          (!this.info.accountId || marker.accountId === this.info.accountId) &&
          (!this.info.serverUrl || marker.serverUrl.replace(/\/+$/, "") === this.info.serverUrl.replace(/\/+$/, ""));
      }
    } catch { /* Unavailable roots must never be recreated by the materializer. */ }
    if (!available) this.rootUnavailable = true;
    return available;
  }

  private diskGuard(finalizing = false): WriteGuard {
    return { root: this.info.root, canCommit: async () => (finalizing || (!this.stopped && !this.follower)) && await this.rootAvailable() };
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    const hub = this.ctx.host.acquire(this.info.manifestDocId, { kind: "manifest", projectId: this.info.projectId });
    this.manifestHub = hub;
    this.observedEntries = this.readEntries();
    this.unsubscribe.push(
      hub.observe("manifest", (change) => {
        if (change.origin === "rebuilt") {
          this.manifestRebuilt = true;
          return;
        }
        if (change.origin === "server") this.manifestRebuilt = false;
        const current = this.readEntries();
        for (const entry of this.observedEntries.values()) {
          if (current.get(entry.fileId)?.path !== entry.path) this.retirePath(entry.path, knownHashes(this.state.layout[entry.fileId], entry));
        }
        this.observedEntries = current;
        this.scheduleManifest(30);
      }),
      hub.onStatus(() => {
        if (!this.manifestWasReady && this.manifestReady()) this.scheduleManifest(30);
        // PDFs first opened elsewhere while this host was away announced it to nobody here.
        const { connected } = hub.getStatus();
        if (connected && !this.manifestConnected) void this.pdfs.refreshServerDocuments();
        this.manifestConnected = connected;
      }),
      hub.onMeta((meta) => this.metaChanged(meta.role, meta.readOnlyReason)),
    );
    // Docs already in the layout get their hubs now, so remote edits that
    // arrive before the first manifest pass are not missed.
    for (const [fileId, record] of Object.entries(this.state.layout)) {
      if (record.kind === "doc" && record.docId) this.ensureDoc(record.docId, fileId);
    }
    this.scheduleManifest(0);
    if (!this.follower) this.startWatching();
  }

  /**
   * Stops syncing and watching. Files stay where they are. `persist: false`
   * skips the final state.json write (the folder has another writer now).
   */
  stop(options: { persist?: boolean; preserveContent?: boolean } = {}): Promise<void> {
    if (!this.stopping) this.stopping = this.doStop(options).catch((error) => { this.stopping = null; throw error; });
    return this.stopping;
  }

  private async doStop(options: { persist?: boolean; preserveContent?: boolean }): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.stopAwaitingDisk();
    for (const timer of [this.manifestTimer, this.scanTimer, this.retryTimer, ...this.timers]) if (timer) clearTimeout(timer);
    this.manifestTimer = this.scanTimer = this.retryTimer = null;
    this.timers.clear();
    for (const doc of this.docs.values()) {
      if (doc.writeTimer) clearTimeout(doc.writeTimer);
      doc.writeTimer = null;
      doc.pendingSince = null;
    }
    await this.queue.catch(() => undefined);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (options.preserveContent) await this.preserveLatestText();
    await this.pdfs.stop({ local: options.preserveContent === true }).catch((error) => this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not stop its PDFs`, error));
    if ((options.preserveContent || !this.follower) && options.persist !== false && await this.rootAvailable()) await writeState(this.info.root, this.state, this.diskGuard(true)).catch(() => undefined);
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe.length = 0;
    for (const doc of [...this.docs.values()]) this.releaseDoc(doc.docId);
    if (this.manifestHub) this.ctx.host.release(this.info.manifestDocId);
    this.manifestHub = null;
  }

  /** A terminal lifecycle transition must keep text newer than the disk debounce. */
  private async preserveLatestText(): Promise<void> {
    const guard = this.diskGuard(true);
    for (const record of Object.values(this.state.layout)) {
      try {
        if (!record.docId || !(await guard.canCommit())) continue;
        const runtime = this.docs.get(record.docId);
        if (!runtime || !this.docReady(runtime)) continue;
        const text = runtime.hub.getText("content");
        const bytes = encodeText(text);
        const target = await resolveInside(this.info.root, record.path);
        const disk = await readWithin(target, HYDRATION_WAIT_MS);
        // Stopping must not wait on a stalled provider: keep the text in the archive instead.
        if (disk === SLOW_READ) throw new WriteCancelledError();
        let expected = disk === null ? null : sha256(disk);
        if (disk && sha256(disk) !== sha256(bytes) && sha256(disk) !== record.hash &&
            decodeText(disk) !== await readBase(this.info.root, record.docId)) {
          await this.archive(record.path, contentGuard(target, expected, guard));
          expected = null;
        }
        const stats = await writeFileAtomic(target, bytes, contentGuard(target, expected, guard));
        setMaterialized(record, sha256(bytes), stats.size, stats.mtimeMs);
        await writeBase(this.info.root, record.docId, text, guard);
      } catch (error) {
        // A local symlink or a disappearing/replaced root must not block
        // revocation, nor turn preservation into a write outside this copy.
        if (!(error instanceof PathRefusedError) && !(error instanceof WriteCancelledError) && !isNotFound(error)) throw error;
        const runtime = record.docId ? this.docs.get(record.docId) : undefined;
        let archived = false;
        try {
          if (error instanceof WriteCancelledError && runtime && await guard.canCommit()) {
            const directory = path.join(this.info.root, ARCHIVE_DIRECTORY);
            await writeFileUnique(directory, `${path.posix.basename(record.path)}.${runtime.docId}.shared`, encodeText(runtime.hub.getText("content")), guard);
            archived = true;
          }
        } catch (recoveryError) {
          if (!(recoveryError instanceof PathRefusedError) && !(recoveryError instanceof WriteCancelledError) && !isNotFound(recoveryError)) throw recoveryError;
        }
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} stays in ${archived ? "the archive" : "the local collaboration log"} because its disk target is unavailable.`);
      }
    }
  }

  /** Export current binaries even on a follower, before deleting server access. */
  prepareLocalConversion(): Promise<number> {
    return this.enqueueExplicit(async () => {
      const hub = this.manifestHub;
      if (!hub || !this.manifestReady() || !hub.getStatus().connected || hub.pendingCount > 0) {
        throw new ControlError(503, "offline", "Connect and sync this notebook before taking it down.");
      }
      const sequence = this.ctx.host.store.getDocMeta(this.info.manifestDocId)?.lastSeenServerSeq ?? 0;
      const entries = this.readEntries();
      const layout = computeLayout(entries.values());
      const needsRoot = [...entries.values()].some((entry) => entry.kind === "blob");
      const current = async () => !this.stopped && hub.getStatus().connected && hub.pendingCount === 0 &&
        this.ctx.host.store.getDocMeta(this.info.manifestDocId)?.lastSeenServerSeq === sequence && (!needsRoot || await this.rootAvailable());
      const guard: WriteGuard = { root: this.info.root, canCommit: current };
      for (const entry of entries.values()) {
        if (entry.kind !== "blob" || !entry.blobHash) continue;
        const relative = layout.paths.get(entry.fileId);
        if (!relative) throw new ControlError(409, "conflict", "A shared file has no safe local path.");
        const bytes = await this.blobBytes(entry.blobHash);
        if (!bytes || sha256(bytes) !== entry.blobHash) throw new ControlError(503, "offline", `Could not preserve ${relative}. The shared project was kept.`);
        const target = await resolveInside(this.info.root, relative);
        const disk = await readWithin(target, HYDRATION_WAIT_MS);
        if (disk === SLOW_READ) throw new ControlError(503, "offline", `${relative} is still downloading from the cloud folder. The shared project was kept; retry taking it down.`);
        let expected = disk === null ? null : sha256(disk);
        if (expected !== entry.blobHash) {
          if (disk && !this.info.album) {
            await this.archive(relative, contentGuard(target, expected, guard));
            expected = null;
          }
          await writeFileAtomic(target, bytes, contentGuard(target, expected, guard));
        }
      }
      // The server project is deleted next: make the exported (and previously
      // materialized text) files and their folders durable first.
      const exported: string[] = [];
      for (const [fileId, relative] of layout.paths) {
        if (entries.get(fileId)?.kind === "folder") continue;
        exported.push(await resolveInside(this.info.root, relative).catch(() => ""));
      }
      const files = exported.filter(Boolean);
      const folders = new Set<string>([this.info.root]);
      for (const file of files) {
        for (let folder = path.dirname(file); folder.length > this.info.root.length && !folders.has(folder); folder = path.dirname(folder)) folders.add(folder);
      }
      try { await flushToDisk(files, [...folders].sort((a, b) => b.length - a.length)); }
      catch (error) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not flush the exported files to disk`, error);
        throw new ControlError(503, "offline", "Could not make the exported files durable. The shared project was kept.");
      }
      if (!await current()) throw new ControlError(409, "conflict", "The notebook changed during its local export. Retry taking it down.");
      return sequence;
    });
  }

  /** Resolves once the queue is empty and no write, scan or manifest pass is pending. */
  async whenIdle(timeoutMs?: number): Promise<boolean> {
    // Continuous remote edits or watcher events can keep re-arming timers, so
    // a caller that must finish passes a bound and gets false (retryable).
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let cutoff: ReturnType<typeof setTimeout> | undefined;
      await (Number.isFinite(remaining)
        ? Promise.race([this.queue.catch(() => undefined), new Promise((resolve) => { cutoff = setTimeout(resolve, remaining); })])
        : this.queue.catch(() => undefined));
      clearTimeout(cutoff);
      const pendingWrites = [...this.docs.values()].some((doc) => doc.writeTimer !== null);
      if (this.queued === 0 && !pendingWrites && !this.manifestTimer && !this.scanTimer) return true;
      if (deadline - Date.now() <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * Best effort on a device that learns ANOTHER device took the project down:
   * make every current binary local while the server (or this device's blob
   * cache) can still supply it. Never throws and never blocks the takedown.
   * Returns the paths whose current bytes could not be made local, or null
   * when the manifest was unavailable to tell.
   */
  async preserveBinariesAfterTakedown(): Promise<string[] | null> {
    if (!this.manifestHub || this.manifestRebuilt) return null;
    let entries: Map<string, ManifestEntry>;
    try { entries = this.readEntries(); } catch { return null; }
    const layout = computeLayout(entries.values());
    const guard = this.diskGuard(true);
    const missing: string[] = [];
    for (const entry of entries.values()) {
      if (entry.kind !== "blob" || !entry.blobHash) continue;
      const relative = layout.paths.get(entry.fileId);
      if (!relative) continue;
      try {
        const target = await resolveInside(this.info.root, relative);
        const disk = await readIfExists(target);
        const expected = disk === null ? null : sha256(disk);
        if (expected === entry.blobHash) continue;
        const bytes = await this.blobBytes(entry.blobHash);
        if (!bytes || sha256(bytes) !== entry.blobHash) { missing.push(relative); continue; }
        if (disk && !this.info.album) await this.archive(relative, contentGuard(target, expected, guard));
        await writeFileAtomic(target, bytes, contentGuard(target, disk && !this.info.album ? null : expected, guard));
      } catch {
        missing.push(relative);
      }
    }
    return missing;
  }

  /** True once every manifest entry has been placed on disk (join waits on this). */
  isMaterialized(): boolean {
    if (!this.manifestReady()) return false;
    if (this.follower) return true;
    const layout = computeLayout(this.readEntries().values());
    for (const fileId of layout.paths.keys()) {
      const record = this.state.layout[fileId];
      if (!record) return false;
      if (record.kind !== "folder" && !record.hash) return false;
    }
    return true;
  }

  /**
   * Runs `task` after the queued work. Background work is skipped once the
   * runtime stops; an explicit request (`explicit`) is refused instead, so its
   * caller never reports success for a change that never ran.
   */
  private enqueue<T>(task: () => Promise<T>, options: { explicit?: boolean } = {}): Promise<T> {
    this.queued += 1;
    const run = this.queue.then(async () => {
      try {
        if (this.stopped) {
          if (options.explicit) throw new ControlError(503, "notebook-unavailable", "The shared notebook stopped before this change could run. Nothing was changed.");
          return undefined as T;
        }
        return await task();
      } finally {
        this.queued -= 1;
      }
    });
    this.queue = run.catch((error) => {
      if (!(error instanceof ControlError) && !(error instanceof WriteCancelledError)) this.ctx.logger.error(`Shared notebook ${this.info.notebook}: task failed`, error);
    });
    return run;
  }

  /** A user's request: refused, never silently dropped, if the runtime stops first. */
  private enqueueExplicit<T>(task: () => Promise<T>): Promise<T> {
    return this.enqueue(task, { explicit: true });
  }

  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  private metaChanged(role: Role, reason: string | undefined): void {
    if (reason === "access-revoked") {
      this.ctx.revoked(this.info.projectId);
      return;
    }
    if (role !== this.info.role) this.ctx.roleChanged(this.info.projectId, role);
  }

  // ------------------------------------------------------------ manifest

  private manifestDoc(): Y.Doc {
    if (!this.manifestHub) throw new Error("The manifest is not open.");
    return this.manifestHub.getDoc("manifest");
  }

  /**
   * Whether the manifest holds real state. Applying an empty manifest that
   * is still loading would archive every file in the notebook.
   */
  private manifestReady(): boolean {
    const hub = this.manifestHub;
    if (!hub || hub.isClosed || this.manifestRebuilt) return false;
    return hubHasState(this.ctx.host, hub, "manifest");
  }

  private scheduleManifest(delay: number): void {
    if (this.stopped || this.manifestTimer) return;
    this.manifestTimer = setTimeout(() => {
      this.manifestTimer = null;
      void this.enqueue(() => this.applyManifest());
    }, delay);
    this.manifestTimer.unref?.();
  }

  /** Makes the folder match the manifest: removals, moves, folders, new and changed files. */
  private async applyManifest(): Promise<void> {
    if (!this.manifestReady()) return;
    this.manifestWasReady = true;
    const pdfLive = this.pdfs.enabled;
    if (pdfLive !== this.pdfLiveSnapshot) {
      this.pdfLiveSnapshot = pdfLive;
      this.ctx.emit({ t: "project-changed", projectId: this.info.projectId });
    }
    if (this.follower) {
      this.followManifest();
      this.notifyAlbumChanged();
      return;
    }
    if (!(await this.rootAvailable())) {
      this.scheduleRetry();
      return;
    }
    this.entries = this.readEntries();
    const layout = computeLayout(this.entries.values());
    for (const refused of layout.refused) {
      if (this.refusedLogged.has(refused.fileId)) continue;
      this.refusedLogged.add(refused.fileId);
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: not writing "${refused.path}": ${refused.reason}`);
    }
    const previous = this.state.layout;
    const next: Record<string, LayoutRecord> = {};
    const touched = new Set<string>();
    const vacated = new Set<string>();
    let needsRetry = false;

    // Removed entries: archive files (never delete user data outright).
    for (const [fileId, record] of Object.entries(previous)) {
      if (layout.paths.has(fileId)) continue;
      this.retirePath(record.path, knownHashes(record));
      touched.add(record.path);
      vacated.add(record.kind === "folder" ? record.path : path.posix.dirname(record.path));
      if (record.docId) this.docs.get(record.docId)?.hub.markDeleted();
      if (record.kind !== "folder") await this.archiveRemoved(record);
      if (record.docId) {
        this.releaseDoc(record.docId);
        this.dropReconciliations(record.docId);
        await deleteBase(this.info.root, record.docId, this.diskGuard()).catch(() => undefined);
      }
      this.missingSince.delete(fileId);
    }

    // Moves, in two phases so swaps and chains (a→b, b→a) cannot collide.
    const staged: Array<{ fileId: string; staging: string; record: LayoutRecord }> = [];
    for (const [fileId, record] of Object.entries(previous)) {
      const desired = layout.paths.get(fileId);
      if (!desired || desired === record.path) continue;
      this.retirePath(record.path, knownHashes(record));
      if (record.kind === "folder") {
        vacated.add(record.path);
        continue;
      }
      touched.add(record.path).add(desired);
      vacated.add(path.posix.dirname(record.path));
      try {
        const source = await resolveInside(this.info.root, record.path);
        if (!(await statIfExists(source))) {
          next[fileId] = { ...record, path: desired, hash: undefined, size: undefined, mtimeMs: undefined };
          continue;
        }
        // Never reuse an interrupted move's sole recovery artifact.
        const staging = path.join(this.info.root, ...STATE_DIRECTORY, "moving", `${fileId}-${randomId("move")}`);
        const journalled = !this.info.album;
        // Journal first: a crash after staging must not leave bytes with no record of where they were going.
        if (journalled) await writeMoveJournal(this.info.root, { fileId, source: record.path, destination: desired, staged: path.basename(staging), ...(record.hash ? { hash: record.hash } : {}), stagedAt: Date.now() }, this.diskGuard());
        try {
          await movePath(source, staging, this.diskGuard());
        } catch (error) {
          if (journalled) await clearMoveJournal(this.info.root, path.basename(staging)).catch(() => undefined);
          throw error;
        }
        staged.push({ fileId, staging, record });
      } catch (error) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not move ${record.path}`, error);
      }
    }
    for (const { fileId, staging, record } of staged) {
      const desired = layout.paths.get(fileId) as string;
      try {
        const target = await resolveInside(this.info.root, desired);
        if (await statIfExists(target)) await this.archive(desired);
        await movePath(staging, target, this.diskGuard());
        if (!this.info.album) await clearMoveJournal(this.info.root, path.basename(staging)).catch(() => undefined);
        next[fileId] = { ...record, path: desired };
        this.missingSince.delete(fileId);
      } catch (error) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not move ${record.path} to ${desired}`, error);
        next[fileId] = { ...record, path: desired, hash: undefined, size: undefined, mtimeMs: undefined };
      }
    }

    // Folders.
    for (const directory of [...layout.directories].sort()) {
      try {
        const absolute = await resolveInside(this.info.root, directory);
        const stats = await statIfExists(absolute);
        if (stats && !stats.isDirectory()) await this.archive(directory);
        if (!stats || !stats.isDirectory()) {
          await ensureDirectory(absolute, this.diskGuard());
          touched.add(directory);
        }
      } catch (error) {
        this.refuse(directory, error);
      }
    }

    // Every current entry: carry records over, place new files.
    for (const [fileId, desired] of layout.paths) {
      const entry = this.entries.get(fileId) as ManifestEntry;
      const record: LayoutRecord = next[fileId] ?? (previous[fileId] ? { ...previous[fileId], path: desired } : { path: desired, kind: entry.kind });
      record.kind = entry.kind;
      if (entry.kind === "doc") {
        record.docId = entry.docId;
        record.docKind = entry.docKind;
      }
      next[fileId] = record;
      if (entry.kind === "doc" && entry.docId) {
        if (record.docId && previous[fileId]?.docId && previous[fileId].docId !== entry.docId) this.releaseDoc(previous[fileId].docId as string);
        this.ensureDoc(entry.docId, fileId);
      } else if (entry.kind === "blob" && entry.blobHash && (record.hash !== entry.blobHash || this.baselineMissing.has(fileId))) {
        const placed = await this.placeBlob(entry, record);
        if (placed) touched.add(desired);
        else needsRetry = true;
      }
    }

    const layoutChanged = JSON.stringify(previous) !== JSON.stringify(next);
    this.state.layout = next;
    for (const directory of vacated) {
      if (directory && directory !== ".") {
        await pruneEmptyDirectories(this.info.root, directory, (relative) => layout.directories.has(relative), this.diskGuard());
      }
    }
    if (layoutChanged) {
      this.saveSoon();
      this.ctx.layoutChanged(this.info.projectId);
      this.treeChanged(previous, next);
    }
    if (touched.size > 0) this.filesChanged([...touched]);
    this.pdfs.sync(this.entries.values(), layout.paths);
    // Documents whose file is missing or new get written now that their place exists.
    for (const [fileId, record] of Object.entries(next)) {
      if (record.kind === "doc" && record.docId && (!record.hash || this.rootUnavailable || this.baselineMissing.has(fileId))) {
        const runtime = this.docs.get(record.docId);
        if (runtime && runtime.fileId === fileId && this.docReady(runtime)) await this.materializeDoc(record.docId);
      }
    }
    this.rootUnavailable = false;
    this.notifyAlbumChanged();
    if (needsRetry) this.scheduleRetry();
  }

  /**
   * A follower's pass: the layout and document hubs follow the manifest, and
   * the disk is left to the writer (its files arrive through the sync client).
   */
  private followManifest(): void {
    this.entries = this.readEntries();
    const layout = computeLayout(this.entries.values());
    const previous = this.state.layout;
    const next: Record<string, LayoutRecord> = {};
    for (const [fileId, desired] of layout.paths) {
      const entry = this.entries.get(fileId) as ManifestEntry;
      next[fileId] = entry.kind === "doc" ? { path: desired, kind: "doc", docId: entry.docId, docKind: entry.docKind } : { path: desired, kind: entry.kind };
    }
    for (const [fileId, record] of Object.entries(previous)) {
      if (!next[fileId] || next[fileId].path !== record.path) this.retirePath(record.path, knownHashes(record));
      if (record.docId && next[fileId]?.docId !== record.docId) {
        this.docs.get(record.docId)?.hub.markDeleted();
        this.releaseDoc(record.docId);
      }
    }
    for (const [fileId, record] of Object.entries(next)) if (record.docId) this.ensureDoc(record.docId, fileId);
    this.pdfs.sync(this.entries.values(), layout.paths);
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.state.layout = next;
    this.ctx.layoutChanged(this.info.projectId);
    this.treeChanged(previous, next);
    this.awaitDisk(previous, next);
  }

  /**
   * A follower has no watcher, and the writer changes the disk after the
   * manifest, so the tree a window read on tree-changed can be out of date.
   * This says when the disk catches up, which through a sync client can take
   * minutes. An empty `previous` is the first read of the manifest, not a change.
   */
  private awaitDisk(previous: Record<string, LayoutRecord>, next: Record<string, LayoutRecord>): void {
    if (Object.keys(previous).length === 0) return;
    const until = Date.now() + FOLLOWER_DISK_WAIT_MS;
    for (const [fileId, record] of Object.entries(previous)) {
      if (next[fileId]?.path !== record.path) this.awaitedOnDisk.set(record.path, { present: false, until });
    }
    for (const [fileId, record] of Object.entries(next)) {
      if (previous[fileId]?.path !== record.path) this.awaitedOnDisk.set(record.path, { present: true, until });
    }
    if (this.awaitedOnDisk.size === 0 || this.followerDiskTimer) return;
    this.followerDiskTimer = setInterval(() => void this.checkAwaitedDisk(), this.ctx.timings.followerDiskMs);
    this.followerDiskTimer.unref?.();
  }

  private async checkAwaitedDisk(): Promise<void> {
    if (!this.follower) {
      this.stopAwaitingDisk();
      return;
    }
    const arrived: string[] = [];
    for (const [relative, awaited] of [...this.awaitedOnDisk]) {
      const target = await resolveInside(this.info.root, relative).catch(() => null);
      const settled = target !== null && (await statIfExists(target) !== null) === awaited.present;
      if (settled) arrived.push(relative);
      if (settled || Date.now() >= awaited.until) this.awaitedOnDisk.delete(relative);
    }
    if (this.stopped) return;
    if (arrived.length) this.filesChanged(arrived);
    if (this.awaitedOnDisk.size === 0) this.stopAwaitingDisk();
  }

  private stopAwaitingDisk(): void {
    if (this.followerDiskTimer) clearInterval(this.followerDiskTimer);
    this.followerDiskTimer = null;
    this.awaitedOnDisk.clear();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scheduleManifest(0);
      this.scheduleScan(0);
    }, this.ctx.timings.retryMs);
    this.retryTimer.unref?.();
  }

  /** Downloads (or reuses a cached copy of) a blob and writes it in place. */
  private async placeBlob(entry: ManifestEntry, record: LayoutRecord): Promise<boolean> {
    const hash = entry.blobHash as string;
    let target: string;
    try {
      target = await resolveInside(this.info.root, record.path);
    } catch (error) {
      this.refuse(record.path, error);
      return true;
    }
    // A valid local delivery needs no HTTP round trip. All destination
    // decisions below still use a fresh read after any download has finished.
    // A provider that stalls must not hold the project queue (handoff, takedown, stop wait on it).
    const delivered = await readWithin(target, HYDRATION_WAIT_MS).catch(() => null);
    if (delivered === SLOW_READ) return false;
    const bytes = delivered && sha256(delivered) === hash ? delivered : await this.blobBytes(hash);
    if (!bytes) return false;
    const guard = this.diskGuard();
    const canCommit = guard.canCommit;
    let expected: string | null;
    guard.canCommit = async () => {
      if (!(await canCommit()) || !this.manifestReady()) return false;
      const current = this.readEntries();
      if (current.get(entry.fileId)?.blobHash !== hash || computeLayout(current.values()).paths.get(entry.fileId) !== record.path) return false;
      const disk = await readIfExists(target);
      return (disk === null ? null : sha256(disk)) === expected;
    };
    try {
      // Network waits can outlive an external edit. Observe the destination
      // after downloading, and verify that observation at each disk commit.
      const existing = await readWithin(target, HYDRATION_WAIT_MS);
      if (existing === SLOW_READ) return false;
      const existingHash = existing === null ? null : sha256(existing);
      expected = existingHash;
      const existingStats = await statIfExists(target);
      if (expected === hash) {
        if (!(await guard.canCommit())) return false;
        setMaterialized(record, hash, existingStats?.size, existingStats?.mtimeMs);
        this.baselineMissing.delete(entry.fileId);
        return true;
      }
      if (existingHash !== null && existingHash !== record.hash && !(existingStats && isStaleCopy(record, existingHash, existingStats.mtimeMs))) {
        this.baselineMissing.add(entry.fileId);
        await this.archive(record.path, guard);
        expected = null;
      }
      const stats = await writeFileAtomic(target, bytes, guard);
      setMaterialized(record, hash, stats.size, stats.mtimeMs);
      this.baselineMissing.delete(entry.fileId);
      this.ctx.host.store.putBlob({ hash, localPath: target, size: bytes.byteLength });
      return true;
    } catch (error) {
      // An archive may already have succeeded. Keep the missing-baseline
      // fence until a retry places the current blob, never infer a delete.
      if (!(error instanceof WriteCancelledError)) this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not place ${record.path}`, error);
      return false;
    }
  }

  private async blobBytes(hash: string): Promise<Uint8Array | null> {
    const uploaded = this.uploadedBlobs.get(hash);
    if (uploaded) return uploaded;
    const cached = this.ctx.host.store.getBlob(hash);
    if (cached) {
      const bytes = await readWithin(cached.localPath, HYDRATION_WAIT_MS).catch(() => null);
      if (bytes && bytes !== SLOW_READ && sha256(bytes) === hash) return bytes;
    }
    const api = this.ctx.host.api;
    if (!api) return null;
    try {
      return await api.downloadBlob(this.info.projectId, hash);
    } catch (error) {
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not download blob ${hash}`, error);
      return null;
    }
  }

  /**
   * Moves a file or folder into the notebook's local archive (`_archive`),
   * which is never shared. An album keeps no such copies: a photo removed
   * from the album, or replaced by a member's newer version, is deleted from
   * every member's computer (members keep a photo by saving it to their
   * gallery, which copies it out of the album).
   */
  private async archive(relative: string, guard = this.diskGuard()): Promise<void> {
    let source: string;
    try {
      source = await resolveInside(this.info.root, relative);
    } catch {
      return;
    }
    if (!(await statIfExists(source))) return;
    if (!(await guard.canCommit())) throw new WriteCancelledError();
    if (this.info.album) {
      await fs.rm(source, { recursive: true, force: true });
      return;
    }
    const archiveRoot = path.join(this.info.root, ARCHIVE_DIRECTORY);
    await movePathUnique(source, archiveRoot, path.posix.basename(relative), guard);
  }

  /** Keep the latest CRDT text as well as any distinct on-disk version. */
  private async archiveRemoved(record: LayoutRecord): Promise<void> {
    if (!(await this.rootAvailable())) return;
    const runtime = record.docId ? this.docs.get(record.docId) : undefined;
    if (!runtime || !this.docReady(runtime)) {
      await this.archive(record.path);
      return;
    }
    const text = runtime.hub.getText("content");
    this.retirePath(record.path, [sha256(encodeText(text))]);
    try { await resolveInside(this.info.root, record.path); }
    catch (error) { this.refuse(record.path, error); return; }
    // Write CRDT recovery directly to a new archive path. Never replace the
    // live file during archive IO: an external writer may still be editing it.
    const archiveRoot = path.join(this.info.root, ARCHIVE_DIRECTORY);
    await writeFileUnique(archiveRoot, path.posix.basename(record.path), encodeText(text), this.diskGuard());
    await this.archive(record.path);
    // Writing it back made its folders again if they were deleted with it.
    const inUse = (relative: string) => Object.values(this.state.layout).some((other) => other.path === relative || other.path.startsWith(`${relative}/`));
    await pruneEmptyDirectories(this.info.root, path.posix.dirname(record.path), inUse, this.diskGuard());
  }

  private refuse(relative: string, error: unknown): void {
    if (error instanceof PathRefusedError) {
      if (!this.refusedLogged.has(relative)) {
        this.refusedLogged.add(relative);
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: refused ${error.message}`);
      }
      return;
    }
    this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${relative}`, error);
  }

  private async writeManifest(fn: (files: Y.Map<unknown>, doc: Y.Doc) => void, provenance: Provenance): Promise<void> {
    if (provenance.source === "external-file" && this.follower) throw new WriteCancelledError();
    const hub = this.manifestHub;
    if (!hub) throw new Error("The manifest is not open.");
    hub.applyLocalChange("manifest", (doc) => {
      const files = doc.getMap<unknown>(ManifestKeys.files);
      fn(files, doc);
      // A removed photo takes its details with it; a new one gets a record.
      if (this.info.album) {
        const photos = doc.getMap<unknown>(ManifestKeys.photos);
        for (const fileId of [...photos.keys()]) if (!files.has(fileId)) photos.delete(fileId);
        for (const [fileId, value] of files.entries()) {
          if (photos.has(fileId)) continue;
          const entry = value as Partial<ManifestEntry>;
          const photo: AlbumPhotoRecord = { fileId, addedBy: entry.createdBy ?? "", updatedAt: entry.createdAt ?? Date.now() };
          if (photo.addedBy) photos.set(fileId, { ...photo });
        }
      }
    }, provenance);
    this.entries = this.readEntries();
  }

  // ------------------------------------------------------------ albums

  /** The manifest's entries; in an album, only the photos an album can hold. */
  private readEntries(): Map<string, ManifestEntry> {
    const entries = readManifest(this.manifestDoc());
    if (!this.info.album) return entries;
    for (const [fileId, entry] of entries) {
      const problem = entry.kind === "blob" ? albumPathError(entry.path) : "Albums hold photos only.";
      if (!problem) continue;
      entries.delete(fileId);
      if (!this.refusedLogged.has(fileId)) {
        this.refusedLogged.add(fileId);
        this.ctx.logger.warn(`Shared album ${this.info.notebook}: not writing "${entry.path}": ${problem}`);
      }
    }
    return entries;
  }

  /** The folder as the watcher sees it: in an album, top-level photos only. */
  private async walk(): Promise<NotebookWalk> {
    const walked = await walkNotebook(this.info.root);
    if (this.info.album) walked.entries = walked.entries.filter((entry) => entry.kind === "file" && !entry.relative.includes("/") && albumImageType(entry.relative) !== null);
    return walked;
  }

  /** Whether photos keep their location and camera details (an album setting). */
  private keepsLocation(): boolean {
    return this.manifestHub?.getDoc("manifest").getMap<unknown>(ManifestKeys.settings).get(AlbumSettingKeys.keepLocation) === true;
  }

  /**
   * In an album that removes location details: rewrites the photo without
   * them before it is uploaded, and returns the bytes now on disk (null:
   * nothing to remove).
   */
  private async stripForUpload(absolute: string, relative: string, bytes: Uint8Array): Promise<{ bytes: Uint8Array; size: number; mtimeMs: number } | null> {
    if (!this.info.album || this.keepsLocation()) return null;
    const stripped = stripPhotoMetadata(bytes, albumImageType(relative) ?? "");
    if (!stripped) return null;
    const stats = await writeFileAtomic(absolute, stripped, this.diskGuard());
    return { bytes: stripped, size: stats.size, mtimeMs: stats.mtimeMs };
  }

  /**
   * A photo's bytes were replaced (edited here, or by another program). The
   * unedited photo stays on the server as its originalHash; putting the
   * original back clears the edit.
   */
  private photoReplaced(doc: Y.Doc, fileId: string, before: string | undefined, after: string, accountId: string, now: number): void {
    const photos = doc.getMap<unknown>(ManifestKeys.photos);
    const current = (photos.get(fileId) ?? { fileId, addedBy: accountId, updatedAt: now }) as AlbumPhotoRecord;
    const original = current.originalHash ?? before;
    const next: AlbumPhotoRecord = { ...current, updatedBy: accountId, updatedAt: now };
    if (original && original !== after) next.originalHash = original;
    else {
      delete next.originalHash;
      delete next.edits;
    }
    photos.set(fileId, JSON.parse(JSON.stringify(next)));
  }

  // ------------------------------------------------------------ live PDFs

  private pdfComments(): PdfCommentService {
    return new PdfCommentService(this.ctx.host, () => this.ctx.host.accountId ?? "");
  }

  /** Turns live PDFs on for everyone. One way: marks would otherwise be stranded in the document. */
  enablePdfLive(): Promise<void> {
    return this.enqueueExplicit(async () => {
      if (this.info.album) throw new ControlError(400, "bad-request", "Albums have no PDFs.");
      if (this.info.role !== "owner") throw new ControlError(403, "forbidden", "Only the notebook's owner can turn on live PDFs.");
      if (!this.manifestReady()) throw new ControlError(503, "offline", "The notebook's file list has not loaded yet.");
      const version = await this.ctx.host.api?.version();
      if (!version?.livePdfs) throw new ControlError(409, "update-required", "Update the collaboration server before turning on live PDFs.");
      await this.writeManifest((_files, doc) => doc.getMap<unknown>(ManifestKeys.settings).set(PDF_LIVE_SETTING, true), { source: "typing" });
      this.ctx.emit({ t: "project-changed", projectId: this.info.projectId });
    });
  }

  /** Tells the album's other members about new photos; nothing is retried. */
  private reportAddedPhotos(fileIds: string[]): void {
    const api = this.ctx.host.api;
    if (!api) return;
    void api.albumActivity(this.info.projectId, { added: fileIds.length, fileIds: fileIds.slice(0, 50) }).catch((error: unknown) => {
      this.ctx.logger.warn(`Shared album ${this.info.notebook}: could not announce new photos`, error);
    });
  }

  // ------------------------------------------------------------ documents

  private ensureDoc(docId: string, fileId: string): void {
    const existing = this.docs.get(docId);
    if (existing) {
      existing.fileId = fileId;
      return;
    }
    const hub = this.ctx.host.acquire(docId, { kind: "file", projectId: this.info.projectId });
    const runtime: DocRuntime = { docId, fileId, hub, unsubscribe: [], writeTimer: null, pendingSince: null, rebuilt: false, wasReady: false };
    this.docs.set(docId, runtime);
    runtime.unsubscribe.push(
      hub.observe("content", (change) => {
        if (change.origin === "rebuilt") {
          runtime.rebuilt = true;
          return;
        }
        if (change.origin === "server") runtime.rebuilt = false;
        this.scheduleWrite(runtime);
      }),
      hub.onStatus(() => {
        if (!runtime.wasReady && this.docReady(runtime)) this.scheduleWrite(runtime);
      }),
      hub.onMeta((meta) => this.metaChanged(meta.role, meta.readOnlyReason)),
    );
    if (this.docReady(runtime)) this.scheduleWrite(runtime);
  }

  private releaseDoc(docId: string): void {
    const runtime = this.docs.get(docId);
    if (!runtime) return;
    this.docs.delete(docId);
    if (runtime.writeTimer) clearTimeout(runtime.writeTimer);
    for (const unsubscribe of runtime.unsubscribe) unsubscribe();
    this.ctx.host.release(docId);
  }

  private docReady(runtime: DocRuntime): boolean {
    if (runtime.rebuilt || runtime.hub.isClosed) return false;
    const ready = hubHasState(this.ctx.host, runtime.hub, "content");
    if (ready) runtime.wasReady = true;
    return ready;
  }

  private scheduleWrite(runtime: DocRuntime): void {
    if (this.stopped || this.follower) return;
    if (runtime.writeTimer) clearTimeout(runtime.writeTimer);
    const now = Date.now();
    runtime.pendingSince ??= now;
    const untilMaxWait = runtime.pendingSince + this.ctx.timings.writeMaxWaitMs - now;
    runtime.writeTimer = setTimeout(() => {
      runtime.writeTimer = null;
      runtime.pendingSince = null;
      void this.enqueue(() => this.materializeDoc(runtime.docId));
    }, Math.max(0, Math.min(this.ctx.timings.writeDebounceMs, untilMaxWait)));
    runtime.writeTimer.unref?.();
  }

  private recordFor(docId: string): { fileId: string; record: LayoutRecord } | null {
    const runtime = this.docs.get(docId);
    if (!runtime) return null;
    const record = this.state.layout[runtime.fileId];
    return record && record.docId === docId ? { fileId: runtime.fileId, record } : null;
  }

  /** Writes a document's text to its file, unless the file holds an edit not yet taken in. */
  private async materializeDoc(docId: string): Promise<void> {
    if (this.follower) return;
    if (!(await this.rootAvailable())) {
      this.scheduleRetry();
      return;
    }
    const runtime = this.docs.get(docId);
    const found = this.recordFor(docId);
    if (!runtime || !found || this.reconciliationFor(docId) || !this.docReady(runtime)) return;
    const { fileId, record } = found;
    let target: string;
    try {
      target = await resolveInside(this.info.root, record.path);
    } catch (error) {
      this.refuse(record.path, error);
      return;
    }
    const text = runtime.hub.getText("content");
    const hash = sha256(encodeText(text));
    const disk = await readWithin(target, HYDRATION_WAIT_MS);
    if (disk === SLOW_READ) { this.scheduleRetry(); return; }
    let expected = disk === null ? null : sha256(disk);
    if (disk) {
      const diskHash = sha256(disk);
      if (record.hash && diskHash !== record.hash) {
        // Someone edited the file since our last write; merge that first.
        await this.takeExternalEdit(runtime, record, disk, diskHash);
        return;
      }
      if (diskHash === hash) {
        await this.adopt(fileId, record, hash, text, target);
        return;
      }
      if (!record.hash) {
        try { await this.archive(record.path, contentGuard(target, expected, this.diskGuard())); }
        catch (error) {
          if (!(error instanceof WriteCancelledError)) throw error;
          this.scheduleScan(0); this.scheduleRetry(); return;
        }
        expected = null;
      }
    } else if (record.hash && !this.baselineMissing.has(fileId)) {
      // A provider absence may be a rename in progress. Let the next complete
      // scan pair it with a new path or recover it from shared authority.
      if (!this.missingSince.has(fileId)) this.missingSince.set(fileId, Date.now());
      this.scheduleScan(this.ctx.timings.settleMs);
      return;
    }
    if (!(await this.writeDoc(runtime, record, target, text, expected))) return;
    // A collaborator's new document exists on disk only now; the tree-changed
    // sent when its manifest entry arrived came before the file did.
    if (!disk) {
      this.ctx.emit({ t: "tree-changed", projectId: this.info.projectId, notebook: this.info.notebook, added: [this.liberaPath(record.path)], moves: [], removed: [] });
    }
  }

  /** Writes `text` as the document's file and records it as materialized. */
  private async writeDoc(runtime: DocRuntime, record: LayoutRecord, target: string, text: string, expected: string | null): Promise<boolean> {
    const bytes = encodeText(text);
    const hash = sha256(bytes);
    const base = this.diskGuard();
    const canCommit = base.canCommit;
    base.canCommit = async () => {
      if (!(await canCommit()) || !this.manifestReady()) return false;
      const current = this.readEntries();
      return current.get(runtime.fileId)?.docId === runtime.docId && computeLayout(current.values()).paths.get(runtime.fileId) === record.path;
    };
    let stats;
    try { stats = await writeFileAtomic(target, bytes, contentGuard(target, expected, base)); }
    catch (error) {
      if (!(error instanceof WriteCancelledError)) throw error;
      this.scheduleScan(0); this.scheduleRetry(); return false;
    }
    setMaterialized(record, hash, stats.size, stats.mtimeMs);
    await this.writeBaseOrRetry(record, runtime.docId, text);
    this.baselineMissing.delete(runtime.fileId);
    this.ctx.host.store.upsertDoc({ docId: runtime.docId, projectId: this.info.projectId, fileId: runtime.fileId, path: record.path, materializedHash: hash });
    this.saveSoon();
    this.filesChanged([record.path]);
    return true;
  }

  /**
   * Writes the merge base. A busy base file is no longer overwritten in place;
   * the record is left unmaterialized so the next pass adopts the (identical)
   * file again and rewrites the base from the shared text.
   */
  private async writeBaseOrRetry(record: LayoutRecord, docId: string, text: string): Promise<void> {
    try { await writeBase(this.info.root, docId, text, this.diskGuard()); }
    catch (error) {
      if (!(error instanceof FileBusyError)) throw error;
      record.hash = undefined;
      this.scheduleRetry();
    }
  }

  /** Records bytes already on disk as the materialized state of a document. */
  private async adopt(fileId: string, record: LayoutRecord, hash: string, text: string, target: string): Promise<void> {
    const stats = await statIfExists(target);
    if (stats?.isFile()) this.baselineMissing.delete(fileId);
    const changed = record.hash !== hash;
    setMaterialized(record, hash, stats?.size, stats?.mtimeMs);
    if (record.docId) {
      if (changed) await this.writeBaseOrRetry(record, record.docId, text);
      this.ctx.host.store.upsertDoc({ docId: record.docId, projectId: this.info.projectId, fileId, path: record.path, materializedHash: hash });
    }
    this.saveSoon();
  }

  /**
   * A text file changed on disk. If the shared text is still what we last
   * wrote, the disk edit becomes minimal CRDT edits by the local user.
   * Otherwise both sides moved: open a reconciliation and touch neither.
   */
  private async takeExternalEdit(runtime: DocRuntime, record: LayoutRecord, disk: Uint8Array, diskHash: string): Promise<void> {
    if (this.follower || !this.docReady(runtime)) return;
    const target = await resolveInside(this.info.root, record.path);
    const shared = runtime.hub.getText("content");
    const diskStats = await statIfExists(target);
    if (diskStats && isStaleCopy(record, diskHash, diskStats.mtimeMs)) {
      // An older version we wrote came back (a sync client restoring or
      // delivering a stale copy). Taking it in would undo newer edits.
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} was replaced by an older copy; the current text was written again.`);
      await this.writeDoc(runtime, record, target, shared, diskHash);
      return;
    }
    if (!this.canEdit) {
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} changed on disk, but this role cannot edit; the change stays local.`);
      return;
    }
    const diskText = decodeText(disk);
    if (diskText === null) {
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} is no longer UTF-8 text; it was not synced.`);
      return;
    }
    const fileId = runtime.fileId;
    if (shared === diskText) {
      await this.adopt(fileId, record, diskHash, diskText, target);
      return;
    }
    if (!this.follower && !(diskStats && isUncertainCopy(record, diskHash, diskStats.mtimeMs)) && sha256(encodeText(shared)) === record.hash) {
      this.applyText(runtime.hub, shared, diskText, EXTERNAL);
      await this.adopt(fileId, record, diskHash, diskText, target);
      this.filesChanged([record.path]);
      return;
    }
    const existing = this.reconciliationFor(runtime.docId);
    const reconciliation: Reconciliation = {
      id: existing?.id ?? randomId("rec"),
      docId: runtime.docId,
      path: this.liberaPath(record.path),
      shared,
      disk: diskText,
      base: (await readBase(this.info.root, runtime.docId)) ?? "",
      detectedAt: existing?.detectedAt ?? Date.now(),
    };
    this.state.reconciliations = [...this.state.reconciliations.filter((item) => item.docId !== runtime.docId), reconciliation];
    // Remember the disk state so later scans do not re-detect the same edit.
    const stats = await statIfExists(target);
    Object.assign(record, { size: stats?.size, mtimeMs: stats?.mtimeMs });
    this.saveSoon();
    this.ctx.emit({ t: "reconcile-needed", reconciliation });
    this.ctx.emit({ t: "project-changed", projectId: this.info.projectId });
  }

  /** Applies the minimal edits from `from` (the current shared text) to `to`. */
  private applyText(hub: DocHub, from: string, to: string, provenance: Provenance): void {
    const edits = diffText(from, to);
    if (edits.length === 0) return;
    hub.applyLocalChange(
      "content",
      (doc) => {
        const text = doc.getText(ContentKeys.source);
        if (text.toString() !== from) throw new Error("The shared text changed while edits were computed.");
        for (let index = edits.length - 1; index >= 0; index -= 1) {
          const edit = edits[index];
          if (edit.end > edit.start) text.delete(edit.start, edit.end - edit.start);
          if (edit.text) text.insert(edit.start, edit.text);
        }
      },
      provenance,
    );
  }

  // ------------------------------------------------------------ reconciliations

  private reconciliationFor(docId: string): Reconciliation | undefined {
    return this.state.reconciliations.find((item) => item.docId === docId);
  }

  private dropReconciliations(docId: string): void {
    this.state.reconciliations = this.state.reconciliations.filter((item) => item.docId !== docId);
  }

  /** The fence that stops files dropped into the notebook from being shared automatically, and why (DL-6). */
  get externalAdoption(): { required: boolean; reason?: string } {
    return this.state.externalAdoptionRequired ? { required: true, reason: this.state.externalAdoptionReason ?? "recorded" } : { required: false };
  }

  /** The user reviewed the unexplained files: clear the fence so the next scan may share them. */
  adoptExternal(): Promise<void> {
    if (this.follower) return Promise.reject(new ControlError(409, "read-only", "Only the device that writes this notebook's files can adopt external files."));
    return this.enqueueExplicit(async () => {
      this.ctx.host.store.clearExternalAdoption(this.info.projectId);
      delete this.state.externalAdoptionRequired;
      delete this.state.externalAdoptionReason;
      if (await this.rootAvailable()) await writeState(this.info.root, this.state, this.diskGuard());
      this.scheduleScan(0);
    });
  }

  get reconcilePending(): number {
    return this.state.reconciliations.length;
  }

  /** Open reconciliations with the current shared and disk text. */
  async reconciliations(): Promise<Reconciliation[]> {
    const result: Reconciliation[] = [];
    for (const item of this.state.reconciliations) {
      const runtime = this.docs.get(item.docId);
      const found = this.recordFor(item.docId);
      let disk = item.disk;
      if (found) {
        const bytes = await readIfExists(await resolveInside(this.info.root, found.record.path)).catch(() => null);
        if (bytes) disk = decodeText(bytes) ?? disk;
      }
      result.push({
        ...item,
        // The file may have been renamed since; report where it is now.
        path: found ? this.liberaPath(found.record.path) : item.path,
        shared: runtime ? runtime.hub.getText("content") : item.shared,
        disk,
      });
    }
    return result;
  }

  hasReconciliation(id: string): boolean {
    return this.state.reconciliations.some((item) => item.id === id);
  }

  /** Keeps `text`: applied to the shared document as the user's edits, then written to disk. */
  resolveReconciliation(id: string, text: string, reviewed?: { shared: string; disk: string }): Promise<{ docId: string; text: string }> {
    return this.enqueueExplicit(async () => {
      const item = this.state.reconciliations.find((candidate) => candidate.id === id);
      if (!item) throw new ControlError(404, "not-found", "No such reconciliation.");
      if (!this.canEdit) throw new ControlError(403, "forbidden", "Your role cannot edit this notebook.");
      const runtime = this.docs.get(item.docId);
      const found = this.recordFor(item.docId);
      if (!runtime || !found) throw new ControlError(409, "conflict", "The document is no longer in this notebook.");
      const target = await resolveInside(this.info.root, found.record.path);
      const observed = await readIfExists(target);
      const shared = runtime.hub.getText("content");
      if (!reviewed || typeof reviewed.shared !== "string" || typeof reviewed.disk !== "string" ||
          shared !== reviewed.shared || observed === null || decodeText(observed) !== reviewed.disk) {
        throw new ControlError(409, "conflict", "The shared text or disk changed since this merge was opened. Reload and review both versions.");
      }
      this.applyText(runtime.hub, shared, text, { source: "reconcile" });
      if (!(await this.writeDoc(runtime, found.record, target, text, observed === null ? null : sha256(observed)))) {
        throw new ControlError(409, "conflict", "The disk changed during the merge. The merged shared text is saved; review the new disk version.");
      }
      this.dropReconciliations(item.docId);
      this.saveSoon();
      this.ctx.emit({ t: "project-changed", projectId: this.info.projectId });
      this.filesChanged([found.record.path]);
      // The shared text may have moved on while the user merged; write it next.
      this.scheduleWrite(runtime);
      return { docId: item.docId, text: runtime.hub.getText("content") };
    });
  }

  // ------------------------------------------------------------ watcher

  private startWatching(): void {
    try {
      this.watcher = watch(this.info.root, { recursive: true }, (_event, name) => {
        const relative = typeof name === "string" ? name.split(path.sep).join("/") : "";
        if (relative && isExcludedPath(relative)) return;
        if (relative) {
          this.dirtyPaths.add(relative);
          this.noteReported(relative);
        } else this.verifyAll = true;
        this.scheduleScan(this.ctx.timings.settleMs);
      });
      this.watcher.on("error", (error) => {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: file watching stopped; polling only`, error);
        this.watcher?.close();
        this.watcher = null;
        this.forgetWatchHistory();
        this.retimePoll();
      });
      // fs.watch on a network share reports what this computer does, not
      // what other computers write there. Mapped drive letters and mounted
      // shares are not recognized here; the missed-event check covers them.
      this.watcherTrusted = !onWindowsNetworkShare(this.info.root);
    } catch (error) {
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: file watching unavailable; polling only`, error);
    }
    // The poll is the safety net: fs.watch misses events on ExFAT, network
    // shares and after sleep. Bounded verification also catches preserved stats.
    this.schedulePoll();
    this.scheduleScan(0);
  }

  /**
   * How long until the next safety-net scan. While fs.watch has seen every
   * change, the poll only guards against it failing silently, so it can be
   * slow; on battery, slower still.
   */
  private pollInterval(): number {
    const { pollMs, watchedPollMs } = this.ctx.timings;
    return (this.watcher && this.watcherTrusted ? watchedPollMs : pollMs) * this.powerScale();
  }

  private powerScale(): number {
    return this.ctx.onBattery?.() ? Math.max(1, this.ctx.timings.batteryScale) : 1;
  }

  /** Starts a full poll wait from now; it keeps running while the project does (a follower's scans return early). */
  private schedulePoll(): void {
    this.pollArmedAt = performance.now();
    this.armPoll(this.pollInterval());
  }

  /**
   * The interval changed (power source, watcher state): the deadline counts
   * from when the current wait began, so a run of changes (a loose charger)
   * can never keep pushing the safety-net scan back.
   */
  private retimePoll(): void {
    if (this.pollTimer) this.armPoll(Math.max(0, this.pollArmedAt + this.pollInterval() - performance.now()));
  }

  private armPoll(delay: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.scheduleScan(0);
      this.schedulePoll();
    }, delay);
    this.pollTimer.unref?.();
  }

  /** The power source changed. */
  powerChanged(): void {
    this.retimePoll();
  }

  /** The computer woke up: what changed while it slept may have no watcher event. */
  resumed(): void {
    if (this.pollTimer) this.scheduleScan(0);
  }

  /** The service renewed this writer's lease: a scan refused while it had lapsed runs now. */
  leaseConfirmed(): void {
    if (!this.scanDeferred) return;
    this.scanDeferred = false;
    this.scheduleScan(0);
  }

  private noteReported(relative: string): void {
    if (!this.watcherTrusted) return;
    let key = manifestPathKey(relative);
    // Bounded while scans cannot complete (manifest not ready): further
    // paths count for their top-level entry, coarser but never dropped.
    if (!this.reportedAt.has(key) && this.reportedAt.size >= MAX_REPORTED_PATHS) key = manifestPathKey(relative.split("/")[0]);
    this.reportedAt.set(key, performance.now());
  }

  /** Whether fs.watch reported `relative` or a folder above it at or after `since`. */
  private reportedSince(relative: string, since: number): boolean {
    const segments = relative.split("/");
    for (let length = segments.length; length > 0; length -= 1) {
      const at = this.reportedAt.get(manifestPathKey(segments.slice(0, length).join("/")));
      if (at !== undefined && at >= since) return true;
    }
    return false;
  }

  /** The detector can no longer decide anything (no watcher, or it already missed a change). */
  private forgetWatchHistory(): void {
    this.watchBaseline = null;
    this.reportedAt.clear();
  }

  /**
   * A heuristic for fs.watch failing silently (a network share, ExFAT, a
   * stream broken by sleep): a file whose stats changed between complete
   * walks, or that appeared, with no event for it or a folder above it for
   * watchGraceMs of this host's own clock. The poll then goes back to
   * pollMs for the rest of the session.
   *
   * It cannot see misses that leave every stat equal, deletions (absence
   * has no time to judge an event's lateness by), or folders without files;
   * the poll's interval bounds how long those wait. Generated build output
   * is not judged: it is not imported either.
   */
  private noticeMissedEvents(files: Map<string, WalkEntry>, verifyAll: boolean, startedAt: number): void {
    if (!this.watcher || !this.watcherTrusted) {
      this.forgetWatchHistory();
      return;
    }
    const previous = verifyAll ? null : this.watchBaseline;
    const next = new Map<string, { entry: WalkEntry | null; since: number; unexplainedAt?: number }>();
    const now = performance.now();
    let missed: string | null = null;
    let oldestNeeded = startedAt;
    for (const [relative, entry] of files) {
      const key = manifestPathKey(relative);
      const before = previous?.get(key);
      const since = before?.since ?? this.watchBaselineAt;
      const accounted = !previous || isGeneratedPath(relative) ||
        (before?.entry && before.entry.size === entry.size && before.entry.mtimeMs === entry.mtimeMs && before.entry.ctimeMs === entry.ctimeMs) ||
        this.reportedSince(relative, since);
      if (accounted) {
        // Only events after this walk began can explain the next change.
        next.set(key, { entry, since: startedAt });
        continue;
      }
      // An event can lag the change: keep this path's old baseline and
      // events, and judge it once it has stayed unexplained for the grace.
      const unexplainedAt = before?.unexplainedAt ?? now;
      if (now - unexplainedAt >= this.ctx.timings.watchGraceMs) {
        missed ??= relative;
        continue;
      }
      next.set(key, { entry: before?.entry ?? null, since, unexplainedAt });
      oldestNeeded = Math.min(oldestNeeded, since);
    }
    if (missed) {
      this.watcherTrusted = false;
      this.forgetWatchHistory();
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${missed} changed without a file-watch event; checking the folder every ${Math.round(this.pollInterval() / 1000)} s`);
      this.retimePoll();
      return;
    }
    this.watchBaseline = next;
    this.watchBaselineAt = startedAt;
    for (const [key, at] of this.reportedAt) if (at < oldestNeeded) this.reportedAt.delete(key);
    // Judge what is waiting for its event soon, not at the next poll.
    if (oldestNeeded < startedAt) this.scheduleScan(this.ctx.timings.watchGraceMs);
  }

  /**
   * Arms the next scan. `delay` 0 (poll, resume, retry) runs it as soon as
   * possible, and later watcher events cannot postpone it. A positive delay
   * debounces watcher events: each moves the scan to `delay` after itself,
   * but no further than SCAN_MAX_WAIT_MS after the first, so a long burst
   * (a build, a big copy) still gets scanned.
   */
  private scheduleScan(delay: number): void {
    if (this.stopped) return;
    if (this.follower) {
      // A lapsed lease of a writer: run it once the lease is confirmed.
      if (!this.info.follower) this.scanDeferred = true;
      return;
    }
    const now = performance.now();
    let due = now + delay;
    if (this.scanTimer) {
      if (delay === 0 ? this.scanDueAt <= due : this.scanForced) return;
      if (delay > 0) due = Math.min(due, this.scanFirstAt + SCAN_MAX_WAIT_MS);
      clearTimeout(this.scanTimer);
    } else {
      this.scanFirstAt = now;
    }
    // A debounce never replaces a forced scan (returned above), so this is the armed scan's kind.
    this.scanForced = delay === 0;
    this.scanDueAt = due;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scanForced = false;
      // One queued scan at a time: it starts later and sees what came since.
      if (this.scanQueued) return;
      this.scanQueued = true;
      void this.enqueue(async () => {
        this.scanQueued = false;
        await this.scan();
      });
    }, Math.max(0, due - now));
    this.scanTimer.unref?.();
  }

  /** Turns differences between the folder and the layout into document edits and manifest operations. */
  private async scan(): Promise<void> {
    if (!this.manifestReady() || this.follower) { this.missingSince.clear(); return; }
    if (!(await this.rootAvailable())) {
      this.missingSince.clear();
      return;
    }
    const walkStartedAt = performance.now();
    const walked = await this.walk();
    if (!walked.complete) {
      // Neither a cap nor repeated partial subtree coverage establishes a
      // deletion. Restart the grace period after a complete observation.
      this.missingSince.clear();
      this.scheduleRetry();
      return;
    }
    // The folder can disappear while the asynchronous walk is running.
    if (!(await this.rootAvailable())) {
      this.missingSince.clear();
      return;
    }
    const previous = structuredClone(this.state.layout);
    const files = new Map<string, WalkEntry>();
    const directories = new Map<string, WalkEntry>();
    for (const entry of walked.entries) (entry.kind === "file" ? files : directories).set(entry.relative, entry);
    const skipped = new Set(walked.skipped);
    // Compared as manifest keys: fs.watch can spell a name differently
    // (Unicode normalization, case) from the walk on the same volume.
    const dirty = new Set([...this.dirtyPaths].map(manifestPathKey));
    this.dirtyPaths = new Set();
    const verifyAll = this.verifyAll;
    this.verifyAll = false;
    this.noticeMissedEvents(files, verifyAll, walkStartedAt);
    const known = new Set([...Object.values(this.state.layout), ...this.readEntries().values()].map((record) => record.path));
    // Parents of known entries are known too: a folder implied by "a/b.md"
    // must not become a new folder entry on every machine that sees it.
    for (const relative of [...known]) {
      const segments = relative.split("/");
      for (let index = 1; index < segments.length; index += 1) known.add(segments.slice(0, index).join("/"));
    }
    const now = Date.now();
    const missing: string[] = [];
    const operations: Array<(files: Y.Map<unknown>, doc: Y.Doc) => void> = [];
    /** Photos this pass adds to an album (its other members hear about them). */
    const addedPhotos: string[] = [];
    const touched = new Set<string>();
    const accountId = this.canEdit ? await this.ctx.accountId().catch(() => "") : "";
    let needsRetry = false;

    for (const [fileId, record] of Object.entries(this.state.layout)) {
      if ([...skipped].some((item) => record.path === item || record.path.startsWith(`${item}/`))) {
        this.missingSince.delete(fileId);
        continue;
      }
      if (record.kind === "folder") {
        if (directories.has(record.path)) this.missingSince.delete(fileId);
        else missing.push(fileId);
        continue;
      }
      const seen = files.get(record.path);
      if (!seen) {
        if (record.hash && !this.baselineMissing.has(fileId)) missing.push(fileId);
        continue;
      }
      this.missingSince.delete(fileId);
      // Finder is replacing this file: its bytes are not the new version yet.
      if (isFinderCopy(seen)) continue;
      // Stat equality is an optimization, never permanent proof of equality:
      // every verification has a finite age (verificationAge).
      // A file written in the last 3 s may change again within one timestamp
      // step. An mtime in the future (a copy from a skewed clock) says nothing
      // about that, and would force a read at every scan; this machine's ctime does.
      const settled = seen.mtimeMs > now + 3000 && seen.ctimeMs !== undefined ? now - seen.ctimeMs > 3000 : now - seen.mtimeMs > 3000;
      const verification = this.verified.get(fileId);
      const touchedByWatch = underAny(dirty, manifestPathKey(record.path));
      const sameStats = record.size === seen.size && record.mtimeMs === seen.mtimeMs && verification !== undefined && verification.ctimeMs === seen.ctimeMs;
      const verificationCurrent = verification !== undefined && performance.now() - verification.at < this.verificationAge(fileId, seen.size, verification.pending === true);
      if (!record.hash || (!verifyAll && !touchedByWatch && settled && sameStats && verificationCurrent)) continue;
      // An online-only placeholder with this host's size and mtime holds no
      // local bytes that could have changed; reading it to verify would
      // download it (and every other one, at each verification).
      if (seen.dataless && record.size === seen.size && record.mtimeMs === seen.mtimeMs) {
        this.verified.set(fileId, { ctimeMs: seen.ctimeMs, at: performance.now() });
        continue;
      }
      const absolute = await resolveInside(this.info.root, record.path).catch(() => null);
      const read = absolute ? await readWithin(absolute, HYDRATION_WAIT_MS) : null;
      if (read === SLOW_READ) {
        needsRetry = true;
        continue;
      }
      let bytes: Uint8Array | null = read;
      if (!bytes || !absolute) continue;
      // Pending until what it found is handled; see settleVerification.
      this.verified.set(fileId, { ctimeMs: seen.ctimeMs, at: performance.now(), pending: true });
      let hash = sha256(bytes);
      if (hash !== record.hash && record.kind === "blob" && this.canEdit) {
        const stripped = await this.stripForUpload(absolute, record.path, bytes).catch(() => null);
        if (stripped) {
          bytes = stripped.bytes;
          hash = sha256(bytes);
          Object.assign(seen, { size: stripped.size, mtimeMs: stripped.mtimeMs });
        }
      }
      if (hash === record.hash) {
        this.baselineMissing.delete(fileId);
        this.settleVerification(fileId);
        // A verification that found nothing new must not rewrite state.json.
        if (record.size !== seen.size || record.mtimeMs !== seen.mtimeMs) {
          Object.assign(record, { size: seen.size, mtimeMs: seen.mtimeMs });
          this.saveSoon();
        }
        continue;
      }
      if (record.kind === "doc" && record.docId) {
        const runtime = this.docs.get(record.docId);
        if (runtime && !this.reconciliationFor(record.docId)) await this.takeExternalEdit(runtime, record, bytes, hash);
        // Handled: taken in, waiting on the user (a reconciliation), or kept
        // local for good (this role cannot edit, or it is not text). A
        // document not ready yet, or a failed rewrite, stays pending.
        if (record.hash === hash || this.reconciliationFor(record.docId) || !this.canEdit || decodeText(bytes) === null) this.settleVerification(fileId);
        continue;
      }
      const entry = this.entries.get(fileId);
      // An empty record has no older version to protect: copies keep their
      // source's old mtime, so the bytes filling it are not an old copy.
      if (entry?.blobHash === record.hash && record.size !== 0 && (isStaleCopy(record, hash, seen.mtimeMs) || isUncertainCopy(record, hash, seen.mtimeMs))) {
        // An older version we wrote came back; put the current one back.
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} was replaced by an older copy; the current file was written again.`);
        if (await this.placeBlob(entry, record)) touched.add(record.path);
        else needsRetry = true;
        continue;
      }
      // A replaced binary: a new blob and a manifest update. A viewer's
      // replacement stays local for good, so it is handled.
      if (!this.canEdit) {
        this.settleVerification(fileId);
        continue;
      }
      const api = this.ctx.host.api;
      if (!api || !entry) continue;
      try {
        await api.uploadBlob(this.info.projectId, bytes, entry.mime ?? mimeForPath(record.path));
      } catch (error) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not upload ${record.path}`, error);
        needsRetry = true;
        continue;
      }
      operations.push((map, doc) => {
        const current = readManifest(doc).get(fileId);
        if (!current || current.kind !== "blob" || current.blobHash !== entry.blobHash) return;
        const updated: ManifestEntry = { ...current, blobHash: hash, size: bytes.byteLength, updatedAt: now };
        map.set(fileId, entryRecord(updated));
        if (this.info.album) this.photoReplaced(doc, fileId, entry.blobHash, hash, accountId, now);
        setMaterialized(record, hash, seen.size, seen.mtimeMs);
        this.settleVerification(fileId);
        this.ctx.host.store.putBlob({ hash, localPath: absolute, size: bytes.byteLength });
        touched.add(record.path);
      });
    }

    // Other roles cannot change the manifest; their local changes stay local.
    if (!this.canEdit) return;

    // New files and folders the layout does not know.
    const fresh: Array<{ entry: WalkEntry; bytes: Uint8Array; hash: string }> = [];
    for (const [relative, entry] of files) {
      if (known.has(relative)) continue;
      // An external LaTeX build's products would be uploaded again at every compile.
      if (isGeneratedPath(relative)) continue;
      // An open SQLite database (sidecar beside it) cannot be copied consistently.
      if (isActiveSqliteDatabase(this.info.root, relative)) continue;
      // A fresh device without bookkeeping cannot distinguish a new file
      // from a delayed copy of a deleted identity. Explicit file operations
      // remain available; leave unexplained disk bytes untouched.
      // Judge a file only once it has arrived; the poll comes back to it.
      if (mayStillBeCopying(entry, now)) continue;
      const absolute = await resolveInside(this.info.root, relative).catch(() => null);
      const read = absolute ? await readWithin(absolute, HYDRATION_WAIT_MS) : null;
      if (read === SLOW_READ) {
        needsRetry = true;
        continue;
      }
      const bytes = read;
      if (!bytes) continue;
      const hash = sha256(bytes);
      const conflictOf = this.isLateCopy(relative, hash, entry.mtimeMs) ? null : this.conflictCopyOf(relative, hash);
      if (this.isLateCopy(relative, hash, entry.mtimeMs) || conflictOf) {
        const guard = this.diskGuard();
        const canCommit = guard.canCommit;
        guard.canCommit = async () => await canCommit() && this.pathFree(this.manifestDoc(), relative);
        await this.archive(relative, guard);
        this.reportArchived(relative, conflictOf ? "conflict-copy" : "removed");
        touched.add(relative);
        continue;
      }
      fresh.push({ entry, bytes, hash });
    }

    // Delete + create of the same bytes is a rename (or a move).
    for (const fileId of [...missing]) {
      const record = this.state.layout[fileId];
      if (record.kind === "folder" || !record.hash) continue;
      const index = fresh.findIndex((candidate) => candidate.hash === record.hash && compatibleKind(record, candidate.entry.relative));
      if (index < 0) continue;
      const [match] = fresh.splice(index, 1);
      missing.splice(missing.indexOf(fileId), 1);
      this.missingSince.delete(fileId);
      const entry = this.entries.get(fileId);
      if (!this.canEdit || !entry) continue;
      touched.add(record.path).add(match.entry.relative);
      operations.push((map, doc) => {
        const current = readManifest(doc).get(fileId);
        if (!current || current.kind !== entry.kind || current.docId !== entry.docId || current.path !== entry.path) {
          // Keep an uncommitted local alias from becoming a fresh file on
          // the next scan after the authoritative deletion/move is applied.
          this.retirePath(match.entry.relative, [match.hash]);
          return;
        }
        if (!this.pathFree(doc, match.entry.relative, fileId)) return;
        map.set(fileId, entryRecord({ ...current, path: match.entry.relative, updatedAt: now }));
        // Its ink moves with it; the disk follows the manifest, as for any rename.
        for (const ink of this.inkCompanionMoves(doc, record.path, match.entry.relative, false, now)) map.set(ink.fileId, entryRecord(ink));
        this.retirePath(record.path, knownHashes(record));
        Object.assign(record, { path: match.entry.relative, size: match.entry.size, mtimeMs: match.entry.mtimeMs });
        if (record.docId) this.ctx.host.store.upsertDoc({ docId: record.docId, projectId: this.info.projectId, fileId, path: record.path, materializedHash: record.hash ?? null });
      });
    }

    // Absence has no causality: a provider can deliver a deletion days after
    // a restore. Only explicit host delete operations remove shared entries.
    // Retain the manifest and recover the working copy on the next pass.
    for (const fileId of missing) {
      this.baselineMissing.add(fileId);
      this.missingSince.delete(fileId);
    }
    if (missing.length > 0) this.scheduleManifest(0);
    if (this.canEdit) {
      for (const candidate of fresh) {
        if (this.state.externalAdoptionRequired) continue;
        const created = await this.createFromDisk(candidate.entry, candidate.bytes, candidate.hash, accountId, now);
        if (!created) {
          needsRetry = true;
          continue;
        }
        operations.push((map, doc) => {
          if (this.isLateCopy(created.path, candidate.hash, candidate.entry.mtimeMs) || !this.pathFree(doc, created.path)) {
            delete this.state.layout[created.fileId];
            return;
          }
          map.set(created.fileId, entryRecord(created));
          if (this.info.album) {
            const photo: AlbumPhotoRecord = { fileId: created.fileId, addedBy: accountId, updatedAt: now };
            doc.getMap<unknown>(ManifestKeys.photos).set(created.fileId, { ...photo });
          }
        });
        if (this.info.album) addedPhotos.push(created.fileId);
        touched.add(candidate.entry.relative);
      }
      for (const [relative, entry] of directories) {
        if (this.info.album) break;
        if (known.has(relative) || this.pathRetired(relative) || this.state.externalAdoptionRequired || isGeneratedPath(`${relative}/x`)) continue;
        const fileId = randomId("fil");
        const created: ManifestEntry = { fileId, path: relative, kind: "folder", createdBy: accountId, createdAt: now, updatedAt: now };
        operations.push((map, doc) => {
          if (!this.pathFree(doc, relative, undefined, true) || this.pathRetired(relative)) return;
          this.state.layout[fileId] = { path: relative, kind: "folder", mtimeMs: entry.mtimeMs };
          map.set(fileId, entryRecord(created));
        });
        touched.add(relative);
      }
    }

    if (operations.length > 0) {
      if (this.follower || !(await this.rootAvailable())) {
        this.state.layout = previous;
        this.missingSince.clear();
        return;
      }
      await this.writeManifest((map, doc) => {
        for (const operation of operations) operation(map, doc);
      }, EXTERNAL);
      if (addedPhotos.length > 0) this.reportAddedPhotos(addedPhotos);
      for (const [fileId, record] of Object.entries(this.state.layout)) {
        if (record.kind === "doc" && record.docId && !this.docs.has(record.docId)) this.ensureDoc(record.docId, fileId);
      }
    }
    if (touched.size > 0 || operations.length > 0) {
      this.saveSoon();
      this.ctx.layoutChanged(this.info.projectId);
      this.treeChanged(previous, this.state.layout);
      this.filesChanged([...touched]);
    }
    if (needsRetry) this.scheduleRetry();
  }

  /** When this process retired each path, and when it started (the cutoff for paths retired earlier). */
  private readonly retiredAt = new Map<string, number>();
  private readonly startedAt = Date.now();

  private retirePath(relative: string, hashes: string[] = []): void {
    const key = manifestPathKey(relative);
    this.retiredAt.set(key, Date.now());
    const known = this.retired.get(key);
    const added = hashes.filter((hash) => !known?.has(hash));
    if (known && added.length === 0) return;
    this.ctx.host.store.retirePath(this.info.projectId, key, added);
    this.retired.set(key, new Set([...(known ?? []), ...added]));
  }

  /**
   * Whether a new file at a retired path is the removed file coming back (a
   * late delivery from a sync client), not a file someone just put there.
   * Only the bytes can tell, so a path whose old bytes are unknown stays safe.
   */
  private isLateCopy(relative: string, hash: string, mtimeMs?: number): boolean {
    const key = manifestPathKey(relative);
    const hashes = this.retired.get(key);
    if (hashes === undefined) return false;
    if (hashes.size === 0 || hashes.has(hash)) return true;
    // A finite hash history cannot prove where late bytes came from: an older
    // version delivered after a delete is not in it, but a sync client keeps
    // its original mtime. Unknown bytes count as a new file only when written
    // after the retirement (this process's, else its own start); older ones
    // are set aside in `_archive`, never deleted.
    if (mtimeMs === undefined) return true;
    return mtimeMs <= (this.retiredAt.get(key) ?? this.startedAt);
  }

  private reportArchived(relative: string, reason: "removed" | "conflict-copy" = "removed"): void {
    this.ctx.logger.warn(reason === "conflict-copy"
      ? `Shared notebook ${this.info.notebook}: ${relative} looks like a sync conflict copy of a shared file, so it was set aside instead of shared.`
      : `Shared notebook ${this.info.notebook}: ${relative} matches a file removed from this notebook, so it was not shared again.`);
    if (!this.info.album) this.ctx.emit({ t: "file-archived", projectId: this.info.projectId, notebook: this.info.notebook, path: this.liberaPath(relative), reason });
  }

  /**
   * The shared file a new one is a cloud provider's conflict copy of, or
   * null. Sharing such a copy would publish a stale or conflicting version as
   * a new document next to the original, so it is set aside in `_archive`.
   *
   * - "name (… conflicted copy …).ext" (Dropbox) is one whatever it holds.
   * - "name-Device.ext" (OneDrive), "name 2.ext" (iCloud), "name (1).ext"
   *   could be anyone's new file, so it counts only when it holds an earlier
   *   version of "name.ext" that this host wrote or read. A copy of the
   *   current version is a person's duplicate and is shared as usual.
   */
  private conflictCopyOf(relative: string, hash: string): string | null {
    if (this.info.album) return null;
    const directory = path.posix.dirname(relative);
    const base = path.posix.basename(relative);
    const extension = path.posix.extname(base);
    const stem = base.slice(0, base.length - extension.length);
    const candidates: Array<{ name: string; certain: boolean }> = [];
    const dropbox = /^(.+?) \([^()]*conflicted copy[^()]*\)$/i.exec(stem);
    if (dropbox) candidates.push({ name: dropbox[1] + extension, certain: true });
    const numbered = /^(.+?)(?: \d+| \(\d+\))$/.exec(stem);
    if (numbered) candidates.push({ name: numbered[1] + extension, certain: false });
    // "name-COMPUTER-NAME.ext": computer names hold hyphens too, so try every
    // split point, the longest original name first.
    for (const base of numbered ? [stem, numbered[1]] : [stem]) {
      for (let at = base.lastIndexOf("-"); at > 0; at = base.lastIndexOf("-", at - 1)) {
        candidates.push({ name: base.slice(0, at) + extension, certain: false });
      }
    }
    for (const { name, certain } of candidates) {
      const original = directory === "." ? name : `${directory}/${name}`;
      const key = manifestPathKey(original);
      const record = Object.values(this.state.layout).find((item) => item.kind !== "folder" && manifestPathKey(item.path) === key);
      if (!record) continue;
      if (certain || (hash !== record.hash && knownHashes(record).includes(hash))) return original;
    }
    return null;
  }

  private pathRetired(relative: string): boolean {
    const segments = manifestPathKey(relative).split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      if (this.retired.has(segments.slice(0, length).join("/"))) return true;
    }
    return false;
  }

  /**
   * The ink of a renamed file or folder (`_ink/<path>/`, src/lib/storage/ink.ts)
   * follows it in the same manifest change, whoever renamed it: the editor,
   * Finder (a rename the scan detects) or a follower whose disk has not
   * received the ink folder yet. Not moved when the file changes extension
   * (an explicit rename then removes it) or ink already sits at the
   * destination. A deletion found by a scan leaves the ink: it may be a late
   * cloud delivery, and the ink comes back into use if the file does.
   */
  /** The ink entries of a file or folder (`_ink/<path>/…`); none for albums and for ink itself. */
  private inkCompanions(doc: Y.Doc, relative: string): ManifestEntry[] {
    if (this.info.album || relative === INK_DIRECTORY || relative.startsWith(`${INK_DIRECTORY}/`)) return [];
    return entriesUnder(readManifest(doc).values(), `${INK_DIRECTORY}/${relative}`);
  }

  private inkCompanionMoves(doc: Y.Doc, from: string, to: string, folder: boolean, now: number): ManifestEntry[] {
    if (this.info.album || from === to) return [];
    const inside = (relative: string) => relative === INK_DIRECTORY || relative.startsWith(`${INK_DIRECTORY}/`);
    if (inside(from) || inside(to)) return [];
    if (!folder && path.posix.extname(from).toLowerCase() !== path.posix.extname(to).toLowerCase()) return [];
    const entries = [...readManifest(doc).values()];
    // Paths as the layout shows them (a name collision adds " (2)"), as entriesUnder selects.
    const displayed = computeLayout(entries).paths;
    const shown = (entry: ManifestEntry) => displayed.get(entry.fileId) ?? entry.path;
    const inkFrom = `${INK_DIRECTORY}/${from}`;
    const inkTo = `${INK_DIRECTORY}/${to}`;
    const moving = entriesUnder(entries, inkFrom);
    if (moving.length === 0) return [];
    const ids = new Set(moving.map((entry) => entry.fileId));
    const key = manifestPathKey(inkTo);
    const taken = entries.some((entry) => {
      if (ids.has(entry.fileId)) return false;
      const other = manifestPathKey(shown(entry));
      return other === key || other.startsWith(`${key}/`) || (entry.kind !== "folder" && key.startsWith(`${other}/`));
    });
    if (taken) return [];
    const depth = inkFrom.split("/").length;
    const moved = moving.map((entry) => ({ ...entry, path: [inkTo, ...shown(entry).split("/").slice(depth)].join("/"), updatedAt: now }));
    return moved.every((entry) => isShareablePath(entry.path)) ? moved : [];
  }

  private pathFree(doc: Y.Doc, relative: string, except?: string, folder = false): boolean {
    const key = manifestPathKey(relative);
    return [...readManifest(doc).values()].every((entry) => {
      if (entry.fileId === except) return true;
      const other = manifestPathKey(entry.path);
      return other !== key && (folder || !other.startsWith(`${key}/`)) && (entry.kind === "folder" || !key.startsWith(`${other}/`));
    });
  }

  /** A new local file becomes a shared document or blob. Returns its manifest entry, or null to retry later. */
  private async createFromDisk(entry: WalkEntry, bytes: Uint8Array, hash: string, accountId: string, now: number): Promise<ManifestEntry | null> {
    const api = this.ctx.host.api;
    if (!api) return null;
    const stripped = await this.stripForUpload(path.join(this.info.root, ...entry.relative.split("/")), entry.relative, bytes).catch(() => null);
    if (stripped) {
      bytes = stripped.bytes;
      hash = sha256(bytes);
      entry = { ...entry, size: stripped.size, mtimeMs: stripped.mtimeMs };
    }
    // Retries of the same path+content reuse their IDs so a create whose reply was lost lands on the same server document (STALE-6).
    const attemptKey = `${entry.relative}\0${hash}`;
    const attempt = this.importAttempts.get(attemptKey) ?? { fileId: randomId("fil"), docId: randomId("doc") };
    this.importAttempts.set(attemptKey, attempt);
    const fileId = attempt.fileId;
    const classified = classifyFile(entry.relative, bytes);
    const stillCurrent = async () => {
      if (this.follower || !(await this.rootAvailable())) return false;
      const current = await readIfExists(await resolveInside(this.info.root, entry.relative));
      return current !== null && sha256(current) === hash;
    };
    try {
      if (classified.kind === "doc") {
        const docId = attempt.docId;
        await createSharedDocument(api, this.info.projectId, { docId, fileId }, classified.docKind, classified.text);
        if (!(await stillCurrent())) return null;
        this.importAttempts.delete(attemptKey);
        this.state.layout[fileId] = { path: entry.relative, kind: "doc", docId, docKind: classified.docKind, hash, size: entry.size, mtimeMs: entry.mtimeMs };
        await writeBase(this.info.root, docId, classified.text, this.diskGuard());
        this.ctx.host.store.upsertDoc({ docId, projectId: this.info.projectId, fileId, path: entry.relative, materializedHash: hash });
        return { fileId, path: entry.relative, kind: "doc", docId, docKind: classified.docKind, size: bytes.byteLength, createdBy: accountId, createdAt: now, updatedAt: now };
      }
      const mime = mimeForPath(entry.relative);
      await api.uploadBlob(this.info.projectId, bytes, mime);
      if (!(await stillCurrent())) return null;
      this.importAttempts.delete(attemptKey);
      this.state.layout[fileId] = { path: entry.relative, kind: "blob", hash, size: entry.size, mtimeMs: entry.mtimeMs };
      this.ctx.host.store.putBlob({ hash, localPath: path.join(this.info.root, ...entry.relative.split("/")), size: bytes.byteLength });
      return { fileId, path: entry.relative, kind: "blob", blobHash: hash, size: bytes.byteLength, mime, createdBy: accountId, createdAt: now, updatedAt: now };
    } catch (error) {
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not share new file ${entry.relative}; retrying later`, error);
      return null;
    }
  }

  // ------------------------------------------------------------ file operations (control API)

  /** Read authoritative blob bytes, including locally acknowledged follower writes. */
  readBlob(relative: string): Promise<FileBlobResponse> {
    if (this.stopped) return Promise.reject(new ControlError(503, "offline", "The notebook is stopping."));
    return this.enqueueExplicit(async () => {
      if (!this.manifestReady()) throw new ControlError(503, "offline", "The notebook's file list has not loaded yet.");
      const requested = normalizeRelative(relative);
      const entries = this.readEntries();
      const selected = entriesUnder(entries.values(), requested);
      if (!selected.length) return { contentBase64: null };
      const entry = selected[0];
      if (selected.length !== 1 || manifestPathKey(computeLayout(entries.values()).paths.get(entry.fileId) ?? "") !== manifestPathKey(requested) || entry.kind !== "blob" || !entry.blobHash) throw new ControlError(409, "conflict", "This path is not a binary file.");
      const bytes = await this.blobBytes(entry.blobHash);
      if (!bytes || sha256(bytes) !== entry.blobHash) throw new ControlError(503, "offline", "The shared file's current bytes are unavailable.");
      const current = this.readEntries();
      if (current.get(entry.fileId)?.blobHash !== entry.blobHash || computeLayout(current.values()).paths.get(entry.fileId) !== computeLayout(entries.values()).paths.get(entry.fileId)) {
        throw new ControlError(409, "conflict", "The shared file changed while it was read. Retry the save.");
      }
      return { fileId: entry.fileId, blobHash: entry.blobHash, contentBase64: Buffer.from(bytes).toString("base64") };
    });
  }

  /** create-file, create-folder, write-blob, rename and delete, through the manifest; the disk follows. */
  fileOp(request: FileOpRequest): Promise<{ paths: string[] }> {
    return this.enqueueExplicit(async () => {
      if (!this.canEdit) throw new ControlError(403, "forbidden", "Your role cannot add, rename or delete files.");
      if (!this.manifestReady()) throw new ControlError(503, "offline", "The notebook's file list has not loaded yet.");
      if (!this.follower && !(await this.rootAvailable())) throw new ControlError(503, "notebook-unavailable", "The shared notebook folder is missing or has changed. Restore it before changing its files.");
      this.entries = this.readEntries();
      const relative = normalizeRelative(request.path);
      if (this.info.album) {
        if (request.op === "create-file" || request.op === "create-folder") throw new ControlError(400, "bad-request", "Albums hold photos only.");
        const target = request.op === "rename" ? normalizeRelative(request.to ?? "") : relative;
        const problem = request.op === "delete" ? null : albumPathError(target);
        if (problem) throw new ControlError(400, "bad-request", problem);
      }
      const now = Date.now();
      const accountId = await this.ctx.accountId();
      this.entries = this.readEntries();
      const selected = entriesUnder(this.entries.values(), relative);
      if (request.expectedFileId !== undefined && (selected.length !== 1 || selected[0].fileId !== request.expectedFileId) ||
          request.expectedBlobHash !== undefined && (selected.length !== 1 || selected[0].blobHash !== request.expectedBlobHash)) {
        throw new ControlError(409, "conflict", "This file changed since it was read. Refresh it before changing it.");
      }
      const paths: string[] = [];
      const uploaded: string[] = [];
      try {
        switch (request.op) {
          case "create-file":
          case "create-folder": {
            this.assertFree(relative, []);
            const fileId = randomId("fil");
            let created: ManifestEntry;
            if (request.op === "create-folder") {
              created = { fileId, path: relative, kind: "folder", createdBy: accountId, createdAt: now, updatedAt: now };
            } else {
              created = await this.createFileEntry(fileId, relative, encodeText(request.content ?? ""), accountId, now);
            }
            await this.writeManifest((map) => map.set(fileId, entryRecord(created)), { source: "typing" });
            paths.push(relative);
            break;
          }
          case "write-blob": {
            let bytes = request.stagedFile !== undefined ? await this.takeStaged(request.stagedFile) : base64Bytes(request.contentBase64);
            if (this.info.album && !this.keepsLocation()) bytes = stripPhotoMetadata(bytes, albumImageType(relative) ?? "") ?? bytes;
            this.entries = this.readEntries();
            const key = manifestPathKey(relative);
            const displayed = computeLayout(this.entries.values()).paths;
            const existing = [...this.entries.values()].find((entry) => manifestPathKey(displayed.get(entry.fileId) ?? "") === key);
            if (request.expectedFileId !== undefined && existing?.fileId !== request.expectedFileId) throw new ControlError(409, "conflict", "This file identity changed before the upload began.");
            if (request.expectedBlobHash !== undefined && existing?.blobHash !== request.expectedBlobHash) throw new ControlError(409, "conflict", "This file changed before the upload began.");
            if (existing && request.createOnly) throw new ControlError(409, "conflict", `${existing.path} already exists.`);
            if (!existing) {
              // A new file: the same as create-file, from bytes.
              this.assertFree(relative, []);
              const fileId = randomId("fil");
              if (request.pdfSeed && this.pdfs.enabled) await this.pdfs.seed(fileId, relative, request.pdfSeed);
              const created = await this.createFileEntry(fileId, relative, bytes, accountId, now);
              await this.writeManifest((map) => map.set(fileId, entryRecord(created)), { source: "typing" });
              paths.push(relative);
              break;
            }
            if (existing.kind === "doc") throw new ControlError(409, "conflict", `${existing.path} is a shared document; change its text with edits.`);
            if (existing.kind !== "blob") throw new ControlError(409, "conflict", `${existing.path} is a folder.`);
            const api = this.ctx.host.api;
            if (!api) throw new ControlError(401, "needs-sign-in", "Sign in to the collaboration server.");
            const hash = sha256(bytes);
            // Upload first: a manifest entry must never name a blob the server lacks.
            await api.uploadBlob(this.info.projectId, bytes, existing.mime ?? mimeForPath(existing.path));
            const current = this.readEntries().get(existing.fileId);
            if (!current || current.kind !== "blob" || current.blobHash !== existing.blobHash) {
              throw new ControlError(409, "conflict", "This file was deleted or replaced while the upload was in progress. Its shared version was kept.");
            }
            this.uploadedBlobs.set(hash, bytes);
            uploaded.push(hash);
            const updated: ManifestEntry = { ...current, blobHash: hash, size: bytes.byteLength, updatedAt: now };
            await this.writeManifest((map, doc) => {
              map.set(existing.fileId, entryRecord(updated));
              if (this.info.album) this.photoReplaced(doc, existing.fileId, existing.blobHash, hash, accountId, now);
            }, { source: "typing" });
            paths.push(computeLayout(this.readEntries().values()).paths.get(current.fileId) ?? current.path);
            break;
          }
          case "rename": {
            if (!request.to) throw new ControlError(400, "bad-request", "rename needs `to`.");
            const to = normalizeRelative(request.to);
            const moving = entriesUnder(this.entries.values(), relative);
            if (moving.length === 0) {
              // The same rename again: on a follower the disk still shows the old name.
              if (this.retired.has(manifestPathKey(relative)) && entriesUnder(this.entries.values(), to).length > 0) return { paths: [] };
              throw new ControlError(404, "not-found", `${relative} is not in this notebook.`);
            }
            this.assertFree(to, moving.map((entry) => entry.fileId));
            const displayed = computeLayout(this.entries.values()).paths;
            const depth = relative.split("/").length;
            const updates = moving.map((entry) => {
              const visible = displayed.get(entry.fileId)!;
              const rest = visible.split("/").slice(depth);
              const next = [to, ...rest].join("/");
              if (!isShareablePath(next)) throw new ControlError(400, "bad-request", `${next} is not an allowed path.`);
              paths.push(visible, next);
              return { ...entry, path: next, updatedAt: now };
            });
            // A folder unless `relative` names a file (folders may have no entry of their own).
            const folder = !moving.some((entry) => entry.kind !== "folder" && manifestPathKey(displayed.get(entry.fileId) ?? entry.path) === manifestPathKey(relative));
            const sameKind = folder || path.posix.extname(relative).toLowerCase() === path.posix.extname(to).toLowerCase();
            await this.writeManifest((map, doc) => {
              for (const entry of updates) map.set(entry.fileId, entryRecord(entry));
              for (const entry of this.inkCompanionMoves(doc, relative, to, folder, now)) {
                map.set(entry.fileId, entryRecord(entry));
                paths.push(entry.path);
              }
              // A file that becomes another type keeps none of its ink, as in a local notebook.
              if (!sameKind) {
                for (const entry of this.inkCompanions(doc, relative)) {
                  map.delete(entry.fileId);
                  paths.push(entry.path);
                }
              }
            }, { source: "typing" });
            break;
          }
          case "delete": {
            const removing = entriesUnder(this.entries.values(), relative);
            if (removing.length === 0) {
              // Already removed, and still on a follower's disk until the writer gets to it.
              if (this.retired.has(manifestPathKey(relative))) return { paths: [] };
              throw new ControlError(404, "not-found", `${relative} is not in this notebook.`);
            }
            const displayed = computeLayout(this.entries.values()).paths;
            await this.writeManifest((map, doc) => {
              for (const entry of removing) map.delete(entry.fileId);
              // Someone deleted it on purpose, so its ink goes too (archived on disk like the file).
              for (const entry of this.inkCompanions(doc, relative)) {
                map.delete(entry.fileId);
                paths.push(entry.path);
              }
            }, { source: "typing" });
            paths.push(...removing.map((entry) => displayed.get(entry.fileId)!));
            break;
          }
          default:
            throw new ControlError(400, "bad-request", "Unknown file operation.");
        }
        // Make the disk match before answering, so the caller can re-read the tree.
        await this.applyManifest();
        // Creates record their layout before applyManifest runs, so it sees no
        // change; rebuild the resolvePath index here, or a file just created
        // would not resolve (the caller's next request is often an edit to it).
        this.ctx.layoutChanged(this.info.projectId);
        return { paths: paths.map((item) => this.liberaPath(item)) };
      } finally {
        for (const hash of uploaded) this.uploadedBlobs.delete(hash);
      }
    });
  }

  /**
   * The bytes of a write-blob staged in `.libera/collab/incoming/` by Libera
   * (files too large for a request body). Only a plain name inside that folder
   * is accepted, and the file is removed once read.
   */
  private async takeStaged(name: unknown): Promise<Uint8Array> {
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(name)) {
      throw new ControlError(400, "bad-request", "write-blob needs the staged file's name in stagedFile.");
    }
    const file = path.join(this.info.root, ...STATE_DIRECTORY, "incoming", name);
    try {
      return new Uint8Array(await fs.readFile(file));
    } catch (error) {
      if (isNotFound(error)) throw new ControlError(404, "not-found", "The staged file is gone.");
      throw error;
    } finally {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }

  /** A new file (document or blob) on the server and on disk; the caller adds its manifest entry. */
  private async createFileEntry(fileId: string, relative: string, bytes: Uint8Array, accountId: string, now: number): Promise<ManifestEntry> {
    const api = this.ctx.host.api;
    if (!api) throw new ControlError(401, "needs-sign-in", "Sign in to the collaboration server.");
    const classified = classifyFile(relative, bytes);
    const hash = sha256(bytes);
    const target = await this.resolveOrRefuse(relative);
    if (await statIfExists(target)) throw new ControlError(409, "conflict", `${relative} already exists on disk.`);
    let created: ManifestEntry;
    if (classified.kind === "doc") {
      const docId = randomId("doc");
      await createSharedDocument(api, this.info.projectId, { docId, fileId }, classified.docKind, classified.text);
      created = { fileId, path: relative, kind: "doc", docId, docKind: classified.docKind, size: bytes.byteLength, createdBy: accountId, createdAt: now, updatedAt: now };
    } else {
      const mime = mimeForPath(relative);
      await api.uploadBlob(this.info.projectId, bytes, mime);
      created = { fileId, path: relative, kind: "blob", blobHash: hash, size: bytes.byteLength, mime, createdBy: accountId, createdAt: now, updatedAt: now };
    }
    // A follower leaves the file to the writer.
    if (this.follower) return created;
    if (!this.pathFree(this.manifestDoc(), relative)) return created;
    // The path was empty before HTTP; a cloud/editor arrival is separate work.
    const guard = this.diskGuard();
    const arrived = await readIfExists(target);
    let stats;
    try {
      if (arrived) await this.archive(relative, contentGuard(target, sha256(arrived), guard));
      stats = await writeFileAtomic(target, bytes, contentGuard(target, null, guard));
    } catch (error) {
      if (!(error instanceof WriteCancelledError) || !(await guard.canCommit())) throw error;
      // The server already holds the submitted input. Publish its identity;
      // normal materialization will preserve the newer disk arrival too.
      return created;
    }
    this.state.layout[fileId] = {
      path: relative,
      kind: created.kind,
      ...(created.docId ? { docId: created.docId, docKind: created.docKind } : {}),
      hash,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
    if (created.docId && classified.kind === "doc") {
      await writeBase(this.info.root, created.docId, classified.text, this.diskGuard());
      this.ctx.host.store.upsertDoc({ docId: created.docId, projectId: this.info.projectId, fileId, path: relative, materializedHash: hash });
    } else {
      this.ctx.host.store.putBlob({ hash, localPath: target, size: bytes.byteLength });
    }
    return created;
  }

  private assertFree(relative: string, except: string[]): void {
    if (!isShareablePath(relative)) throw new ControlError(400, "bad-request", `${relative} is not an allowed path in a shared notebook.`);
    const key = manifestPathKey(relative);
    const displayed = computeLayout(this.entries.values()).paths;
    for (const entry of this.entries.values()) {
      if (except.includes(entry.fileId)) continue;
      const entryKey = manifestPathKey(displayed.get(entry.fileId) ?? entry.path);
      if (entryKey === key || entryKey.startsWith(`${key}/`)) throw new ControlError(409, "conflict", `${entry.path} already exists.`);
      // A file cannot become the parent folder of a new entry.
      if (entry.kind !== "folder" && key.startsWith(`${entryKey}/`)) throw new ControlError(409, "conflict", `${entry.path} is a file.`);
    }
  }

  private async resolveOrRefuse(relative: string): Promise<string> {
    try {
      return await resolveInside(this.info.root, relative);
    } catch (error) {
      if (error instanceof PathRefusedError) throw new ControlError(400, "bad-request", error.message);
      throw error;
    }
  }

  // ------------------------------------------------------------ album details (control API)

  /** Captions, covers and privacy changes have no disk event of their own. */
  private notifyAlbumChanged(): void {
    if (!this.info.album) return;
    const snapshot = JSON.stringify(this.albumState());
    if (snapshot === this.albumSnapshot) return;
    this.albumSnapshot = snapshot;
    this.ctx.emit({ t: "project-changed", projectId: this.info.projectId });
  }

  /** The album's photos (with their file names on disk) and settings. */
  albumState(): Pick<LocalAlbum, "direct" | "keepLocation" | "sharePrompts" | "cover" | "photos"> {
    // After access ends the manifest is closed; the entries last read still
    // say which photo is whose (revocation keeps this account's own).
    const hub = this.manifestHub;
    if (!hub) return { direct: false, keepLocation: false, sharePrompts: false, photos: [] };
    const doc = hub.getDoc("manifest");
    const settings = doc.getMap<unknown>(ManifestKeys.settings);
    const records = doc.getMap<unknown>(ManifestKeys.photos);
    const layout = computeLayout((this.manifestReady() ? this.readEntries() : this.entries).values());
    const photos: LocalAlbumPhoto[] = [];
    const sharePrompts = settings.get(AlbumSettingKeys.sharePrompts) === true;
    for (const [fileId, name] of layout.paths) {
      const record = (records.get(fileId) ?? {}) as Partial<AlbumPhotoRecord>;
      const entry = this.entries.get(fileId);
      photos.push({
        fileId,
        name,
        ...(typeof record.caption === "string" && record.caption ? { caption: record.caption } : {}),
        ...(sharePrompts && typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
        ...(sharePrompts && typeof record.model === "string" ? { model: record.model } : {}),
        ...(record.edits && typeof record.edits === "object" ? { edits: record.edits } : {}),
        edited: typeof record.originalHash === "string",
        ...(typeof record.originalHash === "string" ? { originalHash: record.originalHash } : {}),
        ...(typeof record.order === "number" ? { order: record.order } : {}),
        addedBy: typeof record.addedBy === "string" ? record.addedBy : entry?.createdBy ?? "",
        downloaded: this.follower || Boolean(this.state.layout[fileId]?.hash && this.state.layout[fileId].hash === entry?.blobHash),
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : entry?.updatedAt ?? 0,
      });
    }
    const coverId = settings.get(AlbumSettingKeys.cover);
    const cover = typeof coverId === "string" ? layout.paths.get(coverId) : undefined;
    return {
      direct: settings.get(AlbumSettingKeys.direct) === true,
      keepLocation: settings.get(AlbumSettingKeys.keepLocation) === true,
      sharePrompts,
      ...(cover ? { cover } : {}),
      photos,
    };
  }

  /** Captions, order, edits and settings, in one manifest change. */
  updateAlbum(request: UpdateAlbumRequest): Promise<void> {
    return this.enqueueExplicit(async () => {
      if (!this.info.album) throw new ControlError(400, "bad-request", "This is not a shared album.");
      if (!this.canEdit) throw new ControlError(403, "forbidden", "Your role cannot change this album.");
      if ((request.keepLocation !== undefined || request.sharePrompts !== undefined) && this.info.role !== "owner") {
        throw new ControlError(403, "forbidden", "Only the album's owner can change what it shares.");
      }
      if (!this.manifestReady()) throw new ControlError(503, "offline", "The album has not loaded yet.");
      const accountId = await this.ctx.accountId();
      const now = Date.now();
      const layout = computeLayout(this.readEntries().values());
      const byName = new Map([...layout.paths].map(([fileId, name]) => [manifestPathKey(name), fileId]));
      const fileIdOf = (name: unknown): string => {
        const fileId = typeof name === "string" ? byName.get(manifestPathKey(name)) : undefined;
        if (!fileId) throw new ControlError(404, "not-found", `${String(name)} is not in this album.`);
        return fileId;
      };
      const changes = (request.photos ?? []).map((change) => ({ fileId: fileIdOf(change.name), change }));
      const cover = request.cover === undefined ? undefined : request.cover === null ? null : fileIdOf(request.cover);
      await this.writeManifest((_files, doc) => {
        const photos = doc.getMap<unknown>(ManifestKeys.photos);
        for (const { fileId, change } of changes) {
          const current = (photos.get(fileId) ?? { fileId, addedBy: this.entries.get(fileId)?.createdBy ?? accountId, updatedAt: now }) as Record<string, unknown>;
          const next: Record<string, unknown> = { ...current, updatedBy: accountId, updatedAt: now };
          for (const key of ["caption", "order", "edits", "prompt", "model"] as const) {
            const value = change[key];
            if (value === undefined) continue;
            if (value === null || value === "") delete next[key];
            else next[key] = key === "caption" ? String(value).slice(0, MAX_ALBUM_CAPTION_LENGTH) : value;
          }
          photos.set(fileId, JSON.parse(JSON.stringify(next)));
        }
        const settings = doc.getMap<unknown>(ManifestKeys.settings);
        if (cover === null) settings.delete(AlbumSettingKeys.cover);
        else if (cover !== undefined) settings.set(AlbumSettingKeys.cover, cover);
        if (request.keepLocation !== undefined) settings.set(AlbumSettingKeys.keepLocation, request.keepLocation === true);
        if (request.sharePrompts !== undefined) settings.set(AlbumSettingKeys.sharePrompts, request.sharePrompts === true);
      }, { source: "typing" });
    });
  }

  /** The unedited bytes of an edited photo, from the server (or the local cache). */
  async photoOriginal(name: string): Promise<Uint8Array> {
    if (!this.manifestReady()) throw new ControlError(503, "offline", "The album has not loaded yet.");
    const layout = computeLayout(this.readEntries().values());
    const fileId = [...layout.paths].find(([, path]) => manifestPathKey(path) === manifestPathKey(name))?.[0];
    if (!fileId) throw new ControlError(404, "not-found", `${name} is not in this album.`);
    const record = this.manifestDoc().getMap<unknown>(ManifestKeys.photos).get(fileId) as Partial<AlbumPhotoRecord> | undefined;
    if (!record?.originalHash) throw new ControlError(404, "not-found", `${name} has no original.`);
    const bytes = await this.blobBytes(record.originalHash);
    if (!bytes) throw new ControlError(503, "offline", "The original cannot be downloaded right now.");
    return bytes;
  }

  // ------------------------------------------------------------ index, events, persistence

  /** Documents on disk, for resolvePath. */
  indexedDocs(): IndexedDoc[] {
    const result: IndexedDoc[] = [];
    for (const [fileId, record] of Object.entries(this.state.layout)) {
      if (record.kind === "doc" && record.docId && record.docKind) {
        result.push({ fileId, docId: record.docId, path: record.path, docKind: record.docKind });
      }
    }
    return result;
  }

  /** Reconciliations and layout from disk, for a project that is not running (revoked). */
  static async readIndex(root: string): Promise<{ docs: IndexedDoc[]; reconcilePending: number }> {
    const state = await readState(root);
    const docs: IndexedDoc[] = [];
    for (const [fileId, record] of Object.entries(state.layout)) {
      if (record.kind === "doc" && record.docId && record.docKind) docs.push({ fileId, docId: record.docId, path: record.path, docKind: record.docKind });
    }
    return { docs, reconcilePending: state.reconciliations.length };
  }

  liberaPath(relative: string): string {
    return `${this.info.notebook}/${relative}`;
  }

  // Files appeared, moved or went away (a collaborator's file op or our own):
  // windows refresh the Notebooks tree and re-point open tabs of moved files.
  // Separate from files-changed, which also fires for every text write and
  // must not make the tree reload while someone types.
  private treeChanged(previous: Record<string, LayoutRecord>, next: Record<string, LayoutRecord>): void {
    const moves: { from: string; to: string }[] = [];
    const removed: string[] = [];
    const added: string[] = [];
    for (const [fileId, record] of Object.entries(next)) {
      const before = previous[fileId];
      if (!before) added.push(this.liberaPath(record.path));
      else if (before.path !== record.path) moves.push({ from: this.liberaPath(before.path), to: this.liberaPath(record.path) });
    }
    for (const [fileId, record] of Object.entries(previous)) {
      if (!next[fileId]) removed.push(this.liberaPath(record.path));
    }
    if (moves.length === 0 && removed.length === 0 && added.length === 0) return;
    this.ctx.emit({ t: "tree-changed", projectId: this.info.projectId, notebook: this.info.notebook, added, moves, removed });
  }

  private filesChanged(paths: string[]): void {
    const unique = [...new Set(paths)].filter(Boolean).map((item) => this.liberaPath(item));
    if (unique.length > 0) this.ctx.emit({ t: "files-changed", projectId: this.info.projectId, paths: unique });
  }

  /**
   * Writes state.json soon. A write that fails (or finds the folder
   * unavailable) is retried with backoff until one succeeds: until the
   * next change, nothing else would rewrite it.
   */
  private saveSoon(delay = 100): void {
    this.stateDirty = true;
    if (this.saveTimer || this.stopped || this.follower) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.enqueue(async () => {
        if (!this.stateDirty || this.follower) return;
        this.stateDirty = false;
        let saved = false;
        try {
          if (await this.rootAvailable()) {
            await writeState(this.info.root, this.state, this.diskGuard());
            saved = true;
          }
        } finally {
          if (saved) this.saveFailures = 0;
          else if (!this.stopped) {
            this.saveFailures += 1;
            this.saveSoon(Math.min(MAX_SAVE_RETRY_MS, this.ctx.timings.retryMs * 2 ** (this.saveFailures - 1)));
          }
        }
      });
    }, delay);
    this.saveTimer.unref?.();
  }

  /**
   * How long a content verification stands while the stats stay the same:
   * verifyMs, or largeFileVerifyMs (spread per file) for large files whose
   * last read was handled; times batteryScale on battery.
   */
  private verificationAge(fileId: string, size: number, pending: boolean): number {
    const { verifyMs, largeFileVerifyMs } = this.ctx.timings;
    const base = pending || size < LARGE_FILE_BYTES ? verifyMs : Math.max(verifyMs, largeFileVerifyMs * (0.75 + 0.5 * spreadFraction(fileId)));
    return base * this.powerScale();
  }

  /** What the last read of this file found is handled; the longer large-file age may apply. */
  private settleVerification(fileId: string): void {
    const verification = this.verified.get(fileId);
    if (verification) verification.pending = false;
  }
}

/** Whether `key` or a folder above it is in `keys` (all manifestPathKey). */
function underAny(keys: Set<string>, key: string): boolean {
  if (keys.size === 0) return false;
  for (let index = key.indexOf("/"); index >= 0; index = key.indexOf("/", index + 1)) if (keys.has(key.slice(0, index))) return true;
  return keys.has(key);
}

/**
 * A Windows UNC path (\\server\share, \\?\UNC\server\share). Extended-length
 * and device paths to local drives (\\?\C:\, \\.\C:\) are not shares.
 */
export function onWindowsNetworkShare(root: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const normalized = root.replace(/\//g, "\\");
  if (/^\\\\[?.]\\UNC\\/i.test(normalized)) return true;
  if (/^\\\\[?.]\\/.test(normalized)) return false;
  return normalized.startsWith("\\\\");
}

/** A stable fraction in [0, 1) per file, to spread large-file verifications over time. */
function spreadFraction(fileId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < fileId.length; index += 1) hash = Math.imul(hash ^ fileId.charCodeAt(index), 16777619);
  return (hash >>> 0) / 2 ** 32;
}

function compatibleKind(record: LayoutRecord, relative: string): boolean {
  // A document renamed to a name that is not text any more ("a.md" → "a.png")
  // is a new file, not the same document.
  if (record.kind === "doc") return classifyFile(relative, new Uint8Array(0)).kind === "doc";
  return true;
}

function normalizeRelative(input: string): string {
  if (typeof input !== "string") throw new ControlError(400, "bad-request", "A path is required.");
  const relative = input.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!relative) throw new ControlError(400, "bad-request", "A path is required.");
  return relative;
}

/** Every version of a removed or moved file this host knows, for recognizing it if it returns. */
function knownHashes(record?: LayoutRecord, entry?: ManifestEntry): string[] {
  const hashes = [record?.hash, entry?.blobHash, ...(record?.previous ?? []).map((item) => item.hash)];
  return [...new Set(hashes.filter((hash): hash is string => Boolean(hash)))];
}

/** The bytes of write-blob's `contentBase64`; Buffer.from would silently skip invalid characters. */
function base64Bytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new ControlError(400, "bad-request", "write-blob needs the file's bytes as base64 in contentBase64.");
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * Whether a hub holds real state for `subdoc`: something in the local log or
 * a snapshot, or the server's answer on this connection. Before that, an
 * empty text means "not loaded", not "empty".
 */
export function hubHasState(host: CollabHost, hub: DocHub, subdoc: "content" | "manifest"): boolean {
  const state = hub.getStatus().state;
  if (state === "saved-remote" || state === "syncing") return true;
  const store = host.store;
  return store.tailStats(hub.docId, subdoc).count > 0 || store.latestSnapshotSeq(hub.docId, subdoc) > 0;
}
