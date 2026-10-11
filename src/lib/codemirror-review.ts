import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/* Review comment anchors and the pending selection, highlighted in a
 * CodeMirror source editor. Ranges follow edits until the next refresh. */

export type CodeMirrorReviewRange = { start: number; end: number };

export const setReviewHighlights = StateEffect.define<CodeMirrorReviewRange[]>();
const highlight = Decoration.mark({ class: "review-source-highlight" });

const reviewHighlightsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setReviewHighlights)) continue;
      const length = tr.state.doc.length;
      const ranges = effect.value
        .map((range) => ({ from: Math.max(0, Math.min(range.start, length)), to: Math.max(0, Math.min(range.end, length)) }))
        .filter((range) => range.to > range.from)
        .sort((a, b) => a.from - b.from || a.to - b.to);
      next = Decoration.set(ranges.map((range) => highlight.range(range.from, range.to)));
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const readOnlyCompartment = new Compartment();
const installed = new WeakSet<EditorView>();

/** Adds the review highlight field and a read-only switch to an editor once. */
export function installCodeMirrorReview(view: EditorView) {
  if (installed.has(view)) return;
  installed.add(view);
  const extension: Extension = [reviewHighlightsField, readOnlyCompartment.of([])];
  view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
}

export function setCodeMirrorReviewLocked(view: EditorView, locked: boolean) {
  view.dispatch({ effects: readOnlyCompartment.reconfigure(locked ? EditorState.readOnly.of(true) : []) });
}
