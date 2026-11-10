import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setMacroSources, setNumbering, setNumberingStart, visualDefinitions, type MacroSource } from "../../src/lib/latex/codemirror/visual/model";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexParser as parser } from "../../src/lib/latex/codemirror/latex-parser";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { collectLatexDefinitions, loadKey, macroAt, readLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { computeLatexNumbering, type NumberingStart } from "../../src/lib/latex/macros/numbering";
import { chapterNumberingStart } from "../../src/lib/latex/macros/project-numbering";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/* Multi-file projects, document classes and numbering across files (batch 5–7
 * papers: the book 2403.14606, the thesis 1709.01953, LongBench 2308.14508,
 * LIPIcs and LNCS papers). Each test is the smallest source showing the problem. */

/** The Visual mode's state for `doc`, with every pending piece built; `sources` are other files' definitions. */
function visualState(doc: string, extra: Extension[] = [], sources: MacroSource[] = [], start: NumberingStart | null = null) {
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexVisualMode({ documentPath: "nb/main.tex" }), ...extra] });
  if (sources.length || start) state = state.update({ effects: [setMacroSources.of(sources), setNumberingStart.of(start)] }).state;
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

/** The text a mounted Visual mode shows for `doc` (widgets' text included), numbered as the app numbers it. */
function visibleText(doc: string, sources: MacroSource[] = [], start: NumberingStart | null = null) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: visualState(doc, [], sources, start), parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state), { start });
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  const text = view.contentDOM.textContent ?? "";
  view.destroy();
  parent.remove();
  return text;
}

function number(source: string, options: Parameters<typeof computeLatexNumbering>[3] = {}, defs = readLatexDefinitions(source)) {
  return computeLatexNumbering(parser.parse(source), (from, to) => source.slice(from, to), defs, options);
}

test("an environment that opens a theorem in a frame is numbered and headed as the theorem (the book 2403.14606's boxdef, B5-02)", () => {
  const doc = String.raw`\documentclass{book}
\usepackage{amsthm,mdframed}
\newtheorem{definition}{Definition}[chapter]
\newenvironment{boxdef}[1]{%
\begin{definition}[#1]\begin{mdframed}[style=defsty]
}{%
\end{mdframed}\end{definition}}
\newenvironment{boxnote}[1][]{\begin{definition}[#1]\textbf{Note}}{\end{definition}}
\begin{document}
\chapter{Introduction}
\begin{definition}A plain one.\end{definition}
\begin{boxdef}{Differentiable programming}\label{def:dp}
Differentiable programming is a paradigm.
\end{boxdef}
See Definition~\ref{def:dp}.
\end{document}`;
  const numbering = number(doc);
  assert.equal(numbering.labels.get("def:dp")?.number, "1.2");
  assert.equal(numbering.labels.get("def:dp")?.env, "definition");
  const state = visualState(doc);
  assert.ok(constructs(state).some((construct) => construct.startsWith("env-header:")));
  const text = visibleText(doc);
  assert.match(text, /Definition 1\.2 \(Differentiable programming\)\. /);
  assert.match(text, /See Definition.1\.2\./);
  assert.doesNotMatch(text, /\\begin\{boxdef\}|mdframed/);
});

test("an environment whose code does more than open a theorem in a frame is not taken for the theorem", () => {
  const doc = String.raw`\newtheorem{definition}{Definition}
\newenvironment{noted}[1][]{\begin{definition}[#1]\textbf{Note}}{\end{definition}}
\newenvironment{mismatched}{\begin{definition}\begin{mdframed}}{\end{definition}}
\begin{document}
\begin{noted}[A]x\label{a}\end{noted}
\begin{mismatched}y\label{b}\end{mismatched}
\end{document}`;
  const numbering = number(doc);
  assert.equal(numbering.labels.get("a"), undefined);
  assert.equal(numbering.labels.get("b"), undefined);
  assert.doesNotMatch(visibleText(doc), /Definition 1/);
});

/** A project's files by notebook path, read as the workspace reads them. */
function project(files: Record<string, string>) {
  return { known: new Set(Object.keys(files)), readText: async (path: string) => files[path] ?? "" };
}

/** What the workspace gives a chapter: its macro sources and where its numbering starts (latex-workspace.tsx). */
async function chapterData(files: Record<string, string>, filePath: string, rootPath = "nb/main.tex") {
  const { collectMacroSources } = await import("../../src/components/libera/latex/latex-dependencies");
  const { known, readText } = project(files);
  const own = files[filePath];
  const { sources } = await collectMacroSources({ filePath, rootPath, ownPreamble: own.slice(0, Math.max(0, own.search(/\\begin\s*\{document\}/))), known, readText, version: () => "1" });
  const macroSources = sources.map((source) => ({ ...source, version: "1" }));
  const rootSource = sources.find((source) => source.path === rootPath);
  const base = rootSource ? collectLatexDefinitions(sources.map((source) => {
    const body = source === rootSource ? source.text.search(/\\begin\s*\{document\}/) : -1;
    return body >= 0 ? { ...source, text: source.text.slice(0, body) } : source;
  })) : undefined;
  const start = await chapterNumberingStart(filePath, rootPath, readText, base);
  return { sources: macroSources, start };
}

test("a chapter knows the macros its main file defines in its body before including it (2304.03442, B5-11)", async () => {
  const files = {
    "nb/main.tex": String.raw`\documentclass{article}
\newcommand{\pre}{P}
\begin{document}
\newcommand{\gentxt}[1]{\textbf{#1}}
{\newcommand{\scoped}{S}}
\begin{table}\renewcommand{\arraystretch}{2}\end{table}
\input{sections/intro}
\newcommand{\later}{L}
\input{sections/method}
\end{document}`,
    "nb/sections/intro.tex": String.raw`\section{Intro}\newcommand{\fromintro}{I}`,
    "nb/sections/method.tex": String.raw`\section{Method}
Text $\pre$ \gentxt{agent} and \fromintro{} but \later{} and \scoped{}.`,
  };
  const { sources } = await chapterData(files, "nb/sections/method.tex");
  const state = visualState(files["nb/sections/method.tex"], [], sources);
  const defs = visualDefinitions(state);
  for (const name of ["pre", "gentxt", "fromintro", "later"]) assert.ok(macroAt(defs, name, 30), name);
  // A definition local to a group of the main file's body ended there.
  assert.equal(macroAt(defs, "scoped", 30), null);
  assert.equal(macroAt(defs, "arraystretch", 30), null);
  const text = visibleText(files["nb/sections/method.tex"], sources);
  assert.match(text, /P agent and I(?:\{\})? but L(?:\{\})? and \\scoped/);
  // The intro, included before \later is defined, does not see it.
  const intro = await chapterData(files, "nb/sections/intro.tex");
  const introDefs = visualDefinitions(visualState(files["nb/sections/intro.tex"], [], intro.sources));
  assert.equal(macroAt(introDefs, "later", 5), null);
  assert.ok(macroAt(introDefs, "gentxt", 5));
});

test("a chapter is numbered with the formats and counters its main file sets in its body before including it (B4-03)", async () => {
  const files = {
    "nb/main.tex": String.raw`\documentclass{article}
\begin{document}
\section{Main}
\begin{table}\caption{Main}\label{tab:main}\end{table}
\input{results}
\appendix
\renewcommand{\thetable}{A\arabic{table}}
\setcounter{table}{0}
\renewcommand{\thesection}{S\arabic{section}}
\input{appendix}
\end{document}`,
    "nb/results.tex": String.raw`\section{Results}\begin{table}\caption{R}\label{tab:r}\end{table}`,
    "nb/appendix.tex": String.raw`\section{Proofs}\label{sec:proofs}
\begin{table}\caption{Extra}\label{tab:extra}\end{table}`,
  };
  const { sources, start } = await chapterData(files, "nb/appendix.tex");
  assert.equal(start?.counters.table, 0);
  assert.equal(start?.appendix, true);
  // The tables before the appendix keep their numbers, in this chapter's references too.
  assert.equal(start?.labels?.find(([key]) => key === "tab:r")?.[1].number, "2");
  const state = visualState(files["nb/appendix.tex"], [], sources, start);
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), visualDefinitions(state), { start });
  assert.equal(numbering.labels.get("tab:extra")?.number, "A1");
  assert.equal(numbering.labels.get("sec:proofs")?.number, "S1");
  // Without the main file's body, the appendix's format and the letters would be used instead.
  const results = await chapterData(files, "nb/results.tex");
  const resultsState = visualState(files["nb/results.tex"], [], results.sources, results.start);
  const resultsNumbering = computeLatexNumbering(syntaxTree(resultsState), (from, to) => resultsState.doc.sliceString(from, to), visualDefinitions(resultsState), { start: results.start });
  assert.equal(resultsNumbering.labels.get("tab:r")?.number, "2");
});

test("a section format made before \\appendix gives way to its letters in a chapter included after it", async () => {
  const files = {
    "nb/main.tex": String.raw`\documentclass{article}
\begin{document}
\renewcommand{\thesection}{\Roman{section}}
\section{One}
\appendix
\input{appendix}
\end{document}`,
    "nb/appendix.tex": String.raw`\section{Proofs}\label{sec:proofs}`,
  };
  const { sources, start } = await chapterData(files, "nb/appendix.tex");
  const state = visualState(files["nb/appendix.tex"], [], sources, start);
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), visualDefinitions(state), { start });
  assert.equal(numbering.labels.get("sec:proofs")?.number, "A");
});

test("a chapter included through another file gets that file's definitions up to its include", async () => {
  const files = {
    "nb/main.tex": String.raw`\documentclass{book}
\begin{document}
\include{toc}
\end{document}`,
    "nb/toc.tex": String.raw`\newcommand{\early}{E}
\input{chapters/one}
\newcommand{\late}{L}`,
    "nb/chapters/one.tex": String.raw`\chapter{One} \early \late`,
  };
  const { sources } = await chapterData(files, "nb/chapters/one.tex");
  const defs = visualDefinitions(visualState(files["nb/chapters/one.tex"], [], sources));
  assert.ok(macroAt(defs, "early", 5));
  assert.equal(macroAt(defs, "late", 5), null);
});

/** A main file's numbering with its body includes as the workspace collects them (latex-dependencies.ts, plugins.ts). */
async function mainNumbering(files: Record<string, string>, rootPath = "nb/main.tex") {
  const { collectBodyIncludes } = await import("../../src/components/libera/latex/latex-dependencies");
  const { known, readText } = project(files);
  const { includes } = await collectBodyIncludes({ filePath: rootPath, rootPath, text: files[rootPath], known, readText });
  const text = files[rootPath];
  return computeLatexNumbering(parser.parse(text), (from, to) => text.slice(from, to), readLatexDefinitions(text), {
    includes: (name) => {
      const included = includes.get(loadKey("input", name));
      return included === undefined ? null : { tree: parser.parse(included), read: (from, to) => included.slice(from, to) };
    },
  });
}

test("a main file's numbers count all the files its body includes, past 24 (2405.14734's tables, B6-02)", async () => {
  const files: Record<string, string> = {};
  const tables = Array.from({ length: 30 }, (_, index) => `tables/t${index}`);
  files["nb/main.tex"] = String.raw`\documentclass{article}
\begin{document}
\input{sections/body}
\begin{figure}\caption{Last}\label{fig:a}\end{figure}
\begin{table}\caption{Own}\label{tab:own}\end{table}
\end{document}`;
  files["nb/sections/body.tex"] = tables.map((name) => `\\input{${name}}`).join("\n");
  for (const [index, name] of tables.entries()) files[`nb/${name}.tex`] = String.raw`\begin{table}\caption{T${index}}\end{table}`;
  const numbering = await mainNumbering(files);
  assert.equal(numbering.labels.get("tab:own")?.number, "31");
  assert.equal(numbering.labels.get("fig:a")?.number, "1");
});

test("files the import package includes are numbered and lead to their chapters (B5-13)", async () => {
  const files = {
    "nb/main.tex": String.raw`\documentclass{article}
\usepackage{import}
\begin{document}
\import{chapters/}{intro}
\subimport*{chapters/}{method}
\section{End}\label{sec:end}
\end{document}`,
    "nb/chapters/intro.tex": String.raw`\section{Intro}\input{details}`,
    "nb/chapters/details.tex": String.raw`\section{Details}`,
    "nb/chapters/method.tex": String.raw`\section{Method}\label{sec:method}`,
  };
  const numbering = await mainNumbering(files);
  assert.equal(numbering.labels.get("sec:method")?.number, "3");
  assert.equal(numbering.labels.get("sec:end")?.number, "4");
  const { start } = await chapterData(files, "nb/chapters/method.tex");
  assert.equal(start?.counters.section, 2);
});

test("a subfiles chapter is numbered and defined from the main file its class option names (B5-14)", async () => {
  const { subfilesRootPath } = await import("../../src/lib/latex/project");
  const files = {
    "nb/main.tex": String.raw`\documentclass{book}
\usepackage{subfiles}
\newcommand{\R}{\mathbb{R}}
\begin{document}
\subfile{chapters/one}
\subfile{chapters/two}
\end{document}`,
    "nb/chapters/one.tex": String.raw`\documentclass[../main.tex]{subfiles}
\begin{document}
\chapter{One}
\end{document}`,
    "nb/chapters/two.tex": String.raw`\documentclass[../main.tex]{subfiles}
\begin{document}
\chapter{Two}\label{ch:two}
\section{Reals}\label{sec:reals} $\R$
\end{document}`,
  };
  assert.equal(subfilesRootPath("nb/chapters/two.tex", files["nb/chapters/two.tex"], new Set(Object.keys(files))), "nb/main.tex");
  assert.equal(subfilesRootPath("nb/main.tex", files["nb/main.tex"]), null);
  const { sources, start } = await chapterData(files, "nb/chapters/two.tex");
  assert.equal(start?.counters.chapter, 1);
  const state = visualState(files["nb/chapters/two.tex"], [], sources, start);
  const defs = visualDefinitions(state);
  assert.equal(defs.documentClass, "book");
  assert.ok(macroAt(defs, "R", 100));
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), defs, { start });
  assert.equal(numbering.labels.get("ch:two")?.number, "2");
  assert.equal(numbering.labels.get("sec:reals")?.number, "2.1");
  // The main file counts its subfiles' chapters.
  const main = await mainNumbering({ ...files, "nb/main.tex": files["nb/main.tex"].replace("\\end{document}", "\\chapter{Three}\\label{ch:three}\n\\end{document}") });
  assert.equal(main.labels.get("ch:three")?.number, "3");
});

test("theorems a well-known class defines are drawn and numbered as the class numbers them (llncs, LIPIcs, acmart: B5-05, B7-12)", () => {
  const body = String.raw`\begin{document}
\section{One}
\begin{theorem}\label{t1}A.\end{theorem}
\begin{lemma}\label{l1}B.\end{lemma}
\begin{remark}\label{r1}C.\end{remark}
\end{document}`;
  /** The theorems numbered, as "environment number". */
  const theorems = (preamble: string) => number(`${preamble}\n${body}`).entries.filter((entry) => entry.kind === "theorem").map((entry) => `${entry.env} ${entry.number}`);
  assert.deepEqual(theorems(String.raw`\documentclass[runningheads]{llncs}`), ["theorem 1", "lemma 1", "remark 1"]);
  assert.deepEqual(theorems(String.raw`\documentclass[envcountsame]{llncs}`), ["theorem 1", "lemma 2", "remark 3"]);
  assert.deepEqual(theorems(String.raw`\documentclass[envcountsect]{llncs}`), ["theorem 1.1", "lemma 1.1", "remark 1.1"]);
  assert.deepEqual(theorems(String.raw`\documentclass[a4paper,UKenglish,cleveref,thm-restate]{lipics-v2021}`), ["theorem 1", "lemma 2", "remark 3"]);
  assert.deepEqual(theorems(String.raw`\documentclass[numberwithinsect]{lipics-v2021}`), ["theorem 1.1", "lemma 1.2", "remark 1.3"]);
  // acmart has no remark; its theorems are numbered in sections.
  assert.deepEqual(theorems(String.raw`\documentclass[sigconf]{acmart}`), ["theorem 1.1", "lemma 1.2"]);
  assert.deepEqual(theorems(String.raw`\documentclass[sigconf,acmthm=false]{acmart}`), []);
  // amsart defines none; a document's own definition wins over the class's.
  assert.deepEqual(theorems(String.raw`\documentclass{amsart}`), []);
  assert.deepEqual(theorems(String.raw`\documentclass{acmart}
\newtheorem{lemma}{Lemma}`), ["theorem 1.1", "lemma 1"]);
  const doc = String.raw`\documentclass{llncs}
${body}`;
  const text = visibleText(doc);
  assert.match(text, /Theorem 1\. A\./);
  assert.match(text, /Remark 1\. C\./);
});

test("a class the project has gives its theorems (the book 2403.14606's nowfnt.cls, B5-05)", async () => {
  const files = {
    "nb/nowfnt.cls": String.raw`\NeedsTeXFormat{LaTeX2e}
\RequirePackage{amsthm}
\newtheoremstyle{now}{}{}{}{}{\sffamily\bfseries}{.}{.5em}{}
\theoremstyle{now}
\ifbool{@nowfntplain}
{\newtheorem{theorem}{Theorem}[section]
 \newtheorem{definition}{Definition}[section]
 }
{
 \newtheorem{theorem}{Theorem}[chapter]
 \newtheorem{lemma}[theorem]{Lemma}
 \newtheorem{definition}{Definition}[chapter]
}
\def\@spn#1{\newtheorem{#1}{X}}
% \newtheorem{commented}{Commented}`,
    "nb/main.tex": String.raw`\documentclass[MAL, biber]{nowfnt}
\newenvironment{boxdef}[1]{\begin{definition}[#1]\begin{mdframed}}{\end{mdframed}\end{definition}}
\begin{document}
\chapter{Intro}
\input{chapters/one}
\end{document}`,
    "nb/chapters/one.tex": String.raw`\begin{theorem}\label{t}A.\end{theorem}
\begin{lemma}\label{l}B.\end{lemma}
\begin{boxdef}{Programs}\label{d}C.\end{boxdef}`,
  };
  const { sources, start } = await chapterData(files, "nb/chapters/one.tex");
  assert.equal(sources[0].path, "nb/nowfnt.cls");
  const state = visualState(files["nb/chapters/one.tex"], [], sources, start);
  const defs = visualDefinitions(state);
  assert.deepEqual([...defs.theorems.keys()].sort(), ["definition", "lemma", "theorem"]);
  const numbering = computeLatexNumbering(syntaxTree(state), (from, to) => state.doc.sliceString(from, to), defs, { start });
  assert.deepEqual(["t", "l", "d"].map((key) => numbering.labels.get(key)?.number), ["1.1", "1.2", "1.1"]);
  assert.match(visibleText(files["nb/chapters/one.tex"], sources, start), /Definition 1\.1 \(Programs\)\. C\./);
});

/** A small book whose chapters use what numbering keeps between files: appendix, formats, counters, labels after includes. */
const BOOK: Record<string, string> = {
  "main.tex": String.raw`\documentclass{book}
\newtheorem{theorem}{Theorem}[chapter]
\newcommand{\beq}{\begin{equation}}
\newcommand{\eeq}{\end{equation}}
\begin{document}
\chapter{Start}\label{ch:start}
\input{chapters/one}\label{after:one}
\numberwithin{figure}{section}
\begin{center}\input{chapters/two}\label{after:two}\end{center}
\renewcommand{\thetheorem}{\thechapter.\Roman{theorem}}
\input{chapters/three}
\input{chapters/one}
\end{document}`,
  "chapters/one.tex": String.raw`\chapter{One}\label{ch:one}
\section{A}\begin{theorem}\label{thm:a}x\end{theorem}
\beq a \label{eq:a}\eeq
\begin{figure}\caption{F}\label{fig:one}\end{figure}
\input{chapters/one-more}`,
  "chapters/one-more.tex": String.raw`\section{More}\label{sec:more}\footnote{n}`,
  "chapters/two.tex": String.raw`\chapter{Two}\begin{figure}\caption{G}\label{fig:two}\end{figure}\setcounter{theorem}{4}`,
  "chapters/three.tex": String.raw`\appendix\chapter{Proofs}\label{ch:proofs}\begin{theorem}\label{thm:b}y\end{theorem}`,
};

test("an included file's numbering is remembered by the state it starts from, with the same numbers as numbering it again (B5-19)", () => {
  const trees = new Map<string, { tree: ReturnType<typeof parser.parse>; read: (from: number, to: number) => string }>();
  const remembered = (name: string) => {
    const text = BOOK[`${name}.tex`];
    if (text === undefined) return null;
    let file = trees.get(name);
    if (!file) trees.set(name, file = { tree: parser.parse(text), read: (from, to) => text.slice(from, to) });
    return file;
  };
  const fresh = (name: string) => {
    const text = BOOK[`${name}.tex`];
    return text === undefined ? null : { tree: parser.parse(text), read: (from: number, to: number) => text.slice(from, to) };
  };
  const numberMain = (text: string, includes: typeof fresh) => computeLatexNumbering(parser.parse(text), (from, to) => text.slice(from, to), readLatexDefinitions(text), { includes });
  const summary = (numbering: ReturnType<typeof numberMain>) => JSON.stringify([numbering.fingerprint, [...numbering.labels], numbering.counters, numbering.appendix]);
  const main = BOOK["main.tex"];
  const first = numberMain(main, remembered);
  assert.equal(first.labels.get("thm:b")?.number, "A.I");
  assert.equal(first.labels.get("fig:two")?.number, "3.0.1");
  assert.equal(first.labels.get("after:one")?.number, "2.2");
  assert.equal(summary(first), summary(numberMain(main, fresh)));
  // Again, from what was remembered; and after edits before, between and inside the includes.
  assert.equal(summary(numberMain(main, remembered)), summary(first));
  for (const edited of [
    main.replace("\\chapter{Start}", "Some text. \\chapter{Start}"),
    main.replace("\\chapter{Start}", "\\chapter{Start}\\chapter{Again}"),
    main.replace("\\numberwithin{figure}{section}", ""),
    main.replace("\\Roman{theorem}", "\\alph{theorem}"),
    main.replace("\\begin{center}", "\\begin{center}\\section{Inside}"),
    main.replace("\\input{chapters/three}", "\\setcounter{chapter}{7}\\input{chapters/three}"),
  ]) assert.equal(summary(numberMain(edited, remembered)), summary(numberMain(edited, fresh)), edited);
  // A file it includes changed: what was remembered for the file including it is not used.
  BOOK["chapters/one-more.tex"] = String.raw`\section{More}\section{Even more}\label{sec:more}`;
  try {
    trees.delete("chapters/one-more");
    assert.equal(summary(numberMain(main, remembered)), summary(numberMain(main, fresh)));
    assert.equal(numberMain(main, remembered).labels.get("sec:more")?.number, "B.3");
  } finally {
    BOOK["chapters/one-more.tex"] = String.raw`\section{More}\label{sec:more}\footnote{n}`;
  }
});

test("a chapter's start is the same when the project is numbered again after an edit, parsed only where it changed (B5-18)", async () => {
  const files = (prefix: string, extra = "") => Object.fromEntries(Object.entries(BOOK).map(([path, text]) => [`${prefix}/${path}`, path === "chapters/two.tex" ? text + extra : text]));
  const start = (prefix: string, extra = "") => {
    const { readText } = project(files(prefix, extra));
    return chapterNumberingStart(`${prefix}/chapters/three.tex`, `${prefix}/main.tex`, readText);
  };
  const first = await start("nb");
  assert.equal(first?.counters.chapter, 3);
  assert.equal(first?.counters.theorem, 4);
  assert.deepEqual(await start("nb"), first);
  // Edits of a chapter before it and of the chapter itself: the same as numbering a project seen for the first time.
  for (const [index, extra] of ["\\chapter{Extra}\\label{ch:extra}", "\\section{S}\\begin{theorem}t\\end{theorem}", ""].entries()) {
    assert.deepEqual(await start("nb", extra), await start(`fresh${index}`, extra));
  }
});

void collectLatexDefinitions;
