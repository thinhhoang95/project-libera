import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Facet, RangeSet, RangeValue, StateEffect, StateField, type ChangeDesc, type EditorState, type Range, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import { environmentName } from "../../macros/numbering";
import { bodyStartIn, noteBodyStart, preambleOpenField, visualDefinitions } from "./model";
import { walkConstructs, type Construct, type RevealPolicy } from "./walk";
import { preambleSummary } from "./widgets";

/* The structural layer (docs/latex-visual-editor-plan.md §4–5, §8): hidden
 * markup and widgets for the whole document, in a state field so block
 * widgets and multi-line replacements are allowed, and so the same set gives
 * the atomic ranges. Each edit maps the set and rebuilds only the region
 * whose constructs changed; long documents are built in pieces. */

/** A construct's extent, kept in a range set so it maps through edits. */
export class ConstructMark extends RangeValue {
  constructor(readonly id: number, readonly kind: string, readonly reveal: RevealPolicy, readonly leadOffset: number | null, readonly wholeLine: boolean) { super(); }
  eq(other: RangeValue): boolean { return other === this; }
}
ConstructMark.prototype.startSide = -1;
ConstructMark.prototype.endSide = 1;

export type PendingRange = { from: number; to: number };

export type StructuralState = {
  decorations: DecorationSet;
  extents: RangeSet<ConstructMark>;
  /** `decorations` without the revealed constructs: what the view draws and the cursor treats as atoms. */
  shown: DecorationSet;
  revealed: ReadonlyMap<number, { from: number; to: number }>;
  /** Construct shown as source on request (Alt+Enter), until the cursor leaves it. */
  forced: number | null;
  /** Regions not built yet, in document order. */
  pending: PendingRange[];
  defsFingerprint: string;
  preambleOpen: boolean;
  preambleEnd: number;
  treeLength: number;
};

export const LARGE_DOCUMENT = 60_000;
export const CHUNK = 8_000;
/** How far the first build of a long document reaches on each side of the cursor. */
export const FIRST_BUILD_RADIUS = 8_000;
const SYNC_BUDGET = 40_000;
const WINDOW = 2_000;

let nextConstructId = 1;

/** Ranges other extensions want shown as source (pending suggestions, AI review hunks). */
export const visualRevealRanges = Facet.define<(state: EditorState) => ReadonlyArray<{ from: number; to: number }>>();

export const buildPendingEffect = StateEffect.define<PendingRange>();
export const forceRevealEffect = StateEffect.define<number | null>();
/** Rebuilds everything (a setting changed that the walk depends on). */
export const rebuildVisualEffect = StateEffect.define<null>();

/** Constructs whose ranges may change when an edit lands inside them, so the whole construct is rebuilt. */
const WIDEN = new Set([
  "TextBoldCommand", "TextItalicCommand", "EmphasisCommand", "UnderlineCommand", "TextTeletypeCommand", "TextSmallCapsCommand",
  "TextSansSerifCommand", "TextMediumCommand", "StrikeOutCommand", "TextSuperscriptCommand", "TextSubscriptCommand", "TextColorCommand",
  "ColorBoxCommand", "HrefCommand", "UrlCommand", "FootnoteCommand", "EndnoteCommand", "DollarMath", "BracketMath", "ParenMath",
  "EquationEnvironment", "EquationArrayEnvironment", "Cite", "Ref", "Label", "FigureEnvironment", "TableEnvironment",
  "TabularEnvironment", "ListEnvironment", "Maketitle", "IncludeGraphics", "SectioningCommand", "UnknownCommand",
]);
const RENDERED_ENVIRONMENTS = /^(?:proof|abstract|quote|quotation|verse|center|flushleft|flushright)$/;

/** Where the folded preamble ends: the `\begin{document}` line, or the command itself when body text follows it on that line. */
export function preambleEndOf(state: EditorState) {
  const start = bodyStartIn(state.doc);
  if (start <= 0) return -1;
  const line = state.doc.lineAt(start);
  return state.doc.sliceString(start, line.to).trim() ? start : line.to;
}

const TITLE_PARTS = /\\(?:title|author|date)(?![A-Za-z@])/;

/** The `\maketitle` constructs after an edit to a line with `\title`, `\author` or `\date` (before or after the edit). */
function titlesAfterEdit(tr: Transaction, extents: RangeSet<ConstructMark>) {
  let from = -1;
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    if (from >= 0) return;
    const before = tr.startState.doc;
    const after = tr.state.doc;
    if (TITLE_PARTS.test(before.sliceString(before.lineAt(fromA).from, before.lineAt(toA).to)) || TITLE_PARTS.test(after.sliceString(after.lineAt(fromB).from, after.lineAt(toB).to))) from = fromB;
  });
  const titles: PendingRange[] = [];
  if (from < 0) return titles;
  extents.between(from, tr.state.doc.length, (start, end, mark) => { if (mark.kind === "title" && start >= from) titles.push({ from: start, to: end }); });
  return titles;
}

/** Whether an edit can change the structure beyond its own lines: a `$`, a brace, a backslash, a comment or a line break. */
function structuralEdit(tr: Transaction, fromA: number, toA: number, inserted: string) {
  const STRUCTURAL = /[$\\{}[\]%\n]/;
  if (STRUCTURAL.test(inserted) || STRUCTURAL.test(tr.startState.doc.sliceString(fromA, toA))) return true;
  // Letters in a command name (`\begin` becoming `\bgin`) change what the command is.
  const before = tr.startState.doc;
  const line = before.lineAt(fromA);
  // So do letters in an environment's name (`\begin{itemize}` becoming `\begin{itemie}`).
  const lineBefore = before.sliceString(Math.max(line.from, fromA - 64), fromA);
  return /\\[A-Za-z@]*$/.test(lineBefore) || /\\(?:begin|end)\s*\{[^}]*$/.test(lineBefore);
}

function lineBounds(state: EditorState, from: number, to: number) {
  return { from: state.doc.lineAt(Math.max(0, Math.min(from, state.doc.length))).from, to: state.doc.lineAt(Math.max(0, Math.min(to, state.doc.length))).to };
}

type Built = { decorations: Range<Decoration>[]; extents: Range<ConstructMark>[]; signatures: string[]; maxTo: number };

function toRanges(state: EditorState, construct: Construct, built: Built) {
  if (!construct.replaces.length && !construct.hiddenLines?.length) return;
  const id = nextConstructId++;
  for (const replace of construct.replaces) {
    if (replace.from === replace.to) {
      if (replace.widget) built.decorations.push(Decoration.widget({ widget: replace.widget, side: replace.side ?? 0, block: replace.block, cid: id }).range(replace.from));
    } else {
      built.decorations.push(Decoration.replace({ widget: replace.widget, block: replace.block, cid: id }).range(replace.from, replace.to));
    }
  }
  for (const line of construct.hiddenLines ?? []) {
    for (let pos = state.doc.lineAt(line.from).from; pos <= line.to;) {
      const current = state.doc.lineAt(pos);
      built.decorations.push(Decoration.line({ class: line.class, cid: id }).range(current.from));
      if (current.to >= state.doc.length) break;
      pos = current.to + 1;
    }
  }
  built.extents.push(new ConstructMark(id, construct.kind, construct.reveal, construct.lead !== undefined ? construct.lead - construct.from : null, !!construct.wholeLine).range(construct.from, construct.to));
  built.signatures.push(`${construct.from}:${construct.to}:${construct.kind}`);
  built.maxTo = Math.max(built.maxTo, construct.to);
}

function walk(state: EditorState, tree: Tree, from: number, to: number, preambleEnd: number, preambleOpen: boolean): Built {
  const built: Built = { decorations: [], extents: [], signatures: [], maxTo: from };
  const defs = visualDefinitions(state);
  walkConstructs({ state, tree, defs, preambleEnd, preambleOpen, preambleSummary: preambleSummary(null, defs), layer: "structural" }, from, to, (construct) => toRanges(state, construct, built));
  return built;
}

/** Old extents overlapping [from, to], and the range widened to cover them. */
function overlapping(extents: RangeSet<ConstructMark>, from: number, to: number) {
  const ids = new Set<number>();
  let low = from;
  let high = to;
  extents.between(from, to, (start, end, value) => {
    if ((end > from && start < to) || (start === end && start >= from && start <= to) || (start >= from && start < to)) {
      ids.add(value.id);
      low = Math.min(low, start);
      high = Math.max(high, end);
    }
  });
  return { ids, from: low, to: high };
}

/** Widens [from, to] to whole lines and to the constructs (old and new) around its edges. */
function widen(state: EditorState, tree: Tree, extents: RangeSet<ConstructMark>, from: number, to: number) {
  let range = lineBounds(state, from, to);
  for (let round = 0; round < 8; round++) {
    let { from: low, to: high } = overlapping(extents, range.from, range.to);
    for (const [pos, side] of [[range.from, 1], [range.to, -1]] as const) {
      for (let node: ReturnType<Tree["resolveInner"]> | null = tree.resolveInner(pos, side); node; node = node.parent) {
        let rendered = WIDEN.has(node.name);
        if (!rendered && node.name === "Environment") {
          const name = environmentName(node, (start, end) => state.doc.sliceString(start, end));
          const defs = visualDefinitions(state);
          rendered = !!name && (RENDERED_ENVIRONMENTS.test(name) || defs.theorems.has(name) || defs.environments.has(name));
        }
        if (rendered) { low = Math.min(low, node.from); high = Math.max(high, node.to); }
      }
    }
    const next = lineBounds(state, low, high);
    if (next.from === range.from && next.to === range.to) break;
    range = next;
  }
  return range;
}

function sameSignatures(built: Built, extents: RangeSet<ConstructMark>, from: number, to: number) {
  const old: string[] = [];
  extents.between(from, to, (start, end, value) => { if (start >= from && start < to) old.push(`${start}:${end}:${value.kind}`); });
  const fresh = built.signatures.filter((signature) => { const start = Number(signature.split(":")[0]); return start >= from && start < to; });
  if (old.length !== fresh.length) return false;
  old.sort();
  fresh.sort();
  return old.every((signature, index) => signature === fresh[index]);
}

/** Whether the syntax around `pos` is the same as around the same text before the edit (true without an edit to compare). */
function sameContext(state: EditorState, tree: Tree, pos: number, edit?: EditContext) {
  if (!edit) return true;
  const old = edit.changes.invertedDesc.mapPos(pos, 1);
  if (old > edit.oldTree.length) return false;
  return contextAt(state, tree, pos) === contextAt(edit.oldDoc, edit.oldTree, old);
}

function addPending(pending: PendingRange[], range: PendingRange) {
  if (range.to <= range.from) return pending;
  const merged: PendingRange[] = [];
  let current = { ...range };
  for (const existing of pending) {
    if (existing.to < current.from || existing.from > current.to) merged.push(existing);
    else current = { from: Math.min(existing.from, current.from), to: Math.max(existing.to, current.to) };
  }
  merged.push(current);
  return merged.sort((a, b) => a.from - b.from);
}

function removePending(pending: PendingRange[], from: number, to: number) {
  const out: PendingRange[] = [];
  for (const range of pending) {
    if (range.to <= from || range.from >= to) { out.push(range); continue; }
    if (range.from < from) out.push({ from: range.from, to: from });
    if (range.to > to) out.push({ from: to, to: range.to });
  }
  return out;
}

type Working = { decorations: DecorationSet; extents: RangeSet<ConstructMark>; pending: PendingRange[] };

/** The containers around a position (math, verbatim, environments with their names), from the inside out. */
function contextAt(state: { sliceDoc: (from: number, to: number) => string }, tree: Tree, pos: number) {
  const names: string[] = [];
  for (let node: ReturnType<Tree["resolveInner"]> | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (!CONTEXT_NODES.has(node.name) && !node.type.isError) continue;
    names.push(node.type.isError ? "⚠" : node.name === "Environment" ? `Environment:${environmentName(node, (start, end) => state.sliceDoc(start, end)) ?? ""}` : node.name);
  }
  return names.join("<");
}
/** Nodes whose presence around text decides how it is drawn: when they differ, old and new constructs may differ further on. */
const CONTEXT_NODES = new Set([
  "VerbatimEnvironment", "TikzPictureEnvironment", "Comment", "DollarMath", "BracketMath", "ParenMath", "EquationEnvironment",
  "EquationArrayEnvironment", "Environment", "ListEnvironment", "FigureEnvironment", "TableEnvironment", "TabularEnvironment",
  "DocumentEnvironment", "TextArgument", "LongArg", "Group", "NewCommand", "RenewCommand", "NewEnvironment", "RenewEnvironment", "Def",
]);

/** The tree before an edit and the edit itself, to tell where the old and new parses agree again. */
export type EditContext = { oldTree: Tree; oldDoc: { sliceDoc: (from: number, to: number) => string }; changes: ChangeDesc };

/**
 * For an edit inside a container too large to walk now (a long list, an
 * unclosed `\textbf{`): the edited lines and the old constructs on them.
 * Plain typing changes nothing else; after a structural edit the rest of the
 * container is left pending (built in pieces), and the walk forward starts
 * after the container. Null when the container is small enough.
 */
function capEdit(state: EditorState, working: Working, wide: PendingRange, from: number, to: number, structural: boolean) {
  if (wide.to - wide.from <= SYNC_BUDGET) return null;
  const lines = lineBounds(state, from, to);
  const old = overlapping(working.extents, lines.from, lines.to);
  const narrow = lineBounds(state, old.from, old.to);
  if (narrow.to - narrow.from >= wide.to - wide.from) return null;
  if (structural) {
    working.pending = addPending(working.pending, { from: wide.from, to: narrow.from });
    working.pending = addPending(working.pending, { from: narrow.to, to: wide.to });
  }
  return { range: narrow, followFrom: structural ? wide.to : narrow.to };
}

/** Rebuilds [from, to] (widened), then follows changes forward until the old and new constructs agree again. */
function rebuild(state: EditorState, tree: Tree, working: Working, from: number, to: number, preambleEnd: number, preambleOpen: boolean, stabilize: boolean, edit?: EditContext) {
  const available = Math.min(state.doc.length, tree.length);
  // An edit at the very end of a fully parsed document is still rebuilt (deleting the last `$`).
  if (from > available || (from === available && available < state.doc.length)) {
    const lines = lineBounds(state, Math.min(from, state.doc.length), Math.min(Math.max(to, from), state.doc.length));
    // What was drawn there may be wrong now: leave it as source until the piece is built.
    const { ids } = overlapping(working.extents, lines.from, lines.to);
    working.decorations = working.decorations.update({ filter: (_f, _t, value) => !ids.has(value.spec.cid), filterFrom: lines.from, filterTo: lines.to });
    working.extents = working.extents.update({ filter: (_f, _t, value) => !ids.has(value.id), filterFrom: lines.from, filterTo: lines.to });
    working.pending = addPending(working.pending, { from: Math.min(lines.from, from), to: Math.max(lines.to, to, from) });
    return;
  }
  let range = widen(state, tree, working.extents, from, Math.min(to, available));
  // The synchronous budget covers an edit's first walk too.
  const capped = edit ? capEdit(state, working, range, from, Math.min(to, available), stabilize) : null;
  if (capped) range = capped.range;
  let built = walk(state, tree, range.from, range.to, preambleEnd, preambleOpen);
  // New constructs may run past the range (a new `$` pairs with a later one): walk the whole widened range
  // again, so what the first walk covered (a macro's arguments) is known to the rest.
  for (let round = 0; built.maxTo > range.to && round < 16; round++) {
    const extra = widen(state, tree, working.extents, range.from, built.maxTo);
    range = { from: Math.min(range.from, extra.from), to: Math.max(range.to, extra.to) };
    built = walk(state, tree, range.from, range.to, preambleEnd, preambleOpen);
  }
  const apply = (start: number, end: number, fresh: Built) => {
    const { ids } = overlapping(working.extents, start, end);
    working.decorations = working.decorations.update({ filter: (_f, _t, value) => !ids.has(value.spec.cid), filterFrom: start, filterTo: end, add: fresh.decorations, sort: true });
    working.extents = working.extents.update({ filter: (_f, _t, value) => !ids.has(value.id), filterFrom: start, filterTo: end, add: fresh.extents, sort: true });
    // Only what the parser has reached is built: the rest of a long line stays pending.
    working.pending = removePending(working.pending, start, Math.min(end, available));
    if (end > available) working.pending = addPending(working.pending, { from: available, to: end });
  };
  apply(range.from, range.to, built);
  if (!stabilize) return;
  // Follow the edit forward while constructs differ, within a budget.
  let at = capped ? capped.followFrom : range.to;
  let spent = range.to - range.from;
  while (at < available) {
    if (working.pending.some((pending) => pending.from <= at && pending.to > at)) break;
    const window = lineBounds(state, at + 1, Math.min(available, at + WINDOW));
    if (window.to <= at) break;
    const next = walk(state, tree, window.from, window.to, preambleEnd, preambleOpen);
    // Agreement needs the same constructs and the same syntax around the window's end in the old and new
    // trees: two windows of plain text agree on constructs even when the new one has become verbatim.
    if (sameSignatures(next, working.extents, window.from, window.to) && sameContext(state, tree, window.to, edit)) break;
    if (spent > SYNC_BUDGET) {
      // Too far to follow now: drop what may be stale and build it in pieces.
      const { ids } = overlapping(working.extents, at, state.doc.length);
      working.decorations = working.decorations.update({ filter: (_f, _t, value) => !ids.has(value.spec.cid), filterFrom: at, filterTo: state.doc.length });
      working.extents = working.extents.update({ filter: (_f, _t, value) => !ids.has(value.id), filterFrom: at, filterTo: state.doc.length });
      working.pending = addPending(working.pending, { from: at, to: state.doc.length });
      break;
    }
    const widened = widen(state, tree, working.extents, window.from, Math.max(window.to, next.maxTo));
    const fresh = walk(state, tree, widened.from, widened.to, preambleEnd, preambleOpen);
    apply(widened.from, widened.to, fresh);
    spent += widened.to - widened.from;
    at = Math.max(widened.to, fresh.maxTo);
  }
}

function emptyWorking(): Working {
  return { decorations: Decoration.none, extents: RangeSet.empty, pending: [] };
}

/** Builds a document from scratch: everything when it is short, else the part around the cursor, the rest pending. */
function initialBuild(state: EditorState, preambleEnd: number, preambleOpen: boolean): Working {
  const working = emptyWorking();
  const length = state.doc.length;
  if (length <= LARGE_DOCUMENT) {
    const tree = ensureSyntaxTree(state, length, 400) ?? syntaxTree(state);
    working.pending = [{ from: 0, to: length }];
    rebuild(state, tree, working, 0, length, preambleEnd, preambleOpen, false);
    return working;
  }
  const head = state.selection.main.head;
  const from = Math.max(0, head - FIRST_BUILD_RADIUS);
  const to = Math.min(length, head + FIRST_BUILD_RADIUS);
  const tree = ensureSyntaxTree(state, to, 200) ?? syntaxTree(state);
  working.pending = [{ from: 0, to: length }];
  // The preamble block sits at the top: build it with the first piece.
  if (preambleEnd > 0 && from > 0) rebuild(state, tree, working, 0, Math.min(preambleEnd + 1, length), preambleEnd, preambleOpen, false);
  rebuild(state, tree, working, from, to, preambleEnd, preambleOpen, false);
  return working;
}

function revealPolicyMatches(state: EditorState, mark: ConstructMark, from: number, to: number, selection: { from: number; to: number; head: number }) {
  switch (mark.reveal) {
    case "touch": return selection.from <= to && selection.to >= from;
    case "strict": return selection.from > from && selection.to < to;
    case "line": {
      if (mark.wholeLine) {
        const first = state.doc.lineAt(from).from;
        const last = state.doc.lineAt(to).to;
        return selection.head >= first && selection.head <= last;
      }
      return mark.leadOffset !== null && selection.head >= from && selection.head <= from + mark.leadOffset;
    }
    default: return false;
  }
}

/** The constructs to show as source: the innermost one around each selection range, plus suggestions and forced ones. */
function computeRevealed(state: EditorState, value: { decorations: DecorationSet; extents: RangeSet<ConstructMark>; forced: number | null }) {
  const revealed = new Map<number, { from: number; to: number }>();
  for (const range of state.selection.ranges) {
    let best: { id: number; from: number; to: number } | null = null;
    value.extents.between(Math.max(0, range.from - 1), Math.min(state.doc.length, range.to + 1), (from, to, mark) => {
      if (value.forced === mark.id && range.head >= from && range.head <= to) { revealed.set(mark.id, { from, to }); return; }
      if (!revealPolicyMatches(state, mark, from, to, range)) return;
      if (!best || to - from < best.to - best.from) best = { id: mark.id, from, to };
    });
    const found = best as { id: number; from: number; to: number } | null;
    if (found) revealed.set(found.id, { from: found.from, to: found.to });
  }
  for (const source of state.facet(visualRevealRanges)) {
    for (const range of source(state)) {
      value.decorations.between(range.from, Math.max(range.from, range.to), (from, to, decoration) => {
        const overlaps = to > range.from && from < range.to || (from === to && from >= range.from && from <= range.to) || (range.from === range.to && from < range.from && to > range.from);
        if (!overlaps || revealed.has(decoration.spec.cid)) return;
        value.extents.between(from, to, (start, end, mark) => { if (mark.id === decoration.spec.cid) revealed.set(mark.id, { from: start, to: end }); });
      });
    }
  }
  return revealed;
}

function sameRevealed(a: ReadonlyMap<number, unknown>, b: ReadonlyMap<number, unknown>) {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}

function withShown(state: EditorState, base: Omit<StructuralState, "shown" | "revealed">, previous: StructuralState | null): StructuralState {
  const revealed = computeRevealed(state, base);
  if (previous && previous.decorations === base.decorations && sameRevealed(previous.revealed, revealed)) {
    return { ...base, shown: previous.shown, revealed: previous.revealed };
  }
  let shown = base.decorations;
  for (const [id, range] of revealed) {
    shown = shown.update({ filter: (_f, _t, value) => value.spec.cid !== id, filterFrom: range.from, filterTo: range.to });
  }
  return { ...base, shown, revealed };
}

function treeOf(state: EditorState) {
  return syntaxTree(state);
}

export const structuralField = StateField.define<StructuralState>({
  create(state) {
    const preambleEnd = preambleEndOf(state);
    const preambleOpen = state.field(preambleOpenField, false) ?? false;
    const working = initialBuild(state, preambleEnd, preambleOpen);
    return withShown(state, {
      ...working, forced: null, defsFingerprint: visualDefinitions(state).fingerprint, preambleOpen, preambleEnd, treeLength: treeOf(state).length,
    }, null);
  },
  update(value, tr) {
    const state = tr.state;
    const tree = treeOf(state);
    const preambleOpen = state.field(preambleOpenField, false) ?? false;
    const defsFingerprint = visualDefinitions(state).fingerprint;
    if (tr.docChanged) noteBodyStart(tr);
    const preambleEnd = tr.docChanged ? preambleEndOf(state) : value.preambleEnd;
    let forced = value.forced;
    let working: Working = { decorations: value.decorations, extents: value.extents, pending: value.pending };
    const full = defsFingerprint !== value.defsFingerprint || preambleOpen !== value.preambleOpen || preambleEnd !== value.preambleEnd
      || tr.effects.some((effect) => effect.is(rebuildVisualEffect));

    if (full) {
      working = initialBuild(state, preambleEnd, preambleOpen);
      forced = null;
    } else {
      if (tr.docChanged) {
        working.decorations = working.decorations.map(tr.changes);
        working.extents = working.extents.map(tr.changes);
        working.pending = working.pending.map((range) => ({ from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) })).filter((range) => range.to > range.from);
        const edit: EditContext = { oldTree: syntaxTree(tr.startState), oldDoc: tr.startState, changes: tr.changes };
        const ranges: Array<[number, number, boolean]> = [];
        tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => ranges.push([fromB, toB, structuralEdit(tr, fromA, toA, inserted.toString())]));
        // Plain typing only changes its own lines; structural characters are followed forward.
        for (const [from, to, structural] of ranges) rebuild(state, tree, working, from, to, preambleEnd, preambleOpen, structural, edit);
        // \maketitle shows \title, \author and \date written elsewhere: an edit to them redraws it.
        for (const title of titlesAfterEdit(tr, working.extents)) rebuild(state, tree, working, title.from, title.to, preambleEnd, preambleOpen, false);
      }
      // The parser caught up: build what it now covers, and check forward from where the old tree
      // stopped, since constructs built before it caught up may have changed shape past that point.
      if (tree.length > value.treeLength && !tr.docChanged) {
        for (const pending of working.pending.filter((range) => range.from < tree.length && range.to > value.treeLength)) {
          const from = Math.max(pending.from, value.treeLength - 1);
          const to = Math.min(pending.to, tree.length, from + CHUNK);
          if (to > from) rebuild(state, tree, working, from, to, preambleEnd, preambleOpen, false);
        }
        const frontier = Math.max(0, Math.min(value.treeLength, state.doc.length));
        if (frontier < state.doc.length && !working.pending.some((range) => range.from <= frontier && range.to > frontier)) {
          rebuild(state, tree, working, frontier, Math.min(state.doc.length, frontier + 1), preambleEnd, preambleOpen, true, { oldTree: syntaxTree(tr.startState), oldDoc: tr.startState, changes: tr.changes });
        }
      }
      for (const effect of tr.effects) {
        if (effect.is(buildPendingEffect)) {
          const { from, to } = effect.value;
          if (working.pending.some((range) => range.from < to && range.to > from)) rebuild(state, tree, working, from, to, preambleEnd, preambleOpen, false);
        }
      }
    }
    for (const effect of tr.effects) if (effect.is(forceRevealEffect)) forced = effect.value;
    if (forced !== null) {
      // Leaving the construct ends the forced reveal.
      let inside = false;
      working.extents.between(state.selection.main.head, state.selection.main.head, (_f, _t, mark) => { if (mark.id === forced) inside = true; });
      if (!inside) forced = null;
    }
    const base = { ...working, forced, defsFingerprint, preambleOpen, preambleEnd, treeLength: tree.length };
    return withShown(state, base, value);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.shown),
    EditorView.atomicRanges.of((view) => view.state.field(field, false)?.shown ?? RangeSet.empty),
  ],
});

/** The innermost construct around `pos`, for Alt+Enter and widget editors. */
export function constructAt(state: EditorState, pos: number) {
  const value = state.field(structuralField, false);
  if (!value) return null;
  let best: { id: number; from: number; to: number; kind: string } | null = null;
  value.extents.between(pos, pos, (from, to, mark) => {
    if (mark.reveal === "toggle") return;
    if (!best || to - from < best.to - best.from) best = { id: mark.id, from, to, kind: mark.kind };
  });
  return best as { id: number; from: number; to: number; kind: string } | null;
}

/** Whether a transaction only moved the cursor or scrolled: no rebuild needed. */
export function isSelectionOnly(tr: Transaction) {
  return !tr.docChanged && !tr.effects.length;
}
