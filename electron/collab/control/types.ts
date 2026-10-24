// Seams of the collab host's control API (local-api.ts has the wire types).
//
// The control server (control/server.ts) owns HTTP, auth and routing. Feature
// modules register routes on a ControlRouter: core routes (account, projects,
// documents) in control/, shared-notebook routes (share, join, files,
// reconciliations) in notebooks/. Both receive ControlDeps.

import type { HostEvent, LocalProject, ResolvedDoc } from "../../../src/lib/collab/local-api";
import type { CollabHost } from "../core/host";

export interface ControlRequest {
  method: string;
  /** Path without the query string, e.g. "/docs/abc/text". */
  path: string;
  /** Named parameters from the route pattern (":docId"). */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body, or undefined. */
  body: unknown;
}

export interface ControlResponse {
  status?: number;
  body?: unknown;
}

export type ControlHandler = (request: ControlRequest) => Promise<ControlResponse> | ControlResponse;

export interface ControlRouter {
  /** Pattern segments starting with ":" are parameters, e.g. "/docs/:docId/text". */
  add(method: "GET" | "POST" | "PATCH" | "DELETE", pattern: string, handler: ControlHandler): void;
}

/** Thrown by handlers to answer with an error status and `{ error: { code, message } }`. */
export class ControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export interface ControlDeps {
  host: CollabHost;
  /** Master directory (`<LIBERA_DATA_DIR>/users/admin`); notebooks are its direct children. */
  libraryRoot: string;
  /**
   * The gallery folder (`<LIBERA_DATA_DIR>/gallery`); shared albums are its
   * direct children. Defaults to the gallery beside `users/`.
   */
  galleryRoot?: string;
  /** Pushes an event to every window (through main and the preload). */
  emit(event: HostEvent): void;
  notebooks: NotebookService;
  /**
   * Asks the control server to recompute HostStatus and push it as a
   * `status` event if it changed (after a share, join or revocation).
   */
  statusChanged?(): void;
}

/**
 * Shared notebooks on disk (materializer, watcher, manifest, share/join).
 * Implemented in notebooks/; the control server calls it.
 */
export interface NotebookService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Maps a Libera path ("Notebook/sub/file.md") to its shared document, or null. */
  resolvePath(liberaPath: string): ResolvedDoc | null;
  /**
   * The reverse of resolvePath: the shared file a docId belongs to, or null.
   * Optional until the notebook service implements it; GET /docs/:docId
   * answers 404 without it.
   */
  resolveDoc?(docId: string): ResolvedDoc | null;
  /**
   * Called before sign-out or switching accounts, while the current account
   * can still reach the server (gives up synced-folder writer leases).
   */
  beforeAccountChange?(): Promise<void>;
  /** Called after sign-in/sign-out so the service can (re)attach projects. */
  accountChanged(): Promise<void>;
  registerRoutes(router: ControlRouter): void;
  /**
   * Shared notebooks on this device, for HostStatus.projects (role, folder,
   * revoked, pending reconciliations). Optional so test doubles can omit it.
   */
  localProjects?(): LocalProject[];
}
