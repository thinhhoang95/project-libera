import assert from "node:assert/strict";
import test from "node:test";

import type { EditorView } from "@codemirror/view";

import { readCodeMirrorScroll, restoreCodeMirrorScroll } from "../../src/lib/codemirror-scroll";

type ScrollEffect = { value: { range: { head: number }; y: string; yMargin: number } };

/* The parts of a view these helpers touch. Heights and text positions are what
 * the browser would report, so they are stubbed; jsdom has no layout. */
function fakeView({ clientHeight = 400, docLength = 1000, scrollTop = 0, scrollLeft = 0, coordsTop = 90 as number | null } = {}) {
  const effects: ScrollEffect[] = [];
  const queried: { x: number; y: number }[] = [];
  let measures = 0;
  const scrollDOM = {
    clientHeight, scrollTop, scrollLeft,
    getBoundingClientRect: () => ({ top: 100, left: 20, height: clientHeight }),
  };
  const view = {
    scrollDOM,
    contentDOM: { getBoundingClientRect: () => ({ left: 60 }) },
    state: { doc: { length: docLength } },
    dispatch: (spec: { effects: ScrollEffect }) => { effects.push(spec.effects); },
    requestMeasure: () => { measures++; },
    posAtCoords: (coords: { x: number; y: number }) => { queried.push(coords); return 640; },
    coordsAtPos: () => (coordsTop === null ? null : { top: coordsTop }),
  };
  return { view: view as unknown as EditorView, scrollDOM, effects, queried, measures: () => measures };
}

/* Frames run when the test says, the way a browser runs them after layout. */
function manualFrames(context: test.TestContext) {
  const frames = new Map<number, () => void>();
  let next = 0;
  const globals = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  const original = { request: globals.requestAnimationFrame, cancel: globals.cancelAnimationFrame };
  globals.requestAnimationFrame = (callback: () => void) => { frames.set(++next, callback); return next; };
  globals.cancelAnimationFrame = (id: number) => { frames.delete(id); };
  context.after(() => {
    globals.requestAnimationFrame = original.request;
    globals.cancelAnimationFrame = original.cancel;
  });
  return {
    pending: () => frames.size,
    run() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("the saved position is the text at the top edge, not only pixels", () => {
  const { view, queried } = fakeView({ scrollTop: 52200.5, scrollLeft: 7 });
  assert.deepEqual(readCodeMirrorScroll(view), {
    editorScrollLeft: 7, editorScrollOffset: -10, editorScrollPos: 640, editorScrollTop: 52200.5,
  });
  assert.deepEqual(queried, [{ x: 61, y: 101 }], "Reads past the gutter, just inside the top edge");
});

test("without layout or rendered text only the pixels are saved", () => {
  for (const options of [{ clientHeight: 0 }, { coordsTop: null }]) {
    const saved = readCodeMirrorScroll(fakeView({ scrollTop: 30, ...options }).view);
    assert.equal(saved.editorScrollTop, 30);
    assert.equal(saved.editorScrollPos, undefined);
    assert.equal(saved.editorScrollOffset, undefined);
  }
});

test("a view whose position lookups throw still reports its pixels", () => {
  // After "Viewport failed to stabilize" the viewport and the DOM disagree and
  // posAtCoords throws. This is read during tab switches, which must go on.
  const { view } = fakeView({ scrollTop: 300, scrollLeft: 4 });
  view.posAtCoords = (() => { throw new TypeError("Cannot read properties of null (reading 'length')"); }) as EditorView["posAtCoords"];
  assert.deepEqual(readCodeMirrorScroll(view), {
    editorScrollLeft: 4, editorScrollOffset: undefined, editorScrollPos: undefined, editorScrollTop: 300,
  });
});

test("a restore scrolls to the saved text and leaves the estimated pixels alone", (context) => {
  const frames = manualFrames(context);
  const { view, scrollDOM, effects, measures } = fakeView();
  let done = 0;
  const cancel = restoreCodeMirrorScroll(view, {
    editorScrollLeft: 18, editorScrollOffset: -10, editorScrollPos: 640, editorScrollTop: 52200,
  }, () => { done++; });

  assert.ok(cancel);
  // Sent before the first measure, which renders the text and then scrolls to it.
  assert.equal(effects.length, 1);
  assert.equal(effects[0].value.range.head, 640);
  assert.equal(effects[0].value.y, "start");
  assert.equal(effects[0].value.yMargin, -10);
  assert.equal(done, 0, "The position is not in place until that measure has run");

  frames.run();
  assert.equal(scrollDOM.scrollTop, 0, "A pixel offset from another view must not override the text position");
  assert.equal(scrollDOM.scrollLeft, 18);
  assert.equal(measures(), 1);
  assert.equal(done, 1);
});

test("a position past the end of a shorter document goes to the end", (context) => {
  manualFrames(context);
  const { view, effects } = fakeView({ docLength: 100 });
  restoreCodeMirrorScroll(view, { editorScrollOffset: 0, editorScrollPos: 640 }, () => {});
  assert.equal(effects[0].value.range.head, 100);
});

test("tabs saved before the text position restore their pixels", (context) => {
  const frames = manualFrames(context);
  const { view, scrollDOM, effects } = fakeView();
  restoreCodeMirrorScroll(view, { editorScrollLeft: 18, editorScrollTop: 2400.5 }, () => {});
  assert.equal(effects.length, 0);
  frames.run();
  assert.equal(scrollDOM.scrollTop, 2400.5);
  assert.equal(scrollDOM.scrollLeft, 18);
});

test("nothing saved leaves the view to its other fallbacks", (context) => {
  const frames = manualFrames(context);
  const { view, effects } = fakeView();
  assert.equal(restoreCodeMirrorScroll(view, { }, () => {}), null);
  assert.equal(effects.length, 0);
  assert.equal(frames.pending(), 0);
});

test("switching away before the restore finishes cancels it", (context) => {
  const frames = manualFrames(context);
  const { view, scrollDOM } = fakeView();
  let done = 0;
  const cancel = restoreCodeMirrorScroll(view, { editorScrollLeft: 18, editorScrollPos: 640 }, () => { done++; });
  cancel!();
  frames.run();
  assert.equal(done, 0);
  assert.equal(scrollDOM.scrollLeft, 0);
});
