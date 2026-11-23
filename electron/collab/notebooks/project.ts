// One shared notebook while the app runs: the materializer (CRDT → disk),
// the watcher (disk → CRDT), file operations and reconciliations.
//
// Everything that touches the notebook folder or the layout runs on one
// queue per project. That serializes writes per file (and across files, which
// keeps renames and creates from racing each other), and it is what makes
// self-writes invisible: a scan never runs between a write and the layout
// update that records its hash.

import { promises as fs, watch, type FSWatcher, type Stats } from "node:fs";
import path from "node:path";

import type * as Y from "yjs";

import type { FileBlobResponse, FileListEntry, FileListResponse, FileOpMove, FileOpRequest, FileOpResult, HostEvent, LocalAlbum, LocalAlbumPhoto, Reconciliation, UpdateAlbumRequest } from "../../../src/lib/collab/local-api";
import type { Provenance } from "../../../src/lib/collab/protocol/actor";
import type { ProjectClosingResponse, TakedownRecovery } from "../../../src/lib/collab/protocol/api";
import type { Role } from "../../../src/lib/collab/protocol/roles";
import { roleAtLeast } from "../../../src/lib/collab/protocol/roles";
import {
  AlbumSettingKeys,
  ContentKeys,
  MAX_ALBUM_CAPTION_LENGTH,
  ManifestKeys,
  albumImageType,
  albumPathError,
  docKindForPath,
  manifestNewNameError,
  manifestPathKey,
  type AlbumPhotoRecord,
  type ManifestEntry,
} from "../../../src/lib/collab/protocol/schema";
import { stripPhotoMetadata } from "../../../src/lib/collab/photo-metadata";
import { ApiClientError } from "../core/api-client";
import type { Logger } from "../core/clock";
import type { DocHub } from "../core/doc-hub";
import type { CollabHost } from "../core/host";
import { ControlError } from "../control/types";
import { classifyFile, createSharedDocument, mimeForPath } from "./documents";
import { clearMoveJournal, placeStagedMoves, writeMoveJournal } from "./move-journal";
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
  emptyFileWaitMs,
  ensureDirectory,
  isActiveSqliteDatabase,
  isDataless,
  isExcludedPath,
  isFinderCopy,
  isGeneratedPath,
  isNotFound,
  isShareablePath,
  mayStillBeCopying,
  movePath,
  movePathExclusive,
  DestinationTakenError,
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
import { MANIFEST_BATCH_BYTES, computeLayout, entriesUnder, entryRecord, manifestEntryBytes, readManifest, splitManifestBatches } from "./layout";
import { ManifestIntents, trackEntryWrites } from "./manifest-intents";
import { FRESH_RETAIN_BYTES, MAX_SKIPPED_RETRY_MS, MAX_UPLOAD_BYTES, OWN_WRITE_TTL_MS, SCAN_READ_BUDGET_BYTES, noteTruncatedWalk, quietWaitMs, readShared, scanReadState, withinMs } from "./scan-reads";
import { ScanFairness } from "./scan-fairness";
import { PdfCommentService } from "./pdf-comments";
import { AUDIO_EXTENSIONS, MARKDOWN_EXTENSIONS } from "../../../src/lib/storage/constants";
import { pythonSidecarPath } from "../../../src/lib/python/sidecar";
import { PdfMarksRuntime } from "./pdf-marks";
import { PDF_LIVE_SETTING } from "../../../src/lib/collab/protocol/pdf";
import { emptyState, isStaleCopy, isUncertainCopy, readBase, readMarker, readState, setMaterialized, writeBase, writeMarker, writeState, deleteBase, type LayoutRecord, type ProjectState } from "./state";
import { diffText } from "./text-diff";
import { chunkTextEdits } from "./text-edit-chunks";
import { diffManifestPaths, type RecordedPath } from "./transition-log";

/** Scans a pairing of a missing file with a new one is held back for an uncertain absence before the usual restore-and-import applies. */
const MAX_RENAME_DEFERRALS = 8;

/** The scanner's per-project bookkeeping, created on first use (a project built without its field initializers has it too). */
interface ScanScratch {
  fairness: ScanFairness;
  respellSeen: Map<string, string>;
  respellLogged: Set<string>;
  ownRespells: Set<string>;
  renameDeferrals: Map<string, number>;
  /** The latest renames the scanner paired, for a folder whose files pair across scans (S43). */
  recentMoves: Array<{ from: string; to: string; at?: number }>;
}
const scanScratches = new WeakMap<object, ScanScratch>();
function scanScratch(owner: object): ScanScratch {
  let scratch = scanScratches.get(owner);
  if (!scratch) {
    scratch = { fairness: new ScanFairness(), respellSeen: new Map(), respellLogged: new Set(), ownRespells: new Set(), renameDeferrals: new Map(), recentMoves: [] };
    scanScratches.set(owner, scratch);
  }
  return scratch;
}

/** Entries remembered as spelled by a remote normalization-only rename. */
const MAX_REMOTE_RESPELLS = 200;

/** How long a paired rename is remembered for recognizing a moved folder. */
const RECENT_MOVE_MS = 5 * 60_000;

/** Renames remembered across scans to recognize a moved folder. */
const MAX_RECENT_MOVES = 500;

/** Where a notebook keeps its files' ink (INK_DIR in src/lib/storage/constants.ts). */
const INK_DIRECTORY = "_ink";

/**
 * How long a scan waits for one file's bytes before moving on and retrying:
 * an online-only file downloads on first read, and the scan holds the
 * notebook's queue (stopping and lease changes wait on it).
 */
const HYDRATION_WAIT_MS = 10_000;
/** Longest stopping waits for the project queue's running task (a stalled provider can hold it for good). */
export const stopTimings = { queueWaitMs: 15_000 };

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
/** A blob that cannot be downloaded is retried on a doubling delay up to this, and reported as refused after this many failures (or at once on a 404). */
const MAX_BLOB_RETRY_MS = 5 * 60_000;
const UNRESOLVABLE_BLOB_FAILURES = 5;

/** Longest wait between a follower's probes of a path that still has not arrived. */
const FOLLOWER_DISK_MAX_PROBE_MS = 5 * 60_000;

/**
 * Wait before state.json is rewritten after a text flush. The file holds the
 * whole notebook layout, so rewriting it on every flush multiplies provider
 * work; a state a crash loses is rebuilt from the files (the text is adopted).
 */
const TEXT_FLUSH_SAVE_MS = 2000;

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
  /** How long a follower probes a path every tick before it backs off (it keeps waiting after that). */
  followerDiskWaitMs: number;
  /** Retry delay for downloads and creates that failed (offline). */
  retryMs: number;
  /**
   * Age after which a file below LARGE_FILE_BYTES is read and hashed again
   * even if every stat is unchanged (times batteryScale on battery). Also
   * the retry bound for a file whose change could not be handled yet.
   */
  verifyMs: number;
  /**
   * The same age while fs.watch is trusted here and has not been caught
   * missing a change this session. A preserved-stats edit still raises a
   * watcher event (and is read then), so the timed verification only guards
   * against the watcher failing without a sign: re-hashing every small file
   * each minute for that alone cost more battery than it bought. A watcher
   * that did miss one gets verifyMs for good, even once trusted again.
   */
  trustedVerifyMs: number;
  /**
   * How long fs.watch stays distrusted after it was caught missing a change,
   * before it is trusted (and judged) again; doubled at each further miss,
   * up to 16 times this. Never for a folder distrusted from the start (a
   * network share). Trusting it again only slows the stat-walk poll: small
   * files stay on verifyMs, as the watcher is still not known to work.
   */
  watchRetrustMs: number;
  /** The same for files of LARGE_FILE_BYTES or more, spread ±25% per file so they do not all come due together. */
  largeFileVerifyMs: number;
  /** Delay before a shared PDF's sidecar copy is rewritten. */
  pdfWriteMs: number;
  /** How long a new or externally changed file must stay untouched (mtime and ctime) before it is imported. */
  importQuietMs: number;
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
  followerDiskWaitMs: 10 * 60_000,
  retryMs: 5000,
  verifyMs: 60_000,
  trustedVerifyMs: 10 * 60_000,
  watchRetrustMs: 10 * 60_000,
  largeFileVerifyMs: 30 * 60_000,
  pdfWriteMs: 60_000,
  importQuietMs: 3000,
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

/** A path a follower waits on (see awaitDisk). */
interface AwaitedPath {
  present: boolean;
  /** Probed every tick until then; after it, with a growing wait (it is never given up silently). */
  until: number;
  blob?: { hash: string; size: number };
  /** What the last hash probe looked at: the file's stats and the manifest hash it was compared with. */
  probed?: string;
  /** From the first manifest: bytes already there at the expected size count as arrived without hashing them. */
  initial?: boolean;
  /** The path was found not to match at least once, so its arrival is worth announcing. */
  waited?: boolean;
  /** Wait between probes once `until` has passed; doubles up to FOLLOWER_DISK_MAX_PROBE_MS. */
  delay?: number;
  /** No probe before this time (Date.now()). */
  nextAt?: number;
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
  /** A manifest pass or document writes a lapsed writer deferred until its lease is confirmed. */
  private manifestDeferred = false;
  private writesDeferred = false;
  /** Retirements and transition rows held back until the server has the manifest's local edits. */
  private retiresDeferred = false;
  private transitionsDeferred = false;
  /** Layout records of new files, inserted once the manifest entry that names them is written. */
  private pendingLayout = new Map<string, LayoutRecord>();
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
  /** When a watcher caught missing a change is trusted again (performance.now()); null when it is trusted or never will be. */
  private watchRetrustAt: number | null = null;
  /** Times the watcher was caught missing a change this session: each doubles the next wait before trusting it again. */
  private watchMisses = 0;
  /** When the computer last woke (performance.now()): small files verified before it are verified again. */
  private resumedAt = 0;
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
  private readonly awaitedOnDisk = new Map<string, AwaitedPath>();
  /** A follower's last-read manifest blob versions: a same-path replacement changes the hash, not the layout. */
  private followerBlobs: Map<string, { hash: string; size: number }> | null = null;
  private followerDiskTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** performance.now() the pending state.json write is due. */
  private saveDueAt = 0;
  /** The state.json text last written (or found unchanged), so an identical state is not written again. */
  private savedState: string | null = null;
  /** Hubs (by document id) that heard the server's answer since this runtime started: a writer does no disk work before that (finding 2). */
  private readonly caughtUp = new Map<string, number>();
  /** The manifest change this runtime made is in memory only (SQLite refused it): disk work waits for the hub's retry (S54). */
  private durableWaiting = false;
  /** While a manifest pass runs: the catch-up generation its disk writes are bound to (S53). */
  private epochFence: { hub: DocHub; generation: number } | null = null;
  /** Folder paths whose placement on disk this runtime confirmed, and why the others could not be placed (S52). */
  private readonly placedFolders = new Set<string>();
  private readonly folderErrors = new Map<string, string>();
  /** Documents whose write was skipped because their move is still pending; written once it is placed. */
  private readonly moveDeferred = new Set<string>();
  /** state.json is behind the in-memory state; kept until a write succeeds. */
  private stateDirty = false;
  private saveFailures = 0;
  private readonly missingSince = new Map<string, number>();
  /** Files a scan left out or failed to read, so the next scans serve them first; counted in scan passes (S49). */
  private get scanFairness(): ScanFairness { return scanScratch(this).fairness; }
  /** The disk spelling of a known name that another program changed (case, Unicode form), until it is seen at two scans in a row (S39). */
  private get respellSeen(): Map<string, string> { return scanScratch(this).respellSeen; }
  /** Entries already logged as keeping a remote normalization spelling (S39). */
  private get respellLogged(): Set<string> { return scanScratch(this).respellLogged; }
  /** Entries this host's own scan respelled in the manifest: not a remote rename when they come back through the manifest. */
  private get ownRespells(): Set<string> { return scanScratch(this).ownRespells; }
  /** Scans a missing file's pairing with a new file was held back because its absence was uncertain (S41). */
  private get renameDeferrals(): Map<string, number> { return scanScratch(this).renameDeferrals; }
  private readonly refusedLogged = new Set<string>();
  /** Blobs that could not be downloaded: failures so far and the earliest next try (finding 35). */
  private readonly blobFailures = new Map<string, { count: number; nextAt: number }>();
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
  /** Where each manifest entry was last recorded in the host's transition log (a restart reads it back from the store). */
  private recordedPaths: Map<string, RecordedPath>;
  private observedEntries = new Map<string, ManifestEntry>();
  /** Field changes this host made to entries until the server has them: a concurrent whole-entry write must not undo them (see manifest-intents.ts). */
  private readonly manifestIntents = new ManifestIntents();
  private intentsScheduled = false;
  readonly pdfs: PdfMarksRuntime;

  private constructor(ctx: ProjectContext, info: ProjectInfo, state: ProjectState) {
    this.ctx = ctx;
    this.info = info;
    this.state = state;
    this.retired = ctx.host.store.retiredPaths(info.projectId);
    this.recordedPaths = ctx.host.store.manifestPaths(info.projectId);
    this.pdfs = new PdfMarksRuntime({
      host: ctx.host,
      logger: ctx.logger,
      projectId: info.projectId,
      notebook: info.notebook,
      root: info.root,
      writeMs: ctx.timings.pdfWriteMs,
      powerScale: () => this.powerScale(),
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
    // Staged bytes of a move an earlier run never finished (STALE-3) stay under .libera/collab/moving/ until a
    // caught-up manifest pass (placeStagedMoves) supplies the entry's current destination or confirms its removal:
    // resolving them here, against the journal's possibly obsolete destination, consumed them too early (S48).
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

  /**
   * This runtime may not touch the disk now: it follows for good, or it is a writer whose lease has
   * lapsed. Disk work waits (a lapsed writer resumes when the lease is confirmed; see leaseConfirmed).
   */
  get follower(): boolean {
    return this.info.follower === true || this.ctx.canWriteDisk?.(this.info.projectId) === false;
  }

  /** The runtime follows the manifest for good: its layout is the manifest's, never its own bookkeeping. */
  private get permanentFollower(): boolean {
    return this.info.follower === true;
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
    // Eligibility is asked again after the marker read: a lease that expired
    // (or a role that changed) during a slow provider read never commits.
    const eligible = () => finalizing || (!this.stopped && !this.follower);
    // A pass of disk work is bound to the manifest generation it started under: a reconnect or a
    // rollback in between sends it back to wait for the replacement state (S53).
    const fence = this.epochFence;
    const current = () => finalizing || !fence || (!fence.hub.isClosed && fence.hub.caughtUp && fence.hub.catchUpGeneration === fence.generation);
    return { root: this.info.root, canCommit: async () => eligible() && current() && await this.rootAvailable() && eligible() && current() };
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
        this.retireObserved();
        this.scheduleManifest(30);
        this.scheduleIntents();
      }),
      hub.onStatus(() => {
        // A rollback to nothing raises no "server" change: hearing the server again is what ends it (H2).
        if (this.manifestRebuilt && hub.caughtUp) {
          this.manifestRebuilt = false;
          this.scheduleManifest(30);
        }
        // The server has the local edits now: the retirements and transition rows they wait for are due (M23).
        if ((this.retiresDeferred || this.transitionsDeferred) && this.manifestAcknowledged()) {
          this.retireObserved();
          if (this.transitionsDeferred) this.scheduleManifest(30);
        }
        this.scheduleIntents();
        // The retry that saved a change which was only in memory: its disk work may run now (no timer of its own).
        if (this.durableWaiting && hub.unpersistedCount === 0) {
          this.durableWaiting = false;
          this.scheduleManifest(30);
          this.scheduleScan(30);
        }
        if (this.noteCaughtUp(hub)) {
          // The manifest is the gate for every document's write too, and for the scan.
          this.scheduleManifest(30);
          this.scheduleScan(30);
          for (const runtime of this.docs.values()) this.scheduleWrite(runtime);
        }
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
    // A lapsed writer still watches: its scans wait for the lease (scheduleScan).
    if (!this.permanentFollower) this.startWatching();
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
    // A stalled provider can hold the queue's running task for good: wait a
    // bounded while, then go on. That task writes nothing after this point
    // (every write is fenced by diskGuard, which refuses once stopped).
    let queueTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.queue.catch(() => undefined),
      new Promise<void>((resolve) => { queueTimer = setTimeout(resolve, stopTimings.queueWaitMs); queueTimer.unref?.(); }),
    ]);
    clearTimeout(queueTimer);
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
        this.noteOwnWrite(target, stats);
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

  /**
   * Export the current text, PDF marks, comments and binaries even on a
   * follower, before deleting server access. `beginFence` makes the server stop
   * accepting document and comment writes and reports each document's final
   * sequence; everything is exported from state taken after that, so no late
   * change can exist only on the server. Returns the manifest sequence to delete against.
   */
  prepareLocalConversion(beginFence: () => Promise<ProjectClosingResponse>, options: { acceptIncompleteExport?: boolean } = {}): Promise<{ sequence: number; recovery: TakedownRecovery }> {
    return this.enqueueExplicit(async () => {
      const hub = this.manifestHub;
      if (!hub || !this.manifestReady() || !hub.getStatus().connected || hub.pendingCount > 0) {
        throw new ControlError(503, "offline", "Connect and sync this notebook before taking it down.");
      }
      const fence = await beginFence();
      await this.catchUpWithFence(fence);
      if (hub.pendingCount > 0) throw new ControlError(503, "offline", "Connect and sync this notebook before taking it down.");
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
      // The fence froze text, PDF marks and comments too: write the final text and the
      // PDF sidecars now, while the server can still answer, not after it is deleted.
      await this.preserveLatestText();
      try { await this.pdfs.exportLocal(); }
      catch (error) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not export the PDF notes`, error);
        throw new ControlError(503, "offline", "Could not export the PDF notes. The shared project was kept.");
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
      // The comment stores only the server holds (threads, suggestions, reviews, PDF comments): one pass, after the fence.
      const recovery = await this.exportCommentStores(fence, layout.paths, guard, options.acceptIncompleteExport === true);
      if (!await current()) throw new ControlError(409, "conflict", "The notebook changed during its local export. Retry taking it down.");
      return { sequence, recovery };
    });
  }

  /**
   * Writes every thread (with its messages), suggestion and review of every document the fence froze, PDF comments
   * included, to `_archive/shared-takedown-comments.json` in the notebook, and counts them: the server compares the
   * counts with what it holds before it deletes. A store that cannot be read stops the takedown, unless the owner
   * accepted an incomplete export, which is then recorded in the file and reported to the server.
   * One bounded pass: nothing is retried here.
   */
  private async exportCommentStores(fence: ProjectClosingResponse, paths: ReadonlyMap<string, string>, guard: WriteGuard, acceptIncomplete: boolean): Promise<TakedownRecovery> {
    const api = this.ctx.host.api;
    if (!api) throw new ControlError(503, "offline", "Connect and sync this notebook before taking it down.");
    const pathOfDoc = new Map<string, string>();
    for (const [fileId, relative] of paths) {
      const record = this.state.layout[fileId];
      if (record?.docId) pathOfDoc.set(record.docId, relative);
    }
    const recovery: TakedownRecovery = { threads: 0, messages: 0, suggestions: 0, reviews: 0 };
    const documents: Array<Record<string, unknown>> = [];
    const unreadable: string[] = [];
    for (const doc of fence.docs) {
      if (doc.kind === "manifest") continue;
      const label = pathOfDoc.get(doc.docId) ?? doc.docId;
      try {
        const threads = await api.listThreads(doc.docId);
        // A PDF has comment threads but no suggestions or reviews.
        const suggestions = doc.kind === "pdf" ? [] : await api.listSuggestions(doc.docId);
        const reviews = doc.kind === "pdf" ? [] : await api.listReviews(doc.docId);
        recovery.threads += threads.length;
        recovery.messages += threads.reduce((sum, thread) => sum + thread.messages.length, 0);
        recovery.suggestions += suggestions.length;
        recovery.reviews += reviews.length;
        if (threads.length || suggestions.length || reviews.length) documents.push({ docId: doc.docId, kind: doc.kind, path: label, threads, suggestions, reviews });
      } catch (error) {
        if (!acceptIncomplete) throw new ControlError(503, "offline", `Could not export the comments on ${label}. The shared project was kept; retry taking it down.`);
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: the comments on ${label} could not be exported`, error);
        unreadable.push(label);
      }
    }
    if (unreadable.length) recovery.incomplete = true;
    if (documents.length || unreadable.length) {
      const body = { version: 1, exportedAt: new Date().toISOString(), project: this.info.projectId, ...(unreadable.length ? { incomplete: unreadable } : {}), documents };
      const target = await resolveInside(this.info.root, `${ARCHIVE_DIRECTORY}/shared-takedown-comments.json`);
      await ensureDirectory(path.dirname(target), guard);
      await writeFileAtomic(target, Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8"), guard);
      await flushToDisk([target], []).catch(() => { throw new ControlError(503, "offline", "Could not make the exported comments durable. The shared project was kept."); });
    }
    return recovery;
  }

  /** Waits until every document this device holds open has the updates the takedown fence froze on the server. */
  private async catchUpWithFence(fence: ProjectClosingResponse): Promise<void> {
    const finalSeq = new Map(fence.docs.map((doc) => [doc.docId, doc.serverSeq]));
    const held = [
      this.info.manifestDocId,
      ...[...this.docs.values()].filter((doc) => this.docReady(doc)).map((doc) => doc.docId),
      ...this.pdfs.openDocIds(),
    ];
    const behind = () => held.filter((docId) => (this.ctx.host.store.getDocMeta(docId)?.lastSeenServerSeq ?? 0) < (finalSeq.get(docId) ?? 0));
    const deadline = Date.now() + HYDRATION_WAIT_MS;
    while (behind().length > 0) {
      if (this.stopped || Date.now() > deadline) throw new ControlError(503, "offline", "This notebook is still receiving its latest changes. The shared project was kept; retry taking it down.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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
        const bytes = await this.terminalBlobBytes(entry.blobHash);
        if (!bytes || sha256(bytes) !== entry.blobHash) { missing.push(relative); continue; }
        if (disk && !this.info.album) await this.archive(relative, contentGuard(target, expected, guard));
        await writeFileAtomic(target, bytes, contentGuard(target, disk && !this.info.album ? null : expected, guard));
      } catch {
        missing.push(relative);
      }
    }
    return missing;
  }

  /**
   * The bytes of a binary after the project was taken down: what this device already holds, else the server's
   * recovery copy for former members. One attempt each, no retry timer: access is gone, and the recovery window is bounded.
   */
  private async terminalBlobBytes(hash: string): Promise<Uint8Array | null> {
    const uploaded = this.uploadedBlobs.get(hash);
    if (uploaded) return uploaded;
    const cached = this.ctx.host.store.getBlob(hash);
    if (cached) {
      const bytes = await readWithin(cached.localPath, HYDRATION_WAIT_MS).catch(() => null);
      if (bytes && bytes !== SLOW_READ && sha256(bytes) === hash) return bytes;
    }
    const api = this.ctx.host.api;
    if (!api) return null;
    // Still a member (removed, or the takedown is not through yet): the normal route; once the project is gone, the recovery copy.
    return api.downloadBlob(this.info.projectId, hash).catch(() => api.downloadRecoveryBlob(this.info.projectId, hash)).catch(() => null);
  }

  /** True once every manifest entry has been placed on disk (join waits on this). */
  isMaterialized(): boolean {
    if (!this.manifestReady()) return false;
    // A follower's files arrive through the sync client: not materialized while any is awaited.
    if (this.follower) return this.manifestWasReady && this.awaitedOnDisk.size === 0;
    if (!this.manifestCaughtUp()) return false;
    const layout = computeLayout(this.readEntries().values());
    for (const [fileId, directory] of layout.paths) {
      const record = this.state.layout[fileId];
      if (!record) return false;
      if (record.kind === "folder" ? !this.placedFolders.has(directory) : !record.hash) return false;
    }
    for (const directory of layout.directories) if (this.folderErrors.has(directory)) return false;
    return true;
  }

  /** Why a folder of the manifest could not be placed on disk, in a sentence the user can act on (S52). */
  placementProblem(): string | null {
    for (const [directory, reason] of this.folderErrors) {
      return `Could not create the folder "${directory}" in this notebook's folder (${reason}). Check that the location is writable and has free space; Libera tries again by itself.`;
    }
    return null;
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
    if (!hub || hub.isClosed) return false;
    // A rollback to nothing raises no "server" change; hearing the server again ends the rebuilt state (H2).
    if (this.manifestRebuilt && hub.caughtUp) this.manifestRebuilt = false;
    if (this.manifestRebuilt) return false;
    return hubHasState(this.ctx.host, hub, "manifest");
  }

  /**
   * Records that `hub` heard the server's state since this runtime started.
   * True the first time. The SQLite cache alone does not count: a newer file
   * and its bookkeeping may have arrived through the cloud folder meanwhile,
   * and a cache older than them must not be taken for the baseline (finding 2).
   */
  private noteCaughtUp(hub: DocHub): boolean {
    // Caught up for the hub's current generation only: a new connection, a rollback or a lost update starts over (S53).
    if (hub.isClosed || !hub.caughtUp || this.caughtUp.get(hub.docId) === hub.catchUpGeneration) return false;
    this.caughtUp.set(hub.docId, hub.catchUpGeneration);
    return true;
  }

  /** The manifest has heard the server and the server has every local edit: only then are removals and moves final. */
  private manifestAcknowledged(): boolean {
    return this.manifestCaughtUp() && (this.manifestHub?.pendingCount ?? 0) === 0;
  }

  /** Retires the paths the manifest's entries left, once the server has the edit that moved them (M23). */
  private retireObserved(): void {
    if (!this.manifestAcknowledged()) {
      this.retiresDeferred = true;
      return;
    }
    this.retiresDeferred = false;
    const current = this.readEntries();
    for (const entry of this.observedEntries.values()) {
      if (current.get(entry.fileId)?.path !== entry.path) this.retirePath(entry.path, knownHashes(this.state.layout[entry.fileId], entry));
    }
    this.observedEntries = current;
  }

  private hubCaughtUp(hub: DocHub): boolean {
    this.noteCaughtUp(hub);
    return !hub.isClosed && hub.caughtUp;
  }

  /** The manifest has caught up with the server: until then a writer does no disk work. */
  private manifestCaughtUp(): boolean {
    return !!this.manifestHub && this.hubCaughtUp(this.manifestHub);
  }

  /** A document a writer may write, adopt or merge: its text is the server's, not an older cache of it. */
  private docWritable(runtime: DocRuntime): boolean {
    return this.docReady(runtime) && this.manifestCaughtUp() && this.hubCaughtUp(runtime.hub);
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
    const hub = this.manifestHub;
    if (hub && !this.follower && hub.caughtUp) this.epochFence = { hub, generation: hub.catchUpGeneration };
    try { await this.applyManifestPass(); } finally { this.epochFence = null; }
  }

  private async applyManifestPass(): Promise<void> {
    if (!this.manifestReady()) return;
    // A change the manifest holds only in memory is neither materialized nor followed up until SQLite has it (S54).
    if (this.manifestHub && !this.manifestHub.flushDurable()) {
      this.durableWaiting = true;
      return;
    }
    this.manifestWasReady = true;
    const pdfLive = this.pdfs.enabled;
    if (pdfLive !== this.pdfLiveSnapshot) {
      this.pdfLiveSnapshot = pdfLive;
      this.ctx.emit({ t: "project-changed", projectId: this.info.projectId });
    }
    if (this.permanentFollower) {
      this.followManifest();
      this.notifyAlbumChanged();
      return;
    }
    // A writer whose lease has lapsed neither follows the manifest nor touches the disk: its layout holds
    // the hashes and history of its own files. The pass runs when the lease is confirmed (C1).
    if (this.follower) {
      this.manifestDeferred = true;
      return;
    }
    // Hands off the disk until the server has answered; the status listener runs this again then.
    if (!this.manifestCaughtUp()) return;
    if (!(await this.rootAvailable())) {
      this.scheduleRetry();
      return;
    }
    this.entries = this.readEntries();
    const layout = computeLayout(this.entries.values());
    this.recordTransitions(layout);
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

    // Staged bytes of earlier moves whose placement failed: retry them before
    // anything else decides what the old and new paths hold (finding 29).
    const stagedMoves = new Map<string, "placed" | "archived">();
    const stagedWaiting = new Set<string>();
    if (!this.info.album) {
      const results = await placeStagedMoves(this.info.root, layout.paths, this.diskGuard(), { listed: new Set(this.entries.keys()) }).catch((error) => {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not retry staged moves`, error);
        return null;
      });
      if (results) {
        for (const move of results.placed) stagedMoves.set(move.fileId, move.outcome === "archived" ? "archived" : "placed");
        for (const fileId of results.waiting) stagedWaiting.add(fileId);
        if (results.waiting.size > 0) needsRetry = true;
      }
    }

    // Removed entries: archive files (never delete user data outright).
    for (const [fileId, record] of Object.entries(previous)) {
      if (layout.paths.has(fileId)) continue;
      this.retirePath(record.path, knownHashes(record));
      touched.add(record.path);
      vacated.add(record.kind === "folder" ? record.path : path.posix.dirname(record.path));
      // No tombstone here: the removal may still roll back (an optimistic delete
      // the server refuses, a manifest that lags). Only the server's own
      // document-deleted answer ends a document (finding 3).
      try {
        if (record.kind !== "folder") await this.archiveRemoved(record);
      } catch (error) {
        // One failing archive must not abort the pass: keep the record, so the
        // removal is retried, and go on with the other entries (finding 29).
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not archive ${record.path}`, error);
        next[fileId] = record;
        needsRetry = true;
        continue;
      }
      if (record.docId) {
        this.releaseDoc(record.docId);
        this.dropReconciliations(record.docId);
        await deleteBase(this.info.root, record.docId, this.diskGuard()).catch(() => undefined);
      }
      this.missingSince.delete(fileId);
    }

    // Moves, in two phases so swaps and chains (a→b, b→a) cannot collide.
    const staged: Array<{ fileId: string; staging: string; record: LayoutRecord }> = [];
    // Files whose bytes did not reach their new path: the layout keeps the old
    // path (and the hash that goes with it) until a pass places them (finding 29).
    const pending = new Set<string>();
    const occupied = new Set<string>();
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
      const early = stagedMoves.get(fileId);
      if (early) {
        // Placed from the journal above; its bytes are the file's own unless they were archived.
        next[fileId] = early === "archived" ? { ...record, path: desired, hash: undefined, size: undefined, mtimeMs: undefined } : { ...record, path: desired };
        continue;
      }
      if (stagedWaiting.has(fileId)) {
        next[fileId] = { ...record };
        pending.add(fileId);
        continue;
      }
      try {
        const source = await resolveInside(this.info.root, record.path);
        if (!(await statIfExists(source))) {
          next[fileId] = { ...record, path: desired, hash: undefined, size: undefined, mtimeMs: undefined };
          continue;
        }
        // The old name may already hold something else (a sync client reuses names):
        // only this entry's own bytes move. Anything else is new content the scanner
        // imports, and the entry is materialized at its destination from authority.
        const owner = await this.holdsOwnBytes(source, record);
        if (owner === SLOW_READ) throw new Error(`${record.path} is still downloading from the cloud folder`);
        if (!owner) {
          next[fileId] = { ...record, path: desired, hash: undefined, size: undefined, mtimeMs: undefined };
          continue;
        }
        // Never reuse an interrupted move's sole recovery artifact.
        const staging = path.join(this.info.root, ...STATE_DIRECTORY, "moving", `${fileId}-${randomId("move")}`);
        const journalled = !this.info.album;
        // Journal first: a crash after staging must not leave bytes with no record of where they were going.
        if (journalled) await writeMoveJournal(this.info.root, { fileId, source: record.path, destination: desired, staged: path.basename(staging), hash: owner.hash, stagedAt: Date.now() }, this.diskGuard());
        try {
          // Fenced to the source that was verified: replaced since (same name, other bytes), nothing moves.
          await movePath(source, staging, this.sourceGuard(source, owner.key));
        } catch (error) {
          if (journalled) await clearMoveJournal(this.info.root, path.basename(staging)).catch(() => undefined);
          throw error;
        }
        staged.push({ fileId, staging, record });
      } catch (error) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not move ${record.path}`, error);
        // Still at the old path, so the layout stays there and the next pass tries again.
        next[fileId] = { ...record };
        pending.add(fileId);
        occupied.add(record.path);
        needsRetry = true;
      }
    }
    for (const { fileId, staging, record } of staged) {
      const desired = layout.paths.get(fileId) as string;
      try {
        const target = await resolveInside(this.info.root, desired);
        // A file whose own move failed still sits there: it is not ours to archive.
        if (occupied.has(desired)) throw new DestinationTakenError(target);
        if (await statIfExists(target)) this.displacedPath(desired, await this.archive(desired));
        await movePathExclusive(staging, target, this.diskGuard());
        if (!this.info.album) await clearMoveJournal(this.info.root, path.basename(staging)).catch(() => undefined);
        next[fileId] = { ...record, path: desired };
        this.missingSince.delete(fileId);
      } catch (error) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not move ${record.path} to ${desired}`, error);
        // The staged bytes stay (journalled) for a later pass to place or resolve; they are never overwritten onto anything.
        // An album keeps no journal, so its file goes back where it was.
        if (this.info.album) await movePathExclusive(staging, await resolveInside(this.info.root, record.path), this.diskGuard()).catch(() => undefined);
        next[fileId] = { ...record };
        pending.add(fileId);
        needsRetry = true;
      }
    }

    // Folders.
    for (const directory of [...layout.directories].sort()) {
      try {
        const absolute = await resolveInside(this.info.root, directory);
        const stats = await statIfExists(absolute);
        if (stats && !stats.isDirectory()) this.displacedPath(directory, await this.archive(directory));
        if (!stats || !stats.isDirectory()) {
          await ensureDirectory(absolute, this.diskGuard());
          if (!(await statIfExists(absolute))?.isDirectory()) throw new Error("the folder was not created");
          touched.add(directory);
        }
        this.placedFolders.add(directory);
        this.folderErrors.delete(directory);
      } catch (error) {
        // Placement is confirmed, never assumed: the join status and isMaterialized see this.
        this.placedFolders.delete(directory);
        this.folderErrors.set(directory, error instanceof Error ? error.message : String(error));
        if (!(error instanceof PathRefusedError)) needsRetry = true;
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
      } else if (pending.has(fileId)) {
        // Its bytes are mid-move: placing from authority now would leave two copies.
        continue;
      } else if (entry.kind === "blob" && entry.blobHash && (record.hash !== entry.blobHash || this.baselineMissing.has(fileId))) {
        const placed = await this.placeBlob(entry, record);
        if (placed) touched.add(desired);
        // A blob on its download backoff wakes the manifest itself; the fixed-cadence retry would only spin.
        else if (!this.blobBackingOff(entry.blobHash as string)) needsRetry = true;
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
      if (record.kind === "doc" && record.docId && !pending.has(fileId) && (!record.hash || this.rootUnavailable || this.baselineMissing.has(fileId) || this.moveDeferred.has(record.docId))) {
        const runtime = this.docs.get(record.docId);
        this.moveDeferred.delete(record.docId);
        if (runtime && runtime.fileId === fileId && this.docWritable(runtime)) await this.materializeDoc(record.docId);
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
    const previousEntries = this.entries;
    this.entries = this.readEntries();
    const layout = computeLayout(this.entries.values());
    this.recordTransitions(layout);
    const previous = this.state.layout;
    const next: Record<string, LayoutRecord> = {};
    for (const [fileId, desired] of layout.paths) {
      const entry = this.entries.get(fileId) as ManifestEntry;
      next[fileId] = entry.kind === "doc" ? { path: desired, kind: "doc", docId: entry.docId, docKind: entry.docKind } : { path: desired, kind: entry.kind };
    }
    for (const [fileId, record] of Object.entries(previous)) {
      if (!next[fileId] || next[fileId].path !== record.path) {
        // A follower's record holds no hashes: the retired bytes are what the
        // manifest said and what the shared text held, so that a later
        // replacement is not taken for the removed file coming back (S44).
        const runtime = record.docId ? this.docs.get(record.docId) : undefined;
        const text = runtime && hubHasState(this.ctx.host, runtime.hub, "content") ? runtime.hub.getText("content") : null;
        this.retirePath(record.path, retirementHashes(record, previousEntries.get(fileId), text));
      }
      // Released, not tombstoned: only the server's document-deleted answer ends a document (finding 3).
      if (record.docId && next[fileId]?.docId !== record.docId) this.releaseDoc(record.docId);
    }
    for (const [fileId, record] of Object.entries(next)) if (record.docId) this.ensureDoc(record.docId, fileId);
    this.pdfs.sync(this.entries.values(), layout.paths);
    const blobs = new Map<string, { hash: string; size: number }>();
    for (const [fileId, entry] of this.entries) if (entry.kind === "blob" && entry.blobHash && layout.paths.has(fileId)) blobs.set(fileId, { hash: entry.blobHash, size: entry.size ?? -1 });
    const knownBlobs = this.followerBlobs;
    this.followerBlobs = blobs;
    this.pruneAwaited(next);
    if (JSON.stringify(previous) === JSON.stringify(next)) {
      // Same names, new bytes: the old file on disk is not the arrival.
      if (knownBlobs && Object.keys(previous).length > 0) this.awaitReplacedBlobs(knownBlobs, blobs, next);
      return;
    }
    this.state.layout = next;
    this.ctx.layoutChanged(this.info.projectId);
    this.treeChanged(previous, next);
    this.awaitDisk(previous, next, blobs);
    if (knownBlobs) this.awaitReplacedBlobs(knownBlobs, blobs, next);
  }

  private armDiskTimer(): void {
    if (this.awaitedOnDisk.size === 0 || this.followerDiskTimer) return;
    this.followerDiskTimer = setInterval(() => void this.checkAwaitedDisk(), this.ctx.timings.followerDiskMs);
    this.followerDiskTimer.unref?.();
  }

  /** A path the manifest no longer puts there (or no longer takes away) has nothing left to arrive. */
  private pruneAwaited(next: Record<string, LayoutRecord>): void {
    const paths = new Set(Object.values(next).map((record) => record.path));
    for (const [relative, awaited] of this.awaitedOnDisk) if (paths.has(relative) !== awaited.present) this.awaitedOnDisk.delete(relative);
  }

  /** Blobs that kept their path but not their bytes: wait for the disk file to reach the new hash. */
  private awaitReplacedBlobs(known: Map<string, { hash: string; size: number }>, blobs: Map<string, { hash: string; size: number }>, next: Record<string, LayoutRecord>): void {
    const until = Date.now() + this.ctx.timings.followerDiskWaitMs;
    for (const [fileId, blob] of blobs) {
      const before = known.get(fileId);
      if (before && before.hash !== blob.hash && next[fileId]) this.awaitedOnDisk.set(next[fileId].path, { present: true, until, blob });
    }
    this.armDiskTimer();
  }

  /**
   * A follower has no watcher, and the writer changes the disk after the
   * manifest, so the tree a window read on tree-changed can be out of date.
   * This says when the disk catches up, which through a sync client can take
   * minutes. The first read of the manifest (an empty `previous`) is tracked
   * too: its files may not have reached this disk either (finding 23).
   */
  private awaitDisk(previous: Record<string, LayoutRecord>, next: Record<string, LayoutRecord>, blobs: Map<string, { hash: string; size: number }>): void {
    const until = Date.now() + this.ctx.timings.followerDiskWaitMs;
    if (Object.keys(previous).length === 0) {
      for (const [fileId, record] of Object.entries(next)) {
        if (record.kind === "folder") continue;
        const blob = blobs.get(fileId);
        this.awaitedOnDisk.set(record.path, { present: true, until, initial: true, ...(blob ? { blob } : {}) });
      }
      this.armDiskTimer();
      return;
    }
    for (const [fileId, record] of Object.entries(previous)) {
      if (next[fileId]?.path !== record.path) this.awaitedOnDisk.set(record.path, { present: false, until });
    }
    for (const [fileId, record] of Object.entries(next)) {
      if (previous[fileId]?.path !== record.path) this.awaitedOnDisk.set(record.path, { present: true, until });
    }
    this.armDiskTimer();
  }

  private async checkAwaitedDisk(): Promise<void> {
    if (!this.follower) {
      this.stopAwaitingDisk();
      return;
    }
    const arrived: string[] = [];
    for (const [relative, awaited] of [...this.awaitedOnDisk]) {
      if (awaited.nextAt !== undefined && Date.now() < awaited.nextAt) continue;
      const target = await resolveInside(this.info.root, relative).catch(() => null);
      const found = target === null ? null : await statIfExists(target);
      let settled = target !== null && (found !== null) === awaited.present;
      if (settled && awaited.blob && target !== null) {
        // Hashing a large file every second is the cost to avoid: hash only a
        // file of the expected size whose stats moved since the last look at
        // this manifest hash. The memo holds more than size and mtime (a
        // delivery can keep both), and is dropped when the wait is re-armed.
        const stats = found;
        const signature = stats ? `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}:${awaited.blob.hash}` : "";
        settled = false;
        if (stats && (awaited.blob.size < 0 || stats.size === awaited.blob.size)) {
          if (awaited.initial) {
            // Present at the expected size from the start: not worth hashing every file on every open.
            settled = true;
          } else if (signature !== awaited.probed && !isDataless(stats)) {
            awaited.probed = signature;
            const bytes = await readIfExists(target);
            settled = bytes !== null && sha256(bytes) === awaited.blob.hash;
          }
        }
      }
      // Replaced or pruned while it was being looked at: the newer entry is judged on its own.
      if (this.awaitedOnDisk.get(relative) !== awaited) continue;
      if (settled) {
        // Present from the start is not an arrival to announce.
        if (!awaited.initial || awaited.waited) arrived.push(relative);
        this.awaitedOnDisk.delete(relative);
        continue;
      }
      awaited.waited = true;
      const now = Date.now();
      if (now >= awaited.until) {
        // Not given up: it may take a sync client much longer. Probe less and less often, and hash again.
        awaited.delay = Math.min(FOLLOWER_DISK_MAX_PROBE_MS, (awaited.delay ?? this.ctx.timings.followerDiskMs) * 2);
        awaited.nextAt = now + awaited.delay;
        awaited.probed = undefined;
      }
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

  /**
   * What a blob's destination holds, from one read: its stats and hash (the
   * bytes too, to place without a download when they are the blob). An
   * online-only placeholder is not read; our own record answers when its
   * stats are the ones this host recorded, else the hash is unknown (undefined).
   */
  private async observeDestination(target: string, record: LayoutRecord): Promise<DestinationView | typeof SLOW_READ> {
    const before = await statIfExists(target);
    if (!before) return { stats: null, hash: null };
    if (isDataless(before)) {
      const recorded = record.hash !== undefined && record.size === before.size && record.mtimeMs === before.mtimeMs;
      return { stats: before, hash: recorded ? record.hash : undefined };
    }
    const bytes = await readWithin(target, HYDRATION_WAIT_MS);
    if (bytes === SLOW_READ) return SLOW_READ;
    const after = await statIfExists(target);
    // Replaced while it was read: what was read says nothing about what is there now.
    if (bytes === null || !after || statsKey(after) !== statsKey(before)) throw new WriteCancelledError();
    return { stats: after, hash: sha256(bytes), bytes };
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
    // A writer that has not heard the server yet may be holding an older manifest than the files on disk.
    if (!this.manifestCaughtUp()) return false;
    // The destination is read and hashed once. A download can outlive an
    // external edit, so afterwards only its stats are looked at again (a read
    // only if they moved), and each disk commit verifies those stats: no more
    // whole-file reads of a large file, and an online-only placeholder is
    // never downloaded just to be compared (finding 38).
    // A provider that stalls must not hold the project queue (handoff, takedown, stop wait on it).
    let observed: DestinationView | typeof SLOW_READ;
    try { observed = await this.observeDestination(target, record); }
    catch (error) {
      if (!(error instanceof WriteCancelledError)) this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not read ${record.path}`, error);
      return false;
    }
    if (observed === SLOW_READ) return false;
    const delivered = observed.bytes && observed.hash === hash;
    const bytes = delivered ? observed.bytes as Uint8Array : await this.blobBytes(hash);
    if (!bytes) return false;
    if (!delivered) {
      const again = await statIfExists(target).catch(() => undefined);
      if (again === undefined || statsKey(again) !== statsKey(observed.stats)) {
        try {
          const fresh = await this.observeDestination(target, record);
          if (fresh === SLOW_READ) return false;
          observed = fresh;
        } catch { return false; }
      }
    }
    const guard = this.diskGuard();
    const canCommit = guard.canCommit;
    let expected: string | null = observed.stats ? statsKey(observed.stats) : null;
    guard.canCommit = async () => {
      if (!(await canCommit()) || !this.manifestReady()) return false;
      const current = this.readEntries();
      if (current.get(entry.fileId)?.blobHash !== hash || computeLayout(current.values()).paths.get(entry.fileId) !== record.path) return false;
      const stats = await statIfExists(target);
      return (stats ? statsKey(stats) : null) === expected;
    };
    try {
      const existingHash = observed.hash;
      const existingStats = observed.stats;
      if (existingHash === hash) {
        if (!(await guard.canCommit())) return false;
        setMaterialized(record, hash, existingStats?.size, existingStats?.mtimeMs);
        this.baselineMissing.delete(entry.fileId);
        return true;
      }
      // An online-only file nobody explains (existingHash undefined) is archived like any unexplained one.
      if (existingHash !== null && existingHash !== record.hash && !(existingHash !== undefined && existingStats && isStaleCopy(record, existingHash, existingStats.mtimeMs))) {
        this.baselineMissing.add(entry.fileId);
        const archived = await this.archive(record.path, guard);
        // An entry never placed here claiming a path: what was there is a local file that was not shared.
        if (!record.hash) this.displacedPath(record.path, archived);
        expected = null;
      }
      const stats = await writeFileAtomic(target, bytes, guard);
      this.noteOwnWrite(target, stats);
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
    // A blob that keeps failing is tried on a growing delay, not on every pass.
    if (this.blobBackingOff(hash)) return null;
    try {
      const bytes = await api.downloadBlob(this.info.projectId, hash);
      this.blobFailures.delete(hash);
      this.refusedLogged.delete(`blob:${hash}`);
      return bytes;
    } catch (error) {
      const count = (this.blobFailures.get(hash)?.count ?? 0) + 1;
      const delay = Math.min(MAX_BLOB_RETRY_MS, this.ctx.timings.retryMs * 2 ** (count - 1));
      this.blobFailures.set(hash, { count, nextAt: Date.now() + delay });
      // The server says it has no such blob, or it failed repeatedly: the entry
      // cannot be resolved. Say so once, then keep trying only on the backoff.
      const missing = error instanceof ApiClientError && error.status === 404;
      if ((missing || count >= UNRESOLVABLE_BLOB_FAILURES) && !this.refusedLogged.has(`blob:${hash}`)) {
        this.refusedLogged.add(`blob:${hash}`);
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: refused blob ${hash}: ${missing ? "the server does not have it" : `it could not be downloaded ${count} times`}. Its file is not placed.`, error);
      } else if (count < UNRESOLVABLE_BLOB_FAILURES && !missing) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not download blob ${hash}`, error);
      }
      this.later(delay, () => { this.scheduleManifest(0); });
      return null;
    }
  }

  /** True while a blob's last download failed and its next try is not due. */
  private blobBackingOff(hash: string): boolean {
    const failure = this.blobFailures.get(hash);
    return failure !== undefined && failure.nextAt > Date.now();
  }

  /**
   * Moves a file or folder into the notebook's local archive (`_archive`),
   * which is never shared. An album keeps no such copies: a photo removed
   * from the album, or replaced by a member's newer version, is deleted from
   * every member's computer (members keep a photo by saving it to their
   * gallery, which copies it out of the album).
   */
  private async archive(relative: string, guard = this.diskGuard()): Promise<string | null> {
    let source: string;
    try {
      source = await resolveInside(this.info.root, relative);
    } catch {
      return null;
    }
    if (!(await statIfExists(source))) return null;
    if (!(await guard.canCommit())) throw new WriteCancelledError();
    if (this.info.album) {
      await fs.rm(source, { recursive: true, force: true });
      return null;
    }
    const archiveRoot = path.join(this.info.root, ARCHIVE_DIRECTORY);
    const archived = await movePathUnique(source, archiveRoot, path.posix.basename(relative), guard);
    return path.relative(this.info.root, archived).split(path.sep).join("/");
  }

  /**
   * A file nobody had shared (not yet imported) was archived because an incoming
   * entry claims its path (S47). The path-keyed records of the displaced file
   * (annotations, tags, sidecars) must not stay behind for the new occupant: the
   * file's identity is its archive path, so a move from the claimed path to it is
   * recorded in state.json and told to Next as a tree move under a synthetic file
   * id, which Next's follow-up moves the records along with.
   */
  private displacedPath(relative: string, archived: string | null): void {
    if (!archived) return;
    const fileId = `displaced-${sha256(new TextEncoder().encode(archived)).slice(0, 24)}`;
    this.state.displaced = [...(this.state.displaced ?? []), { fileId, from: relative, to: archived, at: Date.now() }].slice(-100);
    this.saveSoon();
    // Also in the durable transition log, before the tree event (as recordTransitions does): Next moves this computer's records at the claimed path to the archived file on the next drain, and a crash or a lost event does not lose it.
    if (!this.info.album) {
      try {
        this.ctx.host.store.commitManifestPaths(this.info.projectId, { upserts: [], removals: [], transitions: [{ fileId, kind: "file", from: relative, to: archived, at: Date.now() }] });
      } catch (error) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not record the move of the displaced file ${relative}`, error);
      }
    }
    this.ctx.emit({
      t: "tree-changed", projectId: this.info.projectId, notebook: this.info.notebook,
      added: [], moves: [{ from: this.liberaPath(relative), to: this.liberaPath(archived), fileId }], removed: [],
    });
  }

  private sourceGuard(source: string, verifiedKey: string): WriteGuard {
    const base = this.diskGuard();
    return { root: base.root, canCommit: async () => await base.canCommit() && statsKey(await statIfExists(source)) === verifiedKey };
  }

  /**
   * Whether the bytes at `source` are the entry's own: the hash this host last
   * placed or adopted (any earlier one too), or for a document its base text.
   * A file the entry never had there is someone else's.
   */
  private async holdsOwnBytes(source: string, record: LayoutRecord): Promise<{ hash: string; key: string } | false | typeof SLOW_READ> {
    const known = new Set(knownHashes(record));
    if (record.docId) {
      const base = await readBase(this.info.root, record.docId).catch(() => null);
      if (base !== null) known.add(sha256(encodeText(base)));
    }
    if (known.size === 0) return false;
    const before = await statIfExists(source);
    // An online-only placeholder is never read (downloaded) just to check it: not provably ours, so it stays put.
    if (!before || isDataless(before)) return false;
    // Same size and mtime prove nothing (S46): the bytes are hashed, once; the caller fences the move to this stat.
    const bytes = await readWithin(source, HYDRATION_WAIT_MS).catch(() => null);
    if (bytes === SLOW_READ) return SLOW_READ;
    if (bytes === null) return false;
    const after = await statIfExists(source);
    if (!after || statsKey(after) !== statsKey(before)) return false;
    const hash = sha256(bytes);
    return known.has(hash) ? { hash, key: statsKey(after) as string } : false;
  }

  /** Keep the latest CRDT text as well as any distinct on-disk version. */
  private async archiveRemoved(record: LayoutRecord): Promise<void> {
    // Not archived is not removed: the pass keeps the record and tries again (M10).
    if (!(await this.rootAvailable())) throw new WriteCancelledError();
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

  /** Commits a manifest change; returns the bytes of its (single) update. A control caller gets an error, not success, for a change SQLite did not take (S54). */
  private async writeManifest(fn: (files: Y.Map<unknown>, doc: Y.Doc) => void, provenance: Provenance): Promise<number> {
    if (provenance.source === "external-file" && this.follower) throw new WriteCancelledError();
    const hub = this.manifestHub;
    if (!hub) throw new Error("The manifest is not open.");
    // An automatic import commits only against a manifest that has heard the server (S53).
    if (provenance.source === "external-file" && !this.manifestCaughtUp()) throw new WriteCancelledError();
    let bytes = 0;
    // Every entry write goes through here, so this is where field changes are noted as intents.
    trackEntryWrites(this.manifestDoc().getMap<unknown>(ManifestKeys.files), this.manifestIntents, () => { bytes = hub.applyLocalChange("manifest", (doc) => {
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
    }, provenance)?.length ?? 0; });
    this.entries = this.readEntries();
    if (!hub.flushDurable()) {
      // The change is applied in memory and retried by the hub on a backoff, but a crash now would lose it.
      this.durableWaiting = true;
      if (provenance.source !== "external-file") {
        throw new ControlError(503, "not-saved", "The change could not be saved on this computer yet (the collaboration database is busy or unavailable). Files and records were not changed. Libera keeps trying to save it; check the notebook before repeating the action.");
      }
    }
    return bytes;
  }

  /**
   * Writes operations in groups whose real encoded size stays near the batch
   * budget (S50): each group's actual update size sets the next group's length,
   * so thousands of long-path entries never become one oversized update.
   */
  private async writeManifestOperations(operations: Array<(map: Y.Map<unknown>, doc: Y.Doc) => void>, provenance: Provenance): Promise<void> {
    let group = 256;
    for (let index = 0; index < operations.length;) {
      const slice = operations.slice(index, index + group);
      const bytes = await this.writeManifest((map, doc) => { for (const operation of slice) operation(map, doc); }, provenance);
      index += slice.length;
      if (bytes > 0) group = Math.max(1, Math.min(1024, Math.floor(MANIFEST_BATCH_BYTES / Math.max(1, bytes / slice.length))));
    }
  }

  /** After a merge (or an acknowledgement): writes again a field change that a concurrent whole-entry write reverted. */
  private scheduleIntents(): void {
    if (this.manifestIntents.size === 0 || this.intentsScheduled || this.stopped) return;
    this.intentsScheduled = true;
    // Not inside the hub's own notification: the write below is a transaction of its own.
    queueMicrotask(() => {
      this.intentsScheduled = false;
      const hub = this.manifestHub;
      if (this.stopped || !hub || !this.canEdit || !this.manifestCaughtUp()) return;
      const files = this.manifestDoc().getMap<unknown>(ManifestKeys.files);
      const rewrites = this.manifestIntents.reconcile(files, hub.pendingCount === 0);
      if (rewrites.size === 0) return;
      void this.writeManifest((map) => {
        for (const [fileId, record] of rewrites) if (map.has(fileId)) map.set(fileId, record);
      }, { source: "typing" }).catch((error) => this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not restore a concurrent change`, error));
    });
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
    // Fenced on the bytes the caller read (after the file settled): a change
    // made since then is another person's version and is never replaced.
    const stats = await writeFileAtomic(absolute, stripped, contentGuard(absolute, sha256(bytes), this.diskGuard()));
    this.noteOwnWrite(absolute, stats);
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
      // A document belongs to one file id. A second entry naming it is a malformed manifest: keep the first binding.
      if (existing.fileId !== fileId) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: document ${docId} is listed under file ${fileId} but belongs to ${existing.fileId}; keeping the first`);
        return;
      }
      existing.hub.reviveDeleted();
      return;
    }
    const hub = this.ctx.host.acquire(docId, { kind: "file", projectId: this.info.projectId });
    // The manifest lists it, so an older tombstone (a rolled-back delete) must not keep it shut.
    hub.reviveDeleted();
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
        // Ready from the cache first, then caught up with the server: the second is when a writer may write.
        // A rollback to an empty document raises no "server" change: hearing the server again ends it (H2).
        if (runtime.rebuilt && hub.caughtUp) runtime.rebuilt = false;
        if ((!runtime.wasReady && this.docReady(runtime)) || this.noteCaughtUp(hub)) this.scheduleWrite(runtime);
      }),
      hub.onMeta((meta) => this.metaChanged(meta.role, meta.readOnlyReason)),
    );
    if (this.docReady(runtime)) this.scheduleWrite(runtime);
  }

  private releaseDoc(docId: string): void {
    const runtime = this.docs.get(docId);
    if (!runtime) return;
    this.docs.delete(docId);
    this.moveDeferred.delete(docId);
    if (runtime.writeTimer) clearTimeout(runtime.writeTimer);
    for (const unsubscribe of runtime.unsubscribe) unsubscribe();
    this.ctx.host.release(docId);
  }

  private docReady(runtime: DocRuntime): boolean {
    if (runtime.hub.isClosed) return false;
    // Same as manifestReady: the server's answer after a rollback may carry no change to observe (H2).
    if (runtime.rebuilt && runtime.hub.caughtUp) runtime.rebuilt = false;
    if (runtime.rebuilt) return false;
    const ready = hubHasState(this.ctx.host, runtime.hub, "content");
    if (ready) runtime.wasReady = true;
    return ready;
  }

  private scheduleWrite(runtime: DocRuntime): void {
    if (this.stopped) return;
    if (this.follower) {
      // A lapsed writer's dirty documents are written once its lease is confirmed.
      if (!this.permanentFollower) this.writesDeferred = true;
      return;
    }
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

  /** The manifest wants the file somewhere else than its layout record says: its move is still pending. */
  private movePending(fileId: string, record: LayoutRecord): boolean {
    const desired = computeLayout(this.readEntries().values()).paths.get(fileId);
    return desired !== undefined && desired !== record.path;
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
    if (!runtime || !found || this.reconciliationFor(docId) || !this.docWritable(runtime)) return;
    const { fileId, record } = found;
    if (this.movePending(fileId, record)) {
      // The layout keeps the old path until a pass places the file (its bytes are
      // staged or mid-move): writing here would leave a second copy at the old name.
      this.moveDeferred.add(docId);
      return;
    }
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
        // Someone edited the file since our last write. Another program may still
        // be writing it, so it waits out the same quiet period the scanner applies
        // (finding 28); the scan then takes the edit in and merges it first.
        const stats = await statIfExists(target);
        const wait = stats ? quietWaitMs(stats, Date.now(), this.ctx.timings.importQuietMs) : 0;
        if (wait > 0) {
          this.scheduleScan(Math.ceil(wait) + 50);
          return;
        }
        await this.takeExternalEdit(runtime, record, disk, diskHash);
        return;
      }
      if (diskHash === hash) {
        await this.adopt(fileId, record, hash, text, target);
        return;
      }
      if (!record.hash) {
        try { this.displacedPath(record.path, await this.archive(record.path, contentGuard(target, expected, this.diskGuard()))); }
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
    // A record holding this hash has its base written already (a busy base clears the hash).
    const baseCurrent = record.hash === hash;
    let stats;
    if (expected === hash) {
      // The file already holds these bytes: rewriting it only gives the sync client work.
      stats = await statIfExists(target);
      if (!stats) { this.scheduleScan(0); this.scheduleRetry(); return false; }
    } else {
      try { stats = await writeFileAtomic(target, bytes, contentGuard(target, expected, base)); }
      catch (error) {
        if (!(error instanceof WriteCancelledError)) throw error;
        this.scheduleScan(0); this.scheduleRetry(); return false;
      }
    }
    this.noteOwnWrite(target, stats);
    setMaterialized(record, hash, stats.size, stats.mtimeMs);
    if (!baseCurrent) await this.writeBaseOrRetry(record, runtime.docId, text);
    this.baselineMissing.delete(runtime.fileId);
    this.ctx.host.store.upsertDoc({ docId: runtime.docId, projectId: this.info.projectId, fileId: runtime.fileId, path: record.path, materializedHash: hash });
    this.saveSoon(TEXT_FLUSH_SAVE_MS);
    if (expected !== hash) this.filesChanged([record.path]);
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
    // Identical bytes with the stats already recorded: nothing to remember (finding 39).
    if (!changed && record.size === stats?.size && record.mtimeMs === stats?.mtimeMs) return;
    setMaterialized(record, hash, stats?.size, stats?.mtimeMs);
    if (record.docId) {
      if (changed) await this.writeBaseOrRetry(record, record.docId, text);
      this.ctx.host.store.upsertDoc({ docId: record.docId, projectId: this.info.projectId, fileId, path: record.path, materializedHash: hash });
    }
    this.saveSoon(TEXT_FLUSH_SAVE_MS);
  }

  /**
   * A text file changed on disk. If the shared text is still what we last
   * wrote, the disk edit becomes minimal CRDT edits by the local user.
   * Otherwise both sides moved: open a reconciliation and touch neither.
   */
  private async takeExternalEdit(runtime: DocRuntime, record: LayoutRecord, disk: Uint8Array, diskHash: string): Promise<void> {
    if (this.follower || !this.docWritable(runtime)) return;
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
    // A single update over the server's limit can never sync, so a very large
    // edit goes in several transactions, applied from the back so earlier offsets stay valid.
    const chunks = chunkTextEdits(edits);
    chunks.forEach((chunk, chunkIndex) => {
      hub.applyLocalChange(
        "content",
        (doc) => {
          const text = doc.getText(ContentKeys.source);
          if (chunkIndex === 0 && text.toString() !== from) throw new Error("The shared text changed while edits were computed.");
          for (const op of chunk) {
            if (op.del > 0) text.delete(op.pos, op.del);
            if (op.text) text.insert(op.pos, op.text);
          }
        },
        provenance,
      );
    });
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
      this.savedState = null;
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
        // On battery the debounce stretches like the poll does.
        this.scheduleScan(this.ctx.timings.settleMs * this.powerScale());
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
      this.maybeRetrustWatcher();
      this.scheduleScan(0);
      this.schedulePoll();
    }, delay);
    this.pollTimer.unref?.();
  }

  /**
   * A watcher caught missing one change (a stream broken by sleep, say) is
   * trusted again after its wait, with nothing to show it works. That only
   * relaxes the poll: the missed-event check starts afresh with the next walk
   * (a further miss distrusts it for twice as long), and small files keep the
   * short verifyMs, since a miss that leaves every stat equal cannot be seen.
   */
  private maybeRetrustWatcher(): void {
    if (this.watchRetrustAt == null || !this.watcher || performance.now() < this.watchRetrustAt) return;
    this.watchRetrustAt = null;
    this.watcherTrusted = true;
    this.forgetWatchHistory();
  }

  /** The power source changed. */
  powerChanged(): void {
    this.retimePoll();
  }

  /**
   * The computer woke up: what changed while it slept may have no watcher event
   * (and the watcher may be trusted), so the next scan reads each small file
   * again whatever its verification age. Large files keep their own schedule.
   */
  resumed(): void {
    this.resumedAt = performance.now();
    if (this.pollTimer) this.scheduleScan(0);
  }

  /** The service renewed this writer's lease: a scan refused while it had lapsed runs now. */
  leaseConfirmed(): void {
    if (this.manifestDeferred) {
      this.manifestDeferred = false;
      this.scheduleManifest(0);
    }
    if (this.writesDeferred) {
      this.writesDeferred = false;
      for (const runtime of this.docs.values()) this.scheduleWrite(runtime);
    }
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
   * pollMs until watchRetrustMs has passed (see maybeRetrustWatcher).
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
      const wait = this.ctx.timings.watchRetrustMs * 2 ** Math.min(this.watchMisses, 4);
      this.watchMisses += 1;
      this.watchRetrustAt = performance.now() + wait;
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${missed} changed without a file-watch event; checking the folder every ${Math.round(this.pollInterval() / 1000)} s for the next ${Math.round(wait / 60_000)} min`);
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
      if (delay > 0) due = Math.min(due, this.scanFirstAt + SCAN_MAX_WAIT_MS * this.powerScale());
      clearTimeout(this.scanTimer);
    } else {
      this.scanFirstAt = now;
    }
    // A debounce never replaces a forced scan (returned above), so this is the armed scan's kind.
    this.scanForced = delay === 0;
    this.scanDueAt = due;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      const forced = this.scanForced;
      this.scanForced = false;
      void this.startScan(forced);
    }, Math.max(0, due - now));
    this.scanTimer.unref?.();
  }

  private async startScan(forced: boolean): Promise<void> {
    // One queued scan at a time: it starts later and sees what came since.
    if (this.scanQueued) return;
    if (!forced && await this.ownWritesOnly()) return;
    if (this.scanQueued) return;
    this.scanQueued = true;
    void this.enqueue(async () => {
      this.scanQueued = false;
      await this.scan();
    });
  }

  /**
   * Remembers what this host's own write left on disk (the file's exact stat,
   * under the spelling it was written with), so the watcher event that write
   * raises can be told from anybody else's change. Recorded after the write
   * has completed; an event that arrives before that is simply scanned.
   */
  private noteOwnWrite(absolute: string, stats: Stats): void {
    const relative = path.relative(this.info.root, absolute).split(path.sep).join("/");
    if (!relative || relative.startsWith("..")) return;
    const writes = scanReadState(this).ownWrites;
    const at = performance.now();
    if (writes.size > 512) for (const [key, own] of writes) if (at - own.at > OWN_WRITE_TTL_MS) writes.delete(key);
    writes.set(manifestPathKey(relative), { relative, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, at });
  }

  /**
   * Whether every path the watcher reported is this host's own recent write,
   * unchanged since: same spelling, size, mtime, ctime and inode as recorded
   * when it was written (and as the bookkeeping holds). A preserved-size,
   * preserved-mtime edit still moves the ctime, so it is not mistaken for it.
   * Walking the whole notebook for that is wasted work (the poll still
   * verifies on its schedule). Those paths are dropped from the dirty set; any
   * other event, or a stat that cannot be taken quickly, leaves everything for
   * the scan.
   */
  private async ownWritesOnly(): Promise<boolean> {
    if (this.stopped || this.verifyAll || this.dirtyPaths.size === 0) return false;
    const records = new Map<string, LayoutRecord>();
    for (const record of Object.values(this.state.layout)) if (record.kind !== "folder" && record.hash) records.set(manifestPathKey(record.path), record);
    const reported = [...this.dirtyPaths];
    // Out of the dirty set while the stats are read: an event that arrives
    // meanwhile is then kept, not removed together with these.
    for (const relative of reported) this.dirtyPaths.delete(relative);
    if (await this.reportedAreOwnWrites(reported, records)) {
      // Something arrived while the stats were taken: it has its own debounce.
      if (this.dirtyPaths.size > 0) this.scheduleScan(this.ctx.timings.settleMs * this.powerScale());
      return true;
    }
    for (const relative of reported) this.dirtyPaths.add(relative);
    return false;
  }

  private async reportedAreOwnWrites(reported: string[], records: Map<string, LayoutRecord>): Promise<boolean> {
    const writes = scanReadState(this).ownWrites;
    for (const relative of reported) {
      const record = records.get(manifestPathKey(relative));
      if (!record || record.size === undefined || record.mtimeMs === undefined) return false;
      const own = writes.get(manifestPathKey(relative));
      if (!own || own.relative !== relative || record.path !== relative || performance.now() - own.at > OWN_WRITE_TTL_MS) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slow = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HYDRATION_WAIT_MS); timer.unref?.(); });
      const stats = await Promise.race([
        resolveInside(this.info.root, relative).then((absolute) => statIfExists(absolute)).catch(() => null),
        slow,
      ]);
      clearTimeout(timer);
      if (!stats || !stats.isFile() || stats.size !== record.size || stats.mtimeMs !== record.mtimeMs) return false;
      if (stats.size !== own.size || stats.mtimeMs !== own.mtimeMs || stats.ctimeMs !== own.ctimeMs || stats.ino !== own.ino) return false;
    }
    return !this.stopped && !this.verifyAll;
  }

  /** Turns differences between the folder and the layout into document edits and manifest operations. */
  private async scan(): Promise<void> {
    if (!this.manifestReady() || this.follower) { this.missingSince.clear(); return; }
    // Judged against a cached manifest older than the server's, a file the
    // server already has looks new and one it moved looks deleted. The
    // manifest's catch-up schedules a scan (status listener in start()).
    if (!this.manifestCaughtUp()) { this.missingSince.clear(); return; }
    if (!(await this.rootAvailable())) {
      this.missingSince.clear();
      return;
    }
    const scanReads = scanReadState(this);
    // A tree over the walk cap is walked again only after a growing delay.
    if (scanReads.blockedUntil > Date.now()) return;
    const walkStartedAt = performance.now();
    const walked = await this.walk();
    if (!walked.complete) {
      // Neither a cap nor repeated partial subtree coverage establishes a
      // deletion. Restart the grace period after a complete observation.
      this.missingSince.clear();
      if (walked.truncated) {
        const delay = noteTruncatedWalk(scanReads, this.ctx.timings.retryMs, Date.now());
        if (!scanReads.warnedTruncated) {
          scanReads.warnedTruncated = true;
          this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: the folder holds more than 50000 files and folders, so external changes are not imported; checking again in ${Math.round(delay / 1000)} s.`);
        }
        this.scheduleScan(delay);
      } else this.scheduleRetry();
      return;
    }
    scanReads.incompleteWalks = 0;
    scanReads.warnedTruncated = false;
    // The folder can disappear while the asynchronous walk is running.
    if (!(await this.rootAvailable())) {
      this.missingSince.clear();
      return;
    }
    const previous = structuredClone(this.state.layout);
    const files = new Map<string, WalkEntry>();
    const directories = new Map<string, WalkEntry>();
    for (const entry of walked.entries) (entry.kind === "file" ? files : directories).set(entry.relative, entry);
    // The manifest compares names as manifestPathKey (case-folded NFC); a
    // cloud-delivered alternate spelling of a known name is that file, not a move.
    const fileKeys = new Map<string, WalkEntry>();
    for (const entry of files.values()) fileKeys.set(manifestPathKey(entry.relative), fileKeys.get(manifestPathKey(entry.relative)) ?? entry);
    const directoryKeys = new Set([...directories.values()].map((entry) => manifestPathKey(entry.relative)));
    // How many spellings of a name the disk holds: with two (a case-sensitive
    // volume) nothing says which one a manifest name became.
    const fileVariants = new Map<string, number>();
    for (const entry of files.values()) fileVariants.set(manifestPathKey(entry.relative), (fileVariants.get(manifestPathKey(entry.relative)) ?? 0) + 1);
    const directoryByKey = new Map<string, WalkEntry[]>();
    for (const entry of directories.values()) directoryByKey.set(manifestPathKey(entry.relative), [...(directoryByKey.get(manifestPathKey(entry.relative)) ?? []), entry]);
    const skipped = new Set(walked.skipped.map(manifestPathKey));
    // Compared as manifest keys: fs.watch can spell a name differently
    // (Unicode normalization, case) from the walk on the same volume.
    const dirty = new Set([...this.dirtyPaths].map(manifestPathKey));
    this.dirtyPaths = new Set();
    const verifyAll = this.verifyAll;
    this.verifyAll = false;
    this.noticeMissedEvents(files, verifyAll, walkStartedAt);
    const known = new Set([...Object.values(this.state.layout), ...this.readEntries().values()].map((record) => manifestPathKey(record.path)));
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
    /** Files sat out this scan after failed reads: they are looked at again later, with a growing wait. */
    let skippedRetry = false;
    /** The shortest wait until a file another program is still changing counts as quiet. */
    let quietDeferMs = Infinity;
    /** Bytes still to read this scan, tracked files and new ones alike. */
    let readBudget = SCAN_READ_BUDGET_BYTES;
    const fair = this.scanFairness;
    fair.beginPass();
    /** Known names another program spelled differently on disk (case, Unicode form): they take the disk's spelling and keep their ID (S39). */
    const respelled: Array<{ fileId: string; record: LayoutRecord; to: string }> = [];
    const noteRespelling = (fileId: string, record: LayoutRecord, variants: WalkEntry[] | undefined) => {
      const to = variants?.length === 1 ? variants[0].relative : null;
      if (!to || to === record.path || !isShareablePath(to)) {
        this.respellSeen.delete(fileId);
        return;
      }
      // A normalization-only difference (no case change) in an entry another device spelled that way: this disk or sync client keeps the other form, and renaming it back would start a rename back and forth between devices.
      if (to.normalize("NFC") === record.path.normalize("NFC") && this.state.remoteRespells?.[fileId]?.path === record.path) {
        if (!this.respellLogged.has(fileId)) {
          this.respellLogged.add(fileId);
          this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} is spelled differently on this computer's disk (Unicode form). The shared name stays as another device set it.`);
        }
        this.respellSeen.delete(fileId);
        return;
      }
      // A rename in progress, or the volume's own spelling of a name Libera just wrote, settles by the next scan (the usual cadence; no timer of its own).
      if (this.respellSeen.get(fileId) !== to) {
        this.respellSeen.set(fileId, to);
        return;
      }
      respelled.push({ fileId, record, to });
    };

    for (const [fileId, record] of fair.order(Object.entries(this.state.layout), ([id]) => id)) {
      const recordKey = manifestPathKey(record.path);
      if ([...skipped].some((item) => recordKey === item || recordKey.startsWith(`${item}/`))) {
        this.missingSince.delete(fileId);
        continue;
      }
      if (record.kind === "folder") {
        if (directoryKeys.has(recordKey)) {
          this.missingSince.delete(fileId);
          this.renameDeferrals.delete(fileId);
          this.renameDeferrals.delete(`unsettled:${fileId}`);
          if (directories.has(record.path)) this.respellSeen.delete(fileId);
          else noteRespelling(fileId, record, directoryByKey.get(recordKey));
        } else missing.push(fileId);
        continue;
      }
      const exact = files.get(record.path);
      const seen = exact ?? fileKeys.get(recordKey);
      if (!seen) {
        if (record.hash && !this.baselineMissing.has(fileId)) missing.push(fileId);
        continue;
      }
      this.missingSince.delete(fileId);
      this.renameDeferrals.delete(fileId);
      this.renameDeferrals.delete(`unsettled:${fileId}`);
      if (exact) this.respellSeen.delete(fileId);
      else noteRespelling(fileId, record, fileVariants.get(recordKey) === 1 ? [seen] : undefined);
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
      // A small file verified before the last wake is read again: what changed during sleep may have no event.
      const verificationCurrent = verification !== undefined && performance.now() - verification.at < this.verificationAge(fileId, seen.size, verification.pending === true) &&
        (seen.size >= LARGE_FILE_BYTES || verification.at >= this.resumedAt);
      if (!record.hash || (!verifyAll && !touchedByWatch && settled && sameStats && verificationCurrent)) continue;
      // An online-only placeholder with this host's size and mtime holds no
      // local bytes that could have changed; reading it to verify would
      // download it (and every other one, at each verification).
      if (seen.dataless && record.size === seen.size && record.mtimeMs === seen.mtimeMs) {
        this.verified.set(fileId, { ctimeMs: seen.ctimeMs, at: performance.now() });
        continue;
      }
      // A tracked file that grew past what the server takes cannot be shared
      // whatever it holds: it is neither read nor hashed (nor downloaded).
      if (seen.size > MAX_UPLOAD_BYTES) {
        if (!scanReads.oversized.has(seen.relative)) {
          scanReads.oversized.add(seen.relative);
          this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${seen.relative} is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB a shared file can be, so its changes are not checked.`);
        }
        continue;
      }
      // A path whose read failed sits out some scans, so it cannot take the budget at every one.
      if (fair.skipped(fileId)) {
        skippedRetry = true;
        continue;
      }
      // One scan reads a bounded amount in all; the rest waits for the next
      // and goes first there.
      if (seen.size > readBudget) {
        fair.leftOut(fileId);
        needsRetry = true;
        continue;
      }
      // Charged when the read starts: one given up on keeps reading in the background.
      readBudget -= seen.size;
      const absolute = await resolveInside(this.info.root, seen.relative).catch(() => null);
      const read = absolute ? await readShared(absolute, HYDRATION_WAIT_MS, seen, this) : null;
      if (read === SLOW_READ) {
        fair.failed(fileId);
        needsRetry = true;
        continue;
      }
      fair.served(fileId);
      let bytes: Uint8Array | null = read;
      if (!bytes || !absolute) continue;
      // Pending until what it found is handled; see settleVerification.
      this.verified.set(fileId, { ctimeMs: seen.ctimeMs, at: performance.now(), pending: true });
      let hash = sha256(bytes);
      const settleSame = () => {
        this.baselineMissing.delete(fileId);
        this.settleVerification(fileId);
        // A verification that found nothing new must not rewrite state.json.
        if (record.size !== seen.size || record.mtimeMs !== seen.mtimeMs) {
          Object.assign(record, { size: seen.size, mtimeMs: seen.mtimeMs });
          this.saveSoon();
        }
      };
      if (hash === record.hash) {
        settleSame();
        continue;
      }
      // An open SQLite database (sidecar beside it) cannot be copied
      // consistently; it is looked at again once it is closed, as a new file is.
      if (record.kind === "blob" && isActiveSqliteDatabase(this.info.root, seen.relative)) {
        this.verified.delete(fileId);
        needsRetry = true;
        continue;
      }
      // Another program may still be writing these bytes: the verification
      // stays pending and the file is judged once it has been quiet a while.
      const stillChanging = quietWaitMs(seen, now, this.ctx.timings.importQuietMs);
      if (stillChanging > 0) {
        quietDeferMs = Math.min(quietDeferMs, stillChanging);
        // Not a verification: the follow-up scan must read the file again even
        // when its size and mtime are what the record already holds.
        this.verified.delete(fileId);
        continue;
      }
      // Only a settled file is rewritten (an album's location details are
      // removed), and only if it still holds the bytes just read.
      if (record.kind === "blob" && this.canEdit) {
        let stripped: { bytes: Uint8Array; size: number; mtimeMs: number } | null = null;
        try {
          stripped = await this.stripForUpload(absolute, seen.relative, bytes);
        } catch (error) {
          // The file changed under the rewrite, or it could not be written
          // (disk full, read-only, denied): judge it again next scan rather
          // than uploading photo bytes that still carry location data.
          if (!(error instanceof WriteCancelledError)) this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not remove the location details from ${seen.relative}, so it is not shared yet.`, error);
          this.verified.delete(fileId);
          needsRetry = true;
          continue;
        }
        if (stripped) {
          bytes = stripped.bytes;
          hash = sha256(bytes);
          Object.assign(seen, { size: stripped.size, mtimeMs: stripped.mtimeMs });
          if (hash === record.hash) {
            settleSame();
            continue;
          }
        }
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
      // The upload took time: publish the new hash only if the file on disk is
      // still the snapshot that was hashed (same stat, same bytes).
      // Both waits are bounded: a provider that hangs here must not stop the project queue.
      // readShared answers SLOW_READ when the file changed or the read did not finish; either way nothing is published.
      const reread = await readShared(absolute, HYDRATION_WAIT_MS, seen, this);
      if (reread === SLOW_READ || !reread || sha256(reread) !== hash) {
        this.verified.delete(fileId);
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

    // A known name another program spelled differently (case, Unicode form)
    // is a rename to the spelling on disk: the ID stays, and the manifest,
    // the tree and Check Notebook's exact-name rule agree (S39). Same name
    // key, so nothing is retired.
    for (const { fileId, record, to } of respelled) {
      const from = record.path;
      const folder = record.kind === "folder";
      this.respellSeen.delete(fileId);
      this.ownRespells.add(fileId);
      touched.add(from).add(to);
      operations.push((map, doc) => {
        const current = readManifest(doc).get(fileId);
        if (!current || current.path !== from || !this.pathFree(doc, to, fileId, folder)) return;
        map.set(fileId, entryRecord({ ...current, path: to, updatedAt: now }));
        if (!folder) {
          for (const ink of this.inkCompanionMoves(doc, from, to, false, now)) map.set(ink.fileId, entryRecord(ink));
          for (const transcript of this.transcriptCompanionMoves(doc, from, to, now)) map.set(transcript.fileId, entryRecord(transcript));
          for (const python of this.pythonCompanionMoves(doc, from, to, now)) map.set(python.fileId, entryRecord(python));
        }
        record.path = to;
        if (record.docId) this.ctx.host.store.upsertDoc({ docId: record.docId, projectId: this.info.projectId, fileId, path: to, materializedHash: record.hash ?? null });
      });
    }

    // New files and folders the layout does not know.
    const fresh: Array<{ entry: WalkEntry; bytes: Uint8Array | null; hash: string; quiet: boolean }> = [];
    /** Bytes of new files held in memory (readBudget is shared with the tracked files above). */
    let retainedBytes = 0;
    // A rename needs the new file's bytes only when a missing record has its size.
    const missingSizes = new Set<number | undefined>();
    for (const fileId of missing) {
      const record = this.state.layout[fileId];
      if (record && record.kind !== "folder" && record.hash) missingSizes.add(record.size);
    }
    /** Document kinds of new files that have not settled: a missing document of such a kind may be their rename (S40). */
    const arriving = new Set<string | null>();
    /** Folders (as manifest keys) holding such files: no folder entry is made for them yet, and a missing folder waits (S43). */
    const unsettledDirectories = new Set<string>();
    /** Sizes of such files: a missing binary of one of them waits too (its bytes are not known yet, so only its size can say it may be that file). */
    const unsettledSizes = new Set<number>();
    const noteUnsettled = (relative: string, size: number) => {
      arriving.add(docKindForPath(relative));
      unsettledSizes.add(size);
      for (let at = relative.lastIndexOf("/"); at > 0; at = relative.lastIndexOf("/", at - 1)) unsettledDirectories.add(manifestPathKey(relative.slice(0, at)));
    };
    for (const [relative, entry] of fair.order([...files], ([name]) => `path:${name}`)) {
      if (known.has(manifestPathKey(relative))) continue;
      // An external LaTeX build's products would be uploaded again at every compile.
      if (isGeneratedPath(relative)) continue;
      // An open SQLite database (sidecar beside it) cannot be copied consistently.
      if (isActiveSqliteDatabase(this.info.root, relative)) continue;
      // A fresh device without bookkeeping cannot distinguish a new file
      // from a delayed copy of a deleted identity. Explicit file operations
      // remain available; leave unexplained disk bytes untouched.
      // Judge a file only once it has arrived; the poll comes back to it.
      if (mayStillBeCopying(entry, now)) {
        noteUnsettled(relative, entry.size);
        // A new empty file is judged once its settle time is over (no wait is known for a Finder copy: the watcher or the poll comes back).
        const emptyWait = emptyFileWaitMs(entry, now);
        if (emptyWait > 0) quietDeferMs = Math.min(quietDeferMs, emptyWait);
        continue;
      }
      // And once no program has changed it for a while: a copy can pause
      // with some of its bytes in place.
      const stillChanging = quietWaitMs(entry, now, this.ctx.timings.importQuietMs);
      // A rename changes ctime as well. A file the size of a missing one is
      // read now, so the pair is found before the delete grace restores the
      // old path; it only counts as new once it is quiet (checked below).
      const renameCandidate = stillChanging > 0 && missingSizes.has(entry.size);
      if (stillChanging > 0 && !renameCandidate) {
        quietDeferMs = Math.min(quietDeferMs, stillChanging);
        noteUnsettled(relative, entry.size);
        continue;
      }
      // Reading an online-only file downloads it: decide from the stat first.
      // Above the server's limit nothing could be uploaded; with the adoption
      // fence up nothing is shared, so bytes matter only to a rename, a
      // returning removed file, or a Dropbox conflict copy.
      if (entry.size > MAX_UPLOAD_BYTES) {
        if (!scanReads.oversized.has(relative)) {
          scanReads.oversized.add(relative);
          this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${relative} is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB a shared file can be, so it is not shared.`);
        }
        continue;
      }
      if (this.state.externalAdoptionRequired
        && !missingSizes.has(entry.size) && !missingSizes.has(undefined)
        && !this.retired.has(manifestPathKey(relative)) && !this.conflictCopyOf(relative, "")) continue;
      const freshKey = `path:${relative}`;
      // A file not read this scan (it sits out, or waits for budget or a read slot) may be a missing one moved: those wait for it (H9).
      if (fair.skipped(freshKey)) {
        skippedRetry = true;
        noteUnsettled(relative, entry.size);
        continue;
      }
      // One scan hydrates a bounded amount; the rest waits for the next and goes first there.
      if (entry.size > readBudget) {
        fair.leftOut(freshKey);
        needsRetry = true;
        noteUnsettled(relative, entry.size);
        continue;
      }
      const absolute = await resolveInside(this.info.root, relative).catch(() => null);
      const read = absolute ? await readShared(absolute, HYDRATION_WAIT_MS, entry, this) : null;
      if (read === SLOW_READ) {
        fair.failed(freshKey);
        needsRetry = true;
        noteUnsettled(relative, entry.size);
        continue;
      }
      fair.served(freshKey);
      let bytes: Uint8Array | null = read;
      if (!bytes) continue;
      readBudget -= entry.size;
      const hash = sha256(bytes);
      // Not the bytes of a missing file after all: judged like any other new file, once quiet.
      if (renameCandidate && ![...missing].some((fileId) => this.state.layout[fileId]?.hash === hash)) {
        quietDeferMs = Math.min(quietDeferMs, stillChanging);
        // Same size as a missing file but other bytes: a rename and an edit that kept the length is still possible.
        noteUnsettled(relative, entry.size);
        continue;
      }
      const lateCopy = this.isLateCopy(relative, hash);
      const conflictOf = lateCopy ? null : this.conflictCopyOf(relative, hash);
      if ((lateCopy || conflictOf) && stillChanging === 0) {
        // Fenced on the bytes just judged: an album deletes the file, so a
        // different photo that replaced it meanwhile must survive.
        const guard = contentGuard(absolute as string, hash, this.diskGuard());
        const canCommit = guard.canCommit;
        guard.canCommit = async () => await canCommit() && this.pathFree(this.manifestDoc(), relative);
        await this.archive(relative, guard);
        this.reportArchived(relative, conflictOf ? "conflict-copy" : "removed", lateCopy && this.retirementEvidence(relative) === "unknown");
        touched.add(relative);
        continue;
      }
      // Contents are kept only up to a budget; the rest is read again when shared.
      if (retainedBytes + bytes.byteLength > FRESH_RETAIN_BYTES) bytes = null;
      else retainedBytes += bytes.byteLength;
      fresh.push({ entry, bytes, hash, quiet: stillChanging === 0 });
    }

    // Delete + create of the same bytes is a rename (or a move), but only when
    // nothing else could explain the new file: a delayed original or an
    // intentional byte-identical copy looks the same. Anything ambiguous is
    // imported as a new entry instead (the missing one is restored as usual).
    /** Renames this pass pairs, for a folder that moved with its files. */
    const paired: Array<{ fileId: string; from: string; to: string }> = [];
    /** Missing entries whose pairing waits for a clearer absence: neither restored nor paired this pass (S41). */
    const held = new Set<string>();
    /** Reconciliations opened for a rename that was also edited; announced once the manifest is written. */
    const openedReconciliations: Reconciliation[] = [];
    const holdPairing = (fileId: string, candidate: (typeof fresh)[number]): void => {
      const count = (this.renameDeferrals.get(fileId) ?? 0) + 1;
      // Held for a few scans (the usual cadence, no timer); if the absence never clears, the old path is restored and the new file imported (nothing is lost).
      if (count > MAX_RENAME_DEFERRALS) {
        this.renameDeferrals.delete(fileId);
        return;
      }
      this.renameDeferrals.set(fileId, count);
      held.add(fileId);
      fresh.splice(fresh.indexOf(candidate), 1);
    };
    /** The manifest rename of one file (S42: its companions move as in an explicit rename). */
    const planRename = (fileId: string, entry: ManifestEntry, record: LayoutRecord, match: (typeof fresh)[number], reconciliation?: Reconciliation) => {
      const from = record.path;
      paired.push({ fileId, from, to: match.entry.relative });
      // Files of one moved folder can pair in different scans: later scans still know where earlier ones went.
      const recent = scanScratch(this).recentMoves;
      recent.push({ from, to: match.entry.relative, at: Date.now() });
      if (recent.length > MAX_RECENT_MOVES) recent.shift();
      touched.add(from).add(match.entry.relative);
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
        for (const ink of this.inkCompanionMoves(doc, from, match.entry.relative, false, now)) map.set(ink.fileId, entryRecord(ink));
        // A recording's transcript and a note's Python code follow it, as in an explicit rename.
        for (const transcript of this.transcriptCompanionMoves(doc, from, match.entry.relative, now)) {
          map.set(transcript.fileId, entryRecord(transcript));
          touched.add(transcript.path);
        }
        for (const python of this.pythonCompanionMoves(doc, from, match.entry.relative, now)) {
          map.set(python.fileId, entryRecord(python));
          touched.add(python.path);
        }
        this.retirePath(from, knownHashes(record));
        Object.assign(record, { path: match.entry.relative, size: match.entry.size, mtimeMs: match.entry.mtimeMs });
        if (reconciliation) {
          this.state.reconciliations = [...this.state.reconciliations.filter((item) => item.docId !== reconciliation.docId), reconciliation];
          openedReconciliations.push(reconciliation);
        }
        if (record.docId) this.ctx.host.store.upsertDoc({ docId: record.docId, projectId: this.info.projectId, fileId, path: record.path, materializedHash: record.hash ?? null });
      });
    };
    /** Whether a move to `to` keeps what an explicit rename keeps (type, ink, transcript, Python code); otherwise it is not a rename (S42). */
    const keepsRecords = (entry: ManifestEntry | undefined, from: string, to: string): boolean => {
      if (!entry) return false;
      try {
        this.assertRenameKeepsRecords(entry, from, to);
        return true;
      } catch (error) {
        if (!(error instanceof ControlError)) throw error;
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${to} is not taken for ${from} renamed. ${error.message} ${from} was put back and ${to} is kept as a separate file.`);
        return false;
      }
    };
    for (const fileId of [...missing]) {
      const record = this.state.layout[fileId];
      if (record.kind === "folder" || !record.hash) continue;
      const candidates = fresh.filter((candidate) => candidate.hash === record.hash);
      if (candidates.length !== 1 || !compatibleKind(record, candidates[0].entry.relative)) continue;
      const sameBytes = Object.entries(this.state.layout).filter(([otherId, other]) => otherId !== fileId && other.kind !== "folder" && other.hash === record.hash);
      if (sameBytes.length > 0 || [...missing].some((otherId) => otherId !== fileId && this.state.layout[otherId]?.hash === record.hash)) continue;
      // The original must still be absent now, not only when the walk began.
      const absence = await this.sourceAbsence(record);
      if (absence === "present") continue;
      // A placeholder that is not the missing file's own stat, or a disk that will not say: do not hand over the identity yet.
      const placeholder = candidates[0].entry.dataless === true && (record.size !== candidates[0].entry.size || record.mtimeMs !== candidates[0].entry.mtimeMs);
      if (absence === "uncertain" || placeholder) {
        holdPairing(fileId, candidates[0]);
        continue;
      }
      const entry = this.entries.get(fileId);
      if (!keepsRecords(entry, record.path, candidates[0].entry.relative)) continue;
      const index = fresh.indexOf(candidates[0]);
      const [match] = fresh.splice(index, 1);
      missing.splice(missing.indexOf(fileId), 1);
      this.missingSince.delete(fileId);
      this.renameDeferrals.delete(fileId);
      if (!this.canEdit || !entry) continue;
      planRename(fileId, entry, record, match);
    }

    // A rename and an edit before the scan (S40): the bytes match nothing, but
    // one missing document and one new text file of its type are plainly the
    // same note. The document keeps its ID and moves to the new name; its
    // shared text and the edited disk text wait for the user as a
    // reconciliation, so neither input is lost or guessed. Uses the bytes
    // this scan already read.
    for (const fileId of [...missing]) {
      if (held.has(fileId) || !this.canEdit) continue;
      const record = this.state.layout[fileId];
      if (record.kind !== "doc" || !record.docId || !record.hash) continue;
      const runtime = this.docs.get(record.docId);
      if (!runtime || this.reconciliationFor(record.docId) || !hubHasState(this.ctx.host, runtime.hub, "content")) continue;
      const kind = docKindForPath(record.path);
      if ([...missing].some((otherId) => otherId !== fileId && this.state.layout[otherId]?.kind === "doc" && docKindForPath(this.state.layout[otherId].path) === kind)) continue;
      const trackedHashes = new Set(Object.values(this.state.layout).map((other) => other.hash));
      const edited = fresh.filter((candidate) => candidate.bytes && !trackedHashes.has(candidate.hash) && docKindForPath(candidate.entry.relative) === kind && compatibleKind(record, candidate.entry.relative));
      if (edited.length !== 1) continue;
      const diskText = decodeText(edited[0].bytes as Uint8Array);
      const sharedText = runtime.hub.getText("content");
      if (diskText === null || !similarText(sharedText, diskText)) continue;
      if ((await this.sourceAbsence(record)) !== "absent") continue;
      const entry = this.entries.get(fileId);
      if (!keepsRecords(entry, record.path, edited[0].entry.relative)) continue;
      const [match] = fresh.splice(fresh.indexOf(edited[0]), 1);
      missing.splice(missing.indexOf(fileId), 1);
      this.missingSince.delete(fileId);
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} looks renamed to ${match.entry.relative} and edited outside Libera; both versions are kept until you choose in the reconcile view.`);
      planRename(fileId, entry as ManifestEntry, record, match, {
        id: randomId("rec"),
        docId: record.docId,
        path: this.liberaPath(match.entry.relative),
        shared: sharedText,
        disk: diskText,
        base: (await readBase(this.info.root, record.docId)) ?? "",
        detectedAt: now,
      });
    }

    // A folder moved with its files (S43): when every file below a missing
    // folder entry was paired to the same names under one new folder, the
    // folder entry moves too and keeps its ID, instead of a second folder
    // identity appearing next to a restored copy of the old one. Works from
    // this pass's pairs; no second walk.
    // A folder entry whose directory is back on disk but empty (this host's own materialization can re-create it between the outside move and the scan) is a candidate too, when every file it held left by a paired move.
    const emptied: string[] = [];
    const recentMoves = scanScratch(this).recentMoves.filter((move) => move.at === undefined || now - move.at < RECENT_MOVE_MS);
    if (recentMoves.length > 0 || paired.length > 0) {
      const names = [...files.keys(), ...directories.keys()].map(manifestPathKey);
      for (const [folderId, folderRecord] of Object.entries(this.state.layout)) {
        if (folderRecord.kind !== "folder" || missing.includes(folderId) || !directoryKeys.has(manifestPathKey(folderRecord.path))) continue;
        const prefix = `${manifestPathKey(folderRecord.path)}/`;
        if (![...recentMoves, ...paired].some((move) => manifestPathKey(move.from).startsWith(prefix))) continue;
        if (names.some((name) => name.startsWith(prefix))) continue;
        if (Object.values(this.state.layout).some((other) => other.kind !== "folder" && manifestPathKey(other.path).startsWith(prefix) && !paired.some((move) => move.from === other.path))) continue;
        emptied.push(folderId);
      }
    }
    for (const fileId of [...missing, ...emptied]) {
      const record = this.state.layout[fileId];
      if (record.kind !== "folder" || !this.canEdit) continue;
      const from = record.path;
      const depth = from.split("/").length;
      const below = (relative: string) => manifestPathKey(relative).startsWith(`${manifestPathKey(from)}/`);
      const inside = Object.entries(this.state.layout).filter(([otherId, other]) => otherId !== fileId && other.kind !== "folder" && below(other.path));
      const pairedNow = paired.filter((move) => below(move.from));
      // Every file still below the folder paired in this pass; files that moved in earlier scans are remembered.
      const moves = [...recentMoves.filter((move) => below(move.from) && !(pairedNow as Array<{ from: string; to: string }>).includes(move)), ...pairedNow];
      if (moves.length === 0 || !inside.every(([, other]) => pairedNow.some((move) => move.from === other.path))) continue;
      let destination: string | null = null;
      for (const move of moves) {
        const rest = move.from.split("/").slice(depth);
        const target = move.to.split("/");
        const where = target.length > rest.length ? target.slice(0, target.length - rest.length).join("/") : "";
        if (!where || manifestPathKey(target.slice(target.length - rest.length).join("/")) !== manifestPathKey(rest.join("/")) || (destination !== null && destination !== where)) {
          destination = null;
          break;
        }
        destination = where;
      }
      if (!destination || !directories.has(destination)) continue;
      const target = destination;
      // The destination may already have its own folder entry (made by an earlier scan, before this one could pair): the old entry's absence is explained by the paired moves, so it is removed instead of restored, and the destination's entry stays.
      const hasFolderAt = (relative: string) => Object.values(this.state.layout).some((other) => other.kind === "folder" && manifestPathKey(other.path) === manifestPathKey(relative));
      const moved: Array<{ id: string; record: LayoutRecord; to: string; merge: boolean }> = [{ id: fileId, record, to: target, merge: hasFolderAt(target) }];
      for (const [otherId, other] of Object.entries(this.state.layout)) {
        if (otherId === fileId || other.kind !== "folder" || !below(other.path) || !missing.includes(otherId)) continue;
        const to = [target, ...other.path.split("/").slice(depth)].join("/");
        if (directories.has(to)) moved.push({ id: otherId, record: other, to, merge: hasFolderAt(to) });
      }
      for (const item of moved) {
        if (missing.includes(item.id)) missing.splice(missing.indexOf(item.id), 1);
        this.missingSince.delete(item.id);
        known.add(manifestPathKey(item.to));
        touched.add(item.record.path).add(item.to);
      }
      operations.push((map, doc) => {
        const current = readManifest(doc).get(fileId);
        if (!current || current.kind !== "folder" || current.path !== from || (!moved[0].merge && !this.pathFree(doc, target, fileId, true))) return;
        for (const item of moved) {
          const entry = readManifest(doc).get(item.id);
          if (!entry || entry.kind !== "folder") continue;
          if (item.merge) {
            map.delete(item.id);
            delete this.state.layout[item.id];
            continue;
          }
          map.set(item.id, entryRecord({ ...entry, path: item.to, updatedAt: now }));
          item.record.path = item.to;
        }
        for (const ink of this.inkCompanionMoves(doc, from, target, true, now)) map.set(ink.fileId, entryRecord(ink));
        this.retirePath(from);
      });
    }

    // A new file of a missing document's kind is still arriving or changing
    // (a rename followed by an edit): the document is neither restored nor
    // paired yet, so the next scans can pair it once the file is quiet. Held
    // for a bounded number of scans.
    for (const fileId of missing) {
      const record = this.state.layout[fileId];
      const waiting = record.kind === "folder" ? unsettledDirectories.size > 0
        : record.kind === "doc" ? Boolean(record.hash) && arriving.has(docKindForPath(record.path))
          : Boolean(record.hash) && record.size !== undefined && unsettledSizes.has(record.size);
      if (held.has(fileId) || !this.canEdit || !waiting) continue;
      // Held while the new files settle, for a bounded time (not a number of scans: a busy folder is scanned many times in one quiet period).
      const holdKey = `unsettled:${fileId}`;
      const since = this.renameDeferrals.get(holdKey) ?? now;
      if (now - since > this.ctx.timings.importQuietMs * 3 + 5000) {
        this.renameDeferrals.delete(holdKey);
        continue;
      }
      this.renameDeferrals.set(holdKey, since);
      held.add(fileId);
    }

    // Absence has no causality: a provider can deliver a deletion days after
    // a restore. Only explicit host delete operations remove shared entries.
    // Retain the manifest and recover the working copy on the next pass.
    for (const fileId of missing) {
      if (held.has(fileId)) continue;
      this.baselineMissing.add(fileId);
      this.missingSince.delete(fileId);
      // Nothing in the folder says whether it was moved out of the notebook
      // (then what left is now a copy) or lost; the shared one comes back.
      const restored = this.state.layout[fileId];
      if (restored) this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${restored.path} is no longer in the folder, so the shared ${restored.kind === "folder" ? "folder" : "copy"} is put back. A file moved out of a shared notebook stays shared here, and the moved one is only a copy. Delete it in Libera to remove it for everyone.`);
    }
    if (missing.some((fileId) => !held.has(fileId))) this.scheduleManifest(0);
    if (this.canEdit) {
      for (const candidate of fresh) {
        if (this.state.externalAdoptionRequired) continue;
        // Read early only to look for a rename; it counts as new once quiet.
        if (!candidate.quiet) {
          quietDeferMs = Math.min(quietDeferMs, Math.max(1, quietWaitMs(candidate.entry, now, this.ctx.timings.importQuietMs)));
          continue;
        }
        // A name with no room for its `.transcript` / `.json` sidecars is not
        // shared (existing entries are not affected); the notebook says why once.
        const nameProblem = manifestNewNameError(candidate.entry.relative);
        if (nameProblem) {
          if (!scanReads.oversized.has(candidate.entry.relative)) {
            scanReads.oversized.add(candidate.entry.relative);
            this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${candidate.entry.relative} is not shared. ${nameProblem}`);
          }
          continue;
        }
        let candidateBytes = candidate.bytes;
        if (!candidateBytes) {
          const absolute = await resolveInside(this.info.root, candidate.entry.relative).catch(() => null);
          const again = absolute ? await readShared(absolute, HYDRATION_WAIT_MS, candidate.entry, this) : null;
          if (!again || again === SLOW_READ || sha256(again) !== candidate.hash) {
            needsRetry = true;
            continue;
          }
          candidateBytes = again;
        }
        const created = await this.createFromDisk(candidate.entry, candidateBytes, candidate.hash, accountId, now);
        if (!created) {
          needsRetry = true;
          continue;
        }
        operations.push((map, doc) => {
          const record = this.pendingLayout.get(created.fileId);
          this.pendingLayout.delete(created.fileId);
          if (this.isLateCopy(created.path, candidate.hash) || !this.pathFree(doc, created.path)) return;
          // The file enters the layout with its manifest entry, never before (C4).
          if (record) this.state.layout[created.fileId] = record;
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
        if (known.has(manifestPathKey(relative)) || unsettledDirectories.has(manifestPathKey(relative)) || this.pathRetired(relative) || this.state.externalAdoptionRequired || isGeneratedPath(`${relative}/x`)) continue;
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
        this.pendingLayout.clear();
        this.missingSince.clear();
        return;
      }
      try {
        await this.writeManifestOperations(operations, EXTERNAL);
      } finally {
        // Files whose manifest entry was not written (a cancelled or failed write) never joined the layout.
        this.pendingLayout.clear();
      }
      if (addedPhotos.length > 0) this.reportAddedPhotos(addedPhotos);
      for (const reconciliation of openedReconciliations) this.ctx.emit({ t: "reconcile-needed", reconciliation });
      if (openedReconciliations.length > 0) this.ctx.emit({ t: "project-changed", projectId: this.info.projectId });
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
    fair.keepOnly(new Set([...Object.keys(this.state.layout), ...[...files.keys()].map((name) => `path:${name}`)]));
    if (quietDeferMs !== Infinity) this.scheduleScan(Math.ceil(quietDeferMs) + 50);
    if (needsRetry) this.scheduleRetry();
    else if (skippedRetry) {
      // Only files sitting out after failed reads are left: come back with a growing wait, so a file that stays unreadable is not walked for every few seconds.
      const delay = Math.min(MAX_SKIPPED_RETRY_MS, this.ctx.timings.retryMs * 2 ** Math.min(6, scanReads.skippedRetries));
      scanReads.skippedRetries += 1;
      this.scheduleScan(delay * this.powerScale());
    } else scanReads.skippedRetries = 0;
  }

  /** Whether a missing entry's old path is really gone: the disk may also fail to say (S41). */
  private async sourceAbsence(record: LayoutRecord): Promise<"absent" | "present" | "uncertain"> {
    try {
      const original = await resolveInside(this.info.root, record.path);
      return (await statIfExists(original)) ? "present" : "absent";
    } catch {
      return "uncertain";
    }
  }

  private retirePath(relative: string, hashes: string[] = []): void {
    const key = manifestPathKey(relative);
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
  private isLateCopy(relative: string, hash: string): boolean {
    const hashes = this.retired.get(manifestPathKey(relative));
    if (hashes === undefined) return false;
    if (hashes.has(hash)) return true;
    // Bytes the retired entry never had are not that file, whatever their
    // mtime says (a photo copied in keeps its camera's old mtime). With no
    // history at all nothing can tell them apart; a notebook sets the file
    // aside in `_archive`, but an album deletes, so it imports instead.
    return hashes.size === 0 && !this.info.album;
  }

  /** What is known about a retired path's old bytes: nothing retired, known versions, or no history at all (S44). */
  private retirementEvidence(relative: string): "none" | "hashes" | "unknown" {
    const hashes = this.retired.get(manifestPathKey(relative));
    return hashes === undefined ? "none" : hashes.size === 0 ? "unknown" : "hashes";
  }

  private reportArchived(relative: string, reason: "removed" | "conflict-copy" = "removed", unknownHistory = false): void {
    this.ctx.logger.warn(reason === "conflict-copy"
      ? `Shared notebook ${this.info.notebook}: ${relative} looks like a sync conflict copy of a shared file, so it was set aside instead of shared.`
      : unknownHistory
        ? `Shared notebook ${this.info.notebook}: ${relative} is at the name of a removed file and this computer does not know what that file held, so it was set aside in _archive instead of shared. To keep it, restore it from _archive or add it again under another name.`
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

  /**
   * The companion planners return the moved entries, or nothing when there is
   * nothing to move. Inferred moves (an outside rename) keep the lenient
   * answer for an occupied or invalid destination; an explicit operation
   * passes `strict` and is refused, naming the companion, before anything is
   * published.
   */
  private companionBlocked(strict: boolean, what: string, from: string, to: string, why: string): ManifestEntry[] {
    if (!strict) return [];
    throw new ControlError(409, "conflict", `${from} was not renamed: its ${what} cannot move to ${to} (${why}). Nothing was changed.`);
  }

  /** Whether `key` is held in the manifest by an entry outside `ids`, or by a file above it. */
  private slotTaken(entries: ManifestEntry[], key: string, ids: Set<string>): boolean {
    const displayed = computeLayout(entries).paths;
    return entries.some((entry) => {
      if (ids.has(entry.fileId)) return false;
      const other = manifestPathKey(displayed.get(entry.fileId) ?? entry.path);
      return other === key || other.startsWith(`${key}/`) || (entry.kind !== "folder" && key.startsWith(`${other}/`));
    });
  }

  private inkCompanionMoves(doc: Y.Doc, from: string, to: string, folder: boolean, now: number, strict = false): ManifestEntry[] {
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
    if (taken) return this.companionBlocked(strict, "ink", from, to, `${inkTo} is already in use`);
    const depth = inkFrom.split("/").length;
    const moved = moving.map((entry) => ({ ...entry, path: [inkTo, ...shown(entry).split("/").slice(depth)].join("/"), updatedAt: now }));
    return moved.every((entry) => isShareablePath(entry.path)) ? moved : this.companionBlocked(strict, "ink", from, to, "the new ink path is not allowed");
  }

  /**
   * A recording's companion transcript (`<recording>.transcript`, shared as a
   * blob next to it) is identified in the manifest, so it moves or goes in the
   * recording's own transaction instead of a disk-dependent second request.
   */
  private transcriptCompanion(entries: ManifestEntry[], relative: string): ManifestEntry[] {
    if (this.info.album || !AUDIO_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) return [];
    return entriesUnder(entries, `${relative}.transcript`).filter((entry) => entry.kind !== "folder");
  }

  /** The renamed recording's transcript at its new path; none when the destination is occupied. */
  private transcriptCompanionMoves(doc: Y.Doc, from: string, to: string, now: number, strict = false): ManifestEntry[] {
    if (from === to || !AUDIO_EXTENSIONS.has(path.posix.extname(to).toLowerCase())) return [];
    const entries = [...readManifest(doc).values()];
    const moving = this.transcriptCompanion(entries, from);
    if (moving.length === 0) return [];
    if (moving.length !== 1) return this.companionBlocked(strict, "transcript", from, to, "it is not one file");
    const next = `${to}.transcript`;
    if (this.slotTaken(entries, manifestPathKey(next), new Set([moving[0].fileId]))) return this.companionBlocked(strict, "transcript", from, to, `${next} is already in use`);
    if (!isShareablePath(next)) return this.companionBlocked(strict, "transcript", from, to, `${next} is not an allowed path`);
    return [{ ...moving[0], path: next, updatedAt: now }];
  }

  /**
   * A note's Python code (`_assets/<note path>/<note>.py`, a text document in
   * the manifest) follows the note like its ink and transcript do.
   */
  private pythonCompanion(entries: ManifestEntry[], relative: string): ManifestEntry[] {
    if (this.info.album || !MARKDOWN_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) return [];
    // The notebook segment is dropped again: manifest paths are relative to it.
    return entriesUnder(entries, pythonSidecarPath(`n/${relative}`).split("/").slice(1).join("/")).filter((entry) => entry.kind !== "folder");
  }

  /** The renamed note's Python code at its new path; none when the destination is occupied. */
  private pythonCompanionMoves(doc: Y.Doc, from: string, to: string, now: number, strict = false): ManifestEntry[] {
    if (from === to || !MARKDOWN_EXTENSIONS.has(path.posix.extname(to).toLowerCase())) return [];
    const entries = [...readManifest(doc).values()];
    const moving = this.pythonCompanion(entries, from);
    if (moving.length === 0) return [];
    if (moving.length !== 1) return this.companionBlocked(strict, "Python code", from, to, "it is not one file");
    const next = pythonSidecarPath(`n/${to}`).split("/").slice(1).join("/");
    if (this.slotTaken(entries, manifestPathKey(next), new Set([moving[0].fileId]))) return this.companionBlocked(strict, "Python code", from, to, `${next} is already in use`);
    if (!isShareablePath(next)) return this.companionBlocked(strict, "Python code", from, to, `${next} is not an allowed path`);
    return [{ ...moving[0], path: next, updatedAt: now }];
  }

  /**
   * The Python code of every note under a renamed folder, at the slots the
   * notes will have (`_assets/<new prefix>/…`). Those slots are disjoint from
   * the folder's own prefix, so the folder's entries do not carry them.
   */
  private pythonFolderMoves(doc: Y.Doc, from: string, to: string, now: number, strict = false): ManifestEntry[] {
    const entries = [...readManifest(doc).values()];
    const displayed = computeLayout(entries).paths;
    const depth = from.split("/").length;
    const moved: ManifestEntry[] = [];
    for (const entry of entriesUnder(entries, from)) {
      if (entry.kind === "folder") continue;
      const shown = displayed.get(entry.fileId) ?? entry.path;
      const next = [to, ...shown.split("/").slice(depth)].join("/");
      moved.push(...this.pythonCompanionMoves(doc, shown, next, now, strict));
    }
    const slots = new Set<string>();
    for (const entry of moved) {
      const key = manifestPathKey(entry.path);
      if (slots.has(key)) return this.companionBlocked(strict, "Python code", from, to, `two scripts would share ${entry.path}`);
      slots.add(key);
    }
    return moved;
  }

  /**
   * Renaming one file never changes what kind of file it is and never deletes
   * a record, as in a local notebook (files.ts assertTypeChangeLosesNothing):
   * the document or blob would be served to the wrong viewer, and the ink,
   * transcript or Python code kept for the old type would be left without a
   * file. The bytes are not converted; the person removes the records or keeps
   * the type.
   */
  private assertRenameKeepsRecords(file: ManifestEntry, from: string, to: string): void {
    const fromExtension = path.posix.extname(from).toLowerCase();
    const toExtension = path.posix.extname(to).toLowerCase();
    const wanted = docKindForPath(to);
    const kindChanged = file.kind === "doc" ? wanted !== (file.docKind ?? null) : wanted !== null && wanted !== docKindForPath(from);
    if (kindChanged) throw new ControlError(409, "conflict", `${from} cannot become ${path.posix.basename(to)}: a file of that type is shared differently. Keep its type, or add the file again under the new name.`);
    const doc = this.manifestDoc();
    const kept: string[] = [];
    if (fromExtension !== toExtension && this.inkCompanions(doc, from).length) kept.push("ink");
    const entries = [...readManifest(doc).values()];
    if (!AUDIO_EXTENSIONS.has(toExtension) && this.transcriptCompanion(entries, from).length) kept.push("a transcript");
    if (!MARKDOWN_EXTENSIONS.has(toExtension) && this.pythonCompanion(entries, from).length) kept.push("Python code");
    if (kept.length) throw new ControlError(409, "conflict", `${from} has ${kept.join(" and ")} that a ${toExtension || "file"} file cannot keep. Remove ${kept.length > 1 ? "them" : "it"} or keep the file type, then rename again.`);
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
    let stripped: { bytes: Uint8Array; size: number; mtimeMs: number } | null = null;
    try {
      stripped = await this.stripForUpload(path.join(this.info.root, ...entry.relative.split("/")), entry.relative, bytes);
    } catch (error) {
      // Changed under the rewrite, or it could not be written: not shared
      // (its bytes may still carry location data) until it is judged again.
      if (!(error instanceof WriteCancelledError)) this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not remove the location details from ${entry.relative}, so it is not shared yet.`, error);
      return null;
    }
    if (stripped) {
      bytes = stripped.bytes;
      hash = sha256(bytes);
      entry = { ...entry, size: stripped.size, mtimeMs: stripped.mtimeMs };
    }
    const rewrittenHere = stripped !== null;
    // Retries of the same path+content reuse their IDs so a create whose reply was lost lands on the same server document (STALE-6).
    const attemptKey = `${entry.relative}\0${hash}`;
    const attempt = this.importAttempts.get(attemptKey) ?? { fileId: randomId("fil"), docId: randomId("doc") };
    this.importAttempts.set(attemptKey, attempt);
    const fileId = attempt.fileId;
    const classified = classifyFile(entry.relative, bytes);
    const stillCurrent = async () => {
      if (this.follower || !(await this.rootAvailable())) return false;
      const target = await resolveInside(this.info.root, entry.relative);
      const current = await readIfExists(target);
      if (current === null || sha256(current) !== hash) return false;
      // Unchanged since the scan saw it quiet, and not touched again since.
      const after = await statIfExists(target);
      return after !== null && after.size === entry.size && after.mtimeMs === entry.mtimeMs && (rewrittenHere || quietWaitMs(after, Date.now(), this.ctx.timings.importQuietMs) === 0);
    };
    try {
      if (classified.kind === "doc") {
        const docId = attempt.docId;
        await createSharedDocument(api, this.info.projectId, { docId, fileId }, classified.docKind, classified.text);
        if (!(await stillCurrent())) return null;
        this.importAttempts.delete(attemptKey);
        this.pendingLayout.set(fileId, { path: entry.relative, kind: "doc", docId, docKind: classified.docKind, hash, size: entry.size, mtimeMs: entry.mtimeMs });
        await writeBase(this.info.root, docId, classified.text, this.diskGuard());
        this.ctx.host.store.upsertDoc({ docId, projectId: this.info.projectId, fileId, path: entry.relative, materializedHash: hash });
        return { fileId, path: entry.relative, kind: "doc", docId, docKind: classified.docKind, size: bytes.byteLength, createdBy: accountId, createdAt: now, updatedAt: now };
      }
      const mime = mimeForPath(entry.relative);
      await api.uploadBlob(this.info.projectId, bytes, mime);
      if (!(await stillCurrent())) return null;
      this.importAttempts.delete(attemptKey);
      this.pendingLayout.set(fileId, { path: entry.relative, kind: "blob", hash, size: entry.size, mtimeMs: entry.mtimeMs });
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

  /**
   * The authoritative file list: every manifest entry at the path the layout
   * gives it. Read from the manifest alone (no disk, no project queue), so a
   * follower lists files the cloud has not delivered yet, and a stalled
   * provider cannot hold the answer up.
   */
  listEntries(): Promise<FileListResponse> {
    if (this.stopped) return Promise.reject(new ControlError(503, "offline", "The notebook is stopping."));
    if (!this.manifestReady()) return Promise.reject(new ControlError(503, "offline", "The notebook's file list has not loaded yet."));
    const entries = this.readEntries();
    const list: FileListEntry[] = [];
    for (const [fileId, placed] of computeLayout(entries.values()).paths) {
      const entry = entries.get(fileId);
      if (!entry) continue;
      list.push({
        fileId,
        path: placed,
        kind: entry.kind,
        ...(entry.docId ? { docId: entry.docId } : {}),
        ...(entry.docKind ? { docKind: entry.docKind } : {}),
        ...(entry.blobHash ? { blobHash: entry.blobHash } : {}),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        updatedAt: entry.updatedAt,
      });
    }
    return Promise.resolve({ entries: list });
  }

  /**
   * A folder rename or delete acts on what the person reviewed: when the
   * request lists the descendant IDs it was confirmed with, the folder must
   * hold exactly those now (it was not renamed away and replaced, nothing was
   * added or removed). Nothing is changed otherwise. Absent list: no binding.
   */
  private assertReviewedDescendants(relative: string, selected: ManifestEntry[], reviewed: string[] | undefined): void {
    if (reviewed === undefined || selected.length === 0) return;
    const displayed = computeLayout(this.entries.values()).paths;
    const own = manifestPathKey(relative);
    const current = new Set(selected.filter((entry) => manifestPathKey(displayed.get(entry.fileId) ?? entry.path) !== own).map((entry) => entry.fileId));
    const expected = new Set(reviewed);
    if (current.size === expected.size && [...current].every((fileId) => expected.has(fileId))) return;
    throw new ControlError(409, "conflict", `${relative} changed since you reviewed it: its files are not the ones you confirmed. Nothing was changed. Open the folder again and repeat the action.`);
  }

  /**
   * The owner a companion save belongs to: `_ink/<owner>/<file>` for ink,
   * `<recording>.transcript` for a transcript. The owner must be a file in
   * the manifest now, and the one the caller read when it names an ID. A save
   * for an owner that moved or was removed is refused instead of creating a
   * companion at the old path (the caller re-reads the owner's current path).
   */
  private assertCompanionOwner(relative: string, ownerFileId: string | undefined): void {
    if (this.info.album) return;
    let owner: string | null = null;
    let what = "";
    const parts = relative.split("/");
    if (parts[0] === INK_DIRECTORY && parts.length >= 3) {
      owner = parts.slice(1, -1).join("/");
      what = "ink";
    } else if (parts[0] !== INK_DIRECTORY && relative.toLowerCase().endsWith(".transcript") && AUDIO_EXTENSIONS.has(path.posix.extname(relative.slice(0, -".transcript".length)).toLowerCase())) {
      owner = relative.slice(0, -".transcript".length);
      what = "transcript";
    }
    if (owner === null) return;
    const files = entriesUnder(this.entries.values(), owner).filter((entry) => entry.kind !== "folder");
    const displayed = computeLayout(this.entries.values()).paths;
    const found = files.find((entry) => manifestPathKey(displayed.get(entry.fileId) ?? entry.path) === manifestPathKey(owner!));
    if (!found) throw new ControlError(409, "conflict", `${owner} is not in this notebook at that path (it was moved or removed), so its ${what} was not saved. Reopen the file and try again.`);
    if (ownerFileId !== undefined && found.fileId !== ownerFileId) throw new ControlError(409, "conflict", `${owner} is a different file now, so its ${what} was not saved. Reopen the file and try again.`);
  }

  /** A name being created or renamed must leave room for its sidecar files (existing names are not re-judged). */
  private assertNewName(relative: string): void {
    const problem = manifestNewNameError(relative);
    if (problem) throw new ControlError(400, "bad-request", problem);
  }

  /** create-file, create-folder, write-blob, rename and delete, through the manifest; the disk follows. */
  fileOp(request: FileOpRequest): Promise<FileOpResult> {
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
      // A replacement names the file and the version it replaces; without them it could create or take over another file.
      if (request.op === "write-blob" && request.replaceOnly) {
        if (request.createOnly) throw new ControlError(400, "bad-request", "A write cannot both create a file and replace one.");
        if (!request.expectedFileId || !request.expectedBlobHash) throw new ControlError(400, "bad-request", "Replacing a file needs the file id and the blob hash of the version being replaced.");
      }
      const now = Date.now();
      const accountId = await this.ctx.accountId();
      this.entries = this.readEntries();
      const selected = entriesUnder(this.entries.values(), relative);
      if (request.expectedFileId !== undefined && (selected.length !== 1 || selected[0].fileId !== request.expectedFileId) ||
          request.expectedBlobHash !== undefined && (selected.length !== 1 || selected[0].blobHash !== request.expectedBlobHash)) {
        throw new ControlError(409, "conflict", "This file changed since it was read. Refresh it before changing it.");
      }
      if (request.op === "rename" || request.op === "delete") this.assertReviewedDescendants(relative, selected, request.expectedDescendantIds);
      if (request.op === "write-blob" || request.op === "create-file") this.assertCompanionOwner(relative, request.ownerFileId);
      const paths: string[] = [];
      // The exact committed change per manifest entry, for a rename or delete.
      const moves: FileOpMove[] = [];
      const uploaded: string[] = [];
      // The file a create or a blob write produced or changed, for the caller to name it by.
      let resultFileId: string | undefined;
      try {
        switch (request.op) {
          case "create-file":
          case "create-folder": {
            this.assertFree(relative, []);
            this.assertNewName(relative);
            const fileId = randomId("fil");
            let created: ManifestEntry;
            if (request.op === "create-folder") {
              created = { fileId, path: relative, kind: "folder", createdBy: accountId, createdAt: now, updatedAt: now };
            } else {
              created = await this.createFileEntry(fileId, relative, encodeText(request.content ?? ""), accountId, now);
            }
            paths.push(await this.publishCreated(created));
            resultFileId = fileId;
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
            if (!existing && request.replaceOnly) throw new ControlError(409, "conflict", `${relative} was deleted or moved before it was saved. Nothing was written.`);
            if (!existing) {
              // A new file: the same as create-file, from bytes.
              this.assertFree(relative, []);
              const fileId = randomId("fil");
              if (request.pdfSeed && this.pdfs.enabled) await this.pdfs.seed(fileId, relative, request.pdfSeed);
              const created = await this.createFileEntry(fileId, relative, bytes, accountId, now);
              paths.push(await this.publishCreated(created));
              resultFileId = fileId;
              break;
            }
            resultFileId = existing.fileId;
            if (existing.kind === "doc") throw new ControlError(409, "conflict", `${existing.path} is a shared document; change its text with edits.`);
            if (existing.kind !== "blob") throw new ControlError(409, "conflict", `${existing.path} is a folder.`);
            const api = this.ctx.host.api;
            if (!api) throw new ControlError(401, "needs-sign-in", "Sign in to the collaboration server.");
            const hash = sha256(bytes);
            // Identical bytes: nothing to upload, and no manifest change to sync.
            if (hash === existing.blobHash) {
              paths.push(computeLayout(this.entries.values()).paths.get(existing.fileId) ?? existing.path);
              break;
            }
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
            this.assertNewName(to);
            const displayed = computeLayout(this.entries.values()).paths;
            const depth = relative.split("/").length;
            const updates = moving.map((entry) => {
              const visible = displayed.get(entry.fileId)!;
              const rest = visible.split("/").slice(depth);
              const next = [to, ...rest].join("/");
              if (!isShareablePath(next)) throw new ControlError(400, "bad-request", `${next} is not an allowed path.`);
              paths.push(visible, next);
              moves.push({ fileId: entry.fileId, from: this.liberaPath(visible), to: this.liberaPath(next) });
              return { ...entry, path: next, updatedAt: now };
            });
            // A folder unless `relative` names a file (folders may have no entry of their own).
            const folder = !moving.some((entry) => entry.kind !== "folder" && manifestPathKey(displayed.get(entry.fileId) ?? entry.path) === manifestPathKey(relative));
            if (!folder) {
              const file = moving.find((entry) => entry.kind !== "folder" && manifestPathKey(displayed.get(entry.fileId) ?? entry.path) === manifestPathKey(relative));
              if (file) this.assertRenameKeepsRecords(file, relative, to);
            }
            // The companions (ink, transcript, Python code of the file, or of every note
            // under a folder) are planned with the primary move: an occupied or invalid
            // slot refuses the whole rename here, before anything is published.
            const planDoc = this.manifestDoc();
            const planned = [
              ...this.inkCompanionMoves(planDoc, relative, to, folder, now, true),
              ...(folder
                ? this.pythonFolderMoves(planDoc, relative, to, now, true)
                : [...this.transcriptCompanionMoves(planDoc, relative, to, now, true), ...this.pythonCompanionMoves(planDoc, relative, to, now, true)]),
            ];
            const before = computeLayout(readManifest(planDoc).values()).paths;
            for (const entry of planned) {
              paths.push(entry.path);
              moves.push({ fileId: entry.fileId, from: this.liberaPath(before.get(entry.fileId) ?? entry.path), to: this.liberaPath(entry.path) });
            }
            // A folder of many files is several transactions: one manifest update
            // over the server's limit would never sync.
            for (const [index, batch] of splitManifestBatches(updates, manifestEntryBytes).entries()) {
              await this.writeManifest((map) => {
                for (const entry of batch) map.set(entry.fileId, entryRecord(entry));
                if (index > 0) return;
                for (const entry of planned) map.set(entry.fileId, entryRecord(entry));
              }, { source: "typing" });
            }
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
            // The Python code of every note being deleted (the file itself, or each note under
            // a folder) lives under `_assets/<note path>`, outside the folder's prefix: it goes
            // in the same committed set, so a note created at the same path later starts clean.
            const planDoc = this.manifestDoc();
            const planEntries = [...readManifest(planDoc).values()];
            const planDisplayed = computeLayout(planEntries).paths;
            const removedIds = new Set(removing.map((entry) => entry.fileId));
            const extra = new Map<string, ManifestEntry>();
            const addExtra = (entry: ManifestEntry) => { if (!removedIds.has(entry.fileId)) extra.set(entry.fileId, entry); };
            for (const entry of removing) {
              if (entry.kind === "folder") continue;
              this.pythonCompanion(planEntries, planDisplayed.get(entry.fileId) ?? entry.path).forEach(addExtra);
            }
            this.transcriptCompanion(planEntries, relative).forEach(addExtra);
            // Someone deleted it on purpose, so its ink goes too (archived on disk like the file).
            this.inkCompanions(planDoc, relative).forEach(addExtra);
            for (const entry of removing) moves.push({ fileId: entry.fileId, from: this.liberaPath(displayed.get(entry.fileId)!), to: null });
            for (const entry of extra.values()) {
              paths.push(entry.path);
              moves.push({ fileId: entry.fileId, from: this.liberaPath(planDisplayed.get(entry.fileId) ?? entry.path), to: null });
            }
            // Many entries are removed in several transactions (see rename).
            for (const [index, batch] of splitManifestBatches(removing, () => 256).entries()) {
              await this.writeManifest((map) => {
                for (const entry of batch) map.delete(entry.fileId);
                if (index > 0) return;
                for (const fileId of extra.keys()) map.delete(fileId);
              }, { source: "typing" });
            }
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
        return { paths: paths.map((item) => this.liberaPath(item)), ...(resultFileId ? { fileId: resultFileId } : {}), ...(moves.length ? { moves } : {}) };
      } finally {
        for (const hash of uploaded) this.uploadedBlobs.delete(hash);
      }
    });
  }

  /**
   * Adds a created entry to the manifest and returns the path the layout gives
   * it. The name is checked again in the tick that writes it (the file was
   * created over several awaits, so someone may have taken it since: 409,
   * nothing published). A create on another device can still land in the same
   * merge and be placed with a suffix; the caller gets that path, never the
   * requested one, which would open the other file.
   */
  /**
   * Publishes a created entry and answers with the path the layout gives it.
   * A name another member took while the document or blob was being created
   * is not refused: both files are kept (the layout suffixes one, "notes (2).md"),
   * and the caller learns the created file's own path, never the other's.
   */
  private async publishCreated(created: ManifestEntry): Promise<string> {
    try {
      await this.writeManifest((map) => {
        map.set(created.fileId, entryRecord(created));
        const record = this.pendingLayout.get(created.fileId);
        if (record) this.state.layout[created.fileId] = record;
      }, { source: "typing" });
    } finally {
      this.pendingLayout.delete(created.fileId);
    }
    return computeLayout(this.readEntries().values()).paths.get(created.fileId) ?? created.path;
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
    // The read is bounded (the staged folder can sit on a cloud provider). When it does not finish, the file is
    // kept and nothing was written: the caller may stage it again or retry the same request.
    const reading = fs.readFile(file);
    let finished = false;
    try {
      const bytes = await withinMs(reading, HYDRATION_WAIT_MS);
      if (bytes === SLOW_READ) throw new ControlError(503, "offline", "The staged file is still being read from disk. Nothing was changed; retry.");
      finished = true;
      return new Uint8Array(bytes);
    } catch (error) {
      if (isNotFound(error)) {
        finished = true;
        throw new ControlError(404, "not-found", "The staged file is gone.");
      }
      finished = !(error instanceof ControlError && error.status === 503);
      throw error;
    } finally {
      // Removal is best effort and never awaited: it must not hold the queue either.
      if (finished) void withinMs(fs.rm(file, { force: true }), HYDRATION_WAIT_MS).catch(() => undefined);
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
      this.noteOwnWrite(target, stats);
    } catch (error) {
      if (!(error instanceof WriteCancelledError) || !(await guard.canCommit())) throw error;
      // The server already holds the submitted input. Publish its identity;
      // normal materialization will preserve the newer disk arrival too.
      return created;
    }
    // The layout takes the file when its manifest entry is written (publishCreated).
    this.pendingLayout.set(fileId, {
      path: relative,
      kind: created.kind,
      ...(created.docId ? { docId: created.docId, docKind: created.docKind } : {}),
      hash,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
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
    const moves: { from: string; to: string; fileId: string }[] = [];
    const removed: string[] = [];
    const added: string[] = [];
    for (const [fileId, record] of Object.entries(next)) {
      const before = previous[fileId];
      if (!before) added.push(this.liberaPath(record.path));
      else if (before.path !== record.path) moves.push({ from: this.liberaPath(before.path), to: this.liberaPath(record.path), fileId });
    }
    for (const [fileId, record] of Object.entries(previous)) {
      if (!next[fileId]) removed.push(this.liberaPath(record.path));
    }
    if (moves.length === 0 && removed.length === 0 && added.length === 0) return;
    this.ctx.emit({ t: "tree-changed", projectId: this.info.projectId, notebook: this.info.notebook, added, moves, removed });
  }

  /**
   * Appends the manifest's moves and removals to the host's durable transition
   * log (see transition-log.ts), on a writer and on a follower alike. The paths
   * are the manifest's, by file ID, compared with what was last recorded: not
   * the layout in memory, which a restart rebuilds. Entries the layout refuses
   * (a path a shared notebook cannot hold) keep their recorded place: they are
   * not removals. Called before the tree event, so a window that reacts to it
   * finds the transition in the log.
   */
  /**
   * Remembers the entries a remote device renamed only in Unicode form (S39),
   * and forgets one once its path changes again. At most MAX_REMOTE_RESPELLS
   * are kept (the oldest go first).
   */
  private noteRemoteRespells(next: Map<string, RecordedPath>): void {
    let changed = false;
    const marks = this.state.remoteRespells ?? {};
    for (const [fileId, now] of next) {
      const before = this.recordedPaths.get(fileId);
      if (!before || before.path === now.path) continue;
      const own = this.ownRespells.delete(fileId);
      if (!own && before.path.normalize("NFC") === now.path.normalize("NFC")) {
        marks[fileId] = { path: now.path, at: Date.now() };
        changed = true;
      } else if (marks[fileId]) {
        delete marks[fileId];
        changed = true;
      }
    }
    if (!changed) return;
    const keep = Object.entries(marks).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_REMOTE_RESPELLS);
    this.state.remoteRespells = Object.fromEntries(keep);
    this.saveSoon();
  }

  private recordTransitions(layout: { paths: Map<string, string>; refused: Array<{ fileId: string }> }): void {
    if (this.info.album) return;
    // A move or removal the server has not acknowledged can still be rolled back (M23).
    if (!this.manifestAcknowledged()) {
      this.transitionsDeferred = true;
      return;
    }
    this.transitionsDeferred = false;
    try {
      const next = new Map<string, RecordedPath>();
      for (const [fileId, path] of layout.paths) next.set(fileId, { path, kind: this.entries.get(fileId)?.kind === "folder" ? "folder" : "file" });
      for (const { fileId } of layout.refused) {
        const before = this.recordedPaths.get(fileId);
        if (before && !next.has(fileId)) next.set(fileId, before);
      }
      this.noteRemoteRespells(next);
      const diff = diffManifestPaths(this.recordedPaths, next, Date.now(), this.manifestHub?.caughtUp === true);
      if (diff.upserts.length === 0 && diff.removals.length === 0) return;
      this.ctx.host.store.commitManifestPaths(this.info.projectId, diff);
      this.recordedPaths = next;
    } catch (error) {
      // Recorded again from the same comparison at the next pass.
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not record the manifest's moves`, error);
    }
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
    if (this.stopped || this.follower) return;
    const due = performance.now() + delay;
    if (this.saveTimer) {
      // Writes coalesce into the pending one, unless this one is wanted sooner (a text flush waits longer).
      if (due >= this.saveDueAt) return;
      clearTimeout(this.saveTimer);
    }
    this.saveDueAt = due;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.enqueue(async () => {
        if (!this.stateDirty || this.follower) return;
        this.stateDirty = false;
        let saved = false;
        try {
          if (await this.rootAvailable()) {
            // A state identical to the one on disk (a flush that changed nothing recorded) is not rewritten.
            const text = JSON.stringify(this.state);
            if (text !== this.savedState) await writeState(this.info.root, this.state, this.diskGuard());
            this.savedState = text;
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
   * verifyMs, or trustedVerifyMs while fs.watch is trusted and has never been
   * caught missing a change this session (a watcher that did is not believed
   * again for this, whatever re-trusts it), or largeFileVerifyMs (spread per
   * file) for large files whose last read was handled; times batteryScale on battery.
   */
  private verificationAge(fileId: string, size: number, pending: boolean): number {
    const { verifyMs, trustedVerifyMs, largeFileVerifyMs } = this.ctx.timings;
    // A change still waiting to be handled is retried on the short bound, watcher or not.
    const small = pending ? verifyMs : this.watcher && this.watcherTrusted && this.watchMisses === 0 ? Math.max(verifyMs, trustedVerifyMs) : verifyMs;
    const base = pending || size < LARGE_FILE_BYTES ? small : Math.max(small, largeFileVerifyMs * (0.75 + 0.5 * spreadFraction(fileId)));
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
  const wanted = docKindForPath(relative);
  // A document renamed to a name that is not text any more ("a.md" → "a.png")
  // is a new file, not the same document, and not one of another document kind.
  if (record.kind === "doc") return classifyFile(relative, new Uint8Array(0)).kind === "doc" && wanted === (record.docKind ?? null);
  // A binary does not become a document kind (assertRenameKeepsRecords).
  return wanted === null || wanted === docKindForPath(record.path);
}

/** The bytes a retired entry is known to have held: its record, its manifest entry, and the shared text it had. */
export function retirementHashes(record: LayoutRecord, entry: ManifestEntry | undefined, sharedText: string | null): string[] {
  const hashes = knownHashes(record, entry);
  if (sharedText !== null) hashes.push(sha256(encodeText(sharedText)));
  return [...new Set(hashes)];
}

/** Whether two texts are mostly the same: about half or less of the longer one differs (a note edited after a rename). */
function similarText(before: string, after: string): boolean {
  if (before.length < 16 || after.length < 16 || before.length > 1_000_000 || after.length > 1_000_000) return false;
  const changed = diffText(before, after).reduce((sum, edit) => sum + edit.end - edit.start + edit.text.length, 0);
  return changed <= Math.max(before.length, after.length) / 2;
}

function normalizeRelative(input: string): string {
  if (typeof input !== "string") throw new ControlError(400, "bad-request", "A path is required.");
  const relative = input.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!relative) throw new ControlError(400, "bad-request", "A path is required.");
  return relative;
}

/** Every version of a removed or moved file this host knows, for recognizing it if it returns. */
/** A blob's destination as observed once: `stats` null when absent; `hash` null when absent, undefined when online-only and unexplained. */
interface DestinationView {
  stats: Stats | null;
  hash: string | null | undefined;
  bytes?: Uint8Array;
}

/** What identifies the bytes of a file without reading them (ctime and inode too: a delivery can keep size and mtime). */
function statsKey(stats: Stats | null): string | null {
  return stats ? `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}` : null;
}

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
