import { forEachDiagnostic, setDiagnostics, setDiagnosticsEffect, type Diagnostic } from "@codemirror/lint";
import type { EditorState, Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { isInLatexComment, readLatexInputs, type LatexDefinitionNote } from "../../macros/definitions";
import { latexProjectField } from "../editing";
import { visualConfig, visualDefinitions } from "./model";

/* Why something stays source, at its call site, in both modes (docs/features/latex-visual-editor.md): a definition with a
 * mistake or one the Visual mode does not render (definitions.ts `problems` and `unsupported`), and an `\input`, image or
 * local package that is not in the project. Shown as lint diagnostics (warning and info) beside the compile's, which they
 * never replace. Packages named without a path are not checked: TeX finds them in its own distribution. */

/** The `source` these diagnostics carry, which tells them apart from the compile's. */
export const DEFINITION_DIAGNOSTIC_SOURCE = "Visual mode";
/** How long after the last edit they are worked out again (they read the whole file). */
const DELAY = 700;

const IMAGE_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "eps", "svg", "gif", "ps"];

/** A definition note at its command in the open file (another file's are at its `\input` or `\usepackage`, when this file loads it). */
function noteRange(state: EditorState, note: LatexDefinitionNote) {
  const doc = state.doc;
  if (note.file === undefined) {
    if (note.pos < 0 || note.pos >= doc.length) return null;
    const command = /^\\[A-Za-z@]+\*?/.exec(doc.sliceString(note.pos, Math.min(doc.length, note.pos + 64)));
    return { from: note.pos, to: note.pos + (command ? command[0].length : 1) };
  }
  return null;
}

/** Where this file loads `file` (a path of the project): its `\input{…}` or `\usepackage{…}`, by the file's name. */
function loadRange(text: string, file: string) {
  const stem = file.replace(/^.*\//, "").replace(/\.(?:tex|sty|cls|ltx)$/i, "");
  if (!stem || !/^[\w.-]+$/.test(stem)) return null;
  const pattern = new RegExp(String.raw`\\(?:input|include|usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\b${stem.replace(/[.]/g, "\\.")}(?:\.(?:tex|sty|cls))?\s*[,}]`, "g");
  for (const match of text.matchAll(pattern)) if (!isInLatexComment(text, match.index ?? 0)) return { from: match.index ?? 0, to: (match.index ?? 0) + match[0].length };
  return null;
}

/** The diagnostics for `state`: definitions that stay source, and files the document loads that the project does not have. */
export function definitionDiagnostics(state: EditorState): Diagnostic[] {
  const defs = visualDefinitions(state);
  const text = state.doc.toString();
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const add = (from: number, to: number, severity: Diagnostic["severity"], message: string) => {
    const key = `${from}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from, to, severity, message, source: DEFINITION_DIAGNOSTIC_SOURCE });
  };
  const notes: Array<[LatexDefinitionNote, Diagnostic["severity"], string]> = [
    ...defs.problems.map((note) => [note, "warning", "its uses stay source in the Visual mode"] as [LatexDefinitionNote, Diagnostic["severity"], string]),
    ...defs.unsupported.map((note) => [note, "info", "its uses stay source in the Visual mode"] as [LatexDefinitionNote, Diagnostic["severity"], string]),
  ];
  /** Another file's notes, by file: one diagnostic at its load, naming the commands. */
  const byFile = new Map<string, { problems: number; names: string[] }>();
  for (const [note, severity, consequence] of notes) {
    if (note.file !== undefined) {
      const entry = byFile.get(note.file) ?? { problems: 0, names: [] };
      if (severity === "warning") entry.problems++;
      if (!entry.names.includes(note.name)) entry.names.push(note.name);
      byFile.set(note.file, entry);
      continue;
    }
    const range = noteRange(state, note);
    if (range) add(range.from, range.to, severity, `${note.message}: ${consequence}.`);
  }
  for (const [file, entry] of byFile) {
    const range = loadRange(text, file);
    if (!range) continue;
    const names = entry.names.slice(0, 6).map((name) => (/^[A-Za-z@]+$/.test(name) ? `\\${name}` : name)).join(", ");
    add(range.from, range.to, entry.problems ? "warning" : "info", `${file}: ${entry.names.length} definition${entry.names.length === 1 ? "" : "s"} the Visual mode does not render (${names}${entry.names.length > 6 ? ", …" : ""}); their uses stay source.`);
  }
  // Files: only for a file compiled from its own folder (a chapter's paths are its main file's), once the project is known.
  const config = state.facet(visualConfig);
  const project = state.field(latexProjectField, false);
  const paths = project?.allPaths;
  if (!paths?.length || (config.rootPath && config.rootPath !== config.documentPath)) return out.sort((a, b) => a.from - b.from);
  const known = new Set(paths.map((path) => path.replace(/^\.\//, "")));
  const clean = (name: string) => name.trim().replace(/^\.\//, "");
  for (const input of readLatexInputs(text)) {
    if (input.command !== "input" && input.command !== "include" && input.command !== "subfile") continue;
    const name = clean(input.path);
    // `\input` of a bare name may be a file of TeX's distribution (`glyphtounicode`): only a folder or `.tex` makes it the project's.
    if (!name || /[#\\]/.test(name) || (input.command === "input" && !/\//.test(name) && !/\.tex$/i.test(name))) continue;
    if (!known.has(name) && !known.has(`${name}.tex`)) add(input.pos, input.end, "warning", `${name} is not in the project: what it holds is not shown in the Visual mode.`);
  }
  const graphicsDirs = ["", ...defs.graphicsPaths.map((dir) => clean(dir).replace(/([^/])$/, "$1/"))];
  for (const match of text.matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}\\#]+)\}/g)) {
    const at = match.index ?? 0;
    if (isInLatexComment(text, at)) continue;
    const name = clean(match[1]);
    const found = graphicsDirs.some((dir) => {
      const path = `${dir}${name}`;
      return known.has(path) || IMAGE_EXTENSIONS.some((extension) => known.has(`${path}.${extension}`));
    });
    if (!found) add(at, at + match[0].length, "info", `The image ${name} is not in the project.`);
  }
  // A local package or class named by a path (`\usepackage{styles/mine}`): one TeX's distribution has would have no folder.
  for (const match of text.matchAll(/\\(usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g)) {
    const at = match.index ?? 0;
    if (isInLatexComment(text, at)) continue;
    const extension = match[1] === "documentclass" ? "cls" : "sty";
    for (const name of match[2].split(",").map(clean)) {
      if (!name.includes("/")) continue;
      if (!known.has(`${name}.${extension}`) && !known.has(name)) add(at, at + match[0].length, "warning", `${name}.${extension} is not in the project.`);
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

function sameDiagnostics(a: readonly Diagnostic[], b: readonly Diagnostic[]) {
  return a.length === b.length && a.every((item, index) => item.from === b[index].from && item.to === b[index].to && item.message === b[index].message);
}

/**
 * Keeps the definition diagnostics in the editor's lint state: worked out a moment after edits (and when the definitions or
 * the project change), added to the diagnostics already there (the compile's), and added again when those are replaced.
 */
export function latexDefinitionDiagnostics(): Extension {
  return ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | null = null;
    /** True while our own `setDiagnostics` is dispatched: it needs no second pass. */
    dispatching = false;
    constructor(readonly view: EditorView) { this.schedule(); }
    update(update: ViewUpdate) {
      const defsChanged = visualDefinitions(update.startState) !== visualDefinitions(update.state);
      const projectChanged = update.startState.field(latexProjectField, false) !== update.state.field(latexProjectField, false);
      // Only a `setDiagnosticsEffect` replaces the lint state (a compile's diagnostics); other effects (numbering, cursors, parser progress) leave it as is.
      const replaced = !this.dispatching && update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setDiagnosticsEffect)));
      if (update.docChanged || defsChanged || projectChanged || replaced) this.schedule();
    }
    schedule() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, DELAY);
    }
    refresh() {
      const view = this.view;
      const next = definitionDiagnostics(view.state);
      const others: Diagnostic[] = [];
      const shown: Diagnostic[] = [];
      forEachDiagnostic(view.state, (diagnostic, from, to) => (diagnostic.source === DEFINITION_DIAGNOSTIC_SOURCE ? shown : others).push({ ...diagnostic, from, to }));
      if (sameDiagnostics(shown.sort((a, b) => a.from - b.from), next)) return;
      this.dispatching = true;
      try { view.dispatch(setDiagnostics(view.state, [...others, ...next])); } finally { this.dispatching = false; }
    }
    destroy() { if (this.timer) clearTimeout(this.timer); }
  });
}
