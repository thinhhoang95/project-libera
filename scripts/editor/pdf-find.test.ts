import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { PDFDocumentProxy, PDFPageProxy, TextContent } from "pdfjs-dist/types/src/display/api";
import { PdfSearchIndex, buildPdfSearchPage, findPdfMatches, highlightPdfMatches } from "../../src/components/libera/pdf-find";
import { PdfTextContentCache } from "../../src/components/libera/pdf-rendering";

test("PDF search maps split words, line breaks, empty items, and literal punctuation to text spans", () => {
  const page = buildPdfSearchPage({ items: [
    { type: "beginMarkedContent", id: "test" },
    { str: "A nee", hasEOL: false }, { str: "", hasEOL: false },
    { str: "dle", hasEOL: true }, { str: "across  lines [a].", hasEOL: false },
  ], styles: {} } as TextContent);
  const matches = findPdfMatches([page], "NEEDLE across lines");
  assert.deepEqual(matches, [{ pageNumber: 1, start: 2, end: 22 }]);
  assert.equal(findPdfMatches([page], "[a].").length, 1);
  assert.deepEqual(findPdfMatches([page], "   "), []);
  assert.deepEqual(findPdfMatches([page], "absent"), []);
  const dom = new JSDOM();
  try {
    const divs = ["A nee", "", "dle", "across  lines [a]."].map((text) => {
      const div = dom.window.document.createElement("span"); div.textContent = text; return div;
    });
    const before = divs.map((div) => div.textContent);
    const active = highlightPdfMatches(divs, page, matches, matches[0]);
    assert.equal(active?.textContent, "nee");
    assert.deepEqual(divs.flatMap((div) => Array.from(div.querySelectorAll("mark"), (mark) => mark.textContent)), ["nee", "dle", "across  lines"]);
    assert.deepEqual(divs.map((div) => div.textContent), before);
    highlightPdfMatches(divs, page, [], undefined);
    assert.ok(divs.every((div) => !div.querySelector("mark")));
    assert.deepEqual(divs.map((div) => div.textContent), before);
  } finally { dom.window.close(); }
});

test("PDF search preserves original offsets after Unicode case folding and handles image-only pages", () => {
  assert.deepEqual(findPdfMatches([{ text: "İ needle NEEDLE", items: [] }], "needle"), [
    { pageNumber: 1, start: 2, end: 8 }, { pageNumber: 1, start: 9, end: 15 },
  ]);
  assert.deepEqual(findPdfMatches([buildPdfSearchPage({ items: [], styles: {}, lang: null })], "needle"), []);
});

test("PDF indexing stops after cancellation and resumes using cached text", async () => {
  const content = { items: [{ str: "needle", hasEOL: false }], styles: {} } as TextContent;
  let resolve!: (value: TextContent) => void;
  const pending = new Promise<TextContent>((done) => { resolve = done; });
  const requests: number[] = [];
  let reads = 0;
  const pages = [
    { getTextContent: () => { reads++; return pending; } },
    { getTextContent: async () => { reads++; return content; } },
  ] as PDFPageProxy[];
  const document = {
    numPages: 2, getPage: async (number: number) => { requests.push(number); return pages[number - 1]; },
  } as PDFDocumentProxy;
  const index = new PdfSearchIndex(document, new PdfTextContentCache());
  const controller = new AbortController();
  const indexing = index.read(controller.signal);
  await Promise.resolve();
  controller.abort();
  resolve(content);
  await assert.rejects(indexing, { name: "AbortError" });
  assert.deepEqual(requests, [1]);
  const result = await index.read(new AbortController().signal);
  assert.equal(findPdfMatches(result, "needle").length, 2);
  assert.equal(reads, 2);
  const before = requests.length;
  await index.read(new AbortController().signal);
  assert.equal(requests.length, before, "Changing queries must not re-extract indexed pages");
});
