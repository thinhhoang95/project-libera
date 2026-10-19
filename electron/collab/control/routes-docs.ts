// Control routes: shared documents for in-process callers (the agent, AI
// features, Next routes). Edits go through DocHub.applyLocalChange, so they
// are persisted, broadcast to open editors and synced like typing, and carry
// the caller's provenance to the server's update log.
//
// A request acquires the doc's hub only for its own duration; open editors
// hold their own references through their MessagePorts.

import type { Actor, AiActorHint } from "../../../src/lib/collab/protocol/actor";
import { canWriteSubdoc, type Subdoc } from "../../../src/lib/collab/protocol/roles";
import { ContentKeys } from "../../../src/lib/collab/protocol/schema";
import {
  ControlRoutes,
  type ApplyEditsResponse,
  type CreateSuggestionsResponse,
  type DocText,
  type ResolvedDoc,
  type TextEdit,
  type WithdrawSuggestionsResponse,
} from "../../../src/lib/collab/local-api";
import type { SuggestionRecord } from "../../../src/lib/collab/protocol/schema";
import { createSuggestion, listSuggestions, suggestionsFromSnapshotEdits, withdrawSuggestion } from "../../../src/lib/collab/suggestions/model";
import type { DocHub } from "../core/doc-hub";
import type { Router } from "./router";
import type { CollabRuntime } from "./runtime";
import { ControlError } from "./types";
import { aiFeature, bad, objectBody, optionalString, provenanceValue, requiredString, stringList, textEdits } from "./validate";

const pattern = {
  doc: decodeURIComponent(ControlRoutes.doc(":docId")),
  docText: decodeURIComponent(ControlRoutes.docText(":docId")),
  docEdits: decodeURIComponent(ControlRoutes.docEdits(":docId")),
  docSuggestions: decodeURIComponent(ControlRoutes.docSuggestions(":docId")),
  docSuggestionsWithdraw: decodeURIComponent(ControlRoutes.docSuggestionsWithdraw(":docId")),
};

/** Same cap as the agentic-review routes put on a document snapshot. */
const MAX_SNAPSHOT_CHARS = 2_000_000;

/** How long a request waits for a doc's first server state before answering. */
const LOAD_TIMEOUT_MS = 5_000;

export interface DocRouteOptions {
  loadTimeoutMs?: number;
}

async function whileLoading(hub: DocHub, timeoutMs: number): Promise<void> {
  if (hub.getStatus().state !== "loading") return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = hub.onStatus((status) => {
      if (status.state === "loading") return;
      off();
      if (timer) clearTimeout(timer);
      resolve();
    });
    timer = setTimeout(() => {
      off();
      resolve();
    }, timeoutMs);
    // The status may have changed between the check and the subscription.
    if (hub.getStatus().state !== "loading") {
      off();
      clearTimeout(timer);
      resolve();
    }
  });
}

/** Acquires the doc for the duration of `work`, after its first load. */
async function withDoc<T>(runtime: CollabRuntime, docId: string, timeoutMs: number, work: (hub: DocHub) => Promise<T> | T): Promise<T> {
  const host = runtime.host;
  const store = host.store;
  const record = store.getDoc(docId);
  const meta = store.getDocMeta(docId);
  // Opening an unknown id would create an empty local doc and ask the server
  // for it; only documents this machine knows about are served.
  if (!record && !meta) throw new ControlError(404, "unknown-doc", `Document ${docId} is not shared with this machine.`);
  const projectId = record?.projectId ?? meta?.projectId ?? undefined;
  const hub = host.acquire(docId, projectId ? { projectId } : {});
  try {
    await whileLoading(hub, timeoutMs);
    return await work(hub);
  } finally {
    host.release(docId);
  }
}

function assertFileDoc(hub: DocHub): void {
  if (hub.kind !== "file") throw bad("This route serves file documents, not the project manifest.");
}

function assertWritable(hub: DocHub, subdoc: Subdoc): void {
  const meta = hub.getMeta();
  if (meta.readOnlyReason === "document-deleted") throw new ControlError(410, "document-deleted", "This file was deleted. Its local text is kept for export.");
  if (meta.readOnlyReason === "access-revoked") throw new ControlError(403, "access-changed", "Access to this document was revoked.");
  if (meta.readOnlyReason === "schema-newer") throw new ControlError(403, "update-required", "This document needs a newer Libera.");
  if (!canWriteSubdoc(meta.role, subdoc)) {
    throw new ControlError(403, "forbidden", subdoc === "content" ? `A ${meta.role} cannot edit this document.` : `A ${meta.role} cannot suggest in this document.`);
  }
}

/**
 * Refuses writes to a doc this machine has no state for and cannot fetch
 * now: offsets from the caller would be applied to an empty text that later
 * merges with the real one.
 */
function assertHasState(runtime: CollabRuntime, hub: DocHub): void {
  const status = hub.getStatus();
  if (status.state === "loading") throw new ControlError(503, "doc-loading", "The document is still loading from the server.");
  if (status.connected) return;
  const seen = runtime.host.store.getDocMeta(hub.docId)?.lastSeenServerSeq ?? 0;
  if (seen === 0 && hub.pendingCount === 0 && hub.getText("content") === "") {
    throw new ControlError(503, "doc-unavailable", "This document has not been downloaded yet. Connect to the collaboration server first.");
  }
}

/** Index of the first edit whose range or `before` no longer matches `text`, or -1. */
export function firstConflict(text: string, edits: readonly TextEdit[]): number {
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (edit.end > text.length) return index;
    if (edit.before !== undefined && text.slice(edit.start, edit.end) !== edit.before) return index;
  }
  return -1;
}

function aiHint(value: unknown): AiActorHint | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") throw bad("ai must be an object.");
  const raw = value as Record<string, unknown>;
  const model = optionalString(raw.model, "ai.model", 200);
  const runId = optionalString(raw.runId, "ai.runId", 200);
  return { feature: aiFeature(raw.feature, "ai.feature"), ...(model ? { model } : {}), ...(runId ? { runId } : {}) };
}

/** The actor stored in suggestion records: the user, or AI on the user's behalf. Plain JSON, no undefined fields. */
function suggestionActor(accountId: string, clientId: string | null, hint: AiActorHint | null): Actor {
  const client = clientId ? { clientId } : {};
  if (!hint) return { kind: "user", userId: accountId, ...client };
  return {
    kind: "ai",
    onBehalfOf: accountId,
    ...client,
    feature: hint.feature,
    ...(hint.model ? { model: hint.model } : {}),
    ...(hint.runId ? { runId: hint.runId } : {}),
  };
}

export function registerDocRoutes(router: Router, runtime: CollabRuntime, options: DocRouteOptions = {}): void {
  const timeoutMs = options.loadTimeoutMs ?? LOAD_TIMEOUT_MS;

  router.add("GET", ControlRoutes.resolve, (request): { body: ResolvedDoc | null } => {
    const liberaPath = requiredString(request.query.get("path"), "path", 4096);
    return { body: runtime.notebooks.resolvePath(liberaPath) };
  });

  // The reverse of resolve (a notification about a docId opens its file).
  // "/docs/resolve" is a literal route, so it wins over this pattern.
  router.add("GET", pattern.doc, (request): { body: ResolvedDoc } => {
    const resolved = runtime.notebooks.resolveDoc?.(request.params.docId) ?? null;
    if (!resolved) throw new ControlError(404, "unknown-doc", `Document ${request.params.docId} is not in a shared notebook on this machine.`);
    return { body: resolved };
  });

  router.add("GET", pattern.docText, (request) =>
    withDoc(runtime, request.params.docId, timeoutMs, (hub): { body: DocText } => ({
      body: { docId: hub.docId, text: hub.getText(), status: hub.getStatus() },
    })),
  );

  router.add("POST", pattern.docEdits, async (request) => {
    const body = objectBody(request.body);
    const edits = textEdits(body.edits);
    const provenance = provenanceValue(body.provenance);
    return withDoc(runtime, request.params.docId, timeoutMs, (hub): { body: ApplyEditsResponse } => {
      assertFileDoc(hub);
      assertWritable(hub, "content");
      assertHasState(runtime, hub);
      const current = hub.getText("content");
      const conflictAt = firstConflict(current, edits);
      if (conflictAt >= 0) return { body: { applied: false, text: current, conflictAt } };
      // One transaction, so one persisted update, one broadcast and one
      // provenance. Offsets refer to the text before any edit: apply from
      // the back so earlier offsets stay valid.
      hub.applyLocalChange(
        "content",
        (doc) => {
          const ytext = doc.getText(ContentKeys.source);
          for (let index = edits.length - 1; index >= 0; index--) {
            const edit = edits[index];
            if (edit.end > edit.start) ytext.delete(edit.start, edit.end - edit.start);
            if (edit.text) ytext.insert(edit.start, edit.text);
          }
        },
        provenance,
      );
      return { body: { applied: true, text: hub.getText("content") } };
    });
  });

  router.add("POST", pattern.docSuggestions, async (request) => {
    const body = objectBody(request.body);
    const edits = textEdits(body.edits);
    const hint = aiHint(body.ai);
    const groupId = optionalString(body.groupId, "groupId", 200);
    const reason = optionalString(body.reason, "reason", 20_000);
    const title = optionalString(body.title, "title", 500);
    const threadIds = stringList(body.threadIds, "threadIds");
    const snapshot = body.snapshot === undefined || body.snapshot === null ? undefined : optionalString(body.snapshot, "snapshot", MAX_SNAPSHOT_CHARS);
    if (snapshot !== undefined) {
      edits.forEach((edit, index) => {
        if (edit.before === undefined) throw bad(`edits[${index}].before is required with a snapshot.`);
        if (edit.end > snapshot.length) throw bad(`edits[${index}] is outside the snapshot.`);
      });
    }
    const account = runtime.accounts.account;
    if (!account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
    const actor = suggestionActor(account.id, runtime.clientId, hint);
    return withDoc(runtime, request.params.docId, timeoutMs, (hub): { status: number; body: CreateSuggestionsResponse } => {
      assertFileDoc(hub);
      assertWritable(hub, "annotations");
      assertHasState(runtime, hub);
      const ytext = hub.getDoc("content").getText(ContentKeys.source);
      const current = ytext.toString();
      const suggestionIds: string[] = [];
      const staleIndexes: number[] = [];
      const provenance = hint ? { source: "ai" as const, feature: hint.feature, ...(hint.model ? { model: hint.model } : {}), ...(hint.runId ? { runId: hint.runId } : {}) } : undefined;
      const extra = { ...(groupId ? { groupId } : {}), ...(reason ? { reason } : {}), ...(title ? { title } : {}), ...(threadIds ? { threadIds } : {}) };
      if (snapshot !== undefined) {
        // Edits made against an older text: mapped through the diff to the
        // live text, or stale where their passage changed meanwhile.
        hub.applyLocalChange(
          "annotations",
          (doc) => {
            const created = suggestionsFromSnapshotEdits(current, snapshot, edits.map((edit) => ({ start: edit.start, end: edit.end, before: edit.before!, after: edit.text })), {
              ytext,
              target: doc,
              actor,
              createdBy: account.id,
              ...extra,
            });
            created.suggestions.forEach((record, index) => {
              suggestionIds.push(record.id);
              if (record.status === "stale") staleIndexes.push(index);
            });
          },
          provenance,
        );
        return { status: 201, body: { suggestionIds, staleIndexes } };
      }
      // The server only accepts new suggestions as "pending". A suggestion
      // whose `before` no longer matches keeps that `before` as its
      // baseQuote, so resolveSuggestion reports it stale (text-changed) to
      // every client, with what the caller saw next to what is there now.
      hub.applyLocalChange(
        "annotations",
        (doc) => {
          edits.forEach((edit, index) => {
            const end = Math.min(edit.end, current.length);
            const start = Math.min(edit.start, end);
            const live = current.slice(start, end);
            const stale = edit.end > current.length || (edit.before !== undefined && edit.before !== live);
            if (stale) staleIndexes.push(index);
            const record = createSuggestion(doc, {
              ytext,
              start,
              end,
              replacement: edit.text,
              actor,
              createdBy: account.id,
              baseQuote: stale ? (edit.before ?? live) : live,
              ...extra,
            });
            suggestionIds.push(record.id);
          });
        },
        provenance,
      );
      return { status: 201, body: { suggestionIds, staleIndexes } };
    });
  });

  router.add("POST", pattern.docSuggestionsWithdraw, async (request) => {
    const body = objectBody(request.body);
    const ids = stringList(body.suggestionIds, "suggestionIds", 1000);
    const runId = optionalString(body.runId, "runId", 200);
    const groupId = optionalString(body.groupId, "groupId", 200);
    if (!ids?.length && !runId && !groupId) throw bad("Name the suggestions to withdraw: suggestionIds, runId or groupId.");
    const account = runtime.accounts.account;
    if (!account) throw new ControlError(409, "signed-out", "Sign in to a collaboration account first.");
    return withDoc(runtime, request.params.docId, timeoutMs, (hub): { body: WithdrawSuggestionsResponse } => {
      assertFileDoc(hub);
      assertWritable(hub, "annotations");
      const withdrawn: string[] = [];
      const skipped: WithdrawSuggestionsResponse["skipped"] = [];
      const matches = (record: SuggestionRecord) => !!ids?.includes(record.id)
        || (!!runId && record.actor.kind === "ai" && record.actor.runId === runId)
        || (!!groupId && record.groupId === groupId);
      const targets = listSuggestions(hub.getDoc("annotations")).filter(matches);
      if (!targets.length) return { body: { withdrawn, skipped } };
      hub.applyLocalChange("annotations", (doc) => {
        for (const record of targets) {
          if (record.createdBy !== account.id) { skipped.push({ suggestionId: record.id, status: record.status, reason: "not-owner" }); continue; }
          const result = withdrawSuggestion(doc, record.id, account.id);
          if (result.ok) withdrawn.push(record.id);
          else skipped.push({ suggestionId: record.id, status: record.status, reason: "decided" });
        }
      });
      return { body: { withdrawn, skipped } };
    });
  });
}
