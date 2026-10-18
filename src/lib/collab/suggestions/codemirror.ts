// Preview-mode rendering of overlay suggestions in CodeMirror (plan M3.1).
//
// The document is never changed: the text a suggestion would replace is
// struck through (red, as in latex/codemirror/review.ts) and tinted with the
// author's colour, the replacement is drawn as a green widget after it, and
// the last suggestion of each group carries a label and Accept / Reject /
// Reply buttons whose behaviour the app supplies.
//
// Cost on large documents: suggestions are resolved against Yjs only when the
// annotations map changes. Text edits map the cached ranges through the
// CodeMirror change set (with the same associativity as the stored relative
// positions) and recheck only the suggestions an edit touched; those are then
// re-resolved exactly through Yjs in a microtask, which catches undo
// restoring deleted text and deleted neighbours of insertion points.

import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import type * as Y from "yjs";
import type { SuggestionRecord } from "../protocol/schema";
import { editSuggestionReplacement, groupKey, listSuggestions, resolveSuggestion, suggestionsMap, type ResolvedSuggestion, type StaleReason, type SuggestionsTarget } from "./model";

export interface SuggestionAuthor {
  name: string;
  color: string;
}

/** One suggestion as the editor shows it. */
export interface ViewSuggestion {
  id: string;
  groupId: string;
  record: SuggestionRecord;
  from: number;
  to: number;
  currentText: string;
  isStale: boolean;
  staleReason?: StaleReason;
  isInsertion: boolean;
}

/** What the action callbacks receive: a whole group, since groups are decided together. */
export interface SuggestionGroupRef {
  groupId: string;
  ids: string[];
  suggestions: ViewSuggestion[];
}

export interface SuggestionPreviewOptions {
  ytext: Y.Text;
  annotations: SuggestionsTarget;
  /** Display name and colour of a suggestion's account. For AI suggestions this is the user it acted for. */
  author: (record: SuggestionRecord) => SuggestionAuthor;
  /** Whether to show Accept and Reject (editors and owners; never for viewers or commenters). */
  canDecide?: boolean;
  /** The local account, for editing your own pending suggestions inline in suggest mode. */
  localUserId?: string;
  onAccept?: (group: SuggestionGroupRef) => void;
  onReject?: (group: SuggestionGroupRef) => void;
  onReply?: (group: SuggestionGroupRef) => void;
}

/** Provided by suggest mode: your own pending replacements become editable in place. */
export const inlineReplacementEditing = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

const previewConfig = Facet.define<SuggestionPreviewOptions, SuggestionPreviewOptions | null>({ combine: (values) => values[0] ?? null });

const setSuggestionItems = StateEffect.define<ViewSuggestion[]>();
const patchSuggestionItems = StateEffect.define<ViewSuggestion[]>();

type FieldValue = { items: ViewSuggestion[]; decorations: DecorationSet; touched: readonly string[] };

export function toViewSuggestion(resolved: ResolvedSuggestion): ViewSuggestion {
  return {
    id: resolved.record.id,
    groupId: groupKey(resolved.record),
    record: resolved.record,
    from: resolved.start,
    to: resolved.end,
    currentText: resolved.currentText,
    isStale: resolved.isStale,
    staleReason: resolved.staleReason,
    isInsertion: resolved.isInsertion,
  };
}

const sortItems = (items: ViewSuggestion[]) => items.sort((a, b) => a.from - b.from || a.to - b.to || a.record.createdAt - b.record.createdAt || a.id.localeCompare(b.id));

function resolveAll(config: SuggestionPreviewOptions, docLength: number): ViewSuggestion[] {
  const records = listSuggestions(config.annotations, { status: ["pending", "stale"] });
  // Ranges past the editor's end mean the editor has not caught up with Yjs
  // yet; they are re-resolved on the next refresh.
  return sortItems(records.map((record) => toViewSuggestion(resolveSuggestion(config.ytext, record))).filter((item) => item.to <= docLength));
}

/** Map a cached suggestion through a change set the way its relative positions move. */
function mapItem(item: ViewSuggestion, tr: Transaction): { item: ViewSuggestion; touched: boolean } {
  const changes = tr.changes;
  const length = tr.startState.doc.length;
  const touched = (item.isInsertion
    ? changes.touchesRange(Math.max(0, item.from - 1), Math.min(length, item.to + 1))
    : changes.touchesRange(item.from, item.to)) !== false;
  const from = item.isInsertion ? changes.mapPos(item.from, -1) : changes.mapPos(item.from, 1);
  const to = Math.max(from, item.isInsertion ? changes.mapPos(item.to, 1) : changes.mapPos(item.to, -1));
  if (!touched) return from === item.from && to === item.to ? { item, touched } : { item: { ...item, from, to }, touched };
  const currentText = tr.newDoc.sliceString(from, to);
  let staleReason: StaleReason | undefined;
  if (item.record.status === "stale") staleReason = item.record.staleReason ?? "text-changed";
  else if (item.isInsertion) staleReason = currentText !== "" ? "text-changed" : item.staleReason;
  else if (to <= from) staleReason = "target-removed";
  else if (currentText !== item.record.baseQuote) staleReason = "text-changed";
  return { item: { ...item, from, to, currentText, isStale: staleReason !== undefined, staleReason }, touched };
}

const suggestionsField = StateField.define<FieldValue>({
  create(state) {
    const config = state.facet(previewConfig);
    const items = config ? resolveAll(config, state.doc.length) : [];
    return { items, decorations: buildDecorations(state, items), touched: [] };
  },
  update(value, tr) {
    let items = value.items;
    let touched: string[] = [];
    let replaced = false;
    if (tr.docChanged && items.length) {
      items = items.map((item) => {
        const mapped = mapItem(item, tr);
        if (mapped.touched) touched.push(item.id);
        return mapped.item;
      });
    }
    for (const effect of tr.effects) {
      if (effect.is(setSuggestionItems)) { items = sortItems([...effect.value]); touched = []; replaced = true; }
      if (effect.is(patchSuggestionItems)) {
        const patch = new Map(effect.value.map((item) => [item.id, item]));
        items = sortItems(items.map((item) => patch.get(item.id) ?? item));
        touched = touched.filter((id) => !patch.has(id));
        replaced = true;
      }
    }
    if (!tr.docChanged && !replaced) return value.touched.length ? { ...value, touched: [] } : value;
    // Untouched suggestions only moved, exactly as their decorations map;
    // anything touched or replaced is redrawn.
    const decorations = replaced || touched.length ? buildDecorations(tr.state, items) : value.decorations.map(tr.changes);
    return { items, decorations, touched };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Suggestions currently shown, in document order. */
export function previewSuggestions(state: EditorState): readonly ViewSuggestion[] {
  return state.field(suggestionsField, false)?.items ?? [];
}

/** Groups shown in the editor, in document order of their first suggestion. */
export function previewGroups(state: EditorState): SuggestionGroupRef[] {
  const groups = new Map<string, SuggestionGroupRef>();
  for (const item of previewSuggestions(state)) {
    const group = groups.get(item.groupId);
    if (group) { group.ids.push(item.id); group.suggestions.push(item); } else groups.set(item.groupId, { groupId: item.groupId, ids: [item.id], suggestions: [item] });
  }
  return [...groups.values()];
}

/* ---- Widgets --------------------------------------------------------------------- */

export function authorLabel(record: SuggestionRecord, author: SuggestionAuthor): string {
  return record.actor.kind === "ai" ? `AI · on behalf of ${author.name}` : author.name;
}

function staleTooltip(item: ViewSuggestion): string {
  const why = item.staleReason === "target-removed" ? "The text this suggestion was made for was deleted." : "The text changed after this suggestion was made.";
  return `${why}\nWas: ${JSON.stringify(item.record.baseQuote)}\nNow: ${JSON.stringify(item.currentText)}\nProposed: ${JSON.stringify(item.record.replacement)}`;
}

class ReplacementWidget extends WidgetType {
  constructor(readonly id: string, readonly text: string, readonly block: boolean, readonly color: string, readonly stale: boolean, readonly title: string, readonly inlineEditable: boolean) { super(); }
  // CodeMirror leaves contenteditable alone on editable widgets.
  get editable() { return this.inlineEditable; }
  eq(other: ReplacementWidget) {
    return other.id === this.id && other.text === this.text && other.block === this.block && other.color === this.color && other.stale === this.stale && other.title === this.title && other.inlineEditable === this.inlineEditable;
  }
  toDOM(view: EditorView) {
    const element = document.createElement(this.block ? "div" : "span");
    element.dataset.suggestionId = this.id;
    this.render(element, view);
    return element;
  }
  updateDOM(element: HTMLElement, view: EditorView) {
    if (element.dataset.suggestionId !== this.id) return false;
    this.render(element, view);
    return true;
  }
  private render(element: HTMLElement, view: EditorView) {
    element.className = `cm-collab-suggestion-inserted${this.block ? " cm-collab-suggestion-inserted-block" : ""}${this.stale ? " cm-collab-suggestion-stale" : ""}`;
    element.style.setProperty("--collab-author", this.color);
    element.setAttribute("aria-label", `Suggested: ${this.text}`);
    if (this.title) element.title = this.title; else element.removeAttribute("title");
    // Leave the text alone while its author types in it; the store echoes it back.
    if (element.ownerDocument.activeElement !== element) element.textContent = this.block ? this.text.replace(/\n$/, "") : this.text;
    element.contentEditable = this.inlineEditable ? "true" : "false";
    if (this.inlineEditable && !element.dataset.bound) {
      element.dataset.bound = "true";
      element.spellcheck = true;
      element.addEventListener("input", () => {
        const config = view.state.facet(previewConfig);
        if (element.contentEditable === "true" && config?.localUserId) editSuggestionReplacement(config.annotations, this.id, config.localUserId, element.textContent ?? "");
      });
      element.addEventListener("keydown", (event) => {
        // Inline editing is single-line; multi-line replacements are edited from the panel.
        if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); element.blur(); view.focus(); }
      });
    }
  }
  ignoreEvent() { return true; }
}

class ActionsWidget extends WidgetType {
  constructor(readonly groupId: string, readonly label: string, readonly color: string, readonly count: number, readonly stale: boolean, readonly title: string, readonly canDecide: boolean) { super(); }
  eq(other: ActionsWidget) {
    return other.groupId === this.groupId && other.label === this.label && other.color === this.color && other.count === this.count && other.stale === this.stale && other.title === this.title && other.canDecide === this.canDecide;
  }
  toDOM(view: EditorView) {
    const root = document.createElement("span");
    root.className = `libera-change-actions cm-collab-suggestion-actions${this.stale ? " cm-collab-suggestion-stale" : ""}`;
    root.contentEditable = "false";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", `Suggestion by ${this.label}`);
    root.style.setProperty("--collab-author", this.color);
    if (this.title) root.title = this.title;
    const label = document.createElement("span");
    label.className = "cm-collab-suggestion-label";
    label.textContent = `${this.stale ? "Stale · " : ""}${this.label}${this.count > 1 ? ` · ${this.count} changes` : ""}`;
    root.append(label);
    const config = view.state.facet(previewConfig);
    const button = (text: string, action: "accept" | "reject" | "reply", handler: ((group: SuggestionGroupRef) => void) | undefined) => {
      if (!handler) return;
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = text;
      element.className = `cm-collab-suggestion-${action}`;
      element.dataset.action = action;
      element.addEventListener("mousedown", (event) => event.preventDefault());
      element.addEventListener("click", (event) => {
        event.preventDefault();
        const group = previewGroups(view.state).find((candidate) => candidate.groupId === this.groupId);
        if (group) handler(group);
      });
      root.append(element);
    };
    if (this.canDecide) {
      button("Reject", "reject", config?.onReject);
      // A stale group cannot be accepted until it is refreshed.
      if (!this.stale) button("Accept", "accept", config?.onAccept);
    }
    button("Reply", "reply", config?.onReply);
    return root;
  }
  ignoreEvent() { return true; }
}

function buildDecorations(state: EditorState, items: readonly ViewSuggestion[]): DecorationSet {
  const config = state.facet(previewConfig);
  if (!config || !items.length) return Decoration.none;
  const editing = state.facet(inlineReplacementEditing);
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  const lastOfGroup = new Map<string, ViewSuggestion>();
  const counts = new Map<string, number>();
  const groupStale = new Map<string, boolean>();
  for (const item of items) {
    lastOfGroup.set(item.groupId, item);
    counts.set(item.groupId, (counts.get(item.groupId) ?? 0) + 1);
    groupStale.set(item.groupId, (groupStale.get(item.groupId) ?? false) || item.isStale);
  }
  for (const item of items) {
    if (item.to > doc.length) continue;
    const author = config.author(item.record);
    const title = item.isStale ? staleTooltip(item) : "";
    const style = `--collab-author: ${author.color}`;
    if (item.to > item.from) {
      ranges.push(Decoration.mark({
        class: `cm-collab-suggestion-deleted${item.isStale ? " cm-collab-suggestion-stale" : ""}`,
        attributes: { style, "data-suggestion-id": item.id, ...(title ? { title } : {}) },
      }).range(item.from, item.to));
    }
    if (item.record.replacement) {
      const block = item.record.replacement.includes("\n") && doc.lineAt(item.from).from === item.from;
      const editable = editing && !item.isStale && item.record.status === "pending" && item.record.actor.kind === "user" && item.record.createdBy === config.localUserId;
      const widget = new ReplacementWidget(item.id, item.record.replacement, block, author.color, item.isStale, title, editable && !block);
      // An insertion is drawn before the caret at its point, so typing there
      // in suggest mode visibly extends it; a replacement follows the struck text.
      ranges.push(Decoration.widget({ widget, side: block ? 1 : item.isInsertion ? -1 : 1, block }).range(block ? doc.lineAt(item.to).to : item.to));
    }
    if (lastOfGroup.get(item.groupId) === item) {
      const stale = groupStale.get(item.groupId) ?? false;
      const widget = new ActionsWidget(item.groupId, authorLabel(item.record, author), author.color, counts.get(item.groupId) ?? 1, stale, title, !!config.canDecide);
      ranges.push(Decoration.widget({ widget, side: 2 }).range(item.to));
    }
  }
  return Decoration.set(ranges, true);
}

/* ---- Keeping in step with the annotations map --------------------------------------- */

const refresher = ViewPlugin.define((view) => {
  const config = view.state.facet(previewConfig);
  if (!config) return {};
  const map = suggestionsMap(config.annotations);
  let destroyed = false;
  let fullScheduled = false;
  const pending = new Set<string>();
  let patchScheduled = false;
  // Dispatching is deferred: the map can change while the view is updating
  // (suggest mode writes from an update listener).
  const refreshAll = () => {
    if (fullScheduled) return;
    fullScheduled = true;
    queueMicrotask(() => {
      fullScheduled = false;
      if (!destroyed) view.dispatch({ effects: setSuggestionItems.of(resolveAll(config, view.state.doc.length)) });
    });
  };
  const patch = () => {
    if (patchScheduled) return;
    patchScheduled = true;
    queueMicrotask(() => {
      patchScheduled = false;
      if (destroyed || !pending.size) return;
      const ids = [...pending];
      pending.clear();
      const items = ids.flatMap((id) => {
        const record = map.get(id);
        return record && (record.status === "pending" || record.status === "stale") ? [toViewSuggestion(resolveSuggestion(config.ytext, record))] : [];
      }).filter((item) => item.to <= view.state.doc.length);
      if (items.length) view.dispatch({ effects: patchSuggestionItems.of(items) });
    });
  };
  const observer = () => refreshAll();
  map.observe(observer);
  return {
    update(update) {
      const touched = update.state.field(suggestionsField).touched;
      if (!touched.length) return;
      for (const id of touched) pending.add(id);
      patch();
    },
    destroy() {
      destroyed = true;
      map.unobserve(observer);
    },
  };
});

const theme = EditorView.baseTheme({
  ".cm-collab-suggestion-deleted": {
    textDecoration: "line-through",
    textDecorationColor: "color-mix(in srgb, var(--change-del, #d14343) 75%, transparent)",
    backgroundColor: "color-mix(in srgb, var(--change-del, #d14343) 14%, transparent)",
    boxShadow: "inset 0 -2px 0 var(--collab-author, transparent)",
    borderRadius: "2px",
  },
  ".cm-collab-suggestion-inserted": {
    backgroundColor: "color-mix(in srgb, var(--change-add, #2f9e44) 20%, transparent)",
    borderBottom: "2px solid var(--collab-author, var(--change-add, #2f9e44))",
    borderRadius: "2px",
    whiteSpace: "pre-wrap",
  },
  ".cm-collab-suggestion-inserted[contenteditable=true]": { outline: "none", cursor: "text" },
  ".cm-collab-suggestion-inserted-block": { display: "block", paddingInline: "6px 20px", boxShadow: "inset 3px 0 0 var(--change-add, #2f9e44)", borderRadius: "0" },
  ".cm-collab-suggestion-stale": {
    textDecorationStyle: "dashed",
    backgroundColor: "color-mix(in srgb, #d08700 14%, transparent)",
    outline: "1px dashed color-mix(in srgb, #d08700 70%, transparent)",
  },
  ".cm-collab-suggestion-actions": {
    display: "inline-flex",
    gap: "2px",
    alignItems: "center",
    marginInlineStart: "4px",
    fontSize: "0.75em",
    verticalAlign: "baseline",
  },
  ".cm-collab-suggestion-label": {
    padding: "0 5px",
    borderRadius: "999px",
    color: "white",
    backgroundColor: "var(--collab-author, #6b7280)",
    whiteSpace: "nowrap",
  },
  ".cm-collab-suggestion-actions button": { font: "inherit", padding: "0 5px", borderRadius: "4px", border: "1px solid currentColor", background: "transparent", cursor: "pointer" },
  ".cm-collab-suggestion-accept": { color: "var(--change-add, #2f9e44)" },
  ".cm-collab-suggestion-reject": { color: "var(--change-del, #d14343)" },
});

/** Renders the overlay suggestions of `annotations` over `ytext` in this editor. */
export function suggestionPreview(options: SuggestionPreviewOptions): Extension {
  return [previewConfig.of(options), suggestionsField, refresher, theme];
}

/* ---- Stepping -------------------------------------------------------------------- */

function reveal(view: EditorView, group: SuggestionGroupRef) {
  const from = group.suggestions[0].from;
  view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
  return group;
}

/** Moves the cursor to the next group after it (wrapping), and returns that group. */
export function nextSuggestion(view: EditorView, wrap = true): SuggestionGroupRef | null {
  const groups = previewGroups(view.state);
  if (!groups.length) return null;
  const head = view.state.selection.main.head;
  const next = groups.find((group) => group.suggestions[0].from > head) ?? (wrap ? groups[0] : null);
  return next ? reveal(view, next) : null;
}

/** Moves the cursor to the previous group before it (wrapping), and returns that group. */
export function previousSuggestion(view: EditorView, wrap = true): SuggestionGroupRef | null {
  const groups = previewGroups(view.state);
  if (!groups.length) return null;
  const head = view.state.selection.main.head;
  const previous = [...groups].reverse().find((group) => group.suggestions[0].from < head) ?? (wrap ? groups.at(-1)! : null);
  return previous ? reveal(view, previous) : null;
}
