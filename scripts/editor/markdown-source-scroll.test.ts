import assert from "node:assert/strict";
import test from "node:test";

import type { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";

import { CodeMirrorTextareaAdapter } from "../../src/lib/markdown-codemirror/textarea-adapter";
import type { EditorScrollState } from "../../src/lib/reflow-scroll-anchor";
import {
  mergeSourceScrollState, readSourceScrollAnchor, registerTextareaHighlightLayer, restoreSourceScrollAnchor,
} from "../../src/lib/markdown-source-scroll";

const TEXT = "first\nsecond\nthird\nfourth\nfifth";

/* A classic editor: a textarea and its one-element-per-line highlight layer.
 * `heights` are the wrapped heights of the lines at this pane's width. */
function classicEditor(heights: number[]) {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const { document } = dom.window;
  Object.assign(globalThis, { NodeFilter: dom.window.NodeFilter });
  const textarea = document.createElement("textarea");
  textarea.value = TEXT;
  const layer = document.createElement("pre");
  const lines = TEXT.split("\n").map((text, index) => {
    const line = document.createElement("div");
    line.textContent = text;
    line.getBoundingClientRect = () => {
      const top = 100 + heights.slice(0, index).reduce((sum, height) => sum + height, 0) - layer.scrollTop;
      return { top, bottom: top + heights[index] } as DOMRect;
    };
    return line;
  });
  layer.append(...lines);
  document.body.append(textarea, layer);
  textarea.getBoundingClientRect = () => ({ top: 100, left: 0, height: 200 }) as DOMRect;
  Object.defineProperty(textarea, "clientHeight", { value: 200 });
  const box = function (this: Range) { return this.startContainer.parentElement!.getBoundingClientRect(); };
  Object.assign(dom.window.Range.prototype, {
    getBoundingClientRect: box,
    getClientRects(this: Range) { return [box.call(this)]; },
  });
  const unregister = registerTextareaHighlightLayer(textarea, () => layer);
  return {
    textarea, layer, unregister,
    scrollTo(top: number) { textarea.scrollTop = top; layer.scrollTop = top; },
  };
}

test("the classic editor keeps the same text at a different width", () => {
  const wide = classicEditor([20, 20, 20, 20, 20]);
  wide.scrollTo(45);
  const anchor = readSourceScrollAnchor(wide.textarea)!;
  assert.deepEqual(anchor, { pos: TEXT.indexOf("third"), offset: -5 });

  // In a narrow pane the same lines wrap to three times the height.
  const narrow = classicEditor([60, 60, 60, 60, 60]);
  assert.equal(restoreSourceScrollAnchor(narrow.textarea, anchor), true);
  assert.equal(narrow.textarea.scrollTop, 125, "The saved 45 pixels would be on the first line here");
  assert.equal(narrow.layer.scrollTop, 125, "The highlight layer scrolls with the text");
  assert.deepEqual(readSourceScrollAnchor(narrow.textarea), anchor);
});

test("the classic editor reports no text position without its layer", () => {
  const { textarea, unregister } = classicEditor([20, 20, 20, 20, 20]);
  unregister();
  assert.equal(readSourceScrollAnchor(textarea), null);
  assert.equal(restoreSourceScrollAnchor(textarea, { pos: 3, offset: 0 }), false, "The caller falls back to pixels");
});

test("a classic position past the end of a shorter text goes to its last line", () => {
  const { textarea } = classicEditor([20, 20, 20, 20, 20]);
  assert.equal(restoreSourceScrollAnchor(textarea, { pos: 9999, offset: 0 }), true);
  assert.equal(textarea.scrollTop, 80);
});

function fakeCodeMirror(docLength = 100) {
  const scrolls: unknown[][] = [];
  let layoutReads = 0;
  const view = {
    state: { doc: { length: docLength } },
    scrollDOM: { clientHeight: 400, scrollTop: 0, scrollLeft: 0 },
    coordsAtPos: () => { layoutReads++; return null; },
  } as unknown as EditorView;
  const driver = {
    applyEdit: () => {}, applyValue: () => {},
    scrollIntoView: (...args: unknown[]) => { scrolls.push(args); },
  };
  return { view, driver, scrolls, layoutReads: () => layoutReads };
}

test("the CodeMirror adapter holds a position until the lazily loaded view attaches", () => {
  const adapter = new CodeMirrorTextareaAdapter("text");
  const textarea = adapter.asTextarea();
  const anchor = { pos: 40, offset: -6 };
  assert.equal(restoreSourceScrollAnchor(textarea, anchor), true);
  assert.deepEqual(readSourceScrollAnchor(textarea), anchor, "A capture before the view exists keeps the position");

  const { view, driver, scrolls } = fakeCodeMirror();
  adapter.attach(view, driver);
  assert.deepEqual(scrolls, [[40, "start", -6]]);
});

test("the CodeMirror adapter places the text at once when its view is there", () => {
  const adapter = new CodeMirrorTextareaAdapter("text");
  const { view, driver, scrolls, layoutReads } = fakeCodeMirror(30);
  adapter.attach(view, driver);
  restoreSourceScrollAnchor(adapter.asTextarea(), { pos: 40, offset: 2 });
  assert.deepEqual(scrolls, [[30, "start", 2]], "Clamped to the document");
  assert.equal(layoutReads(), 1, "Flushes the measure instead of painting a frame at the top");
});

test("a link's pixels replace the tab's saved text position", () => {
  const merged = mergeSourceScrollState(
    { editorScrollOffset: -4, editorScrollPos: 900, editorScrollTop: 5000 },
    { editorScrollTop: 120 },
  );
  assert.equal(merged.editorScrollTop, 120);
  assert.equal(merged.editorScrollPos, undefined);
  assert.equal(merged.editorScrollOffset, undefined);
});

test("other view state leaves the saved text position alone", () => {
  const current: EditorScrollState = { editorScrollOffset: -4, editorScrollPos: 900, editorScrollTop: 5000 };
  assert.deepEqual(mergeSourceScrollState(current, { editorScrollLeft: 3 }), { ...current, editorScrollLeft: 3 });
  assert.deepEqual(
    mergeSourceScrollState(current, { editorScrollOffset: 0, editorScrollPos: 12, editorScrollTop: 8 }),
    { editorScrollOffset: 0, editorScrollPos: 12, editorScrollTop: 8 },
  );
});
