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
import { renderLatexFragment } from "../../src/lib/latex/codemirror/visual/render-fragment";
import { readCodeBlock, renderCodeBlock } from "../../src/lib/latex/codemirror/visual/text-commands";
import { readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { EMPTY_AUX } from "../../src/lib/latex/aux-file";
import { computeLatexNumbering, EMPTY_NUMBERING } from "../../src/lib/latex/macros/numbering";

/* Running text in the Visual mode: enumitem's continued lists, counters printed in the text, code, tracked changes and
 * the text commands papers use. Each test is the smallest source showing the gap. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The Visual mode's state for `doc`, with every pending piece built. */
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

/** Constructs as "kind:from:to": what the structural layer has built. */
function constructs(state: EditorState) {
  const list: string[] = [];
  state.field(structuralField).extents.between(0, state.doc.length, (from, to, mark) => { list.push(`${mark.kind}:${from}:${to}`); });
  return list;
}

/** Numbers the view as the app does and draws its widgets' numbers. */
function renumber(view: EditorView) {
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
}

/** A mounted Visual mode for `doc`; `inspect` reads it before it is destroyed. */
function withView<T>(doc: string, inspect: (view: EditorView) => T, anchor = doc.length) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, [], anchor), parent });
  renumber(view);
  try {
    return inspect(view);
  } finally {
    view.destroy();
    parent.remove();
  }
}

/** Each line's text as the mounted Visual mode shows it (widgets' text included), and the source it shows as code. */
function shown(doc: string) {
  return withView(doc, (view) => ({
    lines: [...view.contentDOM.children].map((line) => line.textContent ?? "").filter((line) => line.trim() && !/^▸ Preamble/.test(line)),
    html: view.contentDOM.innerHTML,
  }));
}

const inDocument = (body: string, preamble = "") => `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;

test("enumitem: resume, resume*, series, start= and [resume] continue the numbers; itemize's label= is its bullet", () => {
  const resumed = shown(inDocument(String.raw`\begin{enumerate}
\item A
\item B
\end{enumerate}
Text.
\begin{enumerate}[resume]
\item C
\end{enumerate}`));
  assert.deepEqual(resumed.lines.filter((line) => /^\d/.test(line)), ["1.A", "2.B", "3.C"]);
  const series = shown(inDocument(String.raw`\begin{enumerate}[label=(\alph*), series=qs]
\item A
\item B
\end{enumerate}
\begin{enumerate}
\item X
\end{enumerate}
\begin{enumerate}[resume*=qs]
\item C
\end{enumerate}`));
  assert.ok(series.lines.includes("(c)C"), series.lines.join(" | "));
  assert.ok(series.lines.includes("1.X"));
  const started = shown(inDocument(String.raw`\begin{enumerate}[start=5]
\item E
\item F
\end{enumerate}`));
  assert.deepEqual(started.lines.filter((line) => /^\d/.test(line)), ["5.E", "6.F"]);
  const bullets = shown(inDocument(String.raw`\begin{itemize}[label=--]
\item A
\end{itemize}
\begin{itemize}[label=$\star$]
\item B
\end{itemize}`));
  assert.ok(bullets.lines.includes("–A"));
  assert.ok(bullets.lines.includes("⋆B"), bullets.lines.join(" | "));
});

test("a resumed list follows an item added to the list before it (numbering refresh, no rebuild)", () => {
  const doc = inDocument(String.raw`\begin{enumerate}
\item A
\end{enumerate}
\begin{enumerate}[resume]
\item C
\end{enumerate}`);
  withView(doc, (view) => {
    const items = () => [...view.contentDOM.querySelectorAll(".cm-vis-item")].map((node) => node.textContent);
    assert.deepEqual(items(), ["1.", "2."]);
    const at = view.state.doc.toString().indexOf("\\item A") + "\\item A".length;
    view.dispatch({ changes: { from: at, insert: "\n\\item B" } });
    for (let guard = 0; view.state.field(structuralField).pending.length && guard < 50; guard++) {
      const next = view.state.field(structuralField).pending[0];
      view.dispatch({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) });
    }
    renumber(view);
    assert.deepEqual(items(), ["1.", "2.", "3."]);
  });
});

test("\\setcounter{enumi} on a list's line is hidden and counts; a list in \\parbox or a minipage is drawn without its box's markup", () => {
  const counted = shown(inDocument(String.raw`\begin{enumerate}
\setcounter{enumi}{6} \item G
\item H
\end{enumerate}`));
  assert.ok(counted.lines.some((line) => /^\s*7\.G$/.test(line)), counted.lines.join(" | "));
  assert.doesNotMatch(counted.lines.join("\n"), /setcounter/);
  // A blank line between the boxes: each is a single box in the text. Without it they sit side by side and are drawn
  // as columns (the floats round's side-by-side boxes), their lists as list elements.
  const boxed = shown(inDocument(String.raw`\parbox{0.5\textwidth}{\begin{itemize}
\item A
\end{itemize}}

\begin{minipage}{0.4\textwidth}
\begin{enumerate}
\item X
\end{enumerate}
\end{minipage}`));
  assert.doesNotMatch(boxed.lines.join("\n"), /parbox|minipage|textwidth/);
  assert.ok(boxed.lines.includes("•A") && boxed.lines.includes("1.X"), boxed.lines.join(" | "));
});

test("counters printed in the text show their values; counter commands print nothing; IEEE's \\appendices letters sections", () => {
  const { lines } = shown(String.raw`\documentclass{article}
\newcounter{ex}
\begin{document}
\section{A}
\stepcounter{ex}\refstepcounter{ex}
Example \arabic{ex} and \theex, \alph{ex}, \Roman{ex}, \fnsymbol{ex}, \thesection.
\setcounter{ex}{7}\addtocounter{ex}{2} now \theex.
\end{document}
`);
  const text = lines.join("\n");
  assert.match(text, /Example 2 and 2, b, II, †, 1\./);
  assert.match(text, /now 9\./);
  assert.doesNotMatch(text, /stepcounter|setcounter|\\arabic|\\theex/);
  // An unknown counter stays as written.
  assert.match(shown(inDocument(String.raw`See \thething.`)).lines.join("\n"), /\\thething/);
  const ieee = shown(String.raw`\documentclass{IEEEtran}
\begin{document}
\section{One}
\appendices
\section{Proof}
See \thesection.
\end{document}
`).lines.join("\n");
  assert.match(ieee, /A\sProof/);
  assert.match(ieee, /See A\./);
  assert.doesNotMatch(ieee, /\\appendices/);
});

test("code: \\verb, \\lstinline and \\mintinline are inline code; verbatim, lstlisting and minted are code lines, edited in place", () => {
  const doc = inDocument(String.raw`Inline \verb|a%b\c{| and \lstinline{f(x)} and \mintinline{python}|x=1|.
\begin{verbatim}
a % b \c { --
\end{verbatim}
\begin{lstlisting}[language=Python, caption={Hello code}, label=lst:a]
def f(x): # hi
    return "s"
\end{lstlisting}
\begin{minted}{python}
x = 1
\end{minted}
\lstinputlisting[caption=File]{code.py}`);
  const { lines, html } = shown(doc);
  assert.equal(lines[0], "Inline a%b\\c{ and f(x) and x=1.");
  // The code is the document's own text: `--` and `%` stay as written, not drawn.
  assert.ok(lines.includes("a % b \\c { --"), lines.join(" | "));
  assert.ok(lines.includes("Listing 1: Hello code"));
  assert.ok(lines.includes("Listing 2: Filecode.py"), lines.join(" | "));
  assert.doesNotMatch(lines.join("\n"), /\\begin|\\end\{(?:verbatim|lstlisting|minted)/);
  assert.match(html, /cm-vis-code-line/);
  assert.match(html, /cm-vis-code-keyword">(?:<span[^>]*>)?def</);
  assert.match(html, /cm-vis-code-comment">(?:<span[^>]*>)?# hi/);
  // The code lines are text, not a widget: the cursor goes into them and typing edits the file.
  const state = visualState(doc);
  const at = doc.indexOf("return");
  assert.ok(!constructs(state).some((item) => { const [, from, to] = item.split(":"); return item.startsWith("code") && +from < at && at < +to && !item.startsWith("code-body"); }));
  // A listing whose options are not closed yet, or without its `\end`, stays source.
  const typing = shown(inDocument(String.raw`\begin{lstlisting}[caption={Hel
x
\end{lstlisting}`)).lines.join("\n");
  assert.match(typing, /\\begin\{lstlisting\}\[caption=\{Hel/);
  const unclosed = shown(inDocument(String.raw`Before \verb|abc and more.`)).lines.join("\n");
  assert.match(unclosed, /\\verb\|abc/);
});

test("a code block's source can be drawn whole (for a float): caption and coloured lines", () => {
  const block = readCodeBlock(String.raw`\begin{lstlisting}[language=C, caption={Main loop}]
int main() { return 0; } // done
\end{lstlisting}`);
  assert.ok(block);
  const element = renderCodeBlock(block!, (latex) => document.createTextNode(latex), "3");
  assert.equal(element.querySelector(".cm-vis-code-caption")?.textContent, "Listing 3: Main loop");
  assert.equal(element.querySelector("pre")?.textContent, "int main() { return 0; } // done");
  assert.equal(element.querySelector(".cm-vis-code-comment")?.textContent, "// done");
  assert.equal(readCodeBlock("\\begin{lstlisting}\nx\n"), null);
});

test("track changes and soul: added, deleted, replaced, highlights and comments are styled text, edited in place", () => {
  const doc = inDocument(String.raw`\added[id=R1]{new text} \deleted{old text} \replaced{new}{old} \highlight{hi} \comment[id=R1]{note}.
\hl{high} \st{strike} \ul{under} \so{spaced} \caps{caps} \fcolorbox{red}{yellow}{boxed}.`, "\\usepackage{changes}\\usepackage{soul}\n");
  const { lines, html } = shown(doc);
  assert.equal(lines[0], "new text old text new old hi note.");
  assert.equal(lines[1], "high strike under spaced caps boxed.");
  assert.match(html, /<span class="cm-vis-added">new text<\/span>/);
  assert.match(html, /<span class="cm-vis-deleted">old text<\/span>/);
  assert.match(html, /<span class="cm-vis-added">new<\/span>.*<span class="cm-vis-deleted">old<\/span>/);
  assert.match(html, /cm-vis-fbox" style="[^"]*border-color/);
  // The text inside is the file's text (a mark), not a widget: the cursor in it shows the markup to edit.
  const at = doc.indexOf("new text") + 3;
  withView(doc, (view) => assert.match(view.contentDOM.textContent ?? "", /\\added\[id=R1\]\{new text\}/), at);
  // A document's own \hl is its macro, not soul's.
  const own = shown(inDocument("\\hl{x}", "\\newcommand{\\hl}[1]{[#1]}\n")).lines.join("\n");
  assert.doesNotMatch(own, /cm-vis-hl/);
});

test("boxes, rules, space and symbols in running text are drawn; \\texorpdfstring draws its TeX in a caption", () => {
  const { lines, html } = shown(inDocument(String.raw`\fbox{box} \framebox[2cm]{fb} \makebox[3cm][c]{mb} \parbox{3cm}{pb text}.
A \rule{2cm}{0.4pt} bar, \hrulefill, \dotfill, a\hfill b \linebreak d \phantom{x}e\vphantom{z}f.
\texttimes \textpm \textonehalf \textsection \textcent \textminus \texteuro \textnumero \textcelsius \textperthousand \th \TH \dh \ng
\enquote{q} \nolinkurl{a_b} \path{c/d} said ${"`"}single' quotes. Note\footnotemark{} here. \marginpar{margin} \marginnote{mn}.`));
  assert.equal(lines[0], "box fb mb pb text.");
  assert.match(lines[1], /^A  bar, , , a\s+b ↵ d  ef\.$/);
  assert.match(html, /cm-vis-rule-bar/);
  assert.match(html, /cm-vis-hrulefill/);
  assert.equal(lines[2], "× ± ½ § ¢ − € № ℃ ‰ þ Þ ð ŋ");
  assert.equal(lines[3], "“q” a_b c/d said ‘single’ quotes. Note1 here. margin mn.");
  assert.match(html, /cm-vis-margin-note/);
  // An apostrophe alone stays as typed.
  assert.match(shown(inDocument("It's fine.")).lines[0], /It's fine\./);
  const defs = readLatexDefinitions("\\begin{document}\\end{document}");
  const div = document.createElement("div");
  div.append(renderLatexFragment(String.raw`The \texorpdfstring{$\ell_1$}{l1} norm, \added{new} \enquote{q} \textpm`, { defs, numbering: EMPTY_NUMBERING, aux: EMPTY_AUX, bib: () => null } as never));
  assert.doesNotMatch(div.textContent ?? "", /l1|texorpdfstring|added|enquote/);
  assert.match(div.textContent ?? "", /“q” ±$/);
});

test("\\tableofcontents, \\listoffigures and \\listoftables draw the lists they print, read-only", () => {
  const { lines } = shown(inDocument(String.raw`\tableofcontents
\listoffigures
\section{Intro}
\subsection[Short]{A long title}
\section*{Unnumbered}
\begin{figure}
\includegraphics{a.png}
\caption{A figure}
\end{figure}`));
  assert.equal(lines[0], "Contents1Intro1.1Short");
  assert.equal(lines[1], "List of Figures1A figure");
});

test("typed progressively: a list, theorem, quote or code block stays source until its \\end, and does not take the text after it", () => {
  for (const [open, close] of [["\\begin{itemize}\n\\item a", "\\end{itemize}"], ["\\begin{quote}\nQuoted", "\\end{quote}"], ["\\begin{center}\nMiddle", "\\end{center}"], ["\\begin{verbatim}\ncode", "\\end{verbatim}"]]) {
    const typing = shown(inDocument(`${open}\nText after.\n\\section{Next}`)).lines.join("\n");
    assert.match(typing, /\\begin\{/, open);
    // An unclosed verbatim takes the rest of the file as its text (as TeX does): all of it stays source.
    if (!open.includes("verbatim")) assert.match(typing, /1\sNext/, open);
    else assert.match(typing, /\\section\{Next\}/);
    const done = shown(inDocument(`${open}\n${close}\nText after.\n\\section{Next}`)).lines.join("\n");
    assert.doesNotMatch(done, /\\begin\{|\\end\{/, open);
    assert.match(done, /Text after\.\n1\sNext/, open);
  }
  // A stray \item outside a list stays source.
  assert.match(shown(inDocument("\\item stray\nText.")).lines.join("\n"), /\\item stray/);
  // A theorem without its \end stays source.
  const theorem = shown(inDocument("\\begin{theorem}\nClaim.\n\\section{Next}", "\\newtheorem{theorem}{Theorem}\n")).lines.join("\n");
  assert.match(theorem, /\\begin\{theorem\}/);
});
