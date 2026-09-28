import assert from "node:assert/strict";
import test from "node:test";
import type { PDFPageProxy, TextContent } from "pdfjs-dist/types/src/display/api";
import {
  PDF_MAX_CANVAS_DIMENSION,
  PDF_MAX_CANVAS_PIXELS,
  PdfTextContentCache,
  pdfCanvasSize,
} from "../../src/components/libera/pdf-rendering";

const text = { items: [], styles: {}, lang: null } as TextContent;
function page(read: () => Promise<TextContent>) {
  return { getTextContent: read } as PDFPageProxy;
}

test("canvas budget preserves normal resolution and bounds high zoom and oversized pages", () => {
  assert.deepEqual(pdfCanvasSize(612, 792, 2), { width: 1224, height: 1584 });
  for (const [width, height, dpr] of [[2448, 3168, 2], [40000, 1000, 3], [1000, 40000, 2]]) {
    const size = pdfCanvasSize(width, height, dpr);
    assert.ok(size.width * size.height <= PDF_MAX_CANVAS_PIXELS);
    assert.ok(Math.max(size.width, size.height) <= PDF_MAX_CANVAS_DIMENSION);
    assert.ok(Math.abs(size.width / width - size.height / height) < 0.002);
  }
});

test("text cache deduplicates in-flight work, retains recently used pages, and clears per document", async () => {
  const cache = new PdfTextContentCache(2);
  let reads = 0;
  let finish!: (value: TextContent) => void;
  const first = page(() => { reads++; return new Promise((resolve) => { finish = resolve; }); });
  const pending = cache.get(first);
  assert.equal(cache.get(first), pending);
  assert.equal(reads, 1);
  finish(text);
  assert.equal(await pending, text);
  let secondReads = 0;
  const second = page(async () => { secondReads++; return text; });
  await cache.get(second);
  assert.equal(await cache.get(first), text); // Touch first, so second is evicted.
  await cache.get(page(async () => text));
  assert.equal(await cache.get(first), text);
  assert.equal(reads, 1);
  await cache.get(second);
  assert.equal(secondReads, 2);
  cache.clear();
  await cache.get(second);
  assert.equal(secondReads, 3);
  await new PdfTextContentCache().get(second);
  assert.equal(secondReads, 4);
});

test("failed text extraction can retry without evicting a newer in-flight request", async () => {
  const cache = new PdfTextContentCache(1);
  let fail!: (reason: Error) => void;
  let reads = 0;
  const first = page(() => ++reads === 1
    ? new Promise((_, reject) => { fail = reject; })
    : Promise.resolve(text));
  const failed = assert.rejects(cache.get(first), /failed/);
  await cache.get(page(async () => text));
  const retry = cache.get(first);
  fail(new Error("failed"));
  await failed;
  assert.equal(cache.get(first), retry);
  assert.equal(await retry, text);
  const alwaysFails = page(async () => { throw new Error("retryable"); });
  await assert.rejects(cache.get(alwaysFails), /retryable/);
  const again = cache.get(alwaysFails);
  await assert.rejects(again, /retryable/);
});
