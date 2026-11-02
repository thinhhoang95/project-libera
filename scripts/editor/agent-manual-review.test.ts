import "./setup.cjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { Editor } from "@tiptap/core";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { TiptapChanges, decideTiptapChanges, tiptapChangesKey } from "../../src/lib/tiptap-changes";
import { useTiptapAgentReview } from "../../src/components/libera/use-tiptap-agent-review";
import { history, redo, undo } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildAgentEnvironment } from "../../src/lib/agent/prompt";
import { keepReviews, listPendingReviews, pruneReviews, revertReviews, setReviewBaseline, withReviewWrite } from "../../src/lib/agent/review-store";
import { RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import { ALL_TOOLS, type ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent, AgentReviewFile } from "../../src/lib/agent/types";
import { agentHunksBetween, agentReviewCodeMirror, agentReviewHunks, textWithoutHunks } from "../../src/lib/agent-review/codemirror";
import { agentReviewStore, reviewLineCounts } from "../../src/lib/agent-review/store";
import { applyAiProposal, decideReviewHunks } from "../../src/lib/latex/codemirror/review";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DOMParser", "MutationObserver"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

async function withLibrary(run: (root: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-review-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  const root = path.join(directory, "users", "admin");
  try {
    await mkdir(path.join(root, "Research"), { recursive: true });
    await writeFile(path.join(root, "Research/plan.md"), "# Plan\n\nThe Q3 budget is 40k.\nAtlas launches in May.\n");
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function makeContext(overrides: Partial<ToolContext> = {}) {
  const events: AgentEvent[] = [];
  const context: ToolContext = {
    permission: "notebook", skills: [], loadedSkills: new Set(), skillState: new Map(),
    notebook: "Research", notebooks: ["Research"], openFiles: new Set(["Research/plan.md"]),
    drafts: new Map(), fileState: new Map(), tasks: [],
    snapshots: new RunSnapshots(`run-${Math.random().toString(36).slice(2, 12)}`),
    changed: new Map(), maxResultChars: 40_000, signal: new AbortController().signal,
    emit: (event) => events.push(event), manualReview: true,
    ...overrides,
  };
  return { context, events };
}

async function call(context: ToolContext, name: string, args: Record<string, unknown>) {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name)!;
  return tool.run(args, context);
}

test("manual review records the text the agent started from and keeps it across runs", async () => {
  await withLibrary(async (root) => {
    const draft = "# Plan\n\nThe Q3 budget is 40k.\nAtlas launches in May.\nUnsaved line.\n";
    const { context, events } = makeContext({ drafts: new Map([["Research/plan.md", draft]]) });
    await call(context, "Read", { file_path: "Research/plan.md" });
    await call(context, "Edit", { file_path: "Research/plan.md", old_string: "40k", new_string: "50k" });
    await call(context, "Write", { file_path: "Research/new.md", content: "# New\n" });
    assert.ok(events.some((event) => event.type === "file_changed" && event.path === "Research/plan.md" && event.review));

    let pending = await listPendingReviews();
    assert.deepEqual(pending.map((file) => [file.path, file.created]), [["Research/new.md", true], ["Research/plan.md", false]]);
    const plan = pending.find((file) => file.path === "Research/plan.md")!;
    assert.equal(plan.baseline, draft, "the baseline is the unsaved draft the agent built on");
    assert.equal(plan.current, draft.replace("40k", "50k"));

    // A second run keeps the first baseline, so both runs' changes are reviewed together.
    const second = makeContext();
    await call(second.context, "Read", { file_path: "Research/plan.md" });
    await call(second.context, "Edit", { file_path: "Research/plan.md", old_string: "May", new_string: "June" });
    pending = await listPendingReviews();
    assert.equal(pending.find((file) => file.path === "Research/plan.md")!.baseline, draft);

    // Without manual review nothing is recorded.
    const off = makeContext({ manualReview: false });
    await call(off.context, "Write", { file_path: "Research/other.md", content: "Other\n" });
    assert.equal((await listPendingReviews()).some((file) => file.path === "Research/other.md"), false);

    // Accepting everything in an editor makes the baseline the file's text: it leaves review.
    assert.equal((await setReviewBaseline("Research/plan.md", await readFile(path.join(root, "Research/plan.md"), "utf8"))).pending, false);
    assert.deepEqual((await listPendingReviews()).map((file) => file.path), ["Research/new.md"]);

    // Rejecting a created file removes it.
    const results = await revertReviews(["Research/new.md"]);
    assert.deepEqual(results, [{ path: "Research/new.md", status: "deleted" }]);
    await assert.rejects(stat(path.join(root, "Research/new.md")));
    assert.deepEqual(await listPendingReviews(), []);
  });
});

test("rejecting restores the editor's baseline; accepting and undo settle files", async () => {
  await withLibrary(async (root) => {
    const original = await readFile(path.join(root, "Research/plan.md"), "utf8");
    const { context } = makeContext();
    await call(context, "Read", { file_path: "Research/plan.md" });
    await call(context, "Edit", { file_path: "Research/plan.md", old_string: "40k", new_string: "50k" });

    // The editor's newer baseline (with the user's own edit) wins over the stored one.
    const edited = original.replace("# Plan", "# Plan (mine)");
    const [restored] = await revertReviews(["Research/plan.md"], { "Research/plan.md": edited });
    assert.deepEqual(restored, { path: "Research/plan.md", status: "restored", content: edited });
    assert.equal(await readFile(path.join(root, "Research/plan.md"), "utf8"), edited);
    assert.deepEqual(await listPendingReviews(), []);

    const keep = makeContext();
    await call(keep.context, "Read", { file_path: "Research/plan.md" });
    await call(keep.context, "Edit", { file_path: "Research/plan.md", old_string: "May", new_string: "June" });
    await keepReviews(["Research/plan.md"]);
    assert.deepEqual(await listPendingReviews(), []);
    assert.match(await readFile(path.join(root, "Research/plan.md"), "utf8"), /June/);

    const undone = makeContext();
    await call(undone.context, "Read", { file_path: "Research/plan.md" });
    await call(undone.context, "Edit", { file_path: "Research/plan.md", old_string: "June", new_string: "July" });
    assert.equal((await listPendingReviews()).length, 1);
    await undoRun(undone.context.snapshots.runId);
    await pruneReviews(["Research/plan.md"]);
    assert.deepEqual(await listPendingReviews(), [], "a file undone back to its baseline leaves review");
  });
});

test("the agent is told when manual review is on", () => {
  const environment = { date: "2026-11-02", notebook: "Research", notebooks: ["Research"], activeFile: null, openFiles: [], unsavedFiles: new Set<string>(), manualReview: true };
  assert.match(buildAgentEnvironment({ ...environment, permission: "notebook" }), /\nManual review: on\./);
  assert.doesNotMatch(buildAgentEnvironment({ ...environment, permission: "read-only" }), /Manual review/);
});

test("agent hunks round-trip between a baseline and the text", () => {
  const baseline = "one\ntwo\nthree\nfour\n";
  const text = "one\n2\nthree\nfour\nfive\n";
  const hunks = agentHunksBetween(baseline, text);
  assert.equal(hunks.length, 2);
  assert.equal(textWithoutHunks(text, hunks), baseline);
  assert.equal(textWithoutHunks(text, hunks.slice(1)), "one\n2\nthree\nfour\n", "accepting a hunk moves it into the baseline");
  assert.deepEqual(reviewLineCounts(baseline, text), { added: 2, removed: 1 });
  for (const [before, after] of [["one", "one\n"], ["one\n", "one"], ["", "\n"], ["\n", ""]]) {
    assert.ok(agentHunksBetween(before, after).length);
    assert.equal(textWithoutHunks(after, agentHunksBetween(before, after)), before);
  }
});

test("a CodeMirror editor shows the pending changes and reports decisions as baselines", async () => {
  const baseline = "alpha\nbeta\ngamma\ndelta\n";
  const current = "alpha\nBETA\ngamma\ndelta\nepsilon\n";
  const files: AgentReviewFile[] = [{ path: "Research/plan.md", baseline, current, created: false, revision: "review-1" }];
  const posted: { action: string; path?: string; baseline?: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== "/api/agent/review") throw new Error(`Unexpected request ${String(input)}`);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      return Response.json({ pending: true });
    }
    return Response.json({ files });
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await agentReviewStore.refresh();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: current, extensions: [history(), agentReviewCodeMirror("Research/plan.md", { outside: (transaction) => transaction.annotation(Transaction.remote) === true })] }),
    });
    await settle();
    assert.deepEqual(agentReviewHunks(view.state).map((hunk) => [view.state.sliceDoc(hunk.from, hunk.to), hunk.original]), [["BETA\n", "beta\n"], ["epsilon\n", ""]]);
    assert.ok(view.dom.classList.contains("libera-ai-review"));

    // Accept the first: the baseline takes it.
    decideReviewHunks(view, [agentReviewHunks(view.state)[0].id], "accept");
    assert.equal(agentReviewStore.get("Research/plan.md")?.baseline, "alpha\nBETA\ngamma\ndelta\n");
    // Typing outside the changes moves the baseline too, so it is never shown as the agent's.
    view.dispatch({ changes: { from: 0, insert: "# " }, userEvent: "input.type" });
    assert.equal(agentReviewStore.get("Research/plan.md")?.baseline, "# alpha\nBETA\ngamma\ndelta\n");
    assert.equal(agentReviewHunks(view.state).length, 1);
    // Reject the last: its text goes, and undo brings the change back for review.
    decideReviewHunks(view, "all", "reject");
    assert.equal(view.state.doc.toString(), "# alpha\nBETA\ngamma\ndelta\n");
    assert.equal(agentReviewHunks(view.state).length, 0);
    undo(view);
    assert.equal(agentReviewHunks(view.state).length, 1);

    redo(view);
    assert.equal(agentReviewHunks(view.state).length, 0);
    undo(view);
    assert.equal(agentReviewHunks(view.state).length, 1);

    // Manually restoring a proposal also settles it; undo restores its review.
    const insertion = agentReviewHunks(view.state)[0];
    view.dispatch({ changes: { from: insertion.from, to: insertion.to, insert: insertion.original }, userEvent: "input.type" });
    assert.equal(agentReviewHunks(view.state).length, 0);
    undo(view);
    assert.equal(agentReviewHunks(view.state).length, 1);

    // The agent's next edit comes in from outside: it is diffed against the baseline
    // (adjacent changed lines form one hunk).
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# alpha\nBETA\ngamma\nDELTA\nepsilon\n" }, annotations: Transaction.remote.of(true) });
    await settle();
    assert.deepEqual(agentReviewHunks(view.state).map((hunk) => [view.state.sliceDoc(hunk.from, hunk.to), hunk.original]), [["DELTA\nepsilon\n", "delta\n"]]);

    await agentReviewStore.flush(["Research/plan.md"]);
    assert.equal(posted.at(-1)?.action, "baseline");
    assert.equal(posted.at(-1)?.baseline, "# alpha\nBETA\ngamma\ndelta\n");

    // Leaving review (Accept all in the AI panel) clears the hunks without touching the text.
    await agentReviewStore.keep(["Research/plan.md"]);
    await settle();
    assert.equal(agentReviewHunks(view.state).length, 0);
    assert.equal(view.state.doc.toString(), "# alpha\nBETA\ngamma\nDELTA\nepsilon\n");
    view.destroy();
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("review listing cannot settle an entry between recording it and the agent write", async () => {
  await withLibrary(async (root) => {
    for (const [filePath, before] of [["Research/plan.md", await readFile(path.join(root, "Research/plan.md"), "utf8")], ["Research/new.md", null]] as const) {
      let start!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => { start = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const writing = withReviewWrite(filePath, before, "run-atomic", async () => {
        start();
        await gate;
        await writeFile(path.join(root, filePath), "Agent text\n");
      });
      await started;
      const listing = listPendingReviews();
      release();
      await writing;
      assert.ok((await listing).some((file) => file.path === filePath));
      assert.equal((await listPendingReviews()).find((file) => file.path === filePath)?.baseline, before ?? "");
    }
  });
});

test("accepting during a run does not hide the run's next write; empty creations stay reviewable", async () => {
  await withLibrary(async () => {
    const { context } = makeContext();
    await call(context, "Read", { file_path: "Research/plan.md" });
    await call(context, "Edit", { file_path: "Research/plan.md", old_string: "40k", new_string: "50k" });
    const [first] = await listPendingReviews();
    await keepReviews([first.path]);
    await call(context, "Edit", { file_path: first.path, old_string: "May", new_string: "June" });
    assert.equal((await listPendingReviews())[0].baseline, first.current);
    await call(context, "Write", { file_path: "Research/empty.md", content: "" });
    assert.ok((await listPendingReviews()).some((file) => file.path === "Research/empty.md" && file.created));
  });
});

test("stale baseline reports and decisions cannot overwrite newer review state or disk text", async () => {
  await withLibrary(async (root) => {
    const { context } = makeContext();
    await call(context, "Read", { file_path: "Research/plan.md" });
    await call(context, "Edit", { file_path: "Research/plan.md", old_string: "40k", new_string: "50k" });
    const [first] = await listPendingReviews();
    const baseline = first.baseline.replace("# Plan", "# Mine");
    await setReviewBaseline(first.path, baseline, first.revision);
    await assert.rejects(setReviewBaseline(first.path, first.current, first.revision), /changed while you were reviewing/);
    assert.equal((await listPendingReviews())[0].baseline, baseline);
    const expected = { [first.path]: { revision: first.revision, current: first.current } };
    await assert.rejects(keepReviews([first.path], expected), /changed while you were reviewing/);
    const [refused] = await revertReviews([first.path], {}, expected);
    assert.equal(refused.status, "conflict");
    assert.equal(await readFile(path.join(root, first.path), "utf8"), first.current);
    const [latest] = await listPendingReviews();
    await writeFile(path.join(root, first.path), "A newer external edit\n");
    assert.equal((await revertReviews([first.path], {}, { [first.path]: { revision: latest.revision, current: latest.current } }))[0].status, "conflict");
    assert.equal(await readFile(path.join(root, first.path), "utf8"), "A newer external edit\n");
  });
});

test("removed review files are not recreated, and review writes reject unsafe or non-text paths", async () => {
  await withLibrary(async (root) => {
    const { context } = makeContext();
    await call(context, "Read", { file_path: "Research/plan.md" });
    await call(context, "Edit", { file_path: "Research/plan.md", old_string: "40k", new_string: "50k" });
    await rm(path.join(root, "Research/plan.md"));
    assert.equal((await revertReviews(["Research/plan.md"]))[0].status, "missing");
    await assert.rejects(stat(path.join(root, "Research/plan.md")));
    for (const filePath of ["Research/../escape.md", "Research/image.png", "Research"]) {
      await assert.rejects(withReviewWrite(filePath, null, "run-invalid", async () => assert.fail("must not write")));
    }
    assert.deepEqual(await listPendingReviews(), []);
  });
});

test("CodeMirror normalizes CRLF for review and a separate rewrite cannot leave overlapping agent hunks", async () => {
  const baseline = "alpha\r\nbeta\r\ngamma\r\n";
  const current = baseline.replace("beta", "BETA");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => init?.method === "POST" ? Response.json({ pending: true, revision: "crlf-2" }) : Response.json({ files: [{ path: "Research/crlf.md", baseline, current, created: false, revision: "crlf-1" }] });
  let view: EditorView | undefined;
  try {
    await agentReviewStore.refresh();
    view = new EditorView({ state: EditorState.create({ doc: current, extensions: [history(), agentReviewCodeMirror("Research/crlf.md", { outside: () => false })] }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(agentReviewHunks(view.state).length, 1);
    assert.equal(agentReviewHunks(view.state)[0].original, "beta\n");
    view.dispatch({ changes: { from: 0, insert: "# " } });
    assert.equal(agentReviewStore.get("Research/crlf.md")?.baseline, "# alpha\r\nbeta\r\ngamma\r\n");
    const hunk = agentReviewHunks(view.state)[0];
    applyAiProposal(view, hunk.from, hunk.to, "Rewritten\n", "rewrite");
    assert.equal(agentReviewHunks(view.state).length, 0);
    assert.doesNotThrow(() => decideReviewHunks(view!, "all", "reject"));
    await agentReviewStore.flush(["Research/crlf.md"]);
    await agentReviewStore.keep(["Research/crlf.md"]);
  } finally {
    view?.destroy();
    globalThis.fetch = originalFetch;
  }
});

test("overlapping refreshes rerun, and a GET started before acceptance cannot resurrect a review", async () => {
  const file: AgentReviewFile = { path: "Research/refresh.md", baseline: "old", current: "agent", created: false, revision: "refresh-1" };
  const originalFetch = globalThis.fetch;
  let release!: (response: Response) => void;
  let requests = 0;
  let mode: "overlap" | "keep" = "overlap";
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") return Response.json({ ok: true });
    requests++;
    if (requests === 1) return new Promise<Response>((resolve) => { release = resolve; });
    return Response.json({ files: mode === "overlap" ? [file] : [] });
  };
  try {
    const first = agentReviewStore.refresh();
    const second = agentReviewStore.refresh();
    release(Response.json({ files: [] }));
    await Promise.all([first, second]);
    assert.equal(requests, 2);
    assert.equal(agentReviewStore.get(file.path)?.baseline, "old");

    mode = "keep";
    requests = 0;
    const stale = agentReviewStore.refresh();
    await agentReviewStore.keep([file.path]);
    release(Response.json({ files: [file] }));
    await stale;
    assert.equal(agentReviewStore.get(file.path), undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test("failed baseline posts stay pending and prevent whole-file rejection until saved", async () => {
  const file: AgentReviewFile = { path: "Research/failure.md", baseline: "old", current: "agent", created: false, revision: "failure-1" };
  const originalFetch = globalThis.fetch;
  const actions: string[] = [];
  let fail = true;
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "POST") return Response.json({ files: [file] });
    const body = JSON.parse(String(init.body));
    actions.push(body.action);
    if (body.action === "baseline") {
      if (fail) return Response.json({ error: "Offline" }, { status: 503 });
      assert.equal(body.baseline, "My edit plus old");
      return Response.json({ pending: true, revision: "failure-2" });
    }
    assert.equal(body.baselines[file.path], "My edit plus old");
    return Response.json({ results: [{ path: file.path, status: "restored", content: body.baselines[file.path] }] });
  };
  try {
    await agentReviewStore.refresh();
    agentReviewStore.setBaseline(file.path, "My edit plus old");
    await assert.rejects(agentReviewStore.flush([file.path]), /Offline/);
    await assert.rejects(agentReviewStore.revert([file.path]), /Offline/);
    assert.equal(actions.includes("revert"), false);
    assert.equal(agentReviewStore.get(file.path)?.baseline, "My edit plus old");
    fail = false;
    assert.equal((await agentReviewStore.revert([file.path]))[0].content, "My edit plus old");
  } finally { globalThis.fetch = originalFetch; }
});

test("flush drains baseline edits queued while an earlier report is in flight", async () => {
  const file: AgentReviewFile = { path: "Research/flush.md", baseline: "old", current: "agent", created: false, revision: "flush-1" };
  const originalFetch = globalThis.fetch;
  let release!: () => void, start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const posted: { baseline: string; revision: string }[] = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "POST") return Response.json({ files: [file] });
    const body = JSON.parse(String(init.body));
    if (body.action === "keep") return Response.json({ ok: true });
    posted.push(body);
    if (posted.length === 1) { start(); await gate; }
    return Response.json({ pending: true, revision: `flush-${posted.length + 1}` });
  };
  try {
    await agentReviewStore.refresh();
    agentReviewStore.setBaseline(file.path, "first");
    const flushing = agentReviewStore.flush([file.path]);
    await started;
    agentReviewStore.setBaseline(file.path, "latest");
    release();
    await flushing;
    assert.deepEqual(posted.map(({ baseline, revision }) => [baseline, revision]), [["first", "flush-1"], ["latest", "flush-2"]]);
    await agentReviewStore.keep([file.path]);
  } finally { release(); globalThis.fetch = originalFetch; }
});

test("Visual review preserves an unchanged raw baseline, restores review on undo/redo, and flushes before incoming text", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const baseline = "# Plan\n\n* Alpha old stays here.\n\nOmega old stays here.\n";
  const current = baseline.replaceAll("old", "new");
  const filePath = "Research/visual.md";
  const published = { current };
  const originalFetch = globalThis.fetch;
  let revision = 1;
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "POST") return Response.json({ files: [{ path: filePath, baseline, current, created: false, revision: "visual-1" }] });
    const body = JSON.parse(String(init.body));
    return Response.json(body.action === "keep" ? { ok: true } : { pending: true, revision: `visual-${++revision}` });
  };
  const editor = new Editor({ extensions: [...createMarkdownExtensions(filePath), TiptapChanges.configure({ documentPath: filePath })], content: current, contentType: "markdown" });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Review() { useTiptapAgentReview(editor, filePath, published); return null; }
  const changes = () => tiptapChangesKey.getState(editor.state)!.changes.filter((change) => change.source === "agent");
  try {
    await agentReviewStore.refresh();
    await act(async () => { root.render(createElement(Review)); });
    assert.equal(changes().length, 2);
    decideTiptapChanges(editor.view, [changes()[0].id], "reject");
    await agentReviewStore.flush([filePath]);
    assert.equal(agentReviewStore.get(filePath)?.baseline, baseline, "rejecting one hunk leaves the exact unchanged baseline intact");
    editor.commands.undo();
    assert.equal(changes().length, 2, "undo restores the rejected agent hunk");
    editor.commands.redo();
    assert.equal(changes().length, 1);
    editor.commands.undo();
    assert.equal(changes().length, 2);
    await agentReviewStore.flush([filePath]);

    editor.view.dispatch(editor.state.tr.insertText("Mine ", 1));
    published.current = editor.getMarkdown();
    await agentReviewStore.flush([filePath]);
    assert.match(agentReviewStore.get(filePath)!.baseline, /Mine Plan/);
    editor.commands.undo();
    await agentReviewStore.flush([filePath]);
    assert.doesNotMatch(agentReviewStore.get(filePath)!.baseline, /Mine Plan/, "undoing user typing must not classify it as an agent change");

    // Do not wait for the 300 ms report timer before replacing from disk.
    editor.view.dispatch(editor.state.tr.insertText("Mine ", 1));
    const incoming = editor.getMarkdown().replace("Omega new", "Omega newest");
    published.current = incoming;
    editor.commands.setContent(incoming, { contentType: "markdown", emitUpdate: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await agentReviewStore.flush([filePath]);
    assert.match(agentReviewStore.get(filePath)!.baseline, /Mine Plan/);
    assert.equal(changes().length, 2, "incoming text is diffed instead of accepting its changed passages");
    await agentReviewStore.keep([filePath]);
  } finally {
    await act(async () => { root.unmount(); });
    editor.destroy();
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
