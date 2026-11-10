import { Facet, StateEffect, StateField, type EditorState, type Text, type Transaction } from "@codemirror/state";
import { EMPTY_AUX, type LatexAuxData } from "../../aux-file";
import { bodyStartOf, collectLatexDefinitions, definitionsFingerprint, emptyLatexDefinitions, mapLatexDefinitions, type DefinitionSource, type LatexDefinitions } from "../../macros/definitions";
import { EMPTY_NUMBERING, type LatexNumbering, type NumberingStart } from "../../macros/numbering";
import { disabledRegions, discardingMacros } from "../../macros/structure";

/* State shared by the Visual mode's layers (docs/latex-visual-editor-plan.md).
 * Nothing here changes the document. */

export type VisualConfig = {
  /** Notebook path of the open file. */
  documentPath: string;
  /** Notebook path of the file TeX compiles (the main file of a chapter): figures resolve from its directory, as TeX does. Defaults to `documentPath`. */
  rootPath?: string;
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

/**
 * Another file of the project whose definitions apply (the root's preamble,
 * `\input` macro files, local `.sty` files). `loadedBy` and `key` say where it
 * is read (definitions.ts `DefinitionSource`): sources without them first.
 */
export type MacroSource = DefinitionSource & { version: string };

export const setMacroSources = StateEffect.define<MacroSource[]>();
export const setAuxData = StateEffect.define<LatexAuxData>();
export const setNumbering = StateEffect.define<LatexNumbering>();
export const togglePreamble = StateEffect.define<boolean>();
export const setNumberingStart = StateEffect.define<NumberingStart | null>();

/** Texts of the files this file `\input`s or `\include`s in its body, by `loadKey("input", name)`: their counters advance its numbers. */
export const setNumberingIncludes = StateEffect.define<ReadonlyMap<string, string>>();

export const numberingIncludesField = StateField.define<ReadonlyMap<string, string>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setNumberingIncludes)) value = effect.value;
    return value;
  },
});

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

/** Whether an edit could change what `\iffalse … \fi` leaves out: it is near a conditional's `\if…`, `\else` or `\fi`. */
function touchesConditionals(tr: Transaction) {
  let touched = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (touched) return;
    const near = (doc: Text, from: number, to: number) => doc.sliceString(Math.max(0, from - 12), Math.min(doc.length, to + 12));
    if (/\\(?:if|fi|else)/.test(near(tr.startState.doc, fromA, toA)) || /\\(?:if|fi|else)/.test(near(tr.state.doc, fromB, toB))) touched = true;
  });
  return touched;
}

/** Whether an edit could change what a discarding macro's use leaves out: it adds or removes a brace, backslash or `%`, or is next to a command. */
function touchesGroups(tr: Transaction) {
  let touched = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (touched) return;
    const near = tr.state.doc.sliceString(Math.max(0, fromB - 40), Math.min(tr.state.doc.length, toB + 2));
    if (/[{}\\%]/.test(inserted.toString()) || /[{}\\%]/.test(tr.startState.doc.sliceString(fromA, toA)) || /\\[A-Za-z@]*$/.test(near.slice(0, fromB - Math.max(0, fromB - 40)))) touched = true;
  });
  return touched;
}

/** The document's macros that discard their arguments, by name: a change to them changes what is left out. */
const discardingKey = (state: EditorState) => [...discardingMacros(visualDefinitions(state)).keys()].join(",");

/** What `\iffalse … \fi` and uses of macros that discard their arguments leave out (structure.ts `disabledRegions`): kept in step with edits. */
export const disabledField = StateField.define<Array<{ from: number; to: number }>>({
  create: (state) => disabledRegions(state.doc.toString(), discardingMacros(visualDefinitions(state))),
  update(value, tr) {
    const discarding = discardingMacros(visualDefinitions(tr.state));
    const recompute = () => disabledRegions(tr.state.doc.toString(), discarding);
    if (discardingKey(tr.startState) !== discardingKey(tr.state)) return recompute();
    if (!tr.docChanged) return value;
    if (touchesConditionals(tr) || (discarding.size && touchesGroups(tr))) return recompute();
    if (!value.length) return value;
    return value.map((region) => ({ from: tr.changes.mapPos(region.from, 1), to: tr.changes.mapPos(region.to, -1) })).filter((region) => region.to > region.from);
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

/** Commands that define something, or that change which definitions TeX runs (conditionals, groups, verbatim). */
const DEFINITION_HINT = /\\(?:new|renew|provide|Declare|def|gdef|edef|xdef|let|theoremstyle|numberwithin|counterwithin|crefname|Crefname|NewDocument|RenewDocument|ProvideDocument|documentclass|usepackage|input|graphicspath|alg(?:new|renew)command|algdef|algblock|algtext|SetKw|if|fi(?![A-Za-z])|else(?![A-Za-z])|begingroup|endgroup|verb|(?:begin|end)\s*\{(?:verbatim|Verbatim|comment|lstlisting|minted))/;

function computeDefinitions(state: EditorState, sources: readonly MacroSource[]): LatexDefinitions {
  return collectLatexDefinitions(sources, { text: state.doc.toString(), bodyStart: bodyStartIn(state.doc) });
}

/**
 * Whether a transaction may have changed a definition: an edit in the
 * preamble, inside a definition (its body may span lines), on a line that
 * defines something, or a brace before the end of a local definition's group.
 */
function touchesDefinitions(tr: Transaction, defs: LatexDefinitions) {
  if (!tr.docChanged) return false;
  const oldBody = bodyStartIn(tr.startState.doc);
  noteBodyStart(tr);
  let scopedUntil = -1;
  for (const list of defs.macros.values()) for (const macro of list) if (macro.end !== undefined) scopedUntil = Math.max(scopedUntil, macro.end);
  let touched = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (touched) return;
    if (fromA <= oldBody) { touched = true; return; }
    if (defs.extents.some((extent) => fromA <= extent.to && toA >= extent.from)) { touched = true; return; }
    if (fromA <= scopedUntil && /[{}\\]/.test(inserted.toString() + tr.startState.doc.sliceString(fromA, toA))) { touched = true; return; }
    const oldLines = tr.startState.doc.sliceString(tr.startState.doc.lineAt(fromA).from, tr.startState.doc.lineAt(toA).to);
    const newLines = tr.state.doc.sliceString(tr.state.doc.lineAt(fromB).from, tr.state.doc.lineAt(toB).to);
    if (DEFINITION_HINT.test(oldLines) || DEFINITION_HINT.test(newLines)) touched = true;
  });
  return touched;
}

/** Whether definitions have anything with a position in the open file, which edits before it move. */
function hasPositions(defs: LatexDefinitions) {
  if (defs.extents.length || defs.problems.some((note) => note.file === undefined) || defs.unsupported.some((note) => note.file === undefined)) return true;
  for (const list of defs.macros.values()) for (const macro of list) if (macro.pos >= 0 || macro.end !== undefined) return true;
  return false;
}

/** The definitions that apply in the open file: other files' first, then its own preamble and body. */
export const definitionsField = StateField.define<LatexDefinitions>({
  create: (state) => computeDefinitions(state, state.field(macroSourcesField, false) ?? []),
  update(value, tr) {
    const sourcesChanged = tr.startState.field(macroSourcesField, false) !== tr.state.field(macroSourcesField, false);
    const touched = touchesDefinitions(tr, value);
    // Positions in the body follow the edit, as the decorations do: the fingerprint stays.
    const mapped = tr.docChanged && hasPositions(value) ? mapLatexDefinitions(value, tr.changes) : value;
    if (!sourcesChanged && !touched) return mapped;
    const next = computeDefinitions(tr.state, tr.state.field(macroSourcesField, false) ?? []);
    const same = next.fingerprint === (mapped === value ? value.fingerprint : definitionsFingerprint(mapped)) && next.problems.length === value.problems.length;
    if (!same) return next;
    // The same definitions: keep the fingerprint the decorations were built with, with the extents just read.
    return mapped === value ? value : { ...next, fingerprint: mapped.fingerprint };
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

export const visualStateFields = [macroSourcesField, auxField, numberingField, numberingStartField, numberingIncludesField, preambleOpenField, definitionsField, disabledField];
