import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { setMacroSources, setNumbering, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { isInLatexComment } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 8, front matter, document classes, text commands and environments (arXiv 2611.*). Every widget these draw shows its source when clicked. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function visualState(doc: string, anchor: number, sources: MacroSource[]) {
  let state = EditorState.create({ doc, selection: { anchor }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" })] });
  ensureSyntaxTree(state, doc.length, 5000);
  if (sources.length) state = state.update({ effects: setMacroSources.of(sources) }).state;
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

/** A mounted Visual mode for `doc`, numbered as the app numbers it, the caret at `anchor` (the start by default). */
function mount(doc: string, anchor = 0, sources: MacroSource[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, anchor, sources), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, numbering, done: () => { view.destroy(); parent.remove(); } };
}

const text = (view: EditorView) => view.contentDOM.textContent ?? "";
const click = (node: Element) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

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

const inDoc = (source: string, preamble = "") => `\\documentclass{article}\n${preamble}\\begin{document}\n${source}\n\\end{document}\n`;
const lines = (view: EditorView) => [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => (line.textContent ?? "").replace(/[​⁣]/g, "").replace(/\s+/g, " ").trim()).filter((line) => line && !/^(?:\\?documentclass|\\?begin\s*document|\\?end\s*document|\\end\{document\})/.test(line));
/** A mounted document body: its drawn lines and the commands still shown as source (the caret is at the start). */
function body(source: string, preamble = "") {
  const { view, done } = mount(inDoc(source, preamble));
  return { view, lines: lines(view), left: left(view).filter((name) => name !== "end"), done };
}

/** The source the view shows for the caret placed in the `needle` of `source` (the widget there gives way to it). */
function withCaretIn(source: string, needle: string, preamble = "") {
  const doc = inDoc(source, preamble);
  const at = doc.indexOf(needle) + 1;
  const { view, done } = mount(doc, at);
  return { view, done, text: text(view) };
}

/** A click (mousedown) on the drawn element `selector` number `index`, and the source the view shows afterwards. */
function clickedSource(view: EditorView, selector: string, index = 0) {
  const nodes = [...view.contentDOM.querySelectorAll(selector)];
  assert.ok(nodes.length > index, `a drawn ${selector} number ${index} (found ${nodes.length})`);
  click(nodes[index]);
  return text(view);
}

test("enumitem `label=\\normalfont(\\roman*)` drops the font switch from item markers and `\\ref` chips (math.GR 2611.14085)", () => {
  const source = String.raw`Conditions:
\begin{enumerate}[label=\normalfont(\roman*)]
\item\label{c:a} First.
\item\label{c:b} Second.
\end{enumerate}
See \ref{c:a} and \ref{c:b}, also \textup{x}.`;
  const doc = body(source);
  assert.deepEqual(doc.left, []);
  const all = doc.lines.join(" ");
  assert.doesNotMatch(all, /normalfont/);
  assert.match(all, /\(i\)/);
  assert.match(all, /\(ii\)/);
  const refs = [...doc.view.contentDOM.querySelectorAll(".cm-vis-ref")].map((node) => node.textContent);
  assert.deepEqual(refs.slice(0, 2), ["(i)", "(ii)"]);
  // A click on the marker and on the chip shows the source.
  assert.match(clickedSource(doc.view, ".cm-vis-item-marker, .cm-vis-item", 1), /\\item/);
  doc.view.dispatch({ selection: { anchor: 0 } });
  // (a plain click on a reference chip goes to its label; Alt-click shows the source)
  doc.view.contentDOM.querySelector(".cm-vis-ref")!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }));
  assert.match(text(doc.view), /\\ref\{c:a\}/);
  doc.done();
});

test("top-level `\\itshape … \\upshape` styles the text between and hides both switches (math.GR 2611.14085)", () => {
  const source = String.raw`Godement writes:

\itshape
From the point of view of practical applications it is important\upshape.

Next paragraph.`;
  const doc = body(source);
  assert.deepEqual(doc.left, []);
  assert.doesNotMatch(doc.lines.join(" "), /itshape|upshape/);
  assert.ok(doc.view.contentDOM.querySelector(".cm-vis-i"), "the text between is italic");
  doc.done();
  // The caret on the switch shows its source.
  const caret = withCaretIn(source, "\\itshape");
  assert.match(caret.text, /\\itshape/);
  caret.done();
});

const INFORMS_DOC = String.raw`\documentclass[mnsc,nonblindrev]{informs3}
\begin{document}
\RUNAUTHOR{Feldman,Huang}
\RUNTITLE{Inventory and Assortment}
\TITLE{\large Inventory and Assortment Optimization: A Unified Framework}
\ARTICLEAUTHORS{%
\AUTHOR{Jacob Feldman}
\AFF{Washington University in St. Louis}
\AUTHOR{Yukai Huang}
\AFF{Suffolk University}
}
\ABSTRACT{We study joint inventory and assortment optimization.}
\KEYWORDS{assortment; inventory}
\maketitle
\section{Introduction}
Text.
\end{document}
`;

test("INFORMS' `\\TITLE`, `\\ARTICLEAUTHORS{\\AUTHOR \\AFF}`, `\\ABSTRACT` are drawn as the title block, and each part is edited in place (econ.TH 2611.05708)", () => {
  const { view, done } = mount(INFORMS_DOC);
  const block = view.contentDOM.querySelector(".cm-vis-title-block")!;
  assert.ok(block, "a title block");
  const shown = block.textContent ?? "";
  assert.match(shown, /Unified Framework/);
  assert.match(shown, /Jacob Feldman/);
  assert.match(shown, /Yukai Huang/);
  assert.match(shown, /Suffolk University/);
  assert.match(shown, /joint inventory and assortment/);
  assert.match(shown, /assortment; inventory/);
  assert.doesNotMatch(shown, /\\|RUNTITLE|ARTICLEAUTHORS/);
  assert.doesNotMatch(text(view).replace(shown, ""), /\\(?:AUTHOR|AFF|TITLE|ABSTRACT|RUNTITLE)/, "no INFORMS command is left as source");
  // A click on the title opens its editor over the argument of `\TITLE`, and the author part too.
  const titlePart = block.querySelector<HTMLElement>('[data-title-part="title"]')!;
  assert.ok(titlePart, "an editable title part");
  click(titlePart);
  const editor = block.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor");
  assert.ok(editor, "the title editor opens");
  assert.match(editor!.value, /Unified Framework/);
  done();
});

test("a click on the INFORMS title block with Alt shows its source (econ.TH 2611.05708)", () => {
  const { view, done } = mount(INFORMS_DOC);
  const block = view.contentDOM.querySelector(".cm-vis-title-block")!;
  block.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }));
  assert.match(text(view), /\\ARTICLEAUTHORS/);
  assert.match(text(view), /\\TITLE/);
  done();
});

test("jmlr's `algorithm2e` environment draws `\\Repeat{cond}{body}` as repeat … until; a click edits the line, Alt-click shows its source (q-bio.NC 2611.07809)", () => {
  const source = String.raw`\documentclass[mlmain]{jmlr}
\begin{document}
\begin{algorithm2e}[h]
\caption{Learning Online}
\For{$t\leftarrow 1$ \KwTo $T$}{
  Update $C$\;
  \Repeat{inference convergence}{
    $z \leftarrow z + 1$\;
  }
}
\end{algorithm2e}
\end{document}
`;
  const { view, done } = mount(source);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  const algorithm = view.contentDOM.querySelector(".cm-vis-algorithm");
  assert.ok(algorithm, "the algorithm is drawn");
  const shown = (algorithm!.textContent ?? "").replace(/\s+/g, " ");
  assert.match(shown, /repeat/i);
  assert.match(shown, /until.*inference convergence/i);
  assert.doesNotMatch(shown, /\\Repeat/);
  const rows = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-algorithm [data-algorithm-line]")];
  const until = rows.find((row) => /repeat/i.test(row.textContent ?? "") && !/until/i.test(row.textContent ?? ""))!;
  assert.ok(until, "a repeat line");
  // A click opens an editor over the statement (its LaTeX), and Alt-click puts the caret in its source.
  until.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }));
  const at = source.indexOf("\\Repeat");
  assert.ok(view.state.selection.main.head >= at && view.state.selection.main.head <= source.indexOf("\\end{algorithm2e}"), "the caret is in the algorithm's source");
  done();
});

test("`{\\centering\\Large\\bfseries\\thetitle\\par}` draws the document's `\\title` (titling); a click shows the command (econ.EM 2611.06067)", () => {
  const source = String.raw`\documentclass{article}
\usepackage{titling}
\title{Offline Learning of Reserve Prices}
\begin{document}
{\centering\Large\bfseries\thetitle\par}
Body text.
\end{document}
`;
  const { view, done } = mount(source);
  assert.deepEqual(left(view).filter((name) => name !== "end"), []);
  const chip = view.contentDOM.querySelector(".cm-vis-macro");
  assert.ok(chip, "a drawn title");
  assert.match(chip!.textContent ?? "", /Offline Learning of Reserve Prices/);
  click(chip!);
  assert.match(text(view), /\\thetitle/);
  done();
});

test("`\\begingroup … \\endgroup` around a paragraph is transparent: hidden markers, the text drawn; the caret shows them (econ.EM 2611.06067)", () => {
  const source = String.raw`Before.

\begingroup The sample produces a reserve, which is then
evaluated against every compatible distribution. \endgroup

After.`;
  const doc = body(source);
  assert.deepEqual(doc.left, []);
  assert.doesNotMatch(doc.lines.join(" "), /begingroup|endgroup/);
  assert.match(doc.lines.join(" "), /The sample produces a reserve/);
  doc.done();
  const caret = withCaretIn(source, "\\begingroup");
  assert.match(caret.text, /\\begingroup/);
  caret.done();
  const end = withCaretIn(source, "\\endgroup");
  assert.match(end.text, /\\endgroup/);
  end.done();
});

test("a chapter file's title block takes its class from the main file: every author and affiliation is drawn (cond-mat.str-el 2611.17871's supplement)", () => {
  const source = String.raw`\title{Supplemental Material}
\author{Yuchen Liu}
\affiliation{Kavli Institute, Beijing}
\author{Zheng Zhu}
\affiliation{Kavli Institute, Beijing}
\date{\today}
\maketitle
Text.
`;
  // The class arrives after the first draw, as the project's macro files are read.
  const { view, done } = mount(source, 0, [{ path: "nb/main.tex", text: "\\documentclass{revtex4-2}\n", version: "1" }]);
  const block = view.contentDOM.querySelector(".cm-vis-title-block");
  assert.ok(block, "a title block");
  const shown = block!.textContent ?? "";
  assert.match(shown, /Yuchen Liu/);
  assert.match(shown, /Zheng Zhu/);
  assert.match(shown, /Kavli Institute/);
  assert.ok(block!.querySelector('[data-title-part="title"]'), "the title is editable in place");
  block!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true }));
  assert.match(text(view), /\\affiliation/);
  done();
});

const LEAN_PREAMBLE = String.raw`\usepackage{xcolor}
\definecolor{lean@equivalent}{HTML}{009E73}
\makeatletter
\newcommand*{\CA@leanpending}{}
\newcommand*{\lean}[2]{%
  \ifcsname\string\color@lean@#1\endcsname\else
    \PackageError{main}{Unknown relation #1 in \string\lean}{Use equivalent, weaker or stronger.}%
  \fi
  \gdef\CA@leanrelation{#1}%
  \gdef\CA@leanpending{#2}}
\makeatother
`;

test("a document's `\\lean{equivalent}{A,B}` is a small coloured L∃∀N chip with a numeral for the second declaration; a click shows the command (math.CT 2611.03553)", () => {
  const source = String.raw`\label{DSortedSet}\lean{equivalent}{SortedSet,SortedSet.Map}
A sorted set is a set.`;
  const doc = body(source, LEAN_PREAMBLE);
  assert.deepEqual(doc.left, []);
  const chip = [...doc.view.contentDOM.querySelectorAll(".cm-vis-symbol")].find((node) => /L∃∀N/.test(node.textContent ?? ""));
  assert.ok(chip, "a lean chip");
  assert.match(chip!.textContent ?? "", /L∃∀N 2/);
  assert.match((chip as HTMLElement).style.color, /#009e73|rgb\(0, 158, 115\)/i);
  click(chip!);
  assert.match(text(doc.view), /\\lean\{equivalent\}/);
  doc.done();
});

test("blueprint's `\\leanok`, `\\uses{…}`, `\\notready` print nothing in the PDF: hidden, shown at the caret (math.CT-style leanblueprint)", () => {
  const source = String.raw`\label{thm:a}\lean{Foo.bar}\leanok\uses{thm:b, thm:c}
Proof text here.`;
  const doc = body(source, "\\usepackage{blueprint}\n");
  assert.deepEqual(doc.left, []);
  assert.doesNotMatch(doc.lines.join(" "), /leanok|uses|Foo\.bar/);
  assert.match(doc.lines.join(" "), /Proof text here/);
  doc.done();
  const caret = withCaretIn(source, "\\uses", "\\usepackage{blueprint}\n");
  assert.match(caret.text, /\\uses\{thm:b/);
  caret.done();
});

test("`(\\romannumeral1)` is drawn as (i); a click shows the command (econ.GN 2611.02533)", () => {
  const source = String.raw`(\romannumeral1) It documents the relationship, and (\romannumeral 2) the second.`;
  const doc = body(source);
  assert.deepEqual(doc.left, []);
  assert.match(doc.lines.join(" "), /^\(i\) It documents the relationship, and \(ii\)the second\.|\(i\) It documents the relationship, and \(ii\) ?the second\./);
  assert.doesNotMatch(doc.lines.join(" "), /romannumeral/);
  const chip = [...doc.view.contentDOM.querySelectorAll(".cm-vis-symbol")].find((node) => node.textContent === "i")!;
  assert.ok(chip, "a chip drawing the numeral");
  click(chip);
  assert.match(text(doc.view), /\\romannumeral1/);
  doc.done();
});

test("`nolinenumbers`, `\\nointerlineskip` and a `\\vbox to 0pt{\\hbox to \\textwidth{…}\\vss}` placing a line are transparent: only the content is drawn, the caret shows the source (cs.RO 2611.20185)", () => {
  const source = String.raw`Before.

\begin{nolinenumbers}
\nointerlineskip
\vbox to 0pt{%
  \vskip -0.28in
  \hbox to \textwidth{\hfil \url{https://openrobokit.com/robokit}\hfil}%
  \vss
}
\end{nolinenumbers}

After.`;
  const doc = body(source);
  assert.deepEqual(doc.left, []);
  const shown = doc.lines.join(" ");
  assert.match(shown, /openrobokit\.com\/robokit/);
  assert.doesNotMatch(shown, /vbox|hbox|nolinenumbers|nointerlineskip|vss/);
  doc.done();
  // The caret in the box's head, and in the environment's line, shows their source.
  const vbox = withCaretIn(source, "\\vbox");
  assert.match(vbox.text, /\\vbox to 0pt\{/);
  vbox.done();
  const hbox = withCaretIn(source, "\\hbox");
  assert.match(hbox.text, /\\hbox to \\textwidth\{/);
  hbox.done();
  const env = withCaretIn(source, "\\begin{nolinenumbers}");
  assert.match(env.text, /\\begin\{nolinenumbers\}/);
  env.done();
});

test("`KeepFromToc` around a contents list is transparent and the list is drawn; `{\\small\\setlength{…}\\tableofcontents}` draws the list too; a click on the list shows its source (math.OA 2611.08668, math.AG 2611.18357)", () => {
  const source = String.raw`\begin{KeepFromToc}
  \setcounter{tocdepth}{1}
  \tableofcontents
  \thispagestyle{empty}
\end{KeepFromToc}
{\small\setlength{\parskip}{0pt}\tableofcontents}
\section{Two}
Text.`;
  const doc = body(source);
  assert.deepEqual(doc.left, []);
  const lists = [...doc.view.contentDOM.querySelectorAll(".cm-vis-contents")];
  assert.equal(lists.length, 2, "both lists of contents are drawn");
  assert.doesNotMatch(doc.lines.join(" "), /KeepFromToc|tableofcontents/);
  click(lists[1]);
  assert.match(text(doc.view), /\\tableofcontents/);
  doc.done();
  const caret = withCaretIn(source, "\\begin{KeepFromToc}");
  assert.match(caret.text, /\\begin\{KeepFromToc\}/);
  caret.done();
});

test("`\\let\\maketitle\\OriginalMaketitle` after `\\let\\OriginalMaketitle\\maketitle` restores the built-in: the supplement's title block is drawn with its authors and affiliations (cond-mat.str-el 2611.17871)", () => {
  const source = String.raw`\title{Supplemental Material}
\author{Yuchen Liu}
\affiliation{Kavli Institute, Beijing}
\author{Zheng Zhu}
\affiliation{Kavli Institute, Beijing}
\maketitle
Text.
`;
  const root = String.raw`\documentclass{revtex4-2}
\begin{document}
\let\OriginalAuthor\author
\let\OriginalAffiliation\affiliation
\let\OriginalMaketitle\maketitle
\input{article.tex}
\let\author\OriginalAuthor
\let\affiliation\OriginalAffiliation
\let\maketitle\OriginalMaketitle
`;
  const { view, done } = mount(source, 0, [{ path: "nb/main.tex", text: root, version: "1" }]);
  const block = view.contentDOM.querySelector(".cm-vis-title-block");
  assert.ok(block, "a title block, not `\\maketitle` as source");
  assert.match(block!.textContent ?? "", /Yuchen Liu[\s\S]*Zheng Zhu/);
  assert.doesNotMatch(text(view), /\\maketitle/);
  // Editable: a click on the title opens its editor over the argument of `\title`.
  click(block!.querySelector('[data-title-part="title"]')!);
  assert.match(block!.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor")?.value ?? "", /Supplemental Material/);
  done();
});
