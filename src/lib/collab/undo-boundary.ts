import { isolateHistory } from "@codemirror/commands";
import { Facet, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ySyncFacet } from "y-codemirror.next";

/* Edits made through a widget (a formula or table cell saved in the Visual
 * mode) are one undo step of their own, in every history the editor has:
 * CodeMirror's local history, the shared tab's Y.UndoManager, and suggest
 * mode's undo manager for its annotations. */

/** Other undo managers that must not merge across a widget edit (suggest mode's). */
export const undoBoundaries = Facet.define<() => void>();

function stopCapturing(view: EditorView) {
  const sync = view.state.facet(ySyncFacet) as unknown as { undoManager?: { stopCapturing?: () => void } } | undefined;
  sync?.undoManager?.stopCapturing?.();
  for (const stop of view.state.facet(undoBoundaries)) stop();
}

/** Dispatches a widget's edit as one undo step that merges with neither the typing before it nor after it. */
export function dispatchAsOneStep(view: EditorView, spec: TransactionSpec) {
  stopCapturing(view);
  view.dispatch({ ...spec, annotations: [...[spec.annotations ?? []].flat(), isolateHistory.of("full")] });
  stopCapturing(view);
}
