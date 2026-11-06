import assert from "node:assert/strict";
import test from "node:test";

import { relocateQuote, type QuotePage, type QuoteTextItem } from "../../src/lib/pdf-quote-rects";

const item = (str: string, x: number, y: number, width: number, hasEOL = false): QuoteTextItem => ({ str, hasEOL, width, height: 10, transform: [10, 0, 0, 10, x, y] });

const page = (pageNumber: number, items: QuoteTextItem[]): QuotePage => ({ pageNumber, items, width: 600, height: 800 });

test("a passage on one line maps to a rectangle in page fractions", () => {
  const found = relocateQuote("brown fox", [page(1, [item("the quick brown fox jumps", 100, 700, 250)])]);
  assert.ok(found);
  assert.equal(found.pageNumber, 1);
  assert.equal(found.rects.length, 1);
  const [rect] = found.rects;
  assert.ok(Math.abs(rect.x - 200 / 600) < 1e-9);
  assert.ok(Math.abs(rect.width - 90 / 600) < 1e-9);
  assert.ok(Math.abs(rect.y - 90 / 800) < 1e-9, "the page's y runs up, a mark's runs down");
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
