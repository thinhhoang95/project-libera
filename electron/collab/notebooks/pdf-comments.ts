// Comments on a live PDF are server threads, like comments on a Markdown
// document: authors, mentions, notifications and the offline queue all come
// with that. The panel and the agent keep speaking in PdfCommentThread terms,
// through /api/pdf-comments, so this module is the only thing that changes.

import { randomBytes } from "node:crypto";

import { ApiClientError } from "../core/api-client";
import type { FailedCommandRecord } from "../core/command-outcomes";
import type { CollabHost } from "../core/host";
import { PdfKeys, pdfAnchorViolation } from "../../../src/lib/collab/protocol/pdf";
import type { Command, Thread } from "../../../src/lib/collab/protocol/api";
import type { AiActorHint } from "../../../src/lib/collab/protocol/actor";
import type { PdfCommentAnchor, PdfCommentMessage, PdfCommentThread } from "../../../src/lib/types";
import { ControlError } from "../control/types";

export type LivePdfCommentChange =
  | { action: "comment"; anchor: PdfCommentAnchor; text: string; mentions?: string[] }
  | { action: "reply"; threadId: string; text: string; mentions?: string[]; ai?: AiActorHint }
  | { action: "edit"; threadId: string; messageId: string; text: string; mentions?: string[] }
  | { action: "resolve"; threadId: string; resolved: boolean }
  | { action: "delete"; threadId: string }
  | { action: "delete-message"; threadId: string; messageId: string };

interface AnchorRecord extends PdfCommentAnchor {
  id: string;
  createdBy: string;
  createdAt: number;
}

/** How long a change waits for the server before it shows as pending instead. */
const SEND_WAIT_MS = 4_000;

const newId = (prefix: string) => `${prefix}_${randomBytes(15).toString("hex")}`;

function messageOf(message: Thread["messages"][number], accountId: string): PdfCommentMessage {
  const ai = message.actor.kind === "ai";
  return {
    id: message.id,
    text: message.body,
    createdAt: message.createdAt,
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
    ...(ai ? { author: "agent" as const } : {}),
    authorName: message.author.displayName,
    own: !ai && message.author.id === accountId,
  };
}

/**
 * A server thread as the panel shows it. Its anchor travels separately and can
 * arrive after it, so until then it shows with its quote and no place on a page.
 */
export function pdfThreadOf(thread: Thread, anchor: PdfCommentAnchor | undefined, accountId: string): PdfCommentThread {
  const messages = thread.messages.filter((message) => !message.deletedAt).map((message) => messageOf(message, accountId));
  return { id: thread.id, anchor: anchor && !pdfAnchorViolation(anchor) ? anchor : { segments: [], quote: thread.quote }, status: thread.status === "resolved" ? "resolved" : "open", messages, createdAt: thread.createdAt, updatedAt: thread.updatedAt };
}

/** Commands still waiting for the network, applied so offline work shows as it will land. */
export function withPendingCommands(threads: PdfCommentThread[], commands: readonly Command[], docId: string, anchorOf: (anchorId: string) => PdfCommentAnchor | undefined): PdfCommentThread[] {
  let next = threads;
  const now = new Date().toISOString();
  const pendingMessage = (id: string, text: string): PdfCommentMessage => ({ id, text, createdAt: now, own: true, pending: true });
  for (const command of commands) {
    switch (command.kind) {
      case "thread.create": {
        const anchor = anchorOf(command.body.anchorId);
        if (command.docId !== docId || !anchor || next.some((thread) => thread.id === command.body.id)) break;
        // The server gives a thread's first message the thread's id.
        next = [...next, { id: command.body.id, anchor, status: "open", messages: [pendingMessage(command.body.id, command.body.body)], createdAt: now, updatedAt: now, pending: true }];
        break;
      }
      case "message.create":
        next = next.map((thread) => thread.id === command.threadId && !thread.messages.some((message) => message.id === command.body.id) ? { ...thread, messages: [...thread.messages, pendingMessage(command.body.id, command.body.body)] } : thread);
        break;
      case "message.edit":
        next = next.map((thread) => ({ ...thread, messages: thread.messages.map((message) => message.id === command.messageId ? { ...message, text: command.body.body, pending: true } : message) }));
        break;
      case "message.delete":
        next = next.map((thread) => ({ ...thread, messages: thread.messages.filter((message) => message.id !== command.messageId) }));
        break;
      case "thread.status":
        next = next.map((thread) => thread.id === command.threadId ? { ...thread, status: command.body.status === "resolved" ? "resolved" : "open" } : thread);
        break;
      case "thread.delete":
        next = next.filter((thread) => thread.id !== command.threadId);
        break;
      default:
        break;
    }
  }
  return next;
}

/**
 * Comments written offline that the server then refused (a role change, a
 * deleted thread): shown, marked as not sent, instead of vanishing. Their text
 * stays until the person deletes them, which discards the refusal.
 */
export function withRefusedCommands(threads: PdfCommentThread[], refused: readonly FailedCommandRecord[], docId: string, anchorOf: (anchorId: string) => PdfCommentAnchor | undefined): PdfCommentThread[] {
  let next = threads;
  for (const { command, error, failedAt } of refused) {
    const at = new Date(failedAt).toISOString();
    const message = (id: string, text: string): PdfCommentMessage => ({ id, text, createdAt: at, own: true, notSent: error.message });
    if (command.kind === "thread.create") {
      const anchor = anchorOf(command.body.anchorId);
      if (command.docId !== docId || !anchor || next.some((thread) => thread.id === command.body.id)) continue;
      next = [...next, { id: command.body.id, anchor, status: "open", messages: [message(command.body.id, command.body.body)], createdAt: at, updatedAt: at, notSent: error.message }];
    } else if (command.kind === "message.create") {
      next = next.map((thread) => thread.id === command.threadId && !thread.messages.some((item) => item.id === command.body.id) ? { ...thread, messages: [...thread.messages, message(command.body.id, command.body.body)] } : thread);
    }
  }
  return next;
}

/** The refused command that created a thread or message, so deleting it discards the refusal. */
function refusedCommandFor(refused: readonly FailedCommandRecord[], id: string): string | null {
  for (const { command } of refused) {
    if ((command.kind === "thread.create" || command.kind === "message.create") && command.body.id === id) return command.id;
  }
  return null;
}

export class PdfCommentService {
  constructor(private readonly host: CollabHost, private readonly accountId: () => string) {}

  private anchors(docId: string): Map<string, AnchorRecord> {
    const hub = this.host.acquire(docId);
    try {
      const anchors = new Map<string, AnchorRecord>();
      for (const [id, value] of hub.getDoc("annotations").getMap<AnchorRecord>(PdfKeys.anchors).entries()) anchors.set(id, value);
      return anchors;
    } finally {
      this.host.release(docId);
    }
  }

  private writeAnchor(docId: string, anchor: PdfCommentAnchor, id: string) {
    const problem = pdfAnchorViolation(anchor);
    if (problem) throw new ControlError(400, "bad-request", problem);
    const hub = this.host.acquire(docId);
    try {
      hub.applyLocalChange("annotations", (doc) => {
        const anchors = doc.getMap<AnchorRecord>(PdfKeys.anchors);
        if (!anchors.has(id)) anchors.set(id, { ...anchor, id, createdBy: this.accountId(), createdAt: Date.now() });
      });
    } finally {
      this.host.release(docId);
    }
  }

  private pending(): Command[] {
    return this.host.commands.list().map((row) => row.command).filter((command): command is Command => Boolean(command));
  }

  /**
   * The PDF's threads. The cache answers when the server cannot, so a person
   * offline keeps seeing what they saw, plus their own queued comments.
   */
  async list(docId: string): Promise<PdfCommentThread[]> {
    let threads: Thread[];
    try {
      const api = this.host.api;
      if (!api) throw new ApiClientError("network", 0, "Not signed in.");
      threads = await api.listThreads(docId);
      const current = new Set(threads.map((thread) => thread.id));
      for (const row of this.host.store.listThreads(docId)) if (!current.has(row.threadId)) this.host.store.deleteThread(row.threadId);
      for (const thread of threads) this.host.store.putThread(thread.id, docId, thread);
    } catch (error) {
      if (error instanceof ApiClientError && !error.transient && error.code !== "network" && error.code !== "needs-sign-in" && error.status !== 404) throw error;
      threads = this.host.store.listThreads(docId).map((row) => row.json as Thread);
    }
    const anchors = this.anchors(docId);
    const anchorOf = (anchorId: string) => anchors.get(anchorId);
    const shown = threads.map((thread) => pdfThreadOf(thread, anchorOf(thread.anchorId), this.accountId()));
    return withRefusedCommands(withPendingCommands(shown, this.pending(), docId, anchorOf), this.host.commandOutcomes.failed(), docId, anchorOf);
  }

  /**
   * Every change goes through the durable queue first, online too, so a crash
   * after the person pressed Send loses nothing. Online, this waits for the
   * outcome so a refusal reaches the panel; a slow or absent network leaves
   * the command queued, and the comment shows as pending.
   */
  private async send(command: Command): Promise<void> {
    const commands = this.host.commands;
    const online = this.host.api !== null && this.host.connectionState === "connected";
    let stop: () => void = () => {};
    const settled = online ? new Promise<{ ok: boolean; status: number; error?: { message: string } } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), SEND_WAIT_MS);
      stop = commands.on((event) => {
        if (event.type !== "settled" || event.id !== command.id) return;
        clearTimeout(timer);
        resolve(event);
      });
    }) : null;
    commands.enqueue(command);
    const outcome = await settled;
    stop();
    if (outcome && !outcome.ok) throw new ControlError(outcome.status, "refused", outcome.error?.message ?? "The server refused this change.");
  }

  async change(docId: string, change: LivePdfCommentChange): Promise<PdfCommentThread[]> {
    const id = newId("cmd");
    // Deleting a comment the server refused discards it here; the server never had it.
    if (change.action === "delete" || change.action === "delete-message") {
      const refused = refusedCommandFor(this.host.commandOutcomes.failed(), change.action === "delete" ? change.threadId : change.messageId);
      if (refused) {
        this.host.commandOutcomes.discard(refused);
        return this.list(docId);
      }
    }
    switch (change.action) {
      case "comment": {
        const anchorId = newId("anc");
        this.writeAnchor(docId, change.anchor, anchorId);
        const body = { id: newId("thr"), anchorId, quote: change.anchor.quote.slice(0, 10_000), body: change.text, ...(change.mentions ? { mentions: change.mentions } : {}) };
        await this.send({ id, kind: "thread.create", docId, body });
        break;
      }
      case "reply": {
        const body = { id: newId("msg"), body: change.text, ...(change.mentions ? { mentions: change.mentions } : {}), ...(change.ai ? { ai: change.ai } : {}) };
        await this.send({ id, kind: "message.create", threadId: change.threadId, body });
        break;
      }
      case "edit": {
        await this.send({ id, kind: "message.edit", messageId: change.messageId, body: { body: change.text, ...(change.mentions ? { mentions: change.mentions } : {}) } });
        break;
      }
      case "resolve": {
        await this.send({ id, kind: "thread.status", threadId: change.threadId, body: { status: change.resolved ? "resolved" : "open" } });
        break;
      }
      case "delete":
        await this.send({ id, kind: "thread.delete", threadId: change.threadId });
        break;
      case "delete-message":
        await this.send({ id, kind: "message.delete", messageId: change.messageId });
        break;
      default:
        throw new ControlError(400, "bad-request", "Unknown comment action.");
    }
    return this.list(docId);
  }
}
