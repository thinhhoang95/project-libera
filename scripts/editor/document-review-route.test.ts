import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as review } from "../../src/app/api/markdown-reviews/route";
import { POST as agent } from "../../src/app/api/document-review/route";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../src/lib/auth";
import { readReview, loadReview, moveReviewPath, copyReviewPath, deleteReviewPath, updateReview } from "../../src/lib/storage/markdown-reviews";
import { addReviewEdit, anchorAt, newReview, replayReviewEdits, ReviewDraftTracker, syncReview, type ReviewDocument, type ReviewTextEdit } from "../../src/lib/markdown-review";

function request(body: unknown, authenticated = true) { return new NextRequest("http://localhost/api/review", { method: "POST", headers: authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {}, body: JSON.stringify(body) }); }
test("authenticated review plans, revises, confirms, accepts/rejects individually, persists, and handles stale output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-review-route-"));
  const env = { LIBERA_DATA_DIR: process.env.LIBERA_DATA_DIR, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, LIBERA_OPENROUTER_MODEL: process.env.LIBERA_OPENROUTER_MODEL, LIBERA_CONFIG_PATH: process.env.LIBERA_CONFIG_PATH };
  process.env.LIBERA_DATA_DIR = directory; process.env.OPENROUTER_API_KEY = "test-key"; process.env.LIBERA_OPENROUTER_MODEL = "test/model"; process.env.LIBERA_CONFIG_PATH = path.join(directory, "missing.json");
  const originalFetch = globalThis.fetch;
  let modelCalls = 0, bad = false, capacity = 200_000, stale = false, expectFreshRound = false;
  let doc: ReviewDocument;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/endpoints")) return Response.json({ data: { endpoints: [{ tag: "test-provider", supports_implicit_caching: true }] } });
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
    // Two real changes at one revision (a change that changes nothing takes no revision).
    const writes = await Promise.allSettled([updateReview(draft.id, commented.revision, d => ({ ...d, enabled: true })), updateReview(draft.id, commented.revision, d => ({ ...d, threads: [] }))]);
    assert.equal(writes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(writes.filter(r => r.status === "rejected").length, 1);
    const moved = await review(request({ action: "migrate-path", from: draft.key, to: "Notebook/saved.md", snapshot: draft.snapshot }));
    assert.equal(moved.status, 200);
    const loaded = await loadReview("Notebook/saved.md", draft.snapshot);
    assert.equal(loaded.id, draft.id);
    assert.deepEqual(loaded.threads, (writes.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<ReviewDocument>).value.threads);
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
    const target = path.join(getAdminRoot(), '.libera', 'reviews', `${created[0].id}.json`);
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

test("unrelated file moves, copies and deletions do not rewrite the review database", async () => {
  const { stat } = await import("node:fs/promises");
  const { getAdminRoot } = await import("../../src/lib/storage/paths");
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-review-noop-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    const doc = await loadReview("Notes/a.md", "Initial snapshot.");
    const targets = [path.join(getAdminRoot(), ".libera", "reviews", "index.json"), path.join(getAdminRoot(), ".libera", "reviews", `${doc.id}.json`)];
    const before = await Promise.all(targets.map((target) => stat(target)));
    await moveReviewPath("Other/missing.md", "Other/renamed.md");
    await copyReviewPath("Other/missing.md", "Other/copy.md");
    await deleteReviewPath("Other/missing.md");
    // A sync against the stored text changes nothing: same revision, no write.
    assert.deepEqual(await updateReview(doc.id, doc.revision, (stored) => syncReview(stored, stored.snapshot)), doc);
    const after = await Promise.all(targets.map((target) => stat(target)));
    assert.deepEqual(after.map((s) => [s.ino, s.mtimeMs]), before.map((s) => [s.ino, s.mtimeMs]));
    assert.deepEqual(await readReview(doc.id), doc);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the plan reads whole threads with authors, and only planned comments get proposals", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-review-intent-"));
  const env = { LIBERA_DATA_DIR: process.env.LIBERA_DATA_DIR, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, LIBERA_OPENROUTER_MODEL: process.env.LIBERA_OPENROUTER_MODEL, LIBERA_CONFIG_PATH: process.env.LIBERA_CONFIG_PATH };
  process.env.LIBERA_DATA_DIR = directory; process.env.OPENROUTER_API_KEY = "test-key"; process.env.LIBERA_OPENROUTER_MODEL = "test/model"; process.env.LIBERA_CONFIG_PATH = path.join(directory, "missing.json");
  const originalFetch = globalThis.fetch;
  const contexts: { system: string; context: { comments: { id: string; messages: { kind: string; from: string; text: string }[] }[] } }[] = [];
  let reply: (system: string, context: { comments: { id: string }[]; target: { blocks: { text: string }[] } }) => unknown = () => ({});
  let doc: ReviewDocument;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test/model", context_length: 200_000 }] });
    const body = JSON.parse(String(init?.body));
    const context = JSON.parse(body.messages[1].content);
    contexts.push({ system: body.messages[0].content, context });
    return Response.json({ choices: [{ message: { content: JSON.stringify(reply(body.messages[0].content, context)) } }] });
  };
  async function mutate(action: string, fields = {}) {
    const response = await review(request({ action, id: doc.id, revision: doc.revision, snapshot: doc.snapshot, ...fields }));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    doc = await response.json();
  }
  const plan = (action: string) => agent(request({ action, id: doc.id, revision: doc.revision, snapshot: doc.snapshot, planVersion: doc.session?.plan.version, prompt: "", ids: doc.threads.map((t) => t.id), references: [] }));
  try {
    doc = await (await review(request({ action: "load", key: "Notes/intent.md", snapshot: "First paragraph.\n\nSecond paragraph." }))).json();
    await mutate("comment", { range: { start: 0, end: 16 }, text: "Shorten this." });
    await mutate("comment", { range: { start: 18, end: 35 }, text: "Why second?" });
    await mutate("reply", { threadId: doc.threads[1].id, text: "Never mind, it reads fine." });
    const [edit, question] = doc.threads.map((t) => t.id);

    reply = () => ({ summary: "One edit", steps: [{ commentIds: [edit], targetBlockIds: ["b1"], proposedChange: "Shorten", rationale: "Asked" }], dispositions: [{ commentId: question, reason: "The reply withdrew the question." }], blockingQuestions: [], revisionSummary: "" });
    let response = await plan("plan"); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); doc = await response.json();
    const sent = contexts.at(-1)!;
    assert.match(sent.system, /Not every comment asks for an edit/);
    assert.deepEqual(sent.context.comments[1].messages.map((m) => [m.kind, m.from, m.text]), [["comment", "the user", "Why second?"], ["reply", "the user", "Never mind, it reads fine."]]);

    // A proposal for the comment the plan settled without an edit is refused.
    reply = (_, context) => ({ proposals: [{ title: "Edit second", reason: "x", commentIds: [question], edits: [{ targetBlockId: "b2", before: context.target.blocks[1].text, after: "Changed." }] }], summary: "" });
    assert.equal((await plan("generate")).status, 400);
    reply = (_, context) => ({ proposals: [{ title: "Shorten first", reason: "Asked", commentIds: [edit], edits: [{ targetBlockId: "b1", before: context.target.blocks[0].text, after: "First." }] }], summary: "Done" });
    response = await plan("generate"); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); doc = await response.json();
    assert.deepEqual(doc.session!.suggestions.map((s) => s.commentIds), [[edit]]);

    // A plan with no steps confirms without asking the model for edits.
    await mutate("new-round");
    reply = () => ({ summary: "Nothing to edit", steps: [], dispositions: [{ commentId: edit, reason: "Already short." }, { commentId: question, reason: "Withdrawn." }], blockingQuestions: [], revisionSummary: "" });
    response = await plan("plan"); assert.equal(response.status, 200); doc = await response.json();
    const calls = contexts.length;
    response = await plan("generate"); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); doc = await response.json();
    assert.equal(contexts.length, calls, "no model call for a plan without edits");
    assert.equal(doc.session!.phase, "completed");
    assert.deepEqual(doc.session!.suggestions, []);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});

async function withLibrary(prefix: string, run: (root: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    const { getAdminRoot } = await import("../../src/lib/storage/paths");
    await run(getAdminRoot());
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("a library's single review database moves to one file per document", async () => {
  await withLibrary("libera-review-legacy-", async (root) => {
    const a = newReview("Notes/a.md", "Alpha.", "review-a");
    a.threads = [{ id: "t1", anchor: anchorAt("Alpha.", { start: 0, end: 5 }), messages: [{ id: "m1", text: "Hi", createdAt: "2026-10-01T00:00:00.000Z" }], status: "open" }];
    const b = newReview("Notes/b.md", "Beta.", "review-b");
    await mkdir(path.join(root, ".libera"), { recursive: true });
    await writeFile(path.join(root, ".libera", "markdown-reviews.json"), JSON.stringify({ schemaVersion: 1, documents: [a, b] }));
    assert.deepEqual(await readReview("review-a"), a);
    assert.equal((await loadReview("Notes/b.md", "Changed.")).id, "review-b");
    assert.deepEqual((await readdir(path.join(root, ".libera", "reviews"))).sort(), ["index.json", "review-a.json", "review-b.json"]);
    assert.deepEqual((await readdir(path.join(root, ".libera"))).filter((name) => name.startsWith("markdown-reviews")), ["markdown-reviews.json.migrated"]);
  });
});

test("a review write rewrites only that document's file", async () => {
  await withLibrary("libera-review-files-", async (root) => {
    const a = await loadReview("Notes/a.md", "Alpha paragraph.");
    const b = await loadReview("Notes/b.md", "Beta paragraph.");
    const untouched = [path.join(root, ".libera", "reviews", "index.json"), path.join(root, ".libera", "reviews", `${b.id}.json`)];
    const before = await Promise.all(untouched.map((target) => stat(target)));
    const response = await review(request({ action: "comment", id: a.id, revision: a.revision, snapshot: a.snapshot, range: { start: 0, end: 5 }, text: "Only A." }));
    assert.equal(response.status, 200);
    const after = await Promise.all(untouched.map((target) => stat(target)));
    assert.deepEqual(after.map((s) => [s.ino, s.mtimeMs]), before.map((s) => [s.ino, s.mtimeMs]));
    assert.equal((await readReview(a.id)).threads.length, 1);
    // Moving a document's file rewrites the index and that document only.
    await moveReviewPath("Notes/a.md", "Notes/c.md");
    assert.equal((await loadReview("Notes/c.md", "")).id, a.id);
    assert.deepEqual(await readReview(b.id), b);
  });
});

test("recorded edits keep anchors that one change spanning them would lose", async () => {
  const original = "Alpha one.\n\nBeta two.\n\nGamma three.\n";
  const steps = ["Alpha one.\n\nBeta 2.\n\nGamma three.\n", "Intro.\n\nAlpha one.\n\nBeta 2.\n\nGamma three.\n", "Intro.\n\nAlpha one.\n\nBeta 2.\n\nGamma three!\n"];
  const doc = newReview("Notes/edits.md", original, "review-edits");
  const at = original.indexOf("Beta two.");
  doc.threads = [{ id: "t1", anchor: anchorAt(original, { start: at, end: at + "Beta two.".length }), messages: [{ id: "m1", text: "Hm", createdAt: "2026-10-01T00:00:00.000Z" }], status: "open" }];
  const tracker = new ReviewDraftTracker();
  let shown = doc;
  for (const step of steps) shown = tracker.advance(doc, step);
  const final = steps.at(-1)!;
  assert.equal(shown.threads[0].anchor.state, "attached");
  assert.equal(shown.threads[0].anchor.quote, "Beta 2.");
  assert.equal(tracker.count, 3);
  const replayed = replayReviewEdits(doc, tracker.edits(doc), final);
  assert.deepEqual(replayed.threads[0].anchor, shown.threads[0].anchor);
  assert.equal(syncReview(doc, final).threads[0].anchor.state, "orphaned", "the single change covers the comment");
  // Edits that do not lead to the snapshot fall back to the single change.
  assert.equal(replayReviewEdits(doc, [{ start: 0, end: 0, text: "x" }], final).threads[0].anchor.state, "orphaned");
  for (const edits of [[null], [undefined], [false], [{ start: -1, end: 0, text: "x" }]]) assert.deepEqual(replayReviewEdits(doc, edits, final), syncReview(doc, final));
  assert.equal(tracker.edits(newReview("Notes/other.md", original, "other")).length, 0);
});

test("continuous typing is recorded as one edit", () => {
  let text = "Hello world.", edits: ReviewTextEdit[] = [];
  // Typing, a backspace, then an edit elsewhere.
  for (const next of ["Hello world. ", "Hello world. M", "Hello world. Mo", "Hello world. Mor", "Hello world. More", "Hello world. Mor", "Oh, Hello world. Mor"]) {
    edits = addReviewEdit(edits, text, next); text = next;
  }
  assert.deepEqual(edits, [{ start: 12, end: 12, text: " Mor" }, { start: 0, end: 0, text: "Oh, " }]);
  const apply = (value: string, edit: ReviewTextEdit) => value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  assert.equal(edits.reduce(apply, "Hello world."), text);
  // However edits overlap and merge, replaying them reproduces the text.
  let seed = 7;
  const random = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const start = "abcabcabc";
    let current = start, recorded: ReviewTextEdit[] = [];
    for (let step = 0; step < 8; step++) {
      const at = random(current.length + 1), end = Math.min(current.length, at + random(4));
      const next = current.slice(0, at) + "abc".slice(0, random(4)) + current.slice(end);
      recorded = addReviewEdit(recorded, current, next); current = next;
    }
    assert.equal(recorded.reduce(apply, start), current, JSON.stringify(recorded));
  }
});

test("touching edits retain their individual anchor maps when their merged replacement would detach a comment", () => {
  const text = "Alpha.\n\nBeta.\n\nGamma.";
  const doc = newReview("Notes/a.md", text, "review-a");
  doc.threads = [{ id: "thread", anchor: anchorAt(text, { start: 8, end: 13 }), messages: [], status: "open" }];
  const tracker = new ReviewDraftTracker();
  tracker.advance(doc, "Alpha.\n\nBeta.abcGamma.");
  const final = "Alpha.\n\nBetaababcGamma.";
  const shown = tracker.advance(doc, final);
  assert.equal(tracker.count, 1, "touching changes still count as one typing group");
  assert.equal(shown.threads[0].anchor.state, "attached");
  assert.equal(shown.threads[0].anchor.quote, "Betaab");
  assert.deepEqual(replayReviewEdits(doc, tracker.edits(doc), final), shown);
});

test("acknowledging an in-flight review write preserves the exact mapping of edits typed after it", () => {
  const text = "Alpha one.\n\nBeta two.\n\nGamma three.\n";
  const doc = newReview("Notes/a.md", text, "review-a");
  const at = text.indexOf("Beta two.");
  doc.threads = [{ id: "thread", anchor: anchorAt(text, { start: at, end: at + 9 }), messages: [], status: "open" }];
  const tracker = new ReviewDraftTracker();
  const sent = `Intro.\n\n${text}`;
  tracker.advance(doc, sent);
  const edits = tracker.checkpoint(doc, sent);
  tracker.advance(doc, sent.replace("Beta two.", "Beta 2."));
  const final = sent.replace("Beta two.", "Beta 2.").replace("Gamma three.", "Gamma three!");
  const shown = tracker.advance(doc, final);
  const stored = { ...replayReviewEdits(doc, edits, sent), revision: 1 };
  tracker.acknowledge(doc, stored);
  const projected = tracker.advance(stored, final);
  assert.deepEqual(projected.threads, shown.threads);
  assert.deepEqual(replayReviewEdits(stored, tracker.edits(stored), final).threads, shown.threads);
  assert.equal(projected.threads[0].anchor.state, "attached");
});

test("a minute of typing past the edit limit still keeps anchors precise when stored", () => {
  const original = "Alpha one.\n\nBeta two.\n\nGamma three.\n";
  const doc = newReview("Notes/limit.md", original, "review-limit");
  const at = original.indexOf("Beta two.");
  doc.threads = [{ id: "t1", anchor: anchorAt(original, { start: at, end: at + "Beta two.".length }), messages: [{ id: "m1", text: "Hm", createdAt: "2026-10-01T00:00:00.000Z" }], status: "open" }];
  const tracker = new ReviewDraftTracker();
  const edited = original.replace("Beta two.", "Beta 2.");
  tracker.advance(doc, edited);
  // One keystroke per step, well past MAX_REVIEW_EDITS, before the review is stored.
  const typed = "An intro typed one key at a time. ".repeat(10);
  let text = edited;
  for (let i = 1; i <= typed.length; i++) { text = `${typed.slice(0, i)}\n\n${edited}`; tracker.advance(doc, text); }
  text = text.replace("Gamma three.", "Gamma three!");
  const shown = tracker.advance(doc, text);
  const edits = tracker.edits(doc);
  assert.ok(edits.length > 1 && edits.length <= 200, `${edits.length} edits`);
  const stored = replayReviewEdits(doc, edits, text);
  assert.equal(shown.threads[0].anchor.state, "attached");
  assert.deepEqual(stored.threads[0].anchor, shown.threads[0].anchor);
});
