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

import type {
  AuditEntry,
  Command,
  CommandKind,
  CreateReviewRequest,
  DecideReviewRequest,
  DecideSuggestionsRequest,
  DecideSuggestionsResponse,
  Invitation,
  MarkNotificationsReadRequest,
  Member,
  NotificationInfo,
  RestoreRequest,
  RestoreResponse,
  RevertSuggestionResponse,
  Review,
  Revision,
  RevisionContent,
  SuggestionInfo,
  Thread,
  ThreadMessage,
  UpdatesPage,
} from "./protocol/api";
import type { AiActorHint, AiFeature, Provenance } from "./protocol/actor";
import type { Role } from "./protocol/roles";
import type { DocKind, SuggestionStatus } from "./protocol/schema";
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
  /** The text cannot be edited here: access was revoked, or the role is below editor. */
  readOnly: boolean;
  /** Access was revoked (the folder is kept read-only); nothing can be written, suggestions and comments included. */
  revoked?: boolean;
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
  /**
   * The text the edits were computed against (an agentic-review session
   * snapshot, the text the agent read). When set, offsets refer to it and
   * every edit needs `before`: edits whose passage is unchanged are mapped
   * onto the live text (collaborators' edits elsewhere only shift them), the
   * others are created stale with `before` as their baseQuote (hard case 7).
   * Without it, offsets refer to the live text.
   */
  snapshot?: string;
}

export interface CreateSuggestionsResponse {
  suggestionIds: string[];
  /** Edits whose `before` no longer matched; created as stale suggestions. */
  staleIndexes: number[];
}

/**
 * POST /docs/:docId/suggestions/withdraw: withdraws the signed-in account's
 * own pending or stale suggestions (directly, or made by AI on its behalf)
 * that match any of the filters. Agent undo withdraws a run's suggestions;
 * agentic review withdraws a proposal's group when it is revised.
 */
export interface WithdrawSuggestionsRequest {
  suggestionIds?: string[];
  /** AI suggestions whose actor has this runId. */
  runId?: string;
  groupId?: string;
}

export interface WithdrawSuggestionsResponse {
  withdrawn: string[];
  /** Matching suggestions left alone: already decided or withdrawn, or someone else's. */
  skipped: { suggestionId: string; status: SuggestionStatus; reason: "decided" | "not-owner" }[];
}

/**
 * POST /docs/:docId/suggestions/decisions. `commandId` is the idempotency key
 * (generated by the client so a retry after a lost response, or the offline
 * replay, is the same command); the host makes one up when it is missing.
 */
export interface DecideSuggestionsLocalRequest extends DecideSuggestionsRequest {
  commandId?: string;
}

/**
 * Online: the server's answer (200). Offline or when the server cannot be
 * reached: the decision is queued as a `suggestions.decide` command and
 * replayed on reconnect (202); its outcome arrives as a
 * `suggestions-settled` host event and from GET …/commands/:commandId.
 */
export type DecideSuggestionsLocalResponse =
  | ({ queued: false; commandId: string } & DecideSuggestionsResponse)
  | { queued: true; commandId: string };

/** GET /docs/:docId/suggestions/commands/:commandId. "unknown" after a host restart forgot a settled result. */
export type SuggestionCommandStatus =
  | { state: "pending" }
  | { state: "settled"; ok: boolean; status: number; response?: DecideSuggestionsResponse; error?: { code: string; message: string } }
  | { state: "unknown" };

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

/** An offline command (thread, message or checkpoint) waiting in the host's queue. */
export interface QueuedCommand {
  command: Command;
  attempts: number;
  lastError: string | null;
}

/** A queued command the server refused for good (it left the queue). */
export interface FailedCommand {
  command: Command;
  status: number;
  error: { code: string; message: string };
  failedAt: number;
}

/** GET /commands: what is still queued and what failed, so a window can rebuild its pending chips. */
export interface CommandsState {
  pending: QueuedCommand[];
  failed: FailedCommand[];
}

/** POST /commands answers with the queued id (a replayed id is not queued twice). */
export interface EnqueueCommandResponse {
  id: string;
  queued: boolean;
}

/** GET /projects/:projectId/migrate-comments: local review comments that could move to the server. */
export interface LocalCommentsSummary {
  documents: number;
  threads: number;
}

/** POST /projects/:projectId/migrate-comments. */
export interface MigrateCommentsResponse {
  documents: number;
  threads: number;
  /** Threads whose quote no longer matched; created detached so they can be reattached. */
  detached: number;
  /** Threads left alone because they were migrated before. */
  skipped: number;
}

/** Query of GET /docs/:docId/updates (mirrors the server's updates feed). */
export interface DocUpdatesQuery {
  fromSeq?: number;
  toSeq?: number;
  subdoc?: string;
  limit?: number;
}

/**
 * POST /docs/:docId/threads/at-range: a comment thread on a range of text,
 * for callers that cannot write the anchor themselves (the agent's review
 * comments, which run in Next). The host writes the anchor into the
 * document's annotations, then creates the thread; offline, the thread
 * waits in the command queue like any comment (202). With `snapshot`, the
 * range refers to that text and is mapped onto the live one (409
 * `passage-changed` when the passage itself changed).
 */
export interface CreateThreadAtRangeRequest {
  /** Client-chosen thread id (for an idempotent retry); the host makes one up otherwise. */
  id?: string;
  range: { start: number; end: number };
  snapshot?: string;
  body: string;
  mentions?: string[];
  ai?: AiActorHint;
}

export type CreateThreadAtRangeResponse =
  | { queued: false; thread: Thread }
  | { queued: true; threadId: string; commandId: string };

/**
 * POST /reviews/:reviewId/decision. `commandId` is the idempotency key, as
 * for suggestion decisions. Online: the server's updated Review (200).
 * Offline or unreachable: queued as a `review.decide` command (202) and
 * replayed on reconnect; its outcome arrives as a `command-settled` host
 * event (kind "review.decide", body the Review).
 */
export interface DecideReviewLocalRequest extends DecideReviewRequest {
  commandId?: string;
}

export type DecideReviewLocalResponse =
  | { queued: false; commandId: string; review: Review }
  | { queued: true; commandId: string };

/** Query of GET /projects/:projectId/audit. */
export interface AuditQuery {
  /** Entries per page (1–200, default 50). */
  limit?: number;
  /** Page backwards from this entry id (exclusive); `nextBefore` of the previous page. */
  before?: string;
  /** Only entries whose action equals this, or starts with it followed by "." ("review" matches "review.decide"). */
  action?: string;
}

/** GET /projects/:projectId/audit (owners): newest first. */
export interface AuditPage {
  entries: AuditEntry[];
  /** Pass as `before` for the next page; null at the end of the log. */
  nextBefore: string | null;
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
  | { t: "divergence"; docId: string; recovered: boolean }
  /**
   * A queued command left the queue: delivered (ok) or refused for good.
   * `body` is the server's result (the Thread or ThreadMessage on success).
   */
  | {
      t: "command-settled";
      id: string;
      kind: CommandKind;
      ok: boolean;
      status: number;
      body: unknown;
      error?: { code: string; message: string };
    }
  /** A queued suggestion decision was replayed (or refused) after reconnecting. */
  | { t: "suggestions-settled"; docId: string; commandId: string; status: Extract<SuggestionCommandStatus, { state: "settled" }> };

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

  // ---- comments (Phase 2): proxies to /v1/documents/:docId/threads, /v1/threads, /v1/messages
  /** GET → Thread[]; POST CreateThreadRequest → Thread. */
  threads: (docId: string) => `/docs/${encodeURIComponent(docId)}/threads`,
  /** POST CreateThreadAtRangeRequest → CreateThreadAtRangeResponse (201, or 202 queued). */
  threadsAtRange: (docId: string) => `/docs/${encodeURIComponent(docId)}/threads/at-range`,
  /** GET → Thread; DELETE → 204. */
  thread: (threadId: string) => `/threads/${encodeURIComponent(threadId)}`,
  /** POST CreateMessageRequest → ThreadMessage. */
  threadMessages: (threadId: string) => `/threads/${encodeURIComponent(threadId)}/messages`,
  /** POST SetThreadStatusRequest → Thread. */
  threadStatus: (threadId: string) => `/threads/${encodeURIComponent(threadId)}/status`,
  /** POST ReattachThreadRequest → Thread. */
  threadReattach: (threadId: string) => `/threads/${encodeURIComponent(threadId)}/reattach`,
  /** PATCH EditMessageRequest → ThreadMessage; DELETE → 204. */
  message: (messageId: string) => `/messages/${encodeURIComponent(messageId)}`,
  /** GET → CommandsState; POST Command → EnqueueCommandResponse (202). */
  commands: "/commands",
  /** DELETE → 204: forgets a failed command (Discard). */
  command: (commandId: string) => `/commands/${encodeURIComponent(commandId)}`,
  /** GET → LocalCommentsSummary; POST → MigrateCommentsResponse (owner only). */
  migrateComments: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/migrate-comments`,

  // ---- version history (Phase 2): proxies to /v1/documents/:docId/revisions, /updates, /restore
  /** GET → Revision[] newest first; POST CreateRevisionRequest → Revision (session-end is queued: 202). */
  revisions: (docId: string) => `/docs/${encodeURIComponent(docId)}/revisions`,
  /** GET → RevisionContent. */
  revisionContent: (docId: string, revisionId: string) =>
    `/docs/${encodeURIComponent(docId)}/revisions/${encodeURIComponent(revisionId)}/content`,
  /** GET (DocUpdatesQuery as the query string) → UpdatesPage. */
  docUpdates: (docId: string) => `/docs/${encodeURIComponent(docId)}/updates`,
  /** POST RestoreRequest → RestoreResponse (editors and owners). */
  restore: (docId: string) => `/docs/${encodeURIComponent(docId)}/restore`,
  // Suggestions (Phase 3). GET docSuggestions → SuggestionInfo[] (the server
  // mirror, with decided history); POST docSuggestions creates overlay
  // suggestions (above).
  /** POST DecideSuggestionsLocalRequest → DecideSuggestionsLocalResponse (200 decided, 202 queued). */
  docSuggestionDecisions: (docId: string) => `/docs/${encodeURIComponent(docId)}/suggestions/decisions`,
  /** GET → SuggestionCommandStatus for a decision queued offline. */
  docSuggestionCommand: (docId: string, commandId: string) =>
    `/docs/${encodeURIComponent(docId)}/suggestions/commands/${encodeURIComponent(commandId)}`,
  /** POST → RevertSuggestionResponse ("Undo acceptance"; online only). */
  suggestionRevert: (suggestionId: string) => `/suggestions/${encodeURIComponent(suggestionId)}/revert`,
  /** POST WithdrawSuggestionsRequest → WithdrawSuggestionsResponse (your own pending suggestions). */
  docSuggestionsWithdraw: (docId: string) => `/docs/${encodeURIComponent(docId)}/suggestions/withdraw`,

  // ---- formal review (Phase 3): proxies to /v1/documents/:docId/reviews and /v1/reviews/…
  /** GET → Review[] (open and closed); POST CreateReviewRequest → Review (editors and owners). */
  reviews: (docId: string) => `/docs/${encodeURIComponent(docId)}/reviews`,
  /** POST DecideReviewLocalRequest → DecideReviewLocalResponse (assignees; 200 decided, 202 queued). */
  reviewDecision: (reviewId: string) => `/reviews/${encodeURIComponent(reviewId)}/decision`,
  /** POST → Review (the requester, editors and owners). */
  reviewClose: (reviewId: string) => `/reviews/${encodeURIComponent(reviewId)}/close`,
  /** GET (AuditQuery as the query string) → AuditPage (owners). */
  audit: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/audit`,
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

export type {
  AuditEntry,
  Command,
  CreateReviewRequest,
  Invitation,
  MarkNotificationsReadRequest,
  Member,
  NotificationInfo,
  RestoreRequest,
  RestoreResponse,
  RevertSuggestionResponse,
  Review,
  Revision,
  RevisionContent,
  SuggestionInfo,
  Thread,
  ThreadMessage,
  UpdatesPage,
};
