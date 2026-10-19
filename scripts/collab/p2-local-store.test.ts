// LocalReviewStore parity (plan M2.1): the store sends exactly the requests
// Review Mode always sent, so a local document's review ends up identical to
// the same operations made directly against /api/markdown-reviews.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET, POST } from "../../src/app/api/markdown-reviews/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import type { ReviewDocument } from "../../src/lib/markdown-review";
import { readReview } from "../../src/lib/storage/markdown-reviews";
import { LocalReviewStore } from "../../src/lib/collab/review-store/local";
import type { ReviewStore } from "../../src/lib/collab/review-store/types";

/** apiRequest's contract, served by the route handlers in-process. */
function routeRequest(log: { url: string; body: unknown }[]) {
  return async <T>(url: string, init?: RequestInit): Promise<T> => {
    log.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const request = new NextRequest(`http://localhost${url}`, { method: init?.method ?? "GET", body: init?.body as string | undefined, headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } });
    const response = (init?.method ?? "GET") === "GET" ? await GET(request) : await POST(request);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Request failed.");
    return payload as T;
  };
}

function normalized(doc: ReviewDocument) {
  return {
    revision: doc.revision,
    snapshot: doc.snapshot,
    threads: doc.threads.map((thread) => ({ anchor: thread.anchor, status: thread.status, messages: thread.messages.map((message) => message.text) })),
  };
}

test("LocalReviewStore matches direct review route calls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-p2-local-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    let text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const log: { url: string; body: unknown }[] = [];
    const request = routeRequest(log);
    const store = new LocalReviewStore({ key: "Notes/store.md", snapshot: () => text, request });
    const seen: ReviewDocument[] = [];
    const off = store.subscribe((doc) => seen.push(doc));
    const reviewStore: ReviewStore = store;
    assert.equal(reviewStore.kind, "local");

    // The same operations straight through the route, on another key.
    const direct = routeRequest([]);
    let raw = await direct<ReviewDocument>("/api/markdown-reviews", { method: "POST", body: JSON.stringify({ action: "load", key: "Notes/direct.md", snapshot: text }) });
    const rawAction = async (action: string, fields: Record<string, unknown>) => {
      raw = await direct<ReviewDocument>("/api/markdown-reviews", { method: "POST", body: JSON.stringify({ ...fields, action, id: raw.id, revision: raw.revision, snapshot: text }) });
      return raw;
    };

    let doc = await store.load();
    assert.deepEqual(log[0].body, { action: "load", key: "Notes/store.md", snapshot: text });
    doc = await store.comment({ range: { start: 0, end: 16 }, text: "About the first" });
    await rawAction("comment", { range: { start: 0, end: 16 }, text: "About the first" });
    const threadId = doc.threads[0].id;
    const rawThread = raw.threads[0].id;
    doc = await store.reply({ threadId, text: "A reply" });
    await rawAction("reply", { threadId: rawThread, text: "A reply" });
    doc = await store.edit({ threadId, messageId: doc.threads[0].messages[0].id, text: "About the first, edited" });
    await rawAction("edit", { threadId: rawThread, messageId: raw.threads[0].messages[0].id, text: "About the first, edited" });
    // The text changes under the anchors before the next operations.
    text = `Intro.\n\n${text}`;
    doc = await store.resolve({ threadId, resolved: true });
    await rawAction("resolve", { threadId: rawThread, resolved: true });
    assert.equal(doc.threads[0].anchor.start, 8, "anchors are mapped onto the new snapshot");
    doc = await store.reattach({ threadId, range: { start: 26, end: 43 } });
    await rawAction("reattach", { threadId: rawThread, range: { start: 26, end: 43 } });
    assert.equal(doc.threads[0].anchor.quote, "Second paragraph.");
    assert.deepEqual(normalized(doc), normalized(raw));
    assert.deepEqual(normalized(await readReview(doc.id)), normalized(doc), "what the store returned is what was stored");

    // The request bodies are the route's own: { ...fields, action, id, revision, snapshot }.
    const commentBody = log.find((entry) => (entry.body as { action?: string })?.action === "comment")!.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(commentBody).sort(), ["action", "id", "range", "revision", "snapshot", "text"]);

    doc = await store.delete({ threadId });
    await rawAction("delete", { threadId: rawThread });
    assert.deepEqual(normalized(doc), normalized(raw));
    assert.equal(doc.threads.length, 0);
    assert.equal(seen.length, 7, "subscribers hear every change");
    assert.deepEqual((await store.read(doc.id)).threads, []);
    off();

    // A stale revision is refused as before.
    const stale = new LocalReviewStore({ key: "Notes/store.md", snapshot: () => text, request });
    stale.setDocument({ ...doc, revision: doc.revision - 1 });
    await assert.rejects(stale.comment({ range: { start: 0, end: 6 }, text: "x" }), /another window/);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
