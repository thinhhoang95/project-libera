import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as review } from "../../src/app/api/markdown-reviews/route";
import { POST as agent } from "../../src/app/api/document-review/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import { readReview, loadReview, moveReviewPath, copyReviewPath, deleteReviewPath, updateReview } from "../../src/lib/storage/markdown-reviews";
import type { ReviewDocument } from "../../src/lib/markdown-review";

function request(body: unknown, authenticated = true) { return new NextRequest("http://localhost/api/review", { method: "POST", headers: authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {}, body: JSON.stringify(body) }); }
test("authenticated review plans, revises, confirms, accepts/rejects individually, persists, and handles stale output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-review-route-"));
  const env = { LIBERA_DATA_DIR: process.env.LIBERA_DATA_DIR, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, LIBERA_OPENROUTER_MODEL: process.env.LIBERA_OPENROUTER_MODEL, LIBERA_CONFIG_PATH: process.env.LIBERA_CONFIG_PATH };
  process.env.LIBERA_DATA_DIR = directory; process.env.OPENROUTER_API_KEY = "test-key"; process.env.LIBERA_OPENROUTER_MODEL = "test/model"; process.env.LIBERA_CONFIG_PATH = path.join(directory, "missing.json");
  const originalFetch = globalThis.fetch;
  let modelCalls = 0, bad = false, capacity = 200_000, stale = false, expectFreshRound = false;
  let doc: ReviewDocument;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test/model", context_length: capacity }] });
    modelCalls++;
    const body = JSON.parse(String(init?.body));
    const context = JSON.parse(body.messages[1].content);
    if (expectFreshRound) {
      assert.equal(context.previousPlan, undefined);
      assert.equal(context.history, undefined);
      assert.equal(context.decisions, undefined);
    }
    assert.equal(context.target.markdown, doc.snapshot);
    assert.equal(context.references[0].text, "Full unsaved reference");
    if (stale) { stale = false; await updateReview(doc.id, doc.revision, (d) => ({ ...d, enabled: !d.enabled })); }
    const content = bad ? "invalid JSON" : body.messages[0].content.includes("stage is PLAN") ? JSON.stringify({ summary: "Clarify both passages", steps: context.comments.map((c: { id: string }, i: number) => ({ commentIds: [c.id], targetBlockIds: [`b${i + 1}`], proposedChange: "Clarify", rationale: "Use reference.md" })), dispositions: [], blockingQuestions: [], revisionSummary: "Updated plan" }) : JSON.stringify({ proposals: context.comments.map((c: { id: string }, i: number) => ({ title: `Change ${i + 1}`, reason: "Clarity", commentIds: [c.id], edits: [{ targetBlockId: `b${i + 1}`, before: context.target.blocks[i].text, after: `Changed passage ${i + 1}.` }] })), summary: "Review each proposed change." });
    return Response.json({ choices: [{ message: { content } }] });
  };
  async function mutate(action: string, fields = {}) {
    const response = await review(request({ action, id: doc.id, revision: doc.revision, snapshot: doc.snapshot, ...fields }));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    doc = await response.json();
  }
  async function plan(action: string, fields = {}) {
    return agent(request({ action, id: doc.id, revision: doc.revision, snapshot: doc.snapshot, planVersion: doc.session?.plan.version, prompt: "Please improve clarity", ids: doc.threads.map((t) => t.id), references: [{ kind: "document", name: "reference.md", path: "Notes/reference.md", text: "Full unsaved reference" }], ...fields }));
  }
  try {
    assert.equal((await review(request({}, false))).status, 401);
    assert.equal((await agent(request({}, false))).status, 401);
    doc = await (await review(request({ action: "load", key: "Notes/a.md", snapshot: "First paragraph.\n\nSecond paragraph." }))).json();
    await mutate("comment", { range: { start: 0, end: 16 }, text: "Improve first." });
    await mutate("comment", { range: { start: 18, end: 35 }, text: "Improve second." });
    const original = doc.snapshot;
    assert.equal((await plan("generate")).status, 400);
    let response = await plan("plan"); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); doc = await response.json();
    assert.equal(doc.snapshot, original); assert.equal(doc.session?.plan.version, 1);
    response = await plan("plan"); doc = await response.json(); assert.equal(doc.session?.plan.version, 2);
    assert.equal((await plan("generate", { planVersion: 1 })).status, 409);
    response = await plan("generate"); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); doc = await response.json();
    assert.equal(doc.snapshot, original); assert.equal(doc.session?.suggestions.length, 2);
    assert.equal((await plan("generate")).status, 400);
    const ids = doc.session!.suggestions.map((s) => s.id);
    await mutate("decision", { ids: [ids[0]], decision: "accept" });
    assert.equal(doc.snapshot, "Changed passage 1.\n\nSecond paragraph.");
    assert.equal(doc.session?.suggestions[1].status, "pending");
    await mutate("decision", { ids: [ids[1]], decision: "reject" });
    assert.equal(doc.session?.phase, "completed"); assert.equal(doc.threads[1].status, "open");
    assert.equal((await readReview(doc.id)).snapshot, doc.snapshot);
    await mutate("undo"); assert.equal(doc.snapshot, original);
    // Full regeneration with failed output leaves the previous accepted state untouched.
    bad = true; const prior = await readReview(doc.id); const beforeCalls = modelCalls;
    assert.equal((await plan("plan")).status, 400); assert.equal(modelCalls - beforeCalls, 3); assert.deepEqual(await readReview(doc.id), prior); bad = false;
    capacity = 200; const beforeLimit = modelCalls; assert.equal((await plan("plan")).status, 400); assert.equal(modelCalls, beforeLimit); capacity = 200_000;
    stale = true; assert.equal((await plan("plan")).status, 409);
    doc = await readReview(doc.id);
    const previousRound = structuredClone(doc), beforeRestartCalls = modelCalls;
    await mutate("new-round");
    assert.equal(modelCalls, beforeRestartCalls, "Starting a round must not invoke the model.");
    assert.equal(doc.snapshot, previousRound.snapshot);
    assert.deepEqual(doc.threads, previousRound.threads);
    assert.deepEqual(doc.previousRounds, [{ number: 1, session: previousRound.session }]);
    assert.equal(doc.session, undefined);
    assert.equal(doc.round, 2);
    assert.equal((await plan("generate")).status, 400);
    const outdated = await review(request({ action: "new-round", id: doc.id, revision: previousRound.revision, snapshot: doc.snapshot }));
    assert.equal(outdated.status, 409);
    expectFreshRound = true;
    response = await plan("plan"); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); doc = await response.json();
    assert.equal(doc.session?.plan.version, 1);
    assert.notEqual(doc.session?.id, previousRound.session?.id);
    assert.deepEqual((await readReview(doc.id)).previousRounds, doc.previousRounds);
    expectFreshRound = false;
    await moveReviewPath("Notes", "Renamed"); assert.equal((await readReview(doc.id)).key, "Renamed/a.md");
    await copyReviewPath("Renamed/a.md", "Renamed/copy.md"); const copied = await loadReview("Renamed/copy.md", doc.snapshot); assert.notEqual(copied.id, doc.id); assert.notEqual(copied.threads[0].id, doc.threads[0].id); assert.equal(copied.session, undefined);
    await deleteReviewPath("Renamed"); await assert.rejects(readReview(doc.id));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});
test("unsaved review recovery preserves identity on first save and concurrent writes fail closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-review-recovery-"));
  const prior = process.env.LIBERA_DATA_DIR; process.env.LIBERA_DATA_DIR = directory;
  try {
    const draft = await loadReview("draft:untitled-recovered.md", "Unsaved text.");
    const response = await review(request({ action: "comment", id: draft.id, revision: draft.revision, snapshot: draft.snapshot, range: { start: 0, end: 13 }, text: "Clarify this draft." }));
    assert.equal(response.status, 200);
    const commented = await response.json() as ReviewDocument;
    const { GET } = await import("../../src/app/api/markdown-reviews/route");
    const recovered = await GET(new NextRequest("http://localhost/api/markdown-reviews?drafts=1", { headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } }));
    const rows = await recovered.json(); assert.equal(rows[0].id, draft.id); assert.equal(rows[0].snapshot, "Unsaved text.");
    const writes = await Promise.allSettled([updateReview(draft.id, commented.revision, d => ({ ...d, enabled: true })), updateReview(draft.id, commented.revision, d => ({ ...d, enabled: false }))]);
    assert.equal(writes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(writes.filter(r => r.status === "rejected").length, 1);
    const moved = await review(request({ action: "migrate-path", from: draft.key, to: "Notebook/saved.md", snapshot: draft.snapshot }));
    assert.equal(moved.status, 200);
    const loaded = await loadReview("Notebook/saved.md", draft.snapshot);
    assert.equal(loaded.id, draft.id); assert.equal(loaded.threads[0].id, commented.threads[0].id);
  } finally { if (prior === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = prior; await rm(directory, { recursive: true, force: true }); }
});

test('existing review loads are read-only and concurrent creation preserves one identity', async () => {
  const { stat, readFile } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'libera-review-readonly-'));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    const created = await Promise.all(Array.from({ length: 5 }, () => loadReview('Notes/existing.md', 'Initial snapshot.')));
    assert.equal(new Set(created.map(doc => doc.id)).size, 1);
    const { getAdminRoot } = await import('../../src/lib/storage/paths');
    const target = path.join(getAdminRoot(), '.libera', 'markdown-reviews.json');
    const before = await stat(target);
    const contents = await readFile(target, 'utf8');
    const doc = await loadReview('Notes/existing.md', 'Unsaved replacement must not overwrite recovery.');
    const after = await stat(target);
    assert.equal(doc.snapshot, 'Initial snapshot.');
    assert.equal(after.ino, before.ino, 'No atomic rewrite on read');
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(await readFile(target, 'utf8'), contents);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
