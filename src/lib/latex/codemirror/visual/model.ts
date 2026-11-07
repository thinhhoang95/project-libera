import { Facet, StateEffect, StateField, type EditorState, type Text, type Transaction } from "@codemirror/state";
import { EMPTY_AUX, type LatexAuxData } from "../../aux-file";
import { bodyStartOf, emptyLatexDefinitions, readLatexDefinitions, type LatexDefinitions } from "../../macros/definitions";
import { EMPTY_NUMBERING, type LatexNumbering, type NumberingStart } from "../../macros/numbering";

/* State shared by the Visual mode's layers (docs/latex-visual-editor-plan.md).
 * Nothing here changes the document. */

export type VisualConfig = {
  /** Notebook path of the open file, to resolve figures and links. */
  documentPath: string;
  /** URL of a notebook file, for image previews; null when it cannot be shown. */
  fileUrl: (notebookPath: string) => string | null;
  /** Opens an http(s) or mailto link. */
  openLink: (url: string) => void;
  /** Whether formula and table editors may open (false for viewers). */
  editable: () => boolean;
};

const DEFAULT_CONFIG: VisualConfig = {
  documentPath: "",
  fileUrl: () => null,
  openLink: (url) => { if (/^(?:https?:|mailto:)/i.test(url)) window.open(url, "_blank", "noopener"); },
  editable: () => true,
};

export const visualConfig = Facet.define<Partial<VisualConfig>, VisualConfig>({
  combine: (values) => Object.assign({}, DEFAULT_CONFIG, ...values),
});

/** Another file of the project whose definitions apply (the root's preamble, `\input` macro files, local `.sty` files). */
export type MacroSource = { path: string; text: string; version: string };

export const setMacroSources = StateEffect.define<MacroSource[]>();
export const setAuxData = StateEffect.define<LatexAuxData>();
export const setNumbering = StateEffect.define<LatexNumbering>();
export const togglePreamble = StateEffect.define<boolean>();
export const setNumberingStart = StateEffect.define<NumberingStart | null>();

/** Counter values where this file is included in its main file (null for a main file). */
export const numberingStartField = StateField.define<NumberingStart | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setNumberingStart)) value = effect.value;
    return value;
  },
});

export const macroSourcesField = StateField.define<MacroSource[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMacroSources)) value = effect.value;
    return value;
  },
});

export const auxField = StateField.define<LatexAuxData>({
  create: () => EMPTY_AUX,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setAuxData)) value = effect.value;
    return value;
  },
});

/** Numbers of headings, equations, figures, theorems and labels; computed after a pause in typing (numbering.ts). */
export const numberingField = StateField.define<LatexNumbering>({
  create: () => EMPTY_NUMBERING,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setNumbering)) value = effect.value;
    return value;
  },
});

/** Whether the preamble is shown as source (its block's header toggles it). */
export const preambleOpenField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(togglePreamble)) value = effect.value;
    return value;
  },
});

/* Where the document body starts (after `\begin{document}`), per document
 * version. Finding it scans the text, so each transaction maps the previous
 * answer instead, unless the edit is on the `\begin{document}` line or adds
 * or removes one. */
const bodyStarts = new WeakMap<Text, number>();
const BEGIN_DOCUMENT = /\\begin\s*\{\s*document\s*\}/;

export function bodyStartIn(doc: Text): number {
  let cached = bodyStarts.get(doc);
  if (cached === undefined) {
    cached = bodyStartOf(doc.sliceString(0, Math.min(doc.length, 400_000)));
    bodyStarts.set(doc, cached);
  }
  return cached;
}

/** Carries the body start of a transaction's old document over to the new one when the edit cannot move it otherwise. */
export function noteBodyStart(tr: Transaction) {
  if (!tr.docChanged || bodyStarts.has(tr.state.doc)) return;
  const old = bodyStarts.get(tr.startState.doc);
  if (old === undefined) return;
  let safe = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!safe) return;
    const before = tr.startState.doc;
    const touched = before.sliceString(before.lineAt(fromA).from, before.lineAt(toA).to);
    if (BEGIN_DOCUMENT.test(touched) || /document|begin/.test(inserted.toString())) safe = false;
  });
  if (safe) bodyStarts.set(tr.state.doc, old <= 0 ? old : tr.changes.mapPos(old));
}

const DEFINITION_HINT =/\\(?:new|renew|provide|Declare|def|gdef|edef|xdef|let|theoremstyle|numberwithin|crefname|Crefname|NewDocument|RenewDocument|ProvideDocument|documentclass|usepackage)/;

function computeDefinitions(state: EditorState, sources: readonly MacroSource[]): LatexDefinitions {
  const defs = emptyLatexDefinitions();
  for (const source of sources) readLatexDefinitions(source.text, defs, { file: source.path });
  readLatexDefinitions(state.doc.toString(), defs, { bodyStart: bodyStartIn(state.doc) });
  return defs;
}

/** Whether a transaction may have changed a definition: an edit in the preamble, or on a line that defines something. */
function touchesDefinitions(tr: Transaction) {
  if (!tr.docChanged) return false;
  const oldBody = bodyStartIn(tr.startState.doc);
  noteBodyStart(tr);
  let touched = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (touched) return;
    if (fromA <= oldBody) { touched = true; return; }
    const oldLines = tr.startState.doc.sliceString(tr.startState.doc.lineAt(fromA).from, tr.startState.doc.lineAt(toA).to);
    const newLines = tr.state.doc.sliceString(tr.state.doc.lineAt(fromB).from, tr.state.doc.lineAt(toB).to);
    if (DEFINITION_HINT.test(oldLines) || DEFINITION_HINT.test(newLines)) touched = true;
  });
  return touched;
}

/** The definitions that apply in the open file: other files' first, then its own preamble and body. */
export const definitionsField = StateField.define<LatexDefinitions>({
  create: (state) => computeDefinitions(state, state.field(macroSourcesField, false) ?? []),
  update(value, tr) {
    const sourcesChanged = tr.startState.field(macroSourcesField, false) !== tr.state.field(macroSourcesField, false);
    if (!sourcesChanged && !touchesDefinitions(tr)) return value;
    const next = computeDefinitions(tr.state, tr.state.field(macroSourcesField, false) ?? []);
    return next.fingerprint === value.fingerprint && next.problems.length === value.problems.length ? value : next;
  },
});

export function visualDefinitions(state: EditorState) {
  return state.field(definitionsField, false) ?? emptyLatexDefinitions();
}

export function visualNumbering(state: EditorState) {
  return state.field(numberingField, false) ?? EMPTY_NUMBERING;
}

export function visualAux(state: EditorState) {
  return state.field(auxField, false) ?? EMPTY_AUX;
}

export const visualStateFields = [macroSourcesField, auxField, numberingField, numberingStartField, preambleOpenField, definitionsField];
