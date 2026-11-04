import assert from "node:assert/strict";
import test from "node:test";

import { pdfAnchorScrollTop, pdfPageAnchorAt } from "../../src/lib/latex/pdf-scroll-anchor";

const PADDING = 16;
const GAP = 14;

/* The preview's layout for pages of the given heights at a scale. */
function layout(pages: number[], scale: number) {
  const heights = pages.map((height) => height * scale);
  const tops: number[] = [];
  let top = PADDING;
  for (const height of heights) {
    tops.push(top);
    top += height + GAP;
  }
  return { tops, heights };
}

const PAGES = Array.from({ length: 230 }, () => 792);

test("the same spot of the same page survives any scale", () => {
  const wide = layout(PAGES, 1.2);
  const scrollTop = wide.tops[69] + wide.heights[69] * 0.25;
  const anchor = pdfPageAnchorAt(scrollTop, wide.tops, wide.heights)!;
  assert.equal(anchor.page, 69);
  assert.ok(Math.abs(anchor.offset - 0.25) < 1e-9);

  // Fit-to-width at a narrower pane: the pixel offset would be page ~174 here.
  const narrow = layout(PAGES, 0.45);
  const restored = pdfAnchorScrollTop(anchor, narrow.tops, narrow.heights);
  assert.ok(Math.abs(restored - (narrow.tops[69] + narrow.heights[69] * 0.25)) < 1e-6);
  const again = pdfPageAnchorAt(restored, narrow.tops, narrow.heights)!;
  assert.equal(again.page, 69);
  assert.ok(Math.abs(again.offset - anchor.offset) < 1e-9);
});

test("repeated round trips do not move the reader", () => {
  let anchor = pdfPageAnchorAt(50000, layout(PAGES, 1).tops, layout(PAGES, 1).heights)!;
  const first = anchor;
  for (const scale of [0.5, 1.4, 0.8, 2, 1]) {
    const { tops, heights } = layout(PAGES, scale);
    anchor = pdfPageAnchorAt(pdfAnchorScrollTop(anchor, tops, heights), tops, heights)!;
  }
  assert.equal(anchor.page, first.page);
  assert.ok(Math.abs(anchor.offset - first.offset) < 1e-9);
});

test("pages of different sizes are measured individually", () => {
  const { tops, heights } = layout([300, 900, 300], 1);
  assert.deepEqual(pdfPageAnchorAt(tops[1] + 450, tops, heights), { page: 1, offset: 0.5 });
  assert.deepEqual(pdfPageAnchorAt(tops[2], tops, heights), { page: 2, offset: 0 });
});

test("the top of the document stays the top, above the first page's margin", () => {
  const { tops, heights } = layout(PAGES, 1);
  const anchor = pdfPageAnchorAt(0, tops, heights)!;
  assert.deepEqual(anchor, { page: 0, offset: 0 });
  assert.equal(pdfAnchorScrollTop(anchor, tops, heights), 0);
});

test("a position in the gap after a page keeps its place", () => {
  const { tops, heights } = layout(PAGES, 1);
  const inGap = tops[3] + heights[3] + GAP / 2;
  const anchor = pdfPageAnchorAt(inGap, tops, heights)!;
  assert.equal(anchor.page, 3);
  assert.equal(pdfAnchorScrollTop(anchor, tops, heights), inGap);
});

test("a build with fewer pages goes to its last page", () => {
  const { tops, heights } = layout([792, 792], 1);
  assert.equal(pdfAnchorScrollTop({ page: 40, offset: 0.5 }, tops, heights), tops[1] + heights[1] * 0.5);
});

test("no pages have no position", () => {
  assert.equal(pdfPageAnchorAt(100, [], []), null);
  assert.equal(pdfAnchorScrollTop({ page: 3, offset: 0.5 }, [], []), 0);
});
