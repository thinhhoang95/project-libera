// Typed REST client for the collab server (routes and shapes in
// src/lib/collab/protocol/api.ts).
//
// Requests carry the access token from the TokenProvider. A 401 with code
// "token-expired" refreshes once and retries once; every other failure is an
// ApiClientError with the server's code and HTTP status (status 0 and code
// "network" when the request never got a response).

import { createHash } from "node:crypto";

import type {
  Account,
  ApiErrorCode,
  AuditEntry,
  AuthResponse,
  BlobInfo,
  ChangePasswordRequest,
  ChangeRoleRequest,
  Command,
  CommandResult,
  CreateDocumentRequest,
  CreateInvitationRequest,
  CreateMessageRequest,
  CreateProjectRequest,
  CreateReviewRequest,
  CreateRevisionRequest,
  CreateThreadRequest,
  DecideReviewRequest,
  DecideSuggestionsRequest,
  DecideSuggestionsResponse,
  DocumentInfo,
  EditMessageRequest,
  FolderLease,
  FolderLeaseRequest,
  Invitation,
  InvitationPreview,
  LoginRequest,
  LogoutRequest,
  DeviceGrantRequest,
  DeviceGrantResponse,
  DeviceGrantSignInRequest,
  MarkNotificationsReadRequest,
  Member,
  NotificationInfo,
  ProjectSummary,
  ReattachThreadRequest,
  RefreshRequest,
  RegisterRequest,
  RenameProjectRequest,
  RestoreRequest,
  RestoreResponse,
  Review,
  RevertSuggestionResponse,
  Revision,
  RevisionContent,
  SetThreadStatusRequest,
  SuggestionInfo,
  Thread,
  ThreadMessage,
  UpdateMeRequest,
  UpdatesPage,
  VersionResponse,
} from "../../../src/lib/collab/protocol/api";
import { ApiRoutes } from "../../../src/lib/collab/protocol/api";
import type { TokenProvider } from "./sync-client";

export type ApiClientErrorCode = ApiErrorCode | "network" | "invalid-response" | "hash-mismatch" | "needs-sign-in";

export class ApiClientError extends Error {
  constructor(
    readonly code: ApiClientErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }

  /** Network failures, 5xx, 408 and 429 are worth retrying later. */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** https:// origin of the collab server, without a trailing slash. */
  baseUrl: string;
  tokenProvider: TokenProvider;
  fetch?: FetchLike;
  /** Sent as X-Libera-Client, for server logs. */
  clientId?: string;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** Skip the bearer token (auth routes, invitation preview, version). */
  anonymous?: boolean;
  raw?: { bytes: Uint8Array; contentType: string };
  /** Return the response bytes instead of JSON. */
  binary?: boolean;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly fetchImpl: FetchLike;
  private readonly clientId?: string;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.clientId = options.clientId;
  }

  // ------------------------------------------------------------ plumbing

  private url(path: string, query?: Query): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) search.set(key, String(value));
    }
    const text = search.toString();
    return `${this.baseUrl}${path}${text ? `?${text}` : ""}`;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    let token: string | null = null;
    if (!options.anonymous) {
      token = await this.tokenProvider.getAccessToken();
      if (!token) throw new ApiClientError("needs-sign-in", 401, "Not signed in to the collaboration server.");
    }
    try {
      return await this.send<T>(method, path, options, token);
    } catch (error) {
      if (options.anonymous || !(error instanceof ApiClientError) || error.status !== 401 || error.code !== "token-expired") {
        throw error;
      }
      const refreshed = await this.tokenProvider.refresh().catch(() => null);
      if (!refreshed) throw new ApiClientError("needs-sign-in", 401, "The session expired; sign in again.");
      return this.send<T>(method, path, options, refreshed);
    }
  }

  private async send<T>(method: string, path: string, options: RequestOptions, token: string | null): Promise<T> {
    const headers: Record<string, string> = { Accept: options.binary ? "application/octet-stream" : "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.clientId) headers["X-Libera-Client"] = this.clientId;
    let body: BodyInit | undefined;
    if (options.raw) {
      headers["Content-Type"] = options.raw.contentType;
      body = options.raw.bytes as unknown as BodyInit;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, options.query), { method, headers, body });
    } catch (error) {
      throw new ApiClientError("network", 0, error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) throw await this.errorFrom(response);
    if (options.binary) return new Uint8Array(await response.arrayBuffer()) as unknown as T;
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiClientError("invalid-response", response.status, "The server returned invalid JSON.");
    }
  }

  private async errorFrom(response: Response): Promise<ApiClientError> {
    let code: ApiClientErrorCode = response.status >= 500 ? "internal" : "bad-request";
    let message = `HTTP ${response.status}`;
    let details: unknown;
    try {
      const parsed = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      if (parsed?.error?.code) code = parsed.error.code as ApiClientErrorCode;
      if (parsed?.error?.message) message = parsed.error.message;
      details = parsed?.error?.details;
    } catch {
      if (response.status === 401) code = "unauthorized";
      else if (response.status === 403) code = "forbidden";
      else if (response.status === 404) code = "not-found";
      else if (response.status === 429) code = "rate-limited";
    }
    return new ApiClientError(code, response.status, message, details);
  }

  // ------------------------------------------------------------ accounts

  version(): Promise<VersionResponse> {
    return this.request("GET", ApiRoutes.version, { anonymous: true });
  }

  register(body: RegisterRequest): Promise<AuthResponse> {
    return this.request("POST", ApiRoutes.register, { body, anonymous: true });
  }

  login(body: LoginRequest): Promise<AuthResponse> {
    return this.request("POST", ApiRoutes.login, { body, anonymous: true });
  }

  refresh(body: RefreshRequest): Promise<AuthResponse> {
    return this.request("POST", ApiRoutes.refresh, { body, anonymous: true });
  }

  logout(body: LogoutRequest): Promise<void> {
    return this.request("POST", ApiRoutes.logout, { body, anonymous: true });
  }

  /** A grant that lets the person's other computers sign in (DeviceGrantRequest). */
  createDeviceGrant(body: DeviceGrantRequest = {}): Promise<DeviceGrantResponse> {
    return this.request("POST", ApiRoutes.deviceGrants, { body });
  }

  /** Revokes every device grant of the account; signed-in computers stay signed in. */
  revokeDeviceGrants(): Promise<void> {
    return this.request("DELETE", ApiRoutes.deviceGrants);
  }

  deviceGrantSignIn(body: DeviceGrantSignInRequest): Promise<AuthResponse> {
    return this.request("POST", ApiRoutes.deviceGrantSignIn, { body, anonymous: true });
  }

  me(): Promise<Account> {
    return this.request("GET", ApiRoutes.me);
  }

  updateMe(body: UpdateMeRequest): Promise<Account> {
    return this.request("PATCH", ApiRoutes.me, { body });
  }

  changePassword(body: ChangePasswordRequest): Promise<void> {
    return this.request("POST", ApiRoutes.password, { body });
  }

  // ------------------------------------------------------------ projects and members

  listProjects(): Promise<ProjectSummary[]> {
    return this.request("GET", ApiRoutes.projects);
  }

  createProject(body: CreateProjectRequest): Promise<ProjectSummary> {
    return this.request("POST", ApiRoutes.projects, { body });
  }

  getProject(projectId: string): Promise<ProjectSummary> {
    return this.request("GET", ApiRoutes.project(projectId));
  }

  renameProject(projectId: string, body: RenameProjectRequest): Promise<ProjectSummary> {
    return this.request("PATCH", ApiRoutes.project(projectId), { body });
  }

  deleteProject(projectId: string): Promise<void> {
    return this.request("DELETE", ApiRoutes.project(projectId));
  }

  /** Takes or renews the writer lease of a synced folder (granted: false when another installation holds it). */
  acquireFolderLease(projectId: string, body: FolderLeaseRequest): Promise<FolderLease> {
    return this.request("POST", ApiRoutes.folderLease(projectId), { body });
  }

  /** Gives the lease up, if `holder` still holds it. */
  releaseFolderLease(projectId: string, folderId: string, holder: string): Promise<void> {
    return this.request("DELETE", ApiRoutes.folderLease(projectId), { query: { folderId, holder } });
  }

  listMembers(projectId: string): Promise<Member[]> {
    return this.request("GET", ApiRoutes.members(projectId));
  }

  changeRole(projectId: string, userId: string, body: ChangeRoleRequest): Promise<Member> {
    return this.request("PATCH", ApiRoutes.member(projectId, userId), { body });
  }

  removeMember(projectId: string, userId: string): Promise<void> {
    return this.request("DELETE", ApiRoutes.member(projectId, userId));
  }

  // ------------------------------------------------------------ invitations

  listInvitations(projectId: string): Promise<Invitation[]> {
    return this.request("GET", ApiRoutes.projectInvitations(projectId));
  }

  createInvitation(projectId: string, body: CreateInvitationRequest): Promise<Invitation> {
    return this.request("POST", ApiRoutes.projectInvitations(projectId), { body });
  }

  revokeInvitation(invitationId: string): Promise<void> {
    return this.request("DELETE", ApiRoutes.invitation(invitationId));
  }

  previewInvitation(token: string): Promise<InvitationPreview> {
    return this.request("GET", ApiRoutes.invitationByToken(token), { anonymous: true });
  }

  acceptInvitation(token: string): Promise<ProjectSummary> {
    return this.request("POST", ApiRoutes.acceptInvitation(token));
  }

  // ------------------------------------------------------------ documents

  listDocuments(projectId: string): Promise<DocumentInfo[]> {
    return this.request("GET", ApiRoutes.documents(projectId));
  }

  createDocument(projectId: string, body: CreateDocumentRequest): Promise<DocumentInfo> {
    return this.request("POST", ApiRoutes.documents(projectId), { body });
  }

  getDocument(docId: string): Promise<DocumentInfo> {
    return this.request("GET", ApiRoutes.document(docId));
  }

  deleteDocument(docId: string): Promise<void> {
    return this.request("DELETE", ApiRoutes.document(docId));
  }

  /** The persisted update feed (history, attribution). */
  getUpdates(docId: string, query: { fromSeq?: number; limit?: number; subdoc?: string } = {}): Promise<UpdatesPage> {
    return this.request("GET", ApiRoutes.documentUpdates(docId), { query });
  }

  // ------------------------------------------------------------ blobs

  /** Uploads bytes under their SHA-256; returns the stored blob's info. */
  uploadBlob(projectId: string, bytes: Uint8Array, mime: string): Promise<BlobInfo> {
    const hash = sha256Hex(bytes);
    return this.request("PUT", ApiRoutes.blob(projectId, hash), { raw: { bytes, contentType: mime || "application/octet-stream" } });
  }

  /** Downloads a blob and verifies its SHA-256 before returning it. */
  async downloadBlob(projectId: string, hash: string): Promise<Uint8Array> {
    const bytes = await this.request<Uint8Array>("GET", ApiRoutes.blob(projectId, hash), { binary: true });
    const actual = sha256Hex(bytes);
    if (actual !== hash.toLowerCase()) {
      throw new ApiClientError("hash-mismatch", 200, `Blob ${hash} arrived with hash ${actual}.`);
    }
    return bytes;
  }

  // ------------------------------------------------------------ threads

  listThreads(docId: string): Promise<Thread[]> {
    return this.request("GET", ApiRoutes.threads(docId));
  }

  createThread(docId: string, body: CreateThreadRequest): Promise<Thread> {
    return this.request("POST", ApiRoutes.threads(docId), { body });
  }

  getThread(threadId: string): Promise<Thread> {
    return this.request("GET", ApiRoutes.thread(threadId));
  }

  deleteThread(threadId: string): Promise<void> {
    return this.request("DELETE", ApiRoutes.thread(threadId));
  }

  createMessage(threadId: string, body: CreateMessageRequest): Promise<ThreadMessage> {
    return this.request("POST", ApiRoutes.threadMessages(threadId), { body });
  }

  editMessage(messageId: string, body: EditMessageRequest): Promise<ThreadMessage> {
    return this.request("PATCH", ApiRoutes.message(messageId), { body });
  }

  deleteMessage(messageId: string): Promise<void> {
    return this.request("DELETE", ApiRoutes.message(messageId));
  }

  setThreadStatus(threadId: string, body: SetThreadStatusRequest): Promise<Thread> {
    return this.request("POST", ApiRoutes.threadStatus(threadId), { body });
  }

  reattachThread(threadId: string, body: ReattachThreadRequest): Promise<Thread> {
    return this.request("POST", ApiRoutes.threadReattach(threadId), { body });
  }

  // ------------------------------------------------------------ suggestions, revisions, reviews

  listSuggestions(docId: string): Promise<SuggestionInfo[]> {
    return this.request("GET", ApiRoutes.suggestions(docId));
  }

  decideSuggestions(docId: string, body: DecideSuggestionsRequest): Promise<DecideSuggestionsResponse> {
    return this.request("POST", ApiRoutes.suggestionDecisions(docId), { body });
  }

  revertSuggestion(suggestionId: string): Promise<RevertSuggestionResponse> {
    return this.request("POST", ApiRoutes.suggestionRevert(suggestionId));
  }

  listRevisions(docId: string): Promise<Revision[]> {
    return this.request("GET", ApiRoutes.revisions(docId));
  }

  createRevision(docId: string, body: CreateRevisionRequest): Promise<Revision> {
    return this.request("POST", ApiRoutes.revisions(docId), { body });
  }

  getRevisionContent(docId: string, revisionId: string): Promise<RevisionContent> {
    return this.request("GET", ApiRoutes.revisionContent(docId, revisionId));
  }

  restore(docId: string, body: RestoreRequest): Promise<RestoreResponse> {
    return this.request("POST", ApiRoutes.restore(docId), { body });
  }

  listReviews(docId: string): Promise<Review[]> {
    return this.request("GET", ApiRoutes.reviews(docId));
  }

  createReview(docId: string, body: CreateReviewRequest): Promise<Review> {
    return this.request("POST", ApiRoutes.reviews(docId), { body });
  }

  decideReview(reviewId: string, body: DecideReviewRequest): Promise<Review> {
    return this.request("POST", ApiRoutes.reviewDecision(reviewId), { body });
  }

  closeReview(reviewId: string): Promise<Review> {
    return this.request("POST", ApiRoutes.reviewClose(reviewId));
  }

  // ------------------------------------------------------------ notifications, audit, commands

  listNotifications(query: { unread?: boolean; before?: string; limit?: number } = {}): Promise<NotificationInfo[]> {
    return this.request("GET", ApiRoutes.notifications, { query });
  }

  markNotificationsRead(body: MarkNotificationsReadRequest): Promise<void> {
    return this.request("POST", ApiRoutes.notificationsRead, { body });
  }

  audit(projectId: string, query: { before?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    return this.request("GET", ApiRoutes.audit(projectId), { query });
  }

  /**
   * Replays an offline command. The server keys results on command.id, so a
   * resend returns the first result instead of applying the command again.
   */
  async postCommand(command: Command): Promise<CommandResult> {
    const result = await this.request<CommandResult | undefined>("POST", ApiRoutes.commands, { body: command });
    if (result && typeof result === "object" && typeof result.status === "number" && "body" in result) {
      return { id: result.id ?? command.id, status: result.status, body: result.body };
    }
    // A server that answers with the command's own result body.
    return { id: command.id, status: 200, body: result ?? null };
  }
}
