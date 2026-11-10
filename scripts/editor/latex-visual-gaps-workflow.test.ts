import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latexLanguageSupport } from "../../src/lib/latex/codemirror/latex-language";
import { latexVisualMode, latexVisualState } from "../../src/lib/latex/codemirror/visual";
import { buildPendingEffect, CHUNK, structuralField } from "../../src/lib/latex/codemirror/visual/structural";
import { refreshVisualWidgets } from "../../src/lib/latex/codemirror/visual/widgets";
import { drawingPreviewConfig, type DrawingPreviewConfig } from "../../src/lib/latex/codemirror/visual/drawing-preview";
import { latexSpellcheck, latexSpellcheckActive } from "../../src/lib/latex/codemirror/spellcheck";
import { imageFilesOf, isImagePaste, latexImagePaste, type LatexImageRequest } from "../../src/lib/latex/codemirror/image-paste";
import { latexMarkdownPaste, trackRange } from "../../src/lib/latex/codemirror/markdown-paste";
import {
  chooseImageFolder, figureLabelFor, imageFigureLatex, latexImageExtension, missingImagePackages, pastedImageBaseName, sanitizeImageBaseName, uniqueImageName,
} from "../../src/lib/latex/image-insert";
import { assemblePreviewDocument, cropBox, documentPreamble, drawingSource, previewErrorSummary, previewHash } from "../../src/lib/latex/drawing-preview";
import { saveAndInsertImages } from "../../src/components/libera/latex/latex-image-drop";
import { normalizeMarkdownDisplayPreferences } from "../../src/lib/markdown-display-preferences";

/* Editor workflow around the Visual mode: spellcheck, images pasted or dropped
 * into figures, and on-demand previews of TikZ-like drawings. */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "DocumentFragment", "HTMLTableCellElement", "DOMParser", "Event", "File", "Blob"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
after(() => dom.window.close());

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

function mount(state: EditorState) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state, parent });
  refreshVisualWidgets(view);
  return view;
}

/** A DataTransfer stand-in with files and string data. */
function transfer(files: File[], data: Record<string, string> = {}) {
  return {
    files, types: [...Object.keys(data), ...(files.length ? ["Files"] : [])],
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

const png = (name = "image.png") => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

/* ---- Spellcheck ---- */

test("spellcheck: a saved boolean, on by default; only the Visual mode checks, and markup is excluded", () => {
  assert.equal(normalizeMarkdownDisplayPreferences({}).latexSpellcheck, true);
  assert.equal(normalizeMarkdownDisplayPreferences({ latexSpellcheck: false }).latexSpellcheck, false);
  assert.equal(normalizeMarkdownDisplayPreferences({ latexSpellcheck: "no" as unknown as boolean }).latexSpellcheck, true);
  assert.equal(latexSpellcheckActive(true, false), false, "Source mode never checks");
  assert.equal(latexSpellcheckActive(false, true), false);
  assert.equal(latexSpellcheckActive(true, true), true);

  const doc = String.raw`Some \textbf{bold} prose with $x^2$ and \cite{key} here.`;
  const on = mount(EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree"), latexSpellcheck(true)] }));
  assert.equal(on.contentDOM.getAttribute("spellcheck"), "true");
  const excluded = [...on.contentDOM.querySelectorAll("[spellcheck=false]")].map((node) => node.textContent);
  assert.ok(excluded.includes("\\textbf"), `command names are excluded: ${excluded.join(" | ")}`);
  assert.ok(excluded.some((text) => text?.includes("x^2")), "formulas are excluded");
  assert.ok(excluded.some((text) => text?.includes("key")), "citation keys are excluded");
  assert.ok(!excluded.some((text) => text?.includes("prose")), "prose is checked");
  on.destroy();
  const off = mount(EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree"), latexSpellcheck(false)] }));
  assert.equal(off.contentDOM.getAttribute("spellcheck"), "false");
  assert.equal(off.contentDOM.querySelectorAll("[spellcheck=false]").length, 0);
  off.destroy();
});

/* ---- Images: pure parts ---- */

test("image names, folders, collisions, labels and the figure", () => {
  assert.equal(latexImageExtension("plot.PNG", ""), "png");
  assert.equal(latexImageExtension("photo.jpeg", "image/jpeg"), "jpg");
  assert.equal(latexImageExtension("", "image/png"), "png");
  assert.equal(latexImageExtension("anim.gif", "image/gif"), null, "LaTeX cannot include GIF");
  assert.equal(latexImageExtension("drawing.svg", "image/svg+xml"), "svg");
  assert.equal(sanitizeImageBaseName("Résumé chart v2.1 (final).png"), "Resume-chart-v2-1-final");
  assert.equal(sanitizeImageBaseName("...png"), "image");
  assert.equal(sanitizeImageBaseName("??.png"), "image");
  assert.equal(pastedImageBaseName(new Date(2026, 10, 10, 14, 5, 9)), "pasted-image-20261110-140509");

  assert.equal(chooseImageFolder("nb/paper", ["nb/paper/main.tex", "nb/paper/Figures/a.pdf", "nb/paper/sections/intro.tex"]), "Figures");
  assert.equal(chooseImageFolder("nb/paper", ["nb/paper/main.tex", "nb/paper/sections/intro.tex"]), "");
  assert.equal(chooseImageFolder("nb/paper", ["nb/other/figures/a.png", "nb/paper/img/x.png", "nb/paper/figs/y.png"]), "figs", "the preferred folder of the paper's own");
  assert.equal(chooseImageFolder("nb", ["nb/main.tex", "nb/images/a.png"]), "images");

  assert.equal(uniqueImageName("plot", "png", "figures", ["figures/plot.png", "figures/PLOT-2.png"]), "plot-3.png", "collisions compare without case");
  assert.equal(uniqueImageName("plot", "png", "", ["figures/plot.png"]), "plot.png");
  assert.equal(figureLabelFor("plot", ["fig:other"]), "fig:plot");
  assert.equal(figureLabelFor("plot", ["fig:plot"]), null, "a taken label is skipped");

  assert.equal(imageFigureLatex({ path: "figures/plot.png", label: "fig:plot" }),
    "\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{figures/plot.png}\n\t\\caption{}\n\t\\label{fig:plot}\n\\end{figure}");
  assert.match(imageFigureLatex({ path: "d.svg", label: null }), /\\includesvg\[width=0\.8\\linewidth\]\{d\}\n\t\\caption\{\}\n\\end\{figure\}$/);

  const loaded = (...names: string[]) => ({ documentClass: "article", packages: new Set(names) });
  assert.deepEqual(missingImagePackages(loaded(), ["a.png"]), ["\\usepackage{graphicx}"]);
  assert.deepEqual(missingImagePackages(loaded("graphicx"), ["a.png", "b.svg"]), ["\\usepackage{svg}"]);
  assert.deepEqual(missingImagePackages({ documentClass: null, packages: new Set() }, ["a.png"]), [], "no preamble known: nothing claimed");
});

/* ---- Images: paste and drop ---- */

test("an image-only clipboard is an image paste; text with a picture of it is not", () => {
  assert.equal(isImagePaste(transfer([png()])), true, "a screenshot");
  assert.equal(isImagePaste(transfer([png()], { "text/html": "<meta charset=utf-8><img src=\"https://x/y.png\">" })), true, "a browser's Copy Image");
  assert.equal(isImagePaste(transfer([png()], { "text/plain": "Hello", "text/html": "<p>Hello</p>" })), false, "Word: text wins");
  assert.equal(isImagePaste(transfer([], { "text/plain": "Hello" })), false);
  assert.equal(imageFilesOf(transfer([new File(["x"], "notes.txt", { type: "text/plain" })])).length, 0);
});

test("pasting an image hands the files over; text pastes and pastes into math are left alone", () => {
  const requests: LatexImageRequest[] = [];
  const refused: string[] = [];
  const doc = "\\documentclass{article}\n\\begin{document}\nText $x$ here.\n\\end{document}\n";
  const view = mount(EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree"), latexImagePaste(() => ({ onImages: (request) => requests.push(request), onRefused: (message) => refused.push(message) })), latexMarkdownPaste(() => null)] }));
  ensureSyntaxTree(view.state, doc.length, 5000);
  const paste = (data: DataTransfer) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    view.contentDOM.dispatchEvent(event);
    return event.defaultPrevented;
  };
  view.dispatch({ selection: { anchor: doc.indexOf("here") } });
  assert.equal(paste(transfer([png()])), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].range.current()?.from, doc.indexOf("here"));
  requests[0].range.release();
  view.dispatch({ selection: { anchor: doc.indexOf("x$") } });
  assert.equal(paste(transfer([png()])), true);
  assert.equal(requests.length, 1, "nothing goes into math");
  assert.equal(refused.length, 1);
  assert.equal(view.state.doc.toString(), doc, "no byte changed");
  // Text (with or without a picture of it) goes on to the text paste: CodeMirror's own here.
  view.dispatch({ selection: { anchor: doc.indexOf("here") } });
  paste(transfer([png()], { "text/plain": "plain" }));
  assert.equal(requests.length, 1, "no image request for a text paste");
  assert.equal(view.state.doc.toString(), doc.replace("here", "plainhere"));
  view.destroy();
});

test("saving pasted images: a figures folder, free names after a 409, a free label, the preamble untouched", async () => {
  const doc = "\\documentclass{article}\n\\begin{document}\nBefore.\n\n\\label{fig:shot}\nAfter.\n\\end{document}\n";
  const view = mount(EditorState.create({ doc, extensions: [latexLanguageSupport("main.tex", "tree"), latexVisualState(), latexMarkdownPaste(() => null)] }));
  ensureSyntaxTree(view.state, doc.length, 5000);
  const at = doc.indexOf("After.");
  const saved: string[] = [];
  const support = {
    files: ["nb/paper/main.tex", "nb/paper/figures/old.pdf", "nb/paper/figures/shot.png"],
    save: async (directory: string, file: File) => {
      // Someone else's shot-2.png, not in the tree yet.
      if (file.name.toLowerCase() === "shot-2.png") throw Object.assign(new Error("File already exists"), { status: 409 });
      saved.push(`${directory}/${file.name}`);
      return `${directory}/${file.name}`;
    },
  };
  const result = await saveAndInsertImages({ files: [png("Shot.png"), new File(["x"], "a.gif", { type: "image/gif" })], range: trackRange(view, at, at), origin: "drop" }, "nb/paper/main.tex", support);
  assert.deepEqual(saved, ["nb/paper/figures/Shot-3.png"]);
  const text = view.state.doc.toString();
  assert.ok(text.startsWith("\\documentclass{article}\n\\begin{document}\n"), "the preamble is untouched");
  assert.ok(!text.includes("\\usepackage"), "no package is added");
  assert.ok(text.includes("\\includegraphics[width=0.8\\linewidth]{figures/Shot-3.png}\n\t\\caption{}\n\t\\label{fig:Shot-3}\n\\end{figure}"), text);
  assert.equal(view.state.sliceDoc(view.state.selection.main.head - "\\caption{".length, view.state.selection.main.head), "\\caption{", "the caret waits in the caption");
  assert.deepEqual(result.missing, ["\\usepackage{graphicx}"]);
  assert.match(result.message ?? "", /a\.gif.*PNG, JPEG, PDF or SVG/);
  view.destroy();
});

/* ---- Drawing previews: pure parts ---- */

test("drawing sources are found as the Visual mode names their placeholders", () => {
  const float = String.raw`\begin{figure}
  \centering
  % \begin{tikzpicture} commented \end{tikzpicture}
  \begin{tikzpicture}\node {a \begin{tikzpicture}\end{tikzpicture}};\end{tikzpicture}
  \[\begin{tikzcd} A \arrow[r] & B \end{tikzcd}\]
  \begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}
  \xymatrix@C=1em{A \ar[r] & B}
  \resizebox{\linewidth}{!}{\input{fig_co}}
  \tikzfig{graph}
  \caption{Pictures.}
\end{figure}`;
  assert.equal(drawingSource(float, "", 0), String.raw`\begin{tikzpicture}\node {a \begin{tikzpicture}\end{tikzpicture}};\end{tikzpicture}`, "nested pictures stay inside");
  assert.equal(drawingSource(float, "", 1), String.raw`\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}`);
  assert.equal(drawingSource(float, "", 2), null);
  assert.equal(drawingSource(float, "diagram:tikz-cd", 0), String.raw`\[\begin{tikzcd} A \arrow[r] & B \end{tikzcd}\]`, "display math around it is kept");
  assert.equal(drawingSource(float, "diagram:xy", 0), String.raw`\(\xymatrix@C=1em{A \ar[r] & B}\)`, "xy goes in math");
  assert.equal(drawingSource(float, "fig_co", 0), String.raw`\input{fig_co}`);
  assert.equal(drawingSource(float, "graph.tikz", 0), String.raw`\tikzfig{graph}`);
});

test("the preview document keeps the preamble, strips page furniture, and falls back to article", () => {
  const doc = "\\documentclass[twocolumn]{revtex4-2}\n\\usepackage{tikz}\n\\newcommand{\\R}{\\mathbb{R}}\n% \\begin{document} in a comment\n\\begin{document}\nBody\n\\end{document}";
  const preamble = documentPreamble(doc)!;
  assert.ok(preamble.endsWith("% \\begin{document} in a comment\n"));
  assert.equal(documentPreamble("\\section{Chapter}\n\\begin{document}"), null, "no class, no preamble");
  const own = assemblePreviewDocument(preamble, "\\begin{tikzpicture}\\end{tikzpicture}");
  assert.ok(own.startsWith("\\documentclass[twocolumn]{revtex4-2}\n\\usepackage{tikz}\n\\newcommand{\\R}"));
  assert.match(own, /\\begin\{document\}\n\\pagestyle\{empty\}\\thispagestyle\{empty\}%\n.*nolinenumbers.*\n\\noindent\n\\begin\{tikzpicture\}\\end\{tikzpicture\}\n\\end\{document\}\n$/);
  const article = assemblePreviewDocument(preamble, "x", "article");
  assert.ok(article.startsWith("\\documentclass{article}\n\\usepackage{tikz}"));
  assert.match(assemblePreviewDocument("\\documentclass{beamer}\n", "x"), /\\begin\{frame\}\[plain\]\n\\noindent\nx\n\\end\{frame\}/);
  assert.equal(previewHash("a", "b"), previewHash("a", "b"));
  assert.notEqual(previewHash("a", "b"), previewHash("a", "c"));
  assert.notEqual(previewHash("ab", ""), previewHash("a", "b"), "parts are separated");
  assert.equal(previewErrorSummary("junk\n./preview.tex:12: Undefined control sequence.\nl.12"), "Undefined control sequence.");
  assert.equal(previewErrorSummary(""), "The picture could not be compiled.");
});

test("cropping keeps the ink plus a margin, inside the page; a blank page has none", () => {
  const width = 10;
  const height = 8;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const ink = (x: number, y: number) => { pixels.set([0, 0, 0, 255], (y * width + x) * 4); };
  assert.equal(cropBox(pixels, width, height), null);
  ink(3, 2);
  ink(6, 4);
  assert.deepEqual(cropBox(pixels, width, height, { margin: 1 }), { x: 2, y: 1, width: 6, height: 5 });
  assert.deepEqual(cropBox(pixels, width, height, { margin: 5 }), { x: 0, y: 0, width: 10, height: 8 });
  // Near-white and transparent pixels are paper.
  pixels.fill(255);
  pixels.set([250, 250, 250, 255], 0);
  pixels.set([0, 0, 0, 0], 4);
  assert.equal(cropBox(pixels, width, height), null);
});

/* ---- Drawing previews: the placeholder ---- */

test("a TikZ placeholder gets a Preview that compiles only on click, with the preamble and that picture; errors show inside it", async () => {
  const doc = String.raw`\documentclass{article}
\usepackage{tikz}
\begin{document}
\begin{figure}
  \centering
  \begin{tikzpicture}\draw (0,0) circle (1);\end{tikzpicture}
  \begin{tikzpicture}\draw (0,0) -- (2,0);\end{tikzpicture}
  \caption{Two.}
\end{figure}
\end{document}
`;
  const calls: Array<Parameters<DrawingPreviewConfig["compile"]>[0]> = [];
  const config: DrawingPreviewConfig = { rootPath: "nb/main.tex", engine: () => "auto", compile: async (request) => { calls.push(request); return { error: "Undefined control sequence." }; } };
  const view = mount(visualState(doc, [drawingPreviewConfig.of(config)]));
  const buttons = [...view.contentDOM.querySelectorAll<HTMLButtonElement>(".cm-vis-drawing-preview-button")];
  assert.equal(buttons.length, 2, "one per drawing");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 0, "nothing compiles by itself");
  buttons[1].click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].picture, String.raw`\begin{tikzpicture}\draw (0,0) -- (2,0);\end{tikzpicture}`);
  assert.equal(calls[0].preamble, "\\documentclass{article}\n\\usepackage{tikz}\n");
  const placeholder = buttons[1].closest(".cm-vis-figure-drawing")!;
  assert.equal(placeholder.querySelector(".cm-vis-drawing-preview-error")?.textContent, "Undefined control sequence.");
  assert.equal(view.state.doc.toString(), doc, "no byte changed");
  view.destroy();
  // Without a configured compiler (viewers, tests), no button.
  const plain = mount(visualState(doc));
  assert.equal(plain.contentDOM.querySelectorAll(".cm-vis-drawing-preview-button").length, 0);
  plain.destroy();
});
