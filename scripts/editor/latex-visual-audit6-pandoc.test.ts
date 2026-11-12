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

/* Round 6, Pandoc/Quarto output, paper-defined text macros, pifont digits (cs.IT 2611.09366, cs.PL 2610.26599, stat.ML 2611.11386, cs.CR 2611.10776, cs.SE 2611.11192): each case is a small excerpt written for the test. */

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

/** Mousedown on the first element matching `selector` reveals the source it stands for: the caret lands inside it. */
function clickReveals(body: string, selector: string, source: string, preamble = "", documentClass = "article", init: Record<string, unknown> = {}) {
  const doc = inDocument(body, preamble, documentClass);
  const view = mount(doc, [], doc.length);
  const target = view.contentDOM.querySelector(selector);
  assert.ok(target, `no ${selector} widget`);
  target.dispatchEvent(mouse("mousedown", init));
  const from = doc.indexOf(source);
  const head = view.state.selection.main.head;
  assert.ok(from >= 0 && head >= from && head <= from + source.length, `caret ${head} not in ${source} at ${from}`);
  view.destroy();
  view.dom.parentElement?.remove();
}


const PANDOC = `\\NewDocumentCommand\\citeproctext{}{}
\\NewDocumentCommand\\citeproc{mm}{%
  \\begingroup\\def\\citeproctext{#2}\\cite{#1}\\endgroup}
\\newlength{\\cslhangindent}
\\newenvironment{CSLReferences}[2]
 {\\begin{list}{}{\\setlength{\\itemindent}{0pt}}}
 {\\end{list}}
\\newcommand{\\CSLBlock}[1]{\\hfill\\break\\parbox[t]{\\linewidth}{\\strut\\ignorespaces#1\\strut}}
\\newcommand{\\CSLLeftMargin}[1]{\\parbox[t]{\\csllabelwidth}{\\strut#1\\strut}}
\\newcommand{\\CSLRightInline}[1]{\\parbox[t]{\\linewidth - \\csllabelwidth}{\\strut#1\\strut}}
\\providecommand{\\tightlist}{%
  \\setlength{\\itemsep}{0pt}\\setlength{\\parskip}{0pt}}
`;

test("Pandoc's \\citeproc draws its bracketed text as a citation chip (cs.IT 2611.09366)", () => {
  const body = "introduced by Elias \\citeproc{ref-elias1954_product}{{[}1{]}}. See \\citeproc{ref-a}{{[}2{]}}--\\citeproc{ref-b}{{[}4{]}}.";
  const text = bodyText(body, undefined, PANDOC, "IEEEtran");
  assert.match(text, /introduced by Elias \[1\]\. See \[2\]–\[4\]\./);
  assert.doesNotMatch(text, /citeproc|\{|\}/);
  clickReveals(body, ".cm-vis-cite", "\\citeproc{ref-elias1954_product}", PANDOC, "IEEEtran");
});

test("Pandoc's CSLReferences is a reference list, \\tightlist and empty hypertargets are hidden (cs.IT 2611.09366)", () => {
  const body = "\\begin{itemize}\n\\tightlist\n\\item one\n\\end{itemize}\n\\begin{lemma}[]\\protect\\hypertarget{lem-x}{}\\label{lem-x}\nBody \\phantomsection\\label{x} text.\n\\end{lemma}\n\\hypertarget{sec}{text shown}\n\n\\begin{CSLReferences}{0}{0}\n\\bibitem[\\citeproctext]{ref-a}\n\\CSLLeftMargin{{[}1{]} }%\n\\CSLRightInline{P. Elias, \\emph{Error-free coding}. 1954.}\n\n\\bibitem[\\citeproctext]{ref-b}\n\\CSLLeftMargin{{[}2{]} }%\n\\CSLRightInline{G. Forney. 1966.}\n\\end{CSLReferences}";
  const text = bodyText(body, undefined, `\\newtheorem{lemma}{Lemma}\n${PANDOC}`);
  assert.doesNotMatch(text, /tightlist|hypertarget|phantomsection|CSL|bibitem|citeproctext/);
  assert.match(text, /text shown/);
  assert.match(text, /References/);
  assert.match(text, /\[1\]%?\s*P\. Elias, Error-free coding\. 1954\./);
  assert.match(text, /\[2\]%?\s*G\. Forney\. 1966\./);
  // The entry's number is a widget: a click shows its command.
  clickReveals(body, ".cm-vis-symbol", "\\CSLLeftMargin{{[}1{]} }");
  // The caret in a hidden command shows it.
  const doc = inDocument(body, `\\newtheorem{lemma}{Lemma}\n${PANDOC}`);
  const at = doc.indexOf("\\tightlist\n") + 3;
  const view = mount(doc, [], at);
  assert.match(lineTexts(view).join("\n"), /\\tightlist/);
  view.destroy();
  view.dom.parentElement?.remove();
});

test("IEEEtran's \\ifCLASSOPTIONcaptionsoff takes its false branch unless the option is given (cs.IT 2611.09366)", () => {
  const body = "Before.\n\\ifCLASSOPTIONcaptionsoff\n  \\newpage\n\\fi\nAfter.";
  // A branch the document leaves out is drawn as faded source (the `cm-vis-disabled` lines).
  const disabledLines = (documentClass: string) => {
    const view = mount(inDocument(body, "", documentClass));
    const count = view.contentDOM.querySelectorAll(".cm-vis-disabled").length;
    view.destroy();
    view.dom.parentElement?.remove();
    return count;
  };
  assert.ok(disabledLines("IEEEtran") >= 1);
  assert.equal(disabledLines("article"), 0);
  assert.equal(disabledLines("[captionsoff]{IEEEtran"), 0);
});

const BN = `\\makeatletter
\\newcommand\\bn@set[4]{\\expandafter\\def\\csname bn@#1\\endcsname{{#2}{#3}{#4}}}
\\bn@set{gache}{3}{9.0}{1.2}
\\newcommand\\bn@scale{1.08}%
\\DeclareRobustCommand\\bn[1]{\\@ifundefined{bn@#1}{\\textbf{??}\\@latex@warning{Bangla snippet #1 undefined}}%
  {\\expandafter\\expandafter\\expandafter\\bn@put\\csname bn@#1\\endcsname}}
\\newcommand\\bn@put[3]{\\leavevmode\\begingroup\\dimen@=\\f@size\\p@ \\dimen@=\\bn@scale\\dimen@
  \\edef\\bn@s{\\strip@pt\\dimen@}%
  \\raisebox{-\\bn@s\\dimexpr#3pt+1.6pt\\relax}{\\includegraphics[scale=\\bn@s,page=#1]{figures/bangla_snippets.pdf}}%
  \\endgroup}
\\makeatother
`;

const DINGNUM = `\\usepackage{pifont}
\\newcommand{\\dingnum}[1]{%
  \\ifcase#1
    \\or \\ding{182} %
    \\or \\ding{183} %
    \\or \\ding{184} %
  \\fi
}
`;

test("pifont's \\dingnum{n} (an \\ifcase of \\ding numbers) draws the circled digit (cs.CR 2611.10776)", () => {
  const body = "Stage \\dingnum{1} reads, stage \\dingnum{3} writes; \\dingnum{2}.";
  const text = bodyText(body, undefined, DINGNUM);
  assert.match(text, /Stage ❶ ?reads, stage ❸ ?writes; ❷ ?./);
  assert.doesNotMatch(text, /\\|ifcase/);
  clickReveals(body, ".cm-vis-macro, .cm-vis-symbol", "\\dingnum{1}", DINGNUM);
});

const MYBOX = `\\usepackage{tcolorbox}
\\makeatletter
\\newcommand{\\mybox}[1]{%
	\\setbox0=\\hbox{#1}%
	\\setlength{\\@tempdima}{\\dimexpr\\wd0+13pt}%
	\\begin{tcolorbox}[boxrule=0.5pt, colback=white, arc=4pt,
		left=6pt,right=6pt,top=6pt,bottom=6pt,boxsep=0pt]
		#1
	\\end{tcolorbox}
}
\\makeatother
`;

test("a \\newcommand wrapping its argument in tcolorbox after measuring it draws the box (cs.SE 2611.11192)", () => {
  const body = "Intro text.\n\n\\mybox{\\textbf{Answer to RQ1:} Fine-tuning helps.}\n\nAfter.\n\\usepgfplotslibrary{groupplots}";
  const view = mount(inDocument(body, MYBOX));
  const text = view.contentDOM.textContent ?? "";
  assert.match(text, /Answer to RQ1: Fine-tuning helps\./);
  assert.doesNotMatch(text, /\\mybox|setbox|tempdima|tcolorbox|usepgfplotslibrary/);
  view.destroy();
  view.dom.parentElement?.remove();
  clickReveals(body, ".cm-vis-macro-env", "\\mybox{\\textbf{Answer to RQ1:} Fine-tuning helps.}", MYBOX);
});

test("a macro that builds a box from registers is never drawn as debris, and \\ensuremath in a bracketed cell is math (stat.ML 2611.11386)", () => {
  const doc = inDocument("A \\bn{gache} B.\n\n\\begin{table}\n\\caption{The idiom \\bn{gache} here.}\n\\begin{tabular}{@{}l ccc@{}}\n\\toprule\nClass apt & +1.7\\,{\\scriptsize[\\ensuremath{-}2.0, +5.5]} & +2.9\\,{\\scriptsize[\\ensuremath{-}1.4, +6.8]} & \\hlkeyr +15.6 \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}", BN);
  const view = mount(doc);
  const shown = view.contentDOM.textContent ?? "";
  assert.match(shown, /A \\bn\{gache\} B\./);
  assert.match(shown, /Table 1: The idiom \\bn\{gache\} here\./);
  assert.doesNotMatch(shown, /ifundefined|latex@warning|expandafter|dimen|strip@pt|csname/);
  assert.match(shown, /\+1\.7\s\[−2\.0, \+5\.5\]/);
  assert.doesNotMatch(shown, /ensuremath/);
  view.destroy();
  view.dom.parentElement?.remove();
});

const TERMS =`\\usepackage{etoolbox}\\usepackage{hyperref}\\usepackage{xcolor}
\\definecolor{commsafetycolor}{HTML}{2E5C8A}
\\newcommand{\\term}[2]{%
 \\hypertarget{#1}{\\ifstrequal{#1}{def:comm-safety}%
   {\\textcolor{commsafetycolor}{\\emph{#2}}}{\\emph{#2}}}}
\\newcommand{\\termref}[2]{%
 \\ifstrequal{#1}{def:comm-safety}%
   {\\hyperlink{#1}{\\textcolor{commsafetycolor}{#2}}}{#2}}
\\newenvironment{myparagraph}[1]{\\vspace{0.1in}\\noindent{\\bf #1.}\\enspace\\ignorespaces}{}
\\newcommand{\\tinyskip}{\\vspace{1pt}}
\\newcommand{\\nparagraph}[2]{\\tinyskip\\noindent\\textbf{#1.} #2}
`;

test("paper-defined \\term, \\termref, \\myparagraph and \\nparagraph draw as their text (cs.PL 2610.26599)", () => {
  const body = "We define \\term{def:comm-safety}{communication safety} and \\term{def:other}{type inference}.\nSee \\termref{def:comm-safety}{communication safety} and \\termref{def:hdl}{HDLs}.\n\n\\myparagraph{Type conformance} Next we study it.\n\n\\nparagraph{Overview}{Here it is.}";
  const text = bodyText(body, undefined, TERMS);
  assert.doesNotMatch(text, /\\|termref|hyperlink|textcolor|ifstrequal/);
  assert.match(text, /We define communication safety and type inference\./);
  assert.match(text, /See communication safety and HDLs\./);
  assert.match(text, /Type conformance\. ?Next we study it\./);
  assert.match(text, /Overview\. ?Here it is\./);
  // A click on any of them shows the use's source; \term and \termref (an \ifstrequal deciding) are the same.
  clickReveals(body, ".cm-vis-macro, .cm-vis-symbol, .cm-vis-heading", "\\term{def:comm-safety}{communication safety}", TERMS);
});

test("a stray \\hyperlink or \\hypertarget outside a macro prints its text, \\ifstrequal and \\ifblank decide on plain strings", () => {
  const text = bodyText("A \\hypertarget{t}{anchor text} and \\hyperlink{t}{link text}.\n\\ifstrequal{a}{b}{\\textbf{no}}{yes}", undefined, "\\usepackage{etoolbox}\\usepackage{hyperref}");
  assert.match(text, /A anchor text and link text\./);
  assert.doesNotMatch(text, /\\hyper/);
  assert.match(text, /yes/);
  // The caret in the hidden `\hyperlink{t}{` shows it again.
  const doc = inDocument("\\hyperlink{t}{link text}");
  const view = mount(doc, [], doc.indexOf("\\hyperlink") + 3);
  assert.match(lineTexts(view).join("\n"), /\\hyperlink\{t\}\{link text\}/);
  view.destroy();
  view.dom.parentElement?.remove();
});

const CREF_SHIM = `\\usepackage{cleveref}
\\makeatletter
\\newcommand{\\@creflabel}[1]{%
  \\expandafter\\ifx\\csname r@#1\\endcsname\\relax
    Ref.~\\ref{#1}%
  \\else
    Section~\\ref{#1}%
  \\fi
}
\\newcommand{\\Cref}[1]{%
  \\def\\@crefsep{}%
  \\@for\\@crefi:=#1\\do{\\@crefsep\\@creflabel{\\@crefi}\\def\\@crefsep{, }}%
}
\\newcommand{\\cref}[1]{\\Cref{#1}}
\\makeatother
`;

test("a \\cref shim built on \\csname and \\@for is drawn as the reference the editor draws itself (cs.AI 2611.13960)", () => {
  const body = "\\section{Setup}\\label{sec:setup}\nAs shown in \\cref{sec:setup}, it works.";
  const text = bodyText(body, undefined, CREF_SHIM);
  assert.doesNotMatch(text, /\\c?ref|csname/);
  assert.match(text, /As shown in .*1.*, it works[.]/);
  clickReveals(body, ".cm-vis-ref", "\\cref{sec:setup}", CREF_SHIM);
});

test("\\ding of a \\numexpr sum written out draws the pifont symbol (cs.DB 2610.38404)", () => {
  const preamble = "\\usepackage{pifont}\\usepackage{xcolor}\n\\newcommand{\\stepnum}[1]{\\textcolor[HTML]{B2182B}{\\ding{\\numexpr171+#1\\relax}}}\n";
  const text = bodyText("Step \\stepnum{1} then \\stepnum{3}.", undefined, preamble);
  assert.doesNotMatch(text, /stepnum|numexpr|\\ding/);
  assert.match(text, /Step .+ then .+[.]/);
});
