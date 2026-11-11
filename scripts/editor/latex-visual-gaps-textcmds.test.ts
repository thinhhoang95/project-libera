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
import { readBibEntries } from "../../src/lib/latex/project";
import { latexProjectField } from "../../src/lib/latex/codemirror/editing";
import { mathNoteText } from "../../src/lib/latex/codemirror/visual/references";

/* Text, front matter, citations and layout no-ops from the audit's papers (2611.07227, 2610.39746, 2611.06541,
 * 2611.10887, 2611.10154, 2610.30364, 2611.07622): each test is the smallest source showing the gap, and every widget
 * these add shows its source when clicked. */

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
/** The text lines of a mounted document body (the last, `\end{document}`, is where the caret is: shown as source, dropped). */
function bodyLines(body: string, preamble = "", extra: Extension[] = [], documentClass = "article") {
  const view = mount(inDocument(body, preamble, documentClass), extra);
  const lines = lineTexts(view).filter(Boolean).filter((line) => !/^(?:\\documentclass|▸ Preamble|\\end\{document\})/.test(line));
  view.destroy();
  view.dom.parentElement?.remove();
  return lines;
}
const mouse = (type: string, init: Record<string, unknown> = {}) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });

const BIB = readBibEntries(String.raw`@article{Pace2022, author = {Pace, Andrew}, title = {A}, year = {2022}}
@article{Battaglia2022, author = {Battaglia, Giuseppina and Taibi, Stefano}, title = {B}, year = {2022}}
@article{Pace2025, author = {Pace, Andrew and Li, Ting}, title = {C}, year = {2025}}`);
const withBib = [latexProjectField.init(() => ({ labels: [], bibEntries: BIB, files: [] }))];

test("natbib citations nested in a citation's note and in a caption print without junk (astro-ph 2611.07227)", () => {
  const doc = inDocument(String.raw`See \citep[][mostly from \citealt{Pace2022}, \citealt{Battaglia2022}]{Pace2025}.
\begin{figure}
\includegraphics{a}
\caption{Data \citep[][mostly from \citealt{Pace2022} and \citealt[see][]{Battaglia2022}]{Pace2025}.}
\end{figure}`);
  const view = mount(doc, withBib);
  const text = lineTexts(view).join("\n");
  assert.doesNotMatch(text, /\\cite|citealtPace/);
  assert.match(text, /See \[Pace and Li 2025, mostly from Pace 2022, Battaglia and Taibi 2022\]\./);
  // The caption's too (it is drawn by the fragment renderer).
  const caption = view.contentDOM.querySelector(".cm-vis-caption-text")?.textContent ?? "";
  assert.match(caption, /Data \[Pace and Li 2025, mostly from Pace 2022 and see Battaglia and Taibi 2022\]\./);
  view.destroy();
});

test("every natbib command with up to two optional arguments draws as a chip", () => {
  const body = String.raw`A \citealt{Pace2022} \citealp[see][p.~3]{Pace2022} \citet{Pace2022} \citep[p.~2]{Pace2022,Pace2025} \citep*{Battaglia2022} \citeauthor{Pace2022} \citeyear{Pace2022} \Citet{Pace2025} \citenum{Pace2022}.`;
  const text = bodyLines(body, "", withBib).join(" ");
  assert.doesNotMatch(text, /\\cite|\\Cite/);
  assert.match(text, /Pace 2022 \[see Pace 2022, p\. 3\]|see Pace 2022, p\. 3/);
  assert.match(text, /Pace and Li \(2025\)/);
});

test("a formula in a citation note prints as text, with the document's macros expanded (2611.07227)", () => {
  assert.equal(mathNoteText(String.raw`(+0.380 \pm 0.001, -0.361 \pm 0.002)\,{\rm mas\,yr^{-1}}`), "(+0.380 ± 0.001, -0.361 ± 0.002) mas yr⁻¹");
  // A formula with a command that has no plain text stays source.
  assert.equal(mathNoteText(String.raw`\frac{a}{b}`), null);
  const text = bodyLines(String.raw`Measured \citet[$(+0.380 \pm 0.001)\masyr$ from \Gaia{} EDR3,][consistent]{Pace2022}.`, String.raw`\newcommand{\masyr}{\,{\rm mas\,yr^{-1}}}
\newcommand{\Gaia}{\textit{Gaia}}
`, withBib).join(" ");
  assert.doesNotMatch(text, /\\masyr|\\pm/);
  assert.match(text, /\(\+0\.380 ± 0\.001\) mas yr⁻¹ from Gaia EDR3,/);
});

const AA = String.raw`\title{\getgaia{} 2.0: automatic membership with \Gaia{}}
\titlerunning{\getgaia{} 2.0: membership}

\author{Andr\'es del Pino\orcidlink{0000-0003-4922-5131}\inst{1}\corrauth{apino@iaa.csic.es}
\and Second Author\inst{1,2}}
\authorrunning{A. del Pino}

\institute{Instituto de Astrof\'isica de Andaluc\'ia (IAA-CSIC), Granada, Spain \and Other Institute, Paris, France}

\date{Received \today; accepted ...}

\abstract
% context
{\Gaia{} provides the astrometry.}
% aims
{We present a package.}
% methods
{The membership is a model.}
% results
{It recovers members.}
% conclusions
{It runs automatically.}

\keywords{astrometry -- proper motions}

\maketitle
`;

test("A&A's front matter is a title block: \\inst, \\orcidlink, \\corrauth, \\institute, \\today, five-part \\abstract; running titles are hidden (astro-ph 2611.07227)", () => {
  const preamble = String.raw`\newcommand{\Gaia}{\textit{Gaia}}
\newcommand{\getgaia}{\textsc{GetGaia}}
`;
  const doc = inDocument(`${AA}\\section{Introduction}\nBody.`, preamble, "aa");
  const view = mount(doc);
  const block = view.contentDOM.querySelector(".cm-vis-title-block")!;
  assert.ok(block, "the title block is drawn");
  const text = (selector: string) => [...block.querySelectorAll(selector)].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
  assert.match(text("[data-title-part=title]")[0], /^GetGaia 2\.0: automatic membership with Gaia$/);
  assert.equal(text("[data-title-part=author]").length, 2);
  assert.equal(block.querySelectorAll(".cm-vis-author sup.cm-vis-inst").length, 2);
  assert.equal(block.querySelector(".cm-vis-orcid")?.getAttribute("title"), "ORCID 0000-0003-4922-5131");
  assert.match(block.querySelector(".cm-vis-author .cm-vis-footnote-mark")?.getAttribute("title") ?? "", /apino@iaa\.csic\.es/);
  assert.match(text("[data-title-part=author]")[0], /^Andrés del Pino/);
  assert.deepEqual(text(".cm-vis-title-places .cm-vis-affiliation"), ["1 Instituto de Astrofísica de Andalucía (IAA-CSIC), Granada, Spain", "2 Other Institute, Paris, France"]);
  assert.match(text("[data-title-part=date]")[0], /^Received [A-Z][a-z]+ \d+, \d{4}; accepted \.\.\.$/);
  const abstract = text("[data-title-part=abstract]")[0];
  assert.match(abstract, /^Context\. Gaia provides the astrometry\. Aims\. We present a package\. Methods\./);
  assert.match(abstract, /Conclusions\. It runs automatically\.$/);
  assert.match(text(".cm-vis-title-note").join(" "), /astrometry/);
  // Nothing of the block is left as source: the running titles are part of it.
  const lines = lineTexts(view).join("\n");
  assert.doesNotMatch(lines, /titlerunning|authorrunning|\\inst|\\orcidlink|\\institute|\\abstract/);
  view.destroy();
});

test("A&A's block: a click on the five-part abstract shows its source (it has no one place to edit)", () => {
  const doc = inDocument(`${AA}\\section{Introduction}\nBody.`, "", "aa");
  const view = mount(doc);
  const block = view.contentDOM.querySelector<HTMLElement>(".cm-vis-title-block")!;
  const start = doc.indexOf("\\title");
  block.querySelector<HTMLElement>("[data-title-part=abstract]")!.dispatchEvent(mouse("mousedown"));
  const sel = view.state.selection.main;
  assert.ok(sel.from >= start && sel.to <= doc.indexOf("\\maketitle") + "\\maketitle".length, "the selection is in the block's source");
  assert.ok(sel.to > sel.from, "the block's source is selected");
  view.destroy();
});

test("layout commands that print nothing are hidden, and their source shows at the cursor (cs.LO 2610.39746, revtex 2611.06541, 2611.10887, q-bio 2610.30364)", () => {
  const body = String.raw`Text \Needspace{16\baselineskip} here.

\eject
\vskip\baselineskip
Para \eject mid \onecolumngrid and \twocolumngrid end.

\onecolumngrid
\twocolumngrid
\Needspace{16\baselineskip}
\addtocontents{toc}{\protect\setcounter{tocdepth}{1}}
\clearpage \newpage
\pagebreak \nopagebreak \raggedbottom \flushbottom \sloppy \fussy \thispagestyle{empty}
Last para.`;
  const lines = bodyLines(body, "", [], "revtex4-2");
  assert.deepEqual(lines, ["Text here.", "Para mid and end.", "Last para."]);
  // At the cursor the command shows again.
  const doc = inDocument(body, "", "revtex4-2");
  const at = doc.indexOf("\\Needspace{16\\baselineskip}\n\\addtocontents");
  const view = mount(doc, [], at + 3);
  assert.ok(lineTexts(view).some((line) => line.startsWith("\\Needspace{16\\baselineskip}")), "the line under the cursor shows its source");
  view.destroy();
  const inline = mount(doc, [], doc.indexOf("\\Needspace") + 3);
  assert.match(lineTexts(inline).join("\n"), /Text \\Needspace\{16\\baselineskip\} here/);
  inline.destroy();
});

test("\\AtEndDocument with a \\includepdf in it folds as one layout block (math.CO 2611.10154)", () => {
  const body = String.raw`Text.
\addtocontents{toc}{\protect\setcounter{tocdepth}{1}}

\AtEndDocument{%
  \includepdf[
    pages=1,
    fitpaper=true,
    pagecommand={\thispagestyle{empty}}
  ]{tamari_3_2.pdf}%
}
Done.`;
  assert.deepEqual(bodyLines(body), ["Text.", "Done."]);
});

test("\\includepdf draws a placeholder naming the file; clicking it shows the command's source", () => {
  const doc = inDocument("Before.\n\\includepdf[pages=1,\n  fitpaper=true]{tamari.pdf}\nAfter and \\includepdf{b.pdf} inline.");
  const view = mount(doc);
  const widgets = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-pdf-pages")];
  assert.deepEqual(widgets.map((widget) => widget.textContent), ["PDF pages: tamari.pdf", "PDF pages: b.pdf"]);
  const from = doc.indexOf("\\includepdf[");
  const to = doc.indexOf("{tamari.pdf}") + "{tamari.pdf}".length;
  widgets[0].dispatchEvent(mouse("mousedown"));
  const head = view.state.selection.main.head;
  assert.ok(head > from && head < to, "the caret moved into the command");
  assert.ok(lineTexts(view).join("\n").includes("\\includepdf[pages=1,"), "the source shows");
  view.destroy();
});

test("a macro in \\url or \\href is expanded; a click on the link shows the source, Ctrl-click leaves that to the link (q-bio 2610.30364)", () => {
  const preamble = String.raw`\newcommand{\repourl}{https://github.com/x/y_z}
\newcommand{\site}{http://example.org/a}
`;
  const doc = inDocument("Code at \\url{\\repourl}; see \\href{\\site/b}{the site} and \\url{\\unknownmacro}.", preamble);
  const view = mount(doc);
  const links = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-link")];
  assert.equal(links[0].textContent, "https://github.com/x/y_z");
  assert.equal(links[0].dataset.href, "https://github.com/x/y_z");
  assert.equal(links[1].textContent, "the site");
  assert.equal(links[1].dataset.href, "http://example.org/a/b");
  // An address that stays a macro is not drawn as a link.
  assert.equal(links.length, 2);
  assert.match(lineTexts(view).join("\n"), /\\url\{\\unknownmacro\}/);
  const from = doc.indexOf("\\url{\\repourl}");
  links[0].dispatchEvent(mouse("mousedown", { ctrlKey: true }));
  assert.equal(view.state.selection.main.head, doc.length, "Ctrl-click does not move the caret (it opens the link)");
  links[0].dispatchEvent(mouse("mousedown"));
  const head = view.state.selection.main.head;
  assert.ok(head > from && head < from + "\\url{\\repourl}".length, "the caret moved into the command");
  view.destroy();
});

test("a group that only scopes \\renewcommand{\\thefootnote}{} before a \\footnotetext draws as the note alone (q-bio 2610.30364)", () => {
  const doc = inDocument("\\maketitle\n\n{\\renewcommand{\\thefootnote}{}\\footnotetext{$^{\\dagger}$Lead and corresponding author.}}\n\nText.", "\\title{T}\\author{A}\n");
  const first = mount(doc);
  const lines = lineTexts(first).join("\n");
  first.destroy();
  assert.match(lines, /†Lead and corresponding author\./);
  assert.doesNotMatch(lines, /renewcommand|thefootnote/);
  assert.doesNotMatch(lines, /\{†/);
  // The source is back at the cursor.
  const view = mount(doc, [], doc.indexOf("\\renewcommand") + 3);
  assert.match(lineTexts(view).join("\n"), /\{\\renewcommand\{\\thefootnote\}\{\}/);
  view.destroy();
});

test("a bibitem label with commands is drawn: BibTeX's alpha style \\etalchar{+} is a superscript plus (cs.DS 2611.07622)", () => {
  const doc = inDocument(String.raw`See \cite{cgk}.
\begingroup
\newcommand{\etalchar}[1]{$^{#1}$}
\begin{thebibliography}{CGK{\etalchar{+}}20}
\bibitem[Abr87]{abr} Karl Abrahamson. Generalized string matching.
\bibitem[CGK{\etalchar{+}}20]{cgk} Timothy Chan et al. Approximating Hamming distances.
\end{thebibliography}
\endgroup`);
  const view = mount(doc);
  const markers = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-item")].map((marker) => (marker.textContent ?? "").replace(/[\u200b\u2063]/g, ""));
  assert.equal(markers[0], "[Abr87]");
  assert.doesNotMatch(markers[1], /etalchar|\\/);
  assert.match(markers[1], /^\[CGK\+20\]$/);
  view.destroy();
});

test("text commands papers use are drawn: font families, soul, colour, boxes, accents, quotes, symbols, siunitx", () => {
  const quotes = "``quoted'' and `single'";
  const text = bodyLines(String.raw`A \textsc{Small} \textsf{Sans} \texttt{Mono} \textsl{Slant} \underline{Under} \sout{Struck} \st{St} \hl{High} \textcolor{red}{Red} \colorbox{yellow}{Boxed}.

B \href{http://a.org}{Link} \texorpdfstring{$x$}{x} \textsuperscript{sup} \textsubscript{sub} \ensuremath{\alpha} \mbox{mb} \hbox{hb} \textbf{\emph{BoldEm}} \ldots \dots \textellipsis.

C \ss \o \ae \'e \"o \c c \v{s} \H{o} \r a \textendash\ --- -- ${quotes} \S \P \textdegree \textmu \copyright \textregistered \ding{51}.

D \SI{1}{\meter} \num{1e5} \qty{3}{\kilo\gram} \unit{m/s} \ang{30}.

E Thanks\thanks{Funded by X} done.`, "\\usepackage{soul,xcolor,siunitx,pifont}\n").join("\n");
  assert.doesNotMatch(text, /\\[a-zA-Z]/);
  assert.match(text, /A Small Sans Mono Slant Under Struck St High Red Boxed\./);
  assert.match(text, /B Link x sup sub α mb hb BoldEm … … …\./);
  assert.match(text, /C ß ø æ é ö ç š ő å – — – “quoted” and ‘single’ § ¶ ° µ © ® ✓\./);
  assert.match(text, /D 1m 1×105 3kg m\/s 30∘\./);
  assert.match(text, /E Thanks\*Funded by X done\./);
});

test("\\thanks in the text is a starred note: its text is styled as a footnote's", () => {
  const view = mount(inDocument("Thanks\\thanks{Funded by X} done."));
  assert.equal(view.contentDOM.querySelector(".cm-vis-footnote-mark")?.textContent, "*");
  assert.equal(view.contentDOM.querySelector(".cm-vis-footnote")?.textContent, "Funded by X");
  view.destroy();
});
