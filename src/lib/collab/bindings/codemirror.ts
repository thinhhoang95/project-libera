// CodeMirror ↔ Y.Text binding for shared Source and LaTeX tabs (map §7.1,
// plan M1.4 and M1.11).
//
// Built on y-codemirror.next without forking it. Its ySync plugin applies each
// CodeMirror update to the Y.Text in one `doc.transact(fn, conf)` call whose
// origin is the YSyncConfig found in `ySyncFacet` (the facet keeps the last
// value). We provide our own YSyncConfig subclass through that facet, so every
// Y transaction the binding produces has an origin we own. A plugin that runs
// before ySync reads the CodeMirror `userEvent` / annotations of the update and
// stores the provenance on the config, and a `beforeTransaction` listener
// copies it into `transaction.meta`, so the replica can read an immutable
// provenance for each update even when it batches them later.

import { Annotation, EditorSelection, EditorState, Facet, Prec, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { yCollab, ySyncAnnotation, ySyncFacet, YSyncConfig } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { AI_FEATURES, type AiFeature, type Provenance } from "../protocol/actor";
import type { SyncState } from "../protocol/local";
import { SyncLimits } from "../protocol/version";
import { setLocalUser, type CollabUser } from "../awareness";

/** Key under which the binding stores a transaction's Provenance in `Y.Transaction.meta`. */
export const PROVENANCE_META_KEY = "libera:provenance";

/** Marks a CodeMirror transaction as an AI edit. */
export interface AiEditHint {
  feature: AiFeature;
  model?: string;
  runId?: string;
}

/** Annotate a CodeMirror transaction produced by an AI feature. */
export const aiEditAnnotation = Annotation.define<AiEditHint>();
/** Annotate a CodeMirror transaction with an explicit provenance (restore, external-file, …). */
export const provenanceAnnotation = Annotation.define<Provenance>();

/** The transaction origin of every Y transaction one binding produces. */
export class ProvenanceSyncConfig extends YSyncConfig {
  /** Provenance of the Y transaction ySync is about to run (or just ran). */
  current: Provenance = { source: "typing" };
  /** One-shot override set through `setNextProvenance`. */
  next: Provenance | null = null;
  constructor(ytext: Y.Text, awareness: Awareness | null, readonly undoManager: Y.UndoManager) {
    super(ytext, awareness);
  }
}

// Undo managers created by bindings, so their transactions read as "undo".
const bindingUndoManagers = new WeakSet<Y.UndoManager>();

/**
 * The provenance stored with a Y transaction produced by a binding, or null
 * for transactions the binding did not produce (remote, hub, other code).
 * Prefer this over `provenanceForOrigin`: it is fixed per transaction.
 */
export function provenanceForTransaction(transaction: Y.Transaction): Provenance | null {
  const stored = transaction.meta.get(PROVENANCE_META_KEY) as Provenance | undefined;
  return stored ?? provenanceForOrigin(transaction.origin);
}

/**
 * The provenance for a transaction origin. Only valid synchronously inside
 * the transaction's events (`update`, `afterTransaction`), because the
 * binding reuses one origin object for all of its transactions.
 */
export function provenanceForOrigin(origin: unknown): Provenance | null {
  if (origin instanceof ProvenanceSyncConfig) return { ...origin.current };
  if (origin instanceof Y.UndoManager && bindingUndoManagers.has(origin)) return { source: "undo" };
  return null;
}

/** Whether an origin belongs to a local editor binding (as opposed to the hub or a remote peer). */
export function isLocalBindingOrigin(origin: unknown): boolean {
  return origin instanceof ProvenanceSyncConfig || (origin instanceof Y.UndoManager && bindingUndoManagers.has(origin));
}

const AI_USER_EVENT = /^input\.ai\.(.+)$/;

/** Derives a provenance from the CodeMirror transactions of one view update. */
export function provenanceForTransactions(transactions: readonly Transaction[]): Provenance {
  let result: Provenance | null = null;
  const rank = (p: Provenance) => (p.source === "ai" ? 3 : p.source === "paste" ? 2 : p.source === "typing" ? 0 : 1);
  for (const tr of transactions) {
    if (!tr.docChanged) continue;
    const candidate = provenanceForTransaction_(tr);
    if (!result || rank(candidate) > rank(result)) result = candidate;
  }
  return result ?? { source: "typing" };
}

function provenanceForTransaction_(tr: Transaction): Provenance {
  const explicit = tr.annotation(provenanceAnnotation);
  if (explicit) return explicit;
  const ai = tr.annotation(aiEditAnnotation);
  if (ai) return { source: "ai", feature: ai.feature, model: ai.model, runId: ai.runId };
  const event = tr.annotation(Transaction.userEvent) ?? "";
  // latex/codemirror/review.ts tags AI proposals as `input.ai.<feature>` and
  // rejections as `input.ai.reject`; rejecting is the user undoing the AI.
  const match = AI_USER_EVENT.exec(event);
  if (match) {
    if (match[1] === "reject") return { source: "undo" };
    const feature = match[1].split(".")[0] as AiFeature;
    return AI_FEATURES.includes(feature) ? { source: "ai", feature } : { source: "ai" };
  }
  if (tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop")) return { source: "paste" };
  if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return { source: "undo" };
  return { source: "typing" };
}

/* ---- Read-only ------------------------------------------------------------ */

export const setCollabReadOnly = StateEffect.define<boolean>();

/**
 * Provided by forced suggest mode (a commenter's editor, plan M3.2). The
 * content stays read-only, but input must still reach suggest mode's
 * transaction filter, which turns it into overlay suggestions and drops the
 * content change: change filters run before transaction filters, so a
 * read-only change filter would discard the typing first.
 */
export const collabSuggestOnly = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

/** Whether the binding currently refuses local edits (viewer, newer schema, access changed). */
export const collabReadOnlyField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setCollabReadOnly)) value = effect.value;
    return value;
  },
  provide: (field) => [
    EditorState.readOnly.compute([field, collabSuggestOnly], (state) => state.field(field) && !state.facet(collabSuggestOnly)),
    // EditorState.readOnly only stops user input; programmatic dispatches (AI
    // actions, toolbar commands) also have to be refused. Remote changes from
    // ySync always pass.
    EditorState.changeFilter.from(field, (readOnly) => (tr: Transaction) => !readOnly || tr.annotation(ySyncAnnotation) !== undefined || tr.startState.facet(collabSuggestOnly)),
  ],
});

/** Sync states in which the editor must not produce content edits. */
export function isReadOnlySyncState(state: SyncState): boolean {
  return state === "read-only" || state === "access-changed";
}

/* ---- Large pastes ----------------------------------------------------------- */

/** UTF-8 byte length of a string, without allocating an encoded copy. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

/**
 * Splits `text` into pieces of at most `maxBytes` UTF-8 bytes (one Yjs
 * update each, so no update outgrows a sync batch). Pieces end at a line
 * break when one is in the second half of the piece, and never split a
 * surrogate pair. Joining the pieces gives `text` back.
 */
export function splitLargeInsert(text: string, maxBytes: number = SyncLimits.batchMaxBytes): string[] {
  if (maxBytes < 4) throw new Error("maxBytes must allow at least one character.");
  if (utf8Length(text) <= maxBytes) return text ? [text] : [];
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let bytes = 0;
    let index = start;
    let lastBreak = -1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      const pair = code >= 0xd800 && code <= 0xdbff && index + 1 < text.length;
      const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
      if (bytes + size > maxBytes) break;
      bytes += size;
      index += pair ? 2 : 1;
      if (code === 10) lastBreak = index;
    }
    const end = index < text.length && lastBreak > start && lastBreak - start >= (index - start) / 2 ? lastBreak : index;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/**
 * Replaces the main selection with `text`, one CodeMirror transaction per
 * `splitLargeInsert` piece, so the binding sends several bounded Yjs updates.
 * The pieces land within the undo manager's capture window, so they still
 * undo as one step.
 */
export function insertLargeText(view: EditorView, text: string, options: { userEvent?: string; maxBytes?: number; annotations?: Annotation<unknown>[] } = {}) {
  const pieces = splitLargeInsert(text, options.maxBytes);
  const { from, to } = view.state.selection.main;
  let pos = from;
  pieces.forEach((piece, index) => {
    view.dispatch({
      changes: { from: pos, to: index === 0 ? to : pos, insert: piece },
      selection: EditorSelection.cursor(pos + piece.length),
      userEvent: options.userEvent ?? "input.paste",
      annotations: options.annotations,
      scrollIntoView: index === pieces.length - 1,
    });
    pos += piece.length;
  });
  if (!pieces.length && from !== to) view.dispatch({ changes: { from, to }, userEvent: options.userEvent ?? "input.paste" });
  return pieces.length;
}

/* ---- The extension ---------------------------------------------------------- */

export interface CollabExtensionOptions {
  ytext: Y.Text;
  awareness: Awareness | null;
  /** Reuse an undo manager (for example one kept by the tab registry across remounts). */
  undoManager?: Y.UndoManager;
  user: CollabUser;
  readOnly?: boolean;
  /** Pastes above this many UTF-8 bytes are split (default SyncLimits.batchMaxBytes). */
  maxPasteBytes?: number;
}

export interface CollabBinding {
  extension: Extension;
  undoManager: Y.UndoManager;
  /** The origin of every Y transaction this binding produces. */
  origin: ProvenanceSyncConfig;
  /** Use `provenance` for the next local edit only (e.g. an external-file or restore edit). */
  setNextProvenance(provenance: Provenance): void;
  setReadOnly(view: EditorView, readOnly: boolean): void;
  /** Applies a hub sync state: read-only and access-changed stop local edits. */
  applySyncState(view: EditorView, state: SyncState): void;
  destroy(): void;
}

/** Undo/redo keys bound to the Y.UndoManager. Higher precedence than any
 * `history()` keymap, which must not be used on shared tabs. */
function undoKeymap(undoManager: Y.UndoManager): Extension {
  const undo = () => { undoManager.undo(); return true; };
  const redo = () => { undoManager.redo(); return true; };
  return Prec.highest(keymap.of([
    { key: "Mod-z", run: undo, preventDefault: true },
    { key: "Mod-y", mac: "Mod-Shift-z", run: redo, preventDefault: true },
    { key: "Mod-Shift-z", run: redo, preventDefault: true },
  ]));
}

export function collabExtension(options: CollabExtensionOptions): CollabBinding {
  const { ytext, awareness, user } = options;
  const doc = ytext.doc;
  if (!doc) throw new Error("The Y.Text must belong to a Y.Doc.");
  const ownsUndoManager = !options.undoManager;
  // Scoped to this binding's origin only: remote, hub and other local
  // origins are never undone by this editor's Undo (source plan §6.6).
  const undoManager = options.undoManager ?? new Y.UndoManager(ytext, { trackedOrigins: new Set() });
  bindingUndoManagers.add(undoManager);
  const config = new ProvenanceSyncConfig(ytext, awareness, undoManager);
  undoManager.addTrackedOrigin(config);
  if (awareness) setLocalUser(awareness, user);

  let lastSource: Provenance["source"] | null = null;
  const stamp = (transaction: Y.Transaction) => {
    if (transaction.origin === config) transaction.meta.set(PROVENANCE_META_KEY, { ...config.current });
    else if (transaction.origin === undoManager) transaction.meta.set(PROVENANCE_META_KEY, { source: "undo" } satisfies Provenance);
  };
  doc.on("beforeTransaction", stamp);

  // Runs before ySync (highest precedence) so `config.current` describes the
  // Y transaction ySync creates for this same update.
  const provenancePlugin = Prec.highest(ViewPlugin.define(() => ({
    update(update: ViewUpdate) {
      if (!update.docChanged || update.transactions.some((tr) => tr.annotation(ySyncAnnotation) !== undefined)) return;
      const provenance = config.next ?? provenanceForTransactions(update.transactions);
      config.next = null;
      config.current = provenance;
      // An AI edit is its own undo step, so Undo removes exactly the AI
      // result and nothing the user typed around it (plan M1.11).
      if (provenance.source === "ai" || (lastSource !== null && provenance.source !== lastSource)) undoManager.stopCapturing();
      lastSource = provenance.source;
    },
  })));

  const maxPasteBytes = options.maxPasteBytes ?? SyncLimits.batchMaxBytes;
  const pasteHandler = EditorView.domEventHandlers({
    paste(event, view) {
      const text = event.clipboardData?.getData("text/plain");
      if (!text || utf8Length(text) <= maxPasteBytes || view.state.readOnly) return false;
      event.preventDefault();
      insertLargeText(view, view.state.toText(text).toString(), { maxBytes: maxPasteBytes });
      return true;
    },
  });

  const extension: Extension = [
    provenancePlugin,
    undoKeymap(undoManager),
    yCollab(ytext, awareness, { undoManager }),
    // Replace the config yCollab created with ours (ySyncFacet keeps the last value).
    Prec.lowest(ySyncFacet.of(config)),
    collabReadOnlyField.init(() => !!options.readOnly),
    pasteHandler,
  ];

  const setReadOnly = (view: EditorView, readOnly: boolean) => {
    if (view.state.field(collabReadOnlyField, false) !== readOnly) view.dispatch({ effects: setCollabReadOnly.of(readOnly) });
  };
  return {
    extension,
    undoManager,
    origin: config,
    setNextProvenance(provenance) { config.next = provenance; },
    setReadOnly,
    applySyncState(view, state) { setReadOnly(view, isReadOnlySyncState(state) || !!options.readOnly); },
    destroy() {
      doc.off("beforeTransaction", stamp);
      undoManager.removeTrackedOrigin(config);
      if (ownsUndoManager) undoManager.destroy();
    },
  };
}

/** Dispatch an AI edit as one undo step tagged `source: "ai"`. */
export function dispatchAiEdit(view: EditorView, spec: { changes: { from: number; to?: number; insert?: string } | { from: number; to?: number; insert?: string }[]; selection?: EditorSelection | { anchor: number; head?: number } }, hint: AiEditHint) {
  view.dispatch({ ...spec, annotations: aiEditAnnotation.of(hint), userEvent: `input.ai.${hint.feature}` });
}
