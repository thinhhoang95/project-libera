// The shared review store (plan M2.1, M2.2, M2.6, map §7.4).
//
// A comment on a shared document has two halves:
//
// - the anchor, two RelativePositions in the document's `annotations`
//   sub-document (anchors.ts). It is written in the replica at once and syncs
//   through the CRDT like text, online or not, and it follows concurrent
//   edits without offset mapping;
// - the thread (quote, messages, status) on the collab server, reached
//   through the host's control routes and kept current by the `thread.changed`
//   and `thread.deleted` events the host forwards.
//
// Writes are optimistic: each is a Command with a client-chosen id, shown at
// once with a "pending" chip, sent directly while online and queued in the
// host's pending_commands otherwise (or when the direct call fails for lack
// of a network). The id makes a replay harmless, so a request that reached
// the server just before the network dropped is not applied twice. The chip
// goes when the server confirms (the direct response, or the host's
// `command-settled` event); a refusal leaves the card with Retry and Discard.
//
// The projection resolves every anchor against the live Y.Text, so the
// panel and the editor highlights see positions that already include
// everyone's edits. A thread whose text was deleted is detached: the store
// tells the server (status `detached`) when it may change the thread, and
// back to `open` when an undo brings the text back.

import * as Y from "yjs";
import { addAnchor, findReattachCandidates, readAnchor, removeAnchor, resolveAnchor, type ReattachCandidate } from "../anchors";
import type { HostEvent } from "../local-api";
import type { Command, Thread, ThreadMessage, ThreadStatus, UserSummary } from "../protocol/api";
import { EventKind } from "../protocol/messages";
import { roleAtLeast, type Role } from "../protocol/roles";
import { AnnotationKeys } from "../protocol/schema";
import { subscribeHostEvents } from "../ui/bridge";
import { describeError } from "../ui/client";
import type { ReviewAnchor, ReviewDocument, ReviewRange } from "@/lib/markdown-review";
import { isQueueableError, threadApi, type ThreadApi } from "./api";
import {
  sharedReviewDocument,
  type CommentInput,
  type DeleteInput,
  type DeliveryState,
  type EditInput,
  type PendingInfo,
  type ReattachInput,
  type ReplyInput,
  type ResolveInput,
  type ReviewStore,
  type SharedReviewMessage,
  type SharedReviewProjection,
  type SharedReviewThread,
} from "./types";

/** The replica surface the store needs (CollabReplica has it). */
export interface SharedReplicaLike {
  readonly annotations: Y.Doc;
  readonly ytext: Y.Text;
  onRebuild(listener: (subdoc: string) => void): () => void;
}

export interface SharedReviewStoreOptions {
  docId: string;
  projectId: string;
  /** The tab's Libera path (the ReviewDocument key). */
  key: string;
  replica: SharedReplicaLike;
  /** The signed-in account, or null (comments then need a sign-in). */
  me: () => UserSummary | null;
  /** The account's role in the notebook. */
  role: () => Role;
  /** Whether the host is connected to the server; offline writes go to the queue. */
  online: () => boolean;
  api?: ThreadApi;
  subscribeEvents?: (listener: (event: HostEvent) => void) => () => void;
  newId?: (prefix: "thr" | "msg" | "anc" | "cmd") => string;
  /** Coalesces projection rebuilds; defaults to a microtask. */
  schedule?: (run: () => void) => void;
  /** How long an anchor must stay deleted before the server is told it is detached. */
  detachDelayMs?: number;
}

/** Origin of the store's own annotation writes, so its observer knows them. */
export const SHARED_REVIEW_ORIGIN = "libera-collab:shared-review";

interface PendingOp {
  command: Command;
  state: DeliveryState;
  error: string | null;
  createdAt: string;
  /** Bookkeeping commands (automatic detach status): no chip, failures dropped. */
  silent?: boolean;
  /** An anchor to remove from annotations once the command succeeds. */
  removeAnchorOnSuccess?: string;
  /** The anchor the command wrote first (removed again when it is discarded). */
  wroteAnchor?: string;
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(15);
  globalThis.crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return `${prefix}_${text}`;
}

function cloneThread(thread: Thread): Thread {
  return { ...thread, messages: thread.messages.map((message) => ({ ...message })) };
}

function threadIdOf(command: Command): string | null {
  switch (command.kind) {
    case "thread.create":
      return command.body.id;
    case "message.create":
    case "thread.status":
    case "thread.reattach":
    case "thread.delete":
      return command.threadId;
    default:
      return null;
  }
}

const CONTEXT = 80;
const DEFAULT_DETACH_DELAY_MS = 1_500;

export class SharedReviewStore implements ReviewStore {
  readonly kind = "shared" as const;
  readonly docId: string;
  private readonly options: SharedReviewStoreOptions;
  private readonly api: ThreadApi;
  private readonly newId: (prefix: "thr" | "msg" | "anc" | "cmd") => string;
  private readonly schedule: (run: () => void) => void;
  private readonly detachDelayMs: number;
  private readonly server = new Map<string, Thread>();
  private ops: PendingOp[] = [];
  private readonly listeners = new Set<(doc: ReviewDocument) => void>();
  private readonly projectionListeners = new Set<(projection: SharedReviewProjection) => void>();
  private projection: SharedReviewProjection;
  private loaded = false;
  private loadError = "";
  private loading: Promise<void> | null = null;
  private scheduled = false;
  private destroyed = false;
  private readonly cleanup: Array<() => void> = [];
  private unobserve: Array<() => void> = [];
  /** Automatic status changes already asked for, so a detached thread is reported once. */
  private readonly autoStatus = new Map<string, { status: ThreadStatus; timer: ReturnType<typeof setTimeout> | null }>();
  private settledWaiters: Array<() => void> = [];
  private lastCreated: string | null = null;

  constructor(options: SharedReviewStoreOptions) {
    this.options = options;
    this.docId = options.docId;
    this.api = options.api ?? threadApi;
    this.newId = options.newId ?? randomId;
    this.schedule = options.schedule ?? queueMicrotask;
    this.detachDelayMs = options.detachDelayMs ?? DEFAULT_DETACH_DELAY_MS;
    this.projection = this.build();
    this.observe();
    this.cleanup.push(
      options.replica.onRebuild(() => {
        // A rejected update replaced a Y.Doc; observe the new one.
        this.observe();
        this.changed();
      }),
      (options.subscribeEvents ?? subscribeHostEvents)((event) => this.onHostEvent(event)),
    );
  }

  /* ---- Reading ----------------------------------------------------------------- */

  getProjection = (): SharedReviewProjection => this.projection;

  /** The projection as a ReviewDocument (the agentic-review fields of `base` are kept). */
  document(base?: ReviewDocument | null): ReviewDocument {
    return sharedReviewDocument(this.projection, base);
  }

  subscribe(listener: (doc: ReviewDocument) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Like subscribe, with the projection itself. */
  subscribeProjection(listener: (projection: SharedReviewProjection) => void): () => void {
    this.projectionListeners.add(listener);
    return () => { this.projectionListeners.delete(listener); };
  }

  /** Resolves when no command of this store is still being sent directly. */
  async idle(): Promise<void> {
    while (this.ops.some((op) => op.state === "sending")) {
      await new Promise<void>((resolve) => this.settledWaiters.push(resolve));
    }
  }

  /** Where a detached thread could be reattached: the quote found in the current text, best first. */
  reattachCandidates(threadId: string, limit = 3): ReattachCandidate[] {
    const thread = this.projection.threads.find((item) => item.id === threadId);
    if (!thread) return [];
    return findReattachCandidates(this.projection.text, thread.anchor.quote, { near: thread.shared.collapsedAt ?? undefined }, limit);
  }

  /* ---- Loading ----------------------------------------------------------------- */

  load(): Promise<ReviewDocument> {
    this.loading ??= this.fetchAll().finally(() => { this.loading = null; });
    return this.loading.then(() => this.document());
  }

  private async fetchAll(): Promise<void> {
    try {
      const threads = await this.api.list(this.docId);
      if (this.destroyed) return;
      this.server.clear();
      for (const thread of threads) if (thread.docId === this.docId) this.server.set(thread.id, thread);
      this.loaded = true;
      this.loadError = "";
    } catch (error) {
      if (this.destroyed) return;
      // Offline with nothing fetched yet: pending local comments still show.
      this.loadError = this.loaded ? "" : describeError(error);
    }
    await this.adoptQueuedCommands();
    this.changed();
  }

  /** Rebuilds pending chips for commands queued by an earlier window (or before a reload). */
  private async adoptQueuedCommands(): Promise<void> {
    let state;
    try {
      state = await this.api.commands();
    } catch {
      return;
    }
    if (this.destroyed) return;
    const known = new Set(this.ops.map((op) => op.command.id));
    const entries = [
      ...state.pending.map((entry) => ({ command: entry.command, state: "queued" as const, error: null })),
      ...state.failed.map((entry) => ({ command: entry.command, state: "failed" as const, error: entry.error.message })),
    ];
    for (const entry of entries) {
      if (known.has(entry.command.id) || !this.ownsCommand(entry.command)) continue;
      this.ops.push({ command: entry.command, state: entry.state, error: entry.error, createdAt: new Date().toISOString() });
    }
  }

  private ownsCommand(command: Command): boolean {
    if (command.kind === "thread.create") return command.docId === this.docId;
    if (command.kind === "message.edit" || command.kind === "message.delete") {
      return this.findMessage(command.messageId) !== null;
    }
    const threadId = threadIdOf(command);
    return threadId !== null && (this.server.has(threadId) || this.ops.some((op) => op.command.kind === "thread.create" && op.command.body.id === threadId));
  }

  private findMessage(messageId: string): { thread: Thread; message: ThreadMessage } | null {
    for (const thread of this.server.values()) {
      const message = thread.messages.find((item) => item.id === messageId);
      if (message) return { thread, message };
    }
    for (const op of this.ops) {
      if (op.command.kind === "message.create" && op.command.body.id === messageId) {
        const thread = this.server.get(op.command.threadId);
        if (thread) return { thread, message: this.syntheticMessage(op.command.body.id, op.command.threadId, op.command.body.body, op.command.body.mentions, op.createdAt) };
      }
    }
    return null;
  }

  /* ---- Host events ----------------------------------------------------------------- */

  private onHostEvent(event: HostEvent): void {
    if (this.destroyed) return;
    if (event.t === "command-settled") {
      const op = this.ops.find((item) => item.command.id === event.id);
      if (!op) return;
      if (event.ok) this.succeeded(op, event.body);
      else this.failed(op, event.error?.message ?? `The server refused this (${event.status}).`);
      return;
    }
    if (event.t === "status") {
      // Back online: catch up on anything said while away.
      if (event.status.connection === "connected" && (this.loadError || !this.loaded)) void this.load();
      return;
    }
    if (event.t !== "server-event") return;
    if (event.kind !== EventKind.ThreadChanged && event.kind !== EventKind.ThreadDeleted) return;
    const thread = (event.payload as { thread?: Thread } | null)?.thread;
    if (!thread || thread.docId !== this.docId) return;
    if (event.kind === EventKind.ThreadDeleted) this.server.delete(thread.id);
    else this.server.set(thread.id, thread);
    this.changed();
  }

  /* ---- Writing ----------------------------------------------------------------- */

  private requireMe(): UserSummary {
    const me = this.options.me();
    if (!me) throw new Error("Sign in to your collaboration account to comment.");
    if (!roleAtLeast(this.options.role(), "commenter")) throw new Error("Viewers cannot comment in this notebook.");
    return me;
  }

  private writeAnchor(range: ReviewRange, me: UserSummary): string {
    const ytext = this.options.replica.ytext;
    const anchorId = this.newId("anc");
    addAnchor(this.options.replica.annotations, ytext, range.start, range.end, { id: anchorId, kind: "comment", createdBy: me.id }, SHARED_REVIEW_ORIGIN);
    return anchorId;
  }

  /** Commenters may only remove anchors they created (the server's annotations rule). */
  private mayRemoveAnchor(anchorId: string): boolean {
    const record = readAnchor(this.options.replica.annotations, anchorId);
    if (!record) return false;
    return record.createdBy === this.options.me()?.id || roleAtLeast(this.options.role(), "editor");
  }

  async comment(input: CommentInput): Promise<ReviewDocument> {
    const me = this.requireMe();
    const text = input.text.trim();
    if (!text) throw new Error("Enter a comment.");
    const ytext = this.options.replica.ytext;
    const { start, end } = input.range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > ytext.length) throw new Error("Select a passage to comment on.");
    const quote = ytext.toString().slice(start, end);
    // The anchor goes first: it syncs through the CRDT even if the thread
    // has to wait in the queue.
    const anchorId = this.writeAnchor(input.range, me);
    const threadId = this.newId("thr");
    this.lastCreated = threadId;
    await this.run(
      { id: this.newId("cmd"), kind: "thread.create", docId: this.docId, body: { id: threadId, anchorId, quote, body: text, ...(input.mentions?.length ? { mentions: input.mentions } : {}) } },
      { wroteAnchor: anchorId },
    );
    return this.document();
  }

  /** The id the last `comment` call gave its thread (the panel selects it). */
  lastCreatedThreadId(): string | null {
    return this.lastCreated;
  }

  async reply(input: ReplyInput): Promise<ReviewDocument> {
    this.requireMe();
    const text = input.text.trim();
    if (!text) throw new Error("Enter a comment.");
    await this.run({ id: this.newId("cmd"), kind: "message.create", threadId: input.threadId, body: { id: this.newId("msg"), body: text, ...(input.mentions?.length ? { mentions: input.mentions } : {}) } });
    return this.document();
  }

  async edit(input: EditInput): Promise<ReviewDocument> {
    this.requireMe();
    const text = input.text.trim();
    if (!text) throw new Error("Enter a comment.");
    const message = this.projection.threads.flatMap((thread) => thread.messages).find((item) => item.id === input.messageId);
    if (message && !message.shared.canEdit) throw new Error("You can only edit your own messages.");
    // An edit of a message still in the queue is queued after its create, so
    // the host replays them in order.
    await this.run({ id: this.newId("cmd"), kind: "message.edit", messageId: input.messageId, body: { body: text, ...(input.mentions?.length ? { mentions: input.mentions } : {}) } });
    return this.document();
  }

  async deleteMessage(messageId: string): Promise<ReviewDocument> {
    this.requireMe();
    const message = this.projection.threads.flatMap((thread) => thread.messages).find((item) => item.id === messageId);
    if (message && !message.shared.canDelete) throw new Error("You can only delete your own messages.");
    await this.run({ id: this.newId("cmd"), kind: "message.delete", messageId });
    return this.document();
  }

  async resolve(input: ResolveInput): Promise<ReviewDocument> {
    this.requireMe();
    this.assertManage(input.threadId);
    const thread = this.projection.threads.find((item) => item.id === input.threadId);
    // Reopening a thread whose text is gone leaves it detached, not open.
    const status: ThreadStatus = input.resolved ? "resolved" : thread?.shared.detached && thread.shared.detachReason === "deleted" ? "detached" : "open";
    this.cancelAutoStatus(input.threadId);
    await this.run({ id: this.newId("cmd"), kind: "thread.status", threadId: input.threadId, body: { status } });
    return this.document();
  }

  async reattach(input: ReattachInput): Promise<ReviewDocument> {
    const me = this.requireMe();
    this.assertManage(input.threadId);
    const ytext = this.options.replica.ytext;
    const { start, end } = input.range ?? { start: 0, end: 0 };
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > ytext.length) throw new Error("Select a passage to reattach the comment to.");
    const thread = this.projection.threads.find((item) => item.id === input.threadId);
    const previous = thread?.shared.anchorId;
    const anchorId = this.writeAnchor(input.range, me);
    this.cancelAutoStatus(input.threadId);
    await this.run(
      { id: this.newId("cmd"), kind: "thread.reattach", threadId: input.threadId, body: { anchorId, quote: ytext.toString().slice(start, end) } },
      previous && previous !== anchorId ? { removeAnchorOnSuccess: previous, wroteAnchor: anchorId } : { wroteAnchor: anchorId },
    );
    return this.document();
  }

  async delete(input: DeleteInput): Promise<ReviewDocument> {
    this.requireMe();
    this.assertManage(input.threadId);
    const thread = this.projection.threads.find((item) => item.id === input.threadId);
    this.cancelAutoStatus(input.threadId);
    await this.run({ id: this.newId("cmd"), kind: "thread.delete", threadId: input.threadId }, thread ? { removeAnchorOnSuccess: thread.shared.anchorId } : {});
    return this.document();
  }

  private assertManage(threadId: string): void {
    const thread = this.projection.threads.find((item) => item.id === threadId);
    if (thread && !thread.shared.canManage) throw new Error("Only the comment's author or an editor can change this thread.");
  }

  /** Sends a refused command again, as a new command (the server keeps the first answer per id). */
  async retry(commandId: string): Promise<ReviewDocument> {
    const op = this.ops.find((item) => item.command.id === commandId);
    if (!op || op.state !== "failed") return this.document();
    this.ops = this.ops.filter((item) => item !== op);
    void this.api.discard(commandId).catch(() => undefined);
    await this.run({ ...op.command, id: this.newId("cmd") } as Command, { removeAnchorOnSuccess: op.removeAnchorOnSuccess, wroteAnchor: op.wroteAnchor });
    return this.document();
  }

  /** Drops a refused command; a comment that was never created takes its anchor with it. */
  discard(commandId: string): ReviewDocument {
    const op = this.ops.find((item) => item.command.id === commandId);
    if (!op) return this.document();
    this.ops = this.ops.filter((item) => item !== op);
    void this.api.discard(commandId).catch(() => undefined);
    if (op.wroteAnchor && (op.command.kind === "thread.create" || op.command.kind === "thread.reattach") && this.mayRemoveAnchor(op.wroteAnchor)) {
      removeAnchor(this.options.replica.annotations, op.wroteAnchor, SHARED_REVIEW_ORIGIN);
    }
    // The card goes at once; listeners hear about it on the next tick.
    this.projection = this.build();
    this.changed();
    return this.document();
  }

  private async run(command: Command, extra: Partial<PendingOp> = {}): Promise<void> {
    const online = this.options.online();
    const op: PendingOp = { command, state: online ? "sending" : "queued", error: null, createdAt: new Date().toISOString(), ...extra };
    this.ops.push(op);
    this.changed();
    if (!online) {
      await this.enqueue(op);
      return;
    }
    try {
      const body = await this.direct(command);
      this.succeeded(op, body);
    } catch (error) {
      if (isQueueableError(error)) {
        op.state = "queued";
        this.changed();
        await this.enqueue(op);
      } else {
        this.failed(op, describeError(error));
      }
    } finally {
      this.wakeIdle();
    }
  }

  private async enqueue(op: PendingOp): Promise<void> {
    try {
      await this.api.enqueue(op.command);
    } catch (error) {
      this.failed(op, describeError(error));
    }
  }

  private direct(command: Command): Promise<unknown> {
    switch (command.kind) {
      case "thread.create":
        return this.api.createThread(command.docId, command.body);
      case "message.create":
        return this.api.addMessage(command.threadId, command.body);
      case "message.edit":
        return this.api.editMessage(command.messageId, command.body);
      case "message.delete":
        return this.api.deleteMessage(command.messageId);
      case "thread.status":
        return this.api.setStatus(command.threadId, command.body);
      case "thread.reattach":
        return this.api.reattach(command.threadId, command.body);
      case "thread.delete":
        return this.api.deleteThread(command.threadId);
      default:
        return Promise.reject(new Error(`${command.kind} is not a comment command.`));
    }
  }

  private succeeded(op: PendingOp, body: unknown): void {
    if (!this.ops.includes(op)) return;
    this.ops = this.ops.filter((item) => item !== op);
    const command = op.command;
    switch (command.kind) {
      case "thread.create":
      case "thread.status":
      case "thread.reattach":
        if (isThread(body) && body.docId === this.docId) this.server.set(body.id, body);
        break;
      case "message.create":
      case "message.edit":
        if (isMessage(body)) this.upsertMessage(body);
        break;
      case "message.delete": {
        const found = this.findMessage(command.messageId);
        if (found) {
          const thread = cloneThread(found.thread);
          thread.messages = thread.messages.map((message) => (message.id === command.messageId ? { ...message, body: "", mentions: [], deletedAt: new Date().toISOString() } : message));
          this.server.set(thread.id, thread);
        }
        break;
      }
      case "thread.delete":
        this.server.delete(command.threadId);
        break;
      default:
        break;
    }
    if (op.removeAnchorOnSuccess && this.mayRemoveAnchor(op.removeAnchorOnSuccess)) {
      removeAnchor(this.options.replica.annotations, op.removeAnchorOnSuccess, SHARED_REVIEW_ORIGIN);
    }
    this.changed();
  }

  private failed(op: PendingOp, error: string): void {
    if (!this.ops.includes(op)) return;
    if (op.silent) {
      this.ops = this.ops.filter((item) => item !== op);
    } else {
      op.state = "failed";
      op.error = error;
    }
    this.changed();
  }

  private upsertMessage(message: ThreadMessage): void {
    const existing = this.server.get(message.threadId);
    if (!existing) return;
    const thread = cloneThread(existing);
    const index = thread.messages.findIndex((item) => item.id === message.id);
    if (index >= 0) thread.messages[index] = message;
    else thread.messages.push(message);
    this.server.set(thread.id, thread);
  }

  private wakeIdle(): void {
    if (this.ops.some((op) => op.state === "sending")) return;
    for (const resolve of this.settledWaiters.splice(0)) resolve();
  }

  /* ---- Automatic detached status -------------------------------------------------------- */

  private cancelAutoStatus(threadId: string): void {
    const entry = this.autoStatus.get(threadId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.autoStatus.delete(threadId);
  }

  /**
   * Tells the server a thread's text was deleted (or came back). Only a
   * client that may change the thread does, and only once per state; the
   * server ignores a status it already has, so several windows agreeing is
   * harmless.
   */
  private syncDetachedStatus(threads: SharedReviewThread[]): void {
    for (const thread of threads) {
      const serverThread = this.server.get(thread.id);
      if (!serverThread || !thread.shared.canManage || thread.shared.pending) continue;
      let wanted: ThreadStatus | null = null;
      if (serverThread.status === "open" && thread.shared.detachReason === "deleted") wanted = "detached";
      else if (serverThread.status === "detached" && !thread.shared.detached) wanted = "open";
      const entry = this.autoStatus.get(thread.id);
      if (!wanted) {
        if (entry?.timer) clearTimeout(entry.timer);
        if (entry && entry.status !== serverThread.status) this.autoStatus.delete(thread.id);
        continue;
      }
      if (entry?.status === wanted) continue;
      if (entry?.timer) clearTimeout(entry.timer);
      const status = wanted;
      const timer = setTimeout(() => {
        const current = this.autoStatus.get(thread.id);
        if (!current || current.status !== status || this.destroyed) return;
        current.timer = null;
        // Checked again: an undo may have brought the text back meanwhile.
        const now = this.projection.threads.find((item) => item.id === thread.id);
        if (!now || (status === "detached" ? now.shared.detachReason !== "deleted" : now.shared.detached)) {
          this.autoStatus.delete(thread.id);
          return;
        }
        void this.run({ id: this.newId("cmd"), kind: "thread.status", threadId: thread.id, body: { status } }, { silent: true });
      }, this.detachDelayMs);
      this.autoStatus.set(thread.id, { status, timer });
    }
  }

  /* ---- Projection ----------------------------------------------------------------- */

  private observe(): void {
    for (const off of this.unobserve) off();
    const ytext = this.options.replica.ytext;
    const anchors = this.options.replica.annotations.getMap(AnnotationKeys.anchors);
    const onChange = () => this.changed();
    ytext.observe(onChange);
    anchors.observe(onChange);
    this.unobserve = [() => ytext.unobserve(onChange), () => anchors.unobserve(onChange)];
  }

  private changed(): void {
    if (this.destroyed || this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      if (this.destroyed) return;
      this.projection = this.build();
      this.syncDetachedStatus(this.projection.threads);
      const doc = this.document();
      for (const listener of [...this.projectionListeners]) listener(this.projection);
      for (const listener of [...this.listeners]) listener(doc);
    });
  }

  /** Rebuilds the projection now (tests, and callers that just wrote). */
  flush(): SharedReviewProjection {
    this.projection = this.build();
    return this.projection;
  }

  private syntheticMessage(id: string, threadId: string, body: string, mentions: string[] | undefined, createdAt: string): ThreadMessage {
    const me = this.options.me() ?? { id: "", displayName: "You", color: "#64748b" };
    return { id, threadId, actor: { kind: "user", userId: me.id }, author: me, body, mentions: mentions ?? [], createdAt, editedAt: null, deletedAt: null };
  }

  private build(): SharedReviewProjection {
    const replica = this.options.replica;
    const ytext = replica.ytext;
    const text = ytext.toString();
    const me = this.options.me();
    const role = this.options.role();
    const threads = new Map<string, Thread>();
    for (const [id, thread] of this.server) threads.set(id, cloneThread(thread));
    const threadPending = new Map<string, PendingOp>();
    const messagePending = new Map<string, PendingOp>();
    const hidden = new Set<string>();

    for (const op of this.ops) {
      const command = op.command;
      switch (command.kind) {
        case "thread.create": {
          if (!threads.has(command.body.id)) {
            threads.set(command.body.id, {
              id: command.body.id,
              docId: this.docId,
              anchorId: command.body.anchorId,
              quote: command.body.quote,
              status: "open",
              actor: { kind: "user", userId: me?.id ?? "" },
              createdBy: me ?? { id: "", displayName: "You", color: "#64748b" },
              createdAt: op.createdAt,
              updatedAt: op.createdAt,
              resolvedBy: null,
              resolvedAt: null,
              suggestionIds: [],
              messages: [this.syntheticMessage(command.body.id, command.body.id, command.body.body, command.body.mentions, op.createdAt)],
            });
            if (!op.silent) threadPending.set(command.body.id, op);
          }
          break;
        }
        case "message.create": {
          const thread = threads.get(command.threadId);
          if (thread && !thread.messages.some((message) => message.id === command.body.id)) {
            thread.messages.push(this.syntheticMessage(command.body.id, command.threadId, command.body.body, command.body.mentions, op.createdAt));
            messagePending.set(command.body.id, op);
          }
          break;
        }
        case "message.edit": {
          for (const thread of threads.values()) {
            const message = thread.messages.find((item) => item.id === command.messageId);
            if (!message) continue;
            message.body = command.body.body;
            message.mentions = command.body.mentions ?? [];
            message.editedAt = op.createdAt;
            messagePending.set(message.id, op);
          }
          break;
        }
        case "message.delete": {
          for (const thread of threads.values()) {
            const message = thread.messages.find((item) => item.id === command.messageId);
            if (!message) continue;
            // Shown greyed until the server agrees, so a refusal can restore it.
            messagePending.set(message.id, op);
          }
          break;
        }
        case "thread.status": {
          const thread = threads.get(command.threadId);
          if (thread) {
            thread.status = command.body.status;
            if (!op.silent) threadPending.set(thread.id, op);
          }
          break;
        }
        case "thread.reattach": {
          const thread = threads.get(command.threadId);
          if (thread) {
            thread.anchorId = command.body.anchorId;
            thread.quote = command.body.quote;
            threadPending.set(thread.id, op);
          }
          break;
        }
        case "thread.delete": {
          // A queued delete hides the thread; a refused one shows it again with the error.
          if (op.state !== "failed") hidden.add(command.threadId);
          else threadPending.set(command.threadId, op);
          break;
        }
        default:
          break;
      }
    }

    const pendingInfo = (op: PendingOp | undefined): PendingInfo | null => (op ? { commandId: op.command.id, state: op.state, error: op.error } : null);
    const projected: SharedReviewThread[] = [];
    for (const thread of threads.values()) {
      if (hidden.has(thread.id)) continue;
      const record = readAnchor(replica.annotations, thread.anchorId);
      const resolved = record ? resolveAnchor(ytext, record) : null;
      const attached = resolved?.state === "attached";
      const anchor: ReviewAnchor = attached
        ? { start: resolved.start, end: resolved.end, quote: thread.quote, prefix: text.slice(Math.max(0, resolved.start - CONTEXT), resolved.start), suffix: text.slice(resolved.end, resolved.end + CONTEXT), state: "attached" }
        : { start: resolved?.start ?? 0, end: resolved?.start ?? 0, quote: thread.quote, prefix: "", suffix: "", state: "orphaned" };
      const canManage = !!me && (thread.createdBy.id === me.id || roleAtLeast(role, "editor"));
      const visible = thread.messages.filter((message) => !message.deletedAt || messagePending.has(message.id));
      const messages: SharedReviewMessage[] = (visible.length ? visible : thread.messages.slice(0, 1)).map((message) => {
        const mine = !!me && message.author.id === me.id;
        const deleted = !!message.deletedAt;
        return {
          id: message.id,
          text: deleted ? "" : message.body,
          createdAt: message.createdAt,
          shared: {
            author: message.author,
            actor: message.actor ?? null,
            mentions: message.mentions ?? [],
            editedAt: message.editedAt,
            deleted,
            pending: pendingInfo(messagePending.get(message.id)),
            mine,
            canEdit: mine && !deleted,
            canDelete: !deleted && (mine || role === "owner"),
          },
        };
      });
      projected.push({
        id: thread.id,
        anchor,
        status: thread.status === "resolved" ? "resolved" : "open",
        messages,
        shared: {
          docId: this.docId,
          anchorId: thread.anchorId,
          status: thread.status,
          detached: !attached,
          detachReason: attached ? null : record ? (resolved?.reason ?? "unresolvable") : "missing",
          collapsedAt: !attached && resolved ? resolved.start : null,
          createdBy: thread.createdBy,
          actor: thread.actor ?? null,
          resolvedBy: thread.resolvedBy,
          createdAt: thread.createdAt,
          pending: pendingInfo(threadPending.get(thread.id)),
          canManage,
        },
      });
    }
    // Document order, so the sidebar follows the text; detached threads last.
    projected.sort((a, b) => {
      const aAttached = a.anchor.state === "attached", bAttached = b.anchor.state === "attached";
      if (aAttached !== bAttached) return aAttached ? -1 : 1;
      if (aAttached && a.anchor.start !== b.anchor.start) return a.anchor.start - b.anchor.start;
      return a.shared.createdAt.localeCompare(b.shared.createdAt) || a.id.localeCompare(b.id);
    });
    const revision = (this.projection?.revision ?? 0) + 1;
    return {
      docId: this.docId,
      projectId: this.options.projectId,
      key: this.options.key,
      text,
      threads: projected,
      loaded: this.loaded,
      error: this.loadError,
      role,
      me,
      revision,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.unobserve) off();
    for (const off of this.cleanup) off();
    for (const entry of this.autoStatus.values()) if (entry.timer) clearTimeout(entry.timer);
    this.autoStatus.clear();
    this.listeners.clear();
    this.projectionListeners.clear();
    for (const resolve of this.settledWaiters.splice(0)) resolve();
  }
}

function isThread(value: unknown): value is Thread {
  return !!value && typeof value === "object" && typeof (value as Thread).id === "string" && Array.isArray((value as Thread).messages);
}

function isMessage(value: unknown): value is ThreadMessage {
  return !!value && typeof value === "object" && typeof (value as ThreadMessage).id === "string" && typeof (value as ThreadMessage).threadId === "string";
}
