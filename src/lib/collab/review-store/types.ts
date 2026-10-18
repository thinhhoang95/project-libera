// The review store seam (plan M2.1): what Review Mode needs from wherever
// comments live. Extracted from markdown-review-context.tsx's calls:
//
//   load → comment / reply / edit / resolve / reattach / delete, plus
//   subscribe for changes made elsewhere.
//
// LocalReviewStore keeps today's behaviour (`/api/markdown-reviews`, one JSON
// file per library). SharedReviewStore keeps anchors in the shared
// document's annotations and threads on the collab server. Both hand the UI a
// ReviewDocument, so the panel, the popover and the editor highlights are the
// same code for either; shared threads carry extra fields (`shared`) for
// authors, pending chips and detached anchors.

import type { ReviewDocument, ReviewMessage, ReviewRange, ReviewThread } from "@/lib/markdown-review";
import type { Actor } from "../protocol/actor";
import type { ThreadStatus, UserSummary } from "../protocol/api";
import type { Role } from "../protocol/roles";

export interface CommentInput {
  range: ReviewRange;
  text: string;
  /** User ids picked with @ (shared documents only). */
  mentions?: string[];
}

export interface ReplyInput {
  threadId: string;
  text: string;
  mentions?: string[];
}

export interface EditInput {
  threadId: string;
  messageId: string;
  text: string;
  mentions?: string[];
}

export interface ResolveInput {
  threadId: string;
  resolved: boolean;
}

export interface ReattachInput {
  threadId: string;
  range: ReviewRange;
}

export interface DeleteInput {
  threadId: string;
}

export interface ReviewStore {
  readonly kind: "local" | "shared";
  load(): Promise<ReviewDocument>;
  comment(input: CommentInput): Promise<ReviewDocument>;
  reply(input: ReplyInput): Promise<ReviewDocument>;
  edit(input: EditInput): Promise<ReviewDocument>;
  resolve(input: ResolveInput): Promise<ReviewDocument>;
  reattach(input: ReattachInput): Promise<ReviewDocument>;
  delete(input: DeleteInput): Promise<ReviewDocument>;
  /** Called with the new document after every change, including ones made in other windows. */
  subscribe(listener: (doc: ReviewDocument) => void): () => void;
}

/** Where an unsent command stands. */
export type DeliveryState = "sending" | "queued" | "failed";

export interface PendingInfo {
  commandId: string;
  state: DeliveryState;
  /** Why the server refused it (state "failed"). */
  error: string | null;
}

export interface SharedMessageInfo {
  author: UserSummary;
  actor: Actor | null;
  mentions: string[];
  editedAt: string | null;
  deleted: boolean;
  /** Set while a create, edit or delete of this message is not confirmed by the server. */
  pending: PendingInfo | null;
  mine: boolean;
  /** Only your own messages can be edited. */
  canEdit: boolean;
  /** Your own messages, or anyone's for the notebook's owner (the server's rule). */
  canDelete: boolean;
}

export type DetachReason = "deleted" | "unresolvable" | "missing";

export interface SharedThreadInfo {
  docId: string;
  anchorId: string;
  /** The server's status (or the one being sent). */
  status: ThreadStatus;
  /** The anchored text was deleted, or the anchor cannot be found. */
  detached: boolean;
  detachReason: DetachReason | null;
  /** Where the anchor collapsed, to rank reattach candidates near it. */
  collapsedAt: number | null;
  createdBy: UserSummary;
  actor: Actor | null;
  resolvedBy: UserSummary | null;
  createdAt: string;
  /** Set while the thread itself (create, status, reattach, delete) is not confirmed. */
  pending: PendingInfo | null;
  /** Resolve, reattach and delete: the thread's author, or an editor or owner. */
  canManage: boolean;
}

export type SharedReviewMessage = ReviewMessage & { shared: SharedMessageInfo };
export type SharedReviewThread = Omit<ReviewThread, "messages"> & { messages: SharedReviewMessage[]; shared: SharedThreadInfo };

/** What a shared store publishes: threads projected onto the live text. */
export interface SharedReviewProjection {
  docId: string;
  projectId: string;
  key: string;
  /** The live shared text the anchors were resolved against. */
  text: string;
  threads: SharedReviewThread[];
  loaded: boolean;
  /** Loading the thread list failed (offline with nothing cached, say). */
  error: string;
  role: Role;
  me: UserSummary | null;
  /** Bumped on every change, like ReviewDocument.revision. */
  revision: number;
}

export function isSharedThread(thread: ReviewThread): thread is SharedReviewThread {
  return "shared" in thread && !!(thread as { shared?: unknown }).shared;
}

export function isSharedMessage(message: ReviewMessage): message is SharedReviewMessage {
  return "shared" in message && !!(message as { shared?: unknown }).shared;
}

/** The base ReviewDocument a shared projection is presented as (agentic-review fields come from the local document). */
export function sharedReviewDocument(projection: SharedReviewProjection, base?: ReviewDocument | null): ReviewDocument {
  return {
    schemaVersion: 1,
    id: base?.id ?? `shared:${projection.docId}`,
    key: base?.key ?? projection.key,
    revision: base?.revision ?? projection.revision,
    enabled: base?.enabled ?? false,
    undo: base?.undo ?? [],
    ...(base?.redo ? { redo: base.redo } : {}),
    ...(base?.session ? { session: base.session } : {}),
    ...(base?.round !== undefined ? { round: base.round } : {}),
    ...(base?.previousRounds ? { previousRounds: base.previousRounds } : {}),
    snapshot: projection.text,
    threads: projection.threads,
  };
}
