import assert from "node:assert/strict";
import test from "node:test";

import type { EditorView } from "@codemirror/view";

import { readCodeMirrorScroll, restoreCodeMirrorScroll, RESTORE_HOLD_LIMIT_MS, RESTORE_SETTLE_MS } from "../../src/lib/codemirror-scroll";

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

type MeasureRequest = { read: () => { delta: number; drawn: boolean }; write: (value: { delta: number; drawn: boolean }) => void };

/* A view in a window with ResizeObserver, so the restore holds the text while
 * heights settle. `textTop` is where the saved text is drawn, in viewport pixels. */
function settlingView(context: test.TestContext) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const frames = manualFrames(context);
  const observers: { callback: () => void; disconnected: boolean }[] = [];
  const listeners = new Map<string, () => void>();
  const requests: MeasureRequest[] = [];
  const layout = { textTop: 90 as number | null, contentHeight: 50000, width: 600 };
  const ownerWindow = {
    ResizeObserver: class {
      entry: { callback: () => void; disconnected: boolean };
      constructor(callback: () => void) { this.entry = { callback, disconnected: false }; observers.push(this.entry); }
      observe() {}
      disconnect() { this.entry.disconnected = true; }
    },
    requestAnimationFrame: (callback: () => void) => requestAnimationFrame(callback),
    cancelAnimationFrame: (id: number) => cancelAnimationFrame(id),
  };
  const scrollDOM = {
    clientHeight: 400, scrollTop: 0, scrollLeft: 0,
    get clientWidth() { return layout.width; },
    ownerDocument: { defaultView: ownerWindow },
    getBoundingClientRect: () => ({ top: 100, left: 20, height: 400 }),
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  };
  const view = {
    scrollDOM,
    contentDOM: { get offsetHeight() { return layout.contentHeight; }, getBoundingClientRect: () => ({ left: 60 }) },
    state: { doc: { length: 1000 } },
    documentTop: 100,
    dispatch: () => {},
    requestMeasure: (request?: MeasureRequest) => { if (request) requests.push(request); },
    coordsAtPos: () => (layout.textTop === null ? null : { top: layout.textTop }),
    lineBlockAt: () => ({ top: 3000 }),
  };
  /** Runs the measure requests the way CodeMirror's measure cycle does. */
  const measure = () => {
    const pending = requests.splice(0);
    for (const request of pending) request.write(request.read());
  };
  const resize = (change: Partial<typeof layout>) => {
    Object.assign(layout, change);
    for (const observer of observers) if (!observer.disconnected) observer.callback();
  };
  return { view: view as unknown as EditorView, scrollDOM, frames, layout, listeners, observers, measure, resize, tick: (ms: number) => context.mock.timers.tick(ms) };
}

test("the restored text stays at its offset while the heights around it settle", (context) => {
  const { view, scrollDOM, frames, measure, resize, tick, observers } = settlingView(context);
  let done = 0;
  restoreCodeMirrorScroll(view, { editorScrollOffset: -10, editorScrollPos: 640 }, () => { done++; });
  frames.run();
  measure();
  assert.equal(scrollDOM.scrollTop, 0, "In place after the first measure: nothing to correct");
  assert.equal(done, 0, "Still holding: the heights are estimates");

  // Lines above get their real heights and the text moves 400px down.
  tick(600);
  resize({ textTop: 490, contentHeight: 42000 });
  measure();
  assert.equal(scrollDOM.scrollTop, 400);

  // Within the settle window of that change, so still holding.
  tick(600);
  assert.equal(done, 0);
  tick(400);
  assert.equal(done, 1, "Done once the height has not changed for a while");
  assert.ok(observers.every((observer) => observer.disconnected));
});

test("text not drawn yet is brought in by its estimate, then placed exactly", (context) => {
  const { view, scrollDOM, frames, layout, measure, resize } = settlingView(context);
  restoreCodeMirrorScroll(view, { editorScrollOffset: -10, editorScrollPos: 640 }, () => {});
  frames.run();
  measure();
  resize({ textTop: null, contentHeight: 30000 });
  measure();
  // documentTop 100 + line top 3000, minus the scroller's top 100, less the offset.
  assert.equal(scrollDOM.scrollTop, 3010);
  layout.textTop = 130;
  frames.run();
  measure();
  assert.equal(scrollDOM.scrollTop, 3050, "Checked again in the next frame, once it is drawn");
});

for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
  test(`the reader's ${type} ends the hold`, (context) => {
    const { view, scrollDOM, frames, listeners, measure, resize } = settlingView(context);
    let done = 0;
    restoreCodeMirrorScroll(view, { editorScrollOffset: -10, editorScrollPos: 640 }, () => { done++; });
    frames.run();
    measure();
    listeners.get(type)!();
    assert.equal(done, 1);
    resize({ textTop: 500, contentHeight: 1 });
    measure();
    assert.equal(scrollDOM.scrollTop, 0, "The reader's scroll is left alone");
  });
}

test("a hidden editor stops holding", (context) => {
  const { view, frames, measure, resize } = settlingView(context);
  let done = 0;
  restoreCodeMirrorScroll(view, { editorScrollOffset: 0, editorScrollPos: 640 }, () => { done++; });
  frames.run();
  measure();
  resize({ width: 0 });
  assert.equal(done, 1);
});

test("heights that never settle are held for a limited time", (context) => {
  const { view, frames, measure, resize, tick } = settlingView(context);
  let done = 0;
  restoreCodeMirrorScroll(view, { editorScrollOffset: 0, editorScrollPos: 640 }, () => { done++; });
  frames.run();
  measure();
  for (let elapsed = 0; elapsed < RESTORE_HOLD_LIMIT_MS; elapsed += RESTORE_SETTLE_MS / 2) {
    assert.equal(done, 0);
    resize({ contentHeight: 50000 + elapsed });
    tick(RESTORE_SETTLE_MS / 2);
  }
  assert.equal(done, 1);
});

test("closing the tab while holding cancels without reporting done", (context) => {
  const { view, frames, measure, observers, listeners } = settlingView(context);
  let done = 0;
  const cancel = restoreCodeMirrorScroll(view, { editorScrollOffset: 0, editorScrollPos: 640 }, () => { done++; });
  frames.run();
  measure();
  cancel!();
  context.mock.timers.tick(RESTORE_HOLD_LIMIT_MS);
  assert.equal(done, 0);
  assert.ok(observers.every((observer) => observer.disconnected));
  assert.equal(listeners.size, 0);
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
