// The NotebookService: shared notebooks on disk (collaboration map §7.3,
// implementation plan M1.5 and the revocation part of M1.8).
//
// It owns the list of shared notebooks, the share and join flows, the
// control routes for files and reconciliations, revocation, and the
// in-memory index behind resolvePath. Each running notebook is a
// SharedProject (project.ts).

import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

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
import { ControlError, type ControlDeps, type ControlHandler, type ControlRouter, type NotebookService } from "../control/types";
import { classifyFile, createSharedDocument, mimeForPath } from "./documents";
import { ARCHIVE_DIRECTORY, PathRefusedError, randomId, readIfExists, sha256, statIfExists, walkNotebook, writeFileAtomic } from "./fs-ops";
import { entryRecord } from "./layout";
import { DEFAULT_TIMINGS, SharedProject, hubHasState, type IndexedDoc, type ProjectContext, type Timings } from "./project";
import {
  deleteMarker,
  deleteSharePlan,
  readMarker,
  readSharePlan,
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
}

/** A shared-notebook folder for the signed-in account whose project this account cannot open. */
export interface UnjoinedFolder {
  notebook: string;
  projectId: string;
  /** The server answered 404 (not a member, or deleted) or 403. */
  status: 404 | 403;
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
  runtime: SharedProject | null;
  index: Map<string, IndexedDoc>;
  reconcilePending: number;
  /** This installation writes the folder; otherwise it follows through the CRDT. */
  writer: boolean;
  /** The folder's identity from its marker (the lease key), null for an older marker. */
  folderId: string | null;
  /** False once the server turned out to predate writer leases. */
  leaseSupported: boolean;
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
  return error;
}

export class NotebookServiceImpl implements NotebookService {
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
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  /** Between beforeAccountChange and accountChanged: no lease is renewed or taken. */
  private releasing = false;
  /** Folders being shared or joined right now: their marker is ours before the store knows it. */
  private readonly pendingRoots = new Set<string>();
  private readonly unjoined = new Map<string, UnjoinedFolder>();

  /** Where shared albums live: the gallery folder (its direct children are albums). */
  private readonly galleryRoot: string;

  constructor(deps: Omit<ControlDeps, "notebooks">, options: NotebookServiceOptions = {}) {
    this.deps = deps;
    this.galleryRoot = deps.galleryRoot ?? path.join(deps.libraryRoot, "..", "..", "gallery");
    this.logger = options.logger ?? consoleLogger;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.joinTimeoutMs = options.joinTimeoutMs ?? 60_000;
    this.shareSyncTimeoutMs = options.shareSyncTimeoutMs ?? 20_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeHost = this.deps.host.on((event) => this.hostEvent(event));
    await this.loadProjects();
    this.leaseTimer = setInterval(() => void this.tick(), Math.max(100, Math.floor(this.leaseTtlMs / 3)));
    this.leaseTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribeHost?.();
    this.unsubscribeHost = null;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
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
      for (const row of this.deps.host.store.listProjects()) {
        if (!row.localRoot || this.projects.has(row.projectId)) continue;
        const marker = await readMarker(row.localRoot).catch(() => null);
        if (!marker || marker.projectId !== row.projectId) {
          this.logger.warn(`Shared notebook folder for ${row.name} is missing; it is not synced.`, row.localRoot);
          continue;
        }
        const handle = newHandle(row.projectId, row.name, row.localRoot, row.role ?? "viewer", marker);
        this.projects.set(handle.projectId, handle);
        if (handle.revoked) {
          const { docs, reconcilePending } = await SharedProject.readIndex(handle.root);
          handle.index = indexOf(docs);
          handle.reconcilePending = reconcilePending;
        } else {
          handle.writer = await this.claimRole(handle, marker);
          await this.run(handle);
        }
      }
      await this.adoptMarkers();
    })();
    return this.loading;
  }

  private async run(handle: ProjectHandle): Promise<void> {
    const runtime = await SharedProject.open(this.context(), {
      projectId: handle.projectId,
      name: handle.name,
      notebook: handle.notebook,
      root: handle.root,
      role: handle.role,
      manifestDocId: handle.manifestDocId,
      folderId: handle.folderId ?? undefined,
      follower: !handle.writer,
      ...(handle.kind === "album" ? { album: true } : {}),
    });
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
  // While the server cannot be reached, the role stays as it is: a lone
  // device offline keeps taking in its own disk edits. Another installation
  // may take over meanwhile; the first one gives the role up when its next
  // renewal is refused.

  /** Whether this installation writes the folder, settling its lease and marker. */
  private async claimRole(handle: ProjectHandle, marker: SharedMarker): Promise<boolean> {
    const named = !marker.writer || marker.writer === this.installationId;
    if (!marker.folderId && named) {
      // An older marker: its writer gives it an identity, the lease key.
      // Until then no other installation can take over.
      handle.folderId = randomId("fld");
      await this.updateMarker(handle, { writer: this.installationId, folderId: handle.folderId });
    }
    const lease = await this.lease(handle);
    const writer = this.keepsWriting(lease, marker);
    if (writer) await this.updateMarker(handle, { writer: this.installationId, ...(lease.contended ? { syncedElsewhere: true } : {}) });
    return writer;
  }

  /**
   * Whether this installation writes the folder, given its lease and the
   * marker. The lease decides when the server answers. Without an answer
   * the marker does: offline, the installation it names keeps writing (a
   * lone device keeps taking in its own disk edits). Signed out, that holds
   * only for a folder no other installation has used, since another may
   * hold the lease now.
   */
  private keepsWriting(lease: Lease, marker: SharedMarker): boolean {
    const named = !marker.writer || marker.writer === this.installationId;
    switch (lease.outcome) {
      case "granted":
        return true;
      case "refused":
        return false;
      case "signed-out":
        return named && !marker.syncedElsewhere;
      default:
        return named;
    }
  }

  private async lease(handle: ProjectHandle): Promise<Lease> {
    const api = this.deps.host.api;
    if (!api) return { outcome: "signed-out", contended: false };
    if (!handle.leaseSupported) return { outcome: "unsupported", contended: false };
    if (!handle.folderId) return { outcome: "unavailable", contended: false };
    try {
      const lease = await api.acquireFolderLease(handle.projectId, { folderId: handle.folderId, holder: this.installationId, ttlMs: this.leaseTtlMs });
      return { outcome: lease.granted ? "granted" : "refused", contended: lease.contended === true };
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) {
        // The project is gone (revocation follows), or the server predates leases.
        const exists = await api.getProject(handle.projectId).then(
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
    const api = this.deps.host.api;
    if (!api || !handle.writer || !handle.folderId || !handle.leaseSupported || handle.revoked) return;
    await api.releaseFolderLease(handle.projectId, handle.folderId, this.installationId).catch(() => undefined);
  }

  /** Changes this project's marker (only a writer calls this; nothing happens when the marker is not this project's). */
  private async updateMarker(handle: ProjectHandle, patch: Partial<SharedMarker>): Promise<void> {
    const marker = await readMarker(handle.root).catch(() => null);
    if (!marker || marker.projectId !== handle.projectId || marker.revoked) return;
    const next: SharedMarker = { ...marker, ...patch };
    if (JSON.stringify(next) === JSON.stringify(marker)) return;
    await writeMarker(handle.root, next).catch((error: unknown) => this.logger.warn(`Could not update the marker of ${handle.name}.`, error));
  }

  /**
   * Called before sign-out or an account switch, while the account can still
   * reach the server: gives the leases up, so another installation on the
   * same folders takes over at its next check instead of when they expire.
   */
  async beforeAccountChange(): Promise<void> {
    this.releasing = true;
    await this.ticking?.catch(() => undefined);
    await Promise.all([...this.projects.values()].map((handle) => this.releaseLease(handle)));
  }

  /** Renews leases, hands the writing role over, and adopts folders that arrived. */
  private tick(): Promise<void> {
    if (this.ticking || !this.started || this.releasing) return this.ticking ?? Promise.resolve();
    this.ticking = (async () => {
      try {
        await this.loading?.catch(() => undefined);
        for (const handle of [...this.projects.values()]) {
          if (!this.started || this.releasing) return;
          if (handle.revoked) continue;
          await this.locked(`project:${handle.projectId}`, () => this.checkLease(handle));
        }
        if (this.started && !this.releasing) await this.adoptMarkers();
      } catch (error) {
        this.logger.warn("Shared notebooks: the writer lease check failed.", error);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  private async checkLease(handle: ProjectHandle): Promise<void> {
    if (!this.started || this.releasing || this.projects.get(handle.projectId) !== handle || handle.revoked || !handle.runtime) return;
    // The marker is read every time: a writer named there by another
    // installation (which held the lease) wins even when the lease cannot be checked.
    const marker = await readMarker(handle.root).catch(() => null);
    if (!marker || marker.projectId !== handle.projectId) return;
    handle.folderId ??= marker.folderId ?? null;
    const lease = await this.lease(handle);
    const writer = this.keepsWriting(lease, marker);
    if (writer !== handle.writer) await this.switchRole(handle, writer);
    else if (writer && lease.outcome === "granted") {
      await this.updateMarker(handle, { writer: this.installationId, ...(lease.contended ? { syncedElsewhere: true } : {}) });
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
    if (!api) return;
    const accountId = await this.accountId().catch(() => null);
    if (!accountId) return;
    const folders: string[] = [];
    for (const base of [this.deps.libraryRoot, this.galleryRoot]) {
      const entries: Dirent[] = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".")) folders.push(path.join(base, entry.name));
    }
    for (const root of folders) {
      if (!this.started) return;
      if (this.pendingRoots.has(root)) continue;
      const marker = await readMarker(root).catch(() => null);
      if (!marker || marker.revoked || marker.accountId !== accountId || marker.serverUrl.replace(/\/+$/, "") !== api.baseUrl) continue;
      if (this.projects.has(marker.projectId) || this.deps.host.store.getProject(marker.projectId)) continue;
      if (this.unjoined.get(root)?.projectId === marker.projectId) continue;
      await this.locked(`project:${marker.projectId}`, () => this.adopt(api, root, marker));
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
        this.logger.warn(`Shared notebook folder ${notebook} is for a notebook this account cannot open (${error.message}); it is left alone.`, root);
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

  private context(): ProjectContext {
    return {
      host: this.deps.host,
      logger: this.logger,
      timings: this.timings,
      emit: (event) => this.deps.emit(event),
      accountId: () => this.accountId(),
      revoked: (projectId) => void this.revoke(projectId),
      roleChanged: (projectId, role) => this.setRole(projectId, role),
      layoutChanged: (projectId) => this.reindex(projectId),
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
      readOnly: handle.revoked || !roleAtLeast(handle.role, "editor"),
      ...(handle.revoked ? { revoked: true } : {}),
    };
  }

  /** The reverse of resolvePath, over the same index (GET /docs/:docId). */
  resolveDoc(docId: string): ResolvedDoc | null {
    if (typeof docId !== "string" || !docId) return null;
    for (const handle of this.projects.values()) {
      for (const doc of handle.index.values()) {
        if (doc.docId !== docId) continue;
        return {
          docId: doc.docId,
          projectId: handle.projectId,
          fileId: doc.fileId,
          path: `${handle.notebook}/${doc.path}`,
          kind: doc.docKind,
          role: handle.role,
          readOnly: handle.revoked || !roleAtLeast(handle.role, "editor"),
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
    }));
  }

  /** The running project (tests, diagnostics). */
  project(projectId: string): SharedProject | null {
    return this.projects.get(projectId)?.runtime ?? null;
  }

  // ------------------------------------------------------------ revocation and roles

  private hostEvent(event: CollabHostEvent): void {
    if (event.source !== "sync" || event.event.type !== "server-event") return;
    const { scope, kind, payload } = event.event.event;
    const data = (payload ?? {}) as { projectId?: unknown; accountId?: unknown; role?: unknown };
    const projectId = typeof data.projectId === "string" ? data.projectId : null;
    if (!projectId || !this.projects.has(projectId)) return;
    // Project-scope events are about any member; only ours matter here.
    const aboutMe = scope === "user" || (this.cachedAccountId !== null && data.accountId === this.cachedAccountId);
    if (kind === EventKind.ProjectDeleted) {
      void this.revoke(projectId, { deleted: true });
    } else if (kind === EventKind.MemberRemoved && aboutMe) {
      void this.revoke(projectId);
    } else if (kind === EventKind.RoleChanged && aboutMe && isRole(data.role)) {
      this.setRole(projectId, data.role);
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
    if (!handle || handle.revoked) return;
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
    handle.revoked = true;
    const runtime = handle.runtime;
    handle.runtime = null;
    if (runtime) {
      handle.index = indexOf(runtime.indexedDocs());
      handle.reconcilePending = runtime.reconcilePending;
      await runtime.stop();
    }
    const marker = handle.writer ? await readMarker(handle.root).catch(() => null) : null;
    if (marker && this.ownsMarker(marker, projectId)) await writeMarker(handle.root, { ...marker, revoked: true, revokedAt: new Date().toISOString() }).catch(() => undefined);
    this.deps.emit({ t: "project-changed", projectId });
  }

  private setRole(projectId: string, role: Role): void {
    const handle = this.projects.get(projectId);
    if (!handle || handle.role === role) return;
    handle.role = role;
    if (handle.runtime) handle.runtime.role = role;
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
      try {
        await api.deleteProject(projectId);
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

  /**
   * After the project was deleted on the server: stops syncing and forgets
   * it. The writer returns the folder to a local notebook; a follower leaves
   * the folder to its writer, which sees the deletion too.
   */
  private async removeLocally(handle: ProjectHandle): Promise<void> {
    const { projectId } = handle;
    await handle.runtime?.stop();
    handle.runtime = null;
    if (handle.writer) {
      await deleteSharePlan(handle.root);
      // The folder may meanwhile hold another share's marker (shared again,
      // or synced in from another device); that one stays.
      const marker = await readMarker(handle.root).catch(() => null);
      if (marker && this.ownsMarker(marker, projectId)) await deleteMarker(handle.root);
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
    const runtime = handle.runtime;
    const photos = runtime?.albumState().photos ?? [];
    await runtime?.stop();
    handle.runtime = null;
    if (handle.writer) {
      const accountId = this.cachedAccountId ?? (await this.accountId().catch(() => null));
      const marker = await readMarker(handle.root).catch(() => null);
      if (marker && this.ownsMarker(marker, handle.projectId)) {
        for (const photo of photos) {
          if (accountId && photo.addedBy === accountId) continue;
          await fs.rm(path.join(handle.root, photo.name), { force: true }).catch(() => undefined);
        }
        await fs.rm(path.join(handle.root, ARCHIVE_DIRECTORY), { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(path.join(handle.root, ".libera"), { recursive: true, force: true }).catch(() => undefined);
        await deleteSharePlan(handle.root);
        await deleteMarker(handle.root);
        // Nothing of this account's left: the folder goes too.
        const left = await fs.readdir(handle.root).catch(() => ["?"]);
        if (left.length === 0) await fs.rmdir(handle.root).catch(() => undefined);
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
    return this.locked(`notebook:${notebook.toLowerCase()}`, async () => this.doShare({ kind: "notebook", notebook, root: await this.shareableRoot(notebook) }, request.name));
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
    const api = this.requireApi();
    const { root, notebook, album } = target;
    if (await readMarker(root)) throw new ControlError(409, "already-shared", `${notebook} is already shared.`);
    const accountId = await this.accountId();

    // The plan: every id chosen once and written down before anything is
    // uploaded, so a retry after a crash or network failure reuses them and
    // the server's idempotency (document replays, content-addressed blobs)
    // turns the repeat into no-ops.
    const existing = await readSharePlan(root);
    const name = (requestedName?.trim() || existing?.name || notebook).slice(0, 200);
    const previous = new Map((existing?.files ?? []).map((file) => [file.path, file]));
    const { entries: everything, skipped } = await walkNotebook(root);
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
          await writeFileAtomic(absolute, stripped);
          bytes = stripped;
        }
      }
      const hash = sha256(bytes);
      const classified = classifyFile(item.relative, bytes);
      if (classified.kind === "doc") {
        texts.set(item.relative, classified.text);
        const reuse = before?.kind === "doc" && before.docKind === classified.docKind;
        files.push({
          path: item.relative,
          kind: "doc",
          fileId: reuse ? before.fileId : randomId("fil"),
          docId: reuse ? before.docId : randomId("doc"),
          docKind: classified.docKind,
          // An uploaded document keeps the hash of the text the server has.
          blobHash: reuse && before.uploaded ? before.blobHash : hash,
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
      name,
      startedAt: existing?.startedAt ?? Date.now(),
      ...(existing?.projectId ? { projectId: existing.projectId, manifestDocId: existing.manifestDocId } : {}),
      files,
    };
    await writeSharePlan(root, plan);

    try {
      this.progress(notebook, { phase: "creating-project", done: 0, total: 1 });
      if (!plan.projectId) {
        const project =
          (await this.orphanProject(api, accountId, name, plan.startedAt, target.kind)) ??
          (await api.createProject(album ? { name, kind: "album" } : { name }));
        if (album && project.kind !== "album") {
          throw new ControlError(409, "update-required", "The collaboration server is too old for shared albums. Ask its administrator to update it.");
        }
        plan.projectId = project.id;
        plan.manifestDocId = project.manifestDocId;
        await writeSharePlan(root, plan);
      }
      const projectId = plan.projectId;
      const manifestDocId = plan.manifestDocId as string;

      const documents = files.filter((file) => file.kind === "doc");
      let done = documents.filter((file) => file.uploaded).length;
      this.progress(notebook, { phase: "importing-documents", done, total: documents.length });
      for (const file of documents) {
        if (file.uploaded) continue;
        await createSharedDocument(api, projectId, { docId: file.docId as string, fileId: file.fileId }, file.docKind!, texts.get(file.path) ?? "");
        file.uploaded = true;
        done += 1;
        await writeSharePlan(root, plan);
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
        await api.uploadBlob(projectId, bytes, file.mime ?? "application/octet-stream");
        file.uploaded = true;
        done += 1;
        await writeSharePlan(root, plan);
        this.progress(notebook, { phase: "uploading-files", done, total: blobs.length });
      }

      // The manifest, through the manifest hub, in one transaction. Entries
      // are keyed by fileId with fixed timestamps, so writing them again on a
      // retry changes nothing that matters.
      this.progress(notebook, { phase: "writing-manifest", done: 0, total: 1 });
      const folderId = randomId("fld");
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
            ...(stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : {}),
          };
          if (file.kind === "doc" && file.docId) {
            const text = texts.get(file.path);
            if (text !== undefined && sha256(Buffer.from(text, "utf8")) === file.blobHash) await writeBase(root, file.docId, text);
            this.deps.host.store.upsertDoc({ docId: file.docId, projectId, fileId: file.fileId, path: file.path, materializedHash: file.blobHash ?? null });
          }
          if (file.kind === "blob" && file.blobHash) {
            this.deps.host.store.putBlob({ hash: file.blobHash, localPath: path.join(root, ...file.path.split("/")), size: file.size ?? 0 });
          }
        }
        await writeState(root, state);
        this.pendingRoots.add(root);
        await writeMarker(root, {
          projectId,
          serverUrl: api.baseUrl,
          accountId,
          manifestDocId,
          sharedAt: new Date(plan.startedAt).toISOString(),
          ...(album ? { kind: "album" as const } : {}),
          writer: this.installationId,
          folderId,
        });
        this.deps.host.store.upsertProject({ projectId, name, localRoot: root, role: "owner" });
        await deleteSharePlan(root);
        synced = await waitUntil(() => hub.isClosed || (hub.pendingCount === 0 && hubHasState(this.deps.host, hub, "manifest") && hub.getStatus().state === "saved-remote"), this.shareSyncTimeoutMs);
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
      this.pendingRoots.delete(root);
      await this.lease(handle);
      await this.run(handle);
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
    } finally {
      this.pendingRoots.delete(root);
    }
  }

  /**
   * A project an earlier attempt created but did not record (it died between
   * the server's answer and writing the plan): ours, same name, created after
   * the plan started, not used locally, and with an empty manifest.
   */
  private async orphanProject(api: ApiClient, accountId: string, name: string, startedAt: number, kind: ProjectKind): Promise<ProjectSummary | null> {
    const projects = await api.listProjects();
    for (const project of projects) {
      if (project.ownerId !== accountId || project.name !== name || (project.kind ?? "notebook") !== kind) continue;
      if (Date.parse(project.createdAt) < startedAt - 60_000) continue;
      if (this.deps.host.store.getProject(project.id)) continue;
      // Documents are only created after the plan records the project, so an
      // orphan has none; an untouched manifest confirms nobody used it.
      const manifest = await api.getDocument(project.manifestDocId).catch(() => null);
      if (manifest && manifest.lastServerSeq > 0) continue;
      return project;
    }
    return null;
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
    const accountId = await this.accountId();
    const known = this.projects.get(project.id);
    const kind: ProjectKind = project.kind === "album" ? "album" : "notebook";
    if (known && !known.revoked) {
      return { projectId: project.id, kind, name: known.name, notebook: known.notebook, role: known.role, materialized: known.runtime?.isMaterialized() ?? false, alreadyJoined: true };
    }

    // An album joins the gallery as one of its folders; a notebook joins the library.
    const base = kind === "album" ? this.galleryRoot : this.deps.libraryRoot;
    const notebook = await this.createFolder(folderNameFor(project.name), base);
    const root = path.join(base, notebook);
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
      });
      this.deps.host.store.upsertProject({ projectId: project.id, name: project.name, localRoot: root, role: project.role });
    } finally {
      this.pendingRoots.delete(root);
    }
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
    if (handle.revoked) throw new ControlError(403, "access-revoked", "Access to this notebook was revoked.");
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

  async resolveReconciliation(id: string, text: unknown): Promise<{ docId: string; text: string }> {
    if (typeof text !== "string") throw new ControlError(400, "bad-request", "The merged text is required.");
    for (const handle of this.projects.values()) {
      if (handle.runtime?.hasReconciliation(id)) {
        const result = await handle.runtime.resolveReconciliation(id, text);
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
    router.add("POST", ControlRoutes.share, wrap(async (request) => ({ body: await this.share(request.body as ShareNotebookRequest) })));
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
      wrap(async (request) => ({ body: await this.resolveReconciliation(request.params.id, (request.body as { text?: unknown } | undefined)?.text) })),
    );
  }
}

function indexOf(docs: IndexedDoc[]): Map<string, IndexedDoc> {
  return new Map(docs.map((doc) => [manifestPathKey(doc.path), doc]));
}
