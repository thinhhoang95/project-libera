import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Title blocks of publishers' classes (revtex, acmart, llncs, svjour3, elsarticle, sn-jnl, IEEEtran, mnras, AAAI): what
 * each class prints besides the names, each line editable in place; a command the block does not know stays source
 * alone. The class files are not in the project: only what the Visual mode knows of the classes is in play. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The Visual mode's state for `doc`, with every pending piece built. */
function visualState(doc: string, extra: Extension[] = []) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [history(), latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  return state;
}

function mount(doc: string, extra: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, extra), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return view;
}

/** What a mounted Visual mode shows: the title block's parts ("part index: text"), the other lines' text, and the source it shows. */
function shown(doc: string, extra: Extension[] = []) {
  const view = mount(doc, extra);
  const block = view.contentDOM.querySelector(".cm-vis-title-block");
  const parts = block ? [...block.querySelectorAll<HTMLElement>("[data-title-part], .cm-vis-title-note")].map((node) => `${node.dataset.titlePart ?? "note"}${node.dataset.titleIndex ?? ""}: ${(node.textContent ?? "").replace(/\s+/g, " ").trim()}`) : [];
  const lines = [...view.contentDOM.querySelectorAll(".cm-line")].filter((line) => !line.querySelector(".cm-vis-title-block")).map((line) => line.textContent ?? "").filter((text) => text.trim());
  view.destroy();
  view.dom.parentElement?.remove();
  return { parts, lines, text: lines.join("\n") };
}

const press = (target: Element, key: string, init: Record<string, unknown> = {}) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const typeInto = (area: HTMLTextAreaElement, value: string) => { area.value = value; area.dispatchEvent(new window.Event("input", { bubbles: true })); };
const click = (node: Element) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
const part = (view: EditorView, name: string, index = 0) => view.contentDOM.querySelector<HTMLElement>(`.cm-vis-title-block [data-title-part="${name}"][data-title-index="${index}"]`)!;

const BODY = "\n\\section{Introduction}\nBody text.\n\\end{document}\n";

const REVTEX = String.raw`\documentclass[aps,prl]{revtex4-2}
\begin{document}
\preprint{APS/123-QED}
\title{A Revtex Title}
\author{Alice One}
\email{alice@x.org}
\altaffiliation{Also at Somewhere}
\affiliation{University A}
\author{Bob Two}
\affiliation{University A}
\author{Carol Three}
\homepage{http://c.org}
\affiliation{University B}
\collaboration{The XYZ Collaboration}
\pacs{12.34.Ab}
\date{June 2025}
\begin{abstract}
An abstract.
\end{abstract}
\maketitle
` + BODY;

test("revtex: each author's affiliations (a shared one, a different one), email, homepage; the preprint, collaboration and PACS lines; nothing left as source", () => {
  const { parts, text } = shown(REVTEX);
  assert.deepEqual(parts, [
    "title0: A Revtex Title",
    "author0: Alice One", "line0: Email: alice@x.org", "line1: Also at Somewhere", "line2: University A",
    "author1: Bob Two", "line3: University A",
    "author2: Carol Three", "line4: URL: http://c.org", "line5: University B",
    "date0: June 2025", "abstract0: An abstract.",
    "line6: Preprint: APS/123-QED", "line7: Collaboration: The XYZ Collaboration", "line8: PACS: 12.34.Ab",
  ]);
  assert.doesNotMatch(text, /\\(?:title|author|affiliation|pacs|preprint)/);
  assert.match(text, /1\s*Introduction/);
});

test("principle 1: one command the title run does not know stays source alone; the declarations around it stay drawn", () => {
  const doc = REVTEX.replace("\\author{Bob Two}", "\\mystery{Something}\n\\author{Bob Two}");
  const { parts, lines } = shown(doc);
  assert.ok(parts.includes("author1: Bob Two"));
  assert.ok(parts.includes("line5: University B"), "the affiliation after the unknown command is still read");
  assert.deepEqual(lines.filter((line) => line.includes("\\")), ["\\mystery{Something}"]);
  assert.doesNotMatch(lines.join("\n"), /A Revtex Title|\\author|\\affiliation/);
});

test("an affiliation is edited in place: Enter writes only it, as one undo step; Tab goes on to the next part", () => {
  const view = mount(REVTEX);
  click(part(view, "line", 5));
  let area = view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor")!;
  assert.equal(area.value, "University B");
  typeInto(area, "University of B");
  press(area, "Enter");
  assert.equal(view.state.doc.toString(), REVTEX.replace("\\affiliation{University B}", "\\affiliation{University of B}"));
  assert.match(part(view, "line", 5).textContent ?? "", /University of B/);
  undo(view);
  assert.equal(view.state.doc.toString(), REVTEX);
  // The email under Alice, then Tab: saved, and the next part (her other affiliation line) opens.
  click(part(view, "line", 0));
  area = view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor")!;
  assert.equal(area.value, "alice@x.org");
  typeInto(area, "alice@y.org");
  press(area, "Tab");
  assert.match(view.state.doc.toString(), /\\email\{alice@y\.org\}/);
  view.destroy();
});

test("acmart: subtitle, ORCID, author note, email and the affiliation's parts as one line, each editable", () => {
  const doc = String.raw`\documentclass[sigconf]{acmart}
\begin{document}
\title{An ACM Title}
\subtitle{A subtitle}
\author{Alice One}
\orcid{0000-0001}
\authornote{Both authors contributed equally.}
\email{alice@x.org}
\affiliation{%
  \institution{University A}
  \city{Paris}
  \country{France}}
\author{Bob Two}
\authornotemark[1]
\email{bob@y.org}
\affiliation{\institution{University B}\city{Rome}\country{Italy}}
\renewcommand{\shortauthors}{One and Two}
\maketitle
` + BODY;
  assert.deepEqual(shown(doc).parts, [
    "title0: An ACM Title", "line0: A subtitle",
    "author0: Alice One", "line1: ORCID: 0000-0001", "line2: Note: Both authors contributed equally.", "line3: Email: alice@x.org", "line4: University A, Paris, France",
    "author1: Bob Two", "line5: Email: bob@y.org", "line6: University B, Rome, Italy",
  ]);
  const view = mount(doc);
  click(part(view, "line", 6));
  assert.equal(view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor")!.value, "\\institution{University B}\\city{Rome}\\country{Italy}");
  view.destroy();
});

test("llncs and svjour3: \\inst marks, numbered institutes split at \\and, keywords separated by a dot, not \\and", () => {
  const llncs = shown(String.raw`\documentclass[runningheads]{llncs}
\begin{document}
\title{An LNCS Title}
\author{Alice One\inst{1}\orcidID{0000-0001} \and Bob Two\inst{2}}
\authorrunning{A. One and B. Two}
\institute{University A, Paris, France\\
\email{alice@x.org} \and
University B, Rome, Italy}
\maketitle
\begin{abstract}
An abstract.
\keywords{First \and Second \and Third.}
\end{abstract}
` + BODY);
  assert.deepEqual(llncs.parts, ["title0: An LNCS Title", "author0: Alice One1", "author1: Bob Two2", "line0: 1 University A, Paris, France alice@x.org", "line1: 2 University B, Rome, Italy"]);
  assert.match(llncs.text, /Keywords: First · Second · Third\./);
  assert.doesNotMatch(llncs.text, /\\and/);
  const svjour = shown(String.raw`\documentclass{svjour3}
\begin{document}
\title{An SV Title}
\subtitle{The subtitle}
\author{Alice One \and Bob Two}
\institute{A. One \at University A \\ \email{alice@x.org}
\and B. Two \at University B}
\maketitle
` + BODY);
  assert.deepEqual(svjour.parts.slice(0, 4), ["title0: An SV Title", "line0: The subtitle", "author0: Alice One", "author1: Bob Two"]);
  assert.match(svjour.parts[4], /^line1: 1 A\. One\s*University A\s*e-mail: alice@x\.org$/);
});

const ELSARTICLE = String.raw`\documentclass{elsarticle}
\begin{document}
\begin{frontmatter}
\title{An Elsevier Title\tnoteref{t1}}
\tnotetext[t1]{This is a title note.}
\author[a]{Alice One\corref{cor1}}
\ead{alice@x.org}
\author[a,b]{Bob Two}
\cortext[cor1]{Corresponding author}
\address[a]{University A}
\address[b]{University B}
\begin{abstract}
An abstract.
\end{abstract}
\begin{keyword}
First \sep Second
\end{keyword}
\end{frontmatter}
` + BODY;

test("elsarticle: labelled addresses (shared and own), \\ead, the title and corresponding-author notes; \\sep as a comma", () => {
  const { parts, text } = shown(ELSARTICLE);
  assert.deepEqual(parts, [
    "title0: An Elsevier Title☆", "author0: Alice One", "line0: University A", "line1: Email: alice@x.org",
    "author1: Bob Two", "line2: University A", "line3: University B", "line4: ☆ This is a title note.", "line5: ∗ Corresponding author",
  ]);
  assert.match(text, /First, Second/);
  assert.doesNotMatch(text, /\\(?:sep|address|author)/);
  // The shared address, edited from Bob's line, is the one `\address[a]`.
  const view = mount(ELSARTICLE);
  click(part(view, "line", 2));
  const area = view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor")!;
  typeInto(area, "University A2");
  press(area, "Enter");
  assert.equal(view.state.doc.toString(), ELSARTICLE.replace("\\address[a]{University A}", "\\address[a]{University A2}"));
  view.destroy();
});

test("elsarticle: a command the front matter does not know stays source alone, the rest of the front matter stays drawn", () => {
  const doc = ELSARTICLE.replace("\\cortext[cor1]", "\\mystery{x}\n\\cortext[cor1]");
  const { parts, lines } = shown(doc);
  assert.ok(parts.includes("line3: University B"));
  assert.ok(parts.includes("line5: ∗ Corresponding author"));
  assert.deepEqual(lines.filter((line) => line.includes("\\")), ["\\mystery{x}"]);
  // Its lines are still edited where they are written, after the unknown command.
  const view = mount(doc);
  click(part(view, "line", 3));
  assert.equal(view.contentDOM.querySelector<HTMLTextAreaElement>(".cm-vis-title-editor")!.value, "University B");
  view.destroy();
});

test("sn-jnl: \\author*[1], name parts, \\affil labels and emails; its \\abstract command is the block's abstract", () => {
  const { parts, text } = shown(String.raw`\documentclass[pdflatex,sn-mathphys-num]{sn-jnl}
\begin{document}
\title[Short]{A Springer Nature Title}
\author*[1]{\fnm{Alice} \sur{One}}\email{alice@x.org}
\author[2]{\fnm{Bob} \sur{Two}}\email{bob@y.org}
\affil*[1]{\orgdiv{Dept A}, \orgname{University A}, \orgaddress{\city{Paris}, \country{France}}}
\affil[2]{\orgname{University B}, \orgaddress{\city{Rome}, \country{Italy}}}
\abstract{An abstract.}
\keywords{a, b, c}
\maketitle
` + BODY);
  assert.deepEqual(parts, [
    "title0: A Springer Nature Title", "author0: Alice One", "line0: Dept A, University A, Paris, France", "line1: Email: alice@x.org",
    "author1: Bob Two", "line2: University B, Rome, Italy", "line3: Email: bob@y.org", "abstract0: An abstract.", "note: Keywords: a, b, c",
  ]);
  assert.doesNotMatch(text, /\\|Keywords/);
});

test("IEEEtran's \\IEEEPARstart draws its letters; MNRAS's \\pagerange and \\bsp print nothing; AAAI's \\affiliations is drawn", () => {
  assert.match(shown(String.raw`\documentclass[conference]{IEEEtran}
\begin{document}
\IEEEPARstart{T}{his} paper is about things.
\end{document}`).text, /^This paper is about things\.$/m);
  const mnras = shown(String.raw`\documentclass{mnras}
\title{An MNRAS Title}
\author[A. One]{Alice One}
\begin{document}
\pagerange{\pageref{firstpage}--\pageref{lastpage}}
\maketitle
Text.
\bsp
\end{document}`);
  assert.doesNotMatch(mnras.text, /pagerange|bsp|\?/);
  const aaai = shown(String.raw`\documentclass[letterpaper]{article}
\usepackage{aaai25}
\title{An AAAI Title}
\author{Alice One\textsuperscript{\rm 1}, Bob Two\textsuperscript{\rm 2}}
\affiliations{\textsuperscript{\rm 1}University A\\ \textsuperscript{\rm 2}University B}
\begin{document}
\maketitle
` + BODY);
  assert.match(aaai.parts.at(-1)!, /^line0: 1University A\s*2University B$/);
});

test("principle 2: a title block being typed stays source until complete, without spilling into the body", () => {
  const steps = [
    "\\title{A Ti",
    "\\title{A Title}\n\\author{A \\and",
    "\\title{A Title}\n\\author{A \\and B}",
  ];
  for (const [index, step] of steps.entries()) {
    const doc = `\\documentclass{revtex4-2}\n\\begin{document}\n${step}\n\\maketitle\n${BODY}`;
    const view = mount(doc);
    assert.equal(view.state.doc.toString(), doc);
    const text = view.contentDOM.textContent ?? "";
    // The body after it is drawn as before.
    assert.match(text, /1\s*Introduction/, `step ${index}`);
    view.destroy();
  }
  // elsarticle's front matter without its end: source, and the section after it is drawn.
  const open = "\\documentclass{elsarticle}\n\\begin{document}\n\\begin{frontmatter}\n\\title{T}\n\\author{A}\n" + BODY;
  const view = mount(open);
  assert.equal(view.contentDOM.querySelector(".cm-vis-title-block"), null);
  assert.match(view.contentDOM.textContent ?? "", /\\title\{T\}/);
  view.destroy();
});
