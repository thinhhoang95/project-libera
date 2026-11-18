import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import * as Y from "yjs";
import { history, undo, undoDepth } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers, type DecorationSet } from "@codemirror/view";
import { collabExtension } from "../../src/lib/collab/bindings/codemirror";
import { compileFind, compileFindReplacement, DEFAULT_FIND_OPTIONS, type Finder, type FindMatch, type FindOptions, type Replacer } from "../../src/lib/find";
import {
  activeFindRanges, findHighlightsField, findInState, findWithinField, replaceAllSpec, replaceTextSpec, searchKeymapWithoutPanel,
  setActiveFindMatch, setFindMatches, setFindWithin,
} from "../../src/lib/find/codemirror";
import { CodeMirrorFindSession, type FindOpenRequest } from "../../src/lib/find/codemirror-session";
import {
  createFindSearchRunner, type FindSearchRunner, type FindWorkerLike, type FindWorkerRequest, type FindWorkerResponse,
} from "../../src/lib/find/worker-search";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState, visualRevealRanges } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";

// CodeMirror read the platform when it loaded (Node's navigator, before jsdom's): Mod is Cmd on a Mac.
const MAC = /Mac/.test(globalThis.navigator?.platform ?? "");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "DOMParser", "KeyboardEvent"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });

function finder(query: string, options: Partial<FindOptions> = {}): Finder {
  const compiled = compileFind(query, { ...DEFAULT_FIND_OPTIONS, ...options });
  assert.ok(compiled.ok, `query ${query} compiles`);
  return compiled.finder;
}

function replacer(find: Finder, replacement: string): Replacer {
  const compiled = compileFindReplacement(find, replacement, false);
  assert.ok(compiled.ok, `replacement ${replacement} compiles`);
  return compiled.replacer;
}

function decorated(set: DecorationSet, length: number) {
  const out: { from: number; to: number; active: boolean }[] = [];
  set.between(0, length, (from, to, value) => {
    out.push({ from, to, active: String(value.spec.class).includes("markdown-editor-find-match-active") });
  });
  return out;
}

const mounted: EditorView[] = [];
after(() => { for (const view of mounted) view.destroy(); dom.window.close(); });

function mount(doc: string, extensions: Extension[] = [], selection?: { anchor: number; head?: number }) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc, selection, extensions }), parent });
  mounted.push(view);
  return view;
}

function sessionView(doc: string, options: { extensions?: Extension[]; selection?: { anchor: number; head?: number }; createRunner?: () => FindSearchRunner } = {}) {
  const session = new CodeMirrorFindSession({ debounceMs: 5, createRunner: options.createRunner });
  const transactions: Transaction[] = [];
  const view = mount(doc, [
    history(),
    session.extension,
    keymap.of([...session.keymap, ...searchKeymapWithoutPanel]),
    EditorView.updateListener.of((update) => { transactions.push(...update.transactions); }),
    ...(options.extensions ?? []),
  ], options.selection);
  session.attach(view);
  return { session, view, transactions };
}

function useQuery(session: CodeMirrorFindSession, query: string, replacement = "", options: Partial<FindOptions> = {}) {
  const find = finder(query, options);
  session.setQuery({ query, finder: find, replacer: replacer(find, replacement) });
}

/* ---- Matches and decorations ---- */

test("matches are drawn with the Markdown editor's classes, the active one marked", () => {
  const view = mount("one x two x three x", [findHighlightsField]);
  const result = findInState(view.state, finder("x"));
  assert.deepEqual(result.matches.map((match) => match.start), [4, 10, 18]);
  view.dispatch({ effects: setFindMatches.of({ matches: result.matches, active: 1 }) });
  const value = view.state.field(findHighlightsField);
  assert.equal(value.doc, view.state.doc);
  assert.deepEqual(decorated(value.decorations, view.state.doc.length), [
    { from: 4, to: 5, active: false }, { from: 10, to: 11, active: true }, { from: 18, to: 19, active: false },
  ]);
  assert.equal(view.contentDOM.querySelectorAll(".markdown-editor-find-match").length, 3);
  assert.equal(view.contentDOM.querySelectorAll(".markdown-editor-find-match-active").length, 1);
  assert.deepEqual(activeFindRanges(view.state), [{ from: 10, to: 11 }]);

  view.dispatch({ effects: setActiveFindMatch.of(2) });
  assert.deepEqual(activeFindRanges(view.state), [{ from: 18, to: 19 }]);
});

test("matches are mapped through edits until the next search; a removed active match passes to the next", () => {
  const view = mount("one x two x three x", [findHighlightsField]);
  view.dispatch({ effects: setFindMatches.of({ matches: findInState(view.state, finder("x")).matches, active: 1 }) });
  view.dispatch({ changes: { from: 0, insert: ">> " } });
  let value = view.state.field(findHighlightsField);
  assert.notEqual(value.doc, view.state.doc, "mapped, not searched");
  assert.deepEqual(value.matches.map((match) => match.start), [7, 13, 21]);
  assert.equal(value.active, 1);
  // Delete the active match: the next one becomes active and is drawn so.
  view.dispatch({ changes: { from: 13, to: 14 } });
  value = view.state.field(findHighlightsField);
  assert.deepEqual(value.matches.map((match) => match.start), [7, 20]);
  assert.equal(value.active, 1);
  assert.deepEqual(decorated(value.decorations, view.state.doc.length).map((range) => range.active), [false, true]);
  // Typing at a match's edge does not grow it.
  view.dispatch({ changes: { from: 8, insert: "y" } });
  assert.deepEqual(view.state.field(findHighlightsField).matches.map((match) => [match.start, match.end]), [[7, 8], [21, 22]]);
});

/* ---- Replace ---- */

test("Replace All is one transaction, one undo step, and numbers @# in document order", async () => {
  const { session, view, transactions } = sessionView("TODO a\nTODO b\nTODO c");
  session.open(view, "replace");
  useQuery(session, "TODO", "TODO-@#", { mode: "pattern" });
  assert.equal(session.getSnapshot().matchCount, 3);
  const before = transactions.length;
  await session.replaceAll();
  const edits = transactions.slice(before).filter((tr) => tr.docChanged);
  assert.equal(edits.length, 1);
  assert.ok(edits[0].isUserEvent("input.replace.all"));
  assert.equal(view.state.doc.toString(), "TODO-1 a\nTODO-2 b\nTODO-3 c");
  assert.deepEqual(session.getSnapshot().summary, { replaced: 3, skipped: 0 });
  assert.equal(undoDepth(view.state), 1);
  undo(view);
  assert.equal(view.state.doc.toString(), "TODO a\nTODO b\nTODO c");
});

test("Replace replaces the active match with its own number and moves to the next match", async () => {
  const { session, view, transactions } = sessionView("TODO a\nTODO b\nTODO c");
  session.open(view, "replace");
  useQuery(session, "TODO", "TODO-@#", { mode: "pattern" });
  session.next();
  assert.equal(session.getSnapshot().active, 1);
  assert.equal(session.getSnapshot().preview?.result, "TODO-2");
  const before = transactions.length;
  await session.replace();
  const edits = transactions.slice(before).filter((tr) => tr.docChanged);
  assert.equal(edits.length, 1);
  assert.ok(edits[0].isUserEvent("input.replace"));
  assert.equal(view.state.doc.toString(), "TODO a\nTODO-2 b\nTODO c");
  // The next match after the replacement is active and selected (TODO-2 itself matches again, but lies before it).
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.active, 2);
  assert.deepEqual([view.state.selection.main.from, view.state.selection.main.to], [16, 20]);
});

test("matches whose replacement fails are skipped and counted", async () => {
  const { session, view } = sessionView("v=1 v=a v=2");
  session.open(view, "replace");
  useQuery(session, "v=@x:word", "v=@(x+1)", { mode: "pattern" });
  assert.equal(session.getSnapshot().matchCount, 3);
  await session.replaceAll();
  assert.equal(view.state.doc.toString(), "v=2 v=a v=3");
  assert.deepEqual(session.getSnapshot().summary, { replaced: 2, skipped: 1 });

  // The pure helper agrees, and leaves the skipped match untouched.
  const state = EditorState.create({ doc: "v=1 v=a" });
  const find = finder("v=@x:word", { mode: "pattern" });
  const spec = replaceAllSpec(state, findInState(state, find).matches, replacer(find, "v=@(x*2)"));
  assert.equal(spec.skipped, 1);
  assert.equal(spec.replaced, 1);
  assert.equal(state.update(spec.spec!).state.doc.toString(), "v=2 v=a");
});

test("Replace All under collaboration sends one Yjs update and undoes in one step", async () => {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("source");
  ytext.insert(0, "a x b x c x");
  const binding = collabExtension({ ytext, awareness: null, user: { name: "Alice", color: "#3366ff" } });
  const session = new CodeMirrorFindSession({ debounceMs: 5 });
  const view = mount(ytext.toString(), [binding.extension, session.extension, keymap.of(session.keymap)]);
  session.attach(view);
  let updates = 0;
  ydoc.on("update", () => { updates++; });
  session.open(view, "replace");
  useQuery(session, "x", "yy");
  await session.replaceAll();
  assert.equal(ytext.toString(), "a yy b yy c yy");
  assert.equal(updates, 1);
  binding.undoManager.undo();
  assert.equal(ytext.toString(), "a x b x c x");
  binding.destroy();
});

test("a whole-text rewrite becomes one change over the span that differs", () => {
  const state = EditorState.create({ doc: "keep \\(a\\) and \\(b\\) keep" });
  const spec = replaceTextSpec(state, "keep \\[a\\] and \\[b\\] keep");
  assert.deepEqual(spec?.changes, { from: 6, to: 20, insert: "[a\\] and \\[b\\]" });
  assert.equal(replaceTextSpec(state, state.doc.toString()), null);
});

/* ---- Options ---- */

test("Where scopes use the LaTeX flavor: inside math, outside math, skip comments", () => {
  const text = "x $x$ \\(x+1\\) % x\n\\verb|x| x";
  const state = EditorState.create({ doc: text, extensions: [findWithinField] });
  const starts = (scope: FindOptions["scope"]) => findInState(state, finder("x", { flavor: "latex", scope })).matches.map((match) => match.start);
  assert.deepEqual(starts("anywhere"), [0, 3, 8, 16, 24, 27]);
  assert.deepEqual(starts("insideMath"), [3, 8]);
  assert.deepEqual(starts("outsideMath"), [0, 16, 24, 27]);
  assert.deepEqual(starts("skipCommentsAndCode"), [0, 3, 8, 27]);
});

test("In selection keeps the selection made before searching, mapped through edits", () => {
  const doc = "x x\nx x\nx x";
  const { session, view } = sessionView(doc, { selection: { anchor: 4, head: 7 } });
  session.open(view, "find");
  useQuery(session, "x");
  assert.equal(session.getSnapshot().matchCount, 6);
  // Searching selected a match; In selection still uses the user's selection.
  assert.notDeepEqual([view.state.selection.main.from, view.state.selection.main.to], [4, 7]);
  session.toggleInSelection();
  assert.equal(session.getSnapshot().inSelection, true);
  assert.deepEqual(view.state.field(findWithinField), [{ start: 4, end: 7 }]);
  assert.deepEqual(view.state.field(findHighlightsField).matches.map((match) => match.start), [4, 6]);

  view.dispatch({ changes: { from: 0, insert: "zz\n" } });
  assert.deepEqual(view.state.field(findWithinField), [{ start: 7, end: 10 }]);
  void session.searchNow();
  assert.deepEqual(view.state.field(findHighlightsField).matches.map((match) => match.start), [7, 9]);

  // Replacing a whole range keeps it inside.
  const state = EditorState.create({ doc: "abc", extensions: [findWithinField] });
  const next = state.update({ effects: setFindWithin.of([{ start: 0, end: 3 }]) }).state.update({ changes: { from: 0, to: 3, insert: "abcdef" } }).state;
  assert.deepEqual(next.field(findWithinField), [{ start: 0, end: 6 }]);

  session.toggleInSelection();
  assert.equal(session.getSnapshot().inSelection, false);
  assert.equal(session.getSnapshot().matchCount, 6);
});

test("edits search again after the debounce; the active match stays put", async () => {
  const { session, view } = sessionView("a x b x c x");
  session.open(view, "find");
  useQuery(session, "x");
  session.next();
  assert.equal(session.getSnapshot().active, 1);
  view.dispatch({ changes: { from: 0, insert: "x " } });
  // Mapped at once, searched again shortly after.
  assert.equal(session.getSnapshot().matchCount, 3);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(view.state.field(findHighlightsField).doc, view.state.doc);
  assert.equal(session.getSnapshot().matchCount, 4);
  assert.equal(view.state.field(findHighlightsField).matches[session.getSnapshot().active].start, 8);
});

/* ---- Keys ---- */

function press(view: EditorView, key: string, modifiers: { mod?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) {
  const { mod = false, ...rest } = modifiers;
  const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...rest, ...(mod ? (MAC ? { metaKey: true } : { ctrlKey: true }) : {}) });
  return runScopeHandlers(view, event as unknown as KeyboardEvent, "editor");
}

test("the stock panel's keys are gone; Mod-d and the other search commands stay", () => {
  const keys = searchKeymapWithoutPanel.map((binding) => binding.key);
  assert.ok(keys.includes("Mod-d"));
  assert.ok(keys.includes("Mod-Shift-l"));
  assert.ok(keys.includes("Mod-Alt-g"));
  for (const key of ["Mod-f", "F3", "Mod-g", "Escape"]) assert.ok(!keys.includes(key), key);

  const { session, view } = sessionView("foo bar foo", { selection: { anchor: 0, head: 3 }, extensions: [EditorState.allowMultipleSelections.of(true)] });
  assert.equal(press(view, "d", { mod: true }), true);
  assert.equal(view.state.selection.ranges.length, 2, "Mod-d selected the next occurrence");

  const requests: FindOpenRequest[] = [];
  session.onOpenRequest((request) => requests.push(request));
  view.dispatch({ selection: { anchor: 4, head: 7 } });
  assert.equal(press(view, "f", { mod: true }), true);
  assert.equal(session.getSnapshot().open, true);
  assert.deepEqual(requests.at(-1), { focus: "find", seed: "bar" });
  assert.equal(press(view, "h", { mod: true }), true);
  assert.deepEqual(requests.at(-1), { focus: "replace", seed: "bar" });

  useQuery(session, "foo");
  const at = () => view.state.selection.main.from;
  assert.equal(at(), 8, "the first match from the cursor");
  press(view, "F3");
  assert.equal(at(), 0);
  press(view, "g", { mod: true });
  assert.equal(at(), 8);
  press(view, "F3", { shiftKey: true });
  assert.equal(at(), 0);
  assert.equal(press(view, "Escape"), true);
  assert.equal(session.getSnapshot().open, false);
  assert.equal(view.state.field(findHighlightsField).matches.length, 0);
  // Closed: Escape is left to others.
  assert.equal(press(view, "Escape"), false);
});

/* ---- LaTeX Visual ---- */

test("the active match inside a rendered formula is shown as source in the Visual mode", () => {
  const doc = "\\documentclass{article}\n\\begin{document}\nText $a^2 + b$ and more text.\n\\end{document}\n";
  let state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), findHighlightsField, visualRevealRanges.of(activeFindRanges), latexVisualMode({ documentPath: "nb/main.tex" })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  for (let guard = 0; state.field(structuralField).pending.length && guard < 500; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  const at = doc.indexOf("a^2");
  const hiddenAt = (current: EditorState): boolean => {
    let hidden: boolean = false;
    current.field(structuralField).shown.between(at, at + 1, (from, to) => { if (from <= at && to > at) hidden = true; });
    return hidden;
  };
  assert.equal(hiddenAt(state), true, "the formula is drawn");
  const match: FindMatch = { start: at, end: at + 3, captures: [] };
  state = state.update({ effects: setFindMatches.of({ matches: [match], active: 0 }) }).state;
  assert.equal(hiddenAt(state), false, "the active match's formula shows its source");
  state = state.update({ effects: setFindMatches.of({ matches: [], active: -1 }) }).state;
  assert.equal(hiddenAt(state), true);
});

/* ---- Regex worker ---- */

class FakeWorker implements FindWorkerLike {
  static created: FakeWorker[] = [];
  posted: FindWorkerRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<FindWorkerResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor() { FakeWorker.created.push(this); }
  postMessage(message: FindWorkerRequest) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  reply(response: FindWorkerResponse) { this.onmessage?.({ data: response } as MessageEvent<FindWorkerResponse>); }
}

const REGEX: FindOptions = { ...DEFAULT_FIND_OPTIONS, mode: "regex" };

test("regex searches run in the worker; a newer search wins", async () => {
  FakeWorker.created = [];
  const runner = createFindSearchRunner({ createWorker: () => new FakeWorker(), deadlineMs: 1000 });
  const first = runner.search({ query: "a+", options: REGEX, text: "aa b a" });
  const worker = FakeWorker.created[0];
  assert.equal(worker.posted[0].query, "a+");
  const second = runner.search({ query: "b", options: REGEX, text: "aa b a" });
  assert.equal(await first, null, "replaced by the newer search");
  // The busy worker was dropped (it might be stuck); the newer search went to a fresh one.
  assert.equal(worker.terminated, true);
  const fresh = FakeWorker.created[1];
  fresh.reply({ id: fresh.posted[0].id - 1, result: { matches: [{ start: 0, end: 2, captures: [] }], incomplete: false } });
  fresh.reply({ id: fresh.posted[0].id, result: { matches: [{ start: 3, end: 4, captures: [] }], incomplete: false } });
  assert.deepEqual((await second)?.matches.map((match) => match.start), [3]);
  runner.dispose();
});

test("a regex search past its deadline is stopped and reported incomplete", async () => {
  FakeWorker.created = [];
  const runner = createFindSearchRunner({ createWorker: () => new FakeWorker(), deadlineMs: 10 });
  const outcome = await runner.search({ query: "(a+)+$", options: REGEX, text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaab" });
  assert.deepEqual(outcome, { matches: [], incomplete: true, timedOut: true });
  assert.equal(FakeWorker.created[0].terminated, true);
  runner.dispose();
});

test("without Worker support regex searches run synchronously", async () => {
  const runner = createFindSearchRunner();
  const outcome = await runner.search({ query: "b(\\d)", options: REGEX, text: "b1 b2 c3" });
  assert.deepEqual(outcome?.matches.map((match) => [match.start, match.captures[0].start]), [[0, 1], [3, 4]]);
});

test("the session sends Regex mode to the runner and ignores stale results", async () => {
  FakeWorker.created = [];
  const { session, view } = sessionView("b1 b2 c3", { createRunner: () => createFindSearchRunner({ createWorker: () => new FakeWorker(), deadlineMs: 1000 }) });
  session.open(view, "replace");
  useQuery(session, "b(\\d)", "c@1", { mode: "regex" });
  const worker = FakeWorker.created[0];
  const request = worker.posted.at(-1)!;
  assert.equal(request.text, "b1 b2 c3");
  worker.reply({ id: request.id, result: { matches: [{ start: 0, end: 2, captures: [{ index: 1, start: 1, end: 2 }] }, { start: 3, end: 5, captures: [{ index: 1, start: 4, end: 5 }] }], incomplete: false } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.getSnapshot().matchCount, 2);
  assert.equal(session.getSnapshot().preview?.result, "c1");

  // An edit makes the result stale: it is not applied, and Replace All waits for a fresh search.
  view.dispatch({ changes: { from: 0, insert: "b0 " } });
  const replacing = session.replaceAll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const current = FakeWorker.created.at(-1)!;
  const fresh = current.posted.at(-1)!;
  assert.equal(fresh.text, "b0 b1 b2 c3");
  current.reply({ id: fresh.id, result: { matches: [0, 3, 6].map((start) => ({ start, end: start + 2, captures: [{ index: 1, start: start + 1, end: start + 2 }] })), incomplete: false } });
  await replacing;
  assert.equal(view.state.doc.toString(), "c0 c1 c2 c3");
  session.dispose();
});
