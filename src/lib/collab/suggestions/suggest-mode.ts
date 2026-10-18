// Suggest mode for CodeMirror (plan M3.2).
//
// A transaction filter turns the user's text changes into overlay suggestion
// operations, so the content Y.Text is never touched: the filtered
// transaction keeps its selection and effects but loses its changes, so
// y-codemirror.next has nothing to sync. The operations travel as an effect
// and are written to the annotations doc after the update, because a filter
// must not have side effects (CodeMirror may build transactions it never
// dispatches).
//
// - Typing at a point creates an insertion; typing again at the same point
//   (or right after your own suggestion) extends its replacement.
// - Backspace right after your own suggestion's text trims that text.
// - Deleting or typing over text suggests deleting or replacing it; deleting
//   next to your own suggestion grows it.
// - Your own pending replacements can be edited in place (the preview
//   extension makes them editable while suggest mode is on).
//
// Remote changes and Y undo/redo (both dispatched by ySync) pass untouched.

import { Annotation, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";
import * as Y from "yjs";
import { actorAccountId, type Actor } from "../protocol/actor";
import type { SuggestionRecord } from "../protocol/schema";
import { relativeRange } from "../anchors";
import { aiEditAnnotation } from "../bindings/codemirror";
import { inlineReplacementEditing } from "./codemirror";
import { buildSuggestion, listSuggestions, newSuggestionId, resolveSuggestion, suggestionsMap, type ResolvedSuggestion, type SuggestionsTarget } from "./model";

/** Let one transaction change content directly even in suggest mode (editors only; the server still checks roles). */
export const bypassSuggestMode = Annotation.define<boolean>();

export type SuggestOp =
  | { kind: "create"; start: number; end: number; replacement: string; actor: Actor; groupId?: string }
  | { kind: "replace"; id: string; replacement: string }
  | { kind: "rerange"; id: string; start: number; end: number; replacement: string }
  | { kind: "discard"; id: string };

const suggestOps = StateEffect.define<SuggestOp[]>();
const setSuggestModeEffect = StateEffect.define<boolean>();

export interface SuggestModeOptions {
  ytext: Y.Text;
  annotations: SuggestionsTarget;
  /** The local user (AI edits are attributed to an AI actor acting for them). */
  actor: Extract<Actor, { kind: "user" }>;
  enabled?: boolean;
  /** Always on, whatever `setEnabled` says: a commenter's editor. */
  forced?: boolean;
  makeId?: () => string;
  now?: () => number;
}

export interface SuggestMode {
  extension: Extension;
  setEnabled(view: EditorView, enabled: boolean): void;
  isEnabled(state: EditorState): boolean;
  /** Undoes this editor's suggestion operations (not content edits). */
  undoManager: Y.UndoManager;
  /** Origin of the annotations transactions suggest mode writes. */
  origin: object;
  destroy(): void;
}

function codeUnitsOfLastChar(text: string) {
  const code = text.charCodeAt(text.length - 1);
  return text.length > 1 && code >= 0xdc00 && code <= 0xdfff ? 2 : 1;
}

/**
 * Plans the overlay operations for a transaction's changes, against the
 * suggestions `own` (the local user's pending, non-stale ones). Exported for
 * tests and for callers that want the same behaviour outside CodeMirror.
 */
export function planSuggestOps(
  changes: readonly { from: number; to: number; insert: string }[],
  own: readonly ResolvedSuggestion[],
  context: { actor: Actor; forward: boolean; ai: boolean; groupId?: string; preferId?: string | null },
): { ops: SuggestOp[]; cursor: number | null } {
  const ops: SuggestOp[] = [];
  // Suggestions as they will be after the planned ops, by id.
  const live = new Map(own.map((item) => [item.record.id, { start: item.start, end: item.end, replacement: item.record.replacement }]));
  let cursor: number | null = null;
  // Several of your suggestions can touch one position (an insertion right
  // after a replacement, say); the one you edited last wins, then the newest.
  const owned = () => {
    const list = [...live.entries()].map(([id, value]) => ({ id, ...value }));
    const preferred = list.findIndex((item) => item.id === context.preferId);
    if (preferred >= 0) list.push(...list.splice(preferred, 1));
    return list;
  };
  for (const change of changes) {
    const { from, to, insert } = change;
    if (context.ai) {
      ops.push({ kind: "create", start: from, end: to, replacement: insert, actor: context.actor, groupId: context.groupId });
      cursor = to;
      continue;
    }
    if (from === to) {
      // Typing at a point: continue your own suggestion that ends here.
      const target = owned().filter((item) => item.end === from).at(-1);
      if (target) {
        target.replacement += insert;
        live.set(target.id, target);
        ops.push({ kind: "replace", id: target.id, replacement: target.replacement });
      } else ops.push({ kind: "create", start: from, end: from, replacement: insert, actor: context.actor });
      cursor = from;
      continue;
    }
    if (!insert) {
      // Backspace right after your own suggested text trims that text.
      const trim = owned().filter((item) => item.end === to && item.replacement && to - from === 1 && !context.forward).at(-1);
      if (trim) {
        trim.replacement = trim.replacement.slice(0, trim.replacement.length - codeUnitsOfLastChar(trim.replacement));
        if (!trim.replacement && trim.start === trim.end) {
          live.delete(trim.id);
          ops.push({ kind: "discard", id: trim.id });
        } else {
          live.set(trim.id, trim);
          ops.push({ kind: "replace", id: trim.id, replacement: trim.replacement });
        }
        cursor = to;
        continue;
      }
      // Deleting next to (or over) your own suggestion grows it.
      const candidates = owned().filter((item) => item.start <= to && item.end >= from);
      const grow = candidates.filter((item) => item.start < item.end).at(-1) ?? candidates.at(-1);
      if (grow) {
        const start = Math.min(grow.start, from);
        const end = Math.max(grow.end, to);
        live.set(grow.id, { ...grow, start, end });
        ops.push({ kind: "rerange", id: grow.id, start, end, replacement: grow.replacement });
        cursor = from < grow.start ? start : end;
        continue;
      }
      ops.push({ kind: "create", start: from, end: to, replacement: "", actor: context.actor });
      cursor = context.forward ? to : from;
      continue;
    }
    // Typing over a selection suggests replacing it.
    const same = owned().find((item) => item.start === from && item.end === to);
    if (same) {
      same.replacement = insert;
      live.set(same.id, same);
      ops.push({ kind: "replace", id: same.id, replacement: insert });
    } else ops.push({ kind: "create", start: from, end: to, replacement: insert, actor: context.actor });
    cursor = to;
  }
  return { ops, cursor: changes.length === 1 ? cursor : null };
}

export function suggestMode(options: SuggestModeOptions): SuggestMode {
  const { ytext, actor } = options;
  const createdBy = options.actor.userId;
  const map = suggestionsMap(options.annotations);
  if (!map.doc) throw new Error("The suggestions map must belong to a Y.Doc.");
  const origin = { suggestMode: createdBy };
  const undoManager = new Y.UndoManager(map, { trackedOrigins: new Set([origin]) });
  const now = options.now ?? Date.now;
  const forced = !!options.forced;
  // The suggestion this editor wrote last, preferred when typing continues.
  let lastTouched: string | null = null;

  const enabledField = StateField.define<boolean>({
    create: () => forced || !!options.enabled,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setSuggestModeEffect)) value = forced || effect.value;
      return value;
    },
  });

  const ownPending = (): ResolvedSuggestion[] => listSuggestions(map, { status: "pending", createdBy })
    .filter((record) => record.actor.kind === "user")
    .map((record) => resolveSuggestion(ytext, record))
    .filter((item) => !item.isStale);

  const filter = EditorState.transactionFilter.of((tr): Transaction | TransactionSpec => {
    if (!tr.docChanged || !tr.startState.field(enabledField)) return tr;
    if (tr.annotation(ySyncAnnotation) !== undefined || tr.annotation(bypassSuggestMode)) return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from, to, insert: inserted.toString() }));
    const ai = tr.annotation(aiEditAnnotation);
    const aiActor: Actor | null = ai ? { kind: "ai", onBehalfOf: actorAccountId(actor)!, clientId: actor.clientId, feature: ai.feature, model: ai.model, runId: ai.runId } : null;
    const plan = planSuggestOps(changes, ai ? [] : ownPending(), {
      actor: aiActor ?? actor,
      forward: tr.isUserEvent("delete.forward"),
      ai: !!ai,
      groupId: ai?.runId,
      preferId: lastTouched,
    });
    const selection = plan.cursor === null ? tr.startState.selection : EditorSelection.cursor(Math.min(plan.cursor, tr.startState.doc.length));
    const userEvent = tr.annotation(Transaction.userEvent);
    return {
      selection,
      effects: [...tr.effects, suggestOps.of(plan.ops)],
      scrollIntoView: tr.scrollIntoView,
      annotations: userEvent ? Transaction.userEvent.of(userEvent) : undefined,
    };
  });

  const apply = (ops: SuggestOp[]) => {
    if (!ops.length) return;
    map.doc!.transact(() => {
      for (const op of ops) {
        if (op.kind === "create") {
          const record = buildSuggestion({ ytext, start: op.start, end: op.end, replacement: op.replacement, actor: op.actor, createdBy, id: options.makeId?.() ?? newSuggestionId(), groupId: op.groupId, now: now() });
          map.set(record.id, record);
          lastTouched = record.id;
          continue;
        }
        const record = map.get(op.id) as SuggestionRecord | undefined;
        if (!record || record.createdBy !== createdBy || record.status !== "pending") continue;
        lastTouched = op.kind === "discard" ? null : op.id;
        if (op.kind === "discard") map.delete(op.id);
        else if (op.kind === "replace") map.set(op.id, { ...record, replacement: op.replacement, updatedAt: now() });
        else {
          const range = relativeRange(ytext, op.start, op.end);
          map.set(op.id, { ...record, start: range.start, end: range.end, baseQuote: ytext.toString().slice(op.start, op.end), replacement: op.replacement, updatedAt: now() });
        }
      }
    }, origin);
  };

  const writer = ViewPlugin.define(() => ({
    update(update: ViewUpdate) {
      for (const tr of update.transactions) for (const effect of tr.effects) if (effect.is(suggestOps)) apply(effect.value);
    },
  }));

  // While suggesting, Undo first steps back through your suggestion edits.
  const undoKeys = Prec.highest(keymap.of([
    { key: "Mod-z", run: (view) => view.state.field(enabledField) && undoManager.undoStack.length > 0 && !!undoManager.undo() },
    { key: "Mod-y", mac: "Mod-Shift-z", run: (view) => view.state.field(enabledField) && undoManager.redoStack.length > 0 && !!undoManager.redo() },
  ]));

  return {
    extension: [
      enabledField,
      filter,
      writer,
      undoKeys,
      inlineReplacementEditing.compute([enabledField], (state) => state.field(enabledField)),
      EditorView.editorAttributes.compute([enabledField], (state) => (state.field(enabledField) ? { class: "cm-collab-suggesting" } : ({} as Record<string, string>))),
    ],
    setEnabled(view, enabled) {
      if (view.state.field(enabledField) !== (forced || enabled)) view.dispatch({ effects: setSuggestModeEffect.of(enabled) });
    },
    isEnabled: (state) => state.field(enabledField, false) ?? false,
    undoManager,
    origin,
    destroy() { undoManager.destroy(); },
  };
}
