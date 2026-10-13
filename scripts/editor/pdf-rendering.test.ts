import assert from "node:assert/strict";
import test from "node:test";
import type { PDFPageProxy, TextContent } from "pdfjs-dist/types/src/display/api";
import {
  PDF_MAX_CANVAS_DIMENSION,
  PDF_DETAIL_MARGIN,
  PDF_MAX_CANVAS_PIXELS,
  PDF_MAX_DETAIL_PIXELS,
  PdfTextContentCache,
  pdfCanvasSize,
  pdfDetailRegion,
  pdfRectContains,
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

test("detail region is only used when the page canvas is capped and covers the visible area at full resolution", () => {
  const screen = { x: 0, y: 0, width: 1200, height: 900 };
  assert.equal(pdfDetailRegion(612 * 2, 792 * 2, screen, 2), null);
  assert.equal(pdfDetailRegion(612 * 4, 792 * 4, screen, 1), null);

  // 400% Letter page on a Retina display, scrolled into the middle.
  const visible = { x: 600.5, y: 1500.25, width: 1200, height: 900 };
  const detail = pdfDetailRegion(612 * 4, 792 * 4, visible, 2)!;
  assert.ok(pdfRectContains(detail.rect, visible));
  assert.deepEqual(detail.rect, {
    x: 600 - PDF_DETAIL_MARGIN,
    y: 1500 - PDF_DETAIL_MARGIN,
    width: 1201 + PDF_DETAIL_MARGIN * 2,
    height: 901 + PDF_DETAIL_MARGIN * 2,
  });
  assert.deepEqual({ width: detail.width, height: detail.height }, { width: detail.rect.width * 2, height: detail.rect.height * 2 });

  // Clamped to the page at its edges.
  const corner = pdfDetailRegion(612 * 4, 792 * 4, { x: 0, y: 0, width: 300, height: 200 }, 2)!;
  assert.deepEqual(corner.rect, { x: 0, y: 0, width: 300 + PDF_DETAIL_MARGIN, height: 200 + PDF_DETAIL_MARGIN });
  assert.equal(pdfDetailRegion(612 * 4, 792 * 4, { x: 0, y: 0, width: 0, height: 200 }, 2), null);
});

test("detail region drops its margin, then resolution, to stay within the pixel budget", () => {
  const page = { width: 612 * 5, height: 792 * 5 };
  // A full-screen 6K window keeps full resolution but loses its margin.
  const large = { x: 0, y: 400, width: 3008, height: 1692 };
  const noMargin = pdfDetailRegion(page.width, page.height, large, 2)!;
  assert.deepEqual(noMargin.rect, large);
  assert.deepEqual({ width: noMargin.width, height: noMargin.height }, { width: 6016, height: 3384 });

  const huge = { x: 0, y: 0, width: 3000, height: 3000 };
  const capped = pdfDetailRegion(page.width, page.height, huge, 2)!;
  assert.deepEqual(capped.rect, huge);
  assert.ok(capped.width * capped.height <= PDF_MAX_DETAIL_PIXELS);
  assert.ok(capped.width < huge.width * 2);
  // Still sharper than the capped page canvas.
  assert.ok(capped.width / huge.width > pdfCanvasSize(page.width, page.height, 2).width / page.width);
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
