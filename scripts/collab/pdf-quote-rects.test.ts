import assert from "node:assert/strict";
import test from "node:test";

import { relocateQuote, type QuotePage, type QuoteTextItem } from "../../src/lib/pdf-quote-rects";

const item = (str: string, x: number, y: number, width: number, hasEOL = false): QuoteTextItem => ({ str, hasEOL, width, height: 10, transform: [10, 0, 0, 10, x, y] });

const page = (pageNumber: number, items: QuoteTextItem[]): QuotePage => ({ pageNumber, items, width: 600, height: 800, toViewport: (x, y) => [x, 800 - y] });

test("a passage on one line maps to a rectangle in page fractions", () => {
  const found = relocateQuote("brown fox", [page(1, [item("the quick brown fox jumps", 100, 700, 250)])]);
  assert.ok(found);
  assert.equal(found.pageNumber, 1);
  assert.equal(found.rects.length, 1);
  const [rect] = found.rects;
  assert.ok(Math.abs(rect.x - 200 / 600) < 1e-9);
  assert.ok(Math.abs(rect.width - 90 / 600) < 1e-9);
  assert.ok(Math.abs(rect.y - 90 / 800) < 1e-9, "the page's y runs up, a mark's runs down");
  assert.ok(Math.abs(rect.height - 10 / 800) < 1e-9);
});

test("a passage across lines gives a rectangle per line, whatever the spacing", () => {
  const found = relocateQuote("end of   line next one", [page(3, [item("the end of line", 100, 700, 150, true), item("next one here", 100, 680, 130)])]);
  assert.equal(found?.rects.length, 2);
});

test("it may move to another page", () => {
  const found = relocateQuote("moved text", [page(1, [item("nothing here", 0, 0, 100)]), page(2, [item("this is moved text", 0, 0, 180)])]);
  assert.equal(found?.pageNumber, 2);
});

test("a passage found twice, or not at all, stays put", () => {
  assert.equal(relocateQuote("twice", [page(1, [item("twice and twice", 0, 0, 150)])]), null);
  assert.equal(relocateQuote("twice", [page(1, [item("twice", 0, 0, 50)]), page(2, [item("twice", 0, 0, 50)])]), null);
  assert.equal(relocateQuote("gone", [page(1, [item("something else", 0, 0, 140)])]), null);
  assert.equal(relocateQuote("   ", [page(1, [item("text", 0, 0, 40)])]), null);
});

test("special characters in a quote are plain text", () => {
  assert.ok(relocateQuote("f(x) = [a+b]*", [page(1, [item("so f(x) = [a+b]* here", 0, 0, 200)])]));
});

test("a rotated page and a crop box go through the page's own viewport", () => {
  // Rotated 90 degrees, cropped so user space starts at (50, 20): displayed 800 wide, 600 tall.
  const rotated: QuotePage = { pageNumber: 1, items: [item("find this", 150, 120, 90)], width: 800, height: 600, toViewport: (x, y) => [y - 20, x - 50] };
  const found = relocateQuote("find this", [rotated]);
  assert.ok(found);
  const [rect] = found.rects;
  assert.ok(Math.abs(rect.x - 100 / 800) < 1e-9, `x ${rect.x}`);
  assert.ok(Math.abs(rect.y - 100 / 600) < 1e-9, `y ${rect.y}`);
  assert.ok(Math.abs(rect.height - 90 / 600) < 1e-9, "the text runs down the displayed page");
});

test("text running up a page is measured along its own direction", () => {
  const vertical: QuoteTextItem = { str: "up", width: 20, height: 10, transform: [0, 10, -10, 0, 100, 100] };
  const found = relocateQuote("up", [page(1, [vertical])]);
  assert.ok(found);
  const [rect] = found.rects;
  assert.ok(Math.abs(rect.height - 20 / 800) < 1e-9, `height ${rect.height}`);
  assert.ok(Math.abs(rect.width - 10 / 600) < 1e-9, `width ${rect.width}`);
});
