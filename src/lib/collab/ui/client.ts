// Typed client for the local collaboration API (`/api/collab/*`, which the
// Next server forwards one to one to the collab host's control routes).
//
// Response shapes follow the host's server-side counterparts: lists are JSON
// arrays, a 204 resolves to undefined. Errors arrive as
// `{ error: { code, message } }` and become CollabClientError, whose message is
// already worded for the UI (see errorMessage).

import {
  ControlRoutes,
  LOCAL_API_PREFIX,
  type ApplyEditsRequest,
  type ApplyEditsResponse,
  type CreateSuggestionsRequest,
  type CreateSuggestionsResponse,
  type DocText,
  type FileOpRequest,
  type HostStatus,
  type Invitation,
  type InviteRequest,
  type JoinProjectRequest,
  type LocalAccount,
  type LocalProject,
  type MarkNotificationsReadRequest,
  type Member,
  type NotificationInfo,
  type NotificationsQuery,
  type Reconciliation,
  type RegisterLocalRequest,
  type ResolveReconciliationRequest,
  type ResolvedDoc,
  type ShareNotebookRequest,
  type SignInRequest,
  type UpdateAccountRequest,
} from "@/lib/collab/local-api";
import type { Role } from "@/lib/collab/protocol/roles";

/** Codes the local routes add on top of the server's ApiErrorCode. */
export const COLLAB_DISABLED = "collab-disabled";
export const NETWORK_ERROR = "network";

export class CollabClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The message the server or host sent, before rewording. */
    readonly serverMessage?: string,
  ) {
    super(message);
    this.name = "CollabClientError";
  }
}

/** True when the local routes say collaboration is off on this device (or do not exist). */
export function isCollabDisabledError(error: unknown): boolean {
  return (
    error instanceof CollabClientError &&
    (error.code === COLLAB_DISABLED || (error.status === 404 && error.code === "route-missing"))
  );
}

const MESSAGES: Record<string, string> = {
  [COLLAB_DISABLED]: "Collaboration is not enabled on this device.",
  [NETWORK_ERROR]: "Libera could not reach its collaboration service. Try again in a moment.",
  "bad-request": "Some of the details are not valid. Check them and try again.",
  unauthorized: "The email or password is not correct.",
  "token-expired": "Your session expired. Sign in again to keep syncing.",
  forbidden: "You do not have permission to do that in this notebook.",
  "not-found": "That item no longer exists.",
  conflict: "Someone changed this at the same time. Try again.",
  "rate-limited": "Too many attempts. Wait a minute and try again.",
  "too-large": "That is too large to share.",
  "invalid-invitation": "This invitation link is not valid, has expired, or was already used.",
  "email-taken": "An account with this email already exists. Sign in instead.",
  "signup-disabled": "This server only accepts new accounts with a registration code from its administrator.",
  "invalid-registration-code": "That registration code is not valid, has expired, or has been used up. Ask the server administrator for a new one.",
  "client-too-old": "This version of Libera is too old for the server. Update Libera to keep syncing.",
  "ai-cannot-decide": "AI features cannot take this action.",
  "host-unavailable": "The collaboration service on this device is not running. Restart Libera.",
  "not-signed-in": "Sign in to a collaboration account first.",
  internal: "Something went wrong on the server. Try again later.",
};

/** UI wording for an error code; falls back to the server's message. */
export function errorMessage(code: string, serverMessage?: string, status?: number): string {
  if (MESSAGES[code]) {
    return MESSAGES[code];
  }
  if (serverMessage) {
    return serverMessage;
  }
  if (status && status >= 500) {
    return MESSAGES.internal;
  }
  return "The request failed.";
}

/** Error text for anything a client call threw. */
export function describeError(error: unknown): string {
  if (error instanceof CollabClientError) {
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : "The request failed.";
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CollabClientOptions {
  /** Defaults to the global fetch, looked up per call so tests can replace it. */
  fetch?: FetchLike;
  /** Defaults to LOCAL_API_PREFIX. */
  prefix?: string;
}

function queryString(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function createCollabClient(options: CollabClientOptions = {}) {
  const prefix = options.prefix ?? LOCAL_API_PREFIX;

  async function request<T>(method: Method, route: string, body?: unknown): Promise<T> {
    const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
    let response: Response;
    try {
      response = await fetchImpl(`${prefix}${route}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new CollabClientError(0, NETWORK_ERROR, MESSAGES[NETWORK_ERROR], error instanceof Error ? error.message : undefined);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text().catch(() => "");
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }

    if (!response.ok) {
      const error = (payload as { error?: unknown } | undefined)?.error;
      // The server and host send { error: { code, message } }; other Libera
      // routes send { error: "message" }. A 404 without a body means the
      // local routes are not there at all (a web build without collaboration).
      const code =
        error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : response.status === 404 && !error
            ? "route-missing"
            : response.status === 503
              ? "host-unavailable"
              : `http-${response.status}`;
      const serverMessage =
        error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : typeof error === "string"
            ? error
            : undefined;
      throw new CollabClientError(response.status, code, errorMessage(code, serverMessage, response.status), serverMessage);
    }

    return payload as T;
  }

  return {
    request,

    // ---------------------------------------------------------------- account
    status: () => request<HostStatus>("GET", ControlRoutes.status),
    signIn: (body: SignInRequest) => request<HostStatus | undefined>("POST", ControlRoutes.signIn, body),
    register: (body: RegisterLocalRequest) => request<HostStatus | undefined>("POST", ControlRoutes.register, body),
    signOut: () => request<void>("POST", ControlRoutes.signOut),
    account: () => request<LocalAccount | null>("GET", ControlRoutes.account),
    updateAccount: (body: UpdateAccountRequest) => request<LocalAccount | undefined>("PATCH", ControlRoutes.account, body),

    // ---------------------------------------------------------------- projects
    projects: () => request<LocalProject[]>("GET", ControlRoutes.projects),
    deleteProject: (projectId: string) => request<void>("DELETE", ControlRoutes.project(projectId)),
    share: (body: ShareNotebookRequest) => request<LocalProject | undefined>("POST", ControlRoutes.share, body),
    join: (body: JoinProjectRequest) => request<LocalProject | undefined>("POST", ControlRoutes.join, body),
    members: (projectId: string) => request<Member[]>("GET", ControlRoutes.members(projectId)),
    changeRole: (projectId: string, userId: string, role: Role) =>
      request<Member | undefined>("PATCH", ControlRoutes.member(projectId, userId), { role }),
    removeMember: (projectId: string, userId: string) => request<void>("DELETE", ControlRoutes.member(projectId, userId)),
    invitations: (projectId: string) => request<Invitation[]>("GET", ControlRoutes.invitations(projectId)),
    invite: (projectId: string, body: InviteRequest) => request<Invitation>("POST", ControlRoutes.invitations(projectId), body),
    revokeInvitation: (projectId: string, invitationId: string) =>
      request<void>("DELETE", ControlRoutes.invitation(projectId, invitationId)),
    leave: (projectId: string) => request<void>("POST", ControlRoutes.leave(projectId)),
    fileOp: (projectId: string, body: FileOpRequest) => request<unknown>("POST", ControlRoutes.files(projectId), body),

    // ---------------------------------------------------------------- documents
    resolve: (path: string) => request<ResolvedDoc | null>("GET", `${ControlRoutes.resolve}${queryString({ path })}`),
    doc: (docId: string) => request<ResolvedDoc>("GET", ControlRoutes.doc(docId)),
    docText: (docId: string) => request<DocText>("GET", ControlRoutes.docText(docId)),
    applyEdits: (docId: string, body: ApplyEditsRequest) => request<ApplyEditsResponse>("POST", ControlRoutes.docEdits(docId), body),
    createSuggestions: (docId: string, body: CreateSuggestionsRequest) =>
      request<CreateSuggestionsResponse>("POST", ControlRoutes.docSuggestions(docId), body),

    // ---------------------------------------------------------------- reconciliation
    reconciliations: () => request<Reconciliation[]>("GET", ControlRoutes.reconciliations),
    resolveReconciliation: (id: string, body: ResolveReconciliationRequest) =>
      request<void>("POST", ControlRoutes.reconciliation(id), body),

    // ---------------------------------------------------------------- notifications
    notifications: (query: NotificationsQuery = {}) =>
      request<NotificationInfo[]>("GET", `${ControlRoutes.notifications}${queryString({ ...query })}`),
    markNotificationsRead: (body: MarkNotificationsReadRequest) => request<void>("POST", ControlRoutes.notificationsRead, body),
  };
}

export type CollabClient = ReturnType<typeof createCollabClient>;

/** The client the UI uses; it calls the global fetch at request time. */
export const collabClient: CollabClient = createCollabClient();
