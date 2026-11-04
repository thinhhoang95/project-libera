import { EditorView } from "@codemirror/view";
import { codeMirrorTopAnchor, type EditorScrollState } from "./reflow-scroll-anchor";

export function readCodeMirrorScroll(view: EditorView): EditorScrollState {
  const { clientHeight, scrollLeft, scrollTop } = view.scrollDOM;
  const anchor = clientHeight ? codeMirrorTopAnchor(view) : null;
  return {
    editorScrollLeft: scrollLeft,
    editorScrollOffset: anchor?.offset,
    editorScrollPos: anchor?.pos,
    editorScrollTop: scrollTop,
  };
}

/**
 * Restores a saved position in a view that was just created. The text position
 * goes through CodeMirror's first measure, which renders that text before
 * scrolling to it, so its height is real by then. `onDone` runs once the
 * position is in place, in the frame after that measure. Returns a function
 * that cancels the restore, or null when nothing was saved.
 */
export function restoreCodeMirrorScroll(view: EditorView, saved: EditorScrollState, onDone: () => void) {
  const { editorScrollLeft, editorScrollOffset, editorScrollPos, editorScrollTop } = saved;
  if (editorScrollPos === undefined && editorScrollTop === undefined && editorScrollLeft === undefined) return null;
  if (editorScrollPos !== undefined) {
    view.dispatch({
      effects: EditorView.scrollIntoView(Math.min(editorScrollPos, view.state.doc.length), { y: "start", yMargin: editorScrollOffset ?? 0 }),
    });
  }
  const frame = requestAnimationFrame(() => {
    if (editorScrollPos === undefined) view.scrollDOM.scrollTop = editorScrollTop ?? 0;
    view.scrollDOM.scrollLeft = editorScrollLeft ?? 0;
    // Refresh the virtual viewport even if no scroll event is delivered.
    view.requestMeasure();
    onDone();
  });
  return () => cancelAnimationFrame(frame);
}
