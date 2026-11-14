import { EditorView } from "@codemirror/view";
import { codeMirrorTopAnchor, type EditorScrollState, type ReflowScrollAnchor } from "./reflow-scroll-anchor";

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

/** How long the restored text is held in place after the editor's height last
 * changed. A fresh view only estimates the lines it has not drawn, and the
 * real heights come in over the following second or so (the syntax tree, the
 * Visual mode's decorations, macros and labels from other files). */
export const RESTORE_SETTLE_MS = 1000;
/** Holding never outlasts this, even while heights keep changing. */
export const RESTORE_HOLD_LIMIT_MS = 10_000;

const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Restores a saved position in a view that was just created. The text position
 * goes through CodeMirror's first measure, which renders that text before
 * scrolling to it. The heights around it are still estimates then, and
 * CodeMirror's own scroll anchoring loses the place as they settle (two height
 * changes before one measure, or a shrinking estimate that briefly reads as
 * scrolled to the bottom), so the text is then held at its offset until the
 * height stops changing or the reader scrolls, types or clicks. `onDone` runs
 * once that is over. Returns a function that cancels the restore, or null when
 * nothing was saved.
 */
export function restoreCodeMirrorScroll(view: EditorView, saved: EditorScrollState, onDone: () => void) {
  const { editorScrollLeft, editorScrollOffset, editorScrollPos, editorScrollTop } = saved;
  if (editorScrollPos === undefined && editorScrollTop === undefined && editorScrollLeft === undefined) return null;
  const pos = editorScrollPos === undefined ? undefined : Math.min(editorScrollPos, view.state.doc.length);
  if (pos !== undefined) {
    view.dispatch({
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: editorScrollOffset ?? 0 }),
    });
  }
  let finished = false;
  let release: (() => void) | null = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    release?.();
    onDone();
  };
  const frame = requestAnimationFrame(() => {
    if (pos === undefined) view.scrollDOM.scrollTop = editorScrollTop ?? 0;
    view.scrollDOM.scrollLeft = editorScrollLeft ?? 0;
    // Refresh the virtual viewport even if no scroll event is delivered.
    view.requestMeasure();
    release = pos === undefined ? null : holdCodeMirrorText(view, { pos, offset: editorScrollOffset ?? 0 }, finish);
    if (!release) finish();
  });
  return () => {
    finished = true;
    cancelAnimationFrame(frame);
    release?.();
  };
}

/**
 * Keeps `anchor` at its offset from the top edge while the view's height
 * changes, until it has not changed for `RESTORE_SETTLE_MS`, the reader takes
 * over, or the editor is hidden; then `onSettled` runs. Null without
 * ResizeObserver (nothing to follow the heights with).
 */
export function holdCodeMirrorText(view: EditorView, anchor: ReflowScrollAnchor, onSettled: () => void) {
  const { scrollDOM, contentDOM } = view;
  const ownerWindow = scrollDOM.ownerDocument?.defaultView;
  if (!ownerWindow || !("ResizeObserver" in ownerWindow)) return null;
  const measureKey = {};
  let stopped = false;
  let frame: number | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    for (const type of USER_SCROLL_EVENTS) scrollDOM.removeEventListener(type, settle, { capture: true });
    if (frame !== null) ownerWindow.cancelAnimationFrame(frame);
    if (settleTimer !== null) clearTimeout(settleTimer);
    clearTimeout(limitTimer);
  };
  function settle() {
    if (stopped) return;
    stop();
    onSettled();
  }
  const waitForSettle = () => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, RESTORE_SETTLE_MS);
  };

  // Read in CodeMirror's measure phase, after it has measured the new heights,
  // and written there too, so its own anchoring sees the corrected position.
  const check = () => {
    frame = null;
    if (stopped) return;
    view.requestMeasure({
      key: measureKey,
      read: () => {
        const coords = view.coordsAtPos(anchor.pos);
        // Not drawn yet: the estimate brings it into the viewport, and the
        // next frame measures it.
        const top = coords?.top ?? view.documentTop + view.lineBlockAt(anchor.pos).top;
        return { delta: top - scrollDOM.getBoundingClientRect().top - anchor.offset, drawn: !!coords };
      },
      write: ({ delta, drawn }) => {
        if (stopped || Math.abs(delta) < 1) return;
        scrollDOM.scrollTop += delta;
        // Scrolling draws other lines, whose real heights may move the text again.
        if (frame === null) frame = ownerWindow.requestAnimationFrame(check);
        if (!drawn) waitForSettle();
      },
    });
  };

  let width = scrollDOM.clientWidth;
  let height = contentDOM.offsetHeight;
  const observer = new ownerWindow.ResizeObserver(() => {
    if (stopped) return;
    const nextWidth = scrollDOM.clientWidth;
    const nextHeight = contentDOM.offsetHeight;
    // Hidden (another tab in front): the tab restore takes over when it is shown.
    if (!nextWidth) { settle(); return; }
    if (nextWidth === width && nextHeight === height) return;
    width = nextWidth;
    height = nextHeight;
    waitForSettle();
    check();
  });
  observer.observe(scrollDOM);
  observer.observe(contentDOM);
  for (const type of USER_SCROLL_EVENTS) scrollDOM.addEventListener(type, settle, { passive: true, capture: true });
  const limitTimer = setTimeout(settle, RESTORE_HOLD_LIMIT_MS);
  waitForSettle();
  check();
  return stop;
}
