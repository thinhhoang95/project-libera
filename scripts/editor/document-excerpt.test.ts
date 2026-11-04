import assert from "node:assert/strict";
import test from "node:test";
import { documentExcerpt, documentWindowSent, locateQuote, pagesForDrag, subtractRanges, windowsAround, wordStarts, WORDS_PER_PAGE } from "../../src/lib/document-excerpt";
import { normalizeForMatch } from "../../src/lib/text-match";

const words = (count: number, from = 0) => Array.from({ length: count }, (_, index) => `w${from + index}`).join(" ");
const size = (ranges: { start: number; end: number }[]) => ranges.reduce((sum, range) => sum + range.end - range.start, 0);

test("a single window is centered on the anchor and shifts inward at the ends", () => {
  assert.deepEqual(windowsAround([{ start: 5_000, end: 5_001 }], 1_000, 10_000), [{ start: 4_501, end: 5_501 }]);
  assert.deepEqual(windowsAround([{ start: 0, end: 1 }], 1_000, 10_000), [{ start: 0, end: 1_000 }]);
  assert.deepEqual(windowsAround([{ start: 9_999, end: 10_000 }], 1_000, 10_000), [{ start: 9_000, end: 10_000 }]);
  assert.deepEqual(windowsAround([{ start: 5, end: 6 }], 1_000, 500), [{ start: 0, end: 500 }]);
});

test("two quotes split the budget; merged windows grow outward back to the full budget", () => {
  const apart = windowsAround([{ start: 1_000, end: 1_001 }, { start: 8_000, end: 8_001 }], 1_000, 10_000);
  assert.equal(apart.length, 2);
  assert.equal(apart[0].end - apart[0].start, 500);
  assert.equal(apart[1].end - apart[1].start, 500);
  const close = windowsAround([{ start: 5_000, end: 5_001 }, { start: 5_100, end: 5_101 }], 1_000, 10_000);
  assert.equal(close.length, 1);
  assert.equal(size(close), 1_000);
  assert.ok(close[0].start < 4_800 && close[0].end > 5_300);
});

test("growth blocked by the start of the document continues on the other side", () => {
  const ranges = windowsAround([{ start: 10, end: 11 }, { start: 20, end: 21 }], 1_000, 10_000);
  assert.deepEqual(ranges, [{ start: 0, end: 1_000 }]);
});

test("subtraction keeps only what was not sent", () => {
  assert.deepEqual(subtractRanges([{ start: 0, end: 100 }], [{ start: 20, end: 40 }, { start: 60, end: 200 }]), [{ start: 0, end: 20 }, { start: 40, end: 60 }]);
});

test("without quotes the budget sits on the page in view", () => {
  const text = words(10_000);
  const offset = wordStarts(text)[5_000];
  const part = documentExcerpt({ text, pages: 2, reader: { offset } })!;
  assert.equal(size(part.excerpt.ranges), 2 * WORDS_PER_PAGE);
  assert.ok(part.text.includes("w5000"));
  assert.ok(!part.text.includes("w3000 "));
  assert.ok(part.text.startsWith("[…]") && part.text.endsWith("[…]"));
});

test("quotes take over from the page in view and share the budget", () => {
  const text = words(10_000);
  const part = documentExcerpt({ text, pages: 2, quotes: ["w1000 w1001", "w8000 w8001"], reader: { offset: wordStarts(text)[5_000] } })!;
  assert.equal(part.excerpt.ranges.length, 2);
  assert.equal(size(part.excerpt.ranges), 2 * WORDS_PER_PAGE);
  assert.ok(part.text.includes("w1000") && part.text.includes("w8000"));
  assert.ok(!part.text.includes("w5000"));
});

test("a quote that cannot be found falls back to the other quotes, then the page in view", () => {
  const text = words(10_000);
  const reader = { offset: wordStarts(text)[5_000] };
  const one = documentExcerpt({ text, pages: 1, quotes: ["w1000 w1001", "nowhere in this file"], reader })!;
  assert.equal(one.excerpt.ranges.length, 1);
  assert.ok(one.text.includes("w1000"));
  assert.ok(documentExcerpt({ text, pages: 1, quotes: ["nowhere in this file"], reader })!.text.includes("w5000"));
});

test("a quote from the Visual editor is found in Markdown source", () => {
  const before = words(3_000);
  const text = `${before}\n\nThis **important** claim about [the river](https://example.com) goes on for a good while longer than one chunk of matching text, and keeps going with plain words after it.\n\n${words(3_000, 3_000)}`;
  const quote = "This important claim about the river goes on for a good while longer than one chunk of matching text, and keeps going with plain words after it.";
  const place = locateQuote(quote, normalizeForMatch(text));
  assert.ok(place && Math.abs(place.start - text.indexOf("This **important**")) < 200);
  assert.ok(documentExcerpt({ text, pages: 1, quotes: [quote] })!.text.includes("[the river]"));
});

test("a follow-up quote outside what was sent adds only the text around it", () => {
  const text = words(10_000);
  const first = documentExcerpt({ text, pages: 2, quotes: ["w1000 w1001"] })!;
  const next = documentExcerpt({ text, pages: 2, quotes: ["w1500 w1501"], sent: [first.excerpt] })!;
  assert.ok(next.text.includes("w1800"));
  assert.ok(!next.text.includes("w1000 "));
  for (const range of next.excerpt.ranges) assert.equal(subtractRanges([range], first.excerpt.ranges).length, 1);
  assert.ok(size(next.excerpt.ranges) < 2 * WORDS_PER_PAGE);
});

test("a follow-up quote inside what was sent adds nothing", () => {
  const text = words(10_000);
  const first = documentExcerpt({ text, pages: 2, quotes: ["w1000 w1001"] })!;
  assert.equal(documentExcerpt({ text, pages: 2, quotes: ["w1100 w1101"], sent: [first.excerpt] }), null);
});

test("of two follow-up quotes, the one already sent gives up nothing to the new one's share", () => {
  const text = words(10_000);
  const first = documentExcerpt({ text, pages: 2, quotes: ["w1000 w1001"] })!;
  const next = documentExcerpt({ text, pages: 2, quotes: ["w1100 w1101", "w8000 w8001"], sent: [first.excerpt] })!;
  assert.equal(size(next.excerpt.ranges), WORDS_PER_PAGE);
  assert.ok(next.text.includes("w8000"));
});

test("widening the budget sends only the new edges; all pages sends the rest", () => {
  const text = words(4_000);
  const offset = wordStarts(text)[2_000];
  const first = documentExcerpt({ text, pages: 1, reader: { offset } })!;
  const wider = documentExcerpt({ text, pages: 3, reader: { offset }, sent: [first.excerpt] })!;
  assert.equal(wider.excerpt.ranges.length, 2);
  assert.equal(size(wider.excerpt.ranges), 2 * WORDS_PER_PAGE);
  const rest = documentExcerpt({ text, reader: { offset }, sent: [first.excerpt, wider.excerpt] })!;
  assert.equal(size(rest.excerpt.ranges), 4_000 - 3 * WORDS_PER_PAGE);
  assert.equal(documentExcerpt({ text, reader: { offset }, sent: [first.excerpt, wider.excerpt, rest.excerpt] }), null);
});

test("moving the reader within what was sent adds nothing; moving past it does", () => {
  const text = words(10_000);
  const starts = wordStarts(text);
  const first = documentExcerpt({ text, pages: 2, reader: { offset: starts[5_000] } })!;
  assert.equal(documentExcerpt({ text, pages: 2, reader: { offset: starts[5_200] }, sent: [first.excerpt] }), null);
  assert.ok(documentWindowSent([first.excerpt], { pages: 2, quoted: false, word: 5_200 }));
  assert.ok(documentExcerpt({ text, pages: 2, reader: { offset: starts[5_800] }, sent: [first.excerpt] }));
  assert.equal(documentWindowSent([first.excerpt], { pages: 2, quoted: false, word: 5_800 }), false);
  assert.equal(documentWindowSent([first.excerpt], { pages: 3, quoted: false, word: 5_200 }), false);
  assert.equal(documentWindowSent([first.excerpt], { pages: 2, quoted: true, word: 5_200 }), false);
});

test("a PDF page is the document's average page and keeps its page headings", () => {
  const text = Array.from({ length: 20 }, (_, index) => `## Page ${index + 1}\n\n${words(300, index * 1_000)}`).join("\n\n");
  const part = documentExcerpt({ text, pages: 3, pdf: true, reader: { page: 10 } })!;
  assert.ok(Math.abs(size(part.excerpt.ranges) - 3 * wordStarts(text).length / 20) <= 1);
  assert.ok(part.excerpt.pdfPages?.includes(10));
  assert.ok(/## Page \d+( \(continued\))?/.test(part.text));
  assert.ok(part.text.includes("w9000"));
  assert.ok(documentWindowSent([part.excerpt], { pages: 3, quoted: false, pdfPage: 10 }));
  assert.equal(documentWindowSent([part.excerpt], { pages: 3, quoted: false, pdfPage: 18 }), false);
});

test("dragging is logarithmic, stays in range and reaches both ends", () => {
  assert.equal(pagesForDrag(300, 300, 50), 300);
  assert.equal(pagesForDrag(300, 300, -500), 1);
  assert.equal(pagesForDrag(1, 300, 500), 300);
  const first = pagesForDrag(300, 300, -110);
  assert.ok(first > 10 && first < 30);
});
