import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import * as Y from "yjs";
import { history, undo, undoDepth } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { collabExtension } from "../../src/lib/collab/bindings/codemirror";
import { SyncLimits } from "../../src/lib/collab/protocol";
import {
  classifyPaste, convertSelectionCommand, insertLatexAt, insertPlainAt, isCodeOnlyHtml, latexMarkdownPaste, pasteFromClipboard, pasteStaysLiteral,
  revertPasteToPlain, trackRange, type MarkdownPasteConfig, type MarkdownPasteRequest,
} from "../../src/lib/latex/codemirror/markdown-paste";
import { pasteHtmlAsLatex } from "../../src/lib/latex/codemirror/visual/paste";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualState } from "../../src/lib/latex/codemirror/visual";

/* The paste flow around the converter (docs/latex-markdown-paste-plan.md §1, §5,
 * §6.1, §8): undo steps, stale and literal targets, several cursors, rich text in
 * Source mode, the context menu's Paste and the remembered settings. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup) fn();
  dom.window.close();
});

const DOC = String.raw`\documentclass{article}
\usepackage{booktabs}
\begin{document}
\section{Intro}
Text $x$ here OLD.
\end{document}`;

type Options = { detect?: boolean; visual?: boolean; extra?: Extension; history?: boolean };

function config(onRequest: (request: MarkdownPasteRequest) => void, options: Options = {}): MarkdownPasteConfig {
  return { onRequest, detect: () => options.detect ?? true, visual: () => options.visual ?? false };
}

function mount(doc: string, onRequest: (request: MarkdownPasteRequest) => void = () => undefined, options: Options = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const state = EditorState.create({
    doc,
    extensions: [
      options.history === false ? [] : history(), EditorState.allowMultipleSelections.of(true), latexLanguageSupport("main.tex", "tree"), latexVisualState(),
      latexMarkdownPaste(() => config(onRequest, options)), options.extra ?? [],
    ],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  const view = new EditorView({ state, parent });
  cleanup.push(() => view.destroy());
  return view;
}

/** A shared tab: the document lives in a Y.Text and undoes through the binding's Y.UndoManager. */
function mountShared(doc: string) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("source");
  ytext.insert(0, doc);
  const binding = collabExtension({ ytext, awareness: null, user: { name: "Alice", color: "#3366ff" } });
  const parent = document.createElement("div");
  document.body.append(parent);
  const state = EditorState.create({ doc, extensions: [binding.extension, latexLanguageSupport("main.tex", "tree"), latexMarkdownPaste(() => null)] });
  ensureSyntaxTree(state, doc.length, 5000);
  const view = new EditorView({ state, parent });
  cleanup.push(() => { view.destroy(); binding.destroy(); });
  return { view, binding, ytext };
}

function paste(view: EditorView, data: Record<string, string>) {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => data[type] ?? "" } });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

const BIG = `\\textbf{H}\n\n${"a".repeat(300_000)}`;

/* ---- One undo step -------------------------------------------------------------------- */

test("a paste over 64 KB is one undo step on a local tab, package lines included", () => {
  const view = mount(DOC);
  const at = DOC.indexOf(" here");
  const inserted = insertLatexAt(trackRange(view, at, at), { latex: BIG, block: false, packages: ["\\usepackage{soul}"] });
  assert.ok(inserted);
  assert.match(view.state.doc.toString(), /\\usepackage\{soul\}/);
  assert.equal(undoDepth(view.state), 1);
  undo(view);
  assert.equal(view.state.doc.toString(), DOC);

  insertPlainAt(trackRange(view, at, at), BIG);
  assert.equal(undoDepth(view.state), 1);
  undo(view);
  assert.equal(view.state.doc.toString(), DOC);
});

test("a paste over the sync batch size goes in pieces on a shared tab and still undoes as one step", () => {
  const { view, binding, ytext } = mountShared(DOC);
  const at = DOC.indexOf(" here");
  const text = `x${"b".repeat(SyncLimits.batchMaxBytes * 2)}`;
  const updates: number[] = [];
  ytext.doc!.on("update", (update: Uint8Array) => updates.push(update.length));
  const inserted = insertLatexAt(trackRange(view, at, at), { latex: text, block: false, packages: ["\\usepackage{soul}"] });
  assert.ok(inserted);
  // Each piece is a bounded update of its own.
  assert.ok(updates.length >= 3, `${updates.length} updates`);
  assert.ok(updates.every((size) => size <= SyncLimits.batchMaxBytes + 1024));
  assert.equal(binding.undoManager.undoStack.length, 1);
  binding.undoManager.undo();
  assert.equal(view.state.doc.toString(), DOC);
});

/* ---- Paste as plain text instead ---------------------------------------------------------- */

test("the notice's plain-text action leaves one undo step back to before the paste (local tab)", () => {
  const view = mount(DOC);
  const from = DOC.indexOf("OLD");
  // Pasted over a selection: undoing must bring the selection's text back.
  const inserted = insertLatexAt(trackRange(view, from, from + 3), { latex: "\\begin{itemize}\n  \\item a\n\\end{itemize}", block: true })!;
  assert.ok(inserted.history);
  assert.equal(inserted.replaced, "OLD");
  const notice = trackRange(view, inserted.from, inserted.to);
  assert.equal(revertPasteToPlain(notice, inserted, "- a"), true);
  assert.equal(view.state.doc.toString(), DOC.replace("OLD", "- a"));
  undo(view);
  assert.equal(view.state.doc.toString(), DOC);
  assert.equal(undoDepth(view.state), 0);
});

test("after a later edit, the plain-text action replaces the LaTeX as a step of its own", () => {
  const view = mount(DOC);
  const at = DOC.indexOf(" here");
  const inserted = insertLatexAt(trackRange(view, at, at), { latex: "\\textbf{b}", block: false })!;
  const notice = trackRange(view, inserted.from, inserted.to);
  // Typing elsewhere: the paste is no longer the latest step, so it is not undone.
  view.dispatch({ changes: { from: 0, insert: "% note\n" }, userEvent: "input.type" });
  assert.equal(revertPasteToPlain(notice, inserted, "**b**"), true);
  assert.equal(view.state.doc.toString(), `% note\n${DOC.replace(" here", "**b** here")}`);
  undo(view);
  assert.match(view.state.doc.toString(), /\\textbf\{b\}/);
});

test("the plain-text action takes nothing once the LaTeX was edited", () => {
  const view = mount(DOC);
  const at = DOC.indexOf(" here");
  const inserted = insertLatexAt(trackRange(view, at, at), { latex: "\\textbf{b}", block: false })!;
  const notice = trackRange(view, inserted.from, inserted.to);
  view.dispatch({ changes: { from: inserted.from + 9, insert: "REMOTE" } });
  assert.equal(revertPasteToPlain(notice, inserted, "**b**"), false);
  assert.match(view.state.doc.toString(), /\\textbf\{bREMOTE\}/);
});

test("the notice's plain-text action leaves one undo step back to before the paste (shared tab)", () => {
  const { view, binding } = mountShared(DOC);
  const from = DOC.indexOf("OLD");
  const inserted = insertLatexAt(trackRange(view, from, from + 3), { latex: "\\emph{a}", block: false })!;
  assert.equal(inserted.history?.kind, "shared");
  assert.equal(revertPasteToPlain(trackRange(view, inserted.from, inserted.to), inserted, "*a*"), true);
  assert.equal(view.state.doc.toString(), DOC.replace("OLD", "*a*"));
  binding.undoManager.undo();
  assert.equal(view.state.doc.toString(), DOC);
  assert.equal(binding.undoManager.undoStack.length, 0);
});

/* ---- Several cursors -------------------------------------------------------------------- */

test("a paste at several cursors is a plain paste: the Visual mode's HTML paste does not convert it at each", () => {
  const requests: MarkdownPasteRequest[] = [];
  const view = mount(DOC, (request) => requests.push(request), { visual: true, extra: pasteHtmlAsLatex });
  const a = DOC.indexOf("Text");
  const b = DOC.indexOf(" here");
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(a), EditorSelection.cursor(b)]) });
  paste(view, { "text/plain": "A\nB", "text/html": "<h1>A</h1><p>B</p>" });
  assert.equal(requests.length, 0);
  assert.doesNotMatch(view.state.doc.toString(), /\\section\{A\}/);
  paste(view, { "text/plain": "# A\n\n- b\n- c" });
  assert.equal(requests.length, 0);
});

/* ---- Rich text in Source mode ----------------------------------------------------------- */

test("rich text converts in Source mode too, unless it is LaTeX, code, or conversion is off", () => {
  const requests: MarkdownPasteRequest[] = [];
  const view = mount(DOC, (request) => requests.push(request));
  view.dispatch({ selection: { anchor: DOC.indexOf("Text") } });
  paste(view, { "text/plain": "Results\nBold words", "text/html": "<h2>Results</h2><p><b>Bold</b> words</p>" });
  assert.equal(requests.length, 1);
  assert.equal(requests.at(-1)?.html, "<h2>Results</h2><p><b>Bold</b> words</p>");
  requests.at(-1)?.range.release();
  const count = requests.length;
  // LaTeX shown on a web page pastes as written (CodeMirror's own paste puts it in).
  paste(view, { "text/plain": "\\begin{itemize}\n\\item a\n\\end{itemize}", "text/html": "<p><b>\\begin{itemize}</b></p><p>\\item a</p><p>\\end{itemize}</p>" });
  assert.equal(requests.length, count);
  assert.match(view.state.doc.toString(), /\\begin\{itemize\}\n\\item a/);
  // So does code copied from a web page.
  assert.equal(isCodeOnlyHtml("<meta charset='utf-8'><pre><code>x = 1\ny = 2</code></pre>"), true);
  assert.equal(isCodeOnlyHtml("<p>Run <code>x</code> now</p>"), false);
  paste(view, { "text/plain": "x = 1\ny = 2", "text/html": "<pre><code>x = 1\ny = 2</code></pre>" });
  assert.equal(requests.length, count);
  // "Never convert": Source mode leaves rich text alone; the Visual mode converts it as it always has.
  const html = { text: "Bold", html: "<p><b>Bold</b></p>" };
  assert.equal(classifyPaste(view.state, html, config(() => undefined, { detect: false })), null);
  assert.equal(classifyPaste(view.state, html, config(() => undefined, { detect: false, visual: true })), "html");
  // Markdown beside the HTML (a chat's copy button) wins.
  assert.equal(classifyPaste(view.state, { text: "## Results\n\n**Bold** words", html: "<h2>Results</h2><p><b>Bold</b> words</p>" }, config(() => undefined)), "markdown");
});

/* ---- What each request must still find --------------------------------------------------- */

test("requests carry the text they replace, so a collaborator's edit inside it is never overwritten", () => {
  const requests: MarkdownPasteRequest[] = [];
  const view = mount(DOC, (request) => requests.push(request));
  const from = DOC.indexOf("OLD");
  view.dispatch({ selection: { anchor: from, head: from + 3 } });
  paste(view, { "text/plain": "# H\n\n- a\n- b" });
  assert.equal(requests.at(-1)?.expected, "OLD");
  requests.at(-1)?.range.release();
  convertSelectionCommand(view, (request) => requests.push(request));
  const request = requests.at(-1)!;
  assert.equal(request.origin, "selection");
  assert.equal(request.expected, "OLD");
  // A collaborator types inside the selection: the range no longer holds what the request expects.
  view.dispatch({ changes: { from: from + 1, insert: "X" } });
  const at = request.range.current()!;
  assert.notEqual(view.state.sliceDoc(at.from, at.to), request.expected);
  // And wraps the target in math: the place is literal now.
  const cursor = DOC.indexOf(" here");
  const range = trackRange(view, cursor, cursor);
  view.dispatch({ changes: [{ from: cursor, insert: "$a " }, { from: cursor + 5, insert: "$" }] });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  assert.equal(pasteStaysLiteral(view.state, range.current()!.from), true);
});

/* ---- The context menu's Paste ------------------------------------------------------------ */

test("the context menu's Paste converts Markdown like a paste event, and pastes anything else as it is", async () => {
  let clipboard = "";
  Object.defineProperty(navigator, "clipboard", { value: { readText: async () => clipboard, read: async () => { throw new Error("denied"); } }, configurable: true });
  const requests: MarkdownPasteRequest[] = [];
  const view = mount(DOC, (request) => requests.push(request));
  const body = DOC.indexOf(" here");
  view.dispatch({ selection: { anchor: body } });
  clipboard = "# Heading\n\n- a\n- b";
  await pasteFromClipboard(view, config((request) => requests.push(request)));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].origin, "paste");
  requests[0].range.release();
  assert.equal(view.state.doc.toString(), DOC);
  // LaTeX goes in as written.
  clipboard = "\\textbf{x}";
  await pasteFromClipboard(view, config((request) => requests.push(request)));
  assert.equal(requests.length, 1);
  assert.match(view.state.doc.toString(), /\\textbf\{x\} here/);
  // Inside math, Markdown goes in as written too.
  const math = view.state.doc.toString().indexOf("$x$") + 1;
  view.dispatch({ selection: { anchor: math } });
  clipboard = "# H\n\n- a\n- b";
  await pasteFromClipboard(view, config((request) => requests.push(request)));
  assert.equal(requests.length, 1);
  assert.ok(view.state.doc.toString().includes("$# H"));
  // Without a configuration (not a .tex file): plain.
  await pasteFromClipboard(view, null);
  assert.equal(requests.length, 1);
});

/* ---- Remembered settings ----------------------------------------------------------------- */

test("a later paste reads the settings saved since the first load", async () => {
  const realFetch = globalThis.fetch;
  let stored: Record<string, unknown> = { italic: "emph", ask: "structure" };
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") stored = JSON.parse(String(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => stored } as unknown as Response;
  }) as typeof fetch;
  try {
    const store = await import("../../src/components/libera/latex/latex-paste-options-store");
    assert.equal((await store.loadMarkdownPasteOptions()).italic, "emph");
    await store.saveMarkdownPasteOptions({ ...store.getMarkdownPasteOptions(), italic: "textit", ask: "never" });
    const next = await store.loadMarkdownPasteOptions();
    assert.equal(next.italic, "textit");
    assert.equal(next.ask, "never");
    assert.equal(stored.italic, "textit");
  } finally {
    globalThis.fetch = realFetch;
  }
});
