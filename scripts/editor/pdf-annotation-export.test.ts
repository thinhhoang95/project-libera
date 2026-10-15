import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, degrees } from "pdf-lib";
import {
  PdfExportError,
  burnPdfAnnotations,
  invertMatrix,
  pdfPageViewport,
} from "../../src/lib/pdf-annotation-export";
import type { PdfAnnotation } from "../../src/lib/types";

const require = createRequire(import.meta.url);
const base = { createdAt: "2026-10-15", updatedAt: "2026-10-15" };

/** Pages that exercise every part of the display transform. */
async function samplePdf() {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  const rotated = document.addPage([600, 800]);
  rotated.setRotation(degrees(90));
  rotated.setCropBox(50, 100, 400, 500);
  const upsideDown = document.addPage([500, 400]);
  upsideDown.setRotation(degrees(-90));
  upsideDown.setMediaBox(-20, 30, 500, 400);

  return document.save();
}

function apply([a, b, c, d, e, f]: number[], x: number, y: number) {
  return [a * x + c * y + e, b * x + d * y + f];
}

test("viewport math matches PDF.js for crop boxes and every rotation", async () => {
  const bytes = await samplePdf();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const reference = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages = (await PDFDocument.load(bytes)).getPages();

  try {
    for (const [index, page] of pages.entries()) {
      const expected = (await reference.getPage(index + 1)).getViewport({ scale: 1 });
      const ours = pdfPageViewport(page);

      assert.ok(Math.abs(ours.width - expected.width) < 1e-9 && Math.abs(ours.height - expected.height) < 1e-9, `page ${index + 1} size`);

      for (const [fx, fy] of [[0, 0], [1, 0], [0.25, 0.75], [1, 1]]) {
        const [x, y] = apply(invertMatrix(ours.transform), fx * ours.width, fy * ours.height);
        const [ex, ey] = expected.convertToPdfPoint(fx * expected.width, fy * expected.height);

        assert.ok(Math.abs(x - ex) < 1e-6 && Math.abs(y - ey) < 1e-6, `page ${index + 1} maps (${fx}, ${fy})`);
      }
    }
  } finally {
    await reference.destroy();
  }
});

function pageContent(document: PDFDocument, pageIndex: number) {
  const contents = document.getPages()[pageIndex].node.Contents();
  const streams = !contents ? [] : contents instanceof PDFArray ? contents.asArray() : [contents];

  return streams
    .map((ref) => document.context.lookup(ref) as PDFRawStream)
    .map((stream) => {
      const raw = Buffer.from(stream.getContents());
      return stream.dict.has(PDFName.of("Filter")) ? inflateSync(raw).toString("latin1") : raw.toString("latin1");
    })
    .join("\n");
}

test("annotations burn into page content in the viewer's layering, leaving untouched pages alone", async () => {
  const annotations: PdfAnnotation[] = [
    { ...base, id: "note", type: "text", pageNumber: 1, text: "Hello", fontSize: 10, rect: { x: 0.5, y: 0.5, width: 0.2, height: 0.05 } },
    { ...base, id: "hl", type: "highlight", pageNumber: 1, color: "#ffe45c", rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }] },
    { ...base, id: "u", type: "highlight", pageNumber: 1, color: "#d92d20", markup: "squiggly", rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }] },
    { ...base, id: "e", type: "shape", pageNumber: 1, shape: "ellipse", color: "#1d4ed8", strokeWidth: 2, from: { x: 0.1, y: 0.3 }, to: { x: 0.4, y: 0.4 } },
    { ...base, id: "a", type: "shape", pageNumber: 1, shape: "arrow", color: "#1d4ed8", strokeWidth: 2, from: { x: 0.5, y: 0.3 }, to: { x: 0.8, y: 0.4 } },
    { ...base, id: "i", type: "ink", pageNumber: 2, color: "#17753a", strokeWidth: 4, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.15 }, { x: 0.3, y: 0.1 }] },
    { ...base, id: "gone", type: "ink", pageNumber: 9, color: "#17753a", strokeWidth: 4, points: [{ x: 0.1, y: 0.1 }] },
  ];
  const notes: string[] = [];
  // A 1×1 PNG; the browser renderer is replaced so only placement is tested.
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const burned = await burnPdfAnnotations(await samplePdf(), annotations, {
    renderNote: async (annotation, box) => {
      notes.push(annotation.id);
      assert.ok(Math.abs(box.width - 0.2 * 612) < 1e-9 && Math.abs(box.maxHeight - 0.5 * 792) < 1e-9);
      return { png, width: box.width, height: 50 };
    },
  });
  const document = await PDFDocument.load(burned);
  const first = pageContent(document, 0);

  assert.deepEqual(notes, ["note"]);
  // Undo the y-down viewport of an unrotated 612×792 page.
  assert.match(first, /1 0 -?0 -1 0 792 cm/);
  assert.match(first, /\/LiberaGS-?\d* gs/, "markup multiplies onto the page");
  assert.match(first, / re\nf/, "highlight band is filled");
  assert.match(first, / c\n/, "curves for the wave and ellipse");
  assert.doesNotMatch(first, / v\n/, "no start-anchored cubics posing as quadratics");
  assert.match(first, /\/LiberaNote-?\d* Do/, "note image is placed");
  assert.ok(first.indexOf(" gs") < first.indexOf(" Do"), "notes sit above markup");
  const resources = document.getPages()[0].node.Resources()!;
  const states = resources.lookup(PDFName.of("ExtGState")) as import("pdf-lib").PDFDict;
  const state = document.context.lookup(states.values()[0]) as import("pdf-lib").PDFDict;
  assert.equal(String(state.get(PDFName.of("BM"))), "/Multiply");

  assert.match(pageContent(document, 1), /0\.0901\d* 0\.4588\d* 0\.2274\d* RG/, "ink keeps its color");
  assert.doesNotMatch(pageContent(document, 2), /Libera/, "pages without annotations are left alone");
});

test("encrypted PDFs fail with a clear message instead of a broken file", async () => {
  const document = await PDFDocument.create();
  document.addPage();
  // pdf-lib cannot write encryption, so mark the trailer as encrypted.
  document.context.trailerInfo.Encrypt = document.context.obj({ Filter: "Standard" });
  const bytes = await document.save({ useObjectStreams: false });

  await assert.rejects(burnPdfAnnotations(bytes, []), PdfExportError);
});
