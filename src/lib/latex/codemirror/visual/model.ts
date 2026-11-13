import { Facet, StateEffect, StateField, type EditorState, type Text, type Transaction } from "@codemirror/state";
import { EMPTY_AUX, type LatexAuxData } from "../../aux-file";
import { bodyStartOf, collectLatexDefinitions, conditionalFactsKey, definitionsFingerprint, emptyLatexDefinitions, mapLatexDefinitions, type DefinitionSource, type LatexDefinitions } from "../../macros/definitions";
import { EMPTY_NUMBERING, type LatexNumbering, type NumberingStart } from "../../macros/numbering";
import { disabledRegions, discardingMacros, macroEnvironmentRegions, type MacroEnvironmentRegion } from "../../macros/structure";

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

/**
 * A conditional's command. `\iff` (the arrow) opens nothing and decides nothing (conditionals.ts `opensConditional`, structure.ts
 * `falseRegions`), so it does not count; a `\iff` cut off by the end of the text might be `\iffalse`, so it does.
 */
const CONDITIONAL_HINT = /\\(?:if(?!f[^A-Za-z@])|fi|else|unless|repeat)/;

/** Whether an edit could change what `\iffalse … \fi` leaves out: it is near a conditional's `\if…`, `\else` or `\fi`. */
function touchesConditionals(tr: Transaction) {
  let touched = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (touched) return;
    const near = (doc: Text, from: number, to: number) => doc.sliceString(Math.max(0, from - 12), Math.min(doc.length, to + 12));
    if (CONDITIONAL_HINT.test(near(tr.startState.doc, fromA, toA)) || CONDITIONAL_HINT.test(near(tr.state.doc, fromB, toB))) touched = true;
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

/** The document's macros that discard their arguments, and what decides its conditionals (`\def\llncs{0}`): a change to them changes what is left out. */
const discardingKey = (state: EditorState) => `${[...discardingMacros(visualDefinitions(state)).keys()].join(",")}\u0000${conditionalFactsKey(visualDefinitions(state))}`;

/** What `\iffalse … \fi` and uses of macros that discard their arguments leave out (structure.ts `disabledRegions`): kept in step with edits. */
export const disabledField = StateField.define<Array<{ from: number; to: number; braced?: boolean }>>({
  create: (state) => disabledRegions(state.doc.toString(), discardingMacros(visualDefinitions(state)), visualDefinitions(state)),
  update(value, tr) {
    const discarding = discardingMacros(visualDefinitions(tr.state));
    const recompute = () => disabledRegions(tr.state.doc.toString(), discarding, visualDefinitions(tr.state));
    // (The keys list every macro: with the same definitions they are the same.)
    if (visualDefinitions(tr.startState) !== visualDefinitions(tr.state) && discardingKey(tr.startState) !== discardingKey(tr.state)) return recompute();
    if (!tr.docChanged) return value;
    // A braced test's branches (`\iftoggle{t}{…}{…}`, structure.ts) end at their braces, as a discarding macro's arguments do.
    if (touchesConditionals(tr) || ((discarding.size || value.some((region) => region.braced)) && touchesGroups(tr))) return recompute();
    if (!value.length) return value;
    return value.map((region) => ({ ...region, from: tr.changes.mapPos(region.from, 1), to: tr.changes.mapPos(region.to, -1) })).filter((region) => region.to > region.from);
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
const DEFINITION_HINT = /\\(?:new|renew|provide|Declare|declare|def|gdef|edef|xdef|let|mathchardef|setboolean|set(?:bool|toggle)|not(?:toggle|bool)|PassOptions|loop|repeat|unless|ProcessOptions|ExecuteOptions|[A-Za-z@]+(?:true|false)(?![A-Za-z@])|theoremstyle|numberwithin|counterwithin|crefname|Crefname|NewDocument|RenewDocument|ProvideDocument|(?:New|Renew|Provide)Expandable|documentclass|usepackage|input|graphicspath|alg(?:new|renew)command|algdef|algblock|algtext|SetKw|if|fi(?![A-Za-z])|else(?![A-Za-z])|begingroup|endgroup|verb|(?:begin|end)\s*\{(?:verbatim|Verbatim|comment|lstlisting|minted))/;

/**
 * `DEFINITION_HINT` without the commands the definition reader skips whatever they follow: `\iff` (the arrow: definitions.ts
 * `TexScanner.advance` never opens a conditional for it), and `\newline`, `\newpage`, `\newblock` (no branch there, and no
 * entry of its `DEFINITION` list, matches them). Unless the document defines a macro of one of those names: its uses
 * may then be a definer's (definitions.ts `definitionPattern`).
 */
const IGNORED_COMMANDS = ["iff", "newline", "newpage", "newblock"];
const DEFINITION_HINT_TRIMMED = new RegExp(DEFINITION_HINT.source.replace("\\\\(?:", `\\\\(?!(?:${IGNORED_COMMANDS.join("|")})(?![A-Za-z@]))(?:`));
const definitionHint = (defs: LatexDefinitions) => (IGNORED_COMMANDS.some((name) => defs.macros.has(name)) ? DEFINITION_HINT : DEFINITION_HINT_TRIMMED);

/** Where the last macro that is local to a group stops applying, per definitions. */
const scopedEnds = new WeakMap<LatexDefinitions, number>();
function scopedUntilOf(defs: LatexDefinitions) {
  let known = scopedEnds.get(defs);
  if (known === undefined) {
    known = -1;
    for (const list of defs.macros.values()) for (const macro of list) if (macro.end !== undefined) known = Math.max(known, macro.end);
    scopedEnds.set(defs, known);
  }
  return known;
}

/** The largest position `mapLatexDefinitions` moves (-1 when it moves none), per definitions. */
const positionLimits = new WeakMap<LatexDefinitions, number>();
function positionLimit(defs: LatexDefinitions) {
  let known = positionLimits.get(defs);
  if (known === undefined) {
    known = -1;
    for (const list of defs.macros.values()) for (const macro of list) known = Math.max(known, macro.pos, macro.end ?? -1);
    for (const env of defs.environments.values()) known = Math.max(known, env.pos);
    for (const list of defs.switches?.values() ?? []) for (const setting of list) known = Math.max(known, setting.pos, setting.end ?? -1);
    for (const extent of defs.extents) known = Math.max(known, extent.from, extent.to);
    for (const note of [...defs.problems, ...defs.unsupported]) if (note.file === undefined) known = Math.max(known, note.pos);
    positionLimits.set(defs, known);
  }
  return known;
}

/** Whether every change starts after every position the definitions hold, so mapping them through it would move none. */
function changesAfterDefinitions(defs: LatexDefinitions, tr: Transaction) {
  const limit = positionLimit(defs);
  let after = true;
  tr.changes.iterChangedRanges((fromA) => { if (fromA <= limit) after = false; });
  return after;
}

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
  const scopedUntil = scopedUntilOf(defs);
  const hint = definitionHint(defs);
  let touched = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (touched) return;
    if (fromA <= oldBody) { touched = true; return; }
    if (defs.extents.some((extent) => fromA <= extent.to && toA >= extent.from)) { touched = true; return; }
    if (fromA <= scopedUntil && /[{}\\]/.test(inserted.toString() + tr.startState.doc.sliceString(fromA, toA))) { touched = true; return; }
    const oldLines = tr.startState.doc.sliceString(tr.startState.doc.lineAt(fromA).from, tr.startState.doc.lineAt(toA).to);
    const newLines = tr.state.doc.sliceString(tr.state.doc.lineAt(fromB).from, tr.state.doc.lineAt(toB).to);
    if (hint.test(oldLines) || hint.test(newLines)) touched = true;
  });
  return touched;
}

/** Whether definitions have anything with a position in the open file, which edits before it move. */
function hasPositions(defs: LatexDefinitions) {
  if (defs.extents.length || defs.problems.some((note) => note.file === undefined) || defs.unsupported.some((note) => note.file === undefined)) return true;
  // A local definition of another file ended there (end -1): it has no position here.
  for (const list of defs.macros.values()) for (const macro of list) if (macro.pos >= 0 || (macro.end !== undefined && macro.end >= 0)) return true;
  return false;
}

/** The environments a document opens and closes through macros, per document version. */
const macroRegions = new WeakMap<Text, { defs: LatexDefinitions; regions: MacroEnvironmentRegion[] }>();
export function macroRegionsFor(doc: Text, defs: LatexDefinitions) {
  const cached = macroRegions.get(doc);
  if (cached?.defs === defs) return cached.regions;
  const regions = macroEnvironmentRegions(() => doc.toString(), defs);
  macroRegions.set(doc, { defs, regions });
  return regions;
}

/** The regions held for a document version, or undefined (for tests: whether a transaction carried them over). */
export function heldMacroRegions(doc: Text, defs: LatexDefinitions) {
  const cached = macroRegions.get(doc);
  return cached?.defs === defs ? cached.regions : undefined;
}

const REACH = 2000;
const NOT_INERT = /[\\%{}\n\r]/;

/**
 * Whether replacing `fromA`-`toA` of `doc` by `inserted` leaves every token `macroEnvironmentRegions` reads (comments,
 * `\begin{…}`, `\end{…}`, control words) as it was: no `\`, `%`, brace or line break goes in or out, the text does not join a
 * control word or a `\begin`/`\end` before it, and it is not inside the braces of one. Anything unsure is not inert.
 */
function inertChange(doc: Text, fromA: number, toA: number, inserted: Text) {
  if (toA - fromA > REACH || inserted.length > REACH) return false;
  if (NOT_INERT.test(inserted.toString()) || NOT_INERT.test(doc.sliceString(fromA, toA))) return false;
  const before = doc.sliceString(Math.max(0, fromA - REACH), fromA);
  const truncated = fromA > before.length;
  // A run of letters or spaces that fills the reach hides what it follows.
  const word = /[A-Za-z@]*$/.exec(before)![0].length;
  if ((truncated && word === before.length) || before[before.length - word - 1] === "\\") return false;
  const space = /\s*$/.exec(before)![0].length;
  if ((truncated && space === before.length) || /\\(?:begin|end)\s*$/.test(before)) return false;
  const brace = before.lastIndexOf("}");
  if (brace < 0 && truncated) return false;
  return !/\\(?:begin|end)\s*\{/.test(before.slice(brace + 1));
}

/**
 * Carries the macro environment regions of a transaction's old document over to the new one when the definitions are the
 * same object (so no macro or extent moved) and the one change cannot alter any token of the text. A region's start follows
 * an insertion at it (what is typed there comes before its command), its end does not.
 */
function noteMacroRegions(tr: Transaction, defs: LatexDefinitions) {
  if (macroRegions.has(tr.state.doc)) return;
  const held = macroRegions.get(tr.startState.doc);
  if (held?.defs !== defs) return;
  let inert = true;
  let count = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (count++ || !inertChange(tr.startState.doc, fromA, toA, inserted)) inert = false;
  });
  if (!inert) return;
  macroRegions.set(tr.state.doc, { defs, regions: held.regions.map((region) => ({ ...region, from: tr.changes.mapPos(region.from, 1), to: tr.changes.mapPos(region.to, -1) })) });
}

/** The definitions that apply in the open file: other files' first, then its own preamble and body. */
export const definitionsField = StateField.define<LatexDefinitions>({
  create: (state) => computeDefinitions(state, state.field(macroSourcesField, false) ?? []),
  update(value, tr) {
    const next = updateDefinitions(value, tr);
    if (next === value && tr.docChanged) noteMacroRegions(tr, value);
    return next;
  },
});

function updateDefinitions(value: LatexDefinitions, tr: Transaction): LatexDefinitions {
  const sourcesChanged = tr.startState.field(macroSourcesField, false) !== tr.state.field(macroSourcesField, false);
  const touched = touchesDefinitions(tr, value);
  // Positions in the body follow the edit, as the decorations do: the fingerprint stays.
  // Edits after every position move none: the definitions stay the same object (what is cached by it stays valid).
  const rebuilt = tr.docChanged && hasPositions(value);
  const mapped = rebuilt && !changesAfterDefinitions(value, tr) ? mapLatexDefinitions(value, tr.changes) : value;
  if (!sourcesChanged && !touched) return mapped;
  const next = computeDefinitions(tr.state, tr.state.field(macroSourcesField, false) ?? []);
  const same = next.fingerprint === (rebuilt ? definitionsFingerprint(mapped) : value.fingerprint) && next.problems.length === value.problems.length;
  if (!same) return next;
  // The same definitions: keep the fingerprint the decorations were built with, with the extents just read.
  return rebuilt ? { ...next, fingerprint: mapped.fingerprint } : value;
}

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
