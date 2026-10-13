import "./setup.cjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { normalizeLatexSnippets } from "../../electron/latex-snippets.cjs";
import { insertSnippetText, insertTemplate, latexSnippetCompletionSource } from "../../src/lib/latex/codemirror/snippets";
import { createLatexSnippet, deleteLatexSnippet, readLatexSnippets, renameLatexSnippet } from "../../src/lib/latex/snippet-storage";
import {
  BIBLATEX_STYLES, BIBTEX_STYLES, bibliographyBlock, codeTemplate, figureTemplate, indentSnippet, listTemplate, literalField, packageInsertion,
  readBibliographySetup, restyleBibliography, sideBySideTemplate, snippetBodyFromSelection, tableTemplate, type TextChange,
} from "../../src/lib/latex/snippets";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

function mount(doc: string, anchor = doc.length, head = anchor) {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({ state: EditorState.create({ doc, selection: { anchor, head } }), parent });
}

function apply(doc: string, changes: TextChange[] | TextChange | null) {
  if (!changes) return doc;
  return [changes].flat().sort((left, right) => right.from - left.from)
    .reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to ?? change.from), doc);
}

const PREAMBLE = "\\documentclass{article}\n\\usepackage{amsmath} % maths\n\n\\begin{document}\nHello\n\\end{document}\n";

/* ---- Saving and inserting snippets ------------------------------------------------ */

test("saved snippets lose the indentation their lines share", () => {
  const selected = "\\begin{figure}\n\t\t\\centering\n\t\\end{figure}\n";
  assert.equal(snippetBodyFromSelection(selected, "\t"), "\\begin{figure}\n\t\\centering\n\\end{figure}");
  // A selection that starts inside the indentation keeps no stray spaces.
  assert.equal(snippetBodyFromSelection("  \\item one\n    \\item two", "    "), "\\item one\n\\item two");
  assert.equal(snippetBodyFromSelection("x\r\n\ty", ""), "x\n\ty");
});

test("inserted snippets follow the indentation of the line they land on", () => {
  assert.equal(indentSnippet("a\n\tb\n\nc", "  "), "a\n  \tb\n\n  c");
  const view = mount("\\begin{itemize}\n\t\n\\end{itemize}", 17);
  insertSnippetText(view, "\\item ${x}\n\\item {y}");
  // Inserted literally: `${…}` and braces are not read as template fields.
  assert.equal(view.state.doc.toString(), "\\begin{itemize}\n\t\\item ${x}\n\t\\item {y}\n\\end{itemize}");
  assert.equal(view.state.selection.main.head, 17 + "\\item ${x}\n\t\\item {y}".length);
  view.destroy();
});

test("stored snippets drop invalid, duplicate and oversized entries", () => {
  assert.deepEqual(normalizeLatexSnippets([
    { id: "a", name: "/fig", body: "\\begin{figure}" },
    { id: "b", name: "FIG", body: "duplicate name" },
    { id: "a", name: "other", body: "duplicate id" },
    { id: "c", name: "has space", body: "x" },
    { id: "d", name: "empty", body: "   " },
    { id: "e", name: "huge", body: "x".repeat(50_001) },
    { id: "f", name: "table_2-col", body: "\\begin{table}" },
    "junk",
  ]), [
    { id: "a", name: "fig", body: "\\begin{figure}" },
    { id: "f", name: "table_2-col", body: "\\begin{table}" },
  ]);
  assert.deepEqual(normalizeLatexSnippets({ not: "a list" }), []);
});

/* ---- Slash completion ----------------------------------------------------------------- */

function complete(doc: string, explicit = false) {
  const snippets = [{ id: "1", name: "twofig", body: "\\begin{figure}\n\\end{figure}" }, { id: "2", name: "figure", body: "my own figure" }];
  const view = mount(doc);
  const result = latexSnippetCompletionSource(() => snippets)(new CompletionContext(view.state, doc.length, explicit));
  return { view, result };
}

test("/name offers saved snippets and templates after a space or at a line start", () => {
  const { view, result } = complete("Some text /fi");
  assert.ok(result);
  assert.equal(result.from, "Some text ".length);
  const labels = result.options.map((option) => option.label);
  assert.ok(labels.includes("/twofig") && labels.includes("/table") && labels.includes("/side-by-side"));
  // A saved snippet hides the built-in template of the same name.
  assert.equal(labels.filter((label) => label === "/figure").length, 1);
  const twofig = result.options.find((option) => option.label === "/twofig")!;
  (twofig.apply as Exclude<Completion["apply"], string | undefined>)(view, twofig, result.from, view.state.doc.length);
  assert.equal(view.state.doc.toString(), "Some text \\begin{figure}\n\\end{figure}");
  view.destroy();

  assert.equal(complete("figures/fi").result, null, "paths are not snippet names");
  assert.equal(complete("text \\/").result, null, "italic correction is not a slash command");
  assert.equal(complete("% note /fi").result, null, "comments are left alone");
  assert.equal(complete("text /").result, null, "a lone slash needs a letter first");
  assert.ok(complete("text /", true).result, "unless completion is asked for");
  assert.ok(complete("/tw").result, "line start");
});

/* ---- Packages ------------------------------------------------------------------------- */

test("missing packages are loaded after the last \\usepackage of the preamble", () => {
  const { missing, change } = packageInsertion(PREAMBLE, ["amsmath", "graphicx", "subcaption", "graphicx"]);
  assert.deepEqual(missing, ["graphicx", "subcaption"]);
  assert.equal(apply(PREAMBLE, change), "\\documentclass{article}\n\\usepackage{amsmath} % maths\n\\usepackage{graphicx}\n\\usepackage{subcaption}\n\n\\begin{document}\nHello\n\\end{document}\n");

  const bare = "\\documentclass[11pt]{article}\n\\begin{document}\n\\end{document}";
  assert.equal(apply(bare, packageInsertion(bare, ["booktabs"]).change), "\\documentclass[11pt]{article}\n\\usepackage{booktabs}\n\\begin{document}\n\\end{document}");

  const listed = "\\documentclass{article}\n\\usepackage[margin=1in]{geometry,graphicx}\n% \\usepackage{listings}\n\\begin{document}\n\\end{document}";
  assert.deepEqual(packageInsertion(listed, ["graphicx", "listings"]).missing, ["listings"], "commented-out packages do not count");

  const chapter = packageInsertion("\\section{Results}\n", ["graphicx"]);
  assert.deepEqual(chapter, { missing: ["graphicx"], change: null }, "a chapter file has no preamble to change");
});

test("templates insert at the selection and load their packages", () => {
  const doc = "\\documentclass{article}\n\\begin{document}\nX\n\\end{document}";
  const view = mount(doc, doc.indexOf("X"), doc.indexOf("X") + 1);
  const unavailable = insertTemplate(view, sideBySideTemplate(2), ["graphicx", "subcaption"]);
  assert.deepEqual(unavailable, []);
  const text = view.state.doc.toString();
  assert.match(text, /^\\documentclass\{article\}\n\\usepackage\{graphicx\}\n\\usepackage\{subcaption\}\n\\begin\{document\}\n\\begin\{figure\}\[htbp\]/);
  assert.equal(text.match(/\\begin\{subfigure\}\[t\]\{0\.48\\linewidth\}/g)?.length, 2);
  assert.match(text, /\\includegraphics\[width=\\linewidth\]\{file-a\}/);
  assert.ok(!text.includes("X\n"), "the selection is replaced");
  // The first field is selected, ready to type over.
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "file-a");
  view.destroy();

  const chapter = mount("\\section{A}\n");
  assert.deepEqual(insertTemplate(chapter, figureTemplate("figs/plot_1.pdf"), ["graphicx"]), ["graphicx"]);
  assert.match(chapter.state.doc.toString(), /\\includegraphics\[width=0\.8\\linewidth\]\{figs\/plot_1\.pdf\}\n {2}\\caption\{Caption\}\n {2}\\label\{fig:plot-1\}/);
  chapter.destroy();
});

test("templates keep selected LaTeX literally, braces and dollars included", () => {
  const selection = "f(x) = \\{ ${a} \\}";
  const view = mount("");
  insertTemplate(view, codeTemplate("verbatim", selection));
  assert.equal(view.state.doc.toString(), `\\begin{verbatim}\n${selection}\n\\end{verbatim}\n`);
  view.destroy();
  assert.equal(literalField("a{b}"), "a\\{b\\}");

  const list = mount("");
  insertTemplate(list, listTemplate("enumerate", "- first {x}\n2. second\n"));
  assert.equal(list.state.doc.toString(), "\\begin{enumerate}\n  \\item first {x}\n  \\item second\n\\end{enumerate}");
  list.destroy();
});

test("tables get a header row, booktabs rules and one tab stop per cell", () => {
  const view = mount("");
  insertTemplate(view, tableTemplate(3, 2));
  const text = view.state.doc.toString();
  assert.match(text, /\\begin\{tabular\}\{ll\}/);
  assert.match(text, /Header 1 & Header 2 \\\\\n\s+\\midrule\n\s+ & {2}\\\\\n\s+ & {2}\\\\\n\s+\\bottomrule/);
  view.destroy();

  const listing = codeTemplate("listing", "", "Python");
  assert.match(listing, /^\\begin\{lstlisting\}\[language=Python, caption=\{\$\{Caption\}\}, label=\{lst:\$\{label\}\}\]/);
  assert.match(codeTemplate("listing", ""), /^\\begin\{lstlisting\}\[caption=/);
});

/* ---- Bibliography ------------------------------------------------------------------------ */

test("bibliography styles switch in place for BibTeX and biblatex", () => {
  const style = (value: string) => [...BIBTEX_STYLES, ...BIBLATEX_STYLES].find((entry) => entry.value === value)!;

  const bibtex = "Text\n% \\bibliographystyle{alpha}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n";
  assert.deepEqual(readBibliographySetup(bibtex), { system: "bibtex", style: "plain" });
  assert.equal(apply(bibtex, restyleBibliography(bibtex, style("IEEEtran"))), "Text\n% \\bibliographystyle{alpha}\n\\bibliographystyle{IEEEtran}\n\\bibliography{refs}\n");

  const unstyled = "\\bibliography{refs}";
  assert.deepEqual(readBibliographySetup(unstyled), { system: "bibtex", style: null });
  assert.equal(apply(unstyled, restyleBibliography(unstyled, style("unsrt"))), "\\bibliographystyle{unsrt}\n\\bibliography{refs}");

  const biblatex = "\\usepackage[backend=biber, style=authoryear]{biblatex}";
  assert.deepEqual(readBibliographySetup(biblatex), { system: "biblatex", style: "authoryear" });
  assert.equal(apply(biblatex, restyleBibliography(biblatex, style("ieee"))), "\\usepackage[backend=biber, style=ieee]{biblatex}");
  assert.equal(apply("\\usepackage[backend=biber]{biblatex}", restyleBibliography("\\usepackage[backend=biber]{biblatex}", style("apa"))), "\\usepackage[style=apa,backend=biber]{biblatex}");
  assert.equal(apply("\\usepackage{biblatex}", restyleBibliography("\\usepackage{biblatex}", style("numeric"))), "\\usepackage[style=numeric]{biblatex}");
  assert.deepEqual(readBibliographySetup("\\usepackage{biblatex}"), { system: "biblatex", style: "numeric" });

  assert.deepEqual(readBibliographySetup("No bibliography"), { system: null, style: null });
  assert.equal(restyleBibliography("No bibliography", style("plain")), null);
  assert.equal(bibliographyBlock(style("plainnat"), "chapters/refs.bib"), "\\bibliographystyle{plainnat}\n\\bibliography{chapters/refs}");
  assert.deepEqual(style("plainnat").packages, ["natbib"]);
  assert.equal(bibliographyBlock(style("nature"), "refs.bib"), "\\printbibliography");
});

/* ---- Storage -------------------------------------------------------------------------------- */

test("snippets are kept in the app config beside its other settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-snippets-test-"));
  const previous = process.env.LIBERA_CONFIG_PATH;
  const configPath = path.join(directory, "config.json");
  process.env.LIBERA_CONFIG_PATH = configPath;
  try {
    await writeFile(configPath, JSON.stringify({ themePreference: "dark", quickPrompts: [{ identifier: "a", prompt: "b" }] }));
    assert.deepEqual(await readLatexSnippets(), []);

    // Concurrent saves are queued, so neither is lost.
    const [, both] = await Promise.all([createLatexSnippet({ name: "/twofig", body: "\\begin{figure}" }), createLatexSnippet({ name: "tab", body: "\\begin{table}" })]);
    assert.deepEqual(both.map((snippet) => snippet.name), ["twofig", "tab"]);

    await assert.rejects(createLatexSnippet({ name: "TWOFIG", body: "x" }), (error: Error & { status?: number }) => error.status === 409 && /already exists/.test(error.message));
    await assert.rejects(createLatexSnippet({ name: "bad name", body: "x" }), (error: Error & { status?: number }) => error.status === 400);
    await assert.rejects(createLatexSnippet({ name: "empty", body: " " }), /Select some LaTeX/);

    const renamed = await renameLatexSnippet(both[1].id, "booktable");
    assert.deepEqual(renamed.map((snippet) => snippet.name), ["twofig", "booktable"]);
    await assert.rejects(renameLatexSnippet(both[1].id, "twofig"), /already exists/);
    await assert.rejects(renameLatexSnippet("missing", "x"), (error: Error & { status?: number }) => error.status === 404);

    const remaining = await deleteLatexSnippet(both[0].id);
    assert.deepEqual(remaining.map((snippet) => snippet.name), ["booktable"]);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.themePreference, "dark");
    assert.deepEqual(config.quickPrompts, [{ identifier: "a", prompt: "b" }]);
    assert.deepEqual(config.latexSnippets, [{ id: both[1].id, name: "booktable", body: "\\begin{table}" }]);
    assert.deepEqual(await readLatexSnippets(), config.latexSnippets);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_CONFIG_PATH;
    else process.env.LIBERA_CONFIG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
