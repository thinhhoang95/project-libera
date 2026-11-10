import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { disabledField, setMacroSources, setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexParser as parser } from "../../src/lib/latex/codemirror/latex-parser";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { renderKatex } from "../../src/lib/latex/codemirror/visual/math-render";
import { expandLatexMacros, expandLatexMacroUse } from "../../src/lib/latex/macros/expand";
import { collectLatexDefinitions, macroAt, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";
import { disabledRegions, discardingMacros } from "../../src/lib/latex/macros/structure";
import { decideConditional } from "../../src/lib/latex/macros/conditionals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = []) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

/** Kinds of the constructs built at the first occurrence of `needle`. */
function kindsAt(state: EditorState, needle: string) {
  const pos = state.doc.toString().indexOf(needle);
  assert.ok(pos >= 0, needle);
  const out: string[] = [];
  state.field(structuralField).extents.between(pos, pos + 1, (_from, _to, mark) => { out.push(mark.kind); });
  return out;
}

/** The text a mounted Visual mode shows for `doc` (widgets' text included), numbered as the app numbers it. */
function visibleText(doc: string, extra: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const text = view.contentDOM.textContent ?? "";
  view.destroy();
  parent.remove();
  return text;
}

function number(source: string) {
  const tree = parser.parse(source);
  return computeLatexNumbering(tree, (from, to) => source.slice(from, to), readLatexDefinitions(source));
}

/** A formula as the Visual mode draws it: the document's macros expanded, then KaTeX; null when it stays source. */
function drawn(preamble: string, formula: string) {
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  const expanded = expandLatexMacros(formula, defs, { mode: "math", pos: 0 });
  return expanded.ok ? renderKatex(expanded.text, false) : null;
}

/** What the regions left out of `source` hold, read with its definitions. */
function leftOut(source: string) {
  const defs = readLatexDefinitions(source);
  return disabledRegions(source, discardingMacros(defs), defs).map((region) => source.slice(region.from, region.to));
}

/* Conditionals and definitions from the seventh batch of papers (2410.03413's mode switches and `\if0`, 2204.14024's
 * thmtools theorems, 2402.08434's definers) and earlier batches (ICML's author switch, estout's `\sym`). */

test("B7-03: \\if0 on its own line leaves out what follows, as \\iffalse does; \\if11 keeps it (2410.03413)", () => {
  const source = String.raw`\newtheorem{lemma}{Lemma}
\begin{document}
\section{Kept}
\if0
\begin{lemma}\label{gone}Old.\end{lemma}
\section{Gone}
\fi
\if11
\begin{lemma}\label{kept}New.\end{lemma}
\fi
\end{document}`;
  const numbering = number(source);
  assert.equal(numbering.labels.has("gone"), false);
  assert.equal(numbering.labels.get("kept")?.number, "1");
  assert.deepEqual(numbering.entries.filter((entry) => entry.kind === "section").map((entry) => entry.number), ["1"]);
  const state = visualState(source);
  assert.deepEqual(kindsAt(state, "\\section{Gone}"), ["disabled"]);
  assert.ok(!kindsAt(state, "\\begin{lemma}\\label{kept}").includes("disabled"));
});

test("B7-04: \\ifnum on a \\def'd or \\newcommand'd flag is decided: one branch drawn and numbered, its theorems read (2410.03413)", () => {
  const source = String.raw`\def\llncs{0}
\newcommand{\full}{1}
\ifnum\llncs=1
\newtheorem{theorem}{Theorem}
\else
\newtheorem{theorem}{Theorem}[section]
\fi
\begin{document}
\section{Intro}
\ifnum\llncs=0
\begin{theorem}\label{long}Full version.\end{theorem}
\else
\begin{theorem}\label{short}Short version.\end{theorem}
\fi
\ifnum\full>0 \section{Appendix}\label{app}\fi
\end{document}`;
  const defs = readLatexDefinitions(source);
  assert.equal(defs.theorems.get("theorem")?.within, "section");
  const numbering = number(source);
  assert.equal(numbering.labels.get("long")?.number, "1.1");
  assert.equal(numbering.labels.has("short"), false);
  assert.equal(numbering.labels.get("app")?.number, "2");
  // The branches not taken, and the tests and `\fi`s of decided conditionals, which print nothing.
  assert.deepEqual(leftOut(source).map((text) => text.slice(0, 13)), ["\\ifnum\\llncs=", "\\fi", "\\ifnum\\llncs=", "\\else\n\\begin{", "\\ifnum\\full>0", "\\fi"]);
  // `\iff` is an arrow, not a conditional the `\fi` would close.
  assert.deepEqual(leftOut(String.raw`\def\llncs{0}\begin{document}\ifnum\llncs=1 $a\iff b$\fi\end{document}`), [String.raw`\ifnum\llncs=1 $a\iff b$\fi`]);
  // A test on what the reader does not know (a counter) stays undecided: nothing is left out.
  assert.deepEqual(leftOut(String.raw`\begin{document}\ifnum\value{page}=1 A\else B\fi\end{document}`), []);
});

test("B7-04: a branch left out inside a paragraph's line fades only its own text, not the line", () => {
  const source = String.raw`\def\llncs{0}
\begin{document}
We prove it in section~2 \ifnum\llncs=1 (short)\else (full)\fi and then more.
\end{document}`;
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(source), parent });
  try {
    const line = [...view.contentDOM.querySelectorAll(".cm-line")].find((element) => element.textContent?.includes("We prove"));
    assert.ok(line && !line.classList.contains("cm-vis-disabled"));
    assert.deepEqual([...line.querySelectorAll(".cm-vis-disabled-text")].map((element) => element.textContent), ["\\ifnum\\llncs=1 (short)\\else", "\\fi"]);
  } finally {
    view.destroy();
    parent.remove();
  }
});

test("TeX's tests are decided as TeX decides them, and left undecided when what they test is not known", () => {
  const constants: Record<string, string> = { flag: "1", width: "2.5cm", mode: "draft", draft: "draft", final: "final" };
  const facts = { constant: (name: string) => constants[name], defined: (name: string) => (name in constants ? true : undefined) };
  const decide = (text: string) => {
    const match = /^\\(if[A-Za-z]*)/.exec(text)!;
    return decideConditional(text, match[0].length, match[1], facts)?.value ?? null;
  };
  const cases: Array<[string, boolean | null]> = [
    ["\\if0\n\\begin{lemma}", false], ["\\if1\nText", false], ["\\if11 yes", true], ["\\if1\\flag yes", true], ["\\if0%\n0 yes", true],
    ["\\ifx 1 0", false], ["\\ifx 1 1", null], ["\\ifx\\mode\\final", false], ["\\ifx\\mode\\draft", null], ["\\ifx\\flag\\undefined", false],
    ["\\ifnum\\flag=1 yes", true], ["\\ifnum \\flag > 2 yes", false], ["\\ifnum\\flag0=10 yes", null], ["\\ifnum\\value{page}=1", null],
    ["\\ifdim\\width>1in yes", false], ["\\ifdim\\width<1in yes", true], ["\\ifdim\\linewidth>1in", null], ["\\ifodd\\flag yes", true],
    ["\\ifdefined\\flag yes", true], ["\\ifdefined\\other yes", null], ["\\ifmmode x", null], ["\\ifcase\\month\\or A\\fi", null],
  ];
  for (const [text, value] of cases) assert.equal(decide(text), value, text);
});

test("B7-02: a plain TeX \\loop … \\repeat does not put later definitions under a condition (2410.03413's macros_basic.tex)", () => {
  const source = String.raw`\newcounter{char}
\setcounter{char}{1}
\loop
   \edef\letter{\alph{char}}
   \stepcounter{char}
   \unless\ifnum\thechar>26
\repeat
\newcommand{\later}{x}
\newtheorem{lemma}{Lemma}
\begin{document}\end{document}`;
  const defs = readLatexDefinitions(source);
  assert.equal(macroAt(defs, "later", 0)?.body, "x");
  assert.equal(macroAt(defs, "later", 0)?.unsupported, undefined);
  assert.ok(defs.theorems.has("lemma"));
  assert.equal(macroAt(defs, "letter", 0), null);
});

test("B3-03: a \\newif switch decides a macro's conditional when it is set before the use; one not known stays source", () => {
  const preamble = String.raw`\newif\ifshowauthors
\newcommand{\who}[1]{\ifshowauthors #1\else Anonymous\fi}`;
  const expand = (source: string) => {
    const defs = readLatexDefinitions(source);
    return expandLatexMacroUse(String.raw`\who{Alice}`, defs, { mode: "text", pos: source.indexOf("USE") })?.text;
  };
  assert.equal(expand(`${preamble}\n\\showauthorstrue\n\\begin{document}USE\\end{document}`), "Alice");
  assert.equal(expand(`${preamble}\n\\begin{document}USE\\end{document}`), "Anonymous");
  // Set in the body: from there on.
  assert.equal(expand(`${preamble}\n\\begin{document}\\showauthorstrue USE\\end{document}`), "Alice");
  // Set under a condition the reader cannot evaluate: the conditional stays (and the use stays source).
  assert.match(expand(`${preamble}\n\\ifx\\a\\b\\showauthorstrue\\fi\n\\begin{document}USE\\end{document}`) ?? "", /\\ifshowauthors/);
});

test("B3-03: a package's options decide what it defines (ICML's \\DeclareOption{accepted}{\\gdef\\isaccepted{1}})", () => {
  const sty = String.raw`\newif\if@accepted
\DeclareOption{accepted}{\gdef\isaccepted{1}\@acceptedtrue}
\ProcessOptions\relax
\newcommand{\who}[1]{\ifdefined\isaccepted #1\else Anonymous\fi}
\newcommand{\venue}{\if@accepted Proceedings\else Under review\fi}`;
  const expand = (options: string, use: string) => {
    const main = `\\usepackage${options}{conf}\n\\begin{document}\\end{document}`;
    const defs = collectLatexDefinitions([{ path: "nb/conf.sty", text: sty, loadedBy: "", key: "package:conf" }], { text: main });
    return expandLatexMacroUse(use, defs, { mode: "text", pos: main.length })?.text;
  };
  assert.equal(expand("[accepted]", String.raw`\who{Alice}`), "Alice");
  assert.equal(expand("[accepted]", String.raw`\venue`), "Proceedings");
  assert.equal(expand("", String.raw`\venue`), "Under review");
  // `\isaccepted` is not defined without the option; `\ifdefined` of a name the reader does not know stays undecided.
  assert.match(expand("", String.raw`\who{Alice}`) ?? "", /\\ifdefined/);
});

test("B3-03: a package's default options (\\ExecuteOptions) set its switches before the options given", () => {
  const sty = String.raw`\newif\if@twoside
\DeclareOption{oneside}{\@twosidefalse}
\DeclareOption{twoside}{\@twosidetrue}
\ExecuteOptions{twoside}
\ProcessOptions
\newcommand{\sides}{\if@twoside two\else one\fi}`;
  const sides = (options: string) => {
    const main = `\\usepackage${options}{pages}\n\\begin{document}\\end{document}`;
    const defs = collectLatexDefinitions([{ path: "nb/pages.sty", text: sty, loadedBy: "", key: "package:pages" }], { text: main });
    return expandLatexMacroUse(String.raw`\sides`, defs, { mode: "text", pos: main.length })?.text;
  };
  assert.equal(sides(""), "two");
  assert.equal(sides("[oneside]"), "one");
  // Read without its loader, the options are not known: the switch is not either.
  const alone = collectLatexDefinitions([{ path: "nb/pages.sty", text: sty }], { text: "\\begin{document}\\end{document}" });
  assert.match(expandLatexMacroUse(String.raw`\sides`, alone, { mode: "text" })?.text ?? "", /\\if@twoside/);
});

test("B4-16: estout's \\sym takes its \\ifmmode branch: a superscript formula in text, a superscript in math", () => {
  const preamble = String.raw`\def\sym#1{\ifmmode^{#1}\else\(^{#1}\)\fi}`;
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  assert.equal(expandLatexMacros(String.raw`0.12\sym{***}`, defs, { mode: "text" }).text, String.raw`0.12\(^{***}\)`);
  assert.equal(expandLatexMacros(String.raw`$0.12\sym{*}$`, defs, { mode: "text" }).text, String.raw`$0.12^{*}$`);
  assert.ok(drawn(preamble, String.raw`0.12\sym{**}`));
});

test("B3-21: ifthen's \\ifthenelse with \\equal and \\boolean is evaluated in an expansion (2107.05853's \\prob)", () => {
  const preamble = String.raw`\newcommand{\prob}[2][]{\text{\bf Pr}\ifthenelse{\not\equal{}{#1}}{_{#1}}{}[#2]}
\newboolean{long}\setboolean{long}{true}
\newcommand{\ver}{\ifthenelse{\boolean{long}}{full}{short}}`;
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  assert.equal(expandLatexMacros(String.raw`\prob{x}`, defs).text, String.raw`\text{\bf Pr}[x]`);
  assert.equal(expandLatexMacros(String.raw`\prob[D]{x}`, defs).text, String.raw`\text{\bf Pr}_{D}[x]`);
  assert.equal(expandLatexMacroUse(String.raw`\ver`, defs, { mode: "text" })?.text, "full");
  assert.ok(drawn(preamble, String.raw`\prob[D]{x}`));
});

test("B7-05: \\crefname under a conditional the reader cannot evaluate is not applied", () => {
  const defs = readLatexDefinitions(String.raw`\ifx\a\b
\crefname{lemma}{lem.}{lems.}
\fi
\crefname{theorem}{thm.}{thms.}
\begin{document}\end{document}`);
  assert.equal(defs.crefNames.has("lemma"), false);
  assert.equal(defs.crefNames.get("theorem")?.singular, "thm.");
});

test("M-12: a date written with \\ifcase\\month shows no month list or stray tokens", () => {
  const text = visibleText(String.raw`\title{T}
\date{\ifcase\month\or January\or February\or March\fi \number\year}
\begin{document}
\maketitle
Body.
\end{document}`);
  assert.ok(!/January\s*February/.test(text), text);
  assert.ok(!/\\number|\\year|\\month/.test(text), text);
});

test("B7-01: thmtools' \\declaretheorem is read: name, numberwithin, sibling, numbered=no, style, the default name", () => {
  const source = String.raw`\declaretheorem[numberwithin=section]{theorem}
\declaretheorem[sibling=theorem]{lemma}
\declaretheorem[sibling=theorem,name=Rule,style=definition]{rul}
\declaretheorem[style=remark, numbered=no, name=Remark]{remark}
\begin{document}
\section{A}
\begin{theorem}\label{t}T.\end{theorem}
\begin{lemma}\label{l}L.\end{lemma}
\begin{rul}\label{r}R.\end{rul}
\begin{remark}Note.\end{remark}
\end{document}`;
  const defs = readLatexDefinitions(source);
  assert.deepEqual(defs.theorems.get("lemma"), { name: "lemma", title: "Lemma", counter: "theorem", within: undefined, numbered: true, style: "plain" });
  assert.equal(defs.theorems.get("rul")?.style, "definition");
  assert.equal(defs.theorems.get("rul")?.title, "Rule");
  assert.equal(defs.theorems.get("remark")?.numbered, false);
  const labels = number(source).labels;
  assert.deepEqual(["t", "l", "r"].map((key) => labels.get(key)?.number), ["1.1", "1.2", "1.3"]);
  assert.match(visibleText(source), /Lemma 1\.2/);
});

test("B4-23: \\newtheoremstyle's body and head fonts give the theorem's style (2211.14219)", () => {
  const defs = readLatexDefinitions(String.raw`\newtheoremstyle{newtheorem}{5pt}{2pt}{\itshape}{0pt}{\bfseries}{.}{.4em}{\thmname{#1}}
\newtheoremstyle{named}{}{}{}{}{\bfseries}{.}{.5em}{\thmnote{#3}}
\newtheoremstyle{note}{}{}{\normalfont}{}{\itshape}{:}{ }{}
\theoremstyle{newtheorem}\newtheorem{assumption}{Assumption}
\theoremstyle{named}\newtheorem*{namedenv}{namedenv}
\theoremstyle{note}\newtheorem{obs}{Observation}
\begin{document}\end{document}`);
  assert.deepEqual(["assumption", "namedenv", "obs"].map((name) => defs.theorems.get(name)?.style), ["plain", "definition", "remark"]);
});

test("B7-06: macros made by the document's own definer macro are read (2402.08434's \\newmathabbrev)", () => {
  const preamble = String.raw`\newcommand{\newmathabbrev}[2]{\newcommand{#1}{\mathrm{#2}}}
\newmathabbrev{\Pol}{Pol}
\newmathabbrev{\Inv}{Inv}`;
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  assert.equal(macroAt(defs, "Pol", 0)?.body, String.raw`\mathrm{Pol}`);
  assert.equal(expandLatexMacros(String.raw`\Pol(\Inv)`, defs).text, String.raw`\mathrm{Pol}(\mathrm{Inv})`);
});

test("B7-07: \\newcommand with a one-token body without braces (2204.14024's \\newcommand\\cfont\\mathsf)", () => {
  const preamble = String.raw`\newcommand\cfont\mathsf
\newcommand{\eps}\varepsilon`;
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  assert.equal(macroAt(defs, "cfont", 0)?.body, "\\mathsf");
  assert.equal(expandLatexMacros(String.raw`\cfont{C} + \eps`, defs).text, String.raw`\mathsf{C} + \varepsilon`);
  assert.ok(drawn(preamble, String.raw`\cfont{C}_\eps`));
});

test("B7-08: \\DeclareMathAlphabet, \\mathchardef and \\DeclareMathSymbol are drawn with the alphabet or symbol they name", () => {
  const preamble = String.raw`\DeclareMathAlphabet{\mathbfsf}{OT1}{cmss}{bx}{n}
\DeclareMathAlphabet{\mathpzc}{OT1}{pzc}{m}{it}
\DeclareMathAlphabet{\mathsfit}{\encodingdefault}{\sfdefault}{m}{sl}
\DeclareMathAlphabet{\mathodd}{U}{oddfont}{m}{n}
\mathchardef\mhyphen="2D
\DeclareMathSymbol{\R}{\mathalpha}{AMSb}{"52}`;
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  assert.equal(macroAt(defs, "mathbfsf", 0)?.body, "\\mathbf{#1}");
  assert.equal(macroAt(defs, "mathpzc", 0)?.body, "\\mathscr{#1}");
  assert.equal(macroAt(defs, "R", 0)?.body, "\\mathbb{R}");
  assert.ok(drawn(preamble, String.raw`\mathbfsf{T} \in \R^{n}, \mathpzc{A}, \mathsfit{x}, \text{non}\mhyphen x`));
  // A font the Visual mode does not have: listed as not rendered, its uses stay source.
  assert.equal(macroAt(defs, "mathodd", 0)?.unsupported, true);
  assert.equal(drawn(preamble, String.raw`\mathodd{A}`), null);
});

test("B7-09: mathtools' \\DeclarePairedDelimiterX with a body and \\delimsize (2410.03413's \\braket)", () => {
  const preamble = String.raw`\DeclarePairedDelimiterX\braket[2]{\langle}{\rangle}{#1 \delimsize\vert #2}
\DeclarePairedDelimiterX{\norm}[1]{\lVert}{\rVert}{#1}
\DeclarePairedDelimiterXPP{\Prob}[1]{\mathbb{P}}{[}{]}{}{#1}`;
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  assert.equal(expandLatexMacros(String.raw`\braket{a}{b}`, defs).text, String.raw`\mathopen{\langle}a \vert b\mathclose{\rangle}`);
  assert.equal(expandLatexMacros(String.raw`\braket*{a}{b}`, defs).text, String.raw`\left\langle a \middle\vert b \right\rangle`);
  assert.equal(expandLatexMacros(String.raw`\norm[\big]{x}`, defs).text, String.raw`\mathopen{\big\lVert}x\mathclose{\big\rVert}`);
  for (const formula of [String.raw`\braket{a}{b}`, String.raw`\braket*{\frac12}{b}`, String.raw`\norm[\Big]{x}`, String.raw`\Prob{X>1}`]) assert.ok(drawn(preamble, formula), formula);
});

test("B7-10: \\let\\x\\undefined removes a macro; a \\let copy of a built-in stands for the original in its redefinition", () => {
  const preamble = String.raw`\newcommand{\x}{X}
\let\x\undefined
\let\oldhat\hat
\renewcommand{\hat}[1]{\oldhat{\mathbf{#1}}}`;
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  assert.equal(macroAt(defs, "x", 0)?.unsupported, true);
  assert.equal(expandLatexMacros(String.raw`\hat{v}`, defs).text, String.raw`\hat{\mathbf{v}}`);
  assert.ok(drawn(preamble, String.raw`\hat{v} + \hat{w}`));
});

test("B5-25: a \\paragraph redefined around its saved original is still drawn as a heading (2107.05853)", () => {
  const source = String.raw`\let\oldparagraph\paragraph
\renewcommand{\paragraph}[1]{\oldparagraph{#1.}}
\begin{document}
\paragraph{Setup} We study.
\end{document}`;
  assert.ok(kindsAt(visualState(source), "\\paragraph{Setup}").includes("heading"));
});

test("B4-27: the empty group after a macro without arguments is not shown (\\etal{} show)", () => {
  const text = visibleText(String.raw`\newcommand{\etal}{et al.}
\begin{document}
Smith \etal{} show it.
\end{document}`);
  assert.match(text, /Smith et al\. show it\./);
  assert.ok(!text.includes("{}"), text);
});

test("conditionals in a project file decide the open file's regions, and a change of the flag moves them", () => {
  const main = String.raw`\def\llncs{1}`;
  const body = String.raw`\begin{document}
\ifnum\llncs=1 \section{Short}\else \section{Long}\fi
\end{document}`;
  const sources = (text: string) => [setMacroSources.of([{ path: "nb/flags.tex", text, version: text }])];
  let state = visualState(body);
  state = state.update({ effects: sources(main) }).state;
  const regions = () => state.field(disabledField).map((region) => state.doc.sliceString(region.from, region.to));
  // The test of the branch taken is left out with the other branch.
  assert.deepEqual(regions(), ["\\ifnum\\llncs=1 ", "\\else \\section{Long}\\fi"]);
  state = state.update({ effects: sources(String.raw`\def\llncs{0}`) }).state;
  assert.deepEqual(regions(), ["\\ifnum\\llncs=1 \\section{Short}\\else", "\\fi"]);
});

test("version switches made of \\ifx…\\undefined pass their argument on or leave it out; the one on holds the title (cs.DS 2611.09172)", () => {
  const source = String.raw`\documentclass{acmart}
\def\fullversion
% \def\conference
\setcopyright{acmcopyright}
\newcommand{\ifconference}[1]{{{\ifx\fullversion\undefined{#1}\fi}\xspace}}
\newcommand{\iffullversion}[1]{{{\ifx\conference\undefined{#1}\fi}\xspace}}
\begin{document}
\ifconference{ \title{Short Title} }
\iffullversion{ \title{Full Title} }
\author{Ziyang Men}
\email{ziyang.men@email.ucr.edu}
\affiliation{\institution{University of California, Riverside}\country{}}
\input{abstract}
\ccsdesc[500]{Computer systems organization~Embedded systems}
\maketitle
\section{Intro}
Shown in \ifconference{the supplemental material.}\iffullversion{the appendix} here.
\end{document}`;
  // `\def\fullversion` reads up to the next brace (delimited parameters): still a definition.
  assert.deepEqual(leftOut(source).map((text) => text.slice(0, 16)), ["\\ifconference{ \\", "\\ifconference{th"]);
  const state = visualState(source);
  assert.ok(kindsAt(state, "\\iffullversion{the").includes("macro-args"));
  assert.ok(kindsAt(state, "\\ifconference{ \\title").includes("title"));
  const text = visibleText(source);
  assert.match(text, /Full Title/);
  assert.match(text, /the appendix here\./);
  assert.doesNotMatch(text, /\\iffullversion|\\title|\\author|\\ccsdesc/);
});

test("an identity wrapper around a paragraph heading draws its content; a true \\newif switch's markers print nothing (q-bio.NC 2610.36484)", () => {
  const source = String.raw`\documentclass{article}
\newif\ifarxiv
\arxivtrue
\newcommand{\rev}[1]{#1}
\newcommand{\revc}[1]{\textcolor{red}{#1}}
\begin{document}
\section{Details}
\rev{\paragraph{Version.} Every number comes from one version.}

\revc{\paragraph{Scope.} Ten tasks.}

\ifarxiv\else
Checklist text.
\fi
\end{document}`;
  const state = visualState(source);
  assert.ok(kindsAt(state, "\\rev{").includes("macro-args"));
  assert.ok(kindsAt(state, "\\paragraph{Version.}").includes("heading"));
  assert.ok(kindsAt(state, "\\revc{").includes("macro-args"));
  assert.deepEqual(leftOut(source), ["\\ifarxiv", "\\else\nChecklist text.\n\\fi"]);
  const text = visibleText(source);
  assert.match(text, /Version\.\s*Every number comes from one version\./);
  assert.doesNotMatch(text, /\\rev|\\paragraph/);
});
