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
import { isInLatexComment, loadKey } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Front matter, document classes and bibliography, audit round 8 (the arXiv id is at each test). */

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
/** Whether the source at `needle` shows once the caret is put just inside it (what the caret entering a hidden command does). */
const caretShows = (view: EditorView, needle: string, marker: string) => {
  const at = view.state.doc.toString().indexOf(needle);
  view.dispatch({ selection: { anchor: at + 1 } });
  return shows(view, marker);
};

const REVTEX = String.raw`\documentclass{article}
\begin{document}
Text.

\begin{thebibliography}{2}%
\providecommand \natexlab [1]{#1}%
\providecommand \bibnamefont  [1]{#1}%
\providecommand \bibinfo  [0]{\@secondoftwo}%
\providecommand \BibitemShut  [1]{\csname bibitem#1\endcsname}%
\let\auto@bib@innerbib\@empty
%</preamble>
\bibitem [{\citenamefont {Gor'kov}\ \emph {et~al.}(1979)\citenamefont
  {Gor'kov}, \citenamefont {Larkin},\ and\ \citenamefont
  {Khmel'nitskii}}]{GLK1979}%
  \BibitemOpen
  \bibfield  {author} {\bibinfo {author} {\bibfnamefont {L.~P.}\ \bibnamefont
  {Gor'kov}}, \bibinfo {author} {\bibfnamefont {A.~I.}\ \bibnamefont
  {Larkin}},\ and\ \bibinfo {author} {\bibfnamefont {D.~E.}\ \bibnamefont
  {Khmel'nitskii}},\ }\bibfield  {title} {\bibinfo {title} {Particle
  conductivity in a two-dimensional random potential},\ }\href@noop {}
  {\bibfield  {journal} {\bibinfo  {journal} {JETP Lett.}\ }\textbf {\bibinfo
  {volume} {30}},\ \bibinfo {pages} {228} (\bibinfo {year} {1979})}\BibitemShut
  {NoStop}%
\bibitem [{\citenamefont {Lee}(1985)}]{Lee1985}%
  \BibitemOpen
  \bibfield  {author} {\bibinfo {author} {\bibfnamefont {P.~A.}\ \bibnamefont
  {Lee}},\ }\href {https://doi.org/10.1103/RevModPhys.57.287} {\bibfield  {journal} {\bibinfo  {journal} {Rev. Mod. Phys.}\ }\textbf {\bibinfo {volume} {57}},\ \bibinfo {pages} {287} (\bibinfo {year} {1985})}\BibitemShut {NoStop}%
\end{thebibliography}
\end{document}
`;

// cond-mat.str-el 2611.17927: REVTeX 4.2's apsrev4-2.bst entries (`\bibfield`, `\bibinfo`, `\href@noop`) are read as the text they print.
test("2611.17927: a REVTeX bibliography entry is drawn as its text, a click turns it back into the source", () => {
  const view = mount(REVTEX);
  assert.deepEqual(left(view), []);
  const entry = widgetWith(view, "Particle conductivity");
  assert.ok(entry, "the entry is one widget");
  assert.match(plain(entry!), /L\. P\. Gor'kov, A\. I\. Larkin, and D\. E\. Khmel'nitskii, Particle conductivity in a two-dimensional random potential, JETP Lett\. 30, 228 \(1979\)/);
  assert.ok(!/[\\]/.test(entry!.textContent!), "no raw LaTeX in the widget");
  assert.ok(widgetWith(view, "Rev. Mod. Phys.")!.querySelector(".cm-vis-link"), "\\href{u}{y} is a link on y");
  assert.ok(!shows(view, "\\BibitemOpen"));
  click(entry!);
  assert.ok(shows(view, "\\bibfield  {author}"), "a click shows the entry's source");
  assert.ok(shows(view, "\\BibitemOpen"));
  view.destroy();
});

test("2611.17927: the REVTeX marker is a widget too: a click shows `\\bibitem[…]{key}`", () => {
  const view = mount(REVTEX);
  const marker = view.contentDOM.querySelector<HTMLElement>(".cm-vis-item")!;
  assert.ok(marker);
  click(marker);
  assert.ok(shows(view, "\\bibitem [{\\citenamefont {Gor'kov}"));
  view.destroy();
});

test("2611.17927: an entry with a command that is not understood stays source", () => {
  const view = mount(REVTEX.replace("\\BibitemOpen\n  \\bibfield  {author} {\\bibinfo {author} {\\bibfnamefont {P.~A.}", "\\BibitemOpen\\mysterious{x}\n  \\bibfield  {author} {\\bibinfo {author} {\\bibfnamefont {P.~A.}"));
  assert.ok(!widgetWith(view, "Rev. Mod. Phys."), "the second entry is not drawn");
  assert.ok(widgetWith(view, "Particle conductivity"), "the first still is");
  view.destroy();
});

const SNJNL = String.raw`\documentclass{article}
\begin{document}
Text.

\begin{thebibliography}{37}
	\ifx \bisbn   \undefined \def \bisbn  #1{ISBN #1}\fi
	\ifx \bauthor  \undefined \def \bauthor#1{#1}\fi
	\ifx \bsnm \undefined \def \bsnm#1{#1}\fi
	\ifx \binits  \undefined \def \binits#1{#1}\fi
	\ifx \batitle  \undefined \def \batitle#1{#1}\fi
	\ifx \bjtitle  \undefined \def \bjtitle#1{#1}\fi
	\ifx \bvolume  \undefined \def \bvolume#1{\textbf{#1}}\fi
	\ifx \byear  \undefined \def \byear#1{#1}\fi
	\ifx \bfpage  \undefined \def \bfpage#1{#1}\fi
	\ifx \barticle \undefined \def \barticle#1{#1}\fi
	\bibcommenthead
	\ifx \endbibitem  \undefined \def \endbibitem {}\fi
	\csname PreBibitemsHook\endcsname

	%%% 2
	\bibitem[\protect\citeauthoryear{Heinzelman
		et~al.}{2002}]{heinzelman2002application}
	\begin{barticle}
		\bauthor{\bsnm{Heinzelman}, \binits{W.B.}},
		\batitle{An application-specific protocol}.
		\bjtitle{IEEE Transactions on Wireless Communications}
		\bvolume{1},
		\bfpage{660}
		(\byear{2002})
	\end{barticle}
	\endbibitem

\end{thebibliography}
\end{document}
`;

// cs.NI 2611.13943: Springer Nature's sn-jnl .bbl: `\ifx \bauthor \undefined \def \bauthor#1{#1}\fi` is a definition, the b-commands expand.
test("2611.13943: the sn-jnl fallback definitions fold away and the entry's b-commands are drawn", () => {
  const view = mount(SNJNL);
  assert.deepEqual(left(view), []);
  assert.ok(!shows(view, "\\undefined"), "the \\ifx … \\fi definition lines are hidden");
  assert.ok(shows(view, "Heinzelman"));
  assert.ok(shows(view, "IEEE Transactions on Wireless Communications"));
  assert.ok(!shows(view, "\\bauthor") && !shows(view, "\\begin{barticle}"));
  view.destroy();
});

test("2611.13943: the sn-jnl definitions and the entry's environment lines stay reachable", () => {
  const view = mount(SNJNL);
  assert.ok(caretShows(view, "\\ifx \\bauthor", "\\ifx \\bauthor"), "the caret in a fallback definition shows it");
  assert.ok(caretShows(view, "\\begin{barticle}", "\\begin{barticle}"), "the caret in the entry's \\begin line shows it");
  const marker = view.contentDOM.querySelector<HTMLElement>(".cm-vis-item")!;
  click(marker);
  assert.ok(shows(view, "\\citeauthoryear{Heinzelman"), "a click on the marker shows \\bibitem[…]{key}");
  view.destroy();
});

const EPL = String.raw`\documentclass[doublecol]{epl2}
\begin{document}
Text.

\begin{thebibliography}{100}
\expandafter\ifx\csname url\endcsname\relax\def\url#1{\texttt{#1}}\fi

\bibitem{nowak1992evolutionary}
\Name{Nowak M.~A. \and May R.~M.} \REVIEW{Nature}{359}{1992}{826}.

\bibitem{szabo1998evolutionary}
\Name{Szab{\'o} G. \and T{\H{o}}ke C.} \REVIEW{Phys. Rev. E}{58}{1998}{69}.
\end{thebibliography}
\end{document}
`;

// q-bio.PE 2610.35161: epl2.cls's `\Name` (small capitals, "and" for `\and`) and `\REVIEW{journal}{volume}{year}{page}`.
test("2610.35161: EPL's \\Name and \\REVIEW are drawn as the reference they print", () => {
  const view = mount(EPL);
  assert.deepEqual(left(view), []);
  const name = widgetWith(view, "Nowak M. A. and May R. M.")!;
  assert.ok(name, "the authors");
  assert.ok(name.querySelector(".cm-vis-sc"), "in small capitals");
  const review = widgetWith(view, "Nature")!;
  assert.equal(plain(review), "Nature, 359 (1992) 826");
  assert.equal(review.querySelector("strong, .cm-vis-b")?.textContent, "359");
  view.destroy();
});

test("2610.35161: a click on EPL's \\Name or \\REVIEW widget shows its source", () => {
  for (const [needle, source] of [["Nowak M. A.", "\\Name{Nowak M.~A. \\and"], ["Nature", "\\REVIEW{Nature}"]] as const) {
    const view = mount(EPL);
    click(widgetWith(view, needle)!);
    assert.ok(shows(view, source), source);
    view.destroy();
  }
});

test("2610.35161: \\Name and \\REVIEW the document defines itself are left to it, other classes' are not read", () => {
  const view = mount(EPL.replace("{epl2}", "{article}"));
  assert.ok(!widgetWith(view, "Nature"), "only the EPL class's");
  view.destroy();
});

const INDEX = String.raw`\documentclass{article}
\begin{document}
Text.

\begin{theindex}
{\textbf{A}}\nopagebreak

  \item anti-locality, \hyperpage{100}
  \item antiunitary (Def.~\ref{def:A}),
		\hyperpage{12}
  \item classification
    \subitem by dual pairs, \hyperpage{80}
    \subitem x (\ref *{theorem:H}),
		\hyperpage{62}
  \item Hadamard product, \see{Schur product theorem}{105}

  \indexspace
\end{theindex}
\end{document}
`;

// math.OA 2611.08668: an inline `.ind` index.
test("2611.08668: theindex is drawn as an Index list: items, subitems, page numbers, see", () => {
  const view = mount(INDEX);
  assert.deepEqual(left(view), []);
  const lines = [...view.contentDOM.querySelectorAll(".cm-line")];
  assert.ok(lines.some((line) => line.classList.contains("cm-vis-index-item") && /anti-locality, 100/.test(line.textContent ?? "")), "an item line");
  assert.ok(lines.some((line) => line.classList.contains("cm-vis-index-subitem") && /by dual pairs, 80/.test(line.textContent ?? "")), "a subitem line, indented");
  assert.ok(lines.some((line) => line.classList.contains("cm-vis-index-space")), "\\indexspace is a gap");
  assert.ok(shows(view, "Index"));
  assert.ok(!shows(view, "\\hyperpage") && !shows(view, "\\item") && !shows(view, "\\subitem"));
  assert.ok(shows(view, "see Schur product theorem"));
  view.destroy();
});

test("2611.08668: an index item's source stays reachable (caret) and its widgets open it on a click", () => {
  const view = mount(INDEX);
  assert.ok(caretShows(view, "\\subitem by dual", "\\subitem by dual"), "the caret on a subitem line shows its commands");
  view.destroy();
  const second = mount(INDEX);
  click(widgetWith(second, "see Schur product theorem")!);
  assert.ok(shows(second, "\\see{Schur product theorem}{105}"), "a click on `see` shows its source");
  second.destroy();
  const third = mount(INDEX);
  click(widgetWith(third, "Index")!);
  assert.ok(shows(third, "\\begin{theindex}"), "a click on the heading shows \\begin{theindex}");
  third.destroy();
});

test("2611.08668: `\\ref *{key}` (a space before the star) is a reference, and a click (Alt) shows its source", () => {
  const view = mount(INDEX);
  const chip = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-ref")].find((node) => node.title.startsWith("\\ref*"))!;
  assert.ok(chip, "a reference chip");
  click(chip, { altKey: true });
  assert.ok(shows(view, "\\ref *{theorem:H}"));
  view.destroy();
});

const INDEXED = String.raw`\documentclass{article}
\newtheorem{definition}{Definition}
\begin{document}
\section{One}\label{sec:one}
\begin{definition}\label{def:Inv}A thing.\end{definition}
Text here.\index{involution (Def.~\ref{def:Inv})}\index{projection!real orthogonal (Def.~\ref{def:Inv})} More\glsadd{SHK} text.
\end{document}
`;

// math.OA 2611.08668: `\index{involution (Def.~\ref{…})}` drew its raw text in a tag; `\glsadd{key}` was left as source.
test("2611.08668: an \\index tag never shows raw LaTeX; a click on it shows the source", () => {
  const view = mount(INDEXED);
  const tags = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-index")];
  assert.equal(tags.length, 3, "two \\index and one \\glsadd");
  for (const tag of tags) assert.ok(!/\\/.test(tag.textContent ?? ""), `no raw command in "${tag.textContent}"`);
  assert.match(tags[0].textContent!, /^involution \(Def\.\s?\S+\)$/);
  assert.match(tags[1].textContent!, /^projection › real orthogonal/);
  assert.equal(tags[2].textContent, "SHK");
  assert.deepEqual(left(view), []);
  click(tags[0]);
  assert.ok(shows(view, "\\index{involution (Def.~\\ref{def:Inv})}"), "the \\index source shows");
  view.destroy();
  const glossary = mount(INDEXED);
  click([...glossary.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-index")][2]);
  assert.ok(shows(glossary, "\\glsadd{SHK}"), "a click on the \\glsadd tag shows its source");
  glossary.destroy();
});

const CITED = String.raw`\documentclass{article}
\input{released_cites}
\begin{document}
All data are open~\citep{\releasedCites} and also \citep{\unknownList}.
\bibliographystyle{plain}
\end{document}
`;
const RELEASED: MacroSource[] = [{ path: "nb/released_cites.tex", text: "\\newcommand{\\releasedCites}{%\nds000001,%\nds000002,%\nds000003%\n}\n", loadedBy: "", key: loadKey("input", "released_cites"), version: "1" }];

// cs.LG 2611.21215: `\citep{\releasedCites}` drew a chip named after the macro.
test("2611.21215: a macro that is the whole key list is expanded; an unknown one stays source", () => {
  const view = mount(CITED, [], RELEASED);
  const chips = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-cite")];
  assert.equal(chips.length, 1, "only the known list is a chip");
  assert.ok(!/\\/.test(chips[0].textContent ?? ""), "the chip does not show the macro's name");
  assert.ok(chips[0].title.includes("ds000002") && chips[0].title.includes("ds000003"), "the keys are the macro's");
  assert.ok(shows(view, "\\citep{\\unknownList}"), "the unknown macro's citation is left as source");
  click(chips[0]);
  assert.ok(shows(view, "\\citep{\\releasedCites}"), "a click on the chip shows the source");
  view.destroy();
});

// Checked in the app: REVTeX's entries hung from an empty marker, their first letters under the gutter (cond-mat.str-el 2611.17927).
// apsrev gives author–year labels, but an APS journal prints [n]; and a bibliography longer than the screen keeps its indent
// below its first screen (the style layer starts at its `\begin`, as for a theorem).
test("2611.17927: REVTeX entries of an APS paper hang from [n] markers, all down a long bibliography", async () => {
  const entry = (n: number) => String.raw`\bibitem [{\citenamefont {Lee}(19${n})}]{Lee${n}}%
  \BibitemOpen
  \bibfield  {author} {\bibinfo {author} {\bibfnamefont {P.~A.}\ \bibnamefont
  {Lee${n}}},\ }\href@noop {} {\bibfield  {journal} {\bibinfo  {journal} {Rev. Mod. Phys.}\ }\textbf {\bibinfo {volume} {${n}}},\ \bibinfo {pages} {287} (\bibinfo {year} {1985})}\BibitemShut {NoStop}%
`;
  const entries = Array.from({ length: 80 }, (_, i) => entry(i + 10)).join("");
  const doc = REVTEX.replace(String.raw`\documentclass{article}`, String.raw`\documentclass[aps,prb,reprint]{revtex4-2}`).replace(String.raw`\end{thebibliography}`, `${entries}\\end{thebibliography}`);
  const view = mount(doc);
  const markers = () => [...view.contentDOM.querySelectorAll(".cm-vis-bibliography .cm-vis-item")].map((marker) => marker.textContent);
  assert.equal(doc.split(String.raw`\bibitem`).length, 83);
  assert.deepEqual(markers().slice(0, 2), ["[1]", "[2]"]);
  view.dispatch({ effects: EditorView.scrollIntoView(doc.indexOf("{Lee89}}"), { y: "start" }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const last = [...view.contentDOM.querySelectorAll(".cm-line")].find((line) => line.textContent?.includes("Lee89"));
  assert.ok(last, "the last entry is on screen");
  assert.ok(last!.classList.contains("cm-vis-bibliography"), `line classes: ${last!.className}`);
  assert.equal(last!.querySelector(".cm-vis-item")?.textContent, "[82]");
  view.destroy();
});

test("2611.17927: in an author–year document (article with natbib's labels) a REVTeX entry still prints no marker", () => {
  const view = mount(REVTEX);
  assert.deepEqual([...view.contentDOM.querySelectorAll(".cm-vis-bibliography .cm-vis-item")].map((marker) => marker.textContent), ["", ""]);
  view.destroy();
});
