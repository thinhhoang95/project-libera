import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { katexForEnvironment, renderKatex } from "../../src/lib/latex/codemirror/visual/math-render";
import { parseAlgorithm2e, parseAlgorithmic } from "../../src/lib/latex/codemirror/visual/algorithm";
import { expandLatexMacros, expandLatexMacroUse, needsMathMode } from "../../src/lib/latex/macros/expand";
import { readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/* Formulas and algorithms from real papers (group E: math and algorithms):
 * Larrauri & Živný 2402.08434 (complexity), 2204.14024 (LIPIcs), 2511.16492 and
 * 2410.03413 (physics), GaLore 2403.03507 (algorithm2e, algorithmic), and the
 * batch 4–5 papers' amsmath, intertext and algpseudocode uses. */

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

/** A formula as the Visual mode draws it: the document's macros expanded, then KaTeX; null when it stays source. */
function drawn(preamble: string, formula: string, display = false) {
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  const expanded = expandLatexMacros(formula, defs, { mode: "math", pos: 0 });
  return expanded.ok ? renderKatex(expanded.text, display) : null;
}

/** Whether `formula` (with the preamble's macros) is drawn as `expected` is (both through KaTeX). */
function drawnAs(preamble: string, formula: string, expected: string, display = false) {
  const html = drawn(preamble, formula, display);
  assert.ok(html, `${formula} is drawn`);
  assert.equal(html, renderKatex(expected, display), formula);
}

test("with the complexity package, \\P and the other classes are sans-serif class names, not ¶ (Larrauri & Živný)", () => {
  const preamble = String.raw`\usepackage{complexity}`;
  drawnAs(preamble, String.raw`\P \subseteq \NP \cap \coNP`, String.raw`\mathsf{P} \subseteq \mathsf{NP} \cap \mathsf{coNP}`);
  drawnAs(preamble, String.raw`\BPP, \PSPACE, \EXP, \class{SZK}, \lang{SAT}`, String.raw`\mathsf{BPP}, \mathsf{PSPACE}, \mathsf{EXP}, \mathsf{SZK}, \mathsf{SAT}`);
  drawnAs(String.raw`\usepackage[classfont=roman]{complexity}`, String.raw`\NP`, String.raw`\mathrm{NP}`);
  // Without the package, `\P` is the pilcrow; with `disableredefinitions` too.
  drawnAs("", String.raw`\P`, String.raw`\P`);
  drawnAs(String.raw`\usepackage[disableredefinitions]{complexity}`, String.raw`\P \ne \NP`, String.raw`\P \ne \mathsf{NP}`);
  // The document's own renewal wins (`\renewcommand{\C}{{\bm{C}}}`).
  drawnAs(String.raw`\usepackage{complexity}\renewcommand{\C}{\mathbf{C}}`, String.raw`\C`, String.raw`\mathbf{C}`);
  // In text: `\NP-hard` is the class, as a formula.
  const text = visibleText(String.raw`\documentclass{article}
\usepackage{complexity}
\begin{document}
The problem is \NP-hard, and for groups in \P.
\end{document}`);
  assert.match(text, /is NP-hard, and for groups in P\./);
  assert.doesNotMatch(text, /\\NP|¶/);
  // The preamble's summary counts the document's macros, not the package's classes.
  assert.match(text, /1 package · 0 macros/);
});

test("with the physics package, its brackets, derivatives and Dirac notation are drawn (2511.16492, 2410.03413)", () => {
  const preamble = String.raw`\usepackage{physics}`;
  drawnAs(preamble, String.raw`\abs{x} + \abs*{y} + \norm{v}`, String.raw`\left\lvert{x}\right\rvert + \lvert{y}\rvert + \left\lVert{v}\right\rVert`);
  drawnAs(preamble, String.raw`\pqty{m_{i,j}}_{1 \le i}`, String.raw`\left({m_{i,j}}\right)_{1 \le i}`);
  drawnAs(preamble, String.raw`\dv{f}{x} = \dv[2]{f}{x} + \dv{x}`, String.raw`\frac{\mathrm{d} f}{\mathrm{d} x} = \frac{\mathrm{d}^{2} f}{\mathrm{d} x^{2}} + \frac{\mathrm{d}}{\mathrm{d} x}`);
  drawnAs(preamble, String.raw`\pdv{f}{x}{y} + \pdv*{f}{x}`, String.raw`\frac{\partial^2 f}{\partial x \partial y} + {\partial f}/{\partial x}`);
  drawnAs(preamble, String.raw`\braket{a}{b} + \braket{a}`, String.raw`\left\langle{a}\middle\vert{b}\right\rangle + \left\langle{a}\middle\vert{a}\right\rangle`);
  drawnAs(preamble, String.raw`\bra{\phi}\ket{\psi}`, String.raw`\left\langle{\phi}\middle\vert {\psi}\right\rangle`);
  drawnAs(preamble, String.raw`\ket{\psi}\bra{\psi}`, String.raw`\left\lvert{\psi}\right\rangle\left\langle{\psi}\right\rvert`);
  drawnAs(preamble, String.raw`\expval{A}{\psi} + \mel{a}{H}{b}`, String.raw`\left\langle{\psi}\middle\vert{A}\middle\vert{\psi}\right\rangle + \left\langle{a}\middle\vert{H}\middle\vert{b}\right\rangle`);
  drawnAs(preamble, String.raw`\qty(\frac{1}{2}) \qty[x] \qty{y} \qty|z| \qty\big(w)`, String.raw`\left(\frac{1}{2}\right) \left[x\right] \left\{y\right\} \left\lvert z\right\rvert \bigl(w\bigr)`);
  drawnAs(preamble, String.raw`\Tr[\rho] + \tr A + \order{x^2}`, String.raw`\operatorname{Tr}\left[\rho\right] + \operatorname{tr} A + \mathcal{O}\left(x^2\right)`);
  drawnAs(preamble, String.raw`\grad\Psi, \div{\vb{E}}, \curl\vb*{\omega}`, String.raw`\boldsymbol{\nabla}\Psi, \boldsymbol{\nabla}\boldsymbol{\cdot}{\mathbf{E}}, \boldsymbol{\nabla}\boldsymbol{\times}\boldsymbol{\omega}`);
  drawnAs(preamble, String.raw`\mqty(a & b \\ c & d)`, String.raw`\begin{pmatrix}a & b \\ c & d\end{pmatrix}`);
  // `\div` is the divergence only with physics; without it, ÷. A `\qty` whose delimiter does not close stays source.
  drawnAs("", String.raw`a \div b`, String.raw`a \div b`);
  assert.equal(drawn(preamble, String.raw`\qty(x`), null);
  assert.equal(drawn("", String.raw`\abs{x}`), null);
  // physics' commands are math: in text, a use stays source.
  assert.match(visibleText(String.raw`\documentclass{article}
\usepackage{physics}
\begin{document}
Text \abs{x} and $\abs{x}$.
\end{document}`), /Text \\abs\{x\} and ∣x∣\./);
});

test("amsmath's capital accents are KaTeX's accents (a macro paper's \\Tilde{\\pi}_1)", () => {
  drawnAs("", String.raw`\Tilde{\pi}_1 + \Bar{x} + \Hat{a} + \Vec{v} + \Dot{q} + \Ddot{q} + \Check{c} + \Breve{b} + \Acute{e} + \Grave{e}`,
    String.raw`\tilde{\pi}_1 + \bar{x} + \hat{a} + \vec{v} + \dot{q} + \ddot{q} + \check{c} + \breve{b} + \acute{e} + \grave{e}`);
  // A macro for a bold letter after one: braced, as TeX reads it.
  drawnAs(String.raw`\newcommand{\bx}{\mathbf{x}}`, String.raw`\Bar\bx`, String.raw`\bar{\mathbf{x}}`);
  assert.ok(needsMathMode(String.raw`\Tilde{x}`));
});

test("KaTeX's gaps in real formulas: \\qedhere, \\sqsubsetneq, \\nulldelimiterspace, \\scalebox (2204.14024, Larrauri & Živný)", () => {
  assert.ok(drawn("", String.raw`(u,w) + (v_1,v_2) = (x,y). \qedhere`, true));
  assert.ok(drawn(String.raw`\newcommand{\lneqsg}{\sqsubsetneq}`, String.raw`ac \lneqsg a`));
  const crestrict = String.raw`\newcommand\Crestrict[2]{{% we make the whole thing an ordinary symbol
  \left.\kern-\nulldelimiterspace % automatically resize the bar with \right
  #1 % the function
  \right|_{#2} % this is the delimiter
  }}`;
  assert.ok(drawn(crestrict, String.raw`\Crestrict{f}{\dom(g)}=g`.replace("\\dom", "\\mathrm{dom}")));
  drawnAs("", String.raw`{\nulldelimiterspace=0pt \left. x \right|}`, String.raw`{ \left. x \right|}`);
  const eq = "\\newcommand{\\eq}{\\mathrel{\\scalebox{0.4}[1]{${=}$}{:}{\\scalebox{0.4}[1]{${=}$}}}}";
  drawnAs(eq, String.raw`f(x) - g(x) \eq \psi`, "f(x) - g(x) \\mathrel{\\text{${=}$}{:}{\\text{${=}$}}} \\psi");
  // youngtab's diagrams are not drawn: the formula stays source.
  assert.equal(drawn("", String.raw`\yng(2,1)`), null);
  assert.equal(drawn("", String.raw`\young(ab,c)`), null);
});

test("\\intertext between an align's rows is a row of text, unnumbered (natural gradient's \\intertext{where})", () => {
  const source = katexForEnvironment("align", String.raw`
 w^{(t+1)} &= w^{(t)} + \eta\Delta,\notag
 \intertext{where}
 \Delta &= \arg\min_d f(d)`);
  const html = renderKatex(source.latex, true);
  assert.ok(html);
  assert.match(html, /where/);
  // One numbered row: the one after the text.
  const element = document.createElement("div");
  element.innerHTML = html;
  assert.equal(element.querySelectorAll(".eqn-num").length, 1);
  assert.ok(renderKatex(katexForEnvironment("align*", String.raw`a &= b \shortintertext{and} c &= d`).latex, true));
});

test("a size environment in a display draws nothing; blockarray stays source (B5-23)", () => {
  assert.ok(renderKatex(String.raw`\begin{small}\begin{aligned} f(v) &\coloneqq \log v \end{aligned}\end{small}`, true));
  assert.equal(renderKatex(String.raw`\mathbf{P} = \begin{blockarray}{cc} & s_0 \\ \begin{block}{c(c)} s_0 & 1 \\ \end{block}\end{blockarray}`, true), null);
});

test("with amsthm, \\qed is □ in text and math, \\qedhere draws nothing, and a proof ends with the document's \\qedsymbol", () => {
  const doc = (preamble: string) => String.raw`\documentclass{article}
\usepackage{amsthm}
${preamble}
\begin{document}
\begin{proof}
This completes the proof.\qed
\[ x = y. \qedhere \]
\end{proof}
\end{document}`;
  const text = visibleText(doc(""));
  assert.match(text, /This completes the proof\.□x=y\.□/);
  assert.doesNotMatch(text, /\\qed/);
  const black = visibleText(doc(String.raw`\renewcommand{\qedsymbol}{$\blacksquare$}`));
  assert.match(black, /proof\.■x=y\.■/);
  // Without amsthm, a proof still ends with ∎.
  assert.match(visibleText(String.raw`\documentclass{article}
\begin{document}
\begin{proof}
Done.
\end{proof}
\end{document}`), /Done\.∎/);
});

/** An algorithmic body's lines as "depth|lead|text|trail|comment" (rules as "depth|rule"). */
function algorithmLines(body: string, options: string | null = "1", preamble = "") {
  const defs = readLatexDefinitions(`${preamble}\n\\begin{document}\\end{document}`);
  const expand = (source: string) => expandLatexMacroUse(source, defs, { mode: "text", pos: Number.MAX_SAFE_INTEGER });
  const spec = parseAlgorithmic(body, options, defs.macros.size ? expand : undefined);
  return spec?.lines.map((line) => (line.rule ? `${line.depth}|${line.rule}` : [line.depth, line.lead ?? "", line.text, line.trail ?? "", line.comment ?? ""].join("|"))) ?? null;
}

test("\\forall in a statement's formula is no \\FORALL, and statements are matched case-sensitively (B5-06)", () => {
  assert.deepEqual(algorithmLines(String.raw`\STATE $\forall i$: $x_i \gets 0$
\FORALL{$j$}
\STATE \(\forall k\) $y \gets 1$
\ENDFOR`), ["0||$\\forall i$: $x_i \\gets 0$||", "0|for all|$j$|do|", "1||\\(\\forall k\\) $y \\gets 1$||", "0|end for|||"]);
  // Lower-case commands are TeX's (`\repeat`, `\loop`, `\input`), not statements.
  assert.deepEqual(algorithmLines(String.raw`\State \return x`), ["0||\\return x||"]);
});

test("algpseudocode's \\Call, algorithmic's \\TRUE and \\AND, and \\algorithmicrequire as the document renames it (B5-24)", () => {
  assert.deepEqual(algorithmLines(String.raw`\State $\mathbf{x} \gets$ \Call{RandRecord}{$\mathbf{x}^*$, $k$}
\If{\Call{SplitSucceeded}{$\Sigma$} \AND $p$}
\State \Call{Init}{}
\EndIf`), ["0||$\\mathbf{x} \\gets$ \\textsc{RandRecord}($\\mathbf{x}^*$, $k$)||", "0|if|\\textsc{SplitSucceeded}($\\Sigma$) \\textbf{and} $p$|then|", "1||\\textsc{Init}||", "0|end if|||"]);
  assert.deepEqual(algorithmLines(String.raw`\REQUIRE $x$
\ENSURE $y$`, null, String.raw`\renewcommand{\algorithmicrequire}{\textbf{Input:}}\algrenewcommand\algorithmicensure{\textbf{Output:}}`), ["0|Input:|$x$||", "0|Output:|$y$||"]);
});

test("\\algnewcommand statements and comments, and \\algdef / \\algblockdefx blocks, are read as what they write (B5-24)", () => {
  const preamble = String.raw`\usepackage{algpseudocode}
\algnewcommand{\LineComment}[1]{\State \(\triangleright\) #1}
\algnewcommand{\Cmnt}[1]{\Comment{\textcolor{gray}{\small\em #1}}}
\algblockdefx[ON]{Blk}{EndBlk}[1]
  {#1}
  {}
\algdef{SE}[DOWHILE]{Do}{doWhile}{\algorithmicdo}[1]{\algorithmicwhile\ #1}`;
  assert.deepEqual(algorithmLines(String.raw`\LineComment{initialise}
\State $x \gets 0$ \Cmnt{a record}
\Blk{On receiving $m$}
\State send $m$
\EndBlk
\Do
\State $x \gets x + 1$
\doWhile{$x < 3$}`, "1", preamble), [
    "0||\\(\\triangleright\\) initialise||", "0||$x \\gets 0$||\\textcolor{gray}{\\small\\em a record}", "0||On receiving $m$||", "1||send $m$||",
    "0||\\textbf{do}||", "1||$x \\gets x + 1$||", "0||\\textbf{while} \\ $x < 3$||",
  ]);
  // `\algtext*{EndBlk}`: the command draws no line.
  assert.equal(readLatexDefinitions(String.raw`\algblockdefx[ON]{Blk}{EndBlk}[1]{#1}{\textbf{end}}\algtext*{EndBlk}`).macros.get("EndBlk")?.at(-1)?.body, "\\algorithmic@end{}");
  // A definition in the body is an inert unit (round 5): folded, nothing it defines is drawn there, and its source shows at the caret.
  const bodyDef = String.raw`\documentclass{article}
\begin{document}
\algnewcommand{\Note}[1]{\State #1}
Text.
\end{document}`;
  assert.doesNotMatch(visibleText(bodyDef), /algnewcommand|Note|State/);
  {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: visualState(bodyDef), parent });
    refreshVisualWidgets(view);
    view.dispatch({ selection: { anchor: bodyDef.indexOf("\\algnewcommand") + 4 } });
    assert.match(view.contentDOM.textContent ?? "", /\\algnewcommand\{\\Note\}\[1\]\{\\State #1\}/);
    view.destroy();
    parent.remove();
  }
});

test("\\\\\\hrulefill between statements is a rule across the algorithm; a fill in a line is space (GaLore, B6-21)", () => {
  assert.deepEqual(algorithmLines(String.raw`\STATE $R_t \gets P_{t}^{\top} G_t$ \hfill \COMMENT{Project gradient}
   \\\hrulefill
   \STATE {\bfseries Update by Adam}
   \STATE \dotfill
   \STATE Input \dotfill $x$`, null), ["0||$R_t \\gets P_{t}^{\\top} G_t$ \\hfill||Project gradient", "0|solid", "0||{\\bfseries Update by Adam}||", "0|dotted", "0||Input   $x$||"]);
});

test("algorithm2e: keywords declared in the preamble, the document's statement macros, and \\Indp / \\Indm (GaLore, B6-19)", () => {
  const doc = (preamble: string, body: string) => String.raw`\documentclass{article}
\usepackage[ruled,vlined]{algorithm2e}
${preamble}
\begin{document}
\begin{algorithm}[t]
${body}
\caption{Code}
\end{algorithm}
\end{document}`;
  const preamble = String.raw`\SetKwInOut{Input}{Input}\SetKwFunction{FUpdate}{Update}
\SetKwProg{Fn}{Function}{:}{}
\newcommand{\PyCode}[1]{\texttt{#1}}`;
  const text = visibleText(doc(preamble, String.raw`\SetAlgoLined
\Input{weights $W$}
\Fn{\FUpdate{$W$}}{
  \PyCode{for weight in model.parameters():} \\
  \Indp
  \PyCode{grad = weight.grad} \\
  \Indm
  \PyCode{done} \\
}`));
  assert.match(text, /Input:\s*weights W/);
  assert.match(text, /Function\s*Update\(W\):/i);
  assert.match(text, /for weight in model\.parameters\(\):\s*grad = weight\.grad\s*done/);
  assert.doesNotMatch(text, /\\Indp|\\PyCode|\\Input/);
  // The levels \Indp and \Indm set.
  const spec = parseAlgorithm2e(String.raw`a\; \Indp b\; \Indp c\; \Indm d\; \Indm \Indm e\;`, { numbered: false, ends: false });
  assert.deepEqual(spec?.lines.map((line) => `${line.depth}${line.text}`), ["0a", "1b", "2c", "1d", "0e"]);
  // A capitalised command that is no macro of the document still keeps the algorithm source.
  assert.equal(parseAlgorithm2e(String.raw`\Unknown{x}\;`, { numbered: false, ends: false }, () => null), null);
});

test("KaTeX's gaps in real formulas: \\sun, \\arrowvert, \\slashed, \\ooalign, \\textsc around a formula, booktabs rules (2611.08676, 2611.11568, 2611.09172, 2611.11191)", () => {
  drawnAs("", String.raw`\left(\frac{N_{\mathrm{X}}}{N_{\mathrm{H}}}\right)_{\sun}`, String.raw`\left(\frac{N_{\mathrm{X}}}{N_{\mathrm{H}}}\right)_{\odot}`);
  drawnAs("", String.raw`\Big\arrowvert x \Big\Arrowvert`, String.raw`\Big\vert x \Big\Vert`);
  // slashed's `/` centred over its argument, braced or not; the `\Slash` idiom built with `\ooalign` draws the same overlay.
  const slashed = (x: string, slash = "/") => `{\\mathclap{\\hphantom{${x}}\\mathclap{${slash}}}${x}}`;
  drawnAs(String.raw`\usepackage{slashed}`, String.raw`\slashed{k} + \slashed n_1`, `${slashed("k")} + ${slashed("n")}_1`);
  drawnAs(String.raw`\newcommand{\Slash}[1]{{\ooalign{\hfil/\hfil\crcr$#1$}}}`, String.raw`{\rm Tr}\left[ \bar\Gamma(\Slash{k}+m) \right]`, String.raw`{\rm Tr}\left[ \bar\Gamma({${slashed("k", "\\text{/}")}}+m) \right]`);
  // An overlay whose alignment is not read (neither row centred) stays source.
  assert.equal(drawn("", String.raw`{\ooalign{$a$\crcr$b$}}`), null);
  drawnAs(String.raw`\newcommand{\nodes}{\mathit{nodes}}`, String.raw`P[i]\gets\textsc{FetchInvalidSubtrees($T.\nodes[i]$)}`,
    String.raw`P[i]\gets\text{F{\small ETCH}I{\small NVALID}S{\small UBTREES}($T.\mathit{nodes}[i]$)}`);
  drawnAs("", String.raw`\begin{array}{cc} \toprule v & 0\\ \midrule x & y\\ \bottomrule \end{array}`, String.raw`\begin{array}{cc} \hline v & 0\\ \hline x & y\\ \hline \end{array}`, true);
});

test("a written-out mleftright (\\left as \\mathclose\\bgroup…, \\right with \\aftergroup) keeps TeX's \\left and \\right (2611.09172)", () => {
  const preamble = String.raw`\let \originalleft \left
\let\originalright\right
\renewcommand{\left}{\mathopen{}\mathclose\bgroup\originalleft}
\renewcommand{\right}{\aftergroup\egroup\originalright}`;
  drawnAs(preamble, String.raw`O\!\left(\frac{n}{B}\log_{M/B}\frac{n}{B}\right)`, String.raw`O\!\left(\frac{n}{B}\log_{M/B}\frac{n}{B}\right)`);
});

test("\\ensuremath in text is an inline formula, also from a macro ending in \\xspace (2610.41832's lhs2TeX, 2611.08676's \\css)", () => {
  const text = visibleText(String.raw`\documentclass{article}
\newcommand{\Conid}[1]{\mathit{#1}}
\newcommand{\css}{\ensuremath{\mathrm{CS}_{2}}\xspace}
\begin{document}
The relation \ensuremath{\mathcal{R}\mathbin{\circ}\mathcal{S}} on \ensuremath{\Conid{C}}, with \css{} and \css here.
\end{document}`).replace(/\u200b/g, "");
  assert.doesNotMatch(text, /\\ensuremath|\\Conid|\\css/);
  assert.match(text, /The relation R∘S on C, with CS2 and CS2 here\./);
});

test("algorithm2e (cs.DS 2611.09172): \\SetKwFor loops with side comments, \\lIf with \\Return and \\tcp*, \\Return without braces, the font and margin set at the start", () => {
  const spec = parseAlgorithm2e(String.raw`\fontsize{9pt}{9.5pt}\selectfont
\setlength{\algomargin}{0em}
\caption{Batch Insertion\label{algo:insert}}
\SetKwFor{parFor}{parallel-for}{do}{endfor}
\SetKwProg{MyFunc}{Function}{}{end}
\DontPrintSemicolon
\MyFunc{\upshape{\textsc{InsertSorted$(T,E)$}}}{
  \lIf{$E$ is empty}{\Return $T$ \tcp*[f]{Unchanged}\label{line:empty}}
  \parFor(\tcp*[f]{Recursively insert}){$i\gets 0$ to $b-1$}{
    $U[i]\gets x$
  }
  \Return $H$
}`, { numbered: true, ends: true });
  assert.deepEqual(spec?.lines.map((line) => [line.depth, line.lead ?? "", line.text, line.trail ?? "", line.comment ?? ""].join("|")), [
    "0|Function|\\upshape{\\textsc{InsertSorted$(T,E)$}}||",
    "1|if|$E$ is empty \\textbf{then} \\textbf{return} $T$||Unchanged",
    "1|parallel-for|$i\\gets 0$ to $b-1$|do|Recursively insert",
    "2||$U[i]\\gets x$||",
    "1|endfor|||",
    "1||\\textbf{return} $H$||",
    "0|end|||",
  ]);
  // A keyword written with LaTeX is drawn as LaTeX, in bold.
  const latexLead = parseAlgorithm2e(String.raw`\SetKwFor{hnode}{A \heavynode{} maintains}{}{}\hnode{}{x\;}`, { numbered: false, ends: false });
  assert.deepEqual(latexLead?.lines.map((line) => `${line.lead ?? ""}|${line.text}`), ["|\\textbf{A \\heavynode{} maintains}", "|x"]);
  // A block inside a one-line form is not one line, and definitions in the algorithm change how it prints: they are
  // source lines (an algorithm of nothing else stays source).
  assert.equal(parseAlgorithm2e(String.raw`\lIf{c}{\If{d}{x}}`, { numbered: false, ends: false }), null);
  assert.deepEqual(parseAlgorithm2e(String.raw`\let\oldnl\nl x\;`, { numbered: false, ends: false })?.lines.map((line) => `${line.text}|${line.raw ?? false}`), ["\\let\\oldnl\\nl|true", "x|false"]);
});
