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
//
// IME composition cannot be filtered keystroke by keystroke: the browser owns
// the DOM text until the composition ends, and dropping its changes would
// leave CodeMirror's document and the DOM disagreeing (the IME then commits
// garbage). So composition input is applied to the editor only, never to
// the Y.Text (it is tagged as a ySync transaction, which ySync does not echo),
// and held as one change set. When the composition ends the held text is
// rolled back and converted into suggestions in one step. Remote changes that
// arrive meanwhile come in Y offsets, so they are moved over the held text.

import { Annotation, ChangeSet, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type ChangeSpec, type Extension, type Text, type TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { ySyncAnnotation, ySyncFacet } from "y-codemirror.next";
import * as Y from "yjs";
import { actorAccountId, type Actor } from "../protocol/actor";
import type { SuggestionRecord } from "../protocol/schema";
import { relativeRange } from "../anchors";
import { aiEditAnnotation, collabSuggestOnly } from "../bindings/codemirror";
import { inlineReplacementEditing } from "./codemirror";
import { buildSuggestion, listSuggestions, newSuggestionId, resolveSuggestion, suggestionsMap, type ResolvedSuggestion, type SuggestionsTarget } from "./model";

/**
 * Let one transaction change content directly even in suggest mode (editors
 * only; the server still checks roles). Ignored while suggest mode is forced.
 */
export const bypassSuggestMode = Annotation.define<boolean>();

export type SuggestOp =
  | { kind: "create"; start: number; end: number; replacement: string; actor: Actor; groupId?: string }
  | { kind: "replace"; id: string; replacement: string }
  | { kind: "rerange"; id: string; start: number; end: number; replacement: string }
  | { kind: "discard"; id: string };

const suggestOps = StateEffect.define<SuggestOp[]>();
const setSuggestModeEffect = StateEffect.define<boolean>();
const setForcedEffect = StateEffect.define<boolean>();

/** Composition text applied to the editor but not to the Y.Text: `changes` turn `base` (the Y.Text's text) into the editor's document. */
interface HeldComposition {
  changes: ChangeSet;
  base: Text;
}
const setHeldComposition = StateEffect.define<HeldComposition | null>();
const flushComposition = StateEffect.define<null>();

/** How long after compositionend to wait for the browser's last composition change (CodeMirror flushes it in a microtask, Android later). */
const COMPOSITION_SETTLE_MS = 40;

export interface SuggestModeOptions {
  ytext: Y.Text;
  annotations: SuggestionsTarget;
  /** The local user (AI edits are attributed to an AI actor acting for them). */
  actor: Extract<Actor, { kind: "user" }>;
  enabled?: boolean;
  /**
   * Always on, whatever `setEnabled` says: a commenter's editor. Forced
   * suggest mode also lets input through a read-only collab binding
   * (`collabSuggestOnly`), since the input never reaches the content.
   */
  forced?: boolean;
  makeId?: () => string;
  now?: () => number;
}

export interface SuggestMode {
  extension: Extension;
  setEnabled(view: EditorView, enabled: boolean): void;
  /** Changes whether the mode is forced (the role changed between commenter and editor). */
  setForced(view: EditorView, forced: boolean): void;
  isEnabled(state: EditorState): boolean;
  isForced(state: EditorState): boolean;
  /** Converts held composition text now (tests, and editors that lose focus mid-composition). */
  flushComposition(view: EditorView): void;
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

function changeList(changes: ChangeSet): { from: number; to: number; insert: string }[] {
  const list: { from: number; to: number; insert: string }[] = [];
  changes.iterChanges((from, to, _fromB, _toB, inserted) => list.push({ from, to, insert: inserted.toString() }));
  return list;
}

export function suggestMode(options: SuggestModeOptions): SuggestMode {
  const { ytext, actor } = options;
  const createdBy = options.actor.userId;
  const map = suggestionsMap(options.annotations);
  if (!map.doc) throw new Error("The suggestions map must belong to a Y.Doc.");
  const origin = { suggestMode: createdBy };
  const undoManager = new Y.UndoManager(map, { trackedOrigins: new Set([origin]) });
  const now = options.now ?? Date.now;
  // The suggestion this editor wrote last, preferred when typing continues.
  let lastTouched: string | null = null;

  const enabledField = StateField.define<boolean>({
    create: () => !!options.enabled,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setSuggestModeEffect)) value = effect.value;
      return value;
    },
  });
  const forcedField = StateField.define<boolean>({
    create: () => !!options.forced,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setForcedEffect)) value = effect.value;
      return value;
    },
  });
  const heldField = StateField.define<HeldComposition | null>({
    create: () => null,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setHeldComposition)) value = effect.value;
      return value;
    },
  });
  const active = (state: EditorState) => state.field(enabledField) || state.field(forcedField);

  const ownPending = (): ResolvedSuggestion[] => listSuggestions(map, { status: "pending", createdBy })
    .filter((record) => record.actor.kind === "user")
    .map((record) => resolveSuggestion(ytext, record))
    .filter((item) => !item.isStale);

  /** Marks a transaction so ySync does not write it to the Y.Text (composition text and its rollback). */
  const localOnly = (state: EditorState) => {
    const conf = state.facet(ySyncFacet);
    return conf ? [ySyncAnnotation.of(conf)] : [];
  };

  /**
   * ySync built a remote change from Y offsets, which do not count the held
   * composition text. Re-read it against the held base and move it over the
   * held text (and the held text over it).
   */
  const remapRemote = (tr: Transaction, held: HeldComposition): TransactionSpec => {
    const specs: ChangeSpec[] = changeList(tr.changes);
    const remote = ChangeSet.of(specs, held.base.length);
    const local = remote.map(held.changes);
    const next: HeldComposition = { changes: held.changes.map(remote, true), base: remote.apply(held.base) };
    const sync = tr.annotation(ySyncAnnotation);
    return {
      changes: local,
      effects: [...tr.effects, setHeldComposition.of(next)],
      annotations: sync === undefined ? [] : [ySyncAnnotation.of(sync)],
    };
  };

  const filter = EditorState.transactionFilter.of((tr): Transaction | TransactionSpec => {
    const start = tr.startState;
    const held = start.field(heldField);
    const flushing = tr.effects.some((effect) => effect.is(flushComposition));
    if (!held && (!tr.docChanged || !active(start))) return tr;
    if (tr.annotation(ySyncAnnotation) !== undefined) return held && tr.docChanged ? remapRemote(tr, held) : tr;
    if (!tr.docChanged && !flushing) return tr;
    if (!held && tr.annotation(bypassSuggestMode) && !start.field(forcedField)) return tr;
    const userEvent = tr.annotation(Transaction.userEvent);

    if (tr.docChanged && tr.isUserEvent("input.type.compose")) {
      // Mid-composition: keep the browser's text in the editor only.
      const changes = held ? held.changes.compose(tr.changes) : tr.changes;
      const base = held?.base ?? start.doc;
      return {
        changes: tr.changes,
        selection: tr.selection,
        effects: [...tr.effects, setHeldComposition.of({ changes, base })],
        annotations: [...localOnly(start), ...(userEvent ? [Transaction.userEvent.of(userEvent)] : [])],
        scrollIntoView: tr.scrollIntoView,
      };
    }

    // Changes relative to the Y.Text: the held composition (if any) plus this
    // transaction's own, which are relative to the editor's document.
    const combined = held ? (tr.docChanged ? held.changes.compose(tr.changes) : held.changes) : tr.changes;
    const rollback = held ? held.changes.invert(held.base) : null;
    const ai = tr.annotation(aiEditAnnotation);
    const aiActor: Actor | null = ai ? { kind: "ai", onBehalfOf: actorAccountId(actor)!, clientId: actor.clientId, feature: ai.feature, model: ai.model, runId: ai.runId } : null;
    const plan = planSuggestOps(changeList(combined), ai ? [] : ownPending(), {
      actor: aiActor ?? actor,
      forward: tr.isUserEvent("delete.forward"),
      ai: !!ai,
      groupId: ai?.runId,
      preferId: lastTouched,
    });
    const docLength = held ? held.base.length : start.doc.length;
    const selection = plan.cursor === null
      ? (rollback ? start.selection.map(rollback) : start.selection)
      : EditorSelection.cursor(Math.min(plan.cursor, docLength));
    return {
      ...(rollback ? { changes: rollback } : {}),
      selection,
      effects: [...tr.effects.filter((effect) => !effect.is(flushComposition)), suggestOps.of(plan.ops), ...(held ? [setHeldComposition.of(null)] : [])],
      scrollIntoView: tr.scrollIntoView,
      annotations: [...(rollback ? localOnly(start) : []), ...(userEvent ? [Transaction.userEvent.of(userEvent)] : [])],
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

  const flushNow = (view: EditorView) => {
    if (view.state.field(heldField, false)) view.dispatch({ effects: flushComposition.of(null), userEvent: "input.type" });
  };

  const writer = ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onCompositionEnd = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // A new composition started meanwhile: its own end flushes both.
        if (!view.composing) flushNow(view);
      }, COMPOSITION_SETTLE_MS);
    };
    view.contentDOM.addEventListener("compositionend", onCompositionEnd);
    return {
      update(update: ViewUpdate) {
        for (const tr of update.transactions) for (const effect of tr.effects) if (effect.is(suggestOps)) apply(effect.value);
      },
      destroy() {
        if (timer) clearTimeout(timer);
        view.contentDOM.removeEventListener("compositionend", onCompositionEnd);
      },
    };
  });

  // While suggesting, Undo first steps back through your suggestion edits.
  const undoKeys = Prec.highest(keymap.of([
    { key: "Mod-z", run: (view) => active(view.state) && undoManager.undoStack.length > 0 && !!undoManager.undo() },
    { key: "Mod-y", mac: "Mod-Shift-z", run: (view) => active(view.state) && undoManager.redoStack.length > 0 && !!undoManager.redo() },
  ]));

  return {
    extension: [
      enabledField,
      forcedField,
      heldField,
      filter,
      writer,
      undoKeys,
      inlineReplacementEditing.compute([enabledField, forcedField], (state) => active(state)),
      collabSuggestOnly.compute([forcedField], (state) => state.field(forcedField)),
      EditorView.editorAttributes.compute([enabledField, forcedField], (state) => (active(state) ? { class: "cm-collab-suggesting" } : ({} as Record<string, string>))),
    ],
    setEnabled(view, enabled) {
      if (view.state.field(enabledField) !== enabled) view.dispatch({ effects: setSuggestModeEffect.of(enabled) });
    },
    setForced(view, forced) {
      if (view.state.field(forcedField) !== forced) view.dispatch({ effects: setForcedEffect.of(forced) });
    },
    isEnabled: (state) => (state.field(enabledField, false) ?? false) || (state.field(forcedField, false) ?? false),
    isForced: (state) => state.field(forcedField, false) ?? false,
    flushComposition: flushNow,
    undoManager,
    origin,
    destroy() { undoManager.destroy(); },
  };
}
