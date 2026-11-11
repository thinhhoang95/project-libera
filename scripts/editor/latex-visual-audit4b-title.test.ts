import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { preambleOpenField, setMacroSources, setNumbering, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 4b. stat.ME 2611.11188's supplement writes its title block by hand in a body file (`\def\@title{…}`,
 * `\def\@author{…}`, `\def\@date{}`, then `\arxivmaketitle`, which the main preamble `\let`s to `\@maketitle`): the title
 * block's widget over those lines. No new widget kind: it is the title block's own TitleWidget, with its click-to-edit
 * parts, Edit source button and Alt-click. The folded `\makeatletter` and `\makeatother` lines are the layout kind other
 * folded lines are, shown again at the cursor. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function settle(state: EditorState) {
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string, sources: MacroSource[] = [], anchor = doc.length) {
  let state = EditorState.create({ doc, selection: { anchor }, extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/supplement-body.tex" })] });
  ensureSyntaxTree(state, doc.length, 5000);
  if (sources.length) state = state.update({ effects: setMacroSources.of(sources) }).state;
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: settle(state), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

const press = (target: Element, key: string) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const typeInto = (area: HTMLTextAreaElement, value: string) => { area.value = value; area.dispatchEvent(new window.Event("input", { bubbles: true })); };
const mouse = (node: Element, init: Record<string, unknown> = {}) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));
const block = (view: EditorView) => view.contentDOM.querySelector<HTMLElement>(".cm-vis-title-block");
const part = (view: EditorView, name: string, index = 0) => view.contentDOM.querySelector<HTMLElement>(`.cm-vis-title-block [data-title-part="${name}"][data-title-index="${index}"]`)!;
const editor = (view: EditorView) => view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor");
const sourceButton = (view: EditorView) => view.contentDOM.querySelector<HTMLButtonElement>(".cm-vis-title-block .cm-vis-title-source");
const at = (view: EditorView, needle: string, shift = 0) => view.state.doc.toString().indexOf(needle) + shift;

/** The main file's `\let\arxivmaketitle\@maketitle` between `\makeatletter` and `\makeatother`, as a project macro file. */
const MAIN_PREAMBLE: MacroSource[] = [{ path: "nb/main.tex", text: "\\makeatletter\n\\let\\arxivmaketitle\\@maketitle\n\\makeatother\n", version: "1" }];

const SUPPLEMENT = String.raw`\clearpage
\makeatletter
\def\@title{Supplementary Material for ''Heavy tails in Gaussian-process surrogates:\\ process-level profiling degeneracy''}
\def\@author{Neelesh S.\ Upadhye and Rohit Kumar Mani\\[2pt]
\normalsize Department of Mathematics, Indian Institute of Technology Madras,\\ \normalsize Chennai 600036, India}
\def\@date{}
\arxivmaketitle
\thispagestyle{plain}
\makeatother
\noindent Theorems without the prefix S refer to the main article.

\section{Proofs}
Text.
`;

test("stat.ME 2611.11188: hand-written \\def\\@title/\\@author/\\@date and \\arxivmaketitle draw as the title block, with no date and no source", () => {
  const view = mount(SUPPLEMENT, MAIN_PREAMBLE);
  assert.ok(block(view), "the title block is drawn");
  assert.match(part(view, "title").textContent ?? "", /^Supplementary Material for .*Heavy tails in Gaussian-process surrogates:/);
  assert.equal(view.contentDOM.querySelectorAll('.cm-vis-title-block [data-title-part="author"]').length, 1, "`and` is text; only \\and separates authors");
  assert.match(part(view, "author").textContent ?? "", /Neelesh S\.\s*Upadhye and Rohit Kumar Mani/);
  assert.match(part(view, "author").textContent ?? "", /Department of Mathematics, Indian Institute of Technology Madras,\s*Chennai 600036, India/);
  assert.equal(view.contentDOM.querySelector(".cm-vis-title-block .cm-vis-date"), null, "`\\def\\@date{}` prints no date");
  const shown = view.contentDOM.textContent ?? "";
  for (const junk of ["\\def", "@title", "@author", "@date", "arxivmaketitle", "\\normalsize", "\\makeatletter", "thispagestyle"]) assert.equal(shown.includes(junk), false, `${junk} is not shown`);
  assert.match(shown, /Theorems without the prefix S/);
  view.destroy();
});

test("the same title block when the main file's `\\let` is in the open file's own preamble", () => {
  const doc = String.raw`\documentclass{article}
\makeatletter
\let\arxivmaketitle\@maketitle
\makeatother
\begin{document}
\makeatletter
\def\@title{A Title}
\def\@author{Alice One \and Bob Two}
\def\@date{June 2025}
\arxivmaketitle
\makeatother
Text.
\end{document}`;
  const view = mount(doc);
  assert.equal(part(view, "title").textContent, "A Title");
  assert.equal(view.contentDOM.querySelectorAll('.cm-vis-title-block [data-title-part="author"]').length, 2);
  assert.equal(part(view, "date").textContent, "June 2025");
  view.destroy();
});

test("click-to-source: clicking a part edits its definition in place, Alt-click and Edit source show the \\def lines", () => {
  const view = mount(SUPPLEMENT, MAIN_PREAMBLE);
  // A click on the title opens its LaTeX (the argument of `\def\@title`), saved as a minimal change.
  mouse(part(view, "title"));
  const area = editor(view)!;
  assert.ok(area, "the title's field is open");
  assert.match(area.value, /^Supplementary Material for ''Heavy tails/);
  typeInto(area, area.value.replace("Supplementary Material", "Supplement"));
  press(area, "Enter");
  assert.match(view.state.doc.toString(), /\\def\\@title\{Supplement for ''Heavy tails/);
  assert.match(part(view, "title").textContent ?? "", /^Supplement for /);
  // The author is one part: its field holds the whole `\def\@author` argument, line breaks included.
  mouse(part(view, "author"));
  assert.match(editor(view)!.value, /^Neelesh S\.\\ Upadhye and Rohit Kumar Mani\\\\\[2pt\]\n\\normalsize Department/);
  press(editor(view)!, "Escape");
  // No author can be added (the authors are one `\def`).
  assert.equal(view.contentDOM.querySelector<HTMLElement>(".cm-vis-title-add-author")?.hidden ?? true, true);
  // Alt-click: the block's real source, with the cursor in the first `\def`.
  mouse(part(view, "date") ?? part(view, "title"), { altKey: true });
  const head = view.state.selection.main.head;
  assert.ok(head > at(view, "\\def\\@title") && head < at(view, "\\arxivmaketitle"), "the cursor is in the block's source");
  assert.match(view.contentDOM.textContent ?? "", /\\def\\@title\{Supplement for/);
  assert.match(view.contentDOM.textContent ?? "", /\\def\\@author\{Neelesh/);
  assert.match(view.contentDOM.textContent ?? "", /\\arxivmaketitle/);
  assert.ok(block(view) === null, "the block shows its source while the cursor is in it");
  // Leaving draws it again.
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  assert.ok(block(view));
  // Edit source: the same, from the button.
  sourceButton(view)!.click();
  assert.ok(view.state.selection.main.head > at(view, "\\def\\@title") && view.state.selection.main.head < at(view, "\\arxivmaketitle"));
  assert.match(view.contentDOM.textContent ?? "", /\\def\\@date\{\}/);
  view.destroy();
});

test("hidden commands show their source at the cursor: \\makeatletter, \\makeatother, \\thispagestyle around the block", () => {
  for (const needle of ["\\makeatletter", "\\thispagestyle{plain}", "\\makeatother"]) {
    const view = mount(SUPPLEMENT, MAIN_PREAMBLE, 0);
    assert.equal((view.contentDOM.textContent ?? "").includes(needle), false, `${needle} is hidden with the cursor elsewhere`);
    view.dispatch({ selection: { anchor: at(view, needle, 3) } });
    assert.ok((view.contentDOM.textContent ?? "").includes(needle), `${needle} shows its source with the cursor in it`);
    view.destroy();
  }
});

test("the source stays when it is not unambiguously a title block", () => {
  // The macro is not known to print the title.
  let view = mount(SUPPLEMENT);
  assert.ok(block(view) === null);
  assert.match(view.contentDOM.textContent ?? "", /\\def\\@title/);
  view.destroy();
  // Something else between the definitions and the macro, or on their lines.
  for (const doc of [
    SUPPLEMENT.replace("\\def\\@date{}\n", "\\def\\@date{}\nSome text.\n"),
    SUPPLEMENT.replace("\\arxivmaketitle", "\\arxivmaketitle Some text."),
    SUPPLEMENT.replace("\\makeatletter\n\\def\\@title", "\\makeatletter \\def\\@title"),
  ]) {
    view = mount(doc, MAIN_PREAMBLE);
    assert.ok(block(view) === null, "no title block");
    assert.match(view.contentDOM.textContent ?? "", /\\def\\@title/);
    view.destroy();
  }
  // Definitions in a comment do not count.
  view = mount(SUPPLEMENT.replace("\\def\\@title", "%\\def\\@title").replace("\\def\\@author", "%\\def\\@author"), MAIN_PREAMBLE);
  assert.ok(block(view) === null);
  view.destroy();
});

test("editing the file around the block keeps it drawn (a definition added or removed redraws it)", () => {
  const view = mount(SUPPLEMENT, MAIN_PREAMBLE, 0);
  assert.equal(part(view, "date")?.textContent ?? null, null);
  view.dispatch({ changes: { from: at(view, "\\def\\@date{}") + "\\def\\@date{".length, insert: "May 2026" } });
  assert.equal(part(view, "date").textContent, "May 2026");
  view.dispatch({ changes: { from: at(view, "\\def\\@title") + "\\def\\@title{".length, insert: "New: " } });
  assert.match(part(view, "title").textContent ?? "", /^New: Supplementary/);
  assert.equal(view.state.field(preambleOpenField), false);
  view.destroy();
});

/* math.CO 2611.13390: five proofs open with `\begin{proof}[Proof of~\cref{…}]\renewcommand{\qedsymbol}{$\blacksquare$}` on one
 * line. The command is hidden as part of the proof header's construct, so the cursor anywhere on that line shows the whole
 * line as source (a hidden command of its own lost the reveal to the longer header and could not be reached). The proof's
 * end mark is the custom symbol. No new widget: the header is the proof header's own widget. */

const PROOF = String.raw`\documentclass{amsart}
\begin{document}
\begin{proof}[Proof of the claim]\renewcommand{\qedsymbol}{$\blacksquare$} Assume the contrary.
More text.
\end{proof}
Done.
\end{document}`;
const RENEWAL = "\\renewcommand{\\qedsymbol}{$\\blacksquare$}";

test("same-line \\renewcommand{\\qedsymbol}: hidden with the cursor elsewhere, the proof ends with the custom mark", () => {
  const view = mount(PROOF, [], PROOF.length);
  const shown = view.contentDOM.textContent ?? "";
  assert.doesNotMatch(shown, /renewcommand|qedsymbol|blacksquare/);
  assert.match(shown, /Proof of the claim/);
  assert.match(shown, /Assume the contrary\./);
  assert.ok(view.contentDOM.querySelector(".cm-vis-env-header-proof"), "the proof header is drawn");
  assert.match(shown, /■/, "the proof ends with the document's \\qedsymbol");
  view.destroy();
});

test("the cursor on that line shows its source, the \\renewcommand included, at each place on it", () => {
  const begin = PROOF.indexOf("\\begin{proof}");
  const places = [begin, begin + 5, PROOF.indexOf(RENEWAL), PROOF.indexOf(RENEWAL) + 5, PROOF.indexOf(RENEWAL) + RENEWAL.length, PROOF.indexOf(" Assume"), PROOF.indexOf("More") - 1];
  for (const place of places) {
    const view = mount(PROOF, [], place);
    const shown = view.contentDOM.textContent ?? "";
    assert.ok(shown.includes(RENEWAL), `the command's source shows with the cursor at ${place}`);
    assert.ok(shown.includes("\\begin{proof}[Proof of the claim]"), `and so does the header's, at ${place}`);
    view.destroy();
  }
  // The next line is not the line.
  const view = mount(PROOF, [], PROOF.indexOf("More"));
  assert.doesNotMatch(view.contentDOM.textContent ?? "", /renewcommand/);
  view.destroy();
});

test("a click on the proof header still works: it puts the cursor on the line, which shows its source, and leaving draws it again", () => {
  const view = mount(PROOF, [], PROOF.length);
  const header = view.contentDOM.querySelector<HTMLElement>(".cm-vis-env-header-proof")!;
  assert.ok(header);
  // A mousedown on it is left to the editor, which puts the cursor next to the widget: before it, or after it where the command was hidden.
  mouse(header);
  for (const anchor of [PROOF.indexOf("\\begin{proof}"), PROOF.indexOf(RENEWAL)]) {
    view.dispatch({ selection: { anchor } });
    assert.ok((view.contentDOM.textContent ?? "").includes(RENEWAL), `source shows with the cursor at ${anchor}`);
  }
  view.dispatch({ selection: { anchor: PROOF.length } });
  assert.ok(view.contentDOM.querySelector(".cm-vis-env-header-proof"), "drawn again");
  assert.doesNotMatch(view.contentDOM.textContent ?? "", /renewcommand/);
  view.destroy();
});

test("a proof without the same-line command, and a different command on the line, are as before", () => {
  const plain = PROOF.replace(RENEWAL, "");
  let view = mount(plain, [], plain.length);
  assert.match(view.contentDOM.textContent ?? "", /Proof of the claim\.\s+Assume the contrary\./);
  view.destroy();
  const other = PROOF.replace(RENEWAL, "\\renewcommand{\\thesection}{S\\arabic{section}}");
  view = mount(other, [], other.length);
  assert.match(view.contentDOM.textContent ?? "", /Proof of the claim/);
  view.destroy();
});
