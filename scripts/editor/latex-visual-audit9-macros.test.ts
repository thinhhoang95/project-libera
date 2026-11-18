import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import katex from "katex";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { collectMacroSources } from "../../src/components/libera/latex/latex-dependencies";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { forKatex, KATEX_MACROS } from "../../src/lib/latex/codemirror/visual/math-render";
import { setMacroSources, setNumbering, visualDefinitions } from "../../src/lib/latex/codemirror/visual/model";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { classCommandSource, collectLatexDefinitions } from "../../src/lib/latex/macros/definitions";
import { expandLatexMacros } from "../../src/lib/latex/macros/expand";
import { computeLatexNumbering } from "../../src/lib/latex/macros/numbering";

/* Audit round 9, reading and expanding the user's macros: kvoptions booleans that decide which package a package loads and
 * which definition is in force (ATLAS's style files, 2611.16454), `\iflanguage`, and the commands a project's own class gives. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

/** The definitions the editor holds for `file` of an in-memory project (file name without `nb/` to text). */
async function projectSources(files: Record<string, string>, file: string, root = file) {
  const known = new Set(Object.keys(files).map((name) => `nb/${name}`));
  const readText = async (path: string) => files[path.replace(/^nb\//, "")] ?? "";
  const doc = files[file];
  const begin = doc.search(/\\begin\{document\}/);
  const ownPreamble = doc.slice(0, Math.max(begin, 0));
  const { sources } = await collectMacroSources({ filePath: `nb/${file}`, rootPath: `nb/${root}`, ownPreamble, ownBody: doc.slice(ownPreamble.length), known, readText, version: () => "1" });
  return { sources, doc, bodyStart: begin };
}

async function projectDefinitions(files: Record<string, string>, file: string) {
  const { sources, doc, bodyStart } = await projectSources(files, file);
  return collectLatexDefinitions(sources, { text: doc, bodyStart });
}

async function mountProject(files: Record<string, string>, file: string) {
  const { sources, doc } = await projectSources(files, file);
  const base = EditorState.create({ doc, extensions: [latexLanguageSupport(file, "tree")] });
  ensureSyntaxTree(base, doc.length, 5000);
  let state = EditorState.create({ doc, selection: { anchor: 0 }, extensions: [latexLanguageSupport(file, "tree"), latexVisualState(), latexVisualMode({ documentPath: `nb/${file}` })] });
  state = state.update({ effects: setMacroSources.of(sources) }).state;
  for (let guard = 0; state.field(structuralField).pending.length && guard < 200; guard++) {
    const next = state.field(structuralField).pending[0];
    state = state.update({ effects: buildPendingEffect.of({ from: next.from, to: Math.min(next.to, next.from + CHUNK) }) }).state;
  }
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state, parent });
  const numbering = computeLatexNumbering(syntaxTree(view.state), (from, to) => view.state.doc.sliceString(from, to), visualDefinitions(view.state));
  view.dispatch({ effects: setNumbering.of(numbering) });
  refreshVisualWidgets(view);
  return { view, done: () => { view.destroy(); parent.remove(); for (const editor of document.querySelectorAll(".cm-vis-math-editor")) editor.remove(); } };
}

const mousedown = (node: Element, altKey = false) => node.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey }));

const renders = (latex: string) => {
  try { katex.renderToString(forKatex(latex), { throwOnError: true, strict: "ignore", macros: { ...KATEX_MACROS } }); return true; } catch { return false; }
};

/** ATLAS's layout: a physics package that loads its parts by kvoptions booleans, the options given on its `\usepackage`. */
const ATLAS_FILES = {
  "main.tex": String.raw`\documentclass[PAPER, UKenglish, orcidlogo]{atlasdoc}
\usepackage[full]{atlaspackage}
\usepackage[jetetmiss=true, process=true]{atlasphysics}
\begin{document}
Tau leptons ($\tauhad$, $\pT > 5$) at \pileup of $\ttbar$ near \GeV{} and \pp\ events.
\end{document}`,
  "atlasdoc.cls": String.raw`\ProvidesClass{atlasdoc}
\RequirePackage{kvoptions}
\SetupKeyvalOptions{
family=ADOC,
prefix=ADOC@
}
\DeclareBoolOption[false]{orcidlogo}
\ProcessKeyvalOptions{ADOC}
\ifbool{ADOC@orcidlogo}{%
\newcommand{\orcidlink}[1]{\href{https://orcid.org/#1}{\usebox{\myorcidaffilbox}}}
}{}
\NewDocumentCommand \AtlasOrcid { o m } {%
\ifbool{ADOC@orcidlogo}{%
\IfNoValueTF {#1} {#2}{#2\,\orcidlink{#1}}%
}{%
\IfNoValueTF {#1} {#2}{\href{https://orcid.org/#1}{#2}}%
}%
}
\newcommand{\internal}{\@internal}`,
  "atlaspackage.sty": String.raw`\RequirePackage{etoolbox}`,
  "atlasphysics.sty": String.raw`\RequirePackage{etoolbox}
\RequirePackage{kvoptions}
\SetupKeyvalOptions{
family=APHY,
prefix=APHY@
}
\DeclareBoolOption[false]{jetetmiss}
\DeclareBoolOption[true]{misc}
\DeclareBoolOption[false]{process}
\DeclareBoolOption[true]{unit}
\ProcessKeyvalOptions*
\ifbool{APHY@misc}{\RequirePackage{atlasmisc}}{}
\ifbool{APHY@process}{%
\RequirePackage[process]{atlasparticle}
}{%
\RequirePackage{atlasparticle}
}
\ifbool{APHY@unit}{\RequirePackage{atlasunit}}{}
\ifbool{APHY@jetetmiss}{\RequirePackage{atlasjetetmiss}}{}`,
  "atlasmisc.sty": String.raw`\newcommand*{\pT}{\ensuremath{p_{\text{T}}}\xspace}
\iflanguage{USenglish}{%
\newcommand*{\pileup}{pileup\xspace}
}{%
\newcommand*{\pileup}{pile-up\xspace}
}`,
  "atlasparticle.sty": String.raw`\RequirePackage{kvoptions}
\SetupKeyvalOptions{
family=APTCL,
prefix=APTCL@
}
\DeclareBoolOption[false]{hepparticle}
\DeclareBoolOption[false]{process}
\ProcessKeyvalOptions*
\ifbool{APTCL@hepparticle}{%
\newcommand*{\tauhad}{\ensuremath{\Pgt_{\text{had}}}\xspace}
\newcommand*{\ttbar}{\Pqt{}\Paqt}
}{%
\newcommand*{\tauhad}{\ensuremath{\tau_{\text{had}}}\xspace}
\newcommand*{\ttbar}{\ensuremath{t\bar{t}}\xspace}
}
\ifbool{APTCL@process}{\newcommand*{\pp}{\ensuremath{pp}\xspace}}{}`,
  "atlasunit.sty": String.raw`\RequirePackage{kvoptions}
\SetupKeyvalOptions{
family=AUNIT,
prefix=AUNIT@
}
\DeclareBoolOption[false]{eVkern}
\ProcessKeyvalOptions*
\ifbool{AUNIT@eVkern}{%
\newcommand{\electronvolt}{\mathrm{e\kern-0.1em V}}
}{%
\newcommand{\electronvolt}{eV}
}
\newcommand*{\GeV}{\ensuremath{\text{G\electronvolt}}\xspace}`,
  "atlasjetetmiss.sty": String.raw`\newcommand*{\MET}{\ensuremath{E_{\text{T}}^{\text{miss}}}\xspace}`,
};

test("kvoptions booleans decide which branch's macro is in force, so the sub-packages' macros are known (2611.16454)", async () => {
  const defs = await projectDefinitions(ATLAS_FILES, "main.tex");
  const expand = (text: string) => expandLatexMacros(text, defs, { mode: "text" });
  for (const [use, expected] of [
    [String.raw`\tauhad`, String.raw`\ensuremath{\tau_{\text{had}}}\xspace`],
    [String.raw`\ttbar`, String.raw`\ensuremath{t\bar{t}}\xspace`],
    [String.raw`\pT`, String.raw`\ensuremath{p_{\text{T}}}\xspace`],
    [String.raw`\GeV`, String.raw`\ensuremath{\text{GeV}}\xspace`],
    [String.raw`\MET`, String.raw`\ensuremath{E_{\text{T}}^{\text{miss}}}\xspace`],
    [String.raw`\pp`, String.raw`\ensuremath{pp}\xspace`],
  ] as const) {
    const result = expand(use);
    assert.ok(result.ok, use);
    assert.equal(result.text.replace(/\s+/g, ""), expected.replace(/\s+/g, ""), use);
  }
});

test("a package's boolean without the option given is its declared default; an option sets it (2611.16454)", async () => {
  const withoutOption = { ...ATLAS_FILES, "main.tex": ATLAS_FILES["main.tex"].replace("[jetetmiss=true, process=true]", "") };
  const defs = await projectDefinitions(withoutOption, "main.tex");
  // `jetetmiss` is off: atlasjetetmiss.sty is not loaded (`\MET` unknown); `process` is off: `\pp` unknown; `misc` and `unit` are on.
  assert.equal(defs.macros.get("MET"), undefined);
  assert.equal(defs.macros.get("pp"), undefined);
  assert.ok(defs.macros.get("pT")?.length);
  assert.ok(defs.macros.get("GeV")?.length);
  assert.equal(expandLatexMacros(String.raw`\tauhad`, defs, { mode: "text" }).ok, true);
  // `process=false` given explicitly is off too.
  const off = { ...ATLAS_FILES, "main.tex": ATLAS_FILES["main.tex"].replace("jetetmiss=true, process=true", "jetetmiss=true, process=false") };
  const offDefs = await projectDefinitions(off, "main.tex");
  assert.ok(offDefs.macros.get("MET")?.length);
  assert.equal(offDefs.macros.get("pp"), undefined);
});

test("babel's \\iflanguage picks the definition of the document's language: UKenglish gives pile-up (2611.16454)", async () => {
  const defs = await projectDefinitions(ATLAS_FILES, "main.tex");
  assert.equal(expandLatexMacros(String.raw`\pileup`, defs, { mode: "text" }).text, "pile-up\\xspace");
  const american = await projectDefinitions({ ...ATLAS_FILES, "main.tex": ATLAS_FILES["main.tex"].replace("UKenglish, ", "") }, "main.tex");
  // Without a language option babel's language is not known here: the macro stays as source rather than guessing.
  assert.ok(!/pile/.test(expandLatexMacros(String.raw`\pileup`, american, { mode: "text" }).text.replace(/^\\pileup$/, "")));
  const us = await projectDefinitions({ ...ATLAS_FILES, "main.tex": ATLAS_FILES["main.tex"].replace("UKenglish", "USenglish") }, "main.tex");
  assert.equal(expandLatexMacros(String.raw`\pileup`, us, { mode: "text" }).text, "pileup\\xspace");
});

test("the project's own class gives its top-level commands, read with the class options: \\AtlasOrcid draws the name (2611.16454)", async () => {
  const defs = await projectDefinitions(ATLAS_FILES, "main.tex");
  const withId = expandLatexMacros(String.raw`\AtlasOrcid[0000-0002-6665-4934]{G.~Aad}`, defs, { mode: "text" });
  assert.ok(withId.ok);
  assert.match(withId.text, /G\.~Aad\\,\\orcidlink\{0000-0002-6665-4934\}/);
  const without = expandLatexMacros(String.raw`\AtlasOrcid{G.~Aad}`, defs, { mode: "text" });
  assert.ok(without.ok);
  assert.equal(without.text.replace(/[%\s]/g, ""), "G.~Aad");
  // Not the class's layout internals, and not a definition inside the class's own conditional (`\orcidlink` is drawn by the Visual mode).
  assert.equal(defs.macros.get("internal"), undefined);
  assert.equal(defs.macros.get("orcidlink"), undefined);
  const source = classCommandSource(ATLAS_FILES["atlasdoc.cls"]);
  assert.ok(source.includes("\\NewDocumentCommand \\AtlasOrcid") && !source.includes("\\@internal") && !source.includes("orcidlink}[1]"));
});

test("without the class option orcidlogo the class's \\AtlasOrcid links the name instead (2611.16454)", async () => {
  const files = { ...ATLAS_FILES, "main.tex": ATLAS_FILES["main.tex"].replace(", orcidlogo", "") };
  const defs = await projectDefinitions(files, "main.tex");
  const result = expandLatexMacros(String.raw`\AtlasOrcid[0000-0002-6665-4934]{G.~Aad}`, defs, { mode: "text" });
  assert.ok(result.ok);
  // orcidlogo is off: the author's name links to the ORCID page instead.
  assert.match(result.text, /\\href\{https:\/\/orcid\.org\/0000-0002-6665-4934\}\{G\.~Aad\}/);
});

test("macros of the style files are drawn in the text and in formulas, and a click shows the formula's source (2611.16454)", async () => {
  const { view, done } = await mountProject(ATLAS_FILES, "main.tex");
  try {
    const text = view.contentDOM.textContent ?? "";
    assert.ok(!text.includes("\\tauhad") && !text.includes("\\pileup") && !text.includes("\\pT") && !text.includes("\\ttbar") && !text.includes("\\GeV"), text);
    const math = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-vis-math")];
    assert.ok(math.length >= 3, view.contentDOM.innerHTML.slice(0, 800));
    for (const formula of math) assert.ok(formula.querySelector(".katex"), formula.outerHTML.slice(0, 300));
    const doc = view.state.doc.toString();
    const from = doc.indexOf("$\\pT > 5$");
    mousedown(math[1]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const head = view.state.selection.main.head;
    const revealed = [...view.state.field(structuralField).revealed.values()].some((range) => range.from <= from && range.to >= from + 9);
    assert.ok((head >= from && head <= from + 9) || revealed || document.querySelector(".cm-vis-math-editor") !== null);
  } finally { done(); }
});

test("a formula that expands with the style files' macros is drawn by KaTeX (2611.16454)", async () => {
  const defs = await projectDefinitions(ATLAS_FILES, "main.tex");
  for (const formula of [String.raw`\tauhad`, String.raw`\pT > 5`, String.raw`\ttbar \rightarrow \tauhad + \MET`]) {
    const expanded = expandLatexMacros(formula, defs, { mode: "math" });
    assert.ok(expanded.ok && renders(expanded.text), `${formula} -> ${expanded.text}`);
  }
});
