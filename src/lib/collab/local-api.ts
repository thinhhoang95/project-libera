// Contracts between the parts of Libera that run on one machine:
//
//   renderer ──fetch /api/collab/*──▶ Next server ──HTTP──▶ collab host control API
//   renderer ◀──window.liberaCollab (preload)──▶ main ◀──parentPort──▶ collab host
//
// The control API listens on 127.0.0.1 with a per-launch bearer token. Next
// receives its URL and token as LIBERA_COLLAB_HOST_URL / LIBERA_COLLAB_HOST_TOKEN.
// The Next routes under /api/collab mirror the control routes one to one
// (behind the local app session), so the React UI never talks to the host
// directly except through MessagePorts for live documents.
//
// Types only plus route constants: imported by the renderer, Next and the host.

import type { Invitation, MarkNotificationsReadRequest, Member, NotificationInfo } from "./protocol/api";
import type { AiFeature, Provenance } from "./protocol/actor";
import type { Role } from "./protocol/roles";
import type { DocKind } from "./protocol/schema";
import type { SyncStatus } from "./protocol/local";

export type HostConnection =
  /** No account configured. */
  | "signed-out"
  | "connecting"
  | "connected"
  /** Account configured, server unreachable; editing continues locally. */
  | "offline"
  /** Refresh failed; local editing continues until the user signs in again. */
  | "needs-sign-in"
  /** Server requires a newer protocol (close 4026). */
  | "update-required";

export interface LocalAccount {
  id: string;
  email: string;
  displayName: string;
  color: string;
  serverUrl: string;
}

export interface LocalProject {
  projectId: string;
  name: string;
  role: Role;
  /** Top-level notebook folder name under the master directory. */
  notebook: string;
  /** Set when access was revoked; the folder is kept read-only. */
  revoked: boolean;
  /** Files whose disk copy conflicts with the shared document. */
  reconcilePending: number;
}

export interface HostStatus {
  hostVersion: number;
  connection: HostConnection;
  account: LocalAccount | null;
  projects: LocalProject[];
  /** Commands queued while offline (comments, decisions). */
  pendingCommands: number;
  detail?: string;
}

export interface SignInRequest {
  serverUrl: string;
  email: string;
  password: string;
}

export interface RegisterLocalRequest extends SignInRequest {
  displayName: string;
  invitationToken?: string;
}

export interface UpdateAccountRequest {
  displayName?: string;
  color?: string;
}

export interface ShareNotebookRequest {
  /** Existing top-level notebook to share (its folder name). */
  notebook: string;
  /** Project name shown to collaborators; defaults to the notebook name. */
  name?: string;
}

export interface ShareProgress {
  phase: "creating-project" | "importing-documents" | "uploading-files" | "writing-manifest" | "done";
  done: number;
  total: number;
}

export interface JoinProjectRequest {
  /** Invitation token or full invitation URL. */
  invitation: string;
}

export interface InviteRequest {
  email: string;
  role: Exclude<Role, "owner">;
}

/** A Libera path ("Notebook/sub/file.md") resolved to a shared document. */
export interface ResolvedDoc {
  docId: string;
  projectId: string;
  fileId: string;
  path: string;
  kind: DocKind;
  role: Role;
  readOnly: boolean;
}

export interface DocText {
  docId: string;
  text: string;
  status: SyncStatus;
}

/** A replacement on the current text by UTF-16 offsets. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
  /** Text expected between start and end; the edit is refused if it differs. */
  before?: string;
}

export interface ApplyEditsRequest {
  edits: TextEdit[];
  provenance: Provenance;
}

export interface ApplyEditsResponse {
  applied: boolean;
  text: string;
  /** Index of the first edit whose `before` did not match. */
  conflictAt?: number;
}

export interface CreateSuggestionsRequest {
  edits: TextEdit[];
  ai?: { feature: AiFeature; model?: string; runId?: string };
  groupId?: string;
  reason?: string;
  title?: string;
  threadIds?: string[];
}

export interface CreateSuggestionsResponse {
  suggestionIds: string[];
  /** Edits whose `before` no longer matched; created as stale suggestions. */
  staleIndexes: number[];
}

export interface FileOpRequest {
  /**
   * `write-blob` adds a binary file (an upload, a pasted image, an edited
   * photo) or replaces the bytes of an existing blob entry. A new file whose
   * path and bytes make it a text document is created as one, like
   * `create-file`; an existing document is refused (change it with edits).
   */
  op: "create-file" | "create-folder" | "rename" | "delete" | "write-blob";
  path: string;
  /** For rename. */
  to?: string;
  /** For create-file of a text document: initial text. */
  content?: string;
  /** For write-blob: the file's bytes, base64. */
  contentBase64?: string;
}

export interface Reconciliation {
  id: string;
  docId: string;
  path: string;
  /** What the document says now. */
  shared: string;
  /** What the file on disk says. */
  disk: string;
  /** The last text Libera wrote to disk (the common base). */
  base: string;
  detectedAt: number;
}

/** Query of GET /notifications (mirrors the server's GET /v1/notifications). */
export interface NotificationsQuery {
  unread?: boolean;
  /** ISO time; returns notifications created before it (paging). */
  before?: string;
  limit?: number;
}

export interface ResolveReconciliationRequest {
  /** The merged text to keep; applied as edits authored by the user. */
  text: string;
}

/** Events the host pushes to every window (through main and the preload). */
export type HostEvent =
  | { t: "status"; status: HostStatus }
  | { t: "share-progress"; notebook: string; progress: ShareProgress }
  | { t: "reconcile-needed"; reconciliation: Reconciliation }
  | { t: "notification"; notification: NotificationInfo }
  | { t: "project-changed"; projectId: string }
  | { t: "files-changed"; projectId: string; paths: string[] }
  | { t: "server-event"; scope: string; id: string; kind: string; payload: unknown }
  /**
   * The hourly divergence check found this document differing from the
   * server at the same state vector. `recovered` says whether re-opening it
   * with the server's full state made it match again (nothing local is dropped).
   */
  | { t: "divergence"; docId: string; recovered: boolean };

export const ControlRoutes = {
  status: "/status",
  signIn: "/account/sign-in",
  register: "/account/register",
  signOut: "/account/sign-out",
  account: "/account",
  projects: "/projects",
  share: "/projects/share",
  join: "/projects/join",
  members: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/members`,
  member: (projectId: string, userId: string) =>
    `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
  invitations: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/invitations`,
  invitation: (projectId: string, invitationId: string) =>
    `/projects/${encodeURIComponent(projectId)}/invitations/${encodeURIComponent(invitationId)}`,
  leave: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/leave`,
  resolve: "/docs/resolve",
  docText: (docId: string) => `/docs/${encodeURIComponent(docId)}/text`,
  docEdits: (docId: string) => `/docs/${encodeURIComponent(docId)}/edits`,
  docSuggestions: (docId: string) => `/docs/${encodeURIComponent(docId)}/suggestions`,
  files: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/files`,
  reconciliations: "/reconciliations",
  reconciliation: (id: string) => `/reconciliations/${encodeURIComponent(id)}`,
  /** GET → ResolvedDoc: the reverse of `resolve`, so a notification about a docId can open its file. */
  doc: (docId: string) => `/docs/${encodeURIComponent(docId)}`,
  /** GET (NotificationsQuery as the query string) → NotificationInfo[], newest first. */
  notifications: "/notifications",
  /** POST MarkNotificationsReadRequest → 204. */
  notificationsRead: "/notifications/read",
  /** GET → HostDiagnostics (ui/diagnostics-types.ts): the "Report sync problem" bundle, no content. */
  diagnostics: "/diagnostics",
  /** POST → DivergenceRecord[]: runs the divergence check on every open or recent document now. */
  divergenceCheck: "/diagnostics/divergence-check",
} as const;

/** Next routes are the control routes under this prefix. */
export const LOCAL_API_PREFIX = "/api/collab";

/** Shape of `window.liberaCollab`, exposed by electron/preload.cjs. */
export interface LiberaCollabBridge {
  /** Resolves to a MessagePort connected to the DocHub for docId (protocol/local.ts). */
  attach(docId: string): Promise<MessagePort>;
  onEvent(listener: (event: HostEvent) => void): () => void;
  /** Ask the host to reconnect now (used after the user fixes the network). */
  nudge(): void;
}

export type { Invitation, MarkNotificationsReadRequest, Member, NotificationInfo };
