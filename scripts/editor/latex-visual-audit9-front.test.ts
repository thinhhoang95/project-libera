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

/* Front matter, bibliographies and citations, audit round 9 (the arXiv id is at each test). */

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

const NATBIB = String.raw`\documentclass{aastex7}
\usepackage{natbib}
\begin{document}
Particles \citep[GLEs\footnote{\url{https://gle.oulu.fi} \label{url:gle}}; e.g.,][]{poluianov2017gle, crosby2024very} are seen. Then \citep[$R_\mathrm{s}$; see][for details]{billings1966corona, manchester2008three}. See \citep[e.g.,][and Figure~\ref{fig:a}(d) below]{plain}.
\begin{figure}
\caption{A figure.\label{fig:a}}
\end{figure}
\end{document}
`;

// astro-ph.SR 2611.19628: a footnote, a formula with a subscript and a reference inside a natbib note kept the citation (and the commands in it) as source.
test("2611.19628: natbib cite notes with a footnote, a formula and a reference are chips, each opens its source on a click", () => {
  const view = mount(NATBIB);
  const chips = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-cite")];
  assert.equal(chips.length, 3);
  assert.ok(chips[0].textContent!.includes("GLEs (https://gle.oulu.fi); e.g."), "the footnote's text follows the word it marks");
  assert.ok(!/[\\]/.test(chips[0].textContent!));
  assert.ok(chips[1].textContent!.includes("Rₛ; see"), "the subscript is drawn");
  assert.match(chips[2].textContent!, /and Figure 1\(d\) below/, "the reference is its number");
  assert.deepEqual(left(view).filter((name) => name !== "begin{figure}" && name !== "caption" && name !== "label"), []);
  click(chips[0]);
  assert.ok(shows(view, "\\footnote{\\url{https://gle.oulu.fi}"), "a click on the chip shows the source with the footnote");
  view.destroy();
});

const HE_BBL = String.raw`\documentclass[aps,prd]{revtex4-2}
\usepackage{natbib}
\begin{document}
Price \citep{Price:1971fb} and \citep{Price:1972}.

\begin{thebibliography}{2}%
\providecommand \natexlab [1]{#1}%
\providecommand \bibnamefont  [1]{#1}%
\providecommand \bibinfo  [0]{\@secondoftwo}%
\providecommand \BibitemShut  [1]{\csname bibitem#1\endcsname}%
\let\auto@bib@innerbib\@empty
%</preamble>
\bibitem [{\citenamefont {Price}(1972{\natexlab{a}})}]{Price:1971fb}%
  \BibitemOpen
  \bibfield  {author} {\bibinfo {author} {\bibfnamefont {R.~H.}\ \bibnamefont {Price}},\ }\bibfield  {title} {\bibinfo {title} {{Nonspherical perturbations of relativistic gravitational collapse: Korteweg\textendash{}de Vries}},\ }\href {https://doi.org/10.1103/PhysRevD.5.2419} {\bibfield  {journal} {\bibinfo  {journal} {Phys. Rev. D}\ }\textbf {\bibinfo {volume} {5}},\ \bibinfo {pages} {2419} (\bibinfo {year} {1972}{\natexlab{a}})}\BibitemShut {NoStop}%
\bibitem [{\citenamefont {Price}(1972{\natexlab{b}})}]{Price:1972}%
  \BibitemOpen
  \bibfield  {author} {\bibinfo {author} {\bibfnamefont {R.~H.}\ \bibnamefont {Price}},\ }\href@noop {} {\bibfield  {journal} {\bibinfo  {journal} {Phys. Rev. D}\ }\textbf {\bibinfo {volume} {5}},\ \bibinfo {pages} {2439} (\bibinfo {year} {1972}{\natexlab{b}})}\BibitemShut {NoStop}%
\end{thebibliography}
\end{document}
`;

// astro-ph.HE 2611.21043: the label `(1972{\natexlab{a}})` was not read as author-year, so the entry stayed source.
test("2611.21043: REVTeX entries with \\natexlab years are drawn, cite chips show 1972a, a click shows the entry's source", () => {
  const view = mount(HE_BBL, [latexProjectField.init(() => ({ labels: [], bibEntries: readCompiledBibliography(HE_BBL), files: [] }))]);
  assert.deepEqual(left(view), []);
  const entry = widgetWith(view, "Nonspherical perturbations");
  assert.ok(entry, "the entry is a widget");
  assert.match(plain(entry!), /R\. H\. Price, .*Korteweg–de Vries, Phys\. Rev\. D 5, 2419 \(1972a\)/);
  assert.ok(!/[\\]/.test(entry!.textContent!));
  const chips = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-cite")].map((chip) => chip.textContent);
  assert.ok(chips.some((chip) => chip?.includes("1972a")), `the chip shows 1972a: ${chips.join(" | ")}`);
  assert.ok(chips.some((chip) => chip?.includes("1972b")), "and 1972b");
  click(entry!);
  assert.ok(shows(view, "\\natexlab{a}"), "a click shows the source");
  view.destroy();
});

const ELSARTICLE = String.raw`\documentclass[review]{elsarticle}
\begin{document}
\begin{frontmatter}
\title{Rigidity of carpets}
\author[1]{Wen Fan}
\ead{wenfan@jnu.edu.cn}
\affiliation[1]{organization={Jinan University},city={Guangzhou},country={China}}
\nonumnote{Supported by the National Natural Science Foundation of China}
\begin{abstract}
We prove a theorem.
\end{abstract}
\begin{keyword}
Carpet \sep quasisymmetric
\MSC[2020] 30C65 \sep 28A80
\end{keyword}
\end{frontmatter}
\section{Introduction}
Text.
\begin{thebibliography}{1}
\bibitem{A} Author, Title.
\newline\urlprefix\url{https://arxiv.org/abs/2512.24649}
\end{thebibliography}
\end{document}
`;

// math.CV 2611.13725: three elsarticle commands stayed source.
test("2611.13725: elsarticle's \\nonumnote, \\MSC[2020] and \\urlprefix are drawn; clicks show their source", () => {
  const view = mount(ELSARTICLE);
  assert.deepEqual(left(view), []);
  assert.ok(shows(view, "Supported by the National Natural Science Foundation of China"));
  const msc = widgetWith(view, "MSC 2020:");
  assert.ok(msc, "the MSC label");
  click(msc!);
  assert.ok(shows(view, "\\MSC[2020]"), "a click on the label shows the command");
  const url = widgetWith(view, "URL");
  assert.ok(url, "the urlprefix widget");
  click(url!);
  assert.ok(shows(view, "\\urlprefix"));
  view.destroy();
});

test("2611.13725: the nonumnote is in the title block and the block still shows its source on Alt-click", () => {
  const view = mount(ELSARTICLE);
  const block = view.contentDOM.querySelector(".cm-vis-title-block");
  assert.ok(block, "a title block");
  assert.match(block!.textContent ?? "", /Supported by the National Natural Science Foundation of China/);
  block!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }));
  assert.ok(shows(view, "\\nonumnote{Supported by"), "Alt-click shows the source");
  view.destroy();
});

const AASTEX_MAIN = String.raw`\documentclass[twocolumn]{aastex702}
\begin{document}

\title{Comparative Analysis of Influences\\ the 2017 September 10 Event}

\input{authorlist}

\begin{abstract}
Models.
\end{abstract}
\section{Introduction}
Text.
\end{document}
`;
const AUTHOR_LIST = String.raw`
\correspondingauthor{Weihao Liu}
\email[show]{whliu@umich.edu}

\author[orcid=0000-0002-2873-5688]{Weihao Liu}
\affiliation{Department of Climate and Space Sciences, University of Michigan, Ann Arbor, MI 48109, USA}
\email{whliu@umich.edu}
\author[orcid=0000-0001-9114-6133]{Nishtha Sachdeva}
\affiliation{Department of Climate and Space Sciences, University of Michigan, Ann Arbor, MI 48109, USA}
\email{nishthas@umich.edu}
`;
const AASTEX_ROOT: MacroSource[] = [{ path: "nb/main.tex", text: "\\documentclass[twocolumn]{aastex702}\n", version: "1" }];

// astro-ph.SR 2611.19628: the `\input` after `\title` ended the run, so a title with its authors in another file stayed source.
test("2611.19628: an AASTeX \\title followed by \\input{authorlist} is a title block; the input line stays as it is", () => {
  const view = mount(AASTEX_MAIN);
  const block = view.contentDOM.querySelector(".cm-vis-title-block");
  assert.ok(block, "a title block");
  assert.match(block!.textContent ?? "", /Comparative Analysis of Influences/);
  assert.ok(!left(view).includes("title"), "the title is not source");
  assert.ok(block!.querySelector('[data-title-part="title"]'), "the title is editable in place");
  block!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }));
  assert.ok(shows(view, "\\title{Comparative Analysis"), "Alt-click shows the source");
  view.destroy();
});

test("2611.19628: authorlist.tex, a file of only the AASTeX author block, draws its authors and affiliations like the inline block", () => {
  const view = mount(AUTHOR_LIST, [], AASTEX_ROOT);
  const block = view.contentDOM.querySelector(".cm-vis-title-block");
  assert.ok(block, "a title block");
  const shown = block!.textContent ?? "";
  assert.match(shown, /Weihao Liu/);
  assert.match(shown, /Nishtha Sachdeva/);
  assert.match(shown, /University of Michigan/);
  assert.match(shown, /Corresponding author/);
  assert.deepEqual(left(view), []);
  block!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }));
  assert.ok(shows(view, "\\author[orcid=0000-0002-2873-5688]{Weihao Liu}"), "Alt-click shows the source");
  view.destroy();
});

test("2611.19628: a file with other text besides the declarations is not read as an author block", () => {
  const view = mount(`${AUTHOR_LIST}\nSome text of the paper.\n`, [], AASTEX_ROOT);
  assert.ok(!view.contentDOM.querySelector(".cm-vis-title-block"));
  view.destroy();
});

const CONTRIBUTION = String.raw`\documentclass{aastex7}
\begin{document}
\section{Intro}
Text.
\begin{acknowledgments}
We thank everyone.
\end{acknowledgments}
\begin{contribution}
A did the work.
\end{contribution}
\facilities{HST}
\software{numpy}
\end{document}
`;

// astro-ph.EP 2611.16040: AASTeX 7's `contribution` prints an "Author Contributions" section.
test("2611.16040: AASTeX 7's contribution environment has its own heading; a click on it shows the source", () => {
  const view = mount(CONTRIBUTION);
  assert.deepEqual(left(view), []);
  const heading = widgetWith(view, "Author Contributions");
  assert.ok(heading, "the heading");
  assert.ok(widgetWith(view, "Acknowledgments"), "and the acknowledgments' own");
  assert.ok(shows(view, "A did the work."));
  assert.ok(shows(view, "Facilities:") && shows(view, "Software:"), "its siblings are drawn");
  click(heading!);
  assert.ok(shows(view, "\\begin{contribution}"), "a click shows the source");
  view.destroy();
});

test("2611.16040: `contribution` in another class is not an Author Contributions heading", () => {
  const view = mount(String.raw`\documentclass{article}
\begin{document}
\begin{contribution}
Text.
\end{contribution}
\end{document}
`);
  assert.ok(!widgetWith(view, "Author Contributions"));
  view.destroy();
});
