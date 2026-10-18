// Shared setup for the revision, suggestion, review and hard-case tests: a
// real server (REST + sync), a project with one member per role, and
// helpers that write overlay suggestions the way the client library does
// (src/lib/collab/suggestions/model.ts, src/lib/collab/anchors.ts).

import assert from "node:assert/strict";

import * as Y from "yjs";

import type { Config } from "../../src/config.js";
import { newId } from "../../src/ids.js";
import {
  AnnotationKeys,
  type Actor,
  type AnchorRecord,
  type RelativePositionJSON,
  type Role,
  type SuggestionRecord,
} from "../../src/protocol.js";
import { json } from "../helpers.js";
import { createDocument, startSyncEnv, type AccountFixture, type SyncEnv } from "./sync-fixtures.js";
import type { SyncTestClient } from "./sync-client.js";

export interface CollabEnv extends SyncEnv {
  editor: AccountFixture;
  editor2: AccountFixture;
  commenter: AccountFixture;
  viewer: AccountFixture;
  api(method: string, path: string, account: AccountFixture | null, body?: unknown): Promise<{ status: number; body: any }>;
  /** A new markdown document with `text`, opened by `client`. */
  document(client: SyncTestClient, text: string): Promise<string>;
}

export async function startCollab(overrides: Partial<Config> = {}): Promise<CollabEnv> {
  const env = await startSyncEnv(overrides);
  const members: Record<string, AccountFixture> = {};
  for (const [name, role] of [
    ["editor", "editor"],
    ["editor2", "editor"],
    ["commenter", "commenter"],
    ["viewer", "viewer"],
  ] as Array<[string, Role]>) {
    members[name] = await env.member(role);
  }
  return {
    ...env,
    editor: members.editor,
    editor2: members.editor2,
    commenter: members.commenter,
    viewer: members.viewer,
    api: (method, path, account, body) => json(env.server.url, path, { method, body, token: account?.token }),
    async document(client, text) {
      const docId = await createDocument(env.db, env.project.id, { createdBy: env.owner.id });
      await client.open(docId);
      if (text) await client.acked(client.edit(docId, "content", (doc) => doc.getText("source").insert(0, text)));
      return docId;
    },
  };
}

function toJSON(position: Y.RelativePosition): RelativePositionJSON {
  const raw = Y.relativePositionToJSON(position) as RelativePositionJSON;
  const plain: RelativePositionJSON = {};
  if (raw.type) plain.type = { client: raw.type.client, clock: raw.type.clock };
  if (raw.tname) plain.tname = raw.tname;
  if (raw.item) plain.item = { client: raw.item.client, clock: raw.item.clock };
  if (raw.assoc !== undefined) plain.assoc = raw.assoc;
  return plain;
}

/** The client library's relativeRange: insertion points point at both neighbours. */
export function relativeRange(text: Y.Text, start: number, end: number): { start: RelativePositionJSON; end: RelativePositionJSON } {
  if (start === end) {
    return {
      start: toJSON(Y.createRelativePositionFromTypeIndex(text, start, -1)),
      end: toJSON(Y.createRelativePositionFromTypeIndex(text, start, 0)),
    };
  }
  return {
    start: toJSON(Y.createRelativePositionFromTypeIndex(text, start, 0)),
    end: toJSON(Y.createRelativePositionFromTypeIndex(text, end, -1)),
  };
}

export interface SuggestOptions {
  id?: string;
  /** Range in the client's current text; defaults to the first occurrence of `quote`. */
  start?: number;
  end?: number;
  quote?: string;
  replacement: string;
  groupId?: string;
  actor?: Actor;
  /** Overrides the quote captured from the text (an AI edit computed on an old snapshot). */
  baseQuote?: string;
  status?: "pending" | "stale";
}

/** Writes an overlay suggestion through the sync socket and waits for the ack. */
export async function suggest(client: SyncTestClient, docId: string, account: AccountFixture, options: SuggestOptions): Promise<SuggestionRecord> {
  const text = client.doc(docId, "content").getText("source");
  let start = options.start;
  let end = options.end;
  if (start === undefined) {
    assert.ok(options.quote !== undefined, "suggest needs start/end or quote");
    start = text.toString().indexOf(options.quote);
    assert.ok(start >= 0, `quote ${JSON.stringify(options.quote)} is not in the text`);
    end = start + options.quote.length;
  }
  end ??= start;
  const range = relativeRange(text, start, end);
  const now = Date.now();
  const record: SuggestionRecord = {
    id: options.id ?? newId("sg"),
    actor: options.actor ?? { kind: "user", userId: account.id },
    createdBy: account.id,
    start: range.start,
    end: range.end,
    baseQuote: options.baseQuote ?? text.toString().slice(start, end),
    replacement: options.replacement,
    status: options.status ?? "pending",
    createdAt: now,
    updatedAt: now,
  };
  if (options.groupId) record.groupId = options.groupId;
  if (record.status === "stale") record.staleReason = "text-changed";
  await client.acked(client.edit(docId, "annotations", (doc) => doc.getMap(AnnotationKeys.suggestions).set(record.id, record)));
  return record;
}

/** Writes a comment/review-scope anchor over text[start, end). */
export async function anchor(client: SyncTestClient, docId: string, account: AccountFixture, start: number, end: number): Promise<AnchorRecord> {
  const text = client.doc(docId, "content").getText("source");
  const range = relativeRange(text, start, end);
  const record: AnchorRecord = { id: newId("anc"), kind: "review-scope", start: range.start, end: range.end, createdBy: account.id, createdAt: Date.now() };
  await client.acked(client.edit(docId, "annotations", (doc) => doc.getMap(AnnotationKeys.anchors).set(record.id, record)));
  return record;
}

/** Edits the client's text: replaces text[start, end) with `insert`. */
export async function edit(client: SyncTestClient, docId: string, start: number, end: number, insert: string): Promise<number> {
  const ack = await client.acked(
    client.edit(docId, "content", (doc) => {
      const text = doc.getText("source");
      if (end > start) text.delete(start, end - start);
      if (insert) text.insert(start, insert);
    }),
  );
  return ack.serverSeq;
}

/** Index of `needle` in the client's text (asserting it occurs). */
export function at(client: SyncTestClient, docId: string, needle: string): number {
  const index = client.text(docId).indexOf(needle);
  assert.ok(index >= 0, `${JSON.stringify(needle)} is not in ${JSON.stringify(client.text(docId))}`);
  return index;
}

/** The server's live text of a document. */
export function serverText(env: SyncEnv, docId: string): Promise<string> {
  return env.server.server.context.rooms.withDocs(docId, (docs) => docs.content.getText("source").toString());
}

/** The server's overlay record. */
export function serverRecord(env: SyncEnv, docId: string, id: string): Promise<SuggestionRecord | undefined> {
  return env.server.server.context.rooms.withDocs(
    docId,
    (docs) => docs.annotations.getMap<SuggestionRecord>(AnnotationKeys.suggestions).get(id),
  );
}

export async function waitUntil(check: () => boolean | Promise<boolean>, message: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

export function decide(env: CollabEnv, account: AccountFixture, docId: string, decisions: Array<[string, "accept" | "reject"]>, extra: Record<string, unknown> = {}) {
  return env.api("POST", `/v1/documents/${docId}/suggestions/decisions`, account, {
    decisions: decisions.map(([suggestionId, decision]) => ({ suggestionId, decision })),
    ...extra,
  });
}

export function outcomes(response: { body: any }): Record<string, string> {
  return Object.fromEntries((response.body.results as Array<{ suggestionId: string; outcome: string }>).map((r) => [r.suggestionId, r.outcome]));
}
