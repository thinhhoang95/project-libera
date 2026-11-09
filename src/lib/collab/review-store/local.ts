// The local review store: today's Review Mode storage, unchanged. Every call
// is the request markdown-review-context.tsx made before the store existed
// (`/api/markdown-reviews`, which keeps `.libera/markdown-reviews.json`), so
// documents outside shared notebooks behave exactly as before.

import { apiRequest } from "@/components/libera/api-client";
import type { ReviewDocument } from "@/lib/markdown-review";
import type { CommentInput, DeleteInput, EditInput, ReattachInput, ReplyInput, ResolveInput, ReviewStore } from "./types";

export const LOCAL_REVIEW_ROUTE = "/api/markdown-reviews";

/** A request that found no such review (apiRequest sets `status`). */
const notFound = (error: unknown) => (error as { status?: unknown } | null)?.status === 404;

export interface LocalReviewStoreOptions {
  /** The review key: a Libera path, `draft:<tabId>` or `standalone:<id>`. */
  key: string;
  /**
   * The text the anchors refer to (the editor's live draft), for the
   * ReviewStore methods. Callers that pass a snapshot to every call (the
   * review context) can leave it out.
   */
  snapshot?: () => string;
  /** Defaults to the app's JSON request helper. */
  request?: <T>(url: string, init?: RequestInit) => Promise<T>;
}

export class LocalReviewStore implements ReviewStore {
  readonly kind = "local" as const;
  readonly key: string;
  private readonly snapshot: () => string;
  private readonly requestImpl: <T>(url: string, init?: RequestInit) => Promise<T>;
  private current: ReviewDocument | null = null;
  private readonly listeners = new Set<(doc: ReviewDocument) => void>();

  constructor(options: LocalReviewStoreOptions) {
    this.key = options.key;
    this.snapshot = options.snapshot ?? (() => { throw new Error("Open the review document first."); });
    this.requestImpl = options.request ?? apiRequest;
  }

  get document(): ReviewDocument | null {
    return this.current;
  }

  /** Adopts a document the caller already has (after a reload or a recovery). */
  setDocument(doc: ReviewDocument | null) {
    this.current = doc;
  }

  private publish(doc: ReviewDocument): ReviewDocument {
    this.current = doc;
    for (const listener of [...this.listeners]) listener(doc);
    return doc;
  }

  subscribe(listener: (doc: ReviewDocument) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** `load`: the review for the key, created on first use (`snapshot` defaults to the live draft). */
  async load(signal?: AbortSignal, snapshot: string = this.snapshot()): Promise<ReviewDocument> {
    const doc = await this.requestImpl<ReviewDocument>(LOCAL_REVIEW_ROUTE, { method: "POST", signal, body: JSON.stringify({ action: "load", key: this.key, snapshot }) });
    return this.publish(doc);
  }

  /** `migrate`: an untitled or standalone draft was saved under a new key. */
  async migrate(previous: ReviewDocument, snapshot: string): Promise<ReviewDocument> {
    return this.requestImpl<ReviewDocument>(LOCAL_REVIEW_ROUTE, { method: "POST", body: JSON.stringify({ action: "migrate", id: previous.id, revision: previous.revision, snapshot, key: this.key }) });
  }

  /**
   * Reads the stored review by id (Reload review). When that review is gone,
   * the one stored for the key is loaded instead (see `mutate`).
   */
  async read(id: string, signal?: AbortSignal): Promise<ReviewDocument> {
    try {
      return this.publish(await this.requestImpl<ReviewDocument>(`${LOCAL_REVIEW_ROUTE}?id=${encodeURIComponent(id)}`, { signal }));
    } catch (error) {
      if (!notFound(error) || !this.current) throw error;
      return this.load(signal, this.current.snapshot);
    }
  }

  /**
   * Any review action against `doc`'s revision with the given snapshot: the
   * comment operations below and the agentic-review ones (toggle, sync,
   * decision, undo, redo, new-round) that keep their local route.
   *
   * A review can be replaced under an open editor: Check Notebook → Try to
   * fix gives a file moved outside the app its older review in place of the
   * empty one that opening it made (markdown-reviews.ts moveReviewPaths). The
   * action then finds no review by that id; the key's review is loaded and
   * the action applied to it once.
   */
  async mutate(action: string, fields: Record<string, unknown>, context: { doc: ReviewDocument; snapshot: string; signal?: AbortSignal }): Promise<ReviewDocument> {
    const send = (doc: ReviewDocument) => this.requestImpl<ReviewDocument>(LOCAL_REVIEW_ROUTE, {
      method: "POST",
      signal: context.signal,
      body: JSON.stringify({ ...fields, action, id: doc.id, revision: doc.revision, snapshot: context.snapshot }),
    });
    try {
      return this.publish(await send(context.doc));
    } catch (error) {
      if (!notFound(error)) throw error;
      const replacement = await this.load(context.signal, context.snapshot);
      if (replacement.id === context.doc.id) throw error;
      return this.publish(await send(replacement));
    }
  }

  private act(action: string, fields: Record<string, unknown>): Promise<ReviewDocument> {
    const doc = this.current;
    if (!doc) return Promise.reject(new Error("Open the review document first."));
    return this.mutate(action, fields, { doc, snapshot: this.snapshot() });
  }

  comment(input: CommentInput) { return this.act("comment", { range: input.range, text: input.text }); }
  reply(input: ReplyInput) { return this.act("reply", { threadId: input.threadId, text: input.text }); }
  edit(input: EditInput) { return this.act("edit", { threadId: input.threadId, messageId: input.messageId, text: input.text }); }
  resolve(input: ResolveInput) { return this.act("resolve", { threadId: input.threadId, resolved: input.resolved }); }
  reattach(input: ReattachInput) { return this.act("reattach", { threadId: input.threadId, range: input.range }); }
  delete(input: DeleteInput) { return this.act("delete", { threadId: input.threadId }); }
}
