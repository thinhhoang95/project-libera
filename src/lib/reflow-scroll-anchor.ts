import type { EditorView as CodeMirrorView } from "@codemirror/view";
import type { EditorView as ProseMirrorView } from "@tiptap/pm/view";
import { applyVisualScrollAnchor, captureVisualScrollAnchor } from "./tiptap-scroll-anchor";

/** A position in an editor's text and how far its line sits below the top of
 * the scroll container, in pixels. Kept in memory only: it is recaptured as
 * the reader scrolls and means nothing once the layout settles again. */
export type ReflowScrollAnchor = { pos: number; offset: number };

export type ReflowScrollAnchorAdapter<Anchor> = {
  /** The position to hold: the caret line when it is on screen, otherwise the
   * text at the top of the viewport. Null without layout. */
  capture(): Anchor | null;
  /** Scrolls so the anchor's line is back at its offset. */
  apply(anchor: Anchor): void;
  /** True while another restore owns the scroll position (tab switches). */
  paused?(): boolean;
  /** The element holding the text, when blocks in it settle their height after
   * the width changes (live HTML frames report theirs a few frames later). */
  content?: HTMLElement;
};

/** How long after the last width change the original anchor keeps being
 * re-applied; covers the side panels' width transition and blocks that settle
 * their height shortly after it. */
export const REFLOW_FOLLOW_MS = 400;

const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
const CAPTURE_EVENTS = ["scroll", "keyup", "pointerup", "input"] as const;

/**
 * Keeps what the reader sees in place when the container's width changes (a
 * side panel opening or closing, a window resize) and the text rewraps. The
 * anchor is captured as the reader scrolls or moves the caret, then re-applied
 * on every width change until the width settles or the user takes over, and
 * on content height changes within that window (never outside it, so typing
 * and late-loading images are left alone). Changes to or from zero width (hidden tabs) are left to the tab restore, and
 * nothing is applied while `paused()` says another restore is running.
 */
export function keepScrollOnReflow<Anchor>(container: HTMLElement, adapter: ReflowScrollAnchorAdapter<Anchor>) {
  const ownerWindow = container.ownerDocument.defaultView;
  if (!ownerWindow || !("ResizeObserver" in ownerWindow)) return () => {};
  let anchor: Anchor | null = null;
  const { content } = adapter;
  let width = container.clientWidth;
  let contentHeight = content?.offsetHeight ?? 0;
  let followUntil = 0;
  let frame: number | null = null;

  const following = () => followUntil > Date.now();
  const stopFollowing = () => { followUntil = 0; };
  function capture() {
    frame = null;
    // Scrolls caused by re-applying the anchor must not replace it.
    if (following()) return;
    try {
      anchor = adapter.capture();
    } catch {
      // The view can disappear between a queued frame and unmount.
      anchor = null;
    }
  }
  function scheduleCapture() {
    if (frame === null) frame = ownerWindow!.requestAnimationFrame(capture);
  }

  function apply() {
    try {
      adapter.apply(anchor!);
    } catch {
      // As above: a torn-down view has nothing to keep in place.
    }
  }

  const observer = new ownerWindow.ResizeObserver(() => {
    const previous = width;
    const previousContentHeight = contentHeight;
    width = container.clientWidth;
    contentHeight = content?.offsetHeight ?? 0;
    if (width === previous) {
      // A block settling its height after the width change; does not extend the window.
      if (contentHeight !== previousContentHeight && anchor && following() && !adapter.paused?.()) apply();
      return;
    }
    if (!width || !previous) {
      anchor = null;
      stopFollowing();
      if (width) scheduleCapture();
      return;
    }
    if (!anchor || adapter.paused?.()) return;
    followUntil = Date.now() + REFLOW_FOLLOW_MS;
    apply();
  });
  observer.observe(container);
  if (content) observer.observe(content);
  for (const type of USER_SCROLL_EVENTS) container.addEventListener(type, stopFollowing, { passive: true, capture: true });
  for (const type of CAPTURE_EVENTS) container.addEventListener(type, scheduleCapture, { passive: true, capture: true });
  scheduleCapture();

  return () => {
    observer.disconnect();
    for (const type of USER_SCROLL_EVENTS) container.removeEventListener(type, stopFollowing, { capture: true });
    for (const type of CAPTURE_EVENTS) container.removeEventListener(type, scheduleCapture, { capture: true });
    if (frame !== null) ownerWindow.cancelAnimationFrame(frame);
  };
}

function viewportBand(container: HTMLElement) {
  const rect = container.getBoundingClientRect();
  return { top: rect.top, bottom: rect.top + (container.clientHeight || rect.height), left: rect.left };
}

const isOnScreen = (band: { top: number; bottom: number }, rect: { top: number; bottom: number }) =>
  rect.top >= band.top && rect.bottom <= band.bottom;

/** A Visual anchor is a text position, or a top-level block when the text at
 * the top has no box of its own (a macro's hidden source behind its expansion). */
export type VisualReflowAnchor = ReflowScrollAnchor & { block?: true };

/** Hidden text (`display: none`) measures as an empty box at the origin. */
const hasBox = (rect: { top: number; bottom: number }) => rect.bottom > rect.top;

/** Visual (TipTap) editor: `container` is the scroller around `view.dom`. */
export function proseMirrorReflowAdapter(
  view: ProseMirrorView,
  container: HTMLElement,
  paused?: () => boolean,
): ReflowScrollAnchorAdapter<VisualReflowAnchor> {
  return {
    paused,
    content: view.dom as HTMLElement,
    capture() {
      if (view.isDestroyed) return null;
      const band = viewportBand(container);
      const head = view.state.selection.head;
      const caret = view.coordsAtPos(head);
      if (view.hasFocus() && hasBox(caret) && isOnScreen(band, caret)) return { pos: head, offset: caret.top - band.top };
      const left = Math.max(band.left + 1, view.dom.getBoundingClientRect().left + 1);
      const hit = view.posAtCoords({ left, top: band.top + 1 });
      const rect = hit && view.coordsAtPos(hit.pos);
      if (hit && rect && hasBox(rect)) return { pos: hit.pos, offset: rect.top - band.top };
      const block = captureVisualScrollAnchor(view, container);
      return block && { ...block, block: true };
    },
    apply(anchor) {
      if (view.isDestroyed || anchor.pos > view.state.doc.content.size) return;
      if (anchor.block) {
        applyVisualScrollAnchor(view, container, anchor);
        return;
      }
      const rect = view.coordsAtPos(anchor.pos);
      // The text was hidden since it was captured (the caret left a macro); keep still.
      if (!hasBox(rect)) return;
      const delta = rect.top - container.getBoundingClientRect().top - anchor.offset;
      if (delta) container.scrollTop += delta;
    },
  };
}

/** CodeMirror editors (source, LaTeX, code). Applied in CodeMirror's measure
 * cycle, after its own height bookkeeping for the new line wrapping. */
export function codeMirrorReflowAdapter(view: CodeMirrorView, paused?: () => boolean): ReflowScrollAnchorAdapter<ReflowScrollAnchor> {
  const measureKey = {};
  return {
    paused,
    capture() {
      const band = viewportBand(view.scrollDOM);
      const head = view.state.selection.main.head;
      const caret = view.coordsAtPos(head);
      if (caret && view.hasFocus && isOnScreen(band, caret)) return { pos: head, offset: caret.top - band.top };
      const left = Math.max(band.left + 1, view.contentDOM.getBoundingClientRect().left + 1);
      const pos = view.posAtCoords({ x: left, y: band.top + 1 }, false);
      const coords = view.coordsAtPos(pos);
      return coords ? { pos, offset: coords.top - band.top } : null;
    },
    apply(anchor) {
      view.requestMeasure({
        key: measureKey,
        read: () => {
          const pos = Math.min(anchor.pos, view.state.doc.length);
          const top = view.coordsAtPos(pos)?.top
            // Scrolled out of the rendered viewport: fall back to the line's
            // estimated height; the next width change refines it.
            ?? view.documentTop + view.lineBlockAt(pos).top;
          return top - view.scrollDOM.getBoundingClientRect().top - anchor.offset;
        },
        write: (delta) => { if (delta) view.scrollDOM.scrollTop += delta; },
      });
    },
  };
}

/** Legacy textarea source editor: a line index and column in the text. */
export type TextareaReflowAnchor = { line: number; column: number; offset: number };

/** Measures through the highlight layer, which mirrors the textarea's text in
 * one element per line with identical wrapping, and scrolls with it. */
export function textareaReflowAdapter(
  textarea: HTMLTextAreaElement,
  layer: () => HTMLElement | null,
): ReflowScrollAnchorAdapter<TextareaReflowAnchor> {
  return {
    capture() {
      const lines = layer()?.children;
      if (!lines?.length) return null;
      const band = viewportBand(textarea);
      if (textarea.ownerDocument.activeElement === textarea) {
        const caret = textareaLineColumn(textarea.value, textarea.selectionEnd);
        const rect = lines[caret.line] && columnRect(lines[caret.line], caret.column);
        if (rect && isOnScreen(band, rect)) return { ...caret, offset: rect.top - band.top };
      }
      // Lines stack in order, so measure O(log n) of them.
      let low = 0, high = lines.length - 1, line = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (lines[middle].getBoundingClientRect().bottom > band.top) { line = middle; high = middle - 1; }
        else low = middle + 1;
      }
      if (line < 0) return null;
      const element = lines[line];
      let column = 0;
      if (element.getBoundingClientRect().top < band.top) {
        // The line wraps across the top edge: find its first visible character.
        let lowColumn = 0, highColumn = element.textContent?.length ?? 0;
        while (lowColumn < highColumn) {
          const middle = (lowColumn + highColumn) >> 1;
          if ((columnRect(element, middle)?.bottom ?? 0) > band.top) highColumn = middle;
          else lowColumn = middle + 1;
        }
        column = lowColumn;
      }
      const rect = columnRect(element, column);
      return rect ? { line, column, offset: rect.top - band.top } : null;
    },
    apply(anchor) {
      const highlight = layer();
      const element = highlight?.children[anchor.line];
      const rect = element && columnRect(element, anchor.column);
      if (!highlight || !rect) return;
      const delta = rect.top - textarea.getBoundingClientRect().top - anchor.offset;
      if (!delta) return;
      textarea.scrollTop += delta;
      highlight.scrollTop = textarea.scrollTop;
    },
  };
}

function textareaLineColumn(text: string, offset: number) {
  let line = 0, start = 0;
  for (let next = text.indexOf("\n"); next !== -1 && next < offset; next = text.indexOf("\n", next + 1)) {
    line++;
    start = next + 1;
  }
  return { line, column: offset - start };
}

/** The box of the character at `column` in a highlight line; at the line's end,
 * the box of its last character, and for an empty line the line's own box. */
function columnRect(line: Element, column: number): DOMRect | null {
  const document = line.ownerDocument;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const charBox = (node: Node, offset: number, last: boolean) => {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const boxes = range.getClientRects();
    return boxes.length ? boxes[last ? boxes.length - 1 : 0] : range.getBoundingClientRect();
  };
  let remaining = column;
  let lastText: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining < length) return charBox(node, remaining, false);
    remaining -= length;
    if (length) lastText = node;
  }
  return lastText ? charBox(lastText, lastText.textContent!.length - 1, true) : line.getBoundingClientRect();
}
