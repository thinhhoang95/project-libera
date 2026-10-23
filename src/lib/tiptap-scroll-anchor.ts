import type { EditorView } from "@tiptap/pm/view";

/** The top-level block at the top of the Visual editor's viewport, and how far
 * its top edge sits from the viewport's top edge (negative once scrolled past). */
export type VisualScrollAnchor = { pos: number; offset: number };

export type VisualScrollTarget = { left: number; top: number; anchor?: VisualScrollAnchor };

/** How long a restore keeps following late layout (images, diagrams, charts,
 * live HTML) before leaving the scroll position alone. */
export const VISUAL_SCROLL_SETTLE_MS = 3000;

const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

function blockRect(view: EditorView, pos: number): DOMRect | null {
  const dom = view.nodeDOM(pos);
  return dom?.nodeType === 1 ? (dom as Element).getBoundingClientRect() : null;
}

/** Finds the first top-level block whose bottom is below the viewport's top.
 * Returns null without layout (every rect is empty) or past the last block. */
export function captureVisualScrollAnchor(view: EditorView, container: HTMLElement): VisualScrollAnchor | null {
  const top = container.getBoundingClientRect().top;
  const offsets: number[] = [];
  view.state.doc.forEach((_node, offset) => { offsets.push(offset); });
  // Top-level blocks are stacked in document order, so measure O(log n) of them.
  let low = 0;
  let high = offsets.length - 1;
  let found: { pos: number; rect: DOMRect } | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const rect = blockRect(view, offsets[middle]);
    if (!rect) return null;
    if (rect.bottom > top) {
      found = { pos: offsets[middle], rect };
      high = middle - 1;
    } else low = middle + 1;
  }
  return found ? { pos: found.pos, offset: found.rect.top - top } : null;
}

/** Scrolls so the anchor's block is back at its saved offset. False when the
 * document no longer has a top-level block at that position. */
export function applyVisualScrollAnchor(view: EditorView, container: HTMLElement, anchor: VisualScrollAnchor): boolean {
  const { doc } = view.state;
  if (anchor.pos < 0 || anchor.pos >= doc.content.size || doc.resolve(anchor.pos).depth !== 0) return false;
  const rect = blockRect(view, anchor.pos);
  if (!rect) return false;
  const delta = rect.top - container.getBoundingClientRect().top - anchor.offset;
  if (delta) container.scrollTop += delta;
  return true;
}

/**
 * Restores a saved Visual scroll position, then keeps re-applying it while the
 * document's height changes, until the settle time passes, the user scrolls,
 * types or clicks, or `cancel()` is called (for programmatic navigation).
 * Without the anchor, the pixel offset is re-applied, so a position clamped by
 * a not-yet-tall page is reached once the content grows.
 */
export function startVisualScrollRestore(
  view: EditorView,
  container: HTMLElement,
  target: VisualScrollTarget,
  settleMs = VISUAL_SCROLL_SETTLE_MS,
) {
  let active = true;
  function apply() {
    container.scrollLeft = target.left;
    if (target.anchor && applyVisualScrollAnchor(view, container, target.anchor)) return;
    container.scrollTop = target.top;
  }
  // Start from the pixel offset so the anchor's block is already nearby.
  container.scrollTop = target.top;
  apply();

  const ownerWindow = container.ownerDocument.defaultView;
  const observer = ownerWindow && "ResizeObserver" in ownerWindow
    ? new ownerWindow.ResizeObserver(() => { if (active) apply(); })
    : null;
  observer?.observe(view.dom);
  for (const type of USER_SCROLL_EVENTS) container.addEventListener(type, cancel, { passive: true, capture: true });
  const timer = setTimeout(cancel, settleMs);

  function cancel() {
    if (!active) return;
    active = false;
    observer?.disconnect();
    for (const type of USER_SCROLL_EVENTS) container.removeEventListener(type, cancel, { capture: true });
    clearTimeout(timer);
  }
  return { target, active: () => active, cancel };
}

export type VisualScrollRestore = ReturnType<typeof startVisualScrollRestore>;
