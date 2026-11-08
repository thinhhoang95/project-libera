import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fc from "fast-check";
import { JSDOM } from "jsdom";
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  createPasteContext, markdownToLatex, parseHeadingTemplate, parseMarkdownPasteOptions, prepareHtmlPaste, convertPreparedMarkdown,
  readPreambleInfo, resolveChoices, scoreMarkdown, looksLikeMarkdown, headingMapFor, autoTopHeading, sectionBefore,
  DEFAULT_MARKDOWN_PASTE_OPTIONS, type LatexPasteContext,
} from "../../src/lib/latex/markdown-paste";
import { hasMarkdownSyntax, isRichClipboardHtml } from "../../src/lib/latex/markdown-paste/detect";
import { splitRawLatex, localImagePath, latexHtmlColor } from "../../src/lib/latex/markdown-paste/convert";
import { captionFromParagraph } from "../../src/lib/latex/markdown-paste/analyze";
import { pasteMathMarkers } from "../../src/lib/latex/markdown-paste/markers";
import { hasBalancedBraces, hasBalancedEnvironments, escapeLatexText, labelSlug, uniqueLabel, mathSymbolsToCommands } from "../../src/lib/latex/latex-text";
import { htmlToLatex } from "../../src/lib/latex/codemirror/visual/html2latex";
import {
  insertLatexAt, latexMarkdownPaste, latexPasteContextAt, listDepthAt, pasteIsInlineOnly, pasteStaysLiteral, preambleInsertPoint, replaceInsertedLatex, trackRange,
  type MarkdownPasteRequest,
} from "../../src/lib/latex/codemirror/markdown-paste";
import { pasteHtmlAsLatex } from "../../src/lib/latex/codemirror/visual/paste";
import { normalizePlacement } from "../../src/lib/latex/markdown-paste/options";
import { isSafeMathTex, isSafeRawLatex } from "../../src/lib/latex/latex-text";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualState } from "../../src/lib/latex/codemirror/visual";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

const article = (partial: Partial<LatexPasteContext> = {}) => createPasteContext({ documentClass: "article", ...partial });
const latex = (markdown: string, options = {}, context = article(), overrides = {}) => markdownToLatex(markdown, options, context, overrides).latex;
const packages = (map: Record<string, string[]>) => new Map(Object.entries(map));

/* ---- The plan's worked example ---------------------------------------------- */

test("the plan's example converts as documented", () => {
  const markdown = String.raw`## Results

We compare **three** models on *two* datasets [@smith2020, p. 4].

- Accuracy improves by 12%
- Latency drops:
  1. on CPU
  2. on GPU

| Model | Acc. | Notes        |
|:------|-----:|--------------|
| A     | 91.2 | baseline     |
| B_2   | 93.4 | uses ` + "`fp16`" + String.raw`  |

$$
E = mc^2
$$
`;
  const context = article({ sectionLevel: 2, sectionCommand: "section", sectionTitle: "Experiments" });
  const result = markdownToLatex(markdown, {}, context, { tables: [{ caption: "Model comparison", label: "" }] });
  assert.equal(result.latex, String.raw`\subsection{Results}

We compare \textbf{three} models on \emph{two} datasets \cite[p.~4]{smith2020}.

\begin{itemize}
  \item Accuracy improves by 12\%
  \item Latency drops:
  \begin{enumerate}
    \item on CPU
    \item on GPU
  \end{enumerate}
\end{itemize}

\begin{table}[htbp]
  \centering
  \caption{Model comparison}
  \label{tab:model-comparison}
  \begin{tabular}{lrl}
    \toprule
    Model & Acc. & Notes \\
    \midrule
    A & 91.2 & baseline \\
    B\_2 & 93.4 & uses \texttt{fp16} \\
    \bottomrule
  \end{tabular}
\end{table}

\[
E = mc^2
\]`);
  assert.deepEqual(result.missing.map((pkg) => pkg.line), ["\\usepackage{booktabs}"]);
  assert.equal(result.block, true);
});

/* ---- Detection --------------------------------------------------------------- */

test("Markdown is told apart from LaTeX and plain prose", () => {
  const markdown = [
    "# Title\n\nSome text.",
    "- one\n- two\n- three",
    "1. first\n2. second",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "```python\nprint(1)\n```",
    "Some **bold** text and a [link](https://example.com).",
    "- [ ] task\n- [x] done",
    "Text[^1]\n\n[^1]: note",
    "![alt](image.png)",
  ];
  for (const sample of markdown) assert.equal(looksLikeMarkdown(sample), true, sample);
  const other = [
    "Just a sentence of prose.",
    "Two paragraphs.\n\nOf plain prose, with $x^2$ math.",
    String.raw`\section{Intro}` + "\n" + String.raw`Some \textbf{bold} text.`,
    String.raw`\begin{itemize}` + "\n" + String.raw`\item one` + "\n" + String.raw`\item two` + "\n" + String.raw`\end{itemize}`,
    String.raw`a & b \\` + "\n" + String.raw`c & d \\`,
    "$a*b*c$ and $d*e$",
    "Only *one* emphasis.",
    "https://example.com",
  ];
  for (const sample of other) assert.equal(looksLikeMarkdown(sample), false, sample);
  // LaTeX that happens to contain a list-like line stays LaTeX.
  assert.equal(scoreMarkdown(String.raw`\begin{enumerate}` + "\n1. x\n2. y\n" + String.raw`\end{enumerate}` + "\n" + String.raw`\section{A}`).isMarkdown, false);
});

test("with rich HTML on the clipboard, only Markdown syntax wins over the HTML", () => {
  assert.equal(isRichClipboardHtml("<p><b>Bold</b></p>"), true);
  assert.equal(isRichClipboardHtml("<div style=\"color:#f00\"><span>code</span></div>"), false);
  // Word's plain text of a numbered list.
  assert.equal(looksLikeMarkdown("1. First\n2. Second", { richHtml: true }), false);
  assert.equal(looksLikeMarkdown("## Heading\n\n1. First\n2. Second", { richHtml: true }), true);
  assert.equal(hasMarkdownSyntax("| a |\n|---|"), true);
});

/* ---- Headings ---------------------------------------------------------------- */

test("heading levels map by rank from the section at the cursor", () => {
  const markdown = "## A\n\n#### B\n\n##### C";
  assert.equal(latex(markdown, {}, article({ sectionLevel: 2 })), "\\subsection{A}\n\n\\subsubsection{B}\n\n\\paragraph{C}");
  assert.equal(latex(markdown, {}, article()), "\\section{A}\n\n\\subsection{B}\n\n\\subsubsection{C}");
  assert.equal(latex(markdown, {}, createPasteContext({ documentClass: "book" })), "\\chapter{A}\n\n\\section{B}\n\n\\subsection{C}");
  // Past \subparagraph: bold paragraphs.
  assert.equal(latex("# a\n## b\n### c", { headingTop: "paragraph" }), "\\paragraph{a}\n\n\\subparagraph{b}\n\n\\textbf{c}");
  // \chapter does not exist in article: the ladder skips it.
  assert.deepEqual(headingMapFor("part", 3, article()), ["part", "section", "subsection"]);
  assert.deepEqual(headingMapFor("chapter", 2, article()), ["section", "subsection"]);
  assert.equal(autoTopHeading(article({ sectionLevel: 6 })), "subparagraph");
});

test("custom headings, starred headings, labels and manual numbers", () => {
  assert.equal(latex("## A\n### B", { headingTop: "custom", headingCustom: "\\frametitle" }), "\\frametitle{A}\n\n\\subsection{B}");
  assert.equal(latex("## A", { headingTop: "custom", headingCustom: String.raw`\textbf{\large #1}\par` }), String.raw`\textbf{\large A}\par`);
  // An invalid template falls back to bold, with a warning.
  const invalid = markdownToLatex("## A", { headingTop: "custom", headingCustom: String.raw`\input{#1}` });
  assert.equal(invalid.latex, "\\textbf{A}");
  assert.equal(invalid.warnings[0].code, "heading-template");
  assert.equal(latex("# A\n## B", { headingStarred: true, headingLabels: true }), "\\section*{A}\n\n\\subsection*{B}");
  assert.equal(latex("# Intro\n## Data set", { headingLabels: true }, article({ labels: new Set(["sec:intro"]) })), "\\section{Intro}\\label{sec:intro-2}\n\n\\subsection{Data set}\\label{sec:data-set}");
  // Links to a pasted heading turn labels on and become \hyperref.
  assert.equal(latex("# Methods\n\nSee [the methods](#methods)."), "\\section{Methods}\\label{sec:methods}\n\nSee \\hyperref[sec:methods]{the methods}.");
  assert.equal(latex("# 1. Intro\n\n## 1.1 Scope\n\n# 2. Methods"), "\\section{Intro}\n\n\\subsection{Scope}\n\n\\section{Methods}");
  assert.equal(latex("# 1. Intro\n\n# 2. Methods", { stripHeadingNumbers: false }), "\\section{1. Intro}\n\n\\section{2. Methods}");
  // A year is not a heading number.
  assert.equal(latex("# 2024 Results"), "\\section{2024 Results}");
  // Headings inside lists and quotes cannot be sections.
  assert.equal(latex("- # Item heading"), "\\begin{itemize}\n  \\item \\textbf{Item heading}\n\\end{itemize}");
  assert.deepEqual(parseHeadingTemplate(String.raw`\section*`), { template: String.raw`\section*{#1}` });
  assert.ok("error" in parseHeadingTemplate(String.raw`\begin{frame}{#1}`));
  assert.ok("error" in parseHeadingTemplate("#1 and #1"));
  assert.ok("error" in parseHeadingTemplate(String.raw`\textbf{#1`));
});

test("the section before the cursor is found, comments skipped", () => {
  const text = String.raw`\section{Intro} text % \subsection{Not this}` + "\n" + String.raw`\subsection*[short]{The \emph{data}}` + "\n";
  assert.deepEqual(sectionBefore(text, text.length), { level: 3, command: "subsection", title: String.raw`The \emph{data}` });
  assert.equal(sectionBefore("no headings", 5), null);
});

/* ---- Lists, quotes, code ------------------------------------------------------- */

test("lists: nesting, starts, tasks, brackets and the depth limit", () => {
  assert.equal(latex("3. three\n4. four"), "\\begin{enumerate}\n  \\setcounter{enumi}{2}\n  \\item three\n  \\item four\n\\end{enumerate}");
  assert.equal(latex("3. three", {}, article({ packages: packages({ enumitem: [] }) })), "\\begin{enumerate}[start=3]\n  \\item three\n\\end{enumerate}");
  assert.equal(latex("- [ ] a\n- [x] b"), "\\begin{itemize}\n  \\item[{[\\,]}] a\n  \\item[{[x]}] b\n\\end{itemize}");
  assert.equal(latex("- [ ] a\n- [x] b", {}, article({ packages: packages({ amssymb: [] }) })), "\\begin{itemize}\n  \\item[$\\square$] a\n  \\item[$\\boxtimes$] b\n\\end{itemize}");
  assert.equal(latex("- [see] this"), "\\begin{itemize}\n  \\item{} [see] this\n\\end{itemize}");
  const deep = markdownToLatex("- 1\n  - 2\n    - 3\n      - 4\n        - 5");
  assert.equal((deep.latex.match(/\\begin\{itemize\}/g) ?? []).length, 4);
  assert.equal(deep.warnings[0].code, "deep-list");
  assert.ok(hasBalancedEnvironments(deep.latex));
});

test("quotes, alerts and Libera boxes", () => {
  assert.equal(latex("> Quoted\n> text"), "\\begin{quote}\n  Quoted\n  text\n\\end{quote}");
  assert.equal(latex("> [!WARNING]\n> Careful."), "\\begin{quote}\n  \\textbf{Warning.} Careful.\n\\end{quote}");
  assert.equal(latex("> [!NOTE] Read me\n> Body."), "\\begin{quote}\n  \\textbf{Read me.} Body.\n\\end{quote}");
  assert.equal(latex("b> Blue box", {}, article({ packages: packages({ tcolorbox: [] }) })), "\\begin{tcolorbox}[colback=blue!6!white,colframe=blue!55!black]\n  Blue box\n\\end{tcolorbox}");
  const displayquote = markdownToLatex("> q", { blockquote: "displayquote" });
  assert.equal(displayquote.latex, "\\begin{displayquote}\n  q\n\\end{displayquote}");
  assert.deepEqual(displayquote.missing.map((pkg) => pkg.name), ["csquotes"]);
  // Horizontal rules are always dropped.
  assert.equal(latex("A\n\n---\n\nB\n\n***\n\nC"), "A\n\nB\n\nC");
});

test("code blocks and inline code", () => {
  assert.equal(latex("```\na_b {c}\n```"), "\\begin{verbatim}\na_b {c}\n\\end{verbatim}");
  const safe = "escapechar={},escapeinside={},mathescape=false,texcl=false";
  assert.equal(latex("```python\nx = 1\n```", { codeBlocks: "lstlisting" }), `\\begin{lstlisting}[language=Python,${safe}]\nx = 1\n\\end{lstlisting}`);
  assert.equal(latex("```csharp\nx\n```", { codeBlocks: "lstlisting" }), `\\begin{lstlisting}[language={[Sharp]C},${safe}]\nx\n\\end{lstlisting}`);
  // Names on Object.prototype are not languages.
  assert.equal(latex("```constructor\nx\n```", { codeBlocks: "lstlisting" }), `\\begin{lstlisting}[${safe}]\nx\n\\end{lstlisting}`);
  assert.equal(latex("```__proto__\nx\n```", { codeBlocks: "lstlisting" }), `\\begin{lstlisting}[${safe}]\nx\n\\end{lstlisting}`);
  // Code that would close the verbatim block early is written as escaped lines.
  assert.equal(latex("```\na\n\\end{verbatim}\n```"), "\\texttt{a}\\\\\n\\texttt{\\textbackslash{}end\\{verbatim\\}}");
  assert.equal(latex("Use `a_b & {c}` here."), "Use \\texttt{a\\_b \\& \\{c\\}} here.");
  assert.equal(latex("Use `a|b` and `x`.", { inlineCode: "verb" }), "Use \\verb!a|b! and \\verb|x|.");
  // Blank lines inside code are kept.
  assert.equal(latex("```\na\n\n\n\nb\n```"), "\\begin{verbatim}\na\n\n\n\nb\n\\end{verbatim}");
  const diagram = markdownToLatex("```mermaid\ngraph TD\n```");
  assert.equal(diagram.latex, "% Diagram (mermaid)\n\\begin{verbatim}\ngraph TD\n\\end{verbatim}");
  assert.equal(diagram.warnings[0].code, "diagram");
});

/* ---- Math ---------------------------------------------------------------------- */

test("math: delimiters, environments, multi-line formulas and safety", () => {
  assert.equal(latex(String.raw`Inline \(x^2\) and $y$ and $$z$$ in text.`), "Inline $x^2$ and $y$ and $z$ in text.");
  assert.equal(latex(String.raw`$x$`, { inlineMath: "paren" }), String.raw`\(x\)`);
  assert.equal(latex("$$\nE = mc^2\n$$"), "\\[\nE = mc^2\n\\]");
  assert.equal(latex("\\[\na + b\n\\]"), "\\[\na + b\n\\]");
  assert.equal(latex("$$x$$"), "\\[\nx\n\\]");
  assert.equal(latex("$$\nx\n$$", { displayMath: "equation" }), "\\begin{equation}\nx\n\\end{equation}");
  const star = markdownToLatex("$$\nx\n$$", { displayMath: "equation*" });
  assert.equal(star.latex, "\\begin{equation*}\nx\n\\end{equation*}");
  assert.deepEqual(star.missing.map((pkg) => pkg.name), ["amsmath"]);
  // A display environment written inside $$ is written as itself.
  assert.equal(latex("$$\n\\begin{align}\nx &= 1 \\\\\ny &= 2\n\\end{align}\n$$"), "\\begin{align}\nx &= 1 \\\\\ny &= 2\n\\end{align}");
  // Rows without an environment: align* with &, gather* without.
  assert.equal(latex("$$\na &= b \\\\\nc &= d\n$$"), "\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}");
  assert.equal(latex("$$\na = b \\\\\nc = d\n$$"), "\\begin{gather*}\na = b \\\\\nc = d\n\\end{gather*}");
  // aligned inside stays inside \[ \].
  assert.equal(latex("$$\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n$$"), "\\[\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n\\]");
  // Unsafe TeX is pasted as text.
  const unsafe = markdownToLatex(String.raw`Math $\input{secret}$ here.`);
  assert.equal(unsafe.latex, String.raw`Math \textbackslash{}input\{secret\} here.`);
  assert.equal(unsafe.warnings[0].code, "unsafe-math");
  // Unicode in formulas under pdfLaTeX, kept under XeLaTeX.
  assert.equal(latex("$α ≤ ℝ$"), "$\\alpha \\le \\mathbb{R}$");
  assert.equal(latex("$α$", {}, article({ engine: "xelatex" })), "$α$");
  assert.equal(mathSymbolsToCommands("αx"), "\\alpha x");
  assert.deepEqual(markdownToLatex("$\\mathbb{R}$").missing.map((pkg) => pkg.name), ["amsfonts"]);
  assert.deepEqual(markdownToLatex("$\\text{x}$", {}, article({ packages: packages({ mathtools: [], amsmath: [] }) })).missing, []);
});

test("math is read with the user's markers (Preferences → Markdown) and the common conventions", () => {
  const custom = { inlineMathMarkers: "@@ @@", blockMathMarkers: "%% %%" };
  const convert = (markdown: string) => markdownToLatex(markdown, {}, article(), {}, custom).latex;
  assert.equal(convert("Area @@\\pi r^2@@ and $x$ and \\(y\\)."), "Area $\\pi r^2$ and $x$ and $y$.");
  assert.equal(convert("%%\nE = mc^2\n%%"), "\\[\nE = mc^2\n\\]");
  assert.equal(convert("\\[\na\n\\]\n\n$$\nb\n$$"), "\\[\na\n\\]\n\n\\[\nb\n\\]");
  assert.deepEqual(pasteMathMarkers(custom), { inlineMathMarkers: "@@ @@\n$ $\n$$ $$\n\\( \\)", blockMathMarkers: "%% %%\n\\[ \\]\n$$ $$" });
  // The user's own pair keeps its meaning: `$$` configured as display only is not also inline.
  assert.deepEqual(pasteMathMarkers({ inlineMathMarkers: "$ $", blockMathMarkers: "$$ $$" }), { inlineMathMarkers: "$ $\n$$ $$\n\\( \\)", blockMathMarkers: "$$ $$\n\\[ \\]" });
  // Detection leaves formulas written with the user's markers out of the LaTeX score.
  assert.equal(scoreMarkdown("- a @@\\begin{matrix}1\\end{matrix}@@\n- b @@\\section{x}@@", custom).isMarkdown, true);
});

/* ---- Tables -------------------------------------------------------------------- */

const TABLE = "| Name | Value |\n|:--|--:|\n| a | 1 |\n| b | 2 |";

test("tables: rules, floats, captions and labels", () => {
  assert.equal(latex(TABLE, { tableFloat: "none", tableRules: "simple" }), "\\begin{tabular}{lr}\n  \\hline\n  Name & Value \\\\\n  \\hline\n  a & 1 \\\\\n  b & 2 \\\\\n  \\hline\n\\end{tabular}");
  assert.equal(latex(TABLE, { tableFloat: "none", tableRules: "grid" }), "\\begin{tabular}{|l|r|}\n  \\hline\n  Name & Value \\\\\n  \\hline\n  a & 1 \\\\\n  \\hline\n  b & 2 \\\\\n  \\hline\n\\end{tabular}");
  assert.equal(latex(TABLE, { tableFloat: "none", tableRules: "none", tableBoldHeader: true }), "\\begin{tabular}{lr}\n  \\textbf{Name} & \\textbf{Value} \\\\\n  a & 1 \\\\\n  b & 2 \\\\\n\\end{tabular}");
  const floated = latex(TABLE, { tablePlacement: "H", tableCaptionBelow: true, tableSize: "small" }, article({ labels: new Set(["tab:values"]) }), { tables: [{ caption: "Values", label: "" }] });
  assert.equal(floated, "\\begin{table}[H]\n  \\centering\n  \\small\n  \\begin{tabular}{lr}\n    \\toprule\n    Name & Value \\\\\n    \\midrule\n    a & 1 \\\\\n    b & 2 \\\\\n    \\bottomrule\n  \\end{tabular}\n  \\caption{Values}\n  \\label{tab:values-2}\n\\end{table}");
  assert.deepEqual(markdownToLatex(TABLE, { tablePlacement: "H" }).missing.map((pkg) => pkg.name).sort(), ["booktabs", "float"]);
  // A caption paragraph next to the table becomes its caption.
  const captioned = markdownToLatex(`**Table 2:** Results by *model*\n\n${TABLE}`);
  assert.match(captioned.latex, /^\\begin\{table\}\[htbp\]\n {2}\\centering\n {2}\\caption\{Results by \\emph\{model\}\}\n {2}\\label\{tab:results-by-model\}/);
  assert.equal(captioned.analysis.tables[0].caption, "Results by *model*");
  // Without a float the caption paragraph stays in the text.
  assert.match(latex(`Table 1: Kept\n\n${TABLE}`, { tableFloat: "none" }), /^Table 1: Kept\n\n\\begin\{tabular\}/);
  assert.equal(captionFromParagraph("*Table 3. Wrapped*"), "Wrapped");
  assert.equal(captionFromParagraph("Tables are nice"), null);
  // A typed label is used as written.
  assert.match(latex(TABLE, {}, article(), { tables: [{ caption: "C", label: "tab:mine" }] }), /\\label\{tab:mine\}/);
});

test("tables: tabularx, longtable, wrapping and footnotes in cells", () => {
  const long = `| Name | Description |\n|---|---|\n| A | ${"word ".repeat(20).trim()} |`;
  const tabularx = markdownToLatex(long, { tableEnvironment: "tabularx", tableFloat: "none" });
  assert.match(tabularx.latex, /^\\begin\{tabularx\}\{\\linewidth\}\{l>\{\\raggedright\\arraybackslash\}X\}/);
  assert.deepEqual(tabularx.missing.map((pkg) => pkg.name).sort(), ["booktabs", "tabularx"]);
  const wrapped = markdownToLatex(long, { tableFloat: "none" });
  assert.match(wrapped.latex, /\{l>\{\\raggedright\\arraybackslash\}p\{0\.\d+\\linewidth\}\}/);
  assert.equal(latex(long, { tableFloat: "none", tableWrap: false }).split("\n")[0], "\\begin{tabular}{ll}");
  const longtable = latex(TABLE, { tableEnvironment: "longtable" }, article(), { tables: [{ caption: "Long", label: "" }] });
  assert.equal(longtable, [
    "\\begin{longtable}{lr}",
    "  \\caption{Long}\\label{tab:long}\\\\",
    "  \\toprule", "  Name & Value \\\\", "  \\midrule", "  \\endfirsthead",
    "  \\toprule", "  Name & Value \\\\", "  \\midrule", "  \\endhead",
    "  \\bottomrule", "  \\endlastfoot",
    "  a & 1 \\\\", "  b & 2 \\\\",
    "\\end{longtable}",
  ].join("\n"));
  // <br> in a cell makes the column wrap.
  assert.match(latex("| a |\n|---|\n| x<br>y |", { tableFloat: "none" }), /p\{0\.\d+\\linewidth\}\}[\s\S]*x\\newline y/);
  const footnote = latex("| a |\n|---|\n| x[^n] |\n\n[^n]: Note.", { tableFloat: "table" });
  assert.match(footnote, /x\\footnotemark \\\\[\s\S]*\\end\{table\}\n\\footnotetext\{Note\.\}$/);
});

/* ---- Links, images, footnotes, citations ------------------------------------------ */

test("links and footnotes", () => {
  assert.equal(latex("[paper](https://x.org/a?b=1&c=2#s)"), "\\href{https://x.org/a?b=1&c=2\\#s}{paper}");
  assert.equal(latex("<https://x.org>"), "\\url{https://x.org}");
  assert.equal(latex("See https://x.org/a_b now."), "See \\url{https://x.org/a_b} now.");
  assert.equal(latex("[paper](https://x.org)", { links: "footnote" }), "paper\\footnote{\\url{https://x.org}}");
  assert.equal(latex("[paper](https://x.org)", { links: "text" }), "paper");
  assert.equal(latex("[note](other-note.md)"), "note");
  assert.equal(latex("[ref][1]\n\n[1]: https://x.org"), "\\href{https://x.org}{ref}");
  // A URL cannot leave its argument.
  assert.equal(latex("[t](https://x.org/a}\\input{x})"), "\\href{https://x.org/a\\%7D\\%5Cinput\\%7Bx\\%7D}{t}");
  assert.deepEqual(markdownToLatex("<https://x.org>", {}, article({ packages: packages({ hyperref: [], url: [] }) })).missing, []);
  assert.equal(latex("A[^a] and B[^a].\n\n[^a]: The *note*."), "A\\footnote{\\label{fn:a}The \\emph{note}.} and B\\footnotemark[\\ref{fn:a}].");
  assert.equal(latex("# Title[^a]\n\n[^a]: N."), "\\section{Title\\protect\\footnote{N.}}");
  assert.equal(markdownToLatex("Text.\n\n[^x]: Unused.").warnings[0].code, "unreferenced-footnote");
});

test("images become figures, with paths the document can use", () => {
  assert.equal(latex("![A cat](img/cat.png \"Cat\")"), "\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.75\\linewidth]{img/cat.png}\n  \\caption{Cat}\n  \\label{fig:cat}\n\\end{figure}");
  assert.equal(latex("![](img/a.png)", { images: "inline", imageWidth: 1 }), "\\includegraphics[width=\\linewidth]{img/a.png}");
  assert.equal(latex("![A](img/a.png)", { images: "comment" }), "% Image: img/a.png (A)");
  const remote = markdownToLatex("![Plot](https://x.org/p.png)");
  assert.equal(remote.latex, "% Image not in the project: https://x.org/p.png\nPlot");
  assert.equal(remote.warnings[0].code, "remote-image");
  assert.deepEqual(localImagePath("/api/files/raw/notes/figs/My%20Plot.png", "paper/tex"), { path: "../../notes/figs/My Plot.png" });
  assert.deepEqual(localImagePath("/api/files/raw/paper/figs/a.png", "paper"), { path: "figs/a.png" });
  assert.equal(localImagePath("/etc/passwd", ""), null);
  assert.equal(localImagePath("a{b}.png", ""), null);
  assert.equal(localImagePath("data:image/png;base64,AAAA", ""), null);
  const missing = markdownToLatex("![x](a.png)", {}, article({ files: new Set(["b.png"]) }));
  assert.equal(missing.warnings[0].code, "missing-image");
  assert.equal(markdownToLatex("![x](a.svg)").warnings[0].code, "image-format");
  assert.equal(latex("Icon ![i](i.png) here."), "Icon \\includegraphics[height=1em]{i.png} here.");
});

test("citations follow the bibliography package", () => {
  const md = "[see @a, p. 3; @b] and [@a; @b] and [-@a]";
  assert.equal(latex(md), "see~\\cite[p.~3]{a}; \\cite{b} and \\cite{a,b} and \\cite{a}");
  assert.equal(latex(md, {}, article({ packages: packages({ natbib: [] }) })), "\\citep[see][p.~3]{a}; \\citep{b} and \\citep{a,b} and \\citeyearpar{a}");
  assert.equal(latex(md, {}, article({ packages: packages({ biblatex: [] }) })), "\\parencites[see][p.~3]{a}{b} and \\parencite{a,b} and \\parencite*{a}");
  // A narrative @word is a citation only when the bibliography knows it.
  assert.equal(latex("Ask @alice or @smith2020.", {}, article({ bibKeys: new Set(["smith2020"]), packages: packages({ biblatex: [] }) })), "Ask @alice or \\textcite{smith2020}.");
  assert.equal(latex("Ask @alice."), "Ask @alice.");
  assert.equal(markdownToLatex("[@zz]", {}, article({ bibKeys: new Set(["a"]) })).warnings[0].code, "cite-keys");
});

/* ---- Text --------------------------------------------------------------------------- */

test("text: escaping, quotes, emoji, scripts, LaTeX written in the text", () => {
  assert.equal(latex("Costs $5 & 10% off #1 a_b {x} ~ ^"), "Costs \\$5 \\& 10\\% off \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{}");
  assert.equal(latex("a < b | c > d"), "a \\textless{} b \\textbar{} c \\textgreater{} d");
  assert.equal(latex("a < b", {}, article({ packages: packages({ fontenc: ["T1"] }) })), "a < b");
  assert.equal(latex(`He said "hi" and 'yes'.`), "He said ``hi'' and `yes'.");
  assert.equal(latex(`He said "hi".`, { quotes: "keep" }), `He said "hi".`);
  const csquotes = markdownToLatex(`He said "hi".`, { quotes: "csquotes" });
  assert.equal(csquotes.latex, "He said \\enquote{hi}.");
  const emoji = markdownToLatex("Done 🎉 now");
  assert.equal(emoji.latex, "Done  now");
  assert.equal(emoji.warnings[0].code, "emoji");
  assert.equal(latex("Done 🎉", {}, article({ engine: "lualatex" })), "Done 🎉");
  assert.equal(markdownToLatex("Привет").warnings[0].code, "script");
  assert.equal(latex(String.raw`See \ref{fig:a}, \cite[p.~2]{b} and \newpage.`), String.raw`See \ref{fig:a}, \cite[p.~2]{b} and \newpage.`);
  assert.equal(latex(String.raw`Path C:\Users\me, \alpha, \input{x}, \write18{rm}.`), String.raw`Path C:\textbackslash{}Users\textbackslash{}me, \textbackslash{}alpha, \textbackslash{}input\{x\}, \textbackslash{}write18\{rm\}.`);
  assert.equal(latex(String.raw`See \ref{x}.`, { keepLatex: false }), String.raw`See \textbackslash{}ref\{x\}.`);
  assert.deepEqual(splitRawLatex(String.raw`a \begin{center}x\end{center} b`), [{ raw: false, text: "a " }, { raw: true, text: String.raw`\begin{center}x\end{center}` }, { raw: false, text: " b" }]);
  assert.equal(latex("**bold *both*** and ~~gone~~", { italic: "textit" }), "\\textbf{bold \\textit{both}} and \\sout{gone}");
  assert.equal(latex("line one  \nline two\\\n[bracket]"), "line one\\\\\nline two\\\\{}\n[bracket]");
  assert.equal(latex("H<sub>2</sub>O, x<sup>2</sup>, <kbd>Ctrl</kbd>, <!-- hidden -->ok"), "H\\textsubscript{2}O, x\\textsuperscript{2}, \\texttt{Ctrl}, ok");
});

test("Libera's own Markdown: highlights, colors, underlines, macros", () => {
  const result = markdownToLatex("A >>>mark<<< and [color=#25e]blue[/color] and <u>under</u>.");
  assert.equal(result.latex, "A \\hl{mark} and \\textcolor[HTML]{2255EE}{blue} and \\underline{under}.");
  assert.deepEqual(result.missing.map((pkg) => pkg.name), ["soul", "xcolor"]);
  assert.equal(latex("A >>>mark<<<", { highlight: "drop" }), "A mark");
  assert.equal(latexHtmlColor("#2563ebcc"), "2563EB");
  assert.equal(latex("```libera-macro\n\\fset = $\\mathcal{F}$\n```\n\nThe set $\\fset$ here."), "The set $\\mathcal{F}$ here.");
});

test("inside an argument or a table, blocks are flattened to one line", () => {
  const context = article({ inlineOnly: true });
  assert.equal(latex("# Title\n\n- a\n- b\n\n$$x$$", {}, context), "\\textbf{Title} a; b $x$");
  assert.equal(markdownToLatex("# T", {}, context).block, false);
});

test("the result says whether it is block content", () => {
  assert.equal(markdownToLatex("Just **bold**.").block, false);
  assert.equal(markdownToLatex("One.\n\nTwo.").block, true);
  assert.equal(markdownToLatex("- a").block, true);
});

/* ---- Context, options, helpers ---------------------------------------------------------- */

test("the preamble's class and packages are read, with what they imply", () => {
  const info = readPreambleInfo([String.raw`\documentclass[11pt,twocolumn]{report}` + "\n" + String.raw`\usepackage[T1]{fontenc}` + "\n" + String.raw`\usepackage{tabularx, hyperref} % \usepackage{soul}` + "\n" + String.raw`\begin{document}\usepackage{late}`]);
  assert.equal(info.documentClass, "report");
  assert.deepEqual(info.classOptions, ["11pt", "twocolumn"]);
  assert.deepEqual([...info.packages.keys()].sort(), ["array", "fontenc", "hyperref", "tabularx", "url"]);
  assert.deepEqual(info.packages.get("fontenc"), ["T1"]);
});

test("saved options are validated, with defaults for anything missing or wrong", () => {
  assert.deepEqual(parseMarkdownPasteOptions(null), DEFAULT_MARKDOWN_PASTE_OPTIONS);
  const parsed = parseMarkdownPasteOptions({ italic: "textit", tableEnvironment: "nonsense", tablePlacement: "pbhxx!", imageWidth: 3, keepLatex: "yes", headingCustom: "\\frametitle" });
  assert.equal(parsed.italic, "textit");
  assert.equal(parsed.tableEnvironment, "tabular");
  assert.equal(parsed.tablePlacement, "hbp!");
  assert.equal(parsed.imageWidth, 0.75);
  assert.equal(parsed.keepLatex, true);
  assert.equal(parsed.headingCustom, "\\frametitle");
  assert.equal(DEFAULT_MARKDOWN_PASTE_OPTIONS.italic, "emph");
  assert.equal(DEFAULT_MARKDOWN_PASTE_OPTIONS.ask, "structure");
});

test("choices: captions found in the text only when asked, labels on for internal links", () => {
  const prepared = markdownToLatex(`Table 1: Found\n\n${TABLE}\n\n# A\n\n[a](#a)`);
  const choices = resolveChoices({ ...DEFAULT_MARKDOWN_PASTE_OPTIONS, tableCaptionFromText: false }, prepared.analysis, article());
  assert.equal(choices.tables[0].caption, "");
  assert.equal(choices.headingLabels, true);
  assert.equal(prepared.analysis.structural, true);
});

test("labels and escaping helpers", () => {
  assert.equal(labelSlug("Résumé of the Data!"), "resume-of-the-data");
  assert.equal(labelSlug("!!!", "table"), "table");
  const taken = new Set(["a"]);
  assert.equal(uniqueLabel("a", taken), "a-2");
  assert.equal(uniqueLabel("a", taken), "a-3");
  // html2latex's escaping is unchanged by the move to latex-text.ts.
  assert.equal(escapeLatexText("α ≤ β and “q” – x"), "$\\alpha \\le \\beta$ and ``q'' -- x");
});

/* ---- Clipboard HTML ---------------------------------------------------------------------- */

test("clipboard HTML converts with the same choices as Markdown", () => {
  const convert = (html: string, options = {}) => {
    const prepared = prepareHtmlPaste(html);
    assert.ok(prepared);
    return convertPreparedMarkdown(prepared, resolveChoices({ ...DEFAULT_MARKDOWN_PASTE_OPTIONS, ...options }, prepared.analysis, article()), article());
  };
  assert.equal(convert("<h1>Title</h1><p>Some <b>bold</b>, <i>italic</i> and <a href=\"https://x.org\">a link</a>.</p><p>Second</p>").latex,
    "\\section{Title}\n\nSome \\textbf{bold}, \\emph{italic} and \\href{https://x.org}{a link}.\n\nSecond");
  assert.equal(convert("<h2>T</h2>", { headingTop: "subsubsection" }).latex, "\\subsubsection{T}");
  assert.equal(convert("<ul><li>One</li><li>Two<ol><li>Nested</li></ol></li></ul>").latex,
    "\\begin{itemize}\n  \\item One\n  \\item Two\n  \\begin{enumerate}\n    \\item Nested\n  \\end{enumerate}\n\\end{itemize}");
  assert.equal(convert("<table><tr><th>A</th><th>B</th></tr><tr><td colspan=\"2\">wide</td></tr><tr><td>1</td><td>2%</td></tr></table>", { tableFloat: "none" }).latex,
    "\\begin{tabular}{ll}\n  \\toprule\n  A & B \\\\\n  \\midrule\n  \\multicolumn{2}{l}{wide} \\\\\n  1 & 2\\% \\\\\n  \\bottomrule\n\\end{tabular}");
  // A table without header cells has no header row.
  assert.equal(convert("<table><tr><td>1</td><td>2</td></tr></table>", { tableFloat: "none" }).latex, "\\begin{tabular}{ll}\n  \\toprule\n  1 & 2 \\\\\n  \\bottomrule\n\\end{tabular}");
  assert.equal(convert("<b style=\"font-weight:normal;\" id=\"docs-internal-guid\"><span style=\"font-weight:700\">Bold</span> <span style=\"font-style:italic\">it</span></b>").latex, "\\textbf{Bold} \\emph{it}");
  assert.equal(convert("<p>See <math><semantics><mi>x</mi><annotation encoding=\"application/x-tex\">x^2</annotation></semantics></math>.</p>").latex, "See $x^2$.");
  assert.equal(convert("<pre><code class=\"language-python\">a_b {c}</code></pre>").latex, "\\begin{verbatim}\na_b {c}\n\\end{verbatim}");
  assert.equal(convert("<p>H<sub>2</sub>O</p><hr><p>x</p>").latex, "H\\textsubscript{2}O\n\nx");
  assert.equal(prepareHtmlPaste("<div><span style=\"color:#f00\">\\textbf{x}</span></div>"), null);
  const word = convert("<p><img src=\"file:///C:/Users/x/AppData/image001.png\" alt=\"Chart\"></p>");
  assert.equal(word.latex, "% Image not in the project: file:///C:/Users/x/AppData/image001.png\nChart");
  // The old converter keeps working for anything that still uses it.
  assert.equal(htmlToLatex("<p><b>x</b></p>"), "\\textbf{x}");
});

/* ---- Properties -------------------------------------------------------------------------- */

test("property: any Markdown converts without throwing, balanced, and flat when inline only", () => {
  const piece = fc.constantFrom(
    "# H", "## H2", "text", "**b**", "*i*", "`c`", "$x$", "[l](https://x.org)", "- item", "1. one", "> q", "| a | b |\n|---|---|\n| 1 | 2 |",
    "$$\nx\n$$", "[@k]", "[^1]", "\n[^1]: note", "&", "%", "#", "_", "{", "}", "~", "^", "\\", "\"", "'", "<br>", "<sup>s</sup>", "---", "\n", "\n\n", " ",
    "- [ ] t", ">>>h<<<", "![a](b.png)", "\\ref{x}", "\\begin{center}x\\end{center}", "y> box", "> [!NOTE]",
  );
  fc.assert(fc.property(fc.array(piece, { maxLength: 24 }), (pieces) => {
    const markdown = pieces.join("");
    const block = markdownToLatex(markdown);
    assert.ok(hasBalancedBraces(block.latex.replace(/\\begin\{verbatim\}[\s\S]*?\\end\{verbatim\}/g, "")), `${JSON.stringify(markdown)} → ${block.latex}`);
    assert.ok(hasBalancedEnvironments(block.latex), `${JSON.stringify(markdown)} → ${block.latex}`);
    const inline = markdownToLatex(markdown, {}, article({ inlineOnly: true }));
    assert.ok(!/\n/.test(inline.latex), `${JSON.stringify(markdown)} → ${inline.latex}`);
    assert.ok(!/\\begin\{(?:itemize|enumerate|table|tabular|figure|verbatim)/.test(inline.latex));
  }), { numRuns: 300 });
});

/* ---- The editor ---------------------------------------------------------------------------- */

const DOC = String.raw`\documentclass{article}
\usepackage{booktabs}
\begin{document}
\section{Intro}
Text $x$ here.
\end{document}`;

function mount(doc: string, onRequest: (request: MarkdownPasteRequest) => void, options: { detect?: boolean; visual?: boolean } = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const state = EditorState.create({
    doc,
    extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexMarkdownPaste(() => ({ onRequest, detect: () => options.detect ?? true, visual: () => options.visual ?? false }))],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return new EditorView({ state, parent });
}

function paste(view: EditorView, data: Record<string, string>) {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => data[type] ?? "" } });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

test("the paste handler takes Markdown and leaves LaTeX, math, the preamble and plain pastes alone", () => {
  const requests: MarkdownPasteRequest[] = [];
  const taken = (view: EditorView, data: Record<string, string>) => {
    const before = requests.length;
    paste(view, data);
    return requests.length > before;
  };
  const MARKDOWN = { "text/plain": "# Heading\n\n- a\n- b" };
  const view = mount(DOC, (request) => requests.push(request));
  const body = DOC.indexOf("Text");
  view.dispatch({ selection: { anchor: body } });
  assert.equal(taken(view, MARKDOWN), true);
  assert.equal(requests[0].origin, "paste");
  assert.deepEqual(requests[0].range.current(), { from: body, to: body });
  requests[0].range.release();
  // LaTeX and prose paste as they are.
  assert.equal(taken(view, { "text/plain": [String.raw`\begin{itemize}`, String.raw`\item a`, String.raw`\end{itemize}`].join("\n") }), false);
  assert.equal(taken(view, { "text/plain": "plain words" }), false);
  // Inside math.
  const math = view.state.doc.toString().indexOf("$x$") + 1;
  view.dispatch({ selection: { anchor: math } });
  assert.equal(pasteStaysLiteral(view.state, math), true);
  // Right before and right after the formula is outside it.
  assert.equal(pasteStaysLiteral(view.state, math + 2), false);
  assert.equal(pasteStaysLiteral(view.state, math - 1), false);
  assert.equal(taken(view, MARKDOWN), false);
  // In the preamble.
  assert.equal(pasteStaysLiteral(view.state, DOC.indexOf(String.raw`\usepackage`)), true);
  // Mod-Shift-V: the next paste is plain.
  view.dispatch({ selection: { anchor: body } });
  view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "V", ctrlKey: true, shiftKey: true, bubbles: true }));
  assert.equal(taken(view, MARKDOWN), false);
  assert.equal(taken(view, MARKDOWN), true);
  requests.at(-1)?.range.release();
  // Rich HTML converts in the Visual mode only.
  assert.equal(taken(view, { "text/plain": "Bold", "text/html": "<p><b>Bold</b></p>" }), false);
  view.destroy();
  const visual = mount(DOC, (request) => requests.push(request), { visual: true });
  visual.dispatch({ selection: { anchor: body } });
  assert.equal(taken(visual, { "text/plain": "Bold", "text/html": "<p><b>Bold</b></p>" }), true);
  assert.equal(requests.at(-1)?.html, "<p><b>Bold</b></p>");
  // A code editor's coloured HTML is not rich text.
  assert.equal(taken(visual, { "text/plain": "x = 1", "text/html": "<div style=\"color:#000\"><span>x = 1</span></div>" }), false);
  // Detection off: Markdown pastes as it is.
  const off = mount(DOC, (request) => requests.push(request), { detect: false });
  off.dispatch({ selection: { anchor: body } });
  assert.equal(taken(off, MARKDOWN), false);
  visual.destroy();
  off.destroy();
});

test("the target range follows edits made while the dialog is open, and the insert is one undo step", () => {
  const view = mount(DOC, () => undefined);
  const at = DOC.indexOf(" here.");
  const range = trackRange(view, at, at);
  // A collaborator types before the target.
  view.dispatch({ changes: { from: DOC.indexOf("Text"), insert: "New " } });
  assert.deepEqual(range.current(), { from: at + 4, to: at + 4 });
  const inserted = insertLatexAt(range, { latex: "\\begin{itemize}\n  \\item a\n\\end{itemize}", block: true, packages: ["\\usepackage{soul}"] });
  assert.ok(inserted);
  const text = view.state.doc.toString();
  assert.match(text, /\\usepackage\{booktabs\}\n\\usepackage\{soul\}\n/);
  assert.match(text, /New Text \$x\$\n\n\\begin\{itemize\}\n {2}\\item a\n\\end\{itemize\}\n\n here\./);
  // What was inserted, padding included: what "Paste as plain text instead" may replace.
  assert.equal(text.slice(inserted!.from, inserted!.to), "\n\n\\begin{itemize}\n  \\item a\n\\end{itemize}\n\n");
  assert.equal(inserted!.text, text.slice(inserted!.from, inserted!.to));
  assert.equal(range.current(), null);
  undo(view);
  assert.equal(view.state.doc.toString(), DOC.replace("Text", "New Text"));
  view.destroy();
});

test("inline insertions take no blank lines; context comes from the editor", () => {
  const view = mount(DOC, () => undefined);
  const at = DOC.indexOf(" here.");
  insertLatexAt(trackRange(view, at, at), { latex: "\\textbf{b}", block: false });
  assert.match(view.state.doc.toString(), /Text \$x\$\\textbf\{b\} here\./);
  const context = latexPasteContextAt(view.state, at, { documentPath: "paper/main.tex" });
  assert.equal(context.sectionCommand, "section");
  assert.equal(context.documentClass, "article");
  assert.equal(context.packages.has("booktabs"), true);
  assert.equal(context.documentDir, "paper");
  assert.equal(context.inlineOnly, false);
  assert.equal(preambleInsertPoint(view.state), DOC.indexOf("\n\\begin{document}"));
  view.destroy();
  const argument = mount(String.raw`\begin{document}\section{Ti tle}\end{document}`, () => undefined);
  assert.equal(pasteIsInlineOnly(argument.state, String.raw`\begin{document}\section{Ti`.length), true);
  argument.destroy();
});

/* ---- Review fixes: TeX safety ----------------------------------------------------------- */

test("TeX that reads or writes files cannot get through, however it is spelled", () => {
  // ^^5c is a backslash to TeX.
  assert.equal(isSafeMathTex("^^5cinput{secret.tex}"), false);
  assert.equal(isSafeRawLatex(String.raw`\textbf{^^5cinput{x}}`), false);
  const caret = markdownToLatex("# H\n\n$^^5cinput{secret.tex}$");
  assert.ok(!caret.latex.includes("$^^5c"), caret.latex);
  assert.equal(caret.warnings[0].code, "unsafe-math");
  assert.ok("error" in parseHeadingTemplate("^^5cinput{secret.tex}#1"));
  assert.ok("error" in parseHeadingTemplate(String.raw`\textbf{#1}#0`));
  assert.ok("error" in parseHeadingTemplate(String.raw`\textbf{#1} #`));
  assert.deepEqual(parseHeadingTemplate(String.raw`\textbf{#1} \#`), { template: String.raw`\textbf{#1} \#` });
  // File-reading commands and file-writing environments are text, even with their package loaded.
  const listings = article({ packages: packages({ listings: [] }) });
  assert.equal(latex(String.raw`See \lstinputlisting{secret.txt} here.`, {}, listings), String.raw`See \textbackslash{}lstinputlisting\{secret.txt\} here.`);
  assert.equal(latex(String.raw`A \begin{filecontents*}{owned.txt}hello\end{filecontents*} B`), String.raw`A \textbackslash{}begin\{filecontents*\}\{owned.txt\}hello\textbackslash{}end\{filecontents*\} B`);
  // Unknown commands are text; the document's own macros and environments are kept.
  assert.equal(latex(String.raw`Use \foo{x} and \bar.`), String.raw`Use \textbackslash{}foo\{x\} and \textbackslash{}bar.`);
  const defined = article({ definedCommands: new Set(["myref"]), definedEnvironments: new Set(["claim"]) });
  assert.equal(latex(String.raw`See \myref{a} and \begin{claim}x\end{claim}.`, {}, defined), String.raw`See \myref{a} and \begin{claim}x\end{claim}.`);
  // A known command whose argument never closes is text as a whole, not a command name with escaped braces.
  assert.equal(latex(String.raw`See \ref{fig and more`), String.raw`See \textbackslash{}ref\{fig and more`);
  // A kept command may only contain allowed names.
  assert.equal(latex(String.raw`\textbf{\foo{x}}`), String.raw`\textbackslash{}textbf\{\textbackslash{}foo\{x\}\}`);
});

test("listings never inherit escapes to TeX from the document", () => {
  const output = latex("```python\n(*@\\input{secret.tex}@*)\n```", { codeBlocks: "lstlisting" });
  assert.match(output, /^\\begin\{lstlisting\}\[language=Python,escapechar=\{\},escapeinside=\{\},mathescape=false,texcl=false\]/);
});

/* ---- Review fixes: conversion ------------------------------------------------------------ */

test("arguments never get \\verb, and highlights only hold what soul can typeset", () => {
  assert.equal(latex("**`x`** and ~~`y`~~ and `z`", { inlineCode: "verb" }), "\\textbf{\\texttt{x}} and \\sout{\\texttt{y}} and \\verb|z|");
  assert.equal(latex("[color=#f00]`x`[/color]", { inlineCode: "verb" }), "\\textcolor[HTML]{FF0000}{\\texttt{x}}");
  const linked = markdownToLatex(">>>a [link](https://example.com)<<<");
  assert.equal(linked.latex, "a \\href{https://example.com}{link}");
  assert.equal(linked.warnings[0].code, "soul");
  assert.equal(latex(">>>a **b** c<<<"), "\\hl{a \\textbf{b} c}");
  assert.equal(latex("~~a [l](https://x.org)~~", { strike: "st" }), "a \\href{https://x.org}{l}");
});

test("where only inline text fits, LaTeX blocks written in the text stay text", () => {
  const inline = markdownToLatex(String.raw`\begin{center}hello\end{center} and \section{x}`, {}, article({ inlineOnly: true }));
  assert.equal(inline.latex, String.raw`\textbackslash{}begin\{center\}hello\textbackslash{}end\{center\} and \textbackslash{}section\{x\}`);
  assert.equal(inline.warnings[0].code, "raw-block");
  // In a heading too.
  assert.equal(latex(String.raw`# A \newpage B`), String.raw`\section{A \textbackslash{}newpage B}`);
  // A label in a heading is fine.
  assert.equal(latex(String.raw`# Intro \label{sec:intro}`), String.raw`\section{Intro \label{sec:intro}}`);
});

test("every generated command's package is reported", () => {
  assert.deepEqual(markdownToLatex("Field ℝ").missing.map((pkg) => pkg.name), ["amsfonts"]);
  assert.deepEqual(markdownToLatex("$\\begin{pmatrix}1\\\\2\\end{pmatrix}$").missing.map((pkg) => pkg.name), ["amsmath"]);
  assert.deepEqual(markdownToLatex("$$\n\\begin{equation*}x\\end{equation*}\n$$").missing.map((pkg) => pkg.name), ["amsmath"]);
  assert.deepEqual(markdownToLatex("$$\n\\begin{equation}x\\end{equation}\n$$").missing, []);
});

test("a display environment in running text is made inline; alone, it is displayed", () => {
  const inline = markdownToLatex("x $\\begin{equation}a\\label{e}\\end{equation}$ y and $\\begin{align}b &= c\\end{align}$");
  assert.equal(inline.latex, "x $a$ y and $\\begin{aligned}b &= c\\end{aligned}$");
  assert.equal(inline.warnings[0].code, "inline-display");
  assert.equal(latex("$\\begin{align}b &= c\\end{align}$"), "\\begin{align}b &= c\\end{align}");
  assert.equal(latex("# T $\\begin{equation}a\\end{equation}$"), "\\section{T $a$}");
});

test("footnotes: numbers in tables, none nested", () => {
  const table = latex("| a | b |\n|---|---|\n| x[^1] | y[^2] |\n\n[^1]: A.\n[^2]: B.", { tableFloat: "none" });
  assert.match(table, /x\\footnotemark & y\\footnotemark/);
  assert.match(table, /\\addtocounter\{footnote\}\{-1\}\n\\footnotetext\{A\.\}\n\\stepcounter\{footnote\}\\footnotetext\{B\.\}$/);
  const nested = markdownToLatex("A[^a]\n\n[^a]: B[^b]\n[^b]: C");
  assert.equal(nested.latex, "A\\footnote{B (C)}");
  assert.equal(nested.warnings[0].code, "nested-footnote");
});

test("tables: captions kept unless used, merged cells, two-column documents, taken labels", () => {
  // Detection off and a typed caption: the paragraph stays in the text.
  const typed = latex(`Table 1: Found\n\n${TABLE}`, { tableCaptionFromText: false }, article(), { tables: [{ caption: "Typed", label: "" }] });
  assert.match(typed, /^Table 1: Found\n\n\\begin\{table\}/);
  assert.match(typed, /\\caption\{Typed\}/);
  // A merged cell never takes \newline.
  const prepared = prepareHtmlPaste("<table><tr><th>A</th><th>B</th></tr><tr><td colspan=\"2\">c<br>d</td></tr></table>")!;
  const merged = convertPreparedMarkdown(prepared, resolveChoices(DEFAULT_MARKDOWN_PASTE_OPTIONS, prepared.analysis, article()), article());
  assert.match(merged.latex, /\\multicolumn\{2\}\{l\}\{c d\}/);
  // longtable is not available in two columns.
  const twoColumn = markdownToLatex(TABLE, { tableEnvironment: "longtable" }, article({ classOptions: ["twocolumn"] }));
  assert.match(twoColumn.latex, /\\begin\{tabular\}/);
  assert.equal(twoColumn.warnings[0].code, "longtable-twocolumn");
  // A typed label already in use gets a number.
  const taken = markdownToLatex(TABLE, {}, article({ labels: new Set(["tab:x"]) }), { tables: [{ caption: "C", label: "tab:x" }] });
  assert.match(taken.latex, /\\label\{tab:x-2\}/);
  assert.equal(taken.warnings[0].code, "label-taken");
});

test("anchors follow GitHub's slugs for repeated headings; starred headings publish none", () => {
  assert.equal(latex("# Foo\n\n# Foo\n\n[first](#foo) [second](#foo-1)"),
    "\\section{Foo}\\label{sec:foo}\n\n\\section{Foo}\\label{sec:foo-2}\n\n\\hyperref[sec:foo]{first} \\hyperref[sec:foo-2]{second}");
  assert.equal(latex("# Foo\n\n[a](#foo)", { headingStarred: true }), "\\section*{Foo}\n\na");
});

test("citations: aliases cite the key the bibliography has", () => {
  const context = article({ packages: packages({ biblatex: [] }), bibKeys: new Set(["new", "old"]), bibAliases: new Map([["old", "new"]]) });
  assert.equal(latex("As @old says, [@old, p. 2].", {}, context), "As \\textcite{new} says, \\parencite[p.~2]{new}.");
});

test("lists count the lists and quotes around the paste", () => {
  const deep = markdownToLatex("- a\n  - b", {}, article({ listDepth: { itemize: 3, enumerate: 0, other: 0 } }));
  assert.equal((deep.latex.match(/\\begin\{itemize\}/g) ?? []).length, 1);
  assert.equal(deep.warnings[0].code, "deep-list");
  const quotes = markdownToLatex("> > > > > - a", {}, article({ listDepth: { itemize: 0, enumerate: 0, other: 1 } }));
  assert.ok(!/\\begin\{itemize\}/.test(quotes.latex), quotes.latex);
});

test("image paths stay inside the notebook and are written for the compile root", () => {
  assert.equal(localImagePath("../../secret.pdf", ""), null);
  assert.deepEqual(localImagePath("../figs/a.png", "chapters"), { path: "../figs/a.png" });
  assert.equal(localImagePath("../../../a.png", "chapters"), null);
  // A Libera URL pasted into a chapter whose main file is at the notebook's root.
  assert.deepEqual(localImagePath("/api/files/raw/nb/figs/a.png", "nb"), { path: "figs/a.png" });
});

test("placements need a position; `!` alone is not one", () => {
  assert.equal(normalizePlacement("!"), "htbp");
  assert.equal(normalizePlacement("!h"), "h!");
  assert.equal(normalizePlacement("H"), "H");
});

/* ---- Review fixes: HTML and detection ---------------------------------------------------- */

test("clipboard HTML: spans are bounded, row spans keep columns, captions and cell paragraphs survive", () => {
  const started = Date.now();
  const infinite = prepareHtmlPaste("<table><tr><td colspan=\"Infinity\">x</td></tr></table>");
  assert.ok(Date.now() - started < 1000);
  assert.ok(infinite);
  const convert = (html: string) => {
    const prepared = prepareHtmlPaste(html)!;
    return convertPreparedMarkdown(prepared, resolveChoices({ ...DEFAULT_MARKDOWN_PASTE_OPTIONS, tableFloat: "none" }, prepared.analysis, article()), article());
  };
  assert.match(convert("<table><tr><td colspan=\"2.5\">x</td><td>y</td></tr></table>").latex, /\\multicolumn\{2\}\{l\}\{x\} & y/);
  const rowspan = convert("<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td rowspan=\"2\">a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td></tr></table>");
  // The cell carried down from the row above is empty in the row below, so d and e keep their columns.
  assert.match(rowspan.latex, /a & b & c \\\\\n {3}& d & e \\\\/);
  assert.equal(rowspan.warnings[0].code, "rowspan");
  const captioned = prepareHtmlPaste("<table><caption>Results</caption><tr><th>A</th></tr><tr><td>1</td></tr></table>")!;
  assert.equal(captioned.analysis.tables[0].caption, "Results");
  // Paragraphs in a cell are line breaks, so the column wraps.
  assert.match(convert("<table><tr><th>A</th></tr><tr><td><p>two</p><p>three</p></td></tr></table>").latex, /p\{0\.\d+\\linewidth\}\}[\s\S]*two\\newline three/);
});

test("detection: single-column tables, Markdown inside LaTeX verbatim, long backtick runs", () => {
  assert.equal(looksLikeMarkdown("| a |\n|---|\n| b |"), true);
  assert.equal(looksLikeMarkdown("\\begin{verbatim}\n# Heading\n**bold**\n- one\n- two\n\\end{verbatim}"), false);
  // Runs of openers without closers stay linear (a quadratic scan of these takes seconds).
  for (const input of ["`".repeat(40_000), "\\[".repeat(40_000), "$\n".repeat(40_000), "$$".repeat(40_000), "\\(x".repeat(30_000), "[".repeat(80_000), "**a".repeat(30_000), "%".repeat(80_000), "*x ".repeat(30_000), "~~a".repeat(30_000)]) {
    const started = Date.now();
    scoreMarkdown(input);
    assert.ok(Date.now() - started < 1000, `${JSON.stringify(input.slice(0, 4))}…: ${Date.now() - started} ms`);
  }
  assert.equal(scoreMarkdown("- a $x*y*z$\n- b $$\\section{q}$$").isMarkdown, true);
  assert.equal(scoreMarkdown("a ~~b~~ c").markdown, 1);
  assert.equal(isRichClipboardHtml("<pre><code>x</code></pre>"), true);
  assert.equal(isRichClipboardHtml("<p><a href=\"https://x.org\">x</a></p>"), true);
});

/* ---- Review fixes: the editor ------------------------------------------------------------ */

test("package lines go after a \\usepackage that spans lines, and commented \\begin{document} does not count", () => {
  const doc = "\\documentclass{article}\n\\usepackage{\nbooktabs\n}\n% \\begin{document}\n\\begin{document}\nx\n\\end{document}";
  const view = mount(doc, () => undefined);
  assert.equal(preambleInsertPoint(view.state), doc.indexOf("}\n% ") + 1);
  assert.equal(pasteStaysLiteral(view.state, doc.indexOf("% \\begin")), true);
  assert.equal(pasteStaysLiteral(view.state, doc.indexOf("x\n\\end")), false);
  view.destroy();
});

test("nothing is reported as inserted when suggest mode keeps the document as it was", () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const state = EditorState.create({
    doc: "\\begin{document}\n\n\\end{document}",
    extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexMarkdownPaste(() => null),
      // A stand-in for suggest mode: changes are taken away from the transaction.
      EditorState.transactionFilter.of((transaction) => transaction.docChanged ? { selection: transaction.selection } : transaction)],
  });
  const view = new EditorView({ state, parent });
  assert.equal(insertLatexAt(trackRange(view, 17, 17), { latex: "\\textbf{x}", block: false }), null);
  view.destroy();
});

test("the notice replaces pasted LaTeX only while it is unchanged; a closed editor takes nothing", () => {
  const view = mount(DOC, () => undefined);
  const at = DOC.indexOf(" here.");
  const inserted = insertLatexAt(trackRange(view, at, at), { latex: "\\textbf{b}", block: false })!;
  // A collaborator types inside the pasted LaTeX.
  view.dispatch({ changes: { from: inserted.from + 9, insert: "REMOTE" } });
  assert.equal(replaceInsertedLatex(trackRange(view, inserted.from, inserted.to + 6), inserted.text, "**b**"), false);
  assert.match(view.state.doc.toString(), /\\textbf\{bREMOTE\}/);
  // Unchanged: replaced.
  const second = insertLatexAt(trackRange(view, 0, 0), { latex: "\\emph{c}", block: false })!;
  assert.equal(replaceInsertedLatex(trackRange(view, second.from, second.to), second.text, "*c*"), true);
  assert.ok(view.state.doc.toString().startsWith("*c*"));
  const range = trackRange(view, 0, 0);
  view.destroy();
  assert.equal(range.current(), null);
});

test("two pastes are two undo steps", () => {
  const view = mount(DOC, () => undefined);
  const at = DOC.indexOf(" here.");
  insertLatexAt(trackRange(view, at, at), { latex: "FIRST", block: false });
  insertLatexAt(trackRange(view, at, at), { latex: "SECOND", block: false });
  undo(view);
  assert.match(view.state.doc.toString(), /FIRST/);
  assert.doesNotMatch(view.state.doc.toString(), /SECOND/);
  view.destroy();
});

test("⇧⌘V and pastes into math keep the Visual mode's HTML paste from converting too", () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const state = EditorState.create({
    doc: DOC,
    extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexMarkdownPaste(() => ({ onRequest: () => undefined, detect: () => true, visual: () => true })), pasteHtmlAsLatex],
  });
  ensureSyntaxTree(state, DOC.length, 5000);
  const view = new EditorView({ state, parent });
  const body = DOC.indexOf("Text");
  view.dispatch({ selection: { anchor: body } });
  view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "V", ctrlKey: true, shiftKey: true, bubbles: true }));
  paste(view, { "text/plain": "bold", "text/html": "<p><b>bold</b></p>" });
  assert.doesNotMatch(view.state.doc.toString(), /\\textbf\{bold\}/);
  view.destroy();
});

test("context: the document's definitions, the lists around the paste, headings in verbatim skipped", () => {
  const info = readPreambleInfo([String.raw`\newcommand{\myref}[1]{x} \def\other{y} \newtheorem{claim}{Claim} \begin{verbatim}\newcommand{\no}{}\end{verbatim}`]);
  assert.deepEqual([...info.commands].sort(), ["myref", "other"]);
  assert.deepEqual([...info.environments], ["claim"]);
  const text = String.raw`\section{Real}` + "\n" + String.raw`\begin{verbatim}\subsection{Fake}\end{verbatim}` + "\n" + String.raw`\newcommand{\chap}[1]{\chapter{#1}}` + "\n";
  assert.equal(sectionBefore(text, text.length)?.title, "Real");
  const doc = "\\begin{document}\n\\begin{itemize}\n\\item a\n\\begin{quote}\nX\n\\end{quote}\n\\end{itemize}\n\\end{document}";
  const view = mount(doc, () => undefined);
  assert.deepEqual(listDepthAt(view.state, doc.indexOf("X")), { itemize: 1, enumerate: 0, other: 1 });
  view.destroy();
});
