// Control routes: comment threads (plan M2.1–M2.3, M2.6). Thin proxies to the
// server's /v1/documents/:docId/threads, /v1/threads/… and /v1/messages/…;
// the server enforces every permission (only your own messages can be
// edited, the owner can delete anyone's).
//
// Offline, the renderer queues the same requests as Commands (POST
// /commands). The host persists them in pending_commands and replays them
// through POST /v1/commands; ids are chosen by the client, so a request that
// reached the server before the network dropped is not applied twice.
//
// The anchor itself is not sent here: the renderer writes it into the
// document's annotations, which sync through the CRDT like text.

import { randomBytes } from "node:crypto";

import { createAnchor, readAnchor, resolveAnchor, writeAnchor } from "../../../src/lib/collab/anchors";
import { mapSnapshotEdits } from "../../../src/lib/collab/suggestions/model";
import { canWriteSubdoc } from "../../../src/lib/collab/protocol/roles";
import { ApiClientError } from "../core/api-client";
import type { AiActorHint } from "../../../src/lib/collab/protocol/actor";
import type {
  Command,
  CreateMessageRequest,
  CreateThreadRequest,
  EditMessageRequest,
  ReattachThreadRequest,
  SetThreadStatusRequest,
  ThreadStatus,
} from "../../../src/lib/collab/protocol/api";
import { ContentKeys } from "../../../src/lib/collab/protocol/schema";
import {
  ControlRoutes,
  type AnchoredThreadsResponse,
  type CommandsState,
  type CreateThreadAtRangeResponse,
  type EnqueueCommandResponse,
  type LocalCommentsSummary,
  type MigrateCommentsResponse,
} from "../../../src/lib/collab/local-api";
import type { DocHub } from "../core/doc-hub";
import {
  documentsToMigrate,
  locateLocalAnchor,
  migrationId,
  readReviewDatabase,
  updateReviewDatabase,
  type MigrationMarker,
} from "./review-migration";
import type { Router } from "./router";
import { requireApi } from "./routes-projects";
import type { CollabRuntime } from "./runtime";
import { ControlError } from "./types";
import { aiFeature, bad, objectBody, optionalString, requiredString, stringList } from "./validate";

const pattern = {
  threads: decodeURIComponent(ControlRoutes.threads(":docId")),
  threadsAtRange: decodeURIComponent(ControlRoutes.threadsAtRange(":docId")),
  threadsAnchored: decodeURIComponent(ControlRoutes.threadsAnchored(":docId")),
  thread: decodeURIComponent(ControlRoutes.thread(":threadId")),
  threadMessages: decodeURIComponent(ControlRoutes.threadMessages(":threadId")),
  threadStatus: decodeURIComponent(ControlRoutes.threadStatus(":threadId")),
  threadReattach: decodeURIComponent(ControlRoutes.threadReattach(":threadId")),
  message: decodeURIComponent(ControlRoutes.message(":messageId")),
  command: decodeURIComponent(ControlRoutes.command(":commandId")),
  migrateComments: decodeURIComponent(ControlRoutes.migrateComments(":projectId")),
};

export interface ThreadRouteOptions {
  /** Master directory; `.libera/markdown-reviews.json` under it holds local review comments. */
  libraryRoot: string;
  /** How long the migration waits for a document's first server state. */
  loadTimeoutMs?: number;
}

const CLIENT_ID = /^[A-Za-z0-9_-]{8,80}$/;
const STATUSES: readonly ThreadStatus[] = ["open", "resolved", "detached"];

/** Same rule as the server's clientIdSchema, so a queued command is not refused for its id. */
export function clientId(value: unknown, name: string): string {
  if (typeof value !== "string" || !CLIENT_ID.test(value)) throw bad(`${name} must be 8 to 80 letters, digits, '_' or '-'.`);
  return value;
}

function messageText(value: unknown, name = "body"): string {
  const text = requiredString(value, name, 20_000).trim();
  if (!text) throw bad(`${name} is required.`);
  return text;
}

function mentionList(value: unknown): string[] | undefined {
  return stringList(value, "mentions", 50);
}

function aiHint(value: unknown): AiActorHint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw bad("ai must be an object.");
  const raw = value as Record<string, unknown>;
  const model = optionalString(raw.model, "ai.model", 200);
  const runId = optionalString(raw.runId, "ai.runId", 200);
  return { feature: aiFeature(raw.feature, "ai.feature"), ...(model ? { model } : {}), ...(runId ? { runId } : {}) };
}

function optionalFields<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export function createThreadBody(value: unknown): CreateThreadRequest {
  const body = objectBody(value);
  const quote = typeof body.quote === "string" ? body.quote : "";
  if (quote.length > 10_000) throw bad("quote is too long.");
  return {
    id: clientId(body.id, "id"),
    anchorId: clientId(body.anchorId, "anchorId"),
    quote,
    body: messageText(body.body),
    ...optionalFields({ mentions: mentionList(body.mentions), ai: aiHint(body.ai) }),
  };
}

export function createMessageBody(value: unknown): CreateMessageRequest {
  const body = objectBody(value);
  return { id: clientId(body.id, "id"), body: messageText(body.body), ...optionalFields({ mentions: mentionList(body.mentions), ai: aiHint(body.ai) }) };
}

export function editMessageBody(value: unknown): EditMessageRequest {
  const body = objectBody(value);
  return { body: messageText(body.body), ...optionalFields({ mentions: mentionList(body.mentions) }) };
}

export function statusBody(value: unknown): SetThreadStatusRequest {
  const body = objectBody(value);
  if (!STATUSES.includes(body.status as ThreadStatus)) throw bad("status must be open, resolved or detached.");
  return { status: body.status as ThreadStatus };
}

export function reattachBody(value: unknown): ReattachThreadRequest {
  const body = objectBody(value);
  const quote = typeof body.quote === "string" ? body.quote : "";
  if (quote.length > 10_000) throw bad("quote is too long.");
  return { anchorId: clientId(body.anchorId, "anchorId"), quote };
}

function pathId(value: unknown, name: string): string {
  return requiredString(value, name, 200);
}

/** The commands a window may queue: comments and checkpoints. Decisions keep their own routes. */
export function commandValue(value: unknown): Command {
  const raw = objectBody(value);
  const id = clientId(raw.id, "id");
  switch (raw.kind) {
    case "thread.create":
      return { id, kind: raw.kind, docId: pathId(raw.docId, "docId"), body: createThreadBody(raw.body) };
    case "message.create":
      return { id, kind: raw.kind, threadId: pathId(raw.threadId, "threadId"), body: createMessageBody(raw.body) };
    case "message.edit":
      return { id, kind: raw.kind, messageId: pathId(raw.messageId, "messageId"), body: editMessageBody(raw.body) };
    case "message.delete":
      return { id, kind: raw.kind, messageId: pathId(raw.messageId, "messageId") };
    case "thread.status":
      return { id, kind: raw.kind, threadId: pathId(raw.threadId, "threadId"), body: statusBody(raw.body) };
    case "thread.reattach":
      return { id, kind: raw.kind, threadId: pathId(raw.threadId, "threadId"), body: reattachBody(raw.body) };
    case "thread.delete":
      return { id, kind: raw.kind, threadId: pathId(raw.threadId, "threadId") };
    case "revision.create": {
      const body = raw.body === undefined ? {} : objectBody(raw.body);
      const kind = body.kind;
      if (kind !== undefined && kind !== "named" && kind !== "auto" && kind !== "session-end") throw bad("body.kind must be named, auto or session-end.");
      const label = optionalString(body.label, "body.label", 200);
      return { id, kind: raw.kind, docId: pathId(raw.docId, "docId"), body: optionalFields({ kind, label }) };
    }
    default:
      throw bad("kind must be a thread, message or revision command.");
  }
}

async function whenLoaded(hub: DocHub, timeoutMs: number): Promise<void> {
  if (hub.getStatus().state !== "loading") return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve();
    }, timeoutMs);
    const off = hub.onStatus((status) => {
      if (status.state === "loading") return;
      off();
      clearTimeout(timer);
      resolve();
    });
    if (hub.getStatus().state !== "loading") {
      off();
      clearTimeout(timer);
      resolve();
    }
  });
}

interface MigrationTarget {
  key: string;
  docId: string;
}

function migrationTargets(runtime: CollabRuntime, projectId: string, documents: { key: string }[]): MigrationTarget[] {
  const targets: MigrationTarget[] = [];
  for (const doc of documents) {
    const resolved = runtime.notebooks.resolvePath(doc.key);
    if (resolved && resolved.projectId === projectId) targets.push({ key: doc.key, docId: resolved.docId });
  }
  return targets;
}

function projectNotebook(runtime: CollabRuntime, projectId: string): { notebook: string; role: string } {
  const project = runtime.status().projects.find((item) => item.projectId === projectId);
  if (!project) throw new ControlError(404, "unknown-project", "This notebook is not shared on this machine.");
  return { notebook: project.notebook, role: project.role };
}

export function registerThreadRoutes(router: Router, runtime: CollabRuntime, options: ThreadRouteOptions): void {
  const loadTimeoutMs = options.loadTimeoutMs ?? 5_000;

  router.add("GET", pattern.threads, async (request) => ({ body: await requireApi(runtime).listThreads(request.params.docId) }));

  router.add("POST", pattern.threads, async (request) => {
    const body = createThreadBody(request.body);
    return { status: 201, body: await requireApi(runtime).createThread(request.params.docId, body) };
  });

  // A thread on a range the caller only knows by offsets (the agent's review
  // comments): the anchor is written here, in the host's copy of the
  // document, and syncs like any annotation.
  router.add("POST", pattern.threadsAtRange, async (request): Promise<{ status: number; body: CreateThreadAtRangeResponse }> => {
    const raw = objectBody(request.body);
    const range = raw.range as { start?: unknown; end?: unknown } | undefined;
    const start = Number(range?.start), end = Number(range?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) throw bad("range needs integer offsets with 0 <= start < end.");
    const snapshot = raw.snapshot === undefined || raw.snapshot === null ? undefined : optionalString(raw.snapshot, "snapshot", 2_000_000);
    if (snapshot !== undefined && end > snapshot.length) throw bad("range is outside the snapshot.");
    const threadId = raw.id === undefined ? `thr_${randomBytes(15).toString("hex")}` : clientId(raw.id, "id");
    const body = messageText(raw.body);
    const mentions = mentionList(raw.mentions);
    const ai = aiHint(raw.ai);
    const account = runtime.accounts.account;
    if (!account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
    const host = runtime.host;
    const docId = request.params.docId;
    const record = host.store.getDoc(docId);
    const meta = host.store.getDocMeta(docId);
    if (!record && !meta) throw new ControlError(404, "unknown-doc", `Document ${docId} is not shared with this machine.`);
    const projectId = record?.projectId ?? meta?.projectId ?? undefined;
    const hub = host.acquire(docId, projectId ? { projectId } : {});
    let anchor: { anchorId: string; quote: string };
    try {
      await whenLoaded(hub, loadTimeoutMs);
      const state = hub.getMeta();
      if (state.readOnlyReason === "access-revoked") throw new ControlError(403, "access-changed", "Access to this document was revoked.");
      if (!canWriteSubdoc(state.role, "annotations")) throw new ControlError(403, "forbidden", `A ${state.role} cannot comment in this document.`);
      const text = hub.getText("content");
      let target = { start, end };
      if (snapshot !== undefined) {
        const [mapped] = mapSnapshotEdits(text, snapshot, [{ start, end, before: snapshot.slice(start, end), after: "" }]);
        if (!mapped.matched) throw new ControlError(409, "passage-changed", "The passage changed since it was read; read the document again.");
        target = { start: mapped.start, end: mapped.end };
      } else if (end > text.length) throw bad("range is outside the document.");
      const anchorId = `anc_${randomBytes(15).toString("hex")}`;
      hub.applyLocalChange(
        "annotations",
        (annotations) => {
          const ytext = hub.getDoc("content").getText(ContentKeys.source);
          writeAnchor(annotations, createAnchor(ytext, target.start, target.end, { id: anchorId, kind: "comment", createdBy: account.id }));
        },
        ai ? { source: "ai", feature: ai.feature, ...(ai.runId ? { runId: ai.runId } : {}) } : undefined,
      );
      anchor = { anchorId, quote: text.slice(target.start, target.end) };
    } finally {
      host.release(docId);
    }
    const thread = { id: threadId, anchorId: anchor.anchorId, quote: anchor.quote, body, ...optionalFields({ mentions, ai }) };
    const queue = () => {
      const commandId = `cmd_${randomBytes(12).toString("base64url")}`;
      host.commands.enqueue({ id: commandId, kind: "thread.create", docId, body: thread });
      return { status: 202, body: { queued: true as const, threadId, commandId } };
    };
    const api = host.api;
    if (!api || !runtime.accounts.session || host.connectionState !== "connected") return queue();
    try {
      return { status: 201, body: { queued: false, thread: await api.createThread(docId, thread) } };
    } catch (error) {
      if (error instanceof ApiClientError && (error.transient || error.code === "network" || error.code === "needs-sign-in")) return queue();
      throw error;
    }
  });

  // Threads with their anchors resolved in the host's copy (the agent's
  // ReadComments): Next cannot read the annotations, only offsets into text.
  router.add("GET", pattern.threadsAnchored, async (request): Promise<{ body: AnchoredThreadsResponse }> => {
    const api = requireApi(runtime);
    const accountId = runtime.accounts.account!.id;
    const docId = request.params.docId;
    const host = runtime.host;
    const record = host.store.getDoc(docId);
    const meta = host.store.getDocMeta(docId);
    if (!record && !meta) throw new ControlError(404, "unknown-doc", `Document ${docId} is not shared with this machine.`);
    const threads = await api.listThreads(docId);
    const projectId = record?.projectId ?? meta?.projectId ?? undefined;
    const hub = host.acquire(docId, projectId ? { projectId } : {});
    try {
      await whenLoaded(hub, loadTimeoutMs);
      const ytext = hub.getDoc("content").getText(ContentKeys.source);
      const annotations = hub.getDoc("annotations");
      return {
        body: {
          text: hub.getText("content"),
          accountId,
          threads: threads.map((thread) => {
            const anchor = readAnchor(annotations, thread.anchorId);
            const resolved = anchor ? resolveAnchor(ytext, anchor) : null;
            return { ...thread, range: resolved?.state === "attached" ? { start: resolved.start, end: resolved.end } : null };
          }),
        },
      };
    } finally {
      host.release(docId);
    }
  });

  router.add("GET", pattern.thread, async (request) => ({ body: await requireApi(runtime).getThread(request.params.threadId) }));

  router.add("DELETE", pattern.thread, async (request) => {
    await requireApi(runtime).deleteThread(request.params.threadId);
    return {};
  });

  router.add("POST", pattern.threadMessages, async (request) => {
    const body = createMessageBody(request.body);
    return { status: 201, body: await requireApi(runtime).createMessage(request.params.threadId, body) };
  });

  router.add("POST", pattern.threadStatus, async (request) => ({
    body: await requireApi(runtime).setThreadStatus(request.params.threadId, statusBody(request.body)),
  }));

  router.add("POST", pattern.threadReattach, async (request) => ({
    body: await requireApi(runtime).reattachThread(request.params.threadId, reattachBody(request.body)),
  }));

  router.add("PATCH", pattern.message, async (request) => ({
    body: await requireApi(runtime).editMessage(request.params.messageId, editMessageBody(request.body)),
  }));

  router.add("DELETE", pattern.message, async (request) => {
    await requireApi(runtime).deleteMessage(request.params.messageId);
    return {};
  });

  // ---- offline commands

  router.add("GET", ControlRoutes.commands, (): { body: CommandsState } => {
    const host = runtime.host;
    return {
      body: {
        pending: host.commands.list().map((row) => ({ command: row.command, attempts: row.attempts, lastError: row.lastError })),
        failed: host.commandOutcomes.failed(),
      },
    };
  });

  router.add("POST", ControlRoutes.commands, (request): { status: number; body: EnqueueCommandResponse } => {
    if (!runtime.accounts.account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
    const command = commandValue(request.body);
    const queued = runtime.host.commands.enqueue(command);
    return { status: 202, body: { id: command.id, queued } };
  });

  router.add("DELETE", pattern.command, (request) => {
    if (!runtime.host.commandOutcomes.discard(request.params.commandId)) {
      throw new ControlError(404, "not-found", "No failed command with this id.");
    }
    return {};
  });

  // ---- one-time migration of local review comments

  router.add("GET", pattern.migrateComments, async (request): Promise<{ body: LocalCommentsSummary }> => {
    const { notebook } = projectNotebook(runtime, request.params.projectId);
    const db = await readReviewDatabase(options.libraryRoot);
    const targets = new Set(migrationTargets(runtime, request.params.projectId, documentsToMigrate(db, notebook)).map((target) => target.key));
    const documents = db.documents.filter((doc) => targets.has(doc.key));
    return {
      body: { documents: documents.length, threads: documents.reduce((count, doc) => count + doc.threads.filter((thread) => !thread.migratedTo).length, 0) },
    };
  });

  router.add("POST", pattern.migrateComments, async (request): Promise<{ body: MigrateCommentsResponse }> => {
    const projectId = request.params.projectId;
    const { notebook, role } = projectNotebook(runtime, projectId);
    if (role !== "owner") throw new ControlError(403, "forbidden", "Only the notebook's owner can move its comments.");
    const api = requireApi(runtime);
    const account = runtime.accounts.account;
    if (!account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
    const accountId = account.id;
    const db = await readReviewDatabase(options.libraryRoot);
    const documents = documentsToMigrate(db, notebook);
    const targets = new Map(migrationTargets(runtime, projectId, documents).map((target) => [target.key, target.docId]));
    const markers = new Map<string, Map<string, MigrationMarker>>();
    const result: MigrateCommentsResponse = { documents: 0, threads: 0, detached: 0, skipped: 0 };

    try {
      await migrateDocuments();
    } finally {
      // Whatever reached the server is marked, even when a later document
      // failed: the ids are stable, so running it again only adds the rest.
      if (markers.size) {
        await updateReviewDatabase(options.libraryRoot, (stored) => {
          for (const doc of stored.documents) {
            const moved = markers.get(doc.id);
            if (!moved) continue;
            doc.threads = doc.threads.map((thread) => (moved.has(thread.id) ? { ...thread, migratedTo: moved.get(thread.id) } : thread));
            // The Next side compares revisions before writing; bump it so a
            // window holding the old copy reloads instead of overwriting.
            doc.revision += 1;
          }
        });
      }
    }
    return { body: result };

    async function migrateDocuments(): Promise<void> {
      for (const doc of documents) {
        const docId = targets.get(doc.key);
        if (!docId) continue;
        const host = runtime.host;
        const hub = host.acquire(docId, { projectId });
        const moved = new Map<string, MigrationMarker>();
        try {
          await whenLoaded(hub, loadTimeoutMs);
          const text = hub.getText("content");
          for (const thread of doc.threads) {
            if (thread.migratedTo) {
              result.skipped += 1;
              continue;
            }
            const [first, ...replies] = thread.messages;
            if (!first?.text.trim()) continue;
            const threadId = migrationId("thr", docId, thread.id);
            const anchorId = migrationId("anc", docId, thread.id);
            const range = locateLocalAnchor(thread, text);
            if (range) {
              // Written before the thread so the anchor is in the CRDT when
              // the thread appears in other windows.
              hub.applyLocalChange(
                "annotations",
                (annotations) => {
                  if (readAnchor(annotations, anchorId)) return;
                  const ytext = hub.getDoc("content").getText(ContentKeys.source);
                  writeAnchor(annotations, createAnchor(ytext, range.start, range.end, { id: anchorId, kind: "comment", createdBy: accountId }));
                },
                { source: "import" },
              );
            }
            // Comments the agent left keep that fact as an AI actor; the owner
            // is still their account, as for any AI action on their behalf.
            const ai = (message: { author?: "agent" }): { ai?: AiActorHint } => (message.author === "agent" ? { ai: { feature: "review-comments" } } : {});
            await api.createThread(docId, { id: threadId, anchorId, quote: thread.anchor.quote, body: first.text.trim(), ...ai(first) });
            for (const reply of replies) {
              if (!reply.text.trim()) continue;
              await api.createMessage(threadId, { id: migrationId("msg", docId, thread.id, reply.id), body: reply.text.trim(), ...ai(reply) });
            }
            if (thread.status === "resolved") await api.setThreadStatus(threadId, { status: "resolved" });
            else if (!range) await api.setThreadStatus(threadId, { status: "detached" });
            if (!range) result.detached += 1;
            result.threads += 1;
            moved.set(thread.id, { docId, threadId, at: new Date().toISOString() });
          }
        } finally {
          host.release(docId);
          if (moved.size) markers.set(doc.id, moved);
        }
        if (moved.size) result.documents += 1;
      }
    }
  });
}
