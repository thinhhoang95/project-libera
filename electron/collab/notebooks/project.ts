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

import type { FileOpRequest, HostEvent, LocalAlbum, LocalAlbumPhoto, Reconciliation, UpdateAlbumRequest } from "../../../src/lib/collab/local-api";
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
import {
  ARCHIVE_DIRECTORY,
  PathRefusedError,
  STATE_DIRECTORY,
  availableName,
  decodeText,
  encodeText,
  isNotFound,
  isShareablePath,
  movePath,
  pruneEmptyDirectories,
  randomId,
  readIfExists,
  resolveInside,
  sha256,
  statIfExists,
  walkNotebook,
  writeFileAtomic,
  type WalkEntry,
} from "./fs-ops";
import { computeLayout, entriesUnder, entryRecord, readManifest } from "./layout";
import { emptyState, isStaleCopy, readBase, readMarker, readState, setMaterialized, writeBase, writeState, deleteBase, type LayoutRecord, type ProjectState } from "./state";
import { diffText } from "./text-diff";

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
  /** Retry delay for downloads and creates that failed (offline). */
  retryMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  writeDebounceMs: 2000,
  writeMaxWaitMs: 15_000,
  settleMs: 250,
  deleteGraceMs: 1200,
  pollMs: 5000,
  retryMs: 5000,
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
  emit(event: HostEvent): void;
  /** The signed-in account (manifest createdBy). */
  accountId(): Promise<string>;
  /** Access to the project was revoked (a doc or the manifest was closed with access-revoked). */
  revoked(projectId: string): void;
  /** The role changed (from a hub's meta). */
  roleChanged(projectId: string, role: Role): void;
  /** The layout changed; the resolvePath index must be rebuilt. */
  layoutChanged(projectId: string): void;
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
  private manifestWasReady = false;
  private readonly docs = new Map<string, DocRuntime>();
  private readonly unsubscribe: Array<() => void> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private watcher: FSWatcher | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private manifestTimer: ReturnType<typeof setTimeout> | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly missingSince = new Map<string, number>();
  private readonly refusedLogged = new Set<string>();
  private stopped = false;
  private started = false;
  private rootUnavailable = false;

  private constructor(ctx: ProjectContext, info: ProjectInfo, state: ProjectState) {
    this.ctx = ctx;
    this.info = info;
    this.state = state;
  }

  static async open(ctx: ProjectContext, info: ProjectInfo): Promise<SharedProject> {
    // A follower's layout comes from the manifest alone; state.json and its
    // reconciliations belong to the writer.
    return new SharedProject(ctx, info, info.follower ? emptyState() : await readState(info.root));
  }

  get follower(): boolean {
    return this.info.follower === true;
  }

  get role(): Role {
    return this.info.role;
  }

  set role(role: Role) {
    this.info.role = role;
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
          marker.manifestDocId === this.info.manifestDocId && (!this.info.folderId || marker.folderId === this.info.folderId);
      }
    } catch { /* Unavailable roots must never be recreated by the materializer. */ }
    if (!available) this.rootUnavailable = true;
    return available;
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    const hub = this.ctx.host.acquire(this.info.manifestDocId, { kind: "manifest", projectId: this.info.projectId });
    this.manifestHub = hub;
    this.unsubscribe.push(
      hub.observe("manifest", (change) => {
        if (change.origin === "rebuilt") {
          this.manifestRebuilt = true;
          return;
        }
        if (change.origin === "server") this.manifestRebuilt = false;
        this.scheduleManifest(30);
      }),
      hub.onStatus(() => {
        if (!this.manifestWasReady && this.manifestReady()) this.scheduleManifest(30);
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
  async stop(options: { persist?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const timer of [this.manifestTimer, this.scanTimer, this.retryTimer, ...this.timers]) if (timer) clearTimeout(timer);
    this.timers.clear();
    for (const doc of this.docs.values()) if (doc.writeTimer) clearTimeout(doc.writeTimer);
    await this.queue.catch(() => undefined);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.follower && options.persist !== false && await this.rootAvailable()) await writeState(this.info.root, this.state).catch(() => undefined);
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe.length = 0;
    for (const doc of [...this.docs.values()]) this.releaseDoc(doc.docId);
    if (this.manifestHub) this.ctx.host.release(this.info.manifestDocId);
    this.manifestHub = null;
  }

  /** Resolves once the queue is empty and no write, scan or manifest pass is pending. */
  async whenIdle(): Promise<void> {
    for (;;) {
      await this.queue.catch(() => undefined);
      const pendingWrites = [...this.docs.values()].some((doc) => doc.writeTimer !== null);
      if (this.queued === 0 && !pendingWrites && !this.manifestTimer && !this.scanTimer) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const run = this.queue.then(async () => {
      try {
        if (this.stopped) return undefined as T;
        return await task();
      } finally {
        this.queued -= 1;
      }
    });
    this.queue = run.catch((error) => {
      if (!(error instanceof ControlError)) this.ctx.logger.error(`Shared notebook ${this.info.notebook}: task failed`, error);
    });
    return run;
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
    if (this.follower) {
      this.followManifest();
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
      touched.add(record.path);
      vacated.add(record.kind === "folder" ? record.path : path.posix.dirname(record.path));
      if (record.docId) this.docs.get(record.docId)?.hub.markDeleted();
      if (record.kind !== "folder") await this.archiveRemoved(record);
      if (record.docId) {
        this.releaseDoc(record.docId);
        this.dropReconciliations(record.docId);
        await deleteBase(this.info.root, record.docId).catch(() => undefined);
      }
      this.missingSince.delete(fileId);
    }

    // Moves, in two phases so swaps and chains (a→b, b→a) cannot collide.
    const staged: Array<{ fileId: string; staging: string; record: LayoutRecord }> = [];
    for (const [fileId, record] of Object.entries(previous)) {
      const desired = layout.paths.get(fileId);
      if (!desired || desired === record.path) continue;
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
        const staging = path.join(this.info.root, ...STATE_DIRECTORY, "moving", fileId);
        await movePath(source, staging);
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
        await movePath(staging, target);
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
          await fs.mkdir(absolute, { recursive: true });
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
      } else if (entry.kind === "blob" && entry.blobHash && record.hash !== entry.blobHash) {
        const placed = await this.placeBlob(entry, record);
        if (placed) touched.add(desired);
        else needsRetry = true;
      }
    }

    const layoutChanged = JSON.stringify(previous) !== JSON.stringify(next);
    this.state.layout = next;
    for (const directory of vacated) {
      if (directory && directory !== ".") {
        await pruneEmptyDirectories(this.info.root, directory, (relative) => layout.directories.has(relative));
      }
    }
    if (layoutChanged) {
      this.saveSoon();
      this.ctx.layoutChanged(this.info.projectId);
      this.treeChanged(previous, next);
    }
    if (touched.size > 0) this.filesChanged([...touched]);
    // Documents whose file is missing or new get written now that their place exists.
    for (const [fileId, record] of Object.entries(next)) {
      if (record.kind === "doc" && record.docId && (!record.hash || this.rootUnavailable)) {
        const runtime = this.docs.get(record.docId);
        if (runtime && runtime.fileId === fileId && this.docReady(runtime)) await this.materializeDoc(record.docId);
      }
    }
    this.rootUnavailable = false;
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
      if (record.docId && next[fileId]?.docId !== record.docId) {
        this.docs.get(record.docId)?.hub.markDeleted();
        this.releaseDoc(record.docId);
      }
    }
    for (const [fileId, record] of Object.entries(next)) if (record.docId) this.ensureDoc(record.docId, fileId);
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.state.layout = next;
    this.ctx.layoutChanged(this.info.projectId);
    this.treeChanged(previous, next);
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
    const existing = await readIfExists(target);
    if (existing) {
      const existingHash = sha256(existing);
      if (existingHash === hash) {
        const stats = await statIfExists(target);
        setMaterialized(record, hash, stats?.size, stats?.mtimeMs);
        return true;
      }
      // The local copy changed and the shared file was replaced too: keep the
      // local bytes in the archive rather than overwrite them silently. An
      // older copy we wrote ourselves is not worth keeping.
      const existingStats = await statIfExists(target);
      if (record.hash && existingHash !== record.hash && !(existingStats && isStaleCopy(record, existingHash, existingStats.mtimeMs))) {
        await this.archive(record.path);
      }
    }
    const bytes = await this.blobBytes(hash);
    if (!bytes) return false;
    const stats = await writeFileAtomic(target, bytes);
    setMaterialized(record, hash, stats.size, stats.mtimeMs);
    this.ctx.host.store.putBlob({ hash, localPath: target, size: bytes.byteLength });
    return true;
  }

  private async blobBytes(hash: string): Promise<Uint8Array | null> {
    const cached = this.ctx.host.store.getBlob(hash);
    if (cached) {
      const bytes = await readIfExists(cached.localPath).catch(() => null);
      if (bytes && sha256(bytes) === hash) return bytes;
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

  /** Moves a file or folder into the notebook's local archive (`_archive`), which is never shared. */
  private async archive(relative: string): Promise<void> {
    let source: string;
    try {
      source = await resolveInside(this.info.root, relative);
    } catch {
      return;
    }
    if (!(await statIfExists(source))) return;
    const archiveRoot = path.join(this.info.root, ARCHIVE_DIRECTORY);
    const name = await availableName(archiveRoot, path.posix.basename(relative));
    await movePath(source, path.join(archiveRoot, name));
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
    let target: string;
    try { target = await resolveInside(this.info.root, record.path); }
    catch (error) { this.refuse(record.path, error); return; }
    const stats = await statIfExists(target);
    if (stats && !stats.isFile()) await this.archive(record.path);
    const disk = stats?.isFile() ? await readIfExists(target) : null;
    // If disk holds a separate external edit, preserve it under another archive name.
    if (disk && sha256(disk) !== sha256(encodeText(text)) && sha256(disk) !== record.hash) await this.archive(record.path);
    await writeFileAtomic(target, encodeText(text));
    await this.archive(record.path);
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
  private async walk(): Promise<WalkEntry[]> {
    const { entries } = await walkNotebook(this.info.root);
    if (!this.info.album) return entries;
    return entries.filter((entry) => entry.kind === "file" && !entry.relative.includes("/") && albumImageType(entry.relative) !== null);
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
    const stats = await writeFileAtomic(absolute, stripped);
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
    const disk = await readIfExists(target);
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
      if (!record.hash) await this.archive(record.path);
    } else if (record.hash) {
      // Deleted on disk after our last write: that is the user's delete, which
      // the watcher turns into a manifest operation. Do not resurrect it.
      if (!this.missingSince.has(fileId)) this.missingSince.set(fileId, Date.now());
      this.scheduleScan(this.ctx.timings.settleMs);
      return;
    }
    await this.writeDoc(runtime, record, target, text);
    // A collaborator's new document exists on disk only now; the tree-changed
    // sent when its manifest entry arrived came before the file did.
    if (!disk) {
      this.ctx.emit({ t: "tree-changed", projectId: this.info.projectId, notebook: this.info.notebook, added: [this.liberaPath(record.path)], moves: [], removed: [] });
    }
  }

  /** Writes `text` as the document's file and records it as materialized. */
  private async writeDoc(runtime: DocRuntime, record: LayoutRecord, target: string, text: string): Promise<void> {
    const bytes = encodeText(text);
    const hash = sha256(bytes);
    const stats = await writeFileAtomic(target, bytes);
    setMaterialized(record, hash, stats.size, stats.mtimeMs);
    await writeBase(this.info.root, runtime.docId, text);
    this.ctx.host.store.upsertDoc({ docId: runtime.docId, projectId: this.info.projectId, fileId: runtime.fileId, path: record.path, materializedHash: hash });
    this.saveSoon();
    this.filesChanged([record.path]);
  }

  /** Records bytes already on disk as the materialized state of a document. */
  private async adopt(fileId: string, record: LayoutRecord, hash: string, text: string, target: string): Promise<void> {
    const stats = await statIfExists(target);
    const changed = record.hash !== hash;
    setMaterialized(record, hash, stats?.size, stats?.mtimeMs);
    if (record.docId) {
      if (changed) await writeBase(this.info.root, record.docId, text);
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
    if (!this.docReady(runtime)) return;
    const target = await resolveInside(this.info.root, record.path);
    const shared = runtime.hub.getText("content");
    const diskStats = await statIfExists(target);
    if (diskStats && isStaleCopy(record, diskHash, diskStats.mtimeMs)) {
      // An older version we wrote came back (a sync client restoring or
      // delivering a stale copy). Taking it in would undo newer edits.
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} was replaced by an older copy; the current text was written again.`);
      await this.writeDoc(runtime, record, target, shared);
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
    if (sha256(encodeText(shared)) === record.hash) {
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
  resolveReconciliation(id: string, text: string): Promise<{ docId: string; text: string }> {
    return this.enqueue(async () => {
      const item = this.state.reconciliations.find((candidate) => candidate.id === id);
      if (!item) throw new ControlError(404, "not-found", "No such reconciliation.");
      if (!this.canEdit) throw new ControlError(403, "forbidden", "Your role cannot edit this notebook.");
      const runtime = this.docs.get(item.docId);
      const found = this.recordFor(item.docId);
      if (!runtime || !found) throw new ControlError(409, "conflict", "The document is no longer in this notebook.");
      this.applyText(runtime.hub, runtime.hub.getText("content"), text, { source: "reconcile" });
      const target = await resolveInside(this.info.root, found.record.path);
      const bytes = encodeText(text);
      const stats = await writeFileAtomic(target, bytes);
      const hash = sha256(bytes);
      setMaterialized(found.record, hash, stats.size, stats.mtimeMs);
      await writeBase(this.info.root, item.docId, text);
      this.ctx.host.store.upsertDoc({ docId: item.docId, projectId: this.info.projectId, fileId: found.fileId, path: found.record.path, materializedHash: hash });
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
        if (relative && relative.split("/").some((segment) => segment.startsWith(".libera"))) return;
        this.scheduleScan(this.ctx.timings.settleMs);
      });
      this.watcher.on("error", (error) => {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: file watching stopped; polling only`, error);
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (error) {
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: file watching unavailable; polling only`, error);
    }
    // The poll is the safety net: fs.watch misses events on ExFAT, network
    // shares and after sleep. A scan only rehashes files whose size or mtime moved.
    this.pollTimer = setInterval(() => this.scheduleScan(0), this.ctx.timings.pollMs);
    this.pollTimer.unref?.();
    this.scheduleScan(0);
  }

  private scheduleScan(delay: number): void {
    if (this.stopped || this.follower) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.enqueue(() => this.scan());
    }, delay);
    this.scanTimer.unref?.();
  }

  /** Turns differences between the folder and the layout into document edits and manifest operations. */
  private async scan(): Promise<void> {
    if (!this.manifestReady()) return;
    if (!(await this.rootAvailable())) {
      this.missingSince.clear();
      return;
    }
    const walked = await this.walk();
    // The folder can disappear while the asynchronous walk is running.
    if (!(await this.rootAvailable())) {
      this.missingSince.clear();
      return;
    }
    const previous = structuredClone(this.state.layout);
    const files = new Map<string, WalkEntry>();
    const directories = new Map<string, WalkEntry>();
    for (const entry of walked) (entry.kind === "file" ? files : directories).set(entry.relative, entry);
    const known = new Set(Object.values(this.state.layout).map((record) => record.path));
    // Parents of known entries are known too: a folder implied by "a/b.md"
    // must not become a new folder entry on every machine that sees it.
    for (const record of Object.values(this.state.layout)) {
      const segments = record.path.split("/");
      for (let index = 1; index < segments.length; index += 1) known.add(segments.slice(0, index).join("/"));
    }
    const now = Date.now();
    const missing: string[] = [];
    const removedRecords: LayoutRecord[] = [];
    const operations: Array<(files: Y.Map<unknown>, doc: Y.Doc) => void> = [];
    /** Photos this pass adds to an album (its other members hear about them). */
    const addedPhotos: string[] = [];
    const touched = new Set<string>();
    const accountId = this.canEdit ? await this.ctx.accountId().catch(() => "") : "";
    let needsRetry = false;

    for (const [fileId, record] of Object.entries(this.state.layout)) {
      if (record.kind === "folder") {
        if (directories.has(record.path)) this.missingSince.delete(fileId);
        else missing.push(fileId);
        continue;
      }
      const seen = files.get(record.path);
      if (!seen) {
        if (record.hash) missing.push(fileId);
        continue;
      }
      this.missingSince.delete(fileId);
      // Equal size and mtime means unchanged, except right after a write: FAT
      // and ExFAT keep coarse mtimes, so a quick second write can look the same.
      const settled = now - seen.mtimeMs > 3000;
      if (!record.hash || (settled && record.size === seen.size && record.mtimeMs === seen.mtimeMs)) continue;
      const absolute = await resolveInside(this.info.root, record.path).catch(() => null);
      let bytes: Uint8Array | null = absolute ? await readIfExists(absolute) : null;
      if (!bytes || !absolute) continue;
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
        Object.assign(record, { size: seen.size, mtimeMs: seen.mtimeMs });
        this.saveSoon();
        continue;
      }
      if (record.kind === "doc" && record.docId) {
        const runtime = this.docs.get(record.docId);
        if (runtime && !this.reconciliationFor(record.docId)) await this.takeExternalEdit(runtime, record, bytes, hash);
        continue;
      }
      const entry = this.entries.get(fileId);
      if (entry?.blobHash === record.hash && isStaleCopy(record, hash, seen.mtimeMs)) {
        // An older version we wrote came back; put the current one back.
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} was replaced by an older copy; the current file was written again.`);
        if (await this.placeBlob(entry, record)) touched.add(record.path);
        else needsRetry = true;
        continue;
      }
      // A replaced binary: a new blob and a manifest update.
      if (!this.canEdit) continue;
      const api = this.ctx.host.api;
      if (!api || !entry) continue;
      try {
        await api.uploadBlob(this.info.projectId, bytes, entry.mime ?? mimeForPath(record.path));
      } catch (error) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not upload ${record.path}`, error);
        needsRetry = true;
        continue;
      }
      const updated: ManifestEntry = { ...entry, blobHash: hash, size: bytes.byteLength, updatedAt: now };
      operations.push((map, doc) => {
        map.set(fileId, entryRecord(updated));
        if (this.info.album) this.photoReplaced(doc, fileId, entry.blobHash, hash, accountId, now);
      });
      setMaterialized(record, hash, seen.size, seen.mtimeMs);
      this.ctx.host.store.putBlob({ hash, localPath: absolute, size: bytes.byteLength });
      touched.add(record.path);
    }

    // Other roles cannot change the manifest; their local changes stay local.
    if (!this.canEdit) return;

    // New files and folders the layout does not know.
    const fresh: Array<{ entry: WalkEntry; bytes: Uint8Array; hash: string }> = [];
    for (const [relative, entry] of files) {
      if (known.has(relative)) continue;
      const absolute = await resolveInside(this.info.root, relative).catch(() => null);
      const bytes = absolute ? await readIfExists(absolute) : null;
      if (bytes) fresh.push({ entry, bytes, hash: sha256(bytes) });
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
      const updated: ManifestEntry = { ...entry, path: match.entry.relative, updatedAt: now };
      operations.push((map) => map.set(fileId, entryRecord(updated)));
      Object.assign(record, { path: match.entry.relative, size: match.entry.size, mtimeMs: match.entry.mtimeMs });
      if (record.docId) {
        this.ctx.host.store.upsertDoc({ docId: record.docId, projectId: this.info.projectId, fileId, path: record.path, materializedHash: record.hash ?? null });
      }
    }

    // Still missing after the grace period: deleted.
    for (const fileId of missing) {
      const since = this.missingSince.get(fileId) ?? now;
      this.missingSince.set(fileId, since);
      if (now - since < this.ctx.timings.deleteGraceMs) {
        this.scheduleScan(since + this.ctx.timings.deleteGraceMs - now + 10);
        continue;
      }
      if (!this.canEdit) continue;
      const record = this.state.layout[fileId];
      operations.push((map) => map.delete(fileId));
      touched.add(record.path);
      if (record.docId) removedRecords.push(record);
      delete this.state.layout[fileId];
      this.missingSince.delete(fileId);
    }

    if (this.canEdit) {
      for (const candidate of fresh) {
        const created = await this.createFromDisk(candidate.entry, candidate.bytes, candidate.hash, accountId, now);
        if (!created) {
          needsRetry = true;
          continue;
        }
        operations.push((map, doc) => {
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
        if (known.has(relative)) continue;
        const fileId = randomId("fil");
        const created: ManifestEntry = { fileId, path: relative, kind: "folder", createdBy: accountId, createdAt: now, updatedAt: now };
        this.state.layout[fileId] = { path: relative, kind: "folder", mtimeMs: entry.mtimeMs };
        operations.push((map) => map.set(fileId, entryRecord(created)));
        touched.add(relative);
      }
    }

    if (operations.length > 0) {
      if (!(await this.rootAvailable())) {
        this.state.layout = previous;
        this.missingSince.clear();
        return;
      }
      await this.writeManifest((map, doc) => {
        for (const operation of operations) operation(map, doc);
      }, EXTERNAL);
      if (addedPhotos.length > 0) this.reportAddedPhotos(addedPhotos);
      for (const record of removedRecords) {
        this.docs.get(record.docId!)?.hub.markDeleted();
        try { await this.archiveRemoved(record); }
        finally { this.releaseDoc(record.docId!); this.dropReconciliations(record.docId!); }
      }
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
    const fileId = randomId("fil");
    const classified = classifyFile(entry.relative, bytes);
    try {
      if (classified.kind === "doc") {
        const docId = randomId("doc");
        await createSharedDocument(api, this.info.projectId, { docId, fileId }, classified.docKind, classified.text);
        this.state.layout[fileId] = { path: entry.relative, kind: "doc", docId, docKind: classified.docKind, hash, size: entry.size, mtimeMs: entry.mtimeMs };
        await writeBase(this.info.root, docId, classified.text);
        this.ctx.host.store.upsertDoc({ docId, projectId: this.info.projectId, fileId, path: entry.relative, materializedHash: hash });
        return { fileId, path: entry.relative, kind: "doc", docId, docKind: classified.docKind, size: bytes.byteLength, createdBy: accountId, createdAt: now, updatedAt: now };
      }
      const mime = mimeForPath(entry.relative);
      await api.uploadBlob(this.info.projectId, bytes, mime);
      this.state.layout[fileId] = { path: entry.relative, kind: "blob", hash, size: entry.size, mtimeMs: entry.mtimeMs };
      this.ctx.host.store.putBlob({ hash, localPath: path.join(this.info.root, ...entry.relative.split("/")), size: bytes.byteLength });
      return { fileId, path: entry.relative, kind: "blob", blobHash: hash, size: bytes.byteLength, mime, createdBy: accountId, createdAt: now, updatedAt: now };
    } catch (error) {
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not share new file ${entry.relative}; retrying later`, error);
      return null;
    }
  }

  // ------------------------------------------------------------ file operations (control API)

  /** create-file, create-folder, write-blob, rename and delete, through the manifest; the disk follows. */
  fileOp(request: FileOpRequest): Promise<{ paths: string[] }> {
    return this.enqueue(async () => {
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
      const paths: string[] = [];
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
          const key = manifestPathKey(relative);
          const existing = [...this.entries.values()].find((entry) => manifestPathKey(entry.path) === key);
          if (existing && request.createOnly) throw new ControlError(409, "conflict", `${existing.path} already exists.`);
          if (!existing) {
            // A new file: the same as create-file, from bytes.
            this.assertFree(relative, []);
            const fileId = randomId("fil");
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
          if (!this.follower) {
            const target = await this.resolveOrRefuse(existing.path);
            const stats = await writeFileAtomic(target, bytes);
            // Record the hash before the manifest changes, so neither the
            // materializer nor the watcher treats our own write as remote or external.
            this.state.layout[existing.fileId] = { path: existing.path, kind: "blob", hash, size: stats.size, mtimeMs: stats.mtimeMs };
            this.ctx.host.store.putBlob({ hash, localPath: target, size: bytes.byteLength });
          }
          const updated: ManifestEntry = { ...existing, blobHash: hash, size: bytes.byteLength, updatedAt: now };
          await this.writeManifest((map, doc) => {
            map.set(existing.fileId, entryRecord(updated));
            if (this.info.album) this.photoReplaced(doc, existing.fileId, existing.blobHash, hash, accountId, now);
          }, { source: "typing" });
          paths.push(existing.path);
          break;
        }
        case "rename": {
          if (!request.to) throw new ControlError(400, "bad-request", "rename needs `to`.");
          const to = normalizeRelative(request.to);
          const moving = entriesUnder(this.entries.values(), relative);
          if (moving.length === 0) throw new ControlError(404, "not-found", `${relative} is not in this notebook.`);
          this.assertFree(to, moving.map((entry) => entry.fileId));
          const depth = relative.split("/").length;
          const updates = moving.map((entry) => {
            const rest = entry.path.split("/").slice(depth);
            const next = [to, ...rest].join("/");
            if (!isShareablePath(next)) throw new ControlError(400, "bad-request", `${next} is not an allowed path.`);
            paths.push(entry.path, next);
            return { ...entry, path: next, updatedAt: now };
          });
          await this.writeManifest((map) => {
            for (const entry of updates) map.set(entry.fileId, entryRecord(entry));
          }, { source: "typing" });
          break;
        }
        case "delete": {
          const removing = entriesUnder(this.entries.values(), relative);
          if (removing.length === 0) throw new ControlError(404, "not-found", `${relative} is not in this notebook.`);
          await this.writeManifest((map) => {
            for (const entry of removing) map.delete(entry.fileId);
          }, { source: "typing" });
          paths.push(...removing.map((entry) => entry.path));
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
    // The bytes are known, so write the file now instead of waiting for the server echo.
    const stats = await writeFileAtomic(target, bytes);
    this.state.layout[fileId] = {
      path: relative,
      kind: created.kind,
      ...(created.docId ? { docId: created.docId, docKind: created.docKind } : {}),
      hash,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
    if (created.docId && classified.kind === "doc") {
      await writeBase(this.info.root, created.docId, classified.text);
      this.ctx.host.store.upsertDoc({ docId: created.docId, projectId: this.info.projectId, fileId, path: relative, materializedHash: hash });
    } else {
      this.ctx.host.store.putBlob({ hash, localPath: target, size: bytes.byteLength });
    }
    return created;
  }

  private assertFree(relative: string, except: string[]): void {
    if (!isShareablePath(relative)) throw new ControlError(400, "bad-request", `${relative} is not an allowed path in a shared notebook.`);
    const key = manifestPathKey(relative);
    for (const entry of this.entries.values()) {
      if (except.includes(entry.fileId)) continue;
      const entryKey = manifestPathKey(entry.path);
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
    return this.enqueue(async () => {
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

  private saveSoon(): void {
    if (this.saveTimer || this.stopped || this.follower) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.enqueue(async () => {
        if (await this.rootAvailable()) await writeState(this.info.root, this.state);
      });
    }, 100);
    this.saveTimer.unref?.();
  }
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
