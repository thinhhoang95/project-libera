// Thread calls on the local collaboration API (`/api/collab/*` → the host's
// control routes → the server). Kept apart from SharedReviewStore so tests
// can hand the store a client that talks to a real host directly.

import {
  ControlRoutes,
  type CommandsState,
  type EnqueueCommandResponse,
  type LocalCommentsSummary,
  type MigrateCommentsResponse,
} from "../local-api";
import type {
  Command,
  CreateMessageRequest,
  CreateThreadRequest,
  EditMessageRequest,
  ReattachThreadRequest,
  SetThreadStatusRequest,
  Thread,
  ThreadMessage,
} from "../protocol/api";
import { CollabClientError, collabClient, type CollabClient } from "../ui/client";

export interface ThreadApi {
  list(docId: string): Promise<Thread[]>;
  createThread(docId: string, body: CreateThreadRequest): Promise<Thread>;
  addMessage(threadId: string, body: CreateMessageRequest): Promise<ThreadMessage>;
  editMessage(messageId: string, body: EditMessageRequest): Promise<ThreadMessage>;
  deleteMessage(messageId: string): Promise<void>;
  setStatus(threadId: string, body: SetThreadStatusRequest): Promise<Thread>;
  reattach(threadId: string, body: ReattachThreadRequest): Promise<Thread>;
  deleteThread(threadId: string): Promise<void>;
  /** Queues a command in the host's pending_commands (offline path). */
  enqueue(command: Command): Promise<EnqueueCommandResponse>;
  commands(): Promise<CommandsState>;
  /** Forgets a refused command on the host. */
  discard(commandId: string): Promise<void>;
}

type Request = CollabClient["request"];

export function createThreadApi(request: Request = collabClient.request): ThreadApi {
  return {
    list: (docId) => request<Thread[]>("GET", ControlRoutes.threads(docId)),
    createThread: (docId, body) => request<Thread>("POST", ControlRoutes.threads(docId), body),
    addMessage: (threadId, body) => request<ThreadMessage>("POST", ControlRoutes.threadMessages(threadId), body),
    editMessage: (messageId, body) => request<ThreadMessage>("PATCH", ControlRoutes.message(messageId), body),
    deleteMessage: (messageId) => request<void>("DELETE", ControlRoutes.message(messageId)),
    setStatus: (threadId, body) => request<Thread>("POST", ControlRoutes.threadStatus(threadId), body),
    reattach: (threadId, body) => request<Thread>("POST", ControlRoutes.threadReattach(threadId), body),
    deleteThread: (threadId) => request<void>("DELETE", ControlRoutes.thread(threadId)),
    enqueue: (command) => request<EnqueueCommandResponse>("POST", ControlRoutes.commands, command),
    commands: () => request<CommandsState>("GET", ControlRoutes.commands),
    discard: (commandId) => request<void>("DELETE", ControlRoutes.command(commandId)),
  };
}

export const threadApi: ThreadApi = createThreadApi();

/** Local comments that could move to a shared notebook, and the move itself (owner only). */
export function localCommentsSummary(projectId: string, request: Request = collabClient.request): Promise<LocalCommentsSummary> {
  return request<LocalCommentsSummary>("GET", ControlRoutes.migrateComments(projectId));
}

export function migrateLocalComments(projectId: string, request: Request = collabClient.request): Promise<MigrateCommentsResponse> {
  return request<MigrateCommentsResponse>("POST", ControlRoutes.migrateComments(projectId));
}

/**
 * Whether a failed direct call should be retried through the offline queue:
 * the server or the network was unreachable, or the session needs a new
 * sign-in. Refusals (403, 404, 400) are answers and are shown instead.
 */
export function isQueueableError(error: unknown): boolean {
  if (!(error instanceof CollabClientError)) return false;
  if (error.code === "host-unavailable" || error.code === "collab-disabled" || error.code === "collab-host-auth") return false;
  if (error.code === "network" || error.code === "offline" || error.code === "needs-sign-in") return true;
  return error.status === 0 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504 || error.status === 408 || error.status === 429;
}
