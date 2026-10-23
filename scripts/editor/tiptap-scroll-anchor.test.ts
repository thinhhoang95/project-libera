import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";

import { captureVisualScrollAnchor, startVisualScrollRestore, type VisualScrollAnchor } from "../../src/lib/tiptap-scroll-anchor";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

/* A Visual page without a browser: a 200px viewport over top-level blocks of
 * the given heights. scrollTop clamps to the content like a real scroller, and
 * the page's ResizeObserver fires only when the test says layout changed. */
function mountPage(heights: number[]) {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals.window, document: globals.document, navigator: globals.navigator };
  for (const key of ["window", "document", "navigator"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  const document = dom.window.document;
  const container = document.createElement("div");
  document.body.append(container);
  const viewportHeight = 200;
  let scrollTop = 0;
  const contentHeight = () => heights.reduce((sum, height) => sum + height, 0);
  Object.defineProperty(container, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, Math.min(value, contentHeight() - viewportHeight)); },
  });

  const view = new EditorView(container, {
    state: EditorState.create({
      doc: schema.node("doc", null, heights.map((_, index) => schema.node("paragraph", null, [schema.text(`Block ${index}`)]))),
    }),
  });
  const rect = (top: number, height: number) => new dom.window.DOMRect(0, top, 600, height);
  container.getBoundingClientRect = () => rect(0, viewportHeight);
  [...view.dom.children].forEach((block, index) => {
    block.getBoundingClientRect = () => {
      const top = heights.slice(0, index).reduce((sum, height) => sum + height, 0) - scrollTop;
      return rect(top, heights[index]);
    };
  });

  const observers: Array<() => void> = [];
  class FakeResizeObserver {
    connected = true;
    constructor(callback: () => void) { observers.push(() => { if (this.connected) callback(); }); }
    observe() {}
    disconnect() { this.connected = false; }
  }
  Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, value: FakeResizeObserver });

  const blockPos = (index: number) => {
    let pos = 0;
    view.state.doc.forEach((node, offset, childIndex) => { if (childIndex === index) pos = offset; });
    return pos;
  };
  /** The viewport-relative top of a block, i.e. where the reader sees it. */
  const blockTop = (index: number) => view.dom.children[index].getBoundingClientRect().top;
  return {
    container, view, heights, blockPos, blockTop,
    layoutChanged: () => { for (const notify of observers) notify(); },
    close() {
      view.destroy();
      dom.window.close();
      for (const [key, value] of Object.entries(saved)) Object.defineProperty(globalThis, key, { configurable: true, value });
    },
  };
}

test("an anchored restore keeps the same block in view while content above it loads", () => {
  // Before the switch: a 400px figure, then text; the reader is 20px into block 2.
  const before = mountPage([400, 100, 100, 100, 100, 100]);
  let anchor: VisualScrollAnchor | undefined;
  try {
    before.container.scrollTop = 520;
    anchor = captureVisualScrollAnchor(before.view, before.container) ?? undefined;
    assert.deepEqual(anchor, { pos: before.blockPos(2), offset: -20 });
  } finally {
    before.close();
  }

  // After the switch the figure has not loaded yet, so the page is too short
  // for scrollTop 520: a pixel-only restore would clamp to 300 and show block 3.
  const page = mountPage([0, 100, 100, 100, 100, 100]);
  try {
    const restore = startVisualScrollRestore(page.view, page.container, { left: 0, top: 520, anchor });
    assert.equal(page.blockTop(2), -20, "the anchored block is in place before late layout");

    page.heights[0] = 400;
    page.layoutChanged();
    assert.equal(page.container.scrollTop, 520);
    assert.equal(page.blockTop(2), -20, "the anchored block stays put once the figure loads");
    assert.ok(restore.active());
    assert.deepEqual(restore.target, { left: 0, top: 520, anchor }, "the saved target is still what gets reported");

    // Once the reader scrolls, later layout no longer moves the page.
    page.container.dispatchEvent(new page.container.ownerDocument.defaultView!.WheelEvent("wheel"));
    assert.equal(restore.active(), false);
    page.container.scrollTop = 100;
    page.heights[1] = 300;
    page.layoutChanged();
    assert.equal(page.container.scrollTop, 100);
  } finally {
    page.close();
  }
});

test("without an anchor the pixel offset is re-applied once the page is tall enough", async () => {
  const page = mountPage([0, 100, 100, 100, 100, 100]);
  try {
    const restore = startVisualScrollRestore(page.view, page.container, { left: 0, top: 520 }, 20);
    assert.equal(page.container.scrollTop, 300, "clamped while the page is short");
    page.heights[0] = 400;
    page.layoutChanged();
    assert.equal(page.container.scrollTop, 520);

    // The restore stops following layout after the settle time.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(restore.active(), false);
    page.container.scrollTop = 0;
    page.layoutChanged();
    assert.equal(page.container.scrollTop, 0);
  } finally {
    page.close();
  }
});

test("no anchor is captured without layout, or for a position the document no longer has", () => {
  const page = mountPage([100, 100, 100]);
  try {
    const emptyRect = () => new page.container.ownerDocument.defaultView!.DOMRect();
    for (const block of page.view.dom.children) block.getBoundingClientRect = emptyRect;
    page.container.getBoundingClientRect = emptyRect;
    assert.equal(captureVisualScrollAnchor(page.view, page.container), null);

    // A reload replaced the document: fall back to the pixel offset.
    startVisualScrollRestore(page.view, page.container, { left: 0, top: 50, anchor: { pos: 9999, offset: 0 } }).cancel();
    assert.equal(page.container.scrollTop, 50);
  } finally {
    page.close();
  }
});
