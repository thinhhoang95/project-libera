import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";
import { latexProjectField } from "../../src/lib/latex/codemirror/editing";

/* Round 4, bibliography and text commands (stat.ME 2611.11188, cs.LO 2611.01825, cs.CL 2611.13560): a natbib .bbl's
 * boilerplate, TeX layout hints (`\penalty0`, `\looseness=-1`, `\allowbreak`), `\doi{…}`, `\urlstyle{…}`, keywords. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string, extra: Extension[] = [], anchor = doc.length) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string, extra: Extension[] = [], anchor = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra, anchor), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

const inDocument = (body: string, preamble = "", documentClass = "article") => `\\documentclass{${documentClass}}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;
const lineTexts = (view: EditorView) => [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => (line.textContent ?? "").replace(/\s+/g, " ").trim());
const mouse = (type: string, init: Record<string, unknown> = {}) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });

/** The visible text of a document body, the caret placed at `anchor` (default: the end, past the body). */
function bodyText(body: string, anchor?: number, preamble = "", documentClass = "article", extra: Extension[] = []) {
  const doc = inDocument(body, preamble, documentClass);
  const view = mount(doc, extra, anchor ?? doc.length);
  const text = lineTexts(view).filter(Boolean).filter((line) => !/^(?:\\documentclass|▸ Preamble|\\end\{document\})/.test(line)).join("\n");
  view.destroy();
  view.dom.parentElement?.remove();
  return text;
}

// The processed .bbl pasted into the body (stat.ME 2611.11188, cs.LO 2611.01825).
const BBL = String.raw`\begin{thebibliography}{56}
\providecommand{\natexlab}[1]{#1}
\providecommand{\url}[1]{\texttt{#1}}
\expandafter\ifx\csname urlstyle\endcsname\relax
  \providecommand{\doi}[1]{doi: #1}\else
  \providecommand{\doi}{doi: \begingroup \urlstyle{rm}\Url}\fi

\bibitem[Altamirano et~al.(2024)Altamirano, Briol, and
  Knoblauch]{Altamirano2024}
Matias Altamirano, Fran\c{c}ois-Xavier Briol, and Jeremias Knoblauch.
\newblock Robust and conjugate {G}aussian process regression.
\newblock In \emph{Proceedings of the 41st International Conference on Machine
  Learning}, volume 235 of \emph{Proceedings of Machine Learning Research},
  pages 1155--1185, 2024.

\bibitem[Nolan(1997)]{Nolan1997}
John~P. Nolan.
\newblock Numerical calculation of stable densities.
\newblock \emph{Scandinavian Journal of Statistics}, 50\penalty0 (2):\penalty0 13--37, 2023.
\newblock \doi{10.1111/sjos.12345}.
\end{thebibliography}`;

/** The visible text with the caret `offset` characters into `marker` (found in the document). */
function textWithCaretIn(body: string, marker: string, offset: number) {
  const doc = inDocument(body);
  return bodyText(body, doc.indexOf(marker) + offset);
}

test("a natbib .bbl's boilerplate folds away, \\penalty and \\doi are drawn clean (stat.ME 2611.11188, cs.LO 2611.01825)", () => {
  const text = bodyText(BBL);
  assert.doesNotMatch(text, /providecommand|natexlab|csname|urlstyle|\\penalty|\\doi|\\expandafter/);
  assert.match(text, /Scandinavian Journal of Statistics, 50\(2\):13–37, 2023\./);
  assert.match(text, /doi: 10\.1111\/sjos\.12345\./);
  // The plain entries are untouched.
  assert.match(text, /Matias Altamirano, François-Xavier Briol, and Jeremias Knoblauch\./);
});

test("the .bbl boilerplate and a \\penalty show their source at the caret (nothing new is drawn: the lines fold, the hints hide)", () => {
  assert.match(textWithCaretIn(BBL, "\\providecommand{\\url}", 3), /\\providecommand\{\\url\}\[1\]\{\\texttt\{#1\}\}/);
  assert.match(textWithCaretIn(BBL, "\\penalty0 (2)", 3), /50\\penalty0 \(2\):13–37/);
});

test("\\doi{…} is a link-like \"doi: …\" whose click shows the source and Ctrl-click opens doi.org (new use of LinkTextWidget)", () => {
  const doc = inDocument(String.raw`See \doi{10.1111/sjos.12345} and \doi{10.1000/a\_b}.`);
  const view = mount(doc);
  const links = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-link")];
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, "doi: 10.1111/sjos.12345");
  assert.equal(links[0].dataset.href, "https://doi.org/10.1111/sjos.12345");
  assert.equal(links[1].textContent, "doi: 10.1000/a_b");
  const from = doc.indexOf("\\doi{10.1111");
  const to = from + "\\doi{10.1111/sjos.12345}".length;
  links[0].dispatchEvent(mouse("mousedown", { ctrlKey: true }));
  assert.equal(view.state.selection.main.head, doc.length, "Ctrl-click leaves the caret (it opens the link)");
  links[0].dispatchEvent(mouse("mousedown"));
  const head = view.state.selection.main.head;
  assert.ok(head > from && head < to, "the caret moved into the command");
  assert.ok(lineTexts(view).join("\n").includes("\\doi{10.1111/sjos.12345}"), "the source shows");
  view.destroy();
});

test("protective braces ({G}aussian) and a scoped \\urlstyle print nothing, and show at the caret (cs.CL 2611.13560, stat.ME 2611.11188)", () => {
  assert.equal(bodyText("A conjugate {G}aussian process."), "A conjugate Gaussian process.");
  assert.match(textWithCaretIn("A conjugate {G}aussian process.", "{G}", 1), /\{G\}aussian/);
  assert.equal(bodyText(String.raw`Code: {\urlstyle{same}\url{https://github.com/x/y}}. Next.`), "Code: https://github.com/x/y. Next.");
  // The innermost construct around the caret shows: the \urlstyle, or (at the brace) the group's braces.
  assert.match(textWithCaretIn(String.raw`Code: {\urlstyle{same}\url{https://github.com/x/y}}. Next.`, "\\urlstyle", 3), /Code: \\urlstyle\{same\}https:/);
  assert.match(textWithCaretIn(String.raw`Code: {\urlstyle{same}\url{https://github.com/x/y}}. Next.`, "{\\urlstyle", 0), /Code: \{https:\/\/github\.com\/x\/y\}\./);
  // A group that is a command's argument or holds a command stays as it is.
  assert.match(bodyText(String.raw`A \unknownmacro {x} here.`), /\\unknownmacro \{x\}/);
});

test("\\looseness=-1 at a paragraph's end is hidden (cs.CL 2611.13560)", () => {
  assert.equal(bodyText("The critic).\\looseness=-1\n\nNext."), "The critic).\nNext.");
  assert.match(textWithCaretIn("The critic).\\looseness=-1\n\nNext.", "\\looseness", 3), /The critic\)\.\\looseness=-1/);
});

test("\\input and \\include draw a chip naming the file; a click shows the source (new widget kind: IncludeChipWidget; cs.CL 2611.13560)", () => {
  const doc = inDocument("\\input{figures/fig_teaser}\n\nText \\include{chapters/a}.\n\n\\IfFileExists{a}{\\input{a}}{}\n");
  const view = mount(doc);
  const chips = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-include")];
  assert.deepEqual(chips.map((chip) => chip.textContent), ["include: figures/fig_teaser", "include: chapters/a"]);
  // `\IfFileExists{a}{\input{a}}{}` stays source.
  assert.match(lineTexts(view).join("\n"), /\\IfFileExists\{a\}\{\\input\{a\}\}\{\}/);
  const from = doc.indexOf("\\input{figures");
  const to = from + "\\input{figures/fig_teaser}".length;
  chips[0].dispatchEvent(mouse("mousedown"));
  const head = view.state.selection.main.head;
  assert.ok(head > from && head < to, "the caret moved into the command");
  assert.ok(lineTexts(view).join("\n").includes("\\input{figures/fig_teaser}"), "the source shows");
  chips[1].dispatchEvent(mouse("mousedown"));
  assert.ok(view.state.selection.main.head > doc.indexOf("\\include{") && view.state.selection.main.head < doc.indexOf("}.", doc.indexOf("\\include{")) + 1);
  view.destroy();
});

test("\\input of a file the project does not have stays source; one it has is a chip", () => {
  const project = (paths: string[]) => [latexProjectField.init(() => ({ labels: [], bibEntries: [], files: [], allPaths: paths }))];
  const body = "\\input{figures/fig_a}\n\n\\input{figures/fig_b}\n";
  const doc = inDocument(body);
  const view = mount(doc, project(["main.tex", "figures/fig_a.tex"]));
  assert.deepEqual([...view.contentDOM.querySelectorAll(".cm-vis-include")].map((chip) => chip.textContent), ["include: figures/fig_a"]);
  assert.match(lineTexts(view).join("\n"), /\\input\{figures\/fig_b\}/);
  view.destroy();
});

test("llncs-style \\keywords{a \\and b} where the arxiv template defines it: \"Keywords: a · b\" (cs.LO 2611.01825)", () => {
  const preamble = "\\usepackage{arxiv}\n\\def\\keywords#1{\\par\\noindent Keywords #1\\par}\n";
  const body = String.raw`\keywords{scope ambiguity \and context-free grammar \and Schr\"oder numbers}`;
  const text = bodyText(body, undefined, preamble);
  assert.equal(text, "Keywords: scope ambiguity · context-free grammar · Schröder numbers");
  // The caret in the line shows the source back.
  const doc = inDocument(body, preamble);
  const view = mount(doc, [], doc.indexOf("scope") + 2);
  assert.match(lineTexts(view).join("\n"), /\\keywords\{scope ambiguity/);
  view.destroy();
});

test("a \\doi with a command in it stays source", () => {
  assert.match(bodyText(String.raw`See \doi{\unknown}.`), /\\doi\{\\unknown\}/);
});

test("\\penalty, \\allowbreak, \\nobreak, \\relax, \\looseness print nothing, and show at the caret", () => {
  const body = String.raw`one\penalty0 two\penalty-10000 three\allowbreak four\nobreak five\relax six\looseness=-1 seven`;
  assert.equal(bodyText(body), "onetwothreefourfivesixseven");
  assert.match(textWithCaretIn(body, "\\penalty0", 3), /one\\penalty0 two/);
  assert.match(textWithCaretIn(body, "\\looseness", 3), /six\\looseness=-1 seven/);
});
