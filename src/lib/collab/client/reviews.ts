// Formal review on one shared document, for this window (plan M3.5).
//
// One controller per replica, like suggestions. It holds the document's
// reviews from the server (kept current by `review.changed` events and the
// replay of queued decisions), and the actions:
//
// - request: whole document, or a range anchored in the annotations doc (an
//   anchor of kind "review-scope"; the server adds the `reviewScopes` entry
//   naming it under the review id), so the scope follows edits like a
//   comment does;
// - decide: an assignee approves or requests changes, bound to the revision
//   they read (the review's base revision in checkpoint mode, else the
//   latest). Offline, the host queues it as a `review.decide` command and
//   the outcome comes back as `command-settled`;
// - close.
//
// The server decides who may do what and computes outdated approvals; the
// controller only mirrors its answers.

import { addAnchor } from "../anchors";
import {
  ControlRoutes,
  type AuditPage,
  type AuditQuery,
  type DecideReviewLocalRequest,
  type DecideReviewLocalResponse,
  type HostEvent,
} from "../local-api";
import type { CreateReviewRequest, Review, ReviewDecision } from "../protocol/api";
import { EventKind } from "../protocol/messages";
import { can, type Role } from "../protocol/roles";
import { subscribeHostEvents } from "../ui/bridge";
import { CollabClientError, collabClient, describeError, type CollabClient } from "../ui/client";
import type { CollabReplica } from "./replica";
import { getSharedDocRegistry, type SharedDocSession } from "./registry";

export interface ReviewsApi {
  list(docId: string): Promise<Review[]>;
  create(docId: string, body: CreateReviewRequest): Promise<Review>;
  decide(reviewId: string, body: DecideReviewLocalRequest): Promise<DecideReviewLocalResponse>;
  close(reviewId: string): Promise<Review>;
  audit(projectId: string, query?: AuditQuery): Promise<AuditPage>;
}

function queryString(query: AuditQuery = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function createReviewsApi(client: Pick<CollabClient, "request"> = collabClient): ReviewsApi {
  return {
    list: (docId) => client.request<Review[]>("GET", ControlRoutes.reviews(docId)),
    create: (docId, body) => client.request<Review>("POST", ControlRoutes.reviews(docId), body),
    decide: (reviewId, body) => client.request<DecideReviewLocalResponse>("POST", ControlRoutes.reviewDecision(reviewId), body),
    close: (reviewId) => client.request<Review>("POST", ControlRoutes.reviewClose(reviewId)),
    audit: (projectId, query) => client.request<AuditPage>("GET", `${ControlRoutes.audit(projectId)}${queryString(query)}`),
  };
}

export interface PendingReviewDecision {
  decision: Exclude<ReviewDecision, "pending">;
  /** "queued": offline; the host sends it when it can reach the server. */
  phase: "sending" | "queued";
  commandId: string;
}

export interface ReviewsSnapshot {
  docId: string;
  /** Newest first; null until the first load. */
  reviews: Review[] | null;
  error: string | null;
  /** This account's decisions that the server has not confirmed yet, by review id. */
  pending: Record<string, PendingReviewDecision>;
  /** A decision the server refused, by review id. */
  failed: Record<string, string>;
  localUserId: string | null;
  canRequest: boolean;
}

export interface RequestReviewInput {
  /** Source offsets in the live text; omit for the whole document. */
  range?: { start: number; end: number };
  assignees: string[];
  note?: string;
}

export interface ReviewsControllerOptions {
  api?: ReviewsApi;
  subscribeEvents?: (listener: (event: HostEvent) => void) => () => void;
  /** The signed-in account (the registry's presence user in the app). */
  localUserId?: () => string | null;
  newId?: (prefix: string) => string;
}

/** How long a range-scoped request waits for its anchor to reach the server. */
const ANCHOR_SYNC_MS = 5_000;

function randomId(prefix: string): string {
  const bytes = new Uint8Array(15);
  globalThis.crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return `${prefix}_${text}`;
}

function isReview(value: unknown): value is Review {
  return !!value && typeof value === "object" && typeof (value as Review).id === "string" && Array.isArray((value as Review).assignments);
}

export class ReviewsController {
  readonly docId: string;
  private readonly session: SharedDocSession;
  private readonly replica: CollabReplica;
  private readonly api: ReviewsApi;
  private readonly localUserId: () => string | null;
  private readonly newId: (prefix: string) => string;
  private readonly listeners = new Set<() => void>();
  private reviews: Review[] | null = null;
  private error: string | null = null;
  private pending: Record<string, PendingReviewDecision> = {};
  private failed: Record<string, string> = {};
  private readonly commands = new Map<string, string>();
  private snapshot: ReviewsSnapshot | null = null;
  private loading: Promise<void> | null = null;
  private readonly stopEvents: () => void;
  private destroyed = false;

  constructor(session: SharedDocSession, options: ReviewsControllerOptions = {}) {
    this.session = session;
    this.replica = session.replica;
    this.docId = session.docId;
    this.api = options.api ?? createReviewsApi();
    this.localUserId = options.localUserId ?? (() => getSharedDocRegistry().localUser.userId ?? null);
    this.newId = options.newId ?? randomId;
    this.stopEvents = (options.subscribeEvents ?? subscribeHostEvents)((event) => this.onHostEvent(event));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ReviewsSnapshot => {
    this.snapshot ??= {
      docId: this.docId,
      reviews: this.reviews,
      error: this.error,
      pending: this.pending,
      failed: this.failed,
      localUserId: this.localUserId(),
      canRequest: can(this.role, "request-review"),
    };
    return this.snapshot;
  };

  get role(): Role {
    return this.replica.getSnapshot().meta?.role ?? this.session.resolved.role;
  }

  private changed() {
    this.snapshot = null;
    if (this.destroyed) return;
    for (const listener of [...this.listeners]) listener();
  }

  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const reviews = await this.api.list(this.docId);
        this.reviews = [...reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        this.error = null;
      } catch (error) {
        this.error = describeError(error);
      } finally {
        this.loading = null;
        this.changed();
      }
    })();
    return this.loading;
  }

  review(reviewId: string): Review | null {
    return this.reviews?.find((review) => review.id === reviewId) ?? null;
  }

  private upsert(review: Review) {
    if (review.docId !== this.docId) return;
    const list = (this.reviews ?? []).filter((item) => item.id !== review.id);
    this.reviews = [review, ...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private onHostEvent(event: HostEvent) {
    if (this.destroyed) return;
    if (event.t === "server-event" && event.kind === EventKind.ReviewChanged) {
      const review = (event.payload as { review?: unknown } | null)?.review;
      if (isReview(review) && review.docId === this.docId) { this.upsert(review); this.changed(); }
      return;
    }
    if (event.t === "command-settled" && event.kind === "review.decide") {
      const reviewId = this.commands.get(event.id);
      if (!reviewId) return;
      this.settle(reviewId, event.id, event.ok, event.body, event.error?.message ?? `The server refused this (${event.status}).`);
      return;
    }
    if (event.t === "status" && event.status.connection === "connected" && (this.error || !this.reviews)) void this.load();
  }

  private settle(reviewId: string, commandId: string, ok: boolean, body: unknown, error: string) {
    this.commands.delete(commandId);
    if (this.pending[reviewId]?.commandId === commandId) {
      const { [reviewId]: _settled, ...rest } = this.pending;
      void _settled;
      this.pending = rest;
    }
    if (ok && isReview(body)) this.upsert(body);
    if (!ok) this.failed = { ...this.failed, [reviewId]: error };
    this.changed();
  }

  /** Requests a review (editors and owners). A range scope is anchored first, so it syncs even before the server answers. */
  async request(input: RequestReviewInput): Promise<Review> {
    const me = this.localUserId();
    if (!me) throw new Error("Sign in to your collaboration account to request a review.");
    if (!can(this.role, "request-review")) throw new Error("Only editors and owners can request a review.");
    const assignees = [...new Set(input.assignees)].filter(Boolean);
    if (!assignees.length) throw new Error("Pick at least one reviewer.");
    const note = input.note?.trim();
    let scope: CreateReviewRequest["scope"] = { kind: "document" };
    let anchorId: string | null = null;
    if (input.range) {
      const ytext = this.replica.ytext;
      const { start, end } = input.range;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > ytext.length) throw new Error("Select the passage to review first.");
      anchorId = this.newId("anc");
      addAnchor(this.replica.annotations, ytext, start, end, { id: anchorId, kind: "review-scope", createdBy: me });
      scope = { kind: "range", anchorId, quote: ytext.toString().slice(start, end) };
    }
    // The server resolves a range scope through its anchor, so the anchor
    // must have reached it first.
    if (anchorId) await this.whenSynced(ANCHOR_SYNC_MS);
    let review: Review;
    for (let attempt = 0; ; attempt++) {
      try {
        review = await this.api.create(this.docId, { scope, assignees, ...(note ? { note } : {}) });
        break;
      } catch (error) {
        // Acknowledged by the host but not yet applied in the server's room.
        const anchorMissing = error instanceof CollabClientError && error.status === 400 && /anchor/i.test(error.serverMessage ?? "");
        if (!anchorMissing || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    this.upsert(review);
    this.changed();
    return review;
  }

  /** Resolves when the replica has nothing waiting for the server (or after `timeoutMs`). */
  private whenSynced(timeoutMs: number): Promise<void> {
    const idle = () => { const status = this.replica.getSnapshot().status; return !status || (status.pending === 0 && status.connected); };
    if (idle()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); off(); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      const off = this.replica.subscribe(() => { if (idle()) done(); });
    });
  }

  /**
   * An assignee's decision. `revisionId` binds it to the revision they read
   * (checkpoint mode passes the review's base revision); without it the
   * server uses the latest. Resolves once the host answered: decided, or
   * queued for the replay.
   */
  async decide(reviewId: string, decision: Exclude<ReviewDecision, "pending">, options: { revisionId?: string; comment?: string } = {}): Promise<{ queued: boolean; review?: Review }> {
    const commandId = this.newId("cmd");
    this.pending = { ...this.pending, [reviewId]: { decision, phase: "sending", commandId } };
    const { [reviewId]: _cleared, ...failed } = this.failed;
    void _cleared;
    this.failed = failed;
    this.commands.set(commandId, reviewId);
    this.changed();
    try {
      const response = await this.api.decide(reviewId, { decision, commandId, ...(options.revisionId ? { revisionId: options.revisionId } : {}), ...(options.comment?.trim() ? { comment: options.comment.trim() } : {}) });
      if (response.queued) {
        if (this.pending[reviewId]?.commandId === commandId) this.pending = { ...this.pending, [reviewId]: { decision, phase: "queued", commandId } };
        this.changed();
        return { queued: true };
      }
      this.settle(reviewId, commandId, true, response.review, "");
      return { queued: false, review: response.review };
    } catch (error) {
      this.settle(reviewId, commandId, false, null, describeError(error));
      throw error;
    }
  }

  async close(reviewId: string): Promise<Review> {
    const review = await this.api.close(reviewId);
    this.upsert(review);
    this.changed();
    return review;
  }

  destroy() {
    this.destroyed = true;
    this.stopEvents();
    this.listeners.clear();
    controllers.delete(this.replica);
  }
}

const controllers = new WeakMap<CollabReplica, ReviewsController>();
let defaultOptions: ReviewsControllerOptions = {};

/** The reviews controller of a session's document in this window. */
export function reviewsFor(session: SharedDocSession, options?: ReviewsControllerOptions): ReviewsController {
  let controller = controllers.get(session.replica);
  if (!controller || session.replica.isDestroyed) {
    controller = new ReviewsController(session, { ...defaultOptions, ...options });
    controllers.set(session.replica, controller);
  }
  return controller;
}

/** Options for controllers created from now on (tests: a direct control-API client). */
export function setReviewsDefaults(options: ReviewsControllerOptions): void {
  defaultOptions = options;
}

// ---- Opening a review from elsewhere (a notification, a link)

export interface ReviewOpenRequest {
  docId: string;
  reviewId: string;
  /** Bumped on each request, so asking twice opens it twice. */
  seq: number;
}

let openRequest: ReviewOpenRequest | null = null;
let openSeq = 0;
const openListeners = new Set<() => void>();

/** Asks the window to show a review: the Comments rail's Reviews tab, in checkpoint mode for an assignee. */
export function requestOpenReview(docId: string, reviewId: string): void {
  openRequest = { docId, reviewId, seq: ++openSeq };
  for (const listener of [...openListeners]) listener();
}

export function pendingReviewOpen(): ReviewOpenRequest | null {
  return openRequest;
}

/** Marks a request handled (the Reviews tab showed it). */
export function consumeReviewOpen(seq: number): void {
  if (openRequest?.seq === seq) {
    openRequest = null;
    for (const listener of [...openListeners]) listener();
  }
}

export function subscribeReviewOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => { openListeners.delete(listener); };
}
