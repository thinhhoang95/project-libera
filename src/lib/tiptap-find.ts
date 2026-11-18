import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { scanRegions, type FindLimits, type Finder, type FindMatch, type MathSpan, type TextRange } from "./find";
import { preferredMathMarkerPair, type MathMarkerSettings } from "./math-markers";

/* Find in the rich (TipTap) editor with the shared engine (src/lib/find,
 * docs/find-replace-patterns-plan.md §10). Every text block is searched as
 * its text plus a reading of each inline atom: math reads as it is written
 * (its own delimiters, else the configured primary markers) (`$4x+3$`, `\(4x+3\)`), a citation as
 * its `leafText`. A display math node is searched on its own, between the
 * display markers. The reading lives here, not in the schema, so it never
 * changes `textBetween`, copy or paste. */

/** The marker pairs math atoms are read with. */
export type TiptapFindReading = {
  inline: { open: string; close: string };
  block: { open: string; close: string };
};

/** Math atoms read with the first configured pair of each kind, as new Markdown is written. */
export function tiptapFindReading(settings: MathMarkerSettings = {}): TiptapFindReading {
  const inline = preferredMathMarkerPair(settings, false);
  const block = preferredMathMarkerPair(settings, true);
  return {
    inline: inline ? { open: inline.open, close: inline.close } : { open: "$", close: "$" },
    block: block ? { open: block.open, close: block.close } : { open: "$$", close: "$$" },
  };
}

export const DEFAULT_TIPTAP_FIND_READING = tiptapFindReading();

/** A capture in document positions; -1 for a regex group that did not take part. A capture inside a math atom covers the atom. */
export type TiptapFindCapture = { index: number; name?: string; from: number; to: number };

export type TiptapFindMatch = {
  /** The matched range; the whole atom for a match inside a math atom's LaTeX. */
  from: number;
  to: number;
  captures: TiptapFindCapture[];
  /** Position of the searched unit: a text block, or a display math node. */
  unit: number;
  /** Which run of the unit's reading (atoms without a reading, like images, cut a block into runs). */
  run: number;
  /** The match in that run's reading, as the engine returned it. */
  reading: FindMatch;
  /** The match lies inside one math atom's LaTeX (not its delimiters). */
  insideMath: boolean;
};

export type TiptapFindRange = { from: number; to: number };

export type TiptapFindState = {
  activeMatchIndex: number;
  decorations: DecorationSet;
  matches: TiptapFindMatch[];
  finder: Finder | null;
  /** In selection: matches must lie inside these ranges (mapped through edits). */
  within: TiptapFindRange[] | null;
  reading: TiptapFindReading;
  /** A block's search stopped early (step budget). */
  incomplete: boolean;
};

type TiptapFindUpdate = {
  activeMatchIndex?: number;
  finder?: Finder | null;
  within?: TiptapFindRange[] | null;
};

export const tiptapFindPluginKey = new PluginKey<TiptapFindState>("liberaTiptapFind");

/* --- Readings --- */

export type TiptapReadingPiece = {
  /** Offsets in the run's text. */
  start: number;
  end: number;
  /** Position relative to the unit's position, and size in the document. */
  pos: number;
  size: number;
  kind: "text" | "atom" | "math";
  /** For math: where the LaTeX starts and ends in the run's text. */
  contentStart: number;
  contentEnd: number;
};

export type TiptapReadingRun = {
  text: string;
  pieces: TiptapReadingPiece[];
  /** Code: `code`-marked text, or the whole run in a code block (Skip comments & code). */
  skipped: TextRange[];
};

export type TiptapUnitReading = { runs: TiptapReadingRun[] };

const isBlockMath = (node: ProseMirrorNode) => node.type.name === "blockMath";
const isSearchUnit = (node: ProseMirrorNode) => node.isTextblock || isBlockMath(node);

const readingCaches = new Map<string, WeakMap<ProseMirrorNode, TiptapUnitReading>>();
const readingKey = (reading: TiptapFindReading) => JSON.stringify(reading);

/** Math reads with the delimiters it was written with (as the Markdown serializer writes it back), else the configured ones. */
function writtenMarkers(node: ProseMirrorNode, configured: { open: string; close: string }) {
  const open = typeof node.attrs.mathOpen === "string" ? node.attrs.mathOpen : null;
  const close = typeof node.attrs.mathClose === "string" ? node.attrs.mathClose : null;
  return open ? { open, close: close ?? open } : configured;
}

function readUnitUncached(node: ProseMirrorNode, reading: TiptapFindReading): TiptapUnitReading {
  if (isBlockMath(node)) {
    const latex = String(node.attrs.latex ?? "");
    const { open, close } = writtenMarkers(node, reading.block);
    const text = `${open}${latex}${close}`;
    return { runs: [{ text, skipped: [], pieces: [{ start: 0, end: text.length, pos: 0, size: node.nodeSize, kind: "math", contentStart: open.length, contentEnd: open.length + latex.length }] }] };
  }
  const runs: TiptapReadingRun[] = [];
  const codeBlock = !!node.type.spec.code;
  let text = "";
  let pieces: TiptapReadingPiece[] = [];
  let skipped: TextRange[] = [];
  const flush = () => {
    if (text) runs.push({ text, pieces, skipped: codeBlock ? [{ start: 0, end: text.length }] : skipped });
    text = "";
    pieces = [];
    skipped = [];
  };
  const push = (value: string, pos: number, size: number, kind: TiptapReadingPiece["kind"], contentStart = 0, contentEnd = 0) => {
    pieces.push({ start: text.length, end: text.length + value.length, pos, size, kind, contentStart, contentEnd });
    text += value;
  };
  node.forEach((child, offset) => {
    const pos = 1 + offset;
    if (child.isText) {
      const value = child.text ?? "";
      if (!value) return;
      if (child.marks.some((mark) => mark.type.spec.code)) {
        const last = skipped.at(-1);
        if (last && last.end === text.length) last.end += value.length;
        else skipped.push({ start: text.length, end: text.length + value.length });
      }
      push(value, pos, child.nodeSize, "text");
      return;
    }
    if (child.type.name === "inlineMath") {
      const latex = String(child.attrs.latex ?? "");
      const { open, close } = writtenMarkers(child, reading.inline);
      const start = text.length;
      push(`${open}${latex}${close}`, pos, child.nodeSize, "math", start + open.length, start + open.length + latex.length);
      return;
    }
    if (child.type.name === "hardBreak") { push("\n", pos, child.nodeSize, "atom"); return; }
    const leafText = child.isLeaf ? child.type.spec.leafText?.(child) : undefined;
    if (leafText) push(leafText, pos, child.nodeSize, "atom");
    else flush();
  });
  flush();
  return { runs };
}

/** The reading of a text block or display math node. Cached per (immutable) node. */
export function readTiptapFindUnit(node: ProseMirrorNode, reading: TiptapFindReading = DEFAULT_TIPTAP_FIND_READING): TiptapUnitReading {
  const key = readingKey(reading);
  let cache = readingCaches.get(key);
  if (!cache) {
    cache = new WeakMap();
    readingCaches.set(key, cache);
    if (readingCaches.size > 4) readingCaches.delete(readingCaches.keys().next().value!);
  }
  let unit = cache.get(node);
  if (!unit) { unit = readUnitUncached(node, reading); cache.set(node, unit); }
  return unit;
}

/** The reading run a match was found in. */
export function tiptapFindMatchRun(doc: ProseMirrorNode, match: TiptapFindMatch, reading: TiptapFindReading = DEFAULT_TIPTAP_FIND_READING): TiptapReadingRun | null {
  const node = doc.nodeAt(match.unit);
  if (!node || !isSearchUnit(node)) return null;
  return readTiptapFindUnit(node, reading).runs[match.run] ?? null;
}

/** The last piece starting at or before `offset`. */
function pieceIndexAt(run: TiptapReadingRun, offset: number) {
  let low = 0, high = run.pieces.length;
  while (low < high) { const mid = (low + high) >> 1; if (run.pieces[mid].start <= offset) low = mid + 1; else high = mid; }
  return low - 1;
}

/** A reading offset as a position relative to the unit. Inside an atom, a start maps before it and an end after it. */
export function readingPosition(run: TiptapReadingRun, offset: number, end: boolean) {
  if (end && offset <= 0) return run.pieces[0].pos;
  const piece = run.pieces[Math.max(0, pieceIndexAt(run, end ? offset - 1 : offset))];
  if (piece.kind === "text") return piece.pos + Math.min(Math.max(offset - piece.start, 0), piece.end - piece.start);
  if (end) return offset <= piece.start ? piece.pos : piece.pos + piece.size;
  return offset >= piece.end ? piece.pos + piece.size : piece.pos;
}

function mathPieceInside(run: TiptapReadingRun, start: number, end: number) {
  const index = pieceIndexAt(run, start);
  const piece = run.pieces[index];
  return piece && piece.kind === "math" && start >= piece.contentStart && end <= piece.contentEnd && end <= piece.end ? piece : null;
}

/** A match lies inside one atom's LaTeX, or covers every atom it touches; none cuts through delimiters. */
function validMatch(run: TiptapReadingRun, start: number, end: number) {
  const first = run.pieces[pieceIndexAt(run, start)];
  const last = run.pieces[pieceIndexAt(run, end - 1)];
  if (!first || !last) return true;
  if (first === last && first.kind === "math") {
    return (start >= first.contentStart && end <= first.contentEnd) || (start === first.start && end === first.end);
  }
  if (first.kind === "math" && start !== first.start) return false;
  if (last.kind === "math" && end !== last.end) return false;
  return true;
}

/** Math regions of a run: its math atoms, and literal math in its text that does not touch an atom. */
function runRegions(run: TiptapReadingRun) {
  const atoms: MathSpan[] = run.pieces.filter((piece) => piece.kind === "math")
    .map((piece) => ({ start: piece.start, end: piece.end, contentStart: piece.contentStart, contentEnd: piece.contentEnd }));
  const literal = scanRegions(run.text, "markdown").math
    .filter((span) => !atoms.some((atom) => atom.start < span.end && atom.end > span.start));
  return { math: [...atoms, ...literal].sort((a, b) => a.start - b.start), skipped: [] };
}

/** Document ranges as offsets of a run's reading (the parts of the run each range covers). */
function withinRun(run: TiptapReadingRun, unitPos: number, ranges: TiptapFindRange[]): TextRange[] {
  const result: TextRange[] = [];
  for (const range of ranges) {
    let start = run.text.length, end = 0;
    for (const piece of run.pieces) {
      const from = unitPos + piece.pos, to = from + piece.size;
      if (to <= range.from || from >= range.to) continue;
      const pieceStart = piece.kind === "text" ? piece.start + Math.max(0, range.from - from) : range.from <= from ? piece.start : piece.end;
      const pieceEnd = piece.kind === "text" ? piece.start + Math.min(piece.size, range.to - from) : range.to >= to ? piece.end : piece.start;
      start = Math.min(start, pieceStart);
      end = Math.max(end, pieceEnd);
    }
    if (end > start) result.push({ start, end });
  }
  return result;
}

/* --- Search --- */

type RelativeMatch = Omit<TiptapFindMatch, "unit">;
type UnitResult = { matches: RelativeMatch[]; incomplete: boolean };

function searchUnitUncached(node: ProseMirrorNode, finder: Finder, reading: TiptapFindReading, within?: { unitPos: number; ranges: TiptapFindRange[] }): UnitResult {
  const unit = readTiptapFindUnit(node, reading);
  const matches: RelativeMatch[] = [];
  let incomplete = false;
  const scoped = finder.options.scope !== "anywhere";
  unit.runs.forEach((run, runIndex) => {
    const limits: FindLimits = {
      accept: (start, end) => validMatch(run, start, end),
      ...(run.skipped.length ? { skipped: run.skipped } : {}),
      ...(scoped ? { regions: runRegions(run) } : {}),
    };
    if (within) {
      limits.within = withinRun(run, within.unitPos, within.ranges);
      if (!limits.within.length) return;
    }
    const result = finder.find(run.text, limits);
    incomplete ||= result.incomplete;
    for (const match of result.matches) {
      const atom = mathPieceInside(run, match.start, match.end);
      const insideMath = !!atom && !(match.start === atom.start && match.end === atom.end);
      const from = insideMath ? atom!.pos : readingPosition(run, match.start, false);
      const to = insideMath ? atom!.pos + atom!.size : readingPosition(run, match.end, true);
      const captures = match.captures.map((capture): TiptapFindCapture => {
        const named = capture.name ? { name: capture.name } : {};
        if (capture.start < 0) return { index: capture.index, ...named, from: -1, to: -1 };
        const captureFrom = readingPosition(run, capture.start, capture.start >= run.text.length);
        return { index: capture.index, ...named, from: captureFrom, to: capture.end > capture.start ? readingPosition(run, capture.end, true) : captureFrom };
      });
      matches.push({ from, to, captures, run: runIndex, reading: match, insideMath });
    }
  });
  return { matches, incomplete };
}

// A few active queries may share immutable ProseMirror blocks. Cache relative
// matches so moving/editing another block never searches unchanged text again.
const unitSearches = new Map<string, WeakMap<ProseMirrorNode, UnitResult>>();

function unitSearchCache(finder: Finder, reading: TiptapFindReading) {
  const cacheKey = `${finder.key}\u0000${readingKey(reading)}`;
  let cache = unitSearches.get(cacheKey);
  if (!cache) {
    cache = new WeakMap();
    unitSearches.set(cacheKey, cache);
    if (unitSearches.size > 4) unitSearches.delete(unitSearches.keys().next().value!);
  }
  return cache;
}

/** Work counters for tests: units visited and decorations created by the incremental path. */
export const tiptapFindWork = { incremental: 0, fallback: 0, blocksVisited: 0, decorationsCreated: 0 };

function absolute(match: RelativeMatch, unit: number): TiptapFindMatch {
  return {
    from: unit + match.from,
    to: unit + match.to,
    captures: match.captures.map((capture) => capture.from < 0 ? capture : { ...capture, from: unit + capture.from, to: unit + capture.to }),
    unit,
    run: match.run,
    reading: match.reading,
    insideMath: match.insideMath,
  };
}

type SearchContext = { finder: Finder; reading: TiptapFindReading; within: TiptapFindRange[] | null; cache: WeakMap<ProseMirrorNode, UnitResult> };

// Appends the matches of one unit, in document positions. Returns whether its search stopped early.
function searchUnit(node: ProseMirrorNode, position: number, context: SearchContext, matches: TiptapFindMatch[]) {
  tiptapFindWork.blocksVisited++;
  let ranges: TiptapFindRange[] | null = null;
  if (context.within) {
    const contentFrom = isBlockMath(node) ? position : position + 1;
    const contentTo = isBlockMath(node) ? position + node.nodeSize : position + node.nodeSize - 1;
    const touching = context.within.filter((range) => range.to > contentFrom && range.from < contentTo);
    if (!touching.length) return false;
    // Units wholly inside the selection share the cache; others are searched with their part of it.
    if (!touching.some((range) => range.from <= contentFrom && range.to >= contentTo)) ranges = touching;
  }
  let result: UnitResult | undefined;
  if (ranges) result = searchUnitUncached(node, context.finder, context.reading, { unitPos: position, ranges });
  else {
    result = context.cache.get(node);
    if (!result) { result = searchUnitUncached(node, context.finder, context.reading); context.cache.set(node, result); }
  }
  for (const match of result.matches) matches.push(absolute(match, position));
  return result.incomplete;
}

function searchContext(finder: Finder, reading: TiptapFindReading, within: TiptapFindRange[] | null): SearchContext {
  return { finder, reading, within, cache: unitSearchCache(finder, reading) };
}

function searchBetween(doc: ProseMirrorNode, from: number, to: number, context: SearchContext) {
  const matches: TiptapFindMatch[] = [];
  let incomplete = false;
  const visit = (node: ProseMirrorNode, position: number) => {
    if (!isSearchUnit(node)) return;
    if (searchUnit(node, position, context, matches)) incomplete = true;
    // This unit has been searched; do not visit its inline children again.
    return false;
  };
  if (from <= 0 && to >= doc.content.size) doc.descendants(visit);
  else doc.nodesBetween(from, to, visit);
  return { matches, incomplete };
}

export type TiptapFindOptions = { reading?: TiptapFindReading; within?: TiptapFindRange[] | null };

/** Every match of the finder in the document, in document order. */
export function findTiptapTextMatches(doc: ProseMirrorNode, finder: Finder | null, options: TiptapFindOptions = {}) {
  if (!finder) return [];
  return searchBetween(doc, 0, doc.content.size, searchContext(finder, options.reading ?? DEFAULT_TIPTAP_FIND_READING, options.within ?? null)).matches;
}

/* --- Plugin state --- */

const MATCH_CLASS = "markdown-editor-find-match";
const ACTIVE_MATCH_CLASS = "markdown-editor-find-match markdown-editor-find-match-active";

// A match inside an atom, or on a display math node, decorates the node.
const decoratesNode = (match: TiptapFindMatch) => match.insideMath || match.from === match.unit;
const decorationKey = (match: TiptapFindMatch) => `${match.run}:${match.reading.start}`;

function matchDecoration(match: TiptapFindMatch, active: boolean) {
  const attrs = { class: active ? ACTIVE_MATCH_CLASS : MATCH_CLASS };
  const spec = { findKey: decorationKey(match) };
  return decoratesNode(match) ? Decoration.node(match.from, match.to, attrs, spec) : Decoration.inline(match.from, match.to, attrs, spec);
}

function decorationsOf(set: DecorationSet, match: TiptapFindMatch) {
  const key = decorationKey(match);
  return set.find(match.from, match.to, (spec: { findKey?: string }) => spec.findKey === key)
    .filter((decoration) => decoration.from === match.from && decoration.to === match.to);
}

/** The full rebuild; the incremental path below must always agree with it. */
export function createFindState(doc: ProseMirrorNode, finder: Finder | null, requestedIndex = 0, options: TiptapFindOptions = {}): TiptapFindState {
  const reading = options.reading ?? DEFAULT_TIPTAP_FIND_READING;
  const within = options.within ?? null;
  const { matches, incomplete } = finder
    ? searchBetween(doc, 0, doc.content.size, searchContext(finder, reading, within))
    : { matches: [] as TiptapFindMatch[], incomplete: false };
  const activeMatchIndex = matches.length
    ? (requestedIndex % matches.length + matches.length) % matches.length
    : 0;
  const decorations = DecorationSet.create(doc, matches.map((match, index) => matchDecoration(match, index === activeMatchIndex)));
  return { activeMatchIndex, decorations, matches, finder, within, reading, incomplete };
}

// Smallest range of the new document that contains every change of the
// transaction. Outside it the content is unchanged, so text shifts by a
// constant. Null when a step changes content without a position range
// (marks, node attributes), which can alter what an atom reads as.
function changedRange(tr: Transaction) {
  const maps = tr.mapping.maps;
  let from = Infinity, to = -Infinity;
  for (let index = 0; index < maps.length; index++) {
    const rest = tr.mapping.slice(index + 1);
    let empty = true;
    maps[index].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      empty = false;
      from = Math.min(from, rest.map(newStart, -1));
      to = Math.max(to, rest.map(newEnd, 1));
    });
    if (empty) return null;
  }
  return maps.length ? { from, to } : null;
}

function shifted(match: TiptapFindMatch, delta: number): TiptapFindMatch {
  return {
    ...match,
    from: match.from + delta,
    to: match.to + delta,
    unit: match.unit + delta,
    captures: match.captures.map((capture) => capture.from < 0 ? capture : { ...capture, from: capture.from + delta, to: capture.to + delta }),
  };
}

function mapWithin(within: TiptapFindRange[] | null, tr: Transaction) {
  if (!within) return null;
  return within.map((range) => {
    const from = tr.mapping.map(range.from, 1);
    return { from, to: Math.max(from, tr.mapping.map(range.to, -1)) };
  });
}

/**
 * The state after a document change, reusing the matches and decorations of
 * the units the change did not touch. Returns null when it cannot prove
 * itself equal to `createFindState`, which the caller then runs instead.
 */
function updateFindState(previous: TiptapFindState, tr: Transaction, requestedIndex: number, within: TiptapFindRange[] | null): TiptapFindState | null {
  // Which unit stopped early is not kept, so an incomplete search is redone in full.
  if (!previous.finder || previous.incomplete) return null;
  const range = changedRange(tr);
  if (!range) return null;
  const doc = tr.doc;
  const delta = doc.content.size - tr.before.content.size;
  // Widen to whole text blocks, whose matches are searched as one unit.
  const textblockDepth = ($pos: ReturnType<ProseMirrorNode["resolve"]>) => {
    for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).isTextblock) return depth;
    return 0;
  };
  const $from = doc.resolve(Math.min(range.from, doc.content.size)), $to = doc.resolve(Math.min(range.to, doc.content.size));
  const fromDepth = textblockDepth($from), toDepth = textblockDepth($to);
  const from = fromDepth ? $from.before(fromDepth) : range.from;
  const to = toDepth ? $to.after(toDepth) : range.to;
  const oldTo = to - delta;
  if (from > range.to || oldTo < from || to > doc.content.size) return null;

  const { matches: oldMatches } = previous;
  // Matches are in document order, and a unit never straddles `from` or `oldTo`.
  const firstFrom = (start: number, bound: number) => {
    let low = start, high = oldMatches.length;
    while (low < high) { const mid = (low + high) >> 1; if (oldMatches[mid].from < bound) low = mid + 1; else high = mid; }
    return low;
  };
  const first = firstFrom(0, from), last = firstFrom(first, oldTo);

  const stale = previous.decorations.find(from, oldTo).filter((decoration) => decoration.from >= from && decoration.from < oldTo);
  if (stale.length !== last - first) return null;

  const middle = searchBetween(doc, from, to, searchContext(previous.finder, previous.reading, within));
  const matches = [...oldMatches.slice(0, first), ...middle.matches, ...oldMatches.slice(last).map((match) => shifted(match, delta))];
  const activeMatchIndex = matches.length ? (requestedIndex % matches.length + matches.length) % matches.length : 0;

  let decorations = previous.decorations.remove(stale).map(tr.mapping, doc);
  // Where each surviving match sits in the new array.
  const middleCount = middle.matches.length;
  const newIndex = (oldIndex: number) => oldIndex < first ? oldIndex : oldIndex >= last ? oldIndex - last + first + middleCount : -1;
  const wasActive = previous.matches.length ? newIndex(previous.activeMatchIndex) : -1;
  const restyle = (index: number, active: boolean) => {
    const match = matches[index];
    const found = decorationsOf(decorations, match);
    if (found.length !== 1) return false;
    tiptapFindWork.decorationsCreated++;
    decorations = decorations.remove(found).add(doc, [matchDecoration(match, active)]);
    return true;
  };
  if (wasActive >= 0 && wasActive !== activeMatchIndex && !restyle(wasActive, false)) return null;
  const activeSurvived = matches.length > 0 && (activeMatchIndex < first || activeMatchIndex >= first + middleCount);
  if (activeSurvived && wasActive !== activeMatchIndex && !restyle(activeMatchIndex, true)) return null;
  if (middleCount) {
    tiptapFindWork.decorationsCreated += middleCount;
    decorations = decorations.add(doc, middle.matches.map((match, offset) => matchDecoration(match, first + offset === activeMatchIndex)));
  }
  return { activeMatchIndex, decorations, matches, finder: previous.finder, within, reading: previous.reading, incomplete: middle.incomplete };
}

const sameRanges = (a: TiptapFindRange[] | null, b: TiptapFindRange[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((range, index) => range.from === b[index].from && range.to === b[index].to));

export type TiptapFindExtensionOptions = { mathMarkers?: MathMarkerSettings };

export const TiptapFind = Extension.create<TiptapFindExtensionOptions>({
  name: "tiptapFind",
  addOptions() {
    return { mathMarkers: undefined };
  },
  addProseMirrorPlugins() {
    const reading = tiptapFindReading(this.options.mathMarkers);
    return [new Plugin<TiptapFindState>({
      key: tiptapFindPluginKey,
      state: {
        init: (_, state) => createFindState(state.doc, null, 0, { reading }),
        apply: (transaction, previous) => {
          const update = transaction.getMeta(tiptapFindPluginKey) as TiptapFindUpdate | undefined;
          if (!transaction.docChanged && !update) return previous;
          // An inactive find has no positions to map. Keep the shared empty
          // snapshot instead of allocating a new state on every keystroke.
          if (!previous.finder && !update) return previous;
          const finder = update && "finder" in update ? update.finder ?? null : previous.finder;
          const sameFinder = (finder?.key ?? null) === (previous.finder?.key ?? null);
          const mappedWithin = transaction.docChanged ? mapWithin(previous.within, transaction) : previous.within;
          const within = update && "within" in update ? update.within ?? null : mappedWithin;
          const sameWithin = sameRanges(within, mappedWithin);
          // Moving between existing matches never needs another document search.
          if (!transaction.docChanged && sameFinder && sameWithin) {
            const count = previous.matches.length;
            const activeMatchIndex = count ? ((update?.activeMatchIndex ?? previous.activeMatchIndex) % count + count) % count : 0;
            if (activeMatchIndex === previous.activeMatchIndex) return previous;
            const oldMatch = previous.matches[previous.activeMatchIndex];
            const nextMatch = previous.matches[activeMatchIndex];
            const remove = [...decorationsOf(previous.decorations, oldMatch), ...decorationsOf(previous.decorations, nextMatch)];
            const decorations = previous.decorations.remove(remove).add(transaction.doc, [
              matchDecoration(oldMatch, false),
              matchDecoration(nextMatch, true),
            ]);
            return { ...previous, activeMatchIndex, decorations };
          }
          const requested = update?.activeMatchIndex ?? previous.activeMatchIndex;
          // The same search after an edit: only the units the edit touched are searched again.
          if (transaction.docChanged && sameFinder && sameWithin) {
            const next = updateFindState(previous, transaction, requested, within);
            if (next) { tiptapFindWork.incremental++; return next; }
            tiptapFindWork.fallback++;
          }
          return createFindState(transaction.doc, finder, requested, { reading: previous.reading, within });
        },
      },
      props: {
        decorations: (state) => tiptapFindPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
      },
    })];
  },
});

export function updateTiptapFind(
  editor: Editor,
  update: TiptapFindUpdate,
) {
  editor.view.dispatch(editor.state.tr.setMeta(tiptapFindPluginKey, update));
}
