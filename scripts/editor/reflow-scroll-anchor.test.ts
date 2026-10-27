import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { REFLOW_FOLLOW_MS, keepScrollOnReflow } from "../../src/lib/reflow-scroll-anchor";

/* A scroller whose width the test sets, with a ResizeObserver that fires only
 * when the test says layout changed, and an adapter that records calls. */
function mountScroller(initialWidth = 600) {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  let width = initialWidth;
  Object.defineProperty(container, "clientWidth", { get: () => width });
  const content = dom.window.document.createElement("div");
  container.append(content);
  let contentHeight = 2000;
  Object.defineProperty(content, "offsetHeight", { get: () => contentHeight });
  const observers: Array<() => void> = [];
  class FakeResizeObserver {
    connected = true;
    constructor(callback: () => void) { observers.push(() => { if (this.connected) callback(); }); }
    observe() {}
    disconnect() { this.connected = false; }
  }
  Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, value: FakeResizeObserver });

  let next = 0;
  let paused = false;
  const applied: number[] = [];
  const release = keepScrollOnReflow(container, {
    capture: () => ++next,
    apply: (anchor) => { applied.push(anchor); },
    paused: () => paused,
    content,
  });
  const frame = () => new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  return {
    applied, release,
    setPaused(value: boolean) { paused = value; },
    resize(nextWidth: number) {
      width = nextWidth;
      for (const notify of observers) notify();
    },
    /** A live block above the anchor reporting its new height late. */
    settleContent(height: number) {
      contentHeight = height;
      for (const notify of observers) notify();
    },
    userInput(type: string) { container.dispatchEvent(new dom.window.Event(type)); },
    async scroll() {
      container.dispatchEvent(new dom.window.Event("scroll"));
      await frame();
    },
    frame,
    close() { release(); dom.window.close(); },
  };
}

test("a width change re-applies the anchor captured before it", async () => {
  const page = mountScroller();
  await page.frame();
  await page.scroll();
  page.resize(420);
  assert.deepEqual(page.applied, [2]);
  page.close();
});

test("the panel's width transition keeps re-applying the original anchor", async () => {
  const page = mountScroller();
  await page.frame();
  page.resize(560);
  // The corrective scroll must not replace the anchor mid-transition.
  await page.scroll();
  page.resize(500);
  page.resize(420);
  assert.deepEqual(page.applied, [1, 1, 1]);
  page.close();
});

test("the user's own input ends the transition and recaptures", async () => {
  const page = mountScroller();
  await page.frame();
  page.resize(500);
  page.userInput("wheel");
  await page.scroll();
  page.resize(420);
  assert.deepEqual(page.applied, [1, 2]);
  page.close();
});

test("hidden tabs and a running tab restore are left alone", async () => {
  const page = mountScroller();
  await page.frame();
  page.resize(0);
  page.resize(600);
  assert.deepEqual(page.applied, [], "showing a hidden tab belongs to the tab restore");

  await page.frame();
  page.setPaused(true);
  page.resize(420);
  assert.deepEqual(page.applied, [], "an active tab restore owns the position");
  page.close();
});

test("blocks settling their height after the width change are followed, within the window only", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const page = mountScroller();
  await page.frame();
  page.settleContent(2100);
  assert.deepEqual(page.applied, [], "typing and late images outside a width change are left alone");

  page.resize(420);
  now += 50;
  page.settleContent(2300);
  assert.deepEqual(page.applied, [1, 1], "a live frame reporting its height re-applies the same anchor");

  now += 200;
  page.settleContent(2400);
  now += REFLOW_FOLLOW_MS - 200;
  page.settleContent(2500);
  assert.deepEqual(page.applied, [1, 1, 1], "height changes do not extend the window");
  page.close();
});

test("a content height change after the user takes over is left alone", async () => {
  const page = mountScroller();
  await page.frame();
  page.resize(420);
  page.userInput("keydown");
  page.settleContent(2300);
  assert.deepEqual(page.applied, [1]);
  page.close();
});

test("nothing is applied after release", async () => {
  const page = mountScroller();
  await page.frame();
  page.release();
  page.resize(420);
  assert.deepEqual(page.applied, []);
  page.close();
});
