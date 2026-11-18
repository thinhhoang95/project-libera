import { isolateHistory } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { StateEffect, StateField, type ChangeDesc, type EditorState, type Text, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, type Command, type DecorationSet, type KeyBinding } from "@codemirror/view";
import type { FindLimits, Finder, Replacer } from "./index";
import type { FindMatch, FindResult, TextRange } from "./types";

/* The find & replace engine in a CodeMirror editor (LaTeX, code;
 * docs/find-replace-patterns-plan.md §10). Matches are drawn with the same
 * classes as the Markdown editors' find. Between searches they are mapped
 * through edits; `doc` tells whether they were found in the current text. */

export type FindHighlights = {
  /** In positions of the current document (mapped since the search). */
  matches: readonly FindMatch[];
  /** Index of the active match, -1 for none. */
  active: number;
  /** The document the matches were found in; another one means they were mapped since. */
  doc: Text | null;
  decorations: DecorationSet;
};

/** Matches found in the transaction's new document, and the active one (-1 for none). */
export const setFindMatches = StateEffect.define<{ matches: readonly FindMatch[]; active: number }>();
export const setActiveFindMatch = StateEffect.define<number>();
/** In selection: the ranges searched, in the transaction's new document; null switches it off. */
export const setFindWithin = StateEffect.define<readonly TextRange[] | null>();

const matchMark = Decoration.mark({ class: "markdown-editor-find-match" });
const activeMark = Decoration.mark({ class: "markdown-editor-find-match markdown-editor-find-match-active" });

const EMPTY: FindHighlights = { matches: [], active: -1, doc: null, decorations: Decoration.none };

function decorate(matches: readonly FindMatch[], active: number) {
  if (!matches.length) return Decoration.none;
  return Decoration.set(matches.flatMap((match, index) => match.end > match.start
    ? [(index === active ? activeMark : matchMark).range(match.start, match.end)]
    : []), true);
}

function highlights(matches: readonly FindMatch[], active: number, doc: Text): FindHighlights {
  const valid = matches.filter((match) => match.start >= 0 && match.end <= doc.length && match.end > match.start);
  const index = valid.length ? Math.max(-1, Math.min(active, valid.length - 1)) : -1;
  return { matches: valid, active: index, doc, decorations: decorate(valid, index) };
}

/** A match moved through an edit; null when the edit removed it. Text typed at its edges stays outside. */
export function mapFindMatch(match: FindMatch, changes: ChangeDesc): FindMatch | null {
  const start = changes.mapPos(match.start, 1), end = changes.mapPos(match.end, -1);
  if (end <= start) return null;
  return {
    start,
    end,
    captures: match.captures.map((capture) => capture.start < 0 ? capture : {
      ...capture,
      start: changes.mapPos(capture.start, 1),
      end: Math.max(changes.mapPos(capture.start, 1), changes.mapPos(capture.end, -1)),
    }),
  };
}

function mapHighlights(value: FindHighlights, changes: ChangeDesc): FindHighlights {
  const matches: FindMatch[] = [];
  let active = -1, activeLost = false;
  for (let index = 0; index < value.matches.length; index++) {
    const mapped = mapFindMatch(value.matches[index], changes);
    if (index === value.active) {
      active = matches.length;
      activeLost = !mapped;
    }
    if (mapped) matches.push(mapped);
  }
  if (active >= matches.length) active = matches.length - 1;
  // The active match went away: the next one becomes active, and its mark has to be redrawn.
  const decorations = activeLost ? decorate(matches, active) : value.decorations.map(changes);
  return { matches, active, doc: value.doc, decorations };
}

export const findHighlightsField = StateField.define<FindHighlights>({
  create: () => EMPTY,
  update(value, tr) {
    let next = tr.docChanged && value.matches.length ? mapHighlights(value, tr.changes) : value;
    for (const effect of tr.effects) {
      if (effect.is(setFindMatches)) next = effect.value.matches.length ? highlights(effect.value.matches, effect.value.active, tr.state.doc) : EMPTY;
      else if (effect.is(setActiveFindMatch) && effect.value !== next.active) {
        const active = next.matches.length ? Math.max(-1, Math.min(effect.value, next.matches.length - 1)) : -1;
        next = { ...next, active, decorations: decorate(next.matches, active) };
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function mapFindRange(range: TextRange, changes: ChangeDesc): TextRange {
  // Text typed at either edge joins the range, so a replacement of a whole range stays inside it.
  return { start: changes.mapPos(range.start, -1), end: changes.mapPos(range.end, 1) };
}

export const findWithinField = StateField.define<readonly TextRange[] | null>({
  create: () => null,
  update(value, tr) {
    let next = value && tr.docChanged ? value.map((range) => mapFindRange(range, tr.changes)).filter((range) => range.end > range.start) : value;
    for (const effect of tr.effects) if (effect.is(setFindWithin)) next = effect.value;
    return next;
  },
});

/** The active match, for the LaTeX Visual mode to show as source (`visualRevealRanges`). */
export function activeFindRanges(state: EditorState): { from: number; to: number }[] {
  const value = state.field(findHighlightsField, false);
  const match = value && value.active >= 0 ? value.matches[value.active] : undefined;
  return match ? [{ from: match.start, to: match.end }] : [];
}

/** Searches the editor's text, In selection limited to `findWithinField` unless `limits` says otherwise. */
export function findInState(state: EditorState, finder: Finder, limits?: FindLimits, text = state.doc.toString()): FindResult {
  const within = limits?.within ?? state.field(findWithinField, false) ?? undefined;
  return finder.find(text, { ...limits, ...(within ? { within: [...within] } : {}) });
}

/** The match moved to the start of a short text holding just it, for rendering a replacement without the whole document. */
export function excerptMatch(doc: Text, match: FindMatch): { text: string; match: FindMatch } {
  const shift = match.start;
  return {
    text: doc.sliceString(match.start, match.end),
    match: {
      start: 0,
      end: match.end - shift,
      captures: match.captures.map((capture) => capture.start < 0 ? capture : { ...capture, start: capture.start - shift, end: capture.end - shift }),
    },
  };
}

/** One Replace: the transaction, or the reason this match has no replacement. */
export function replaceOneSpec(state: EditorState, match: FindMatch, replacer: Replacer, counter: number):
  { spec: TransactionSpec; insert: string } | { error: true } {
  const excerpt = excerptMatch(state.doc, match);
  const insert = replacer.render(excerpt.text, excerpt.match, counter);
  if (typeof insert !== "string") return { error: true };
  return {
    insert,
    spec: {
      changes: { from: match.start, to: match.end, insert },
      selection: { anchor: match.start + insert.length },
      userEvent: "input.replace",
    },
  };
}

/**
 * Replace All as one transaction (one undo step, one collaborative update).
 * `@#` numbers the matches 1..n in document order; a match whose replacement
 * cannot be computed keeps its number, stays as it is and is counted as skipped.
 */
export function replaceAllSpec(state: EditorState, matches: readonly FindMatch[], replacer: Replacer, text = state.doc.toString()):
  { spec: TransactionSpec | null; replaced: number; skipped: number } {
  const changes: { from: number; to: number; insert: string }[] = [];
  let replaced = 0, skipped = 0;
  matches.forEach((match, index) => {
    const insert = replacer.render(text, match, index + 1);
    if (typeof insert !== "string") { skipped++; return; }
    replaced++;
    // A match replaced by itself counts as replaced but changes nothing.
    if (insert !== text.slice(match.start, match.end)) changes.push({ from: match.start, to: match.end, insert });
  });
  // Its own undo step, never joined with typing just before or after it.
  return { spec: changes.length ? { changes, userEvent: "input.replace.all", annotations: isolateHistory.of("full") } : null, replaced, skipped };
}

/**
 * The whole text replaced by `next` as one transaction changing only the span
 * that differs (recipes and other whole-text rewrites); null when nothing changed.
 */
export function replaceTextSpec(state: EditorState, next: string, userEvent = "input.replace.all"): TransactionSpec | null {
  const text = state.doc.toString();
  if (text === next) return null;
  let start = 0;
  const shortest = Math.min(text.length, next.length);
  while (start < shortest && text.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = text.length, nextEnd = next.length;
  while (end > start && nextEnd > start && text.charCodeAt(end - 1) === next.charCodeAt(nextEnd - 1)) { end--; nextEnd--; }
  return { changes: { from: start, to: end, insert: next.slice(start, nextEnd) }, userEvent };
}

export type FindKeyCommands = {
  /** Opens (or refocuses) the bar on its find or replace field. */
  open: (view: EditorView, focus: "find" | "replace") => boolean;
  next: Command;
  previous: Command;
  /** Closes the bar if it is open; false otherwise, so Escape keeps its other uses. */
  close: Command;
};

/** The find bar's keys (plan §8), in place of the stock search panel's. */
export function findKeymap(commands: FindKeyCommands): KeyBinding[] {
  return [
    { key: "Mod-f", run: (view) => commands.open(view, "find"), preventDefault: true },
    { key: "Mod-h", run: (view) => commands.open(view, "replace"), preventDefault: true },
    { key: "Mod-Alt-f", run: (view) => commands.open(view, "replace"), preventDefault: true },
    { key: "F3", run: commands.next, shift: commands.previous, preventDefault: true },
    { key: "Mod-g", run: commands.next, shift: commands.previous, preventDefault: true },
    { key: "Escape", run: commands.close },
  ];
}

const PANEL_KEYS = new Set(["Mod-f", "F3", "Mod-g", "Escape"]);

/** `@codemirror/search`'s keymap without the panel's keys: Mod-d, Mod-Shift-l and Mod-Alt-g (go to line) stay. */
export const searchKeymapWithoutPanel: readonly KeyBinding[] = searchKeymap.filter((binding) => !binding.key || !PANEL_KEYS.has(binding.key));

/** The query to open the bar with: the selection when it is on one line. */
export function findSeedFromSelection(state: EditorState): string | null {
  const { from, to } = state.selection.main;
  if (from === to) return null;
  const text = state.sliceDoc(from, to);
  return text.includes("\n") ? null : text;
}
