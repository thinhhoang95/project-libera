import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { pdfHighlightQuote } from "../../src/lib/pdf-highlight-quote";

test("PDF highlight quotes keep only selected text from each page and join line breaks", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="pdf-text-layer" id="first"><span>Before Alpha\nBeta</span></div>
    <div class="pdf-text-layer" id="middle"><span>Middle\npage</span></div>
    <div class="pdf-text-layer" id="last"><span>Gamma Delta after</span></div>
  </body>`);
  try {
    const first = dom.window.document.getElementById("first")!;
    const middle = dom.window.document.getElementById("middle")!;
    const last = dom.window.document.getElementById("last")!;
    const range = dom.window.document.createRange();
    range.setStart(first.querySelector("span")!.firstChild!, 7);
    range.setEnd(last.querySelector("span")!.firstChild!, 11);

    assert.equal(pdfHighlightQuote(range, first), "Alpha Beta");
    assert.equal(pdfHighlightQuote(range, middle), "Middle page");
    assert.equal(pdfHighlightQuote(range, last), "Gamma Delta");
  } finally {
    dom.window.close();
  }
});
