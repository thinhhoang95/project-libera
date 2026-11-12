// The NotebookService: shared notebooks on disk (collaboration map §7.3,
// implementation plan M1.5 and the revocation part of M1.8).
//
// It owns the list of shared notebooks, the share and join flows, the
// control routes for files and reconciliations, revocation, and the
// in-memory index behind resolvePath. Each running notebook is a
// SharedProject (project.ts).

import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { readNotebookBinding, readNotebookLifecycle, recordNotebookBinding, recordNotebookLifecycle, sameNotebookIdentity } from "../../../src/lib/collab/local-notebook-state";

import type {
  AlbumOriginalResponse,
  FileOpRequest,
  JoinProjectRequest,
  LocalAlbum,
  LocalProject,
  Reconciliation,
  ResolvedDoc,
  ShareAlbumRequest,
  ShareAlbumResult,
  ResolvedPdf,
  ShareNotebookRequest,
  ShareProgress,
  UpdateAlbumRequest,
} from "../../../src/lib/collab/local-api";
import { stripPhotoMetadata } from "../../../src/lib/collab/photo-metadata";
import { ControlRoutes } from "../../../src/lib/collab/local-api";
import type { ProjectSummary } from "../../../src/lib/collab/protocol/api";
import { EventKind } from "../../../src/lib/collab/protocol/messages";
import { isRole, roleAtLeast, type Role } from "../../../src/lib/collab/protocol/roles";
import {
  AlbumSettingKeys,
  ManifestKeys,
  albumImageType,
  manifestPathKey,
  type AlbumPhotoRecord,
  type ManifestEntry,
  type ProjectKind,
} from "../../../src/lib/collab/protocol/schema";
import { ApiClientError, type ApiClient } from "../core/api-client";
import { consoleLogger, type Logger } from "../core/clock";
import type { CollabHostEvent } from "../core/host";
import { normalizedServerUrl, sameAuthority } from "../core/authority";
import { ControlError, type ControlDeps, type ControlHandler, type ControlRouter, type NotebookService } from "../control/types";
import { classifyFile, createSharedDocument, mimeForPath } from "./documents";
import { ARCHIVE_DIRECTORY, SHARE_PENDING_FILE, SHARED_MARKER_FILE, PathRefusedError, WriteCancelledError, checkWriteGuard, contentGuard, randomId, readIfExists, isNotFound, sha256, statIfExists, walkNotebook, writeFileAtomic, type WriteGuard } from "./fs-ops";
import { entryRecord } from "./layout";
import { isPdfDocId, isPdfPath, PDF_LIVE_SETTING } from "../../../src/lib/collab/protocol/pdf";
import { DEFAULT_TIMINGS, SharedProject, hubHasState, type IndexedDoc, type ProjectContext, type Timings } from "./project";
import {
  deleteMarker,
  deleteSharePlan,
  readMarker,
  readSharePlan,
  recordShareUpload,
  writeBase,
  writeMarker,
  writeSharePlan,
  writeState,
  emptyState,
  type PlannedFile,
  type SharePlan,
  type SharedMarker,
} from "./state";

export interface NotebookServiceOptions {
  timings?: Partial<Timings>;
  logger?: Logger;
  /** How long join waits for the first full materialization before answering. */
  joinTimeoutMs?: number;
  /** How long share waits for the server to acknowledge the manifest. */
  shareSyncTimeoutMs?: number;
  /**
   * How long a synced folder's writer lease lasts unless renewed. Leases are
   * renewed, and followers try to take over, every third of it; the same
   * pass looks for shared folders that arrived through a sync client.
   */
  leaseTtlMs?: number;
  /**
   * How long a bound folder's sharing marker must stay missing before it is
   * restored from this installation's binding (a cloud provider may only be
   * delivering it late; restoring it early would make a conflict copy).
   */
  markerRepairDelayMs?: number;
}

/** A shared-notebook folder for the signed-in account whose project this account cannot open. */
export interface UnjoinedFolder {
  notebook: string;
  projectId: string;
  /** The server answered 404 (not a member, or deleted) or 403. */
  status: 404 | 403 | 409;
  reason?: "unreadable-marker" | "ambiguous-copy";
}

/**
 * The answer to a lease request: granted or refused by the server; no
 * answer (offline, or no folder identity yet); a server without leases; or
 * no account to ask with.
 */
interface Lease {
  outcome: "granted" | "refused" | "unavailable" | "unsupported" | "signed-out";
  /** Another installation has asked for the lease: the folder is synced elsewhere. */
  contended: boolean;
}

export interface ShareResult {
  projectId: string;
  name: string;
  notebook: string;
  documents: number;
  blobs: number;
  folders: number;
  /** Files left local because their names cannot be shared (reserved or invalid on some system). */
  skipped: string[];
  /** The server has acknowledged the file list (false: it syncs when the connection allows). */
  synced: boolean;
  notes: string[];
}

/** What a share starts from: a notebook folder, or a gallery folder shared as an album. */
interface ShareTarget {
  pdfLive?: boolean;
  kind: ProjectKind;
  /** Folder name (a notebook, or an album's folder in the gallery). */
  notebook: string;
  root: string;
  album?: {
    direct: boolean;
    keepLocation: boolean;
    sharePrompts: boolean;
    /** Captions and prompts by file name (manifestPathKey). */
    photos: Map<string, { caption?: string; prompt?: string; model?: string }>;
  };
}

export interface JoinResult {
  projectId: string;
  kind: ProjectKind;
  name: string;
  notebook: string;
  role: Role;
  /** Every file was written before the answer (false: the rest arrive in the background). */
  materialized: boolean;
  alreadyJoined: boolean;
}

interface ProjectHandle {
  projectId: string;
  /** A notebook (under the library root) or a shared album (in the gallery). */
  kind: ProjectKind;
  name: string;
  notebook: string;
  root: string;
  role: Role;
  manifestDocId: string;
  revoked: boolean;
  revoking?: boolean;
  runtime: SharedProject | null;
  index: Map<string, IndexedDoc>;
  reconcilePending: number;
  /** This installation writes the folder; otherwise it follows through the CRDT. */
  writer: boolean;
  /** The folder's identity from its marker (the lease key), null for an older marker. */
  folderId: string | null;
  /** False once the server turned out to predate writer leases. */
  leaseSupported: boolean;
  /** Conservative monotonic deadline, never extended by a failed renewal. */
  leaseDeadline?: number;
}

function newHandle(projectId: string, name: string, root: string, role: Role, marker: SharedMarker): ProjectHandle {
  return {
    projectId,
    kind: marker.kind === "album" ? "album" : "notebook",
    name,
    notebook: path.basename(root),
    root,
    role,
    manifestDocId: marker.manifestDocId,
    revoked: marker.revoked === true,
    runtime: null,
    index: new Map(),
    reconcilePending: 0,
    writer: false,
    folderId: marker.folderId ?? null,
    leaseSupported: true,
  };
}

const LOCAL_REVIEW_NOTE =
  "Local review comments stay on this device for now; they move to the shared notebook when shared comments arrive.";
const ARCHIVE_NOTE = "The _archive folder stays local and is not shared.";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (condition()) resolve(true);
      else if (Date.now() >= deadline) resolve(false);
      else setTimeout(check, 50).unref?.();
    };
    check();
  });
}

/** The token from an invitation token or link (".../invite/<token>" or "?token=<token>"). */
export function invitationToken(input: string): string {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) throw new ControlError(400, "bad-request", "An invitation link or token is required.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlError(400, "bad-request", "The invitation link is not valid.");
  }
  const query = url.searchParams.get("token");
  if (query) return query;
  const last = url.pathname.split("/").filter(Boolean).pop();
  if (!last) throw new ControlError(400, "bad-request", "The invitation link has no token.");
  return decodeURIComponent(last);
}

/** A folder name for a project name that works on Windows, macOS and Linux. */
export function folderNameFor(projectName: string): string {
  let name = projectName
    .normalize("NFC")
    .replace(/[<>:"|?*\\/\u0000-\u001f]/g, "-")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim()
    .slice(0, 120);
  if (WINDOWS_RESERVED.test(name)) name = `${name}_`;
  if (name === "_archive" || name === "_assets") name = `${name} notebook`;
  return name || "Shared notebook";
}

function toControlError(error: unknown): unknown {
  if (error instanceof ApiClientError) {
    if (error.status === 0) return new ControlError(503, "offline", "The collaboration server cannot be reached.");
    return new ControlError(error.status, error.code, error.message);
  }
  if (error instanceof PathRefusedError) return new ControlError(400, "bad-request", error.message);
  if (error instanceof WriteCancelledError) return new ControlError(409, "notebook-changed", "The notebook or account changed while sharing. Its checkpoint was preserved for recovery.");
  return error;
}

export class NotebookServiceImpl implements NotebookService {
  readonly lifecycleDirectory: string;
  private readonly deps: Omit<ControlDeps, "notebooks">;
  private readonly logger: Logger;
  private readonly timings: Timings;
  private readonly joinTimeoutMs: number;
  private readonly shareSyncTimeoutMs: number;
  private readonly projects = new Map<string, ProjectHandle>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private unsubscribeHost: (() => void) | null = null;
  private cachedAccountId: string | null = null;
  private started = false;
  private loading: Promise<void> | null = null;
  private readonly leaseTtlMs: number;
  private readonly markerRepairDelayMs: number;
  /** Bound roots whose marker is missing, and since when (see repairMissingMarker). */
  private readonly markerMissingSince = new Map<string, number>();
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  /** Between beforeAccountChange and accountChanged: no lease is renewed or taken. */
  private releasing = false;
  /** Folders being shared or joined right now: their marker is ours before the store knows it. */
  private readonly pendingRoots = new Set<string>();
  private readonly unjoined = new Map<string, UnjoinedFolder>();
  /** Running on battery: projects check their folders less often. */
  private onBattery = false;

  /** Where shared albums live: the gallery folder (its direct children are albums). */
  private readonly galleryRoot: string;

  constructor(deps: Omit<ControlDeps, "notebooks">, options: NotebookServiceOptions = {}) {
    this.deps = deps;
    this.lifecycleDirectory = deps.lifecycleDir ?? path.join(path.dirname(deps.host.store.path), "notebook-lifecycle");
    this.galleryRoot = deps.galleryRoot ?? path.join(deps.libraryRoot, "..", "..", "gallery");
    this.logger = options.logger ?? consoleLogger;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.joinTimeoutMs = options.joinTimeoutMs ?? 60_000;
    this.shareSyncTimeoutMs = options.shareSyncTimeoutMs ?? 20_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.markerRepairDelayMs = options.markerRepairDelayMs ?? 5 * 60_000;
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeHost = this.deps.host.on((event) => this.hostEvent(event));
    await this.loadProjects().catch((error) => this.logger.warn("Shared notebooks could not all start; discovery will retry.", error));
    if (!this.started) return;
    this.leaseTimer = setInterval(() => void this.tick(), Math.max(100, Math.floor(this.leaseTtlMs / 3)));
    this.leaseTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribeHost?.();
    this.unsubscribeHost = null;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    this.deps.host.api?.cancelPending();
    await this.loading?.catch(() => undefined);
    await this.ticking?.catch(() => undefined);
    await Promise.all([...this.projects.values()].map((handle) => handle.runtime?.stop()));
    // Another installation on the same folder can take over right away.
    await Promise.all([...this.projects.values()].map((handle) => this.releaseLease(handle)));
    this.projects.clear();
  }

  async accountChanged(): Promise<void> {
    this.cachedAccountId = null;
    this.unjoined.clear();
    if (!this.started) {
      this.releasing = false;
      return;
    }
    await this.ticking?.catch(() => undefined);
    await Promise.all([...this.projects.values()].map((handle) => handle.runtime?.stop()));
    this.projects.clear();
    this.releasing = false;
    await this.loadProjects();
  }

  private loadProjects(): Promise<void> {
    this.loading = (async () => {
      await this.loadStoredProjects();
      await this.adoptMarkers();
    })();
    return this.loading;
  }

  private async folderRoots(): Promise<string[]> {
    const folders: string[] = [];
    for (const base of [this.deps.libraryRoot, this.galleryRoot]) {
      const entries: Dirent[] = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".")) folders.push(path.join(base, entry.name));
    }
    return folders;
  }

  private async movedRoot(projectId: string, previous: string): Promise<string | null> {
    const binding = readNotebookBinding(this.lifecycleDirectory, previous);
    const api = this.deps.host.api;
    const accountId = api ? await this.accountId().catch(() => null) : null;
    const candidates: string[] = [];
    for (const root of await this.folderRoots()) {
      if (this.pendingRoots.has(root)) continue;
      const marker = await readMarker(root).catch(() => null);
      if (!marker || marker.projectId !== projectId) continue;
      if (binding ? !sameNotebookIdentity(binding, marker) :
          !api || marker.accountId !== accountId || marker.serverUrl.replace(/\/+$/, "") !== api.baseUrl) continue;
      candidates.push(root);
    }
    if (candidates.length !== 1) {
      for (const root of candidates) this.unjoined.set(root, { notebook: path.basename(root), projectId, status: 409, reason: "ambiguous-copy" });
      return null;
    }
    if (!binding) {
      // Legacy rows have no local binding: require fresh server identity too.
      const project = await api!.getProject(projectId).catch(() => null);
      const marker = await readMarker(candidates[0]);
      if (!project || project.manifestDocId !== marker?.manifestDocId) return null;
    }
    return candidates[0];
  }

  private async loadStoredProjects(): Promise<void> {
    for (const row of this.deps.host.store.listProjects()) {
      if (!this.started) return;
      if (!row.localRoot || this.projects.has(row.projectId) || this.pendingRoots.has(row.localRoot)) continue;
      try {
        let root = row.localRoot;
        let marker = await readMarker(root).catch(() => null);
        if (!marker || marker.projectId !== row.projectId) {
          // A present foreign/corrupt root is not a move. Rebind only a missing
          // old directory to one unique compatible discovered identity. A
          // present root whose marker is gone gets it back from the binding.
          if (await statIfExists(root)) {
            if (!(await this.repairMissingMarker(row.projectId, root))) continue;
            marker = await readMarker(root).catch(() => null);
            if (!marker || marker.projectId !== row.projectId) continue;
          } else {
            const moved = await this.movedRoot(row.projectId, root);
            if (!moved) continue;
            root = moved;
            marker = await readMarker(root);
            if (!marker) continue;
            this.deps.host.store.upsertProject({ ...row, localRoot: root });
            this.unjoined.delete(root);
          }
        }
        if (!this.markerAuthorityMatches(marker)) continue;
        if (await this.repairEndedMarker(root, marker) === "local") {
          this.deps.host.store.deleteProject(row.projectId);
          continue;
        }
        marker = await readMarker(root);
        if (!marker) continue;
        const handle = newHandle(row.projectId, row.name, root, row.role ?? "viewer", marker);
        this.projects.set(handle.projectId, handle);
        if (handle.revoked) {
          const { docs, reconcilePending } = await SharedProject.readIndex(root);
          handle.index = indexOf(docs);
          handle.reconcilePending = reconcilePending;
        } else {
          handle.writer = await this.claimRole(handle, marker);
          await this.run(handle);
        }
        this.unjoined.delete(root);
      } catch (error) {
        const handle = this.projects.get(row.projectId);
        await handle?.runtime?.stop({ persist: false }).catch(() => undefined);
        this.projects.delete(row.projectId);
        this.logger.warn(`Shared notebook ${row.name} could not start; other notebooks will continue and this one will retry.`, error);
      }
    }
  }

  private async run(handle: ProjectHandle): Promise<void> {
    const marker = await readMarker(handle.root);
    if (!this.matchesMarker(handle, marker) || !this.markerAuthorityMatches(marker)) throw new ControlError(409, "notebook-unavailable", "The notebook folder identity changed while it was opening.");
    recordNotebookBinding(this.lifecycleDirectory, handle.root, marker);
    const runtime = await SharedProject.open(this.context(), {
      projectId: handle.projectId,
      name: handle.name,
      notebook: handle.notebook,
      root: handle.root,
      role: handle.role,
      manifestDocId: handle.manifestDocId,
      folderId: handle.folderId ?? undefined,
      accountId: marker.accountId,
      serverUrl: marker.serverUrl,
      follower: !handle.writer,
      ...(handle.kind === "album" ? { album: true } : {}),
    });
    if (handle.writer && (handle.leaseDeadline ?? 0) <= performance.now()) {
      handle.writer = false;
      runtime.info.follower = true;
    }
    handle.runtime = runtime;
    this.reindex(handle.projectId);
    runtime.start();
  }

  // ------------------------------------------------------------ synced folders: writer lease and adoption
  //
  // A shared folder synced by OneDrive or the like reaches every device (or
  // Libera profile) on the same synced data folder. Exactly one installation
  // writes it: the holder of the folder's lease on the server. The others
  // follow: they sync the CRDT, so the app and the agent work there too, and
  // the writer's files arrive through the sync client. Leases expire, so the
  // role moves when the writer goes offline; the new writer starts from the
  // folder's state.json, and the stale-copy guard (state.ts) keeps late
  // copies of older versions from undoing newer edits.
  //
  // Automatic disk work stops when the last confirmed lease expires. Editors
  // and explicit shared file operations still work through the follower path.

  /** Whether this installation writes the folder, settling its lease and marker. */
  private async claimRole(handle: ProjectHandle, marker: SharedMarker): Promise<boolean> {
    const named = !marker.writer || marker.writer === this.installationId;
    if (!marker.folderId && named) {
      const binding = readNotebookBinding(this.lifecycleDirectory, handle.root);
      if (binding && !sameNotebookIdentity({ ...binding, folderId: undefined }, marker)) return false;
      // Restore a locally known identity if a cloud delivery omitted it;
      // genuinely old markers receive a new lease key only once.
      const legacyKey = sha256(Buffer.from(JSON.stringify([marker.serverUrl.replace(/\/+$/, ""), marker.accountId, marker.projectId, marker.manifestDocId, marker.sharedAt]))).slice(0, 32);
      const upgraded = { ...marker, folderId: binding?.folderId ?? `fld_${legacyKey}` };
      await writeMarker(handle.root, upgraded, {
        root: handle.root,
        canCommit: async () => JSON.stringify(await readMarker(handle.root).catch(() => null)) === JSON.stringify(marker),
      });
      recordNotebookBinding(this.lifecycleDirectory, handle.root, upgraded);
      handle.folderId = upgraded.folderId;
    }
    const lease = await this.lease(handle);
    const writer = this.keepsWriting(handle, lease, marker);
    if (writer) await this.updateMarker(handle, { writer: this.installationId, ...(lease.contended ? { syncedElsewhere: true } : {}) });
    return writer;
  }

  /**
   * Whether this installation writes the folder, given its lease and the
   * marker. No marker can extend the last confirmed server lease.
   */
  private keepsWriting(handle: ProjectHandle, lease: Lease, marker: SharedMarker): boolean {
    const named = !marker.writer || marker.writer === this.installationId;
    switch (lease.outcome) {
      case "granted":
        return true;
      case "refused":
        return false;
      case "signed-out":
      case "unsupported":
        return false;
      default:
        return named && (handle.leaseDeadline ?? 0) > performance.now();
    }
  }

  private async lease(handle: ProjectHandle): Promise<Lease> {
    const api = this.deps.host.api;
    if (!api) return { outcome: "signed-out", contended: false };
    if (!handle.leaseSupported) return { outcome: "unsupported", contended: false };
    if (!handle.folderId) return { outcome: "unavailable", contended: false };
    const requestedAt = performance.now();
    try {
      const lease = await api.acquireFolderLease(handle.projectId, { folderId: handle.folderId, holder: this.installationId, ttlMs: this.leaseTtlMs }, { timeoutMs: Math.min(5000, Math.max(100, Math.floor(this.leaseTtlMs / 3))) });
      if (!this.started || this.releasing) return { outcome: "unavailable", contended: false };
      handle.leaseDeadline = lease.granted
        ? requestedAt + Math.max(0, Math.min(this.leaseTtlMs, Date.parse(lease.expiresAt ?? "") - Date.now()))
        : 0;
      return { outcome: lease.granted ? "granted" : "refused", contended: lease.contended === true };
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) {
        // The project is gone (revocation follows), or the server predates leases.
        const exists = await api.getProject(handle.projectId, { timeoutMs: 5000 }).then(
          () => true,
          () => false,
        );
        if (exists) {
          handle.leaseSupported = false;
          this.logger.warn(`Shared notebook ${handle.name}: the server has no writer leases; the folder's marker decides who writes it.`);
          return { outcome: "unsupported", contended: false };
        }
      }
      return { outcome: "unavailable", contended: false };
    }
  }

  private async releaseLease(handle: ProjectHandle): Promise<void> {
    handle.leaseDeadline = 0;
    const api = this.deps.host.api;
    if (!api || !handle.writer || !handle.folderId || !handle.leaseSupported || handle.revoked) return;
    await api.releaseFolderLease(handle.projectId, handle.folderId, this.installationId).catch(() => undefined);
  }

  /** Changes this project's marker (only a writer calls this; nothing happens when the marker is not this project's). */
  private async updateMarker(handle: ProjectHandle, patch: Partial<SharedMarker>): Promise<void> {
    const marker = await readMarker(handle.root).catch(() => null);
    if (!this.matchesMarker(handle, marker) || marker.revoked) return;
    const next: SharedMarker = { ...marker, ...patch };
    if (JSON.stringify(next) === JSON.stringify(marker)) return;
    await writeMarker(handle.root, next, {
      root: handle.root,
      canCommit: async () => JSON.stringify(await readMarker(handle.root).catch(() => null)) === JSON.stringify(marker),
    }).catch((error: unknown) => this.logger.warn(`Could not update the marker of ${handle.name}.`, error));
  }

  /**
   * Called before sign-out or an account switch, while the account can still
   * reach the server: gives the leases up, so another installation on the
   * same folders takes over at its next check instead of when they expire.
   */
  async beforeAccountChange(): Promise<void> {
    this.releasing = true;
    this.deps.host.api?.cancelPending();
    await this.ticking?.catch(() => undefined);
    await Promise.all([...this.projects.values()].map((handle) => this.releaseLease(handle)));
  }

  /** Renews leases, hands the writing role over, and adopts folders that arrived. */
  private tick(): Promise<void> {
    if (this.ticking || !this.started || this.releasing) return this.ticking ?? Promise.resolve();
    this.ticking = (async () => {
      try {
        await this.loading?.catch(() => undefined);
        await this.loadStoredProjects();
        let rebound = false;
        for (const handle of [...this.projects.values()]) {
          if (!this.started || this.releasing) return;
          await this.locked(`project:${handle.projectId}`, async () => {
            if (!handle.revoked && await this.rebindMovedRoot(handle)) {
              rebound = true;
              return;
            }
            if (!handle.revoked) await this.repairMissingMarker(handle.projectId, handle.root);
            if (handle.revoked) {
              const marker = await readMarker(handle.root).catch(() => null);
              if (this.matchesMarker(handle, marker)) {
                const reason = this.deps.host.store.getDocMeta(handle.manifestDocId)?.readOnlyReason;
                if (reason === "access-revoked" || reason === "document-deleted") recordNotebookLifecycle(this.lifecycleDirectory, marker, "revoked");
                await this.repairEndedMarker(handle.root, marker);
              }
            } else await this.checkLease(handle);
          }).catch((error) => this.logger.warn(`Shared notebook ${handle.name}: lifecycle/lease check will retry.`, error));
        }
        // A rebound project starts again at its new folder, as at startup.
        if (rebound && this.started && !this.releasing) await this.loadStoredProjects();
        if (this.started && !this.releasing) await this.adoptMarkers();
      } catch (error) {
        this.logger.warn("Shared notebooks: the writer lease check failed.", error);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  /**
   * A running notebook's folder renamed or moved (Finder, a sync client):
   * hands the project to the one compatible folder found, with the startup
   * identity checks (movedRoot); loadStoredProjects then starts it there.
   * A folder only missing for now (an unmounted drive, a provider re-sync)
   * has no such candidate and keeps its runtime, whose disk work pauses.
   */
  private async rebindMovedRoot(handle: ProjectHandle): Promise<boolean> {
    if (!this.started || this.projects.get(handle.projectId) !== handle || await statIfExists(handle.root)) return false;
    const moved = await this.movedRoot(handle.projectId, handle.root);
    if (!moved || moved === handle.root || this.projects.get(handle.projectId) !== handle) return false;
    const runtime = handle.runtime;
    handle.runtime = null;
    // The old folder is gone: nothing to persist there.
    await runtime?.stop({ persist: false });
    const row = this.deps.host.store.getProject(handle.projectId);
    if (row) this.deps.host.store.upsertProject({ ...row, localRoot: moved });
    this.projects.delete(handle.projectId);
    this.unjoined.delete(moved);
    this.logger.warn(`Shared notebook ${handle.name}: its folder moved to ${path.basename(moved)}; it continues there.`);
    this.deps.emit({ t: "project-changed", projectId: handle.projectId });
    this.deps.statusChanged?.();
    return true;
  }

  /**
   * Restores a bound folder's sharing marker after it went missing (deleted
   * by hand, or by a sync client) while the folder and this installation's
   * binding stay: without it every write is refused and nothing syncs. Only
   * once it has been missing for markerRepairDelayMs (a provider may be about
   * to deliver it) and the server confirms the same project.
   */
  private async repairMissingMarker(projectId: string, root: string): Promise<boolean> {
    const file = path.join(root, SHARED_MARKER_FILE);
    // A present marker, even an unreadable one, is not ours to replace.
    if (await statIfExists(file) || !(await statIfExists(root))) {
      this.markerMissingSince.delete(root);
      return false;
    }
    const binding = readNotebookBinding(this.lifecycleDirectory, root);
    if (!binding || binding.projectId !== projectId || readNotebookLifecycle(this.lifecycleDirectory, binding) !== null) return false;
    const now = Date.now();
    const since = this.markerMissingSince.get(root) ?? now;
    this.markerMissingSince.set(root, since);
    if (now - since < this.markerRepairDelayMs) return false;
    const api = this.deps.host.api;
    if (!api || !this.markerAuthorityMatches(binding)) return false;
    const project = await api.getProject(projectId).catch(() => null);
    if (!project || project.manifestDocId !== binding.manifestDocId) return false;
    // The writer is claimed again through the lease.
    const restored: SharedMarker = { ...binding };
    delete restored.writer;
    delete restored.revoked;
    delete restored.revokedAt;
    await writeMarker(root, restored, { root, canCommit: async () => !(await statIfExists(file)) });
    this.markerMissingSince.delete(root);
    this.logger.warn(`Shared notebook ${path.basename(root)}: its sharing marker was missing and has been restored.`);
    return true;
  }

  private async checkLease(handle: ProjectHandle): Promise<void> {
    if (!this.started || this.releasing || this.projects.get(handle.projectId) !== handle || handle.revoked || !handle.runtime) return;
    const reason = this.deps.host.store.getDocMeta(handle.manifestDocId)?.readOnlyReason;
    if (reason === "access-revoked" || reason === "document-deleted") {
      await this.doRevoke(handle.projectId, reason === "document-deleted");
      return;
    }
    // The marker is read every time: a writer named there by another
    // installation (which held the lease) wins even when the lease cannot be checked.
    const marker = await readMarker(handle.root).catch(() => null);
    if (!this.matchesMarker(handle, marker)) return;
    handle.folderId ??= marker.folderId ?? null;
    const lease = await this.lease(handle);
    const writer = this.keepsWriting(handle, lease, marker);
    if (writer !== handle.writer) await this.switchRole(handle, writer);
    else if (writer && lease.outcome === "granted") {
      await this.updateMarker(handle, { writer: this.installationId, ...(lease.contended ? { syncedElsewhere: true } : {}) });
      // Scans refused while the lease had lapsed (a wake from sleep) run now.
      handle.runtime?.leaseConfirmed();
    }
  }

  private async switchRole(handle: ProjectHandle, writer: boolean): Promise<void> {
    const runtime = handle.runtime;
    handle.runtime = null;
    // A demoted writer leaves state.json to the installation that writes the folder now.
    await runtime?.stop({ persist: false });
    handle.writer = writer;
    // Taking over means another installation used the folder before.
    if (writer) await this.updateMarker(handle, { writer: this.installationId, syncedElsewhere: true });
    this.logger.warn(
      writer
        ? `Shared notebook ${handle.name}: this installation writes the folder now (the previous writer went offline).`
        : `Shared notebook ${handle.name}: another installation writes the folder now, or this one cannot hold its lease; this one follows.`,
    );
    await this.run(handle);
    this.deps.emit({ t: "project-changed", projectId: handle.projectId });
  }

  /** Synced folders of the signed-in account whose project the server would not open (diagnostics). */
  unjoinedFolders(): UnjoinedFolder[] {
    return [...this.unjoined.values()];
  }

  /**
   * Shared folders that arrived through a sync client for the signed-in
   * account, whose project this host has not joined: confirmed with the
   * server, then run like any other (as a follower, unless the lease is free).
   */
  private async adoptMarkers(): Promise<void> {
    const api = this.deps.host.api;
    const accountId = api ? await this.accountId().catch(() => null) : null;
    for (const root of await this.folderRoots()) {
      if (!this.started) return;
      if (this.pendingRoots.has(root)) continue;
      try {
        const marker = await readMarker(root).catch(() => null);
        if (!marker) {
          if (await statIfExists(path.join(root, ".libera-shared.json"))) this.unjoined.set(root, { notebook: path.basename(root), projectId: "", status: 409, reason: "unreadable-marker" });
          continue;
        }
        if (await this.repairEndedMarker(root, marker)) continue;
        const binding = readNotebookBinding(this.lifecycleDirectory, root);
        if (binding && !sameNotebookIdentity(binding, marker) && !readNotebookLifecycle(this.lifecycleDirectory, binding)) {
          this.unjoined.set(root, { notebook: path.basename(root), projectId: marker.projectId, status: 409, reason: "ambiguous-copy" });
          continue;
        }
        if (!api || !accountId) continue;
        if (!marker || marker.revoked || marker.accountId !== accountId || marker.serverUrl.replace(/\/+$/, "") !== api.baseUrl) continue;
        if (this.projects.has(marker.projectId) || this.deps.host.store.getProject(marker.projectId)) continue;
        if (this.unjoined.get(root)?.projectId === marker.projectId) continue;
        await this.locked(`project:${marker.projectId}`, () => this.adopt(api, root, marker))
          .catch((error) => this.logger.warn(`Shared folder ${path.basename(root)} could not be adopted; discovery will retry.`, error));
      } catch (error) {
        this.logger.warn(`Shared folder ${path.basename(root)} could not be checked; other folders will continue.`, error);
      }
    }
  }

  private async repairEndedMarker(root: string, marker: SharedMarker): Promise<"local" | "revoked" | null> {
    const binding = readNotebookBinding(this.lifecycleDirectory, root);
    if (binding && !sameNotebookIdentity(binding, marker) && !readNotebookLifecycle(this.lifecycleDirectory, binding)) return null;
    const outcome = readNotebookLifecycle(this.lifecycleDirectory, marker);
    if (!outcome) return null;
    const originalRoot = await statIfExists(root).catch(() => null);
    const current = await readMarker(root).catch(() => null);
    if (!current || !sameNotebookIdentity(marker, current)) return outcome;
    if (outcome === "local") {
      // The root and marker are checked again immediately before the removal.
      const guard = this.cleanupGuard(root, originalRoot, (latest) => latest !== null && sameNotebookIdentity(marker, latest));
      await deleteMarker(root, guard).catch((error: unknown) => { if (!(error instanceof WriteCancelledError)) throw error; });
    }
    else if (!current.revoked) await writeMarker(root, { ...current, revoked: true, revokedAt: new Date().toISOString() }, {
      root,
      canCommit: async () => {
        const latest = await readMarker(root).catch(() => null);
        return latest !== null && sameNotebookIdentity(current, latest);
      },
    });
    return outcome;
  }

  private async rememberEnded(handle: ProjectHandle, outcome: "local" | "revoked"): Promise<void> {
    const marker = await readMarker(handle.root).catch(() => null);
    const binding = this.matchesMarker(handle, marker) ? marker : readNotebookBinding(this.lifecycleDirectory, handle.root);
    if (!this.matchesMarker(handle, binding)) return;
    recordNotebookLifecycle(this.lifecycleDirectory, binding, outcome);
    // A copy of the marker from before it had a folder id (a cloud provider
    // delivering an old version late) names the same share: it has ended too.
    if (binding.folderId) {
      const legacy: SharedMarker = { ...binding };
      delete legacy.folderId;
      recordNotebookLifecycle(this.lifecycleDirectory, legacy, outcome);
    }
  }

  private async adopt(api: ApiClient, root: string, marker: SharedMarker): Promise<void> {
    if (this.projects.has(marker.projectId) || this.deps.host.store.getProject(marker.projectId)) return;
    let project: ProjectSummary;
    try {
      project = await api.getProject(marker.projectId);
    } catch (error) {
      if (error instanceof ApiClientError && (error.status === 404 || error.status === 403)) {
        const notebook = path.basename(root);
        this.unjoined.set(root, { notebook, projectId: marker.projectId, status: error.status });
        // 404: the project was taken down, or this account lost access, while
        // the installation that writes the folder was away. Nothing would
        // ever clear the marker then, so it is marked revoked like a lost
        // share: the folder stays as a read-only copy that can be deleted.
        const revoked = error.status === 404 && (await this.revokeOrphanMarker(root, marker));
        this.logger.warn(
          `Shared notebook folder ${notebook} is for a notebook this account cannot open (${error.message}); ${revoked ? "it is kept as a read-only copy" : "it is left alone"}.`,
          root,
        );
      }
      return;
    }
    this.unjoined.delete(root);
    this.deps.host.store.upsertProject({ projectId: project.id, name: project.name, localRoot: root, role: project.role });
    const handle = newHandle(project.id, project.name, root, project.role, { ...marker, manifestDocId: project.manifestDocId });
    this.projects.set(project.id, handle);
    handle.writer = await this.claimRole(handle, marker);
    await this.run(handle);
    this.deps.emit({ t: "project-changed", projectId: project.id });
    this.deps.statusChanged?.();
  }

  /** Marks the marker of a project the server no longer has revoked, unless the folder holds another marker by now. */
  private async revokeOrphanMarker(root: string, marker: SharedMarker): Promise<boolean> {
    const current = await readMarker(root).catch(() => null);
    if (!current || !sameNotebookIdentity(current, marker) || current.revoked) return false;
    recordNotebookLifecycle(this.lifecycleDirectory, current, "revoked");
    return writeMarker(root, { ...current, revoked: true, revokedAt: new Date().toISOString() }, {
      root,
      canCommit: async () => JSON.stringify(await readMarker(root).catch(() => null)) === JSON.stringify(current),
    }).then(
      () => true,
      (error: unknown) => {
        this.logger.warn(`Could not mark the marker of ${path.basename(root)} revoked.`, error);
        return false;
      },
    );
  }

  private context(): ProjectContext {
    return {
      host: this.deps.host,
      logger: this.logger,
      timings: this.timings,
      onBattery: () => this.onBattery,
      emit: (event) => this.deps.emit(event),
      accountId: () => this.accountId(),
      revoked: (projectId) => void this.revoke(projectId).catch((error) => this.logger.warn("Could not finish notebook revocation; it will be retried.", error)),
      roleChanged: (projectId, role) => this.setRole(projectId, role),
      layoutChanged: (projectId) => this.reindex(projectId),
      canWriteDisk: (projectId) => {
        const handle = this.projects.get(projectId);
        return !!handle && handle.writer && !handle.revoked && !handle.revoking && !this.releasing &&
          (handle.leaseDeadline ?? 0) > performance.now();
      },
    };
  }

  private reindex(projectId: string): void {
    const handle = this.projects.get(projectId);
    if (!handle?.runtime) return;
    handle.index = indexOf(handle.runtime.indexedDocs());
    handle.reconcilePending = handle.runtime.reconcilePending;
  }

  private requireApi(): ApiClient {
    const api = this.deps.host.api;
    if (!api) throw new ControlError(401, "needs-sign-in", "Sign in to the collaboration server first.");
    return api;
  }

  private get installationId(): string {
    return this.deps.host.installationId;
  }

  /** Whether this installation may rewrite or remove the marker: it is this project's, and no other installation keeps the folder. */
  private ownsMarker(marker: SharedMarker, projectId: string): boolean {
    return marker.projectId === projectId && (!marker.writer || marker.writer === this.installationId);
  }

  private markerAuthorityMatches(marker: SharedMarker): boolean {
    if (this.deps.authority) return sameAuthority(marker, this.deps.authority);
    const host = this.deps.host;
    return !host.serverUrl || (normalizedServerUrl(marker.serverUrl) === normalizedServerUrl(host.serverUrl) && marker.accountId === host.accountId);
  }

  private matchesMarker(handle: ProjectHandle, marker: SharedMarker | null): marker is SharedMarker {
    if (marker === null || marker.projectId !== handle.projectId || marker.manifestDocId !== handle.manifestDocId ||
        (handle.folderId && marker.folderId !== handle.folderId)) return false;
    const binding = readNotebookBinding(this.lifecycleDirectory, handle.root);
    return !binding || binding.projectId !== handle.projectId || binding.manifestDocId !== handle.manifestDocId ||
      sameNotebookIdentity(binding, marker);
  }

  private async accountId(): Promise<string> {
    if (this.cachedAccountId) return this.cachedAccountId;
    const account = await this.requireApi().me();
    this.cachedAccountId = account.id;
    return account.id;
  }

  /** Serializes operations on the same notebook or project. */
  private async locked<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  // ------------------------------------------------------------ resolvePath

  resolvePath(liberaPath: string): ResolvedDoc | null {
    if (typeof liberaPath !== "string") return null;
    const segments = liberaPath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const handle = this.handleForNotebook(segments[0]);
    if (!handle) return null;
    const doc = handle.index.get(manifestPathKey(segments.slice(1).join("/")));
    if (!doc) return null;
    return {
      docId: doc.docId,
      projectId: handle.projectId,
      fileId: doc.fileId,
      path: `${handle.notebook}/${doc.path}`,
      kind: doc.docKind,
      role: handle.role,
      readOnly: handle.revoked || handle.revoking === true || !roleAtLeast(handle.role, "editor"),
      ...(handle.revoked ? { revoked: true } : {}),
    };
  }

  /** A PDF's live document, when the notebook has live PDFs on. Null means use its sidecar. */
  resolvePdf(liberaPath: string): ResolvedPdf | null {
    if (typeof liberaPath !== "string") return null;
    const segments = liberaPath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.length < 2 || !isPdfPath(segments.at(-1) ?? "")) return null;
    const handle = this.handleForNotebook(segments[0]);
    if (handle?.revoking) throw new ControlError(503, "unavailable", "Keeping the last PDF annotations.");
    if (handle && !handle.revoked && (!handle.runtime || !handle.runtime.pdfs.ready)) throw new ControlError(503, "unavailable", "Live PDF status is still loading.");
    if (handle?.revoked) return null;
    const resolved = handle?.runtime?.pdfs.resolve(segments.slice(1).join("/"));
    if (!handle || !resolved) return null;
    return {
      ...resolved,
      projectId: handle.projectId,
      path: `${handle.notebook}/${resolved.path}`,
      role: handle.role,
      readOnly: handle.revoked || handle.revoking === true || !roleAtLeast(handle.role, "commenter"),
      accountId: this.cachedAccountId ?? "",
      ...(handle.revoked ? { revoked: true } : {}),
    };
  }

  /** The reverse of resolvePath, over the same index (GET /docs/:docId). */
  resolveDoc(docId: string): ResolvedDoc | null {
    if (typeof docId !== "string" || !docId) return null;
    for (const handle of this.projects.values()) {
      // A notification about a live PDF opens the PDF.
      const pdf = handle.runtime?.pdfs.fileOf(docId);
      if (pdf) {
        return {
          docId,
          projectId: handle.projectId,
          fileId: pdf.fileId,
          path: `${handle.notebook}/${pdf.path}`,
          kind: "text",
          role: handle.role,
          readOnly: handle.revoked || handle.revoking === true || !roleAtLeast(handle.role, "commenter"),
          ...(handle.revoked ? { revoked: true } : {}),
        };
      }
      for (const doc of handle.index.values()) {
        if (doc.docId !== docId) continue;
        return {
          docId: doc.docId,
          projectId: handle.projectId,
          fileId: doc.fileId,
          path: `${handle.notebook}/${doc.path}`,
          kind: doc.docKind,
          role: handle.role,
          readOnly: handle.revoked || handle.revoking === true || !roleAtLeast(handle.role, "editor"),
          ...(handle.revoked ? { revoked: true } : {}),
        };
      }
    }
    return null;
  }

  private handleForNotebook(notebook: string): ProjectHandle | null {
    const key = notebook.normalize("NFC").toLowerCase();
    let fallback: ProjectHandle | null = null;
    for (const handle of this.projects.values()) {
      // An album folder lives in the gallery, not in the Notebooks tree.
      if (handle.kind === "album") continue;
      if (handle.notebook === notebook) return handle;
      if (handle.notebook.normalize("NFC").toLowerCase() === key) fallback = handle;
    }
    return fallback;
  }

  /** Shared notebooks for the host status (LocalProject). */
  localProjects(): LocalProject[] {
    return [...this.projects.values()].map((handle) => ({
      projectId: handle.projectId,
      name: handle.name,
      role: handle.role,
      notebook: handle.notebook,
      revoked: handle.revoked,
      reconcilePending: handle.runtime?.reconcilePending ?? handle.reconcilePending,
      ...(handle.kind === "album" ? { kind: "album" as const } : {}),
      ...(handle.runtime?.pdfs.enabled ? { pdfLive: true } : {}),
    }));
  }

  powerChanged(onBattery: boolean): void {
    if (this.onBattery === onBattery) return;
    this.onBattery = onBattery;
    for (const handle of this.projects.values()) handle.runtime?.powerChanged();
  }

  resumed(): void {
    for (const handle of this.projects.values()) handle.runtime?.resumed();
  }

  /** The running project (tests, diagnostics). */
  project(projectId: string): SharedProject | null {
    return this.projects.get(projectId)?.runtime ?? null;
  }

  // ------------------------------------------------------------ revocation and roles

  private hostEvent(event: CollabHostEvent): void {
    this.pdfDocumentCreated(event);
    if (event.source !== "sync" || event.event.type !== "server-event") return;
    const { scope, kind, payload } = event.event.event;
    const data = (payload ?? {}) as { projectId?: unknown; accountId?: unknown; role?: unknown };
    const projectId = typeof data.projectId === "string" ? data.projectId : null;
    if (!projectId || !this.projects.has(projectId)) return;
    // Project-scope events are about any member; only ours matter here.
    const aboutMe = scope === "user" || (this.cachedAccountId !== null && data.accountId === this.cachedAccountId);
    if (kind === EventKind.ProjectDeleted) {
      void this.revoke(projectId, { deleted: true }).catch((error) => this.logger.warn("Could not finish notebook takedown.", error));
    } else if (kind === EventKind.MemberRemoved && aboutMe) {
      void this.revoke(projectId).catch((error) => this.logger.warn("Could not finish notebook revocation.", error));
    } else if (kind === EventKind.RoleChanged && aboutMe && isRole(data.role)) {
      this.setRole(projectId, data.role);
    }
  }

  /** Someone opened a PDF for the first time, so it may gain marks this host should follow. */
  private pdfDocumentCreated(event: CollabHostEvent): void {
    if (event.source !== "sync" || event.event.type !== "server-event") return;
    const { id, kind } = event.event.event;
    if (kind === EventKind.PdfDocumentCreated) void this.projects.get(id)?.runtime?.pdfs.refreshServerDocuments();
    // Comments live on the server, so nothing in the document says they changed.
    if ((kind === EventKind.ThreadChanged || kind === EventKind.ThreadDeleted) && isPdfDocId(id)) {
      for (const handle of this.projects.values()) handle.runtime?.pdfs.commentsChanged(id);
    }
  }

  /**
   * Access ended: stop syncing, keep every file, mark the folder. The index
   * stays so resolvePath answers readOnly and the app can offer export.
   * When the project was this account's own and is gone, the account took it
   * down from another installation: that finishes as a takedown here.
   */
  private async revoke(projectId: string, options: { deleted?: boolean } = {}): Promise<void> {
    return this.locked(`project:${projectId}`, () => this.doRevoke(projectId, options.deleted === true));
  }

  private async doRevoke(projectId: string, deleted: boolean): Promise<void> {
    const handle = this.projects.get(projectId);
    if (!handle || handle.revoked || handle.revoking) return;
    // Owners cannot be removed, so an owner losing access means the project
    // was deleted; confirm that unless the server said so.
    if (handle.role === "owner" && (deleted || (await this.projectGone(projectId)))) {
      await this.removeLocally(handle);
      return;
    }
    if (handle.kind === "album") {
      await this.takeAlbumAway(handle);
      return;
    }
    handle.revoking = true;
    try {
      const runtime = handle.runtime;
      if (runtime) {
        handle.index = indexOf(runtime.indexedDocs());
        handle.reconcilePending = runtime.reconcilePending;
        await runtime.stop({ preserveContent: true });
      }
      await this.rememberEnded(handle, "revoked");
      // Revocation is terminal for this account on every copy. A follower must
      // not wait for an offline former writer to make its recovery copy deletable.
      const marker = await readMarker(handle.root).catch(() => null);
      if (this.matchesMarker(handle, marker)) await writeMarker(handle.root, { ...marker, revoked: true, revokedAt: new Date().toISOString() }, {
        root: handle.root,
        canCommit: async () => this.matchesMarker(handle, await readMarker(handle.root).catch(() => null)),
      });
      handle.runtime = null;
      handle.revoked = true;
      this.deps.emit({ t: "project-changed", projectId });
    } finally {
      handle.revoking = false;
    }
  }

  private setRole(projectId: string, role: Role): void {
    const handle = this.projects.get(projectId);
    if (!handle || handle.role === role) return;
    handle.role = role;
    if (handle.runtime) handle.runtime.role = role;
    this.deps.host.setProjectRole(projectId, role);
    this.deps.host.store.upsertProject({ projectId, name: handle.name, localRoot: handle.root, role });
    this.deps.emit({ t: "project-changed", projectId });
  }

  /** Deletes the server copy and returns the owner's folder to a local notebook. */
  takeDown(projectId: string): Promise<void> {
    return this.locked(`project:${projectId}`, async () => {
      const api = this.requireApi();
      const handle = this.projects.get(projectId);
      if (!handle) throw new ControlError(404, "not-found", "Shared notebook not found on this device.");
      if (handle.role !== "owner") throw new ControlError(403, "forbidden", "Only the owner can take down this notebook.");
      // Finish pending materialization before the server closes the documents.
      await handle.runtime?.whenIdle();
      if (!(await api.version()).guardedProjectDeletion) throw new ControlError(409, "update-required", "Update the collaboration server before taking down this notebook safely.");
      if (!handle.runtime) throw new ControlError(503, "offline", "Open and sync this notebook before taking it down.");
      const sequence = await handle.runtime.prepareLocalConversion();
      try {
        await api.deleteProject(projectId, sequence);
      } catch (error) {
        // A lost response or a local cleanup failure can be retried safely.
        if (!(error instanceof ApiClientError)) throw error;
        if (error.status !== 404) {
          if (!error.transient) throw error;
          const gone = await api.getProject(projectId).then(
            () => false,
            (checkError: unknown) => checkError instanceof ApiClientError && checkError.status === 404,
          );
          if (!gone) throw error;
        }
      }
      await this.removeLocally(handle);
    });
  }

  /** Fences a destructive step on the captured folder identity and its sharing marker. */
  private cleanupGuard(root: string, original: Awaited<ReturnType<typeof statIfExists>>, owns: (marker: SharedMarker | null) => boolean): WriteGuard {
    return { root, canCommit: async () => {
      const current = await statIfExists(root).catch(() => null);
      if (!original || !current || !current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev ||
          current.ino !== original.ino || current.birthtimeMs !== original.birthtimeMs) return false;
      return owns(await readMarker(root).catch(() => null));
    } };
  }

  /**
   * After the project was deleted on the server: stops syncing and forgets
   * it. Every installation preserves its latest text and returns its own
   * copy to a local notebook, without depending on an offline former writer.
   */
  private async removeLocally(handle: ProjectHandle): Promise<void> {
    const { projectId } = handle;
    // Identity of the folder as it was when the takedown began; every
    // destructive step below re-validates it instead of trusting this check.
    const originalRoot = await statIfExists(handle.root).catch(() => null);
    await handle.runtime?.stop({ preserveContent: true });
    await this.rememberEnded(handle, "local");
    handle.runtime = null;
    // The folder may meanwhile hold another share's marker; that one stays.
    const marker = await readMarker(handle.root).catch(() => null);
    if (this.matchesMarker(handle, marker)) {
      const guard = this.cleanupGuard(handle.root, originalRoot, (latest) => this.matchesMarker(handle, latest));
      try {
        if (handle.writer) await deleteSharePlan(handle.root, guard);
        await deleteMarker(handle.root, guard);
      } catch (error) {
        if (!(error instanceof WriteCancelledError)) throw error;
      }
    }
    this.deps.host.store.deleteProject(projectId);
    this.projects.delete(projectId);
    this.deps.emit({ t: "project-changed", projectId });
    this.deps.statusChanged?.();
  }

  /**
   * Access to a shared album ended (left, removed, or the album was deleted):
   * the photos other members added go, the ones this account added stay in
   * the folder, which becomes an ordinary album. Photos saved to the gallery
   * were copied out of the folder before, so they are not touched.
   */
  private async takeAlbumAway(handle: ProjectHandle): Promise<void> {
    const originalRoot = await statIfExists(handle.root);
    const currentRoot = async () => {
      const current = await statIfExists(handle.root);
      return !!originalRoot && !!current && current.isDirectory() && !current.isSymbolicLink() &&
        current.dev === originalRoot.dev && current.ino === originalRoot.ino && current.birthtimeMs === originalRoot.birthtimeMs;
    };
    const canRemove = async () => await currentRoot() && this.matchesMarker(handle, await readMarker(handle.root).catch(() => null));
    const removeOwned = async (name: string) => {
      const detached = path.join(this.lifecycleDirectory, "album-cleanup", randomId("removed"));
      await fs.mkdir(path.dirname(detached), { recursive: true });
      if (!await canRemove()) return;
      try { await fs.rename(path.join(handle.root, name), detached); }
      catch (error) { if (isNotFound(error)) return; throw error; }
      await fs.rm(detached, { recursive: true, force: true });
    };
    const runtime = handle.runtime;
    const photos = runtime?.albumState().photos ?? [];
    await runtime?.stop();
    await this.rememberEnded(handle, "revoked");
    handle.runtime = null;
    // A follower cleans up too: its writer may be offline for good, and the
    // account's other installations remove the same photos, so the copies
    // converge whichever device gets there first. The marker check below
    // keeps a folder that another share or account now owns untouched.
    {
      const accountId = this.cachedAccountId ?? (await this.accountId().catch(() => null));
      const marker = await readMarker(handle.root).catch(() => null);
      // The writer, or a follower of this account (see above); canRemove then
      // rechecks the folder and its sharing identity before every removal.
      const ours = marker && (handle.writer ? this.ownsMarker(marker, handle.projectId) : this.markerAuthorityMatches(marker));
      if (marker && ours && await canRemove()) {
        for (const photo of photos) {
          if (accountId && photo.addedBy === accountId) continue;
          if (!await canRemove()) break;
          await removeOwned(photo.name).catch(() => undefined);
        }
        for (const name of [ARCHIVE_DIRECTORY, ".libera", SHARE_PENDING_FILE, ".libera-share-uploaded.jsonl"]) {
          if (!await canRemove()) break;
          await removeOwned(name).catch(() => undefined);
        }
        if (await canRemove()) await removeOwned(SHARED_MARKER_FILE);
        // Nothing of this account's left: the folder goes too.
        const left = await fs.readdir(handle.root).catch(() => ["?"]);
        if (left.length === 0 && await currentRoot()) await fs.rmdir(handle.root).catch(() => undefined);
      }
    }
    this.deps.host.store.deleteProject(handle.projectId);
    this.projects.delete(handle.projectId);
    this.deps.emit({ t: "project-changed", projectId: handle.projectId });
    this.deps.statusChanged?.();
  }

  // ------------------------------------------------------------ albums

  /** The shared albums on this device, with their photos. */
  albums(): LocalAlbum[] {
    const result: LocalAlbum[] = [];
    for (const handle of this.projects.values()) {
      if (handle.kind !== "album") continue;
      const state = handle.runtime?.albumState() ?? { direct: false, keepLocation: false, sharePrompts: false, photos: [] };
      result.push({ projectId: handle.projectId, name: handle.name, folder: handle.notebook, manifestDocId: handle.manifestDocId, role: handle.role, revoked: handle.revoked, ...state });
    }
    return result;
  }

  private albumProject(projectId: string): SharedProject {
    const handle = this.projects.get(projectId);
    if (!handle || handle.kind !== "album") throw new ControlError(404, "not-found", "This shared album is not on this device.");
    return this.runningProject(projectId);
  }

  async updateAlbum(projectId: string, request: UpdateAlbumRequest): Promise<LocalAlbum> {
    if (!request || typeof request !== "object") throw new ControlError(400, "bad-request", "Album changes are required.");
    const runtime = this.albumProject(projectId);
    const { name, ...details } = request;
    if (name !== undefined) {
      const handle = this.projects.get(projectId)!;
      const trimmed = typeof name === "string" ? name.trim().slice(0, 200) : "";
      if (!trimmed) throw new ControlError(400, "bad-request", "The album needs a name.");
      if (handle.role !== "owner") throw new ControlError(403, "forbidden", "Only the album's owner can rename it.");
      const renamed = await this.requireApi().renameProject(projectId, { name: trimmed });
      handle.name = renamed.name;
      this.deps.host.store.upsertProject({ projectId, name: handle.name, localRoot: handle.root, role: handle.role });
      this.deps.emit({ t: "project-changed", projectId });
    }
    if (Object.keys(details).length > 0) await runtime.updateAlbum(details);
    const album = this.albums().find((item) => item.projectId === projectId);
    if (!album) throw new ControlError(404, "not-found", "This shared album is not on this device.");
    return album;
  }

  /** Writes an edited photo's original into the gallery's `.originals` folder. */
  async albumOriginal(projectId: string, name: unknown): Promise<AlbumOriginalResponse> {
    if (typeof name !== "string" || !name) throw new ControlError(400, "bad-request", "The photo's name is required.");
    const bytes = await this.albumProject(projectId).photoOriginal(name);
    const extension = path.extname(name).toLowerCase();
    const original = `shared-${sha256(bytes).slice(0, 32)}${extension}`;
    const directory = path.join(this.galleryRoot, ".originals");
    await fs.mkdir(directory, { recursive: true });
    await writeFileAtomic(path.join(directory, original), bytes);
    return { original };
  }

  /** Whether the server confirms the project no longer exists (false when it cannot be asked). */
  private async projectGone(projectId: string): Promise<boolean> {
    const api = this.deps.host.api;
    if (!api) return false;
    return api.getProject(projectId).then(
      () => false,
      (error: unknown) => error instanceof ApiClientError && error.status === 404,
    );
  }

  // ------------------------------------------------------------ share

  private progress(notebook: string, progress: ShareProgress): void {
    this.deps.emit({ t: "share-progress", notebook, progress });
  }

  private async linkedFolderNames(): Promise<string[]> {
    const bytes = await readIfExists(path.join(this.deps.libraryRoot, ".libera", "directory-mode.json")).catch(() => null);
    if (!bytes) return [];
    try {
      const state = JSON.parse(bytes.toString("utf8")) as { folders?: Array<{ name?: unknown }> };
      return (state.folders ?? []).map((folder) => folder.name).filter((name): name is string => typeof name === "string");
    } catch {
      return [];
    }
  }

  private async shareableRoot(notebook: string): Promise<string> {
    if (typeof notebook !== "string" || !notebook.trim() || /[\\/\0]/.test(notebook) || notebook.startsWith(".") || notebook === "..") {
      throw new ControlError(400, "bad-request", "Choose a notebook to share.");
    }
    const root = path.join(this.deps.libraryRoot, notebook);
    const linked = await this.linkedFolderNames();
    if (linked.some((name) => name.toLowerCase() === notebook.toLowerCase())) {
      throw new ControlError(409, "linked-folder", "Linked folders cannot be shared yet.");
    }
    const stats = await statIfExists(root);
    if (!stats) throw new ControlError(404, "not-found", `There is no notebook named ${notebook}.`);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (await statIfExists(path.join(root, ".libera-folder.json")))) {
      throw new ControlError(409, "linked-folder", "Linked folders cannot be shared yet.");
    }
    return root;
  }

  share(request: ShareNotebookRequest): Promise<ShareResult> {
    const notebook = typeof request?.notebook === "string" ? request.notebook.trim() : "";
    return this.locked(`notebook:${notebook.toLowerCase()}`, async () => this.doShare({ kind: "notebook", notebook, root: await this.shareableRoot(notebook), ...(request.pdfLive === true ? { pdfLive: true } : {}) }, request.name));
  }

  /** Shares a gallery folder as an album (Libera has moved the album's photos into it). */
  shareAlbum(request: ShareAlbumRequest): Promise<ShareAlbumResult> {
    const folder = typeof request?.folder === "string" ? request.folder.trim() : "";
    return this.locked(`album:${folder.toLowerCase()}`, async () => {
      const root = await this.albumRoot(folder);
      const photos = new Map((Array.isArray(request.photos) ? request.photos : []).filter((photo) => typeof photo?.name === "string").map((photo) => [manifestPathKey(photo.name), photo]));
      const result = await this.doShare(
        {
          kind: "album",
          notebook: folder,
          root,
          album: { direct: request.direct === true, keepLocation: request.keepLocation === true, sharePrompts: request.sharePrompts === true, photos },
        },
        request.name,
      );
      return { projectId: result.projectId, name: result.name, folder: result.notebook, photos: result.blobs, skipped: result.skipped, synced: result.synced };
    });
  }

  /** A gallery folder that can be shared as an album. */
  private async albumRoot(folder: string): Promise<string> {
    if (!folder || /[\\/\0]/.test(folder) || folder.startsWith(".") || folder === "..") throw new ControlError(400, "bad-request", "Choose an album to share.");
    const root = path.join(this.galleryRoot, folder);
    const stats = await statIfExists(root);
    if (!stats) throw new ControlError(404, "not-found", `There is no album folder named ${folder}.`);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new ControlError(409, "conflict", "Only an album's own folder can be shared.");
    return root;
  }

  private async doShare(target: ShareTarget, requestedName: string | undefined): Promise<ShareResult> {
    this.pendingRoots.add(target.root);
    try { return await this.shareAttempt(target, requestedName); }
    catch (error) { throw toControlError(error); }
    finally { this.pendingRoots.delete(target.root); }
  }

  private async shareAttempt(target: ShareTarget, requestedName: string | undefined): Promise<ShareResult> {
    const api = this.requireApi();
    const { root, notebook, album } = target;
    const originalRoot = await fs.lstat(root);
    if (!originalRoot.isDirectory() || originalRoot.isSymbolicLink()) throw new WriteCancelledError();
    if (await statIfExists(path.join(root, SHARED_MARKER_FILE))) throw new ControlError(409, "already-shared", `${notebook} already has a sharing marker.`);
    const accountId = await this.accountId();
    const initialPlanBytes = await readIfExists(path.join(root, SHARE_PENDING_FILE));

    // The plan: every id chosen once and written down before anything is
    // uploaded, so a retry after a crash or network failure reuses them and
    // the server's idempotency (document replays, content-addressed blobs)
    // turns the repeat into no-ops.
    const existing = await readSharePlan(root);
    if (initialPlanBytes && !existing) throw new ControlError(409, "invalid-checkpoint", "The share checkpoint is unreadable; it was preserved for recovery.");
    if (existing?.operationId !== undefined && (typeof existing.operationId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(existing.operationId))) {
      throw new ControlError(409, "invalid-checkpoint", "The share checkpoint has an invalid operation identity; it was preserved for recovery.");
    }
    if (existing && requestedName?.trim() && requestedName.trim().slice(0, 200) !== existing.name) {
      throw new ControlError(409, "checkpoint-name", "Resume this share with its saved project name. The checkpoint was left intact.");
    }
    if (existing && ((existing.accountId !== undefined || existing.serverUrl !== undefined) &&
        (existing.accountId !== accountId || typeof existing.serverUrl !== "string" || normalizedServerUrl(existing.serverUrl) !== normalizedServerUrl(api.baseUrl)))) {
      throw new ControlError(409, "checkpoint-authority", "This checkpoint belongs to another account or server. It was left intact.");
    }
    if (existing?.kind && existing.kind !== target.kind) throw new ControlError(409, "checkpoint-kind", "This checkpoint belongs to a different kind of share.");
    if (existing && !existing.projectId && existing.files.some((file) => file.uploaded)) throw new ControlError(409, "invalid-checkpoint", "Uploaded entries have no recorded project identity; the checkpoint was preserved.");
    const operationId = existing?.operationId ?? randomId("share");
    let checkpointed = false;
    let installedMarker: SharedMarker | null = null;
    const guard: WriteGuard = { root, canCommit: async () => {
      if (!this.started || this.releasing || this.deps.host.api !== api || this.deps.host.accountId !== accountId) return false;
      const currentRoot = await statIfExists(root);
      if (!currentRoot?.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== originalRoot.dev ||
          currentRoot.ino !== originalRoot.ino || currentRoot.birthtimeMs !== originalRoot.birthtimeMs) return false;
      if (installedMarker) {
        const current = await readMarker(root);
        if (!current || current.revoked || !sameNotebookIdentity(installedMarker, current)) return false;
      } else if (await statIfExists(path.join(root, SHARED_MARKER_FILE))) return false;
      const currentPlan = await readIfExists(path.join(root, SHARE_PENDING_FILE));
      if (!checkpointed) return initialPlanBytes === null ? currentPlan === null : currentPlan !== null && currentPlan.equals(initialPlanBytes);
      try {
        const value = JSON.parse(currentPlan?.toString("utf8") ?? "null") as SharePlan | null;
        return value?.operationId === operationId && value.accountId === accountId && value.serverUrl === api.baseUrl;
      } catch { return false; }
    } };
    const authorize = async (projectId: string, manifestDocId: string | undefined): Promise<ProjectSummary> => {
      await checkWriteGuard(guard);
      const project = await api.getProject(projectId);
      if (project.ownerId !== accountId || project.role !== "owner" || project.manifestDocId !== manifestDocId ||
          (project.kind ?? "notebook") !== target.kind) throw new ControlError(409, "checkpoint-project", "The checkpoint does not identify this account's current owned project.");
      await checkWriteGuard(guard);
      return project;
    };
    if (existing?.projectId) await authorize(existing.projectId, existing.manifestDocId);
    const name = (requestedName?.trim() || existing?.name || notebook).slice(0, 200);
    const previous = new Map((existing?.files ?? []).map((file) => [file.path, file]));
    const { entries: everything, skipped, complete } = await walkNotebook(root);
    if (!complete) throw new ControlError(409, "scan-incomplete", "The notebook folder could not be read completely. Wait for its files to finish syncing and try again.");
    // An album shares its top-level photos; anything else in the folder stays local.
    const walked = album ? everything.filter((item) => item.kind === "file" && !item.relative.includes("/") && albumImageType(item.relative)) : everything;
    if (album) skipped.push(...everything.filter((item) => item.kind === "file" && !walked.includes(item)).map((item) => item.relative));
    const files: PlannedFile[] = [];
    const texts = new Map<string, string>();
    for (const item of walked) {
      const before = previous.get(item.relative);
      if (item.kind === "folder") {
        files.push(before?.kind === "folder" ? before : { path: item.relative, kind: "folder", fileId: randomId("fil") });
        continue;
      }
      const absolute = path.join(root, ...item.relative.split("/"));
      let bytes: Uint8Array | null = await readIfExists(absolute);
      if (!bytes) continue;
      if (album && !album.keepLocation) {
        // Location and camera details are removed here, in the folder, so the
        // copy on disk is the one the members get (the watcher compares hashes).
        const stripped = stripPhotoMetadata(bytes, albumImageType(item.relative) ?? "");
        if (stripped) {
          await writeFileAtomic(absolute, stripped, contentGuard(absolute, sha256(bytes), guard));
          bytes = stripped;
        }
      }
      const hash = sha256(bytes);
      const classified = classifyFile(item.relative, bytes);
      if (classified.kind === "doc") {
        const reuse = before?.kind === "doc" && before.docKind === classified.docKind;
        const initialText = reuse ? before.initialText ?? classified.text : classified.text;
        texts.set(item.relative, initialText);
        files.push({
          path: item.relative,
          kind: "doc",
          fileId: reuse ? before.fileId : randomId("fil"),
          docId: reuse ? before.docId : randomId("doc"),
          docKind: classified.docKind,
          // An uploaded document keeps the hash of the text the server has.
          blobHash: reuse ? before.blobHash : hash,
          initialText,
          size: bytes.byteLength,
          uploaded: reuse ? before.uploaded : false,
        });
      } else {
        const reuse = before?.kind === "blob";
        files.push({
          path: item.relative,
          kind: "blob",
          fileId: reuse ? before.fileId : randomId("fil"),
          blobHash: hash,
          size: bytes.byteLength,
          mime: (album && albumImageType(item.relative)) || mimeForPath(item.relative),
          uploaded: reuse && before.blobHash === hash ? before.uploaded : false,
        });
      }
    }
    const plan: SharePlan = {
      version: 1,
      operationId, accountId, serverUrl: api.baseUrl, kind: target.kind,
      name,
      startedAt: existing?.startedAt ?? Date.now(),
      ...(existing?.projectId ? { projectId: existing.projectId, manifestDocId: existing.manifestDocId } : {}),
      files,
    };
    const recoveryFile = path.join(this.lifecycleDirectory, "share-attempts", `${operationId}.json`);
    const savePlan = async () => {
      // Recovery belongs to this profile, even if the cloud root disappears.
      await writeFileAtomic(recoveryFile, Buffer.from(JSON.stringify({ root, plan })));
      await writeSharePlan(root, plan, guard);
      checkpointed = true;
    };
    await savePlan();

    try {
      this.progress(notebook, { phase: "creating-project", done: 0, total: 1 });
      if (!plan.projectId) {
        const version = await api.version();
        if (!version.projectCreationKeys) throw new ControlError(409, "update-required", "Update the collaboration server before starting a new share; durable project creation keys are required.");
        // An older server refuses the opens live PDFs need, so it stays off until the server is updated.
        if (!version.livePdfs) target.pdfLive = false;
        await checkWriteGuard(guard);
        const project = await api.createProject({ name, kind: target.kind, creationId: operationId });
        if (project.creationId !== operationId) throw new ControlError(409, "update-required", "The server did not confirm the saved project creation key.");
        if (album && project.kind !== "album") {
          throw new ControlError(409, "update-required", "The collaboration server is too old for shared albums. Ask its administrator to update it.");
        }
        plan.projectId = project.id;
        plan.manifestDocId = project.manifestDocId;
        await savePlan();
      }
      const projectId = plan.projectId;
      const manifestDocId = plan.manifestDocId as string;

      const documents = files.filter((file) => file.kind === "doc");
      let done = documents.filter((file) => file.uploaded).length;
      this.progress(notebook, { phase: "importing-documents", done, total: documents.length });
      for (const file of documents) {
        if (file.uploaded) continue;
        await checkWriteGuard(guard);
        await createSharedDocument(api, projectId, { docId: file.docId as string, fileId: file.fileId }, file.docKind!, texts.get(file.path) ?? "");
        file.uploaded = true;
        done += 1;
        await savePlan();
        this.progress(notebook, { phase: "importing-documents", done, total: documents.length });
      }

      const blobs = files.filter((file) => file.kind === "blob");
      done = blobs.filter((file) => file.uploaded).length;
      this.progress(notebook, { phase: "uploading-files", done, total: blobs.length });
      for (const file of blobs) {
        if (file.uploaded) continue;
        const bytes = await readIfExists(path.join(root, ...file.path.split("/")));
        if (!bytes || sha256(bytes) !== file.blobHash) {
          throw new ControlError(409, "conflict", `${file.path} changed while it was being shared. Share again to continue.`);
        }
        await checkWriteGuard(guard);
        await api.uploadBlob(projectId, bytes, file.mime ?? "application/octet-stream");
        if (album) await recordShareUpload(root, file, guard);
        file.uploaded = true;
        done += 1;
        if (!album) await savePlan();
        this.progress(notebook, { phase: "uploading-files", done, total: blobs.length });
      }

      await authorize(projectId, manifestDocId);
      // The manifest, through the manifest hub, in one transaction. Entries
      // are keyed by fileId with fixed timestamps, so writing them again on a
      // retry changes nothing that matters.
      this.progress(notebook, { phase: "writing-manifest", done: 0, total: 1 });
      // Copies/retries of one cloud checkpoint must contend for the same lease.
      const folderId = `fld_${sha256(Buffer.from(operationId)).slice(0, 32)}`;
      const hub = this.deps.host.acquire(manifestDocId, { kind: "manifest", projectId });
      let synced = false;
      try {
        hub.applyLocalChange(
          "manifest",
          (doc) => {
            const map = doc.getMap<unknown>(ManifestKeys.files);
            for (const file of files) {
              const entry: ManifestEntry = {
                fileId: file.fileId,
                path: file.path,
                kind: file.kind,
                ...(file.kind === "doc" ? { docId: file.docId, docKind: file.docKind } : {}),
                ...(file.kind === "blob" ? { blobHash: file.blobHash, mime: file.mime } : {}),
                ...(file.size !== undefined ? { size: file.size } : {}),
                createdBy: accountId,
                createdAt: plan.startedAt,
                updatedAt: plan.startedAt,
              };
              map.set(file.fileId, entryRecord(entry));
            }
            if (target.pdfLive) doc.getMap<unknown>(ManifestKeys.settings).set(PDF_LIVE_SETTING, true);
            if (album) {
              const settings = doc.getMap<unknown>(ManifestKeys.settings);
              if (album.direct) settings.set(AlbumSettingKeys.direct, true);
              settings.set(AlbumSettingKeys.keepLocation, album.keepLocation);
              settings.set(AlbumSettingKeys.sharePrompts, album.sharePrompts);
              const photos = doc.getMap<unknown>(ManifestKeys.photos);
              for (const file of files) {
                const details = album.photos.get(manifestPathKey(file.path));
                const photo: AlbumPhotoRecord = {
                  fileId: file.fileId,
                  addedBy: accountId,
                  updatedAt: plan.startedAt,
                  ...(details?.caption?.trim() ? { caption: details.caption.trim().slice(0, 2000) } : {}),
                  ...(album.sharePrompts && details?.prompt ? { prompt: details.prompt } : {}),
                  ...(album.sharePrompts && details?.model ? { model: details.model } : {}),
                };
                photos.set(file.fileId, JSON.parse(JSON.stringify(photo)));
              }
            }
          },
          { source: "import" },
        );

        synced = await waitUntil(() => hub.isClosed || !!hub.readOnlyReason || this.deps.host.api !== api || !this.started ||
          (hub.pendingCount === 0 && hubHasState(this.deps.host, hub, "manifest") && hub.getStatus().state === "saved-remote"), this.shareSyncTimeoutMs);
        if (hub.isClosed || hub.readOnlyReason) throw new ControlError(409, "access-changed", "Project access changed before sharing completed; the checkpoint was preserved.");
        await checkWriteGuard(guard);
        // The layout as it is on disk now: the materializer starts from it and
        // treats anything that differs (edits during the share) as new edits.
        const state = emptyState();
        for (const file of files) {
          const stats = await statIfExists(path.join(root, ...file.path.split("/")));
          state.layout[file.fileId] = {
            path: file.path,
            kind: file.kind,
            ...(file.kind === "doc" ? { docId: file.docId, docKind: file.docKind } : {}),
            ...(file.kind !== "folder" ? { hash: file.blobHash } : {}),
            // Until the first verified scan/adoption, the uploaded hash and
            // current disk stat may describe different versions (a retry or
            // an edit during sharing). Do not pair an old hash with new mtime.
            ...(stats && file.kind === "folder" ? { size: stats.size, mtimeMs: stats.mtimeMs } : {}),
          };
          if (file.kind === "doc" && file.docId) {
            const text = texts.get(file.path);
            if (text !== undefined && sha256(Buffer.from(text, "utf8")) === file.blobHash) await writeBase(root, file.docId, text, guard);
            this.deps.host.store.upsertDoc({ docId: file.docId, projectId, fileId: file.fileId, path: file.path, materializedHash: file.blobHash ?? null });
          }
          if (file.kind === "blob" && file.blobHash) {
            this.deps.host.store.putBlob({ hash: file.blobHash, localPath: path.join(root, ...file.path.split("/")), size: file.size ?? 0 });
          }
        }
        await writeState(root, state, guard);
        const marker: SharedMarker = {
          projectId,
          serverUrl: api.baseUrl,
          accountId,
          manifestDocId,
          sharedAt: new Date(plan.startedAt).toISOString(),
          ...(album ? { kind: "album" as const } : {}),
          writer: this.installationId,
          folderId,
        };
        await writeMarker(root, marker, guard);
        installedMarker = marker;
        await checkWriteGuard(guard);
        this.deps.host.store.upsertProject({ projectId, name, localRoot: root, role: "owner" });
      } finally {
        this.deps.host.release(manifestDocId);
      }

      const handle: ProjectHandle = {
        projectId,
        kind: target.kind,
        name,
        notebook,
        root,
        role: "owner",
        manifestDocId,
        revoked: false,
        runtime: null,
        index: new Map(),
        reconcilePending: 0,
        writer: true,
        folderId,
        leaseSupported: true,
      };
      this.projects.set(projectId, handle);
      handle.writer = await this.claimRole(handle, installedMarker!);
      await checkWriteGuard(guard);
      await this.run(handle);
      await deleteSharePlan(root, guard);
      await fs.rm(recoveryFile, { force: true });
      this.progress(notebook, { phase: "done", done: files.length, total: files.length });
      this.deps.emit({ t: "project-changed", projectId });
      return {
        projectId,
        name,
        notebook,
        documents: documents.length,
        blobs: blobs.length,
        folders: files.filter((file) => file.kind === "folder").length,
        skipped,
        synced,
        notes: album ? [] : [LOCAL_REVIEW_NOTE, ARCHIVE_NOTE],
      };
    } catch (error) {
      throw toControlError(error);
    }
  }

  // ------------------------------------------------------------ join

  join(request: JoinProjectRequest): Promise<JoinResult> {
    const token = invitationToken(request?.invitation);
    return this.locked("join", () => this.doJoin(token));
  }

  private async doJoin(token: string): Promise<JoinResult> {
    const api = this.requireApi();
    let project: ProjectSummary;
    try {
      project = await api.acceptInvitation(token);
    } catch (error) {
      throw toControlError(error);
    }
    return this.locked(`project:${project.id}`, () => this.finishJoin(api, project));
  }

  private async finishJoin(api: ApiClient, project: ProjectSummary): Promise<JoinResult> {
    const accountId = await this.accountId();
    if (!this.started || this.releasing || this.deps.host.api !== api || this.deps.host.accountId !== accountId) throw new WriteCancelledError();
    const known = this.projects.get(project.id);
    const kind: ProjectKind = project.kind === "album" ? "album" : "notebook";
    if (known && !known.revoked) {
      return { projectId: project.id, kind, name: known.name, notebook: known.notebook, role: known.role, materialized: known.runtime?.isMaterialized() ?? false, alreadyJoined: true };
    }

    // An album joins the gallery as one of its folders; a notebook joins the library.
    const base = kind === "album" ? this.galleryRoot : this.deps.libraryRoot;
    const notebook = await this.createFolder(folderNameFor(project.name), base);
    const root = path.join(base, notebook);
    const originalRoot = await fs.lstat(root);
    let installedMarker: SharedMarker | null = null;
    const guard: WriteGuard = { root, canCommit: async () => {
      if (!this.started || this.releasing || this.deps.host.api !== api || this.deps.host.accountId !== accountId) return false;
      const current = await statIfExists(root);
      if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== originalRoot.dev ||
          current.ino !== originalRoot.ino || current.birthtimeMs !== originalRoot.birthtimeMs) return false;
      if (!installedMarker) return await statIfExists(path.join(root, SHARED_MARKER_FILE)) === null;
      const marker = await readMarker(root);
      return marker !== null && sameNotebookIdentity(installedMarker, marker) && !marker.revoked;
    } };
    const folderId = randomId("fld");
    this.pendingRoots.add(root);
    try {
      // The marker goes first: from now on Libera's own writers refuse the folder.
      await writeMarker(root, {
        projectId: project.id,
        serverUrl: api.baseUrl,
        accountId,
        manifestDocId: project.manifestDocId,
        sharedAt: project.createdAt,
        ...(kind === "album" ? { kind } : {}),
        writer: this.installationId,
        folderId,
      }, guard);
      installedMarker = await readMarker(root);
      await checkWriteGuard(guard);
      // This folder was allocated by this explicit join, with a fresh folder
      // identity. It is not an inherited cloud copy lacking bookkeeping.
      await writeState(root, emptyState(), guard);
      const marker = installedMarker;
      if (marker) recordNotebookBinding(this.lifecycleDirectory, root, marker);
      this.deps.host.store.upsertProject({ projectId: project.id, name: project.name, localRoot: root, role: project.role });
    } finally {
      this.pendingRoots.delete(root);
    }
    await checkWriteGuard(guard);
    if (known) {
      // Joined again after a revocation: the old folder stays as it is.
      this.projects.delete(project.id);
    }
    const handle: ProjectHandle = {
      projectId: project.id,
      kind,
      name: project.name,
      notebook,
      root,
      role: project.role,
      manifestDocId: project.manifestDocId,
      revoked: false,
      runtime: null,
      index: new Map(),
      reconcilePending: 0,
      writer: true,
      folderId,
      leaseSupported: true,
    };
    this.projects.set(project.id, handle);
    this.deps.host.restoreProjectAccess(project.id, project.role);
    await this.lease(handle);
    await this.run(handle);
    const runtime = handle.runtime as SharedProject | null;
    const materialized = runtime ? await waitUntil(() => runtime.isMaterialized(), this.joinTimeoutMs) : false;
    if (runtime && materialized) await runtime.whenIdle();
    this.deps.emit({ t: "project-changed", projectId: project.id });
    return { projectId: project.id, kind, name: project.name, notebook, role: project.role, materialized, alreadyJoined: false };
  }

  /** Creates `<base>/<name>`, or "<name> (2)" and so on when the name is taken (case-insensitively). */
  private async createFolder(preferred: string, base = this.deps.libraryRoot): Promise<string> {
    await fs.mkdir(base, { recursive: true });
    const linked = base === this.deps.libraryRoot ? await this.linkedFolderNames() : [];
    const taken = new Set([...(await fs.readdir(base)), ...linked].map((name) => name.toLowerCase()));
    for (let index = 1; index < 1000; index += 1) {
      const candidate = index === 1 ? preferred : `${preferred} (${index})`;
      if (taken.has(candidate.toLowerCase())) continue;
      try {
        await fs.mkdir(path.join(base, candidate));
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new ControlError(409, "conflict", "No free folder name for the shared notebook.");
  }

  // ------------------------------------------------------------ files and reconciliations

  private runningProject(projectId: string): SharedProject {
    const handle = this.projects.get(projectId);
    if (!handle) {
      // Typically a folder that arrived through a sync client for a notebook
      // this Libera has not joined (another account's, or not adopted yet).
      throw new ControlError(404, "not-joined", "This notebook is not joined in this Libera, so it cannot be changed here.");
    }
    if (handle.revoked || handle.revoking) throw new ControlError(403, "access-revoked", "Access to this notebook was revoked.");
    if (!handle.runtime) throw new ControlError(503, "offline", "The notebook is restarting; try again in a moment.");
    return handle.runtime;
  }

  async fileOp(projectId: string, request: FileOpRequest): Promise<{ paths: string[] }> {
    if (!request || typeof request !== "object") throw new ControlError(400, "bad-request", "A file operation is required.");
    try {
      return await this.runningProject(projectId).fileOp(request);
    } catch (error) {
      throw toControlError(error);
    }
  }

  async reconciliations(): Promise<Reconciliation[]> {
    const result: Reconciliation[] = [];
    for (const handle of this.projects.values()) if (handle.runtime) result.push(...(await handle.runtime.reconciliations()));
    return result.sort((a, b) => a.detectedAt - b.detectedAt);
  }

  async reconciliation(id: string): Promise<Reconciliation> {
    const found = (await this.reconciliations()).find((item) => item.id === id);
    if (!found) throw new ControlError(404, "not-found", "No such reconciliation.");
    return found;
  }

  async resolveReconciliation(id: string, text: unknown, reviewed?: { shared: string; disk: string }): Promise<{ docId: string; text: string }> {
    if (typeof text !== "string") throw new ControlError(400, "bad-request", "The merged text is required.");
    for (const handle of this.projects.values()) {
      if (handle.runtime?.hasReconciliation(id)) {
        const result = await handle.runtime.resolveReconciliation(id, text, reviewed);
        this.reindex(handle.projectId);
        return result;
      }
    }
    throw new ControlError(404, "not-found", "No such reconciliation.");
  }

  // ------------------------------------------------------------ routes

  registerRoutes(router: ControlRouter): void {
    const wrap =
      (handler: ControlHandler): ControlHandler =>
      async (request) => {
        try {
          return await handler(request);
        } catch (error) {
          throw toControlError(error);
        }
      };
    router.add("GET", decodeURIComponent(ControlRoutes.fileBlob(":projectId")), wrap(async (request) => ({
      body: await this.runningProject(request.params.projectId).readBlob(request.query.get("path") ?? ""),
    })));
    router.add("POST", ControlRoutes.share, wrap(async (request) => ({ body: await this.share(request.body as ShareNotebookRequest) })));
    router.add("GET", ControlRoutes.pdfResolve, wrap(async (request) => {
      const relative = request.query.get("path") ?? "";
      const resolved = this.resolvePdf(relative);
      if (!resolved) {
        const notebook = relative.replace(/\\/g, "/").split("/")[0];
        if (notebook && notebook !== "." && notebook !== "..") {
          const handle = this.handleForNotebook(notebook);
          const marker = await readMarker(path.join(this.deps.libraryRoot, notebook)).catch(() => null);
          if (!handle?.revoked && ((marker && !handle) || handle?.runtime?.pdfs.enabled)) throw new ControlError(503, "unavailable", "Live PDF status is still loading.");
        }
      }
      return { body: resolved };
    }));
    router.add("POST", decodeURIComponent(ControlRoutes.pdfLive(":projectId")), wrap(async (request) => {
      const runtime = this.project(request.params.projectId);
      if (!runtime) throw new ControlError(404, "not-found", "This notebook is not running here.");
      await runtime.enablePdfLive();
      return { status: 204 };
    }));
    router.add("POST", ControlRoutes.join, wrap(async (request) => ({ body: await this.join(request.body as JoinProjectRequest) })));
    router.add("GET", ControlRoutes.albums, wrap(async () => ({ body: this.albums() })));
    router.add("POST", ControlRoutes.albumShare, wrap(async (request) => ({ body: await this.shareAlbum(request.body as ShareAlbumRequest) })));
    router.add("POST", decodeURIComponent(ControlRoutes.album(":projectId")), wrap(async (request) => ({
      body: await this.updateAlbum(request.params.projectId, request.body as UpdateAlbumRequest),
    })));
    router.add("POST", decodeURIComponent(ControlRoutes.albumOriginal(":projectId")), wrap(async (request) => ({
      body: await this.albumOriginal(request.params.projectId, (request.body as { name?: unknown } | undefined)?.name),
    })));
    router.add("DELETE", decodeURIComponent(ControlRoutes.project(":projectId")), wrap(async (request) => {
      await this.takeDown(request.params.projectId);
      return { status: 204 };
    }));
    router.add(
      "POST",
      ControlRoutes.files(":projectId").replace(encodeURIComponent(":projectId"), ":projectId"),
      wrap(async (request) => ({ body: await this.fileOp(request.params.projectId, request.body as FileOpRequest) })),
    );
    router.add("GET", ControlRoutes.reconciliations, wrap(async () => ({ body: await this.reconciliations() })));
    router.add("GET", "/reconciliations/:id", wrap(async (request) => ({ body: await this.reconciliation(request.params.id) })));
    router.add(
      "POST",
      "/reconciliations/:id",
      wrap(async (request) => ({ body: await this.resolveReconciliation(request.params.id, (request.body as { text?: unknown } | undefined)?.text,
        (request.body as { reviewed?: { shared: string; disk: string } } | undefined)?.reviewed) })),
    );
  }
}

function indexOf(docs: IndexedDoc[]): Map<string, IndexedDoc> {
  return new Map(docs.map((doc) => [manifestPathKey(doc.path), doc]));
}
