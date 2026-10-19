import "./setup.cjs";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { snippet } from "@codemirror/autocomplete";
import { history, undo, redo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseBibtexLog, parseLatexLog } from "../../src/lib/latex/log-parser";
import {
  hasDocumentClass, readBibEntries, readLatexBibliographyReferences, readLatexMagicComments, readLatexOutline,
  resolveLatexEngine, resolveLatexRootPath, resolveRelativeNotebookPath, stripLatexComments,
} from "../../src/lib/latex/project";
import { readLatexIncludes } from "../../src/lib/latex/root";
import { notebookPathForTexFile } from "../../src/lib/latex/build";
import { normalizeLatexOutput } from "../../src/lib/latex/ai-prompts";
import { LATEX_COMMANDS } from "../../src/lib/latex/codemirror/latex-data";
import { findMathRegion, readPreviewMacros } from "../../src/lib/latex/codemirror/math";
import { handleLatexInput, openEnvironmentsAt, syncEnvironmentNames } from "../../src/lib/latex/codemirror/editing";
import { applyAiProposal, decideReviewHunks, diffTexts, latexReviewExtension, reviewHunksField } from "../../src/lib/latex/codemirror/review";
import { compiledLocationForPosition, latexSyncExtension, markCompileShown, markCompileStarted, positionForCompiledLine } from "../../src/lib/latex/codemirror/sync";
import { latexFoldRange, latexLanguage } from "../../src/lib/latex/codemirror/language";
import type { LatexEditorHandle } from "../../src/components/libera/latex/latex-editor";
import type { LatexTabViewState } from "../../src/components/libera/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function mount(doc: string, extensions = [history(), latexReviewExtension(), latexSyncExtension()]) {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({ state: EditorState.create({ doc, extensions }), parent });
}

/* ---- Log parsing --------------------------------------------------------------- */

test("TeX logs become diagnostics with files, lines and severities", () => {
  const log = [
    "(/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls",
    "Document Class: article 2024/06/29 v1.4n Standard LaTeX document class",
    ")",
    "/tmp/build/main.tex:5: Undefined control sequence.",
    "l.5 Hello \\undefinedcommand",
    "                           {x} world.",
    "",
    "LaTeX Warning: Reference `sec:missing' on page 1 undefined on input line 5.",
    "",
    "(./chapters/one.tex",
    "Overfull \\hbox (180.36934pt too wide) detected at line 7",
    "! Missing $ inserted.",
    "<inserted text> ",
    "                $",
    "l.9 x^",
    "      2",
    "",
    ")",
    "Package epstopdf Warning: Shell escape feature is not enabled.",
    "",
    "Package natbib Warning: Citation `knuth' on page 1 undefined on input line 12.",
    "",
    "! Emergency stop.",
    "<*> main.tex",
  ].join("\n");
  const entries = parseLatexLog(log, "/tmp/build/main.tex");
  assert.deepEqual(entries.find((entry) => entry.message === "Undefined control sequence."), {
    severity: "error", message: "Undefined control sequence.", details: "l.5 Hello \\undefinedcommand\n                           {x} world.", file: "/tmp/build/main.tex", line: 5,
  });
  assert.equal(entries.find((entry) => entry.message.startsWith("Reference"))?.line, 5);
  const missingDollar = entries.find((entry) => entry.message === "Missing $ inserted.");
  assert.equal(missingDollar?.file, "./chapters/one.tex");
  assert.equal(missingDollar?.line, 9);
  assert.equal(entries.find((entry) => entry.message.startsWith("Overfull"))?.severity, "info");
  assert.equal(entries.find((entry) => entry.message.includes("epstopdf"))?.severity, "info", "shell escape is off on purpose");
  assert.equal(entries.find((entry) => entry.message.includes("natbib"))?.line, 12);
  assert.ok(!entries.some((entry) => entry.message === "Emergency stop."), "the follow-up stop is noise once a real error is known");
});

test("BibTeX logs point at the database line", () => {
  const entries = parseBibtexLog([
    "Database file #1: refs.bib",
    "I was expecting a `,' or a `}'---line 3 of file refs.bib",
    " :   title = {The TeXbook",
    "Warning--I didn't find a database entry for \"nokey\"",
  ].join("\n"));
  assert.deepEqual(entries[0], { severity: "error", message: "I was expecting a `,' or a `}'", file: "refs.bib", line: 3 });
  assert.equal(entries[1].severity, "warning");
  assert.match(entries[1].message, /nokey/);
});

/* ---- Project helpers -------------------------------------------------------------- */

test("engines follow magic comments, then packages, then the user's choice", () => {
  assert.equal(resolveLatexEngine("% !TEX program = xelatex\n\\documentclass{article}"), "xelatex");
  assert.equal(resolveLatexEngine("% !TeX TS-program = lualatex\n"), "lualatex");
  assert.equal(resolveLatexEngine("\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\\end{document}"), "xelatex");
  assert.equal(resolveLatexEngine("\\documentclass{article}\n% \\usepackage{fontspec}\n\\begin{document}"), "pdflatex", "commented packages are ignored");
  assert.equal(resolveLatexEngine("\\documentclass{article}", "lualatex"), "lualatex");
});

test("relative paths stay inside the notebook and roots resolve from magic comments", () => {
  assert.equal(resolveRelativeNotebookPath("Thesis/chapters/one.tex", "../main.tex"), "Thesis/main.tex");
  assert.equal(resolveRelativeNotebookPath("Thesis/main.tex", "../Other/secret.tex"), null);
  const known = new Set(["Thesis/main.tex", "Thesis/chapters/one.tex"]);
  assert.equal(resolveLatexRootPath("Thesis/chapters/one.tex", "% !TEX root = ../main\nText", known), "Thesis/main.tex");
  assert.equal(resolveLatexRootPath("Thesis/chapters/one.tex", "% !TEX root = ../missing.tex\n", known), "Thesis/chapters/one.tex");
  assert.deepEqual(readLatexMagicComments("% !TEX root = main.tex\n% !TEX program = pdflatex"), { root: "main.tex", program: "pdflatex" });
});

test("documents, outlines, bibliographies and includes are read from the source", () => {
  assert.equal(hasDocumentClass("% \\documentclass{article}\n\\section{A}"), false);
  assert.equal(hasDocumentClass("\\documentclass[11pt]{article}"), true);
  assert.equal(stripLatexComments("50\\% done % note"), "50\\% done ");
  assert.deepEqual(readLatexOutline("\\section{Intro}\n% \\section{Hidden}\n\\subsection*{The \\emph{Method}}\n\\chapter[Short]{Long title}").map(({ level, title, line }) => ({ level, title, line })), [
    { level: 2, title: "Intro", line: 1 },
    { level: 3, title: "The Method", line: 3 },
    { level: 1, title: "Long title", line: 4 },
  ]);
  const entries = readBibEntries("@comment{x}\n@book{knuth,\n  title = {The {\\TeX}book},\n  year = 1984\n}\n@article{lamport, author={L. Lamport}}");
  assert.deepEqual(entries.map((entry) => [entry.key, entry.title, entry.year]), [["knuth", "The \\TeXbook", "1984"], ["lamport", undefined, undefined]]);
  assert.deepEqual(readLatexBibliographyReferences("\\bibliography{refs, more}\n\\addbibresource{extra.bib}"), ["refs.bib", "more.bib", "extra.bib"]);
  assert.deepEqual(readLatexIncludes("\\input{chapters/one}\n\\include{two.tex}\n% \\input{skip}\n\\subimport{parts/}{three}"), [
    { path: "chapters/one.tex", relativeToFile: false },
    { path: "two.tex", relativeToFile: false },
    { path: "parts/three.tex", relativeToFile: true },
  ]);
});

test("TeX file names map back to notebook paths through symbolic links", () => {
  const meta = {
    rootPath: "Thesis/main.tex", rootDirectoryPath: "Thesis", jobName: "main",
    sourceDirectory: "/data/Thesis", workDirectory: "/var/build/work",
    realDirectories: { source: "/data/Thesis", work: "/private/var/build/work" },
    overrides: ["chapters/one.tex"],
  };
  assert.equal(notebookPathForTexFile("/var/build/work/main.tex", meta), "Thesis/main.tex");
  assert.equal(notebookPathForTexFile("/private/var/build/work/chapters/one.tex", meta), "Thesis/chapters/one.tex");
  assert.equal(notebookPathForTexFile("/private/var/build/work/main.aux", meta), undefined);
  assert.equal(notebookPathForTexFile("./chapters/two.tex", meta), "Thesis/chapters/two.tex");
  assert.equal(notebookPathForTexFile("/data/Thesis/./figures/plot.tex", meta), "Thesis/figures/plot.tex");
  assert.equal(notebookPathForTexFile("/usr/local/texlive/article.cls", meta), undefined);
});

test("AI output loses a wrapping LaTeX code fence", () => {
  assert.equal(normalizeLatexOutput("```latex\n\\section{A}\nText\n```"), "\\section{A}\nText");
  assert.equal(normalizeLatexOutput("Plain \\LaTeX"), "Plain \\LaTeX");
});

/* ---- Editor behavior -------------------------------------------------------------- */

test("returning to a scrolled LaTeX tab refreshes its viewport without a scroll event", async (context) => {
  Object.defineProperty(globalThis, "Window", { value: dom.window.Window, configurable: true });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(dom.window.Range.prototype, {
    getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect(),
  });
  const { LatexEditor } = await import("../../src/components/libera/latex/latex-editor");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const editorRef = { current: null as LatexEditorHandle | null };
  const source = "A line of LaTeX source.\n".repeat(300);
  let saved: LatexTabViewState = {};
  const measurements: { view: EditorView; top: number; left: number }[] = [];
  const requestMeasure = EditorView.prototype.requestMeasure;
  context.mock.method(EditorView.prototype, "requestMeasure", function (this: EditorView, ...args: Parameters<EditorView["requestMeasure"]>) {
    measurements.push({ view: this, top: this.scrollDOM.scrollTop, left: this.scrollDOM.scrollLeft });
    return requestMeasure.apply(this, args);
  });
  async function openTab() {
    await act(async () => root.render(createElement(StrictMode, null, createElement(LatexEditor, {
      documentPath: "Thesis/main.tex", fileName: "main.tex", value: source,
      fontFamily: "monospace", fontSizePx: 14, lineHeight: 1.6,
      initialViewState: saved, diagnostics: [], project: { labels: [], bibEntries: [], files: [] }, editorRef,
      onChange: () => {}, onEdit: () => {}, onCompile: () => {}, onForwardSync: () => {},
      onAiError: () => {}, onAddSnippet: () => {},
      onViewStateChange: (patch) => { saved = { ...saved, ...patch }; },
    }))));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.ok(editorRef.current);
    return editorRef.current.view;
  }
  try {
    const first = await openTab();
    await act(async () => first.dispatch({ selection: { anchor: 2500, head: 2510 } }));
    first.scrollDOM.scrollTop = 2400.5;
    first.scrollDOM.scrollLeft = 18.25;
    // Switch before a scroll event or the view-state debounce can run.
    await act(async () => root.render(createElement("div", null, "Another tab")));
    const restored = await openTab();
    assert.notEqual(restored, first);
    assert.equal(restored.scrollDOM.scrollTop, 2400.5);
    assert.equal(restored.scrollDOM.scrollLeft, 18.25);
    assert.equal(restored.state.selection.main.anchor, 2500);
    assert.equal(restored.state.selection.main.head, 2510);
    assert.equal(restored.state.doc.toString(), source);
    assert.ok(measurements.some(({ view, top, left }) => view === restored && top === 2400.5 && left === 18.25),
      "The virtual viewport must be measured at the restored scroll position without waiting for user input");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("command snippets produce valid LaTeX, including escaped braces", () => {
  for (const name of ["frac", "left\\{", "date", "includegraphics", "newcommand", "lim"]) {
    const command = LATEX_COMMANDS.find((candidate) => candidate.name === name)!;
    const view = mount("");
    try {
      snippet(command.snippet!)(view, { label: name }, 0, 0);
      const text = view.state.doc.toString();
      const expected: Record<string, string> = {
        frac: "\\frac{numerator}{denominator}",
        "left\\{": "\\left\\{  \\right\\}",
        date: "\\date{\\today}",
        includegraphics: "\\includegraphics[width=\\linewidth]{file}",
        newcommand: "\\newcommand{\\name}{definition}",
        lim: "\\lim_{x \\to \\infty}",
      };
      assert.equal(text, expected[name], name);
    } finally { view.destroy(); }
  }
});

test("finishing \\begin{…} adds the matching \\end and starts a list item", () => {
  const view = mount("\\begin{itemize");
  try {
    assert.equal(handleLatexInput(view, view.state.doc.length, view.state.doc.length, "}"), true);
    assert.equal(view.state.doc.toString(), "\\begin{itemize}\n  \\item \n\\end{itemize}");
    assert.equal(view.state.selection.main.head, "\\begin{itemize}\n  \\item ".length);
  } finally { view.destroy(); }

  const closed = mount("\\begin{proof\n\\end{proof}");
  try {
    assert.equal(handleLatexInput(closed, 12, 12, "}"), false, "an existing \\end is not duplicated");
  } finally { closed.destroy(); }

  const escaped = mount("\\");
  try {
    assert.equal(handleLatexInput(escaped, 1, 1, "{"), true);
    assert.equal(escaped.state.doc.toString(), "\\{\\}");
  } finally { escaped.destroy(); }
});

test("renaming one side of an environment renames the other", () => {
  let state = EditorState.create({ doc: "\\begin{itemize}\n\\item a\n\\begin{itemize}\\end{itemize}\n\\end{itemize}", extensions: [syncEnvironmentNames] });
  const nameEnd = "\\begin{itemize".length;
  state = state.update({ changes: { from: nameEnd - "itemize".length, to: nameEnd, insert: "enumerate" }, userEvent: "input.type" }).state;
  assert.equal(state.doc.toString(), "\\begin{enumerate}\n\\item a\n\\begin{itemize}\\end{itemize}\n\\end{enumerate}");
  assert.deepEqual(openEnvironmentsAt(state.doc, state.doc.toString().indexOf("\\item")), ["enumerate"]);
});

test("math regions cover inline math, display math and math environments", () => {
  const doc = "Text $a+b$ and \\[ x^2 \\]\n\\begin{align}\n  y &= 1 \\\\\n  z &= 2\n\\end{align}\nafter";
  const state = EditorState.create({ doc });
  assert.deepEqual(findMathRegion(state, doc.indexOf("a+b") + 1), { from: doc.indexOf("a+b"), to: doc.indexOf("a+b") + 3, display: false, kind: "$" });
  assert.equal(findMathRegion(state, doc.indexOf("x^2"))?.display, true);
  assert.equal(findMathRegion(state, doc.indexOf("z &="))?.kind, "align");
  assert.equal(findMathRegion(state, doc.indexOf("after")), null);
  assert.equal(findMathRegion(state, doc.indexOf("Text")), null);
  assert.deepEqual(readPreviewMacros("\\newcommand{\\R}{\\mathbb{R}}\n\\DeclareMathOperator{\\tr}{tr}\n\\begin{document}"), { "\\R": "\\mathbb{R}", "\\tr": "\\operatorname{tr}" });
});

test("environments and sections fold to their end", () => {
  const doc = "\\section{A}\ntext\n\\begin{equation}\n  x\n\\end{equation}\n\n\\section{B}\nmore";
  const state = EditorState.create({ doc, extensions: [latexLanguage] });
  const line = (number: number) => state.doc.line(number);
  assert.deepEqual(latexFoldRange(state, line(3).from, line(3).to), { from: line(3).to, to: line(4).to });
  assert.deepEqual(latexFoldRange(state, line(1).from, line(1).to), { from: line(1).to, to: line(5).to });
  assert.equal(latexFoldRange(state, line(2).from, line(2).to), null);
});

test("AI proposals are diffed into hunks that can be accepted, rejected and undone", () => {
  assert.deepEqual(diffTexts("This document tests the editor.", "This document thoroughly exercises the editor."), [{ fromA: 14, toA: 19, fromB: 14, toB: 34 }]);
  const lines = diffTexts("  \\item one\n  \\item two", "  \\item one, expanded\n  \\item two\n  \\item three");
  assert.equal(lines.length, 2, "the unchanged last line is not part of a hunk");

  const original = "Intro.\n  \\item one\n  \\item two\nOutro.";
  const view = mount(original);
  try {
    const from = original.indexOf("  \\item one");
    const to = original.indexOf("\nOutro");
    assert.equal(applyAiProposal(view, from, to, "  \\item one, expanded\n  \\item two\n  \\item three", "rewrite"), 2);
    const proposed = view.state.doc.toString();
    assert.equal(view.state.field(reviewHunksField).length, 2);

    undo(view);
    assert.equal(view.state.doc.toString(), original);
    assert.equal(view.state.field(reviewHunksField).length, 0, "undoing the AI edit removes its review");
    redo(view);
    assert.equal(view.state.doc.toString(), proposed);
    assert.equal(view.state.field(reviewHunksField).length, 2, "redo restores the review");

    const [first] = view.state.field(reviewHunksField);
    decideReviewHunks(view, [first.id], "reject");
    assert.equal(view.state.doc.toString(), "Intro.\n  \\item one\n  \\item two\n  \\item three\nOutro.");
    undo(view);
    assert.equal(view.state.doc.toString(), proposed);
    assert.equal(view.state.field(reviewHunksField).length, 2);

    decideReviewHunks(view, "all", "accept");
    assert.equal(view.state.doc.toString(), proposed);
    assert.equal(view.state.field(reviewHunksField).length, 0);
  } finally { view.destroy(); }
});

test("SyncTeX and log lines follow edits made after the compile", () => {
  const view = mount("line one\nline two\nline three");
  try {
    view.dispatch({ effects: markCompileStarted.of(null) });
    view.dispatch({ changes: { from: 0, insert: "new first line\n" } });
    view.dispatch({ effects: markCompileShown.of(null) });
    const pos = view.state.doc.toString().indexOf("line three");
    assert.deepEqual(compiledLocationForPosition(view.state, pos), { line: 3, column: 0 });
    assert.equal(view.state.doc.lineAt(positionForCompiledLine(view.state, 2)).text, "line two");
  } finally { view.destroy(); }
});

/* ---- Compiling (needs a TeX installation) -------------------------------------------- */

test("a notebook document compiles with drafts, a bibliography and SyncTeX", async (context) => {
  const { findTexToolchain } = await import("../../src/lib/latex/toolchain");
  if (!(await findTexToolchain()).binDirectory) {
    context.skip("TeX is not installed");
    return;
  }
  const { compileLatexDocument } = await import("../../src/lib/latex/build");
  const { synctexForward, synctexInverse } = await import("../../src/lib/latex/synctex");
  const { findLatexRoot } = await import("../../src/lib/latex/root");
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "libera-latex-test-"));
  const previousDataDir = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = dataRoot;
  try {
    const notebook = path.join(dataRoot, "users", "admin", "Thesis");
    await mkdir(path.join(notebook, "chapters"), { recursive: true });
    await writeFile(path.join(notebook, "main.tex"), "\\documentclass{article}\n\\begin{document}\nSaved text.\n\\input{chapters/one}\n\\cite{knuth}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n");
    await writeFile(path.join(notebook, "chapters", "one.tex"), "Chapter on disk.\n");
    await writeFile(path.join(notebook, "refs.bib"), "@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={AW}}\n");
    // A latexmkrc beside the document is Perl code from an untrusted folder.
    const marker = path.join(dataRoot, "latexmkrc-ran");
    await writeFile(path.join(notebook, "latexmkrc"), `open(my $f, ">", ${JSON.stringify(marker)}); close($f);\n`);

    assert.equal(await findLatexRoot("Thesis/chapters/one.tex"), "Thesis/main.tex");

    const result = await compileLatexDocument({
      rootPath: "Thesis/main.tex",
      drafts: { "Thesis/chapters/one.tex": "Chapter from the unsaved draft.\nSecond line.\n" },
    }, new AbortController().signal);
    assert.equal(result.status, "success", JSON.stringify(result.diagnostics));
    assert.ok(result.buildId);
    assert.equal(await access(marker).then(() => true, () => false), false, "a project latexmkrc is never run");

    const locations = await synctexForward("Thesis/main.tex", result.buildId!, "Thesis/chapters/one.tex", 1, 0);
    assert.ok(locations.length > 0, "the draft chapter maps into the PDF");
    const source = await synctexInverse("Thesis/main.tex", result.buildId!, locations[0].page, locations[0].x, locations[0].y);
    assert.deepEqual(source && { path: source.path, line: source.line }, { path: "Thesis/chapters/one.tex", line: 1 });

    const broken = await compileLatexDocument({ rootPath: "Thesis/main.tex", drafts: { "Thesis/main.tex": "\\documentclass{article}\n\\begin{document}\nOops \\notacommand.\n\\end{document}\n" } }, new AbortController().signal);
    assert.equal(broken.status, "error");
    assert.deepEqual(broken.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map(({ path: file, line, message }) => ({ file, line, message })), [
      { file: "Thesis/main.tex", line: 3, message: "Undefined control sequence." },
    ]);
  } finally {
    if (previousDataDir === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previousDataDir;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
