// The Visual (Tiptap) editor on a shared tab (map §7.2, decision D1).
//
// The editor is created empty and the block bridge builds its document from
// the Y.Text, then keeps both in step; nothing on a shared tab calls
// `setContent` on the whole note. The editor calls `attach(editor)` once its
// Tiptap instance exists and `destroy()` when it goes, as the CodeMirror
// editors do with their bindings.
//
// The document's overlay suggestions (plan M3.1) show as preview tracked
// changes on their own channel of the changes plugin, so agentic review's
// previews and the collaborators' suggestions never replace each other.
// They are redrawn from the Y.Text only while the bridge is in step with it,
// since their offsets are Y.Text offsets.

import type { Editor } from "@tiptap/core";
import type { Provenance } from "../protocol/actor";
import { registerUndoScope, type SharedDocSession } from "../client/registry";
import type { CollabReplica } from "../client/replica";
import { suggestionsFor, type SuggestionsController } from "../client/suggestions";
import { listSuggestions, resolveSuggestions, suggestionsMap } from "../suggestions/model";
import { overlaySuggestionsToTrackedChanges } from "../suggestions/tiptap";
import { SUGGESTIONS_CHANNEL, tiptapChangesKey, type TiptapChangesMeta } from "@/lib/tiptap-changes";
import { bindTiptapToYText, type TiptapYTextBridge } from "./tiptap-ytext";

/** Suggestions from the Visual editor: "Suggest edit" and AI results on a shared tab. */
export interface SharedVisualSuggestions {
  readonly controller: SuggestionsController;
  /** Y.Text offsets of an editor range (local edits are flushed first). */
  sourceRange(range: { from: number; to: number }): { start: number; end: number };
  /** The shared text right now. */
  text(): string;
}

export interface SharedVisualHandle {
  readonly bridge: TiptapYTextBridge;
  readonly suggestions: SharedVisualSuggestions;
  /** The shared text right now (the Visual draft of a shared tab). */
  text(): string;
  /** Provenance for the next local change (Libera's own paste and image handlers). */
  setNextProvenance(provenance: Provenance): void;
  destroy(): void;
}

export interface SharedVisualSource {
  readonly docId: string;
  /** Bumps when the content sub-document is rebuilt; key the editor on it. */
  readonly generation: number;
  attach(editor: Editor): SharedVisualHandle;
}

const READ_ONLY_REASON = "This shared note is read-only for you.";
/** Typing settles (and reaches the Y.Text) before suggestions are redrawn over it. */
const REDRAW_MS = 120;

/** Keeps the editor's suggestion previews in step with the overlay; returns the cleanup. */
function showOverlaySuggestions(editor: Editor, bridge: TiptapYTextBridge, replica: CollabReplica, suggestions: SuggestionsController): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let dirty = true;
  let shown = false;
  const draw = () => {
    timer = null;
    if (destroyed || editor.isDestroyed) return;
    // Mid-typing the editor is ahead of the Y.Text; offsets would not match.
    if (!bridge.isSynced()) { retry(); return; }
    if (!dirty) return;
    dirty = false;
    const ytext = replica.ytext;
    const source = ytext.toString();
    const records = listSuggestions(replica.annotations, { status: "pending" });
    const decidable = suggestions.canDecide();
    const changes = records.length
      ? overlaySuggestionsToTrackedChanges(editor, source, resolveSuggestions(ytext, records), { author: suggestions.author, label: (record) => record.title ?? "" })
        .map((change) => ({ ...change, decidable }))
      : [];
    if (!changes.length && !shown) return;
    shown = changes.length > 0;
    const meta: TiptapChangesMeta = {
      type: "preview",
      channel: SUGGESTIONS_CHANNEL,
      changes,
      decide: (groups, decision) => { suggestions.decideGroups(groups, decision); },
    };
    editor.view.dispatch(editor.state.tr.setMeta(tiptapChangesKey, meta).setMeta("addToHistory", false));
  };
  const schedule = () => {
    dirty = true;
    if (timer || destroyed) return;
    timer = setTimeout(draw, REDRAW_MS);
  };
  const retry = () => {
    if (timer || destroyed) return;
    timer = setTimeout(draw, REDRAW_MS);
  };
  let map = suggestionsMap(replica.annotations);
  let ytext = replica.ytext;
  map.observe(schedule);
  ytext.observe(schedule);
  const offRebuild = replica.onRebuild(() => {
    map.unobserve(schedule);
    ytext.unobserve(schedule);
    map = suggestionsMap(replica.annotations);
    ytext = replica.ytext;
    map.observe(schedule);
    ytext.observe(schedule);
    schedule();
  });
  const offSuggestions = suggestions.subscribe(schedule);
  schedule();
  return () => {
    destroyed = true;
    if (timer) clearTimeout(timer);
    map.unobserve(schedule);
    ytext.unobserve(schedule);
    offRebuild();
    offSuggestions();
  };
}

export function sharedVisualSource(session: SharedDocSession, options: { onError?: (error: unknown) => void } = {}): SharedVisualSource {
  const { replica } = session;
  return {
    docId: session.docId,
    generation: replica.getSnapshot().generation,
    attach(editor) {
      const ytext = replica.ytext;
      const readOnlyReason = () => (replica.canEditContent() ? null : READ_ONLY_REASON);
      const bridge = bindTiptapToYText({
        editor,
        ytext,
        awareness: replica.awareness,
        readOnlyReason: readOnlyReason(),
        onError: options.onError,
      });
      // Role, schema and access changes arrive as replica snapshots.
      let last = readOnlyReason();
      const unsubscribe = replica.subscribe(() => {
        const next = readOnlyReason();
        if (next === last) return;
        last = next;
        bridge.setReadOnly(next);
      });
      // AI results, review applies and image insertions undo through this
      // editor's Undo while it is mounted.
      const unregisterUndo = registerUndoScope(replica, bridge.undoManager, () => bridge.flush());
      const controller = suggestionsFor(session);
      const hideSuggestions = showOverlaySuggestions(editor, bridge, replica, controller);
      const unregisterReveal = controller.registerRevealer((start) => {
        if (editor.isDestroyed || !editor.view.dom.isConnected) return false;
        const pos = bridge.sourceOffsetToPos(start);
        editor.chain().setTextSelection(pos).scrollIntoView().run();
        editor.view.focus();
        return true;
      });
      const suggestions: SharedVisualSuggestions = {
        controller,
        sourceRange(range) {
          bridge.flush();
          const start = bridge.posToSourceOffset(range.from);
          const end = range.to === range.from ? start : bridge.posToSourceOffset(range.to);
          return { start: Math.min(start, end), end: Math.max(start, end) };
        },
        text: () => replica.ytext.toString(),
      };
      return {
        bridge,
        suggestions,
        text: () => ytext.toString(),
        setNextProvenance: (provenance) => bridge.setNextProvenance(provenance),
        destroy() {
          unregisterReveal();
          hideSuggestions();
          unregisterUndo();
          unsubscribe();
          bridge.destroy();
        },
      };
    },
  };
}
