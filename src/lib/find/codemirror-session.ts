import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, type KeyBinding, type ViewUpdate } from "@codemirror/view";
import { describeMatch, type Finder, type MatchPreview, type Replacer } from "./index";
import {
  excerptMatch, findHighlightsField, findInState, findKeymap, findSeedFromSelection, findWithinField, replaceAllSpec, replaceOneSpec,
  replaceTextSpec, setActiveFindMatch, setFindMatches, setFindWithin,
} from "./codemirror";
import type { FindFlavor, FindMatch, FindResult, TextRange } from "./types";
import { createFindSearchRunner, type FindSearchRunner } from "./worker-search";
import type { FindRecipeStep } from "./presets";
import { runRecipe } from "./recipe";
import { isolateHistory } from "@codemirror/commands";

/* One CodeMirror editor's find bar, outside React: when to search (at once
 * for a new query, debounced after edits, in a worker for Regex mode), which
 * match is active, In selection, Replace and Replace All. The bar component
 * (components/libera/find/codemirror-find-bar.tsx) feeds it the compiled query
 * and draws its snapshot. */

export type FindBarFocus = "find" | "replace";
export type FindOpenRequest = { focus: FindBarFocus; seed: string | null };

export type FindSessionSnapshot = {
  open: boolean;
  matchCount: number;
  /** Index of the active match, -1 for none. */
  active: number;
  incomplete: boolean;
  preview: MatchPreview | null;
  summary: { replaced: number; skipped: number } | null;
  inSelection: boolean;
};

export type FindSessionQuery = { query: string; finder: Finder | null; replacer: Replacer | null };

type SearchReason = "open" | "query" | "doc";

export const FIND_DEBOUNCE_MS = 100;

function firstAtOrAfter(matches: readonly FindMatch[], pos: number) {
  const index = matches.findIndex((match) => match.start >= pos);
  return index < 0 ? 0 : index;
}

function searchKey(finder: Finder, within: readonly TextRange[] | null) {
  return within ? `${finder.key}\u0000${JSON.stringify(within)}` : finder.key;
}

const CLOSED: FindSessionSnapshot = { open: false, matchCount: 0, active: -1, incomplete: false, preview: null, summary: null, inSelection: false };

export class CodeMirrorFindSession {
  /** Fields and the update listener; install with `keymap` in the editor. */
  readonly extension: Extension;
  /** The bar's keys, in place of `searchKeymap`'s panel keys (see `searchKeymapWithoutPanel`). */
  readonly keymap: readonly KeyBinding[];

  private view: EditorView | null = null;
  private current: FindSessionQuery = { query: "", finder: null, replacer: null };
  private isOpen = false;
  private incomplete = false;
  private summary: FindSessionSnapshot["summary"] = null;
  /** The selection the user made (not one find made), mapped through edits: In selection starts from it. */
  private userSelection: EditorSelection | null = null;
  /** What the matches in the field were found for: the document and the query with its In selection ranges. */
  private found: { doc: unknown; key: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;
  private runner: FindSearchRunner | null = null;
  private readonly createRunner: () => FindSearchRunner;
  private readonly debounceMs: number;
  private snapshot: FindSessionSnapshot = CLOSED;
  private readonly listeners = new Set<() => void>();
  private readonly openListeners = new Set<(request: FindOpenRequest) => void>();

  constructor(options: { createRunner?: () => FindSearchRunner; debounceMs?: number } = {}) {
    this.createRunner = options.createRunner ?? (() => createFindSearchRunner());
    this.debounceMs = options.debounceMs ?? FIND_DEBOUNCE_MS;
    this.keymap = findKeymap({
      open: (view, focus) => this.open(view, focus),
      next: (view) => { this.attach(view); if (!this.isOpen) return this.open(view, "find", false); this.next(); return true; },
      previous: (view) => { this.attach(view); if (!this.isOpen) return this.open(view, "find", false); this.previous(); return true; },
      close: (view) => { this.attach(view); if (!this.isOpen) return false; this.close(); return true; },
    });
    this.extension = [findHighlightsField, findWithinField, EditorView.updateListener.of((update) => this.onUpdate(update))];
  }

  /* ---- For React ---- */

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  /** Called when a key (or `open`) asks for the bar: fill the query with `seed` and focus the field. */
  onOpenRequest(listener: (request: FindOpenRequest) => void) {
    this.openListeners.add(listener);
    return () => { this.openListeners.delete(listener); };
  }

  attach(view: EditorView | null) {
    if (this.view === view) return;
    this.view = view;
    this.userSelection = null;
    this.found = null;
    if (view && this.isOpen) void this.search("doc");
  }

  /** The compiled query and replacement from the bar. */
  setQuery(next: FindSessionQuery) {
    const changed = next.query !== this.current.query || next.finder?.key !== this.current.finder?.key;
    this.current = next;
    if (!changed) { this.emit(); return; }
    this.summary = null;
    if (this.isOpen) void this.search("query");
  }

  /* ---- Commands ---- */

  open(view: EditorView, focus: FindBarFocus = "find", seedFromSelection = true) {
    this.attach(view);
    const wasOpen = this.isOpen;
    this.isOpen = true;
    this.summary = null;
    this.userSelection ??= view.state.selection;
    const seed = seedFromSelection ? findSeedFromSelection(view.state) : null;
    this.emit();
    for (const listener of this.openListeners) listener({ focus, seed });
    // A seed different from the query searches when the bar passes it back through `setQuery`.
    if (!wasOpen) void this.search("open");
    return true;
  }

  close = () => {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.clearTimer();
    this.token++;
    this.runner?.cancel();
    this.found = null;
    this.incomplete = false;
    this.summary = null;
    const view = this.view;
    if (view) {
      view.dispatch({ effects: [setFindMatches.of({ matches: [], active: -1 }), setFindWithin.of(null)] });
      view.focus();
    }
    this.emit();
  };

  next = () => this.step(1);
  previous = () => this.step(-1);

  toggleInSelection = () => {
    const view = this.view;
    if (!view) return;
    if (view.state.field(findWithinField, false)) {
      view.dispatch({ effects: setFindWithin.of(null) });
    } else {
      const selection = this.userSelection ?? view.state.selection;
      const ranges = selection.ranges.filter((range) => !range.empty).map((range) => ({ start: range.from, end: range.to }));
      // Nothing was selected: there is nothing to search in.
      if (!ranges.length) return;
      view.dispatch({ effects: setFindWithin.of(ranges) });
    }
    void this.search("query");
  };

  /** Replaces the active match and moves to the next one. */
  replace = async () => {
    const view = this.view, replacer = this.current.replacer;
    if (!view || !replacer || !(await this.ensureFresh())) return;
    const { matches, active } = view.state.field(findHighlightsField);
    const match = matches[active];
    if (!match) return;
    const result = replaceOneSpec(view.state, match, replacer, active + 1);
    if ("error" in result) {
      this.summary = { replaced: 0, skipped: 1 };
      this.select(view, (active + 1) % matches.length);
      return;
    }
    view.dispatch(result.spec);
    this.summary = null;
    // Not awaited: a Regex-mode search finishes in the worker.
    void this.search("query", match.start + result.insert.length);
  };

  /** Replaces every match in one transaction: one undo step, one collaborative update. */
  replaceAll = async () => {
    const view = this.view, replacer = this.current.replacer;
    if (!view || !replacer || !(await this.ensureFresh())) return;
    const { matches } = view.state.field(findHighlightsField);
    if (!matches.length) return;
    const { spec, replaced, skipped } = replaceAllSpec(view.state, matches, replacer);
    if (spec) view.dispatch(spec);
    this.summary = { replaced, skipped };
    this.emit();
    void this.search("doc");
  };

  /** Runs a recipe's steps over the document in order, as one transaction (one undo step). */
  runRecipe = (steps: readonly FindRecipeStep[], flavor: FindFlavor) => {
    const view = this.view;
    if (!view) return;
    const result = runRecipe(view.state.doc.toString(), steps, flavor);
    const spec = replaceTextSpec(view.state, result.text);
    if (spec) view.dispatch({ ...spec, annotations: isolateHistory.of("full") });
    this.summary = { replaced: result.replaced, skipped: result.skipped };
    this.emit();
    void this.search("doc");
  };

  /** Stops pending searches and the worker (a later search starts a new one). Listeners stay subscribed. */
  dispose() {
    this.clearTimer();
    this.token++;
    this.runner?.dispose();
    this.runner = null;
  }

  /** Searches now (tests; the bar searches by itself). */
  searchNow() {
    return this.search("query");
  }

  /* ---- Internals ---- */

  private onUpdate(update: ViewUpdate) {
    this.view = update.view;
    const ours = update.transactions.some((tr) => tr.isUserEvent("select.search"));
    if (update.selectionSet && !ours) this.userSelection = update.state.selection;
    else if (update.docChanged && this.userSelection) this.userSelection = this.userSelection.map(update.changes);
    if (!this.isOpen) return;
    if (update.docChanged) {
      // An edit after Replace All hides its summary.
      if (!update.transactions.some((tr) => tr.isUserEvent("input.replace"))) this.summary = null;
      this.scheduleSearch();
    }
    if (update.startState.field(findHighlightsField, false) !== update.state.field(findHighlightsField, false)
      || update.startState.field(findWithinField, false) !== update.state.field(findWithinField, false)) this.emit();
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleSearch() {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.search("doc"); }, this.debounceMs);
  }

  /** Searches the current text; `activateAfter` makes the first match from there active and selected. */
  private async search(reason: SearchReason, activateAfter?: number) {
    const view = this.view;
    if (!view || !this.isOpen) return;
    this.clearTimer();
    const token = ++this.token;
    const { finder, query } = this.current;
    if (!finder || !query) {
      this.runner?.cancel();
      this.apply(view, { matches: [], incomplete: false }, null, reason);
      return;
    }
    const state = view.state;
    const within = state.field(findWithinField, false) ?? null;
    const key = searchKey(finder, within);
    if (finder.options.mode !== "regex") {
      this.runner?.cancel();
      this.apply(view, findInState(state, finder), key, reason, activateAfter);
      return;
    }
    const doc = state.doc;
    this.runner ??= this.createRunner();
    const outcome = await this.runner.search({ query, options: finder.options, text: doc.toString(), limits: within ? { within: [...within] } : undefined });
    // A newer search, an edit meanwhile (searched again after it), or the bar closed.
    if (!outcome || token !== this.token || this.view !== view || view.state.doc !== doc || !this.isOpen) return;
    this.apply(view, outcome, key, reason, activateAfter);
  }

  private apply(view: EditorView, result: FindResult, key: string | null, reason: SearchReason, activateAfter?: number) {
    const state = view.state;
    const { matches } = result;
    let active = -1, select = false;
    if (matches.length) {
      if (activateAfter !== undefined) {
        active = firstAtOrAfter(matches, activateAfter);
        select = true;
      } else if (reason === "doc") {
        // After an edit: the same match stays active (or the next one), and the selection is left alone.
        const before = state.field(findHighlightsField);
        const previous = before.matches[before.active];
        active = firstAtOrAfter(matches, previous ? previous.start : state.selection.main.from);
      } else {
        // A new query: the first match from the cursor on.
        active = firstAtOrAfter(matches, state.selection.main.from);
        select = true;
      }
    }
    this.incomplete = result.incomplete;
    this.found = key === null ? null : { doc: state.doc, key };
    const match = select ? matches[active] : undefined;
    view.dispatch({
      effects: [setFindMatches.of({ matches, active }), ...(match ? [EditorView.scrollIntoView(EditorSelection.range(match.start, match.end), { y: "nearest", yMargin: 96 })] : [])],
      ...(match ? { selection: { anchor: match.start, head: match.end }, userEvent: "select.search" } : {}),
    });
    this.emit();
  }

  /** Whether the field's matches were found in the current text for the current query; searches again if not. */
  private async ensureFresh() {
    const view = this.view, finder = this.current.finder;
    if (!view || !finder || !this.isOpen) return false;
    const isFresh = () => {
      const within = view.state.field(findWithinField, false) ?? null;
      return this.found !== null && this.found.doc === view.state.doc && this.found.key === searchKey(finder, within);
    };
    if (isFresh()) return true;
    await this.search("doc");
    return this.view === view && this.current.finder === finder && isFresh();
  }

  private step(direction: 1 | -1) {
    const view = this.view;
    if (!view) return false;
    const { matches, active } = view.state.field(findHighlightsField);
    if (!matches.length) return true;
    const selection = view.state.selection.main;
    const current = matches[active];
    let index: number;
    if (current && selection.from === current.start && selection.to === current.end) {
      index = (active + direction + matches.length) % matches.length;
    } else if (direction > 0) {
      index = firstAtOrAfter(matches, selection.to);
    } else {
      index = -1;
      for (let i = matches.length - 1; i >= 0; i--) if (matches[i].end <= selection.from) { index = i; break; }
      if (index < 0) index = matches.length - 1;
    }
    this.select(view, index);
    return true;
  }

  private select(view: EditorView, index: number) {
    const match = view.state.field(findHighlightsField).matches[index];
    if (!match) return;
    view.dispatch({
      selection: { anchor: match.start, head: match.end },
      effects: [setActiveFindMatch.of(index), EditorView.scrollIntoView(EditorSelection.range(match.start, match.end), { y: "nearest", yMargin: 96 })],
      userEvent: "select.search",
    });
    this.emit();
  }

  private emit() {
    const view = this.view;
    if (!this.isOpen || !view) {
      this.snapshot = this.isOpen ? { ...CLOSED, open: true, summary: this.summary } : CLOSED;
    } else {
      const { matches, active } = view.state.field(findHighlightsField);
      const match = matches[active];
      const { finder, replacer } = this.current;
      let preview: MatchPreview | null = null;
      if (match && finder) {
        const excerpt = excerptMatch(view.state.doc, match);
        preview = describeMatch(excerpt.text, excerpt.match, finder, replacer, active + 1);
      }
      this.snapshot = {
        open: true,
        matchCount: matches.length,
        active,
        incomplete: this.incomplete,
        preview,
        summary: this.summary,
        inSelection: !!view.state.field(findWithinField, false),
      };
    }
    for (const listener of this.listeners) listener();
  }
}
