import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as REVIEWS } from "../../src/app/api/markdown-reviews/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { runAgent } from "../../src/lib/agent/runner";
import { AGENT_SKILLS } from "../../src/lib/agent/skills";
import { RunSnapshots } from "../../src/lib/agent/snapshots";
import { finishSuggestedEdits, passageProblem, suggestEditTool } from "../../src/lib/agent/suggest-edit";
import { activeTools, ALL_TOOLS, toolsForPermission, type AgentTool, type ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent, AgentPermission } from "../../src/lib/agent/types";
import { anchorAt, decideAgentSuggestions, newReview, redoReview, requestAgentRevision, syncReview, undoReview, type AgentSuggestion, type ReviewDocument } from "../../src/lib/markdown-review";
import { addAgentSuggestions, loadReview } from "../../src/lib/storage/markdown-reviews";

const PLAN = "# Plan\n\nThe Q3 budget is 40k.\nAtlas launches in May.\n\nThe budget is final.\n\n- Hire\n- Ship\n";

async function withLibrary(run: (root: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-suggestions-"));
  const previous = { data: process.env.LIBERA_DATA_DIR, key: process.env.OPENROUTER_API_KEY };
  const originalFetch = globalThis.fetch;
  process.env.LIBERA_DATA_DIR = directory;
  process.env.OPENROUTER_API_KEY = "test-key";
  const root = path.join(directory, "users", "admin");
  try {
    await mkdir(path.join(root, "Research"), { recursive: true });
    await writeFile(path.join(root, "Research", "plan.md"), PLAN);
    await writeFile(path.join(root, "Research", "paper.tex"), "\\section{Intro}\n\nWe show a 12\\% gain.\nIt is robust.\n\nMore text.\n");
    await writeFile(path.join(root, "Research", "notes.txt"), "Plain.\n");
    await run(root);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({ LIBERA_DATA_DIR: previous.data, OPENROUTER_API_KEY: previous.key })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function makeContext(permission: AgentPermission = "read-only") {
  const events: AgentEvent[] = [];
  const context: ToolContext = {
    permission, skills: AGENT_SKILLS, loadedSkills: new Set(), skillState: new Map(), notebook: "Research", notebooks: ["Research"],
    openFiles: new Set(), drafts: new Map(), fileState: new Map(), tasks: [], snapshots: new RunSnapshots("suggest-run-0001"), changed: new Map(),
    maxResultChars: 40_000, signal: new AbortController().signal, emit: (event) => events.push(event),
  };
  return { context, events };
}

async function call(context: ToolContext, name: string, args: Record<string, unknown>) {
  const tool = [...activeTools(ALL_TOOLS, context), suggestEditTool].find((candidate: AgentTool) => candidate.name === name)!;
  try { return await tool.run(args, context); }
  catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true, result: "" }; }
}

async function reviews(root: string) {
  return (JSON.parse(await readFile(path.join(root, ".libera", "markdown-reviews.json"), "utf8")) as { documents: ReviewDocument[] }).documents;
}

function suggestion(text: string, before: string, after: string, patch: Partial<AgentSuggestion> = {}): AgentSuggestion {
  const start = text.indexOf(before);
  const anchor = anchorAt(text, { start, end: start + before.length });
  return { id: `s-${before}`, version: 1, title: "Fix", reason: "Because.", commentIds: [], edits: [{ start, end: anchor.end, before, after }], anchors: [anchor], status: "pending", author: "agent", createdAt: "2026-10-18T00:00:00.000Z", ...patch };
}

test("SuggestEdit matches a unique passage within a block and never changes the file, even in Read Only", async () => {
  await withLibrary(async (root) => {
    const { context } = makeContext("read-only");
    assert.match((await call(context, "SuggestEdit", { path: "Research/plan.md", before: "40k", after: "45k", reason: "Matches the table." })).text, /^Read Research\/plan\.md before suggesting edits to it\./);
    await call(context, "Read", { file_path: "Research/plan.md" });
    // Missing, ambiguous, cross-block, no-op, wrong file type.
    assert.match((await call(context, "SuggestEdit", { path: "Research/plan.md", before: "50k", after: "45k", reason: "r" })).text, /^before was not found in Research\/plan\.md/);
    assert.match((await call(context, "SuggestEdit", { path: "Research/plan.md", before: "budget", after: "plan", reason: "r" })).text, /^before matches 2 places in Research\/plan\.md \(lines 3, 6\)/);
    assert.match((await call(context, "SuggestEdit", { path: "Research/plan.md", before: "May.\n\nThe budget", after: "June.\n\nThe budget", reason: "r" })).text, /^Nothing was recorded: before spans parts of several paragraphs/);
    assert.match((await call(context, "SuggestEdit", { path: "Research/plan.md", before: "40k", after: "40k", reason: "r" })).text, /identical/);
    assert.match((await call(context, "SuggestEdit", { path: "Research/notes.txt", before: "Plain", after: "Simple", reason: "r" })).text, /not a Markdown or LaTeX file/);

    const recorded = await call(context, "SuggestEdit", { path: "Research/plan.md", before: "The Q3 budget is 40k.", after: "The Q3 budget is 45k.", reason: "The summary table says 45k. It was revised in August.", comment: "See the table on page 2." });
    assert.equal(recorded.isError, false);
    assert.equal(recorded.result, "Suggestion recorded");
    assert.match(recorded.text, /^Recorded a suggested edit for Research\/plan\.md at line 3\./);
    // Curly quotes and whole blocks are fine; the same passage again replaces the earlier suggestion; overlaps are refused.
    assert.equal((await call(context, "SuggestEdit", { path: "Research/plan.md", before: "- Hire\n- Ship", after: "- Hire\n- Ship\n- Celebrate", reason: "Add the last step." })).isError, false);
    assert.equal((await call(context, "SuggestEdit", { path: "Research/plan.md", before: "The Q3 budget is 40k.", after: "The Q3 budget is 46k.", reason: "Updated figure." })).result, "Suggestion replaced");
    assert.match((await call(context, "SuggestEdit", { path: "Research/plan.md", before: "budget is 40k", after: "budget is 47k", reason: "r" })).text, /overlaps your earlier suggestion for “The Q3 budget is 40k\.” \(line 3\)/);
    await call(context, "Read", { file_path: "Research/paper.tex" });
    assert.match((await call(context, "SuggestEdit", { path: "Research/paper.tex", before: "robust.\n\nMore", after: "x", reason: "r" })).text, /spans parts of several paragraphs/);
    assert.equal((await call(context, "SuggestEdit", { path: "Research/paper.tex", before: "a 12\\% gain", after: "a 12\\% accuracy gain", reason: "Say what improved." })).isError, false);

    assert.equal(await readFile(path.join(root, "Research", "plan.md"), "utf8"), PLAN, "suggestions never touch the file");
    assert.equal(passageProblem(PLAN, { start: 0, end: PLAN.indexOf("May.") + 4 }, "markdown"), null, "whole blocks may be replaced together");
    assert.match(passageProblem(PLAN, { start: PLAN.indexOf("May.") + 4, end: PLAN.indexOf("May.") + 6 }, "markdown") ?? "", /only blank lines/);
  });
});

test("the finish pass saves suggestions with linked comments, turns review mode on and reports the files", async () => {
  await withLibrary(async (root) => {
    const { context, events } = makeContext("read-only");
    context.loadedSkills.add("leave-review-comments");
    await call(context, "Read", { file_path: "Research/plan.md" });
    await call(context, "SuggestEdit", { path: "Research/plan.md", before: "40k", after: "45k", reason: "The table says 45k.", comment: "Page 2 of the budget sheet." });
    await call(context, "SuggestEdit", { path: "Research/plan.md", before: "Atlas launches in May.", after: "", reason: "Out of scope." });
    // The draft changes before the run ends: suggestions follow their passages.
    const draft = `Intro line.\n\n${PLAN}`;
    context.drafts.set("Research/plan.md", draft);
    assert.equal(await finishSuggestedEdits(context), null);
    const [doc] = await reviews(root);
    assert.equal(doc.key, "Research/plan.md");
    assert.equal(doc.enabled, true);
    assert.equal(doc.snapshot, draft);
    assert.deepEqual(doc.agentSuggestions!.map((s) => [s.title, s.status, s.author, s.runId, s.edits[0].before, s.edits[0].after, draft.slice(s.edits[0].start, s.edits[0].end)]), [
      ["The table says 45k.", "pending", "agent", "suggest-run-0001", "40k", "45k", "40k"],
      ["Out of scope.", "pending", "agent", "suggest-run-0001", "Atlas launches in May.", "", "Atlas launches in May."],
    ]);
    assert.equal(doc.threads.length, 1);
    assert.deepEqual(doc.agentSuggestions![0].commentIds, [doc.threads[0].id]);
    assert.deepEqual(doc.threads[0].messages.map((m) => [m.text, m.author]), [["Page 2 of the budget sheet.", "agent"]]);
    assert.deepEqual(events.filter((event) => event.type === "suggestions_added"), [{ type: "suggestions_added", path: "Research/plan.md", count: 2 }]);
    const step = events.filter((event) => event.type === "tool_finished").at(-1) as { result: string; status: string };
    assert.deepEqual([step.status, step.result], ["ok", "2 suggested edits added"]);
    assert.equal(await finishSuggestedEdits(context), null, "a second pass has nothing left to save");
    assert.equal((await reviews(root))[0].agentSuggestions!.length, 2);
  });
});

function sse(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}
function reply(calls: { id: string; name: string; args: unknown }[], text = "") {
  return sse([
    ...(text ? [{ choices: [{ delta: { content: text } }] }] : []),
    ...calls.map((call, index) => ({ choices: [{ delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })),
    { choices: [{ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] },
  ]);
}

test("a review run in Read Only leaves comments and suggestions, saved when the model finishes", async () => {
  await withLibrary(async (root) => {
    const sent: { tools: { function: { name: string } }[] }[] = [];
    const replies = [
      () => reply([{ id: "a", name: "Skill", args: { name: "leave-review-comments" } }, { id: "b", name: "Read", args: { file_path: "Research/plan.md" } }]),
      () => reply([
        { id: "c", name: "SuggestEdit", args: { path: "Research/plan.md", before: "The Q3 budget is 40k.", after: "The Q3 budget is 45k.", reason: "Matches the table." } },
        { id: "d", name: "LeaveComment", args: { file_path: "Research/plan.md", old_string: "- Ship", new_string: "- Ship\n\n:::comment\nWhen?\n:::" } },
      ]),
      () => reply([], "One suggested edit and one comment in Research/plan.md."),
    ];
    globalThis.fetch = async (_input, init) => { sent.push(JSON.parse(String(init?.body))); return replies.shift()!(); };
    const { context, events } = makeContext("read-only");
    const result = await runAgent({ model: "m", profile: { contextLength: 200_000, supportsTools: true, known: true }, system: "S", messages: [{ role: "user", content: "Review it" }], tools: toolsForPermission("read-only"), context, emit: (event) => events.push(event), signal: context.signal });
    assert.equal(result.outcome, "completed");
    assert.ok(sent[1].tools.some((tool) => tool.function.name === "SuggestEdit"), "the skill offers SuggestEdit in Read Only");
    assert.equal(await readFile(path.join(root, "Research", "plan.md"), "utf8"), PLAN);
    const [doc] = await reviews(root);
    assert.equal(doc.threads.length, 1);
    assert.equal(doc.agentSuggestions!.length, 1);
    assert.deepEqual(events.filter((event) => event.type === "comments_added" || event.type === "suggestions_added").map((event) => event.type), ["comments_added", "suggestions_added"]);
  });
});

test("syncReview remaps agent suggestions, conflicts them when their passage changes, and restores them", () => {
  const s = suggestion(PLAN, "40k", "45k");
  const doc: ReviewDocument = { ...newReview("plan.md", PLAN, "r"), agentSuggestions: [s] };
  const inserted = `New intro.\n\n${PLAN}`;
  const moved = syncReview(doc, inserted);
  assert.equal(moved.agentSuggestions![0].status, "pending");
  assert.equal(inserted.slice(moved.agentSuggestions![0].edits[0].start, moved.agentSuggestions![0].edits[0].end), "40k");
  const edited = syncReview(moved, inserted.replace("40k", "42k"));
  assert.equal(edited.agentSuggestions![0].status, "conflicted");
  const restored = syncReview(edited, inserted);
  assert.equal(restored.agentSuggestions![0].status, "pending", "the passage came back, e.g. after undo");
  assert.equal(syncReview({ ...doc, agentSuggestions: [{ ...s, status: "rejected" }] }, inserted.replace("40k", "42k")).agentSuggestions![0].status, "rejected");
  assert.ok(!("agentSuggestions" in syncReview(newReview("plan.md", PLAN, "r"), inserted)), "documents without suggestions stay as they were");
});

test("accepting applies the edit with undo and redo, addresses linked comments; reject and request revision record decisions", () => {
  const thread = { id: "t1", anchor: anchorAt(PLAN, { start: PLAN.indexOf("The Q3"), end: PLAN.indexOf("40k.") + 4 }), status: "open" as const, messages: [{ id: "m", text: "Check", createdAt: "x", author: "agent" as const }] };
  const budget = suggestion(PLAN, "40k", "45k", { commentIds: ["t1"] });
  const ship = suggestion(PLAN, "- Ship", "- Ship it");
  const final = suggestion(PLAN, "The budget is final.", "The budget is provisional.");
  const doc: ReviewDocument = { ...newReview("plan.md", PLAN, "r"), threads: [thread], agentSuggestions: [budget, ship, final] };

  const accepted = decideAgentSuggestions(doc, [budget.id], "accept", "tx1", "2026-10-18T01:00:00.000Z");
  const text = PLAN.replace("40k", "45k");
  assert.equal(accepted.snapshot, text);
  assert.deepEqual(accepted.agentSuggestions!.map((s) => s.status), ["accepted", "pending", "pending"]);
  assert.equal(accepted.agentSuggestions![0].decidedAt, "2026-10-18T01:00:00.000Z");
  assert.equal(accepted.threads[0].status, "addressed");
  assert.equal(text.slice(accepted.threads[0].anchor.start, accepted.threads[0].anchor.end), "The Q3 budget is 45k.");
  assert.equal(text.slice(accepted.agentSuggestions![1].edits[0].start, accepted.agentSuggestions![1].edits[0].end), "- Ship", "other suggestions follow");
  assert.equal(accepted.undo.at(-1)!.kind, "agent");
  assert.throws(() => decideAgentSuggestions(accepted, [budget.id], "accept", "tx"), /already decided/);

  // Reject the third, then undo the acceptance: the later rejection stays.
  const rejected = decideAgentSuggestions(accepted, [final.id], "reject", "tx2");
  assert.equal(rejected.snapshot, text);
  assert.deepEqual(rejected.agentSuggestions!.map((s) => s.status), ["accepted", "pending", "rejected"]);
  const undone = undoReview(rejected);
  assert.equal(undone.snapshot, PLAN);
  assert.deepEqual(undone.agentSuggestions!.map((s) => s.status), ["pending", "pending", "rejected"]);
  assert.equal(undone.threads[0].status, "open");
  // The editor's own undo reaching the review syncs the same way.
  assert.deepEqual(syncReview(rejected, PLAN).agentSuggestions!.map((s) => s.status), ["pending", "pending", "rejected"]);
  const redone = redoReview(undone);
  assert.equal(redone.snapshot, text);
  assert.deepEqual(redone.agentSuggestions!.map((s) => s.status), ["accepted", "pending", "rejected"]);
  assert.equal(redone.redo!.length, 0);

  // Accept all: several suggestions at once.
  const all = decideAgentSuggestions(doc, [budget.id, ship.id, final.id], "accept", "tx3");
  assert.equal(all.snapshot, PLAN.replace("40k", "45k").replace("- Ship", "- Ship it").replace("final", "provisional"));
  // A conflicted suggestion can be rejected but not accepted.
  const conflicted = syncReview(doc, PLAN.replace("- Ship", "- Deliver"));
  assert.equal(conflicted.agentSuggestions![1].status, "conflicted");
  assert.throws(() => decideAgentSuggestions(conflicted, [ship.id], "accept", "tx"), /its passage changed/);
  assert.equal(decideAgentSuggestions(conflicted, [ship.id], "reject", "tx").agentSuggestions![1].status, "rejected");

  let counter = 0;
  const revised = requestAgentRevision(doc, budget.id, "Use the September figure instead.", () => `id-${++counter}`, "2026-10-18T02:00:00.000Z");
  const added = revised.threads.at(-1)!;
  assert.equal(added.anchor.quote, "40k");
  assert.deepEqual(added.messages.map((m) => [m.author, m.text]), [
    ["agent", "Suggested edit: Fix\n\n> 40k\n\nwould become\n\n> 45k\n\nReason: Because."],
    [undefined, "Revision requested: Use the September figure instead."],
  ]);
  assert.deepEqual(revised.agentSuggestions![0].commentIds, ["t1", added.id]);
  assert.equal(revised.agentSuggestions![0].status, "pending", "the suggestion stays open while the revision is discussed");
  assert.throws(() => requestAgentRevision(accepted, budget.id, "x", () => "id"), /already decided/);
  assert.throws(() => requestAgentRevision(doc, budget.id, "  ", () => "id"), /Describe the revision/);
});

function reviewRequest(body: unknown) {
  return new NextRequest("http://localhost/api/markdown-reviews", { method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body: JSON.stringify(body) });
}

test("the review route accepts, rejects and requests revisions of agent suggestions", async () => {
  await withLibrary(async () => {
    const stored = await addAgentSuggestions("Research/plan.md", PLAN, [
      { range: { start: PLAN.indexOf("40k"), end: PLAN.indexOf("40k") + 3 }, after: "45k", reason: "Table." },
      { range: { start: PLAN.indexOf("- Ship"), end: PLAN.indexOf("- Ship") + 6 }, after: "- Ship it", reason: "Clearer.", title: "Clarify shipping" },
      { range: { start: PLAN.indexOf("final"), end: PLAN.indexOf("final") + 5 }, after: "provisional", reason: "Not final yet." },
    ]);
    assert.equal(stored.enabled, true);
    assert.deepEqual(stored.agentSuggestions!.map((s) => s.title), ["Table.", "Clarify shipping", "Not final yet."]);
    let doc = await loadReview("Research/plan.md", PLAN);
    const [budget, ship, final] = doc.agentSuggestions!;
    async function post(body: Record<string, unknown>) {
      const response = await REVIEWS(reviewRequest({ id: doc.id, revision: doc.revision, snapshot: doc.snapshot, ...body }));
      const json = await response.json();
      if (response.ok) doc = json;
      return { status: response.status, json };
    }
    assert.equal((await post({ action: "agent-decision", ids: [budget.id], decision: "maybe" })).status, 400);
    assert.equal((await post({ action: "agent-decision", ids: [budget.id], decision: "accept" })).status, 200);
    assert.equal(doc.snapshot, PLAN.replace("40k", "45k"));
    assert.equal(doc.agentSuggestions![0].status, "accepted");
    assert.equal((await post({ action: "agent-revision", suggestionId: ship.id, text: "Say when." })).status, 200);
    assert.equal(doc.threads.at(-1)!.messages[1].text, "Revision requested: Say when.");
    assert.equal((await post({ action: "agent-decision", ids: [ship.id, final.id], decision: "reject" })).status, 200);
    assert.deepEqual(doc.agentSuggestions!.map((s) => s.status), ["accepted", "rejected", "rejected"]);
    const again = await post({ action: "agent-decision", ids: [ship.id], decision: "reject" });
    assert.equal(again.status, 400);
    assert.match(again.json.error, /already decided/);
    assert.equal((await post({ action: "undo" })).status, 200);
    assert.equal(doc.snapshot, PLAN);
    assert.deepEqual(doc.agentSuggestions!.map((s) => s.status), ["pending", "rejected", "rejected"]);
  });
});
