// The NotebookService: shared notebooks on disk (collaboration map §7.3,
// implementation plan M1.5 and the revocation part of M1.8).
//
// It owns the list of shared notebooks, the share and join flows, the
// control routes for files and reconciliations, revocation, and the
// in-memory index behind resolvePath. Each running notebook is a
// SharedProject (project.ts).

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  FileOpRequest,
  JoinProjectRequest,
  LocalProject,
  Reconciliation,
  ResolvedDoc,
  ShareNotebookRequest,
  ShareProgress,
} from "../../../src/lib/collab/local-api";
import { ControlRoutes } from "../../../src/lib/collab/local-api";
import type { ProjectSummary } from "../../../src/lib/collab/protocol/api";
import { EventKind } from "../../../src/lib/collab/protocol/messages";
import { isRole, roleAtLeast, type Role } from "../../../src/lib/collab/protocol/roles";
import { ManifestKeys, manifestPathKey, type ManifestEntry } from "../../../src/lib/collab/protocol/schema";
import { ApiClientError, type ApiClient } from "../core/api-client";
import { consoleLogger, type Logger } from "../core/clock";
import type { CollabHostEvent } from "../core/host";
import { ControlError, type ControlDeps, type ControlHandler, type ControlRouter, type NotebookService } from "../control/types";
import { classifyFile, createSharedDocument, mimeForPath } from "./documents";
import { PathRefusedError, randomId, readIfExists, sha256, statIfExists, walkNotebook } from "./fs-ops";
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
} from "./state";

export interface NotebookServiceOptions {
  timings?: Partial<Timings>;
  logger?: Logger;
  /** How long join waits for the first full materialization before answering. */
  joinTimeoutMs?: number;
  /** How long share waits for the server to acknowledge the manifest. */
  shareSyncTimeoutMs?: number;
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

export interface JoinResult {
  projectId: string;
  name: string;
  notebook: string;
  role: Role;
  /** Every file was written before the answer (false: the rest arrive in the background). */
  materialized: boolean;
  alreadyJoined: boolean;
}

interface ProjectHandle {
  projectId: string;
  name: string;
  notebook: string;
  root: string;
  role: Role;
  manifestDocId: string;
  revoked: boolean;
  runtime: SharedProject | null;
  index: Map<string, IndexedDoc>;
  reconcilePending: number;
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

  constructor(deps: Omit<ControlDeps, "notebooks">, options: NotebookServiceOptions = {}) {
    this.deps = deps;
    this.logger = options.logger ?? consoleLogger;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.joinTimeoutMs = options.joinTimeoutMs ?? 60_000;
    this.shareSyncTimeoutMs = options.shareSyncTimeoutMs ?? 20_000;
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeHost = this.deps.host.on((event) => this.hostEvent(event));
    await this.loadProjects();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribeHost?.();
    this.unsubscribeHost = null;
    await this.loading?.catch(() => undefined);
    await Promise.all([...this.projects.values()].map((handle) => handle.runtime?.stop()));
    this.projects.clear();
  }

  async accountChanged(): Promise<void> {
    this.cachedAccountId = null;
    if (!this.started) return;
    await Promise.all([...this.projects.values()].map((handle) => handle.runtime?.stop()));
    this.projects.clear();
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
        const handle: ProjectHandle = {
          projectId: row.projectId,
          name: row.name,
          notebook: path.basename(row.localRoot),
          root: row.localRoot,
          role: row.role ?? "viewer",
          manifestDocId: marker.manifestDocId,
          revoked: marker.revoked === true,
          runtime: null,
          index: new Map(),
          reconcilePending: 0,
        };
        this.projects.set(handle.projectId, handle);
        if (handle.revoked) {
          const { docs, reconcilePending } = await SharedProject.readIndex(handle.root);
          handle.index = indexOf(docs);
          handle.reconcilePending = reconcilePending;
        } else {
          await this.run(handle);
        }
      }
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
    });
    handle.runtime = runtime;
    this.reindex(handle.projectId);
    runtime.start();
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
    if (kind === EventKind.ProjectDeleted || (kind === EventKind.MemberRemoved && aboutMe)) {
      void this.revoke(projectId);
    } else if (kind === EventKind.RoleChanged && aboutMe && isRole(data.role)) {
      this.setRole(projectId, data.role);
    }
  }

  /**
   * Access ended: stop syncing, keep every file, mark the folder. The index
   * stays so resolvePath answers readOnly and the app can offer export.
   */
  private async revoke(projectId: string): Promise<void> {
    return this.locked(`project:${projectId}`, () => this.doRevoke(projectId));
  }

  private async doRevoke(projectId: string): Promise<void> {
    const handle = this.projects.get(projectId);
    if (!handle || handle.revoked) return;
    handle.revoked = true;
    const runtime = handle.runtime;
    handle.runtime = null;
    if (runtime) {
      handle.index = indexOf(runtime.indexedDocs());
      handle.reconcilePending = runtime.reconcilePending;
      await runtime.stop();
    }
    const marker = await readMarker(handle.root).catch(() => null);
    if (marker) await writeMarker(handle.root, { ...marker, revoked: true, revokedAt: new Date().toISOString() }).catch(() => undefined);
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
      await handle.runtime?.stop();
      handle.runtime = null;
      await deleteSharePlan(handle.root);
      await deleteMarker(handle.root);
      this.deps.host.store.deleteProject(projectId);
      this.projects.delete(projectId);
      this.deps.emit({ t: "project-changed", projectId });
      this.deps.statusChanged?.();
    });
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
    return this.locked(`notebook:${notebook.toLowerCase()}`, () => this.doShare(notebook, request.name));
  }

  private async doShare(notebook: string, requestedName: string | undefined): Promise<ShareResult> {
    const api = this.requireApi();
    const root = await this.shareableRoot(notebook);
    if (await readMarker(root)) throw new ControlError(409, "already-shared", `${notebook} is already shared.`);
    const accountId = await this.accountId();

    // The plan: every id chosen once and written down before anything is
    // uploaded, so a retry after a crash or network failure reuses them and
    // the server's idempotency (document replays, content-addressed blobs)
    // turns the repeat into no-ops.
    const existing = await readSharePlan(root);
    const name = (requestedName?.trim() || existing?.name || notebook).slice(0, 200);
    const previous = new Map((existing?.files ?? []).map((file) => [file.path, file]));
    const { entries: walked, skipped } = await walkNotebook(root);
    const files: PlannedFile[] = [];
    const texts = new Map<string, string>();
    for (const item of walked) {
      const before = previous.get(item.relative);
      if (item.kind === "folder") {
        files.push(before?.kind === "folder" ? before : { path: item.relative, kind: "folder", fileId: randomId("fil") });
        continue;
      }
      const bytes = await readIfExists(path.join(root, ...item.relative.split("/")));
      if (!bytes) continue;
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
          mime: mimeForPath(item.relative),
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
        const project = (await this.orphanProject(api, accountId, name, plan.startedAt)) ?? (await api.createProject({ name }));
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
        await writeMarker(root, { projectId, serverUrl: api.baseUrl, accountId, manifestDocId, sharedAt: new Date(plan.startedAt).toISOString() });
        this.deps.host.store.upsertProject({ projectId, name, localRoot: root, role: "owner" });
        await deleteSharePlan(root);
        synced = await waitUntil(() => hub.isClosed || (hub.pendingCount === 0 && hubHasState(this.deps.host, hub, "manifest") && hub.getStatus().state === "saved-remote"), this.shareSyncTimeoutMs);
      } finally {
        this.deps.host.release(manifestDocId);
      }

      const handle: ProjectHandle = {
        projectId,
        name,
        notebook,
        root,
        role: "owner",
        manifestDocId,
        revoked: false,
        runtime: null,
        index: new Map(),
        reconcilePending: 0,
      };
      this.projects.set(projectId, handle);
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
        notes: [LOCAL_REVIEW_NOTE, ARCHIVE_NOTE],
      };
    } catch (error) {
      throw toControlError(error);
    }
  }

  /**
   * A project an earlier attempt created but did not record (it died between
   * the server's answer and writing the plan): ours, same name, created after
   * the plan started, not used locally, and with an empty manifest.
   */
  private async orphanProject(api: ApiClient, accountId: string, name: string, startedAt: number): Promise<ProjectSummary | null> {
    const projects = await api.listProjects();
    for (const project of projects) {
      if (project.ownerId !== accountId || project.name !== name) continue;
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
    if (known && !known.revoked) {
      return { projectId: project.id, name: known.name, notebook: known.notebook, role: known.role, materialized: known.runtime?.isMaterialized() ?? false, alreadyJoined: true };
    }

    const notebook = await this.createFolder(folderNameFor(project.name));
    const root = path.join(this.deps.libraryRoot, notebook);
    // The marker goes first: from now on Libera's own writers refuse the folder.
    await writeMarker(root, { projectId: project.id, serverUrl: api.baseUrl, accountId, manifestDocId: project.manifestDocId, sharedAt: project.createdAt });
    this.deps.host.store.upsertProject({ projectId: project.id, name: project.name, localRoot: root, role: project.role });
    if (known) {
      // Joined again after a revocation: the old folder stays as it is.
      this.projects.delete(project.id);
    }
    const handle: ProjectHandle = {
      projectId: project.id,
      name: project.name,
      notebook,
      root,
      role: project.role,
      manifestDocId: project.manifestDocId,
      revoked: false,
      runtime: null,
      index: new Map(),
      reconcilePending: 0,
    };
    this.projects.set(project.id, handle);
    await this.run(handle);
    const runtime = handle.runtime as SharedProject | null;
    const materialized = runtime ? await waitUntil(() => runtime.isMaterialized(), this.joinTimeoutMs) : false;
    if (runtime && materialized) await runtime.whenIdle();
    this.deps.emit({ t: "project-changed", projectId: project.id });
    return { projectId: project.id, name: project.name, notebook, role: project.role, materialized, alreadyJoined: false };
  }

  /** Creates `<library>/<name>`, or "<name> (2)" and so on when the name is taken (case-insensitively). */
  private async createFolder(preferred: string): Promise<string> {
    await fs.mkdir(this.deps.libraryRoot, { recursive: true });
    const taken = new Set([...(await fs.readdir(this.deps.libraryRoot)), ...(await this.linkedFolderNames())].map((name) => name.toLowerCase()));
    for (let index = 1; index < 1000; index += 1) {
      const candidate = index === 1 ? preferred : `${preferred} (${index})`;
      if (taken.has(candidate.toLowerCase())) continue;
      try {
        await fs.mkdir(path.join(this.deps.libraryRoot, candidate));
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
    if (!handle) throw new ControlError(404, "not-found", "This notebook is not shared on this device.");
    if (handle.revoked || !handle.runtime) throw new ControlError(403, "access-revoked", "Access to this notebook was revoked.");
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
