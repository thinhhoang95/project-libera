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

import type { FileOpRequest, HostEvent, Reconciliation } from "../../../src/lib/collab/local-api";
import type { Provenance } from "../../../src/lib/collab/protocol/actor";
import type { Role } from "../../../src/lib/collab/protocol/roles";
import { roleAtLeast } from "../../../src/lib/collab/protocol/roles";
import { ContentKeys, ManifestKeys, manifestPathKey, type ManifestEntry } from "../../../src/lib/collab/protocol/schema";
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
import { readBase, readState, writeBase, writeState, deleteBase, type LayoutRecord, type ProjectState } from "./state";
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

  private constructor(ctx: ProjectContext, info: ProjectInfo, state: ProjectState) {
    this.ctx = ctx;
    this.info = info;
    this.state = state;
  }

  static async open(ctx: ProjectContext, info: ProjectInfo): Promise<SharedProject> {
    return new SharedProject(ctx, info, await readState(info.root));
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
    this.startWatching();
  }

  /** Stops syncing and watching. Files stay where they are. */
  async stop(): Promise<void> {
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
    await writeState(this.info.root, this.state).catch(() => undefined);
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
    const layout = computeLayout(readManifest(this.manifestDoc()).values());
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
    this.entries = readManifest(this.manifestDoc());
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
      if (record.kind !== "folder") await this.archive(record.path);
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
      if (record.kind === "doc" && record.docId && !record.hash) {
        const runtime = this.docs.get(record.docId);
        if (runtime && runtime.fileId === fileId && this.docReady(runtime)) await this.materializeDoc(record.docId);
      }
    }
    if (needsRetry) this.scheduleRetry();
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
        Object.assign(record, { hash, size: stats?.size, mtimeMs: stats?.mtimeMs });
        return true;
      }
      // The local copy changed and the shared file was replaced too: keep the
      // local bytes in the archive rather than overwrite them silently.
      if (record.hash && existingHash !== record.hash) await this.archive(record.path);
    }
    const bytes = await this.blobBytes(hash);
    if (!bytes) return false;
    const stats = await writeFileAtomic(target, bytes);
    Object.assign(record, { hash, size: stats.size, mtimeMs: stats.mtimeMs });
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

  private async writeManifest(fn: (files: Y.Map<unknown>) => void, provenance: Provenance): Promise<void> {
    const hub = this.manifestHub;
    if (!hub) throw new Error("The manifest is not open.");
    hub.applyLocalChange("manifest", (doc) => fn(doc.getMap<unknown>(ManifestKeys.files)), provenance);
    this.entries = readManifest(hub.getDoc("manifest"));
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
    if (this.stopped) return;
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
    const bytes = encodeText(text);
    const hash = sha256(bytes);
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
    const stats = await writeFileAtomic(target, bytes);
    Object.assign(record, { hash, size: stats.size, mtimeMs: stats.mtimeMs });
    await writeBase(this.info.root, docId, text);
    this.ctx.host.store.upsertDoc({ docId, projectId: this.info.projectId, fileId, path: record.path, materializedHash: hash });
    this.saveSoon();
    this.filesChanged([record.path]);
    // A collaborator's new document exists on disk only now; the tree-changed
    // sent when its manifest entry arrived came before the file did.
    if (!disk) {
      this.ctx.emit({ t: "tree-changed", projectId: this.info.projectId, notebook: this.info.notebook, added: [this.liberaPath(record.path)], moves: [], removed: [] });
    }
  }

  /** Records bytes already on disk as the materialized state of a document. */
  private async adopt(fileId: string, record: LayoutRecord, hash: string, text: string, target: string): Promise<void> {
    const stats = await statIfExists(target);
    const changed = record.hash !== hash;
    Object.assign(record, { hash, size: stats?.size, mtimeMs: stats?.mtimeMs });
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
    if (!this.canEdit) {
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} changed on disk, but this role cannot edit; the change stays local.`);
      return;
    }
    if (!this.docReady(runtime)) return;
    const diskText = decodeText(disk);
    if (diskText === null) {
      this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: ${record.path} is no longer UTF-8 text; it was not synced.`);
      return;
    }
    const fileId = runtime.fileId;
    const target = await resolveInside(this.info.root, record.path);
    const shared = runtime.hub.getText("content");
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
      Object.assign(found.record, { hash, size: stats.size, mtimeMs: stats.mtimeMs });
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
    if (this.stopped) return;
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
    const { entries: walked } = await walkNotebook(this.info.root);
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
    const operations: Array<(files: Y.Map<unknown>) => void> = [];
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
      const bytes = absolute ? await readIfExists(absolute) : null;
      if (!bytes || !absolute) continue;
      const hash = sha256(bytes);
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
      // A replaced binary: a new blob and a manifest update.
      if (!this.canEdit) continue;
      const api = this.ctx.host.api;
      const entry = this.entries.get(fileId);
      if (!api || !entry) continue;
      try {
        await api.uploadBlob(this.info.projectId, bytes, entry.mime ?? mimeForPath(record.path));
      } catch (error) {
        this.ctx.logger.warn(`Shared notebook ${this.info.notebook}: could not upload ${record.path}`, error);
        needsRetry = true;
        continue;
      }
      const updated: ManifestEntry = { ...entry, blobHash: hash, size: bytes.byteLength, updatedAt: now };
      operations.push((map) => map.set(fileId, entryRecord(updated)));
      Object.assign(record, { hash, size: seen.size, mtimeMs: seen.mtimeMs });
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
      if (record.docId) {
        this.releaseDoc(record.docId);
        this.dropReconciliations(record.docId);
      }
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
        operations.push((map) => map.set(created.fileId, entryRecord(created)));
        touched.add(candidate.entry.relative);
      }
      for (const [relative, entry] of directories) {
        if (known.has(relative)) continue;
        const fileId = randomId("fil");
        const created: ManifestEntry = { fileId, path: relative, kind: "folder", createdBy: accountId, createdAt: now, updatedAt: now };
        this.state.layout[fileId] = { path: relative, kind: "folder", mtimeMs: entry.mtimeMs };
        operations.push((map) => map.set(fileId, entryRecord(created)));
        touched.add(relative);
      }
    }

    if (operations.length > 0) {
      await this.writeManifest((map) => {
        for (const operation of operations) operation(map);
      }, EXTERNAL);
      for (const [fileId, record] of Object.entries(this.state.layout)) {
        if (record.kind === "doc" && record.docId && !this.docs.has(record.docId)) this.ensureDoc(record.docId, fileId);
      }
    }
    if (touched.size > 0 || operations.length > 0) {
      this.saveSoon();
      this.ctx.layoutChanged(this.info.projectId);
      this.filesChanged([...touched]);
    }
    if (needsRetry) this.scheduleRetry();
  }

  /** A new local file becomes a shared document or blob. Returns its manifest entry, or null to retry later. */
  private async createFromDisk(entry: WalkEntry, bytes: Uint8Array, hash: string, accountId: string, now: number): Promise<ManifestEntry | null> {
    const api = this.ctx.host.api;
    if (!api) return null;
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
      this.entries = readManifest(this.manifestDoc());
      const relative = normalizeRelative(request.path);
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
          const bytes = request.stagedFile !== undefined ? await this.takeStaged(request.stagedFile) : base64Bytes(request.contentBase64);
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
          const target = await this.resolveOrRefuse(existing.path);
          const stats = await writeFileAtomic(target, bytes);
          // Record the hash before the manifest changes, so neither the
          // materializer nor the watcher treats our own write as remote or external.
          this.state.layout[existing.fileId] = { path: existing.path, kind: "blob", hash, size: stats.size, mtimeMs: stats.mtimeMs };
          this.ctx.host.store.putBlob({ hash, localPath: target, size: bytes.byteLength });
          const updated: ManifestEntry = { ...existing, blobHash: hash, size: bytes.byteLength, updatedAt: now };
          await this.writeManifest((map) => map.set(existing.fileId, entryRecord(updated)), { source: "typing" });
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
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.enqueue(() => writeState(this.info.root, this.state));
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
