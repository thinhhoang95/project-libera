import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setMacroSources, setNumbering, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { isInLatexComment } from "../../src/lib/latex/macros/definitions";
import { latexProjectField } from "../../src/lib/latex/codemirror/editing";
import { readCompiledBibliography } from "../../src/lib/latex/project";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Front matter, bibliographies and citations, audit round 10 (the arXiv id is at each test). */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = [], sources: MacroSource[] = []) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  if (sources.length) state = state.update({ effects: setMacroSources.of(sources) }).state;
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string, extra: Extension[] = [], sources: MacroSource[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra, sources), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

/** The commands of the document that nothing drawn covers: what the view still shows as source (the audit's "left"). */
function left(view: EditorView) {
  const doc = view.state.doc.toString();
  const shown = view.state.field(structuralField).shown;
  const covered = (pos: number) => {
    let inside = false;
    shown.between(pos, pos + 1, (from, to, decoration) => { if (decoration.point && from <= pos && to > pos) { inside = true; return false; } });
    return inside;
  };
  const found: string[] = [];
  for (const match of doc.matchAll(/\\(?:begin\s*\{([^}]*)\}|([a-zA-Z@]+))/g)) {
    const pos = match.index!;
    if ((pos > 0 && doc[pos - 1] === "\\") || isInLatexComment(doc, pos) || covered(pos)) continue;
    found.push(match[1] !== undefined ? `begin{${match[1]}}` : match[2]);
  }
  return found;
}

const click = (node: Element, init: Record<string, unknown> = {}) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));
const text = (view: EditorView) => view.contentDOM.textContent ?? "";
const shows = (view: EditorView, needle: string) => text(view).includes(needle);
/** The drawn widgets of the document: the outermost non-editable elements. */
const widgets = (view: EditorView) => [...view.contentDOM.querySelectorAll<HTMLElement>("*")].filter((node) => {
  if (node.contentEditable !== "false") return false;
  for (let up = node.parentElement; up && up !== view.contentDOM; up = up.parentElement) if (up.contentEditable === "false") return false;
  return true;
});
/** The text of a widget, a no-break space (`~`) as a space. */
const plain = (node: Element) => (node.textContent ?? "").replace(/ /g, " ");
const widgetWith = (view: EditorView, needle: string) => widgets(view).find((node) => plain(node).includes(needle));

const BIB_COMMENT = String.raw`\documentclass{article}
\begin{document}
Text \cite{a}.
\bibliographystyle{unsrt}
\bibliography{helium}% Produces the bibliography via BibTeX.
\end{document}
`;

// physics.atom-ph 2611.07764 (and physics.space-ph 2610.30517, `\bibliography{references} %don't specify the file extension`):
// a comment after the command kept the whole line as source.
test("2611.07764: \\bibliography with a comment after it on its line is the References list; a click shows the line", () => {
  for (const line of ["\\bibliography{helium}% Produces the bibliography via BibTeX.", "\\bibliography{helium} %don't specify the file extension"]) {
    const view = mount(BIB_COMMENT.replace(/\\bibliography\{helium\}.*/, line));
    assert.deepEqual(left(view), [], line);
    const list = widgetWith(view, "References");
    assert.ok(list, "the References heading");
    click(list!);
    assert.ok(shows(view, "\\bibliography{helium}"), "a click shows the source");
    view.destroy();
  }
});

const REVTEX_ENTRIES = String.raw`\documentclass[aps,prb]{revtex4-2}
\begin{document}
Text \cite{papic2015MBL, SM}.
\begin{onecolumngrid}
\begin{thebibliography}{2}%
\providecommand \natexlab [1]{#1}%
\providecommand \BibitemShut  [1]{\csname bibitem#1\endcsname}%
\bibitem [{\citenamefont {Ponte}\ \emph {et~al.}(2015)\citenamefont {Ponte}, \citenamefont {Papi\ifmmode~\acute{c}\else \'{c}\fi{}}, \citenamefont {Huveneers},\ and\ \citenamefont {Abanin}}]{papic2015MBL}%
  \BibitemOpen
  \bibfield  {author} {\bibinfo {author} {\bibfnamefont {P.}~\bibnamefont {Ponte}}, \bibinfo {author} {\bibfnamefont {Z.}~\bibnamefont {Papi\ifmmode~\acute{c}\else \'{c}\fi{}}},\ }\href {https://doi.org/10.1103/PhysRevLett.114.140401} {\bibfield  {journal} {\bibinfo  {journal} {Phys. Rev. Lett.}\ }\textbf {\bibinfo {volume} {114}},\ \bibinfo {pages} {140401} (\bibinfo {year} {2015})}\BibitemShut {NoStop}%
\bibitem [{SM()}]{SM}%
  \BibitemOpen
  \href@noop {} {}\bibinfo {note} {See Supplemental Material for the full
  derivations, which includes
  Refs.~\cite{papic2015MBL}.}\BibitemShut
  {Stop}%
\end{thebibliography}
\end{onecolumngrid}
\end{document}
`;

// cond-mat.dis-nn 2611.14200 and nlin.CD 2610.35979: `\ifmmode…\else…\fi` in an entry, `onecolumngrid` as an environment, an empty label `SM()`, a `\cite` in a note.
test("2611.14200: REVTeX entries with \\ifmmode…\\else…\\fi, an empty-year label and a cite note are drawn; onecolumngrid is transparent", () => {
  const view = mount(REVTEX_ENTRIES, [latexProjectField.init(() => ({ labels: [], bibEntries: readCompiledBibliography(REVTEX_ENTRIES), files: [] }))]);
  assert.deepEqual(left(view), []);
  const entry = widgetWith(view, "Phys. Rev. Lett.");
  assert.ok(entry, "the first entry is a widget");
  assert.ok(!/[\\]/.test(entry!.textContent!), entry!.textContent!);
  const note = widgetWith(view, "See Supplemental Material");
  assert.ok(note, "the note entry is a widget");
  assert.ok(!/[\\]/.test(note!.textContent!), note!.textContent!);
  click(entry!);
  assert.ok(shows(view, "\\ifmmode"), "a click shows the source");
  view.destroy();
});

const BYSAME = String.raw`\documentclass{amsart}
\begin{document}
\begin{thebibliography}{99}
\bibitem{A} J.~Klein, \emph{First}, Ann. 1 (2000).
\bibitem{B}
\bysame, \emph{Poincar\'{e} duality spaces}, Surveys, pp.~135--165.
\end{thebibliography}
\end{document}
`;

// math.AT 2611.11463: amsart's \bysame prints a three-em rule.
test("2611.11463: \\bysame in a reference is a long dash; a click shows the command", () => {
  const view = mount(BYSAME);
  assert.deepEqual(left(view), []);
  const rule = widgetWith(view, "———");
  assert.ok(rule, "the rule");
  click(rule!);
  assert.ok(shows(view, "\\bysame"), "a click shows the command");
  view.destroy();
});

const TWOCOLUMN = String.raw`\documentclass[twocolumn,10pt]{article}
\begin{document}
\twocolumn[%
  \begin{center}
    {\LARGE\bfseries A learner-free swarm\par}
    \vspace{5pt}
    {\large Galen J. Wilkerson\par}
  \end{center}
  \vspace{8pt}
  \begin{quotation}\noindent
    {\small\textbf{Abstract.} \input{abstract}}
  \end{quotation}
  \vspace{14pt}
]

\section{Intro}
Text.
\end{document}
`;

// nlin.AO 2610.25113: the `\twocolumn[` wrapper stayed source.
test("2610.25113: \\twocolumn[ … ] is transparent; its contents draw as they would outside it", () => {
  const view = mount(TWOCOLUMN, [], [{ path: "nb/abstract.tex", text: "We study swarms.", version: "1" }]);
  assert.deepEqual(left(view), []);
  assert.ok(shows(view, "A learner-free swarm") && shows(view, "Abstract."), "the title and the abstract line are drawn");
  const chip = widgetWith(view, "abstract");
  assert.ok(chip, "the \\input is a chip");
  click(chip!);
  assert.ok(shows(view, "\\input{abstract}"), "a click shows the source");
  view.destroy();
});
