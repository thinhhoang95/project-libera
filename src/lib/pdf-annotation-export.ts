import {
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  type PDFName,
  type PDFOperator,
  type PDFPage,
  appendBezierCurve,
  clip,
  closePath,
  concatTransformationMatrix,
  drawObject,
  endPath,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
} from "pdf-lib";
import { mergeHighlightRects } from "@/lib/pdf-annotation-style";
import { arrowHeadPoints, arrowShaftEnd, isClosedShape } from "@/lib/pdf-drawing";
import type {
  PdfAnnotation,
  PdfHighlightAnnotation,
  PdfInkAnnotation,
  PdfShapeAnnotation,
  PdfTextAnnotation,
} from "@/lib/types";

/*
 * Burns Libera's annotations into a copy of a PDF as ordinary page content,
 * so every PDF reader shows them and nothing can be edited or hidden.
 *
 * Annotations are stored as fractions of the page as PDF.js displays it
 * (crop box, rotation applied). Each page's drawing first undoes that
 * display transform, so everything below is drawn in the same y-down
 * "viewport" points the viewer uses at 100% zoom.
 */

type Point = { x: number; y: number };
type Matrix = [number, number, number, number, number, number];

/** A text note rendered to PNG; sizes are in PDF points. */
export type PdfNoteImage = { png: Uint8Array; width: number; height: number };

/**
 * Renders a note at its size on the page. Notes are Markdown with math,
 * which only a browser lays out faithfully, so the caller supplies this.
 */
export type RenderPdfNote = (
  annotation: PdfTextAnnotation,
  box: { width: number; height: number; maxHeight: number },
) => Promise<PdfNoteImage | null>;

export class PdfExportError extends Error {}

type PageViewport = { transform: Matrix; width: number; height: number };

function normalizedBox(box: { x: number; y: number; width: number; height: number }) {
  return [
    Math.min(box.x, box.x + box.width),
    Math.min(box.y, box.y + box.height),
    Math.max(box.x, box.x + box.width),
    Math.max(box.y, box.y + box.height),
  ] as const;
}

/** The page as PDF.js shows it at scale 1: crop box ∩ media box, rotated. */
export function pdfPageViewport(page: Pick<PDFPage, "getMediaBox" | "getCropBox" | "getRotation">): PageViewport {
  let mediaBox: readonly number[] = [0, 0, 612, 792];

  try {
    mediaBox = normalizedBox(page.getMediaBox());
  } catch {
    // PDF.js falls back to US Letter when a page has no usable MediaBox.
  }

  let view = mediaBox;

  try {
    const crop = normalizedBox(page.getCropBox());
    const box = [
      Math.max(crop[0], mediaBox[0]),
      Math.max(crop[1], mediaBox[1]),
      Math.min(crop[2], mediaBox[2]),
      Math.min(crop[3], mediaBox[3]),
    ];

    if (box[2] - box[0] > 0 && box[3] - box[1] > 0) {
      view = box;
    }
  } catch {
    // No crop box: the media box is the view.
  }

  const angle = page.getRotation().angle;
  const rotation = angle % 90 === 0 ? ((angle % 360) + 360) % 360 : 0;
  const [a, b, c, d] = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[rotation as 0 | 90 | 180 | 270];
  const centerX = (view[2] + view[0]) / 2;
  const centerY = (view[3] + view[1]) / 2;
  const sideways = a === 0;
  const offsetX = sideways ? Math.abs(centerY - view[1]) : Math.abs(centerX - view[0]);
  const offsetY = sideways ? Math.abs(centerX - view[0]) : Math.abs(centerY - view[1]);

  return {
    transform: [a, b, c, d, offsetX - a * centerX - c * centerY, offsetY - b * centerX - d * centerY],
    width: sideways ? view[3] - view[1] : view[2] - view[0],
    height: sideways ? view[2] - view[0] : view[3] - view[1],
  };
}

export function invertMatrix([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;

  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function rgb(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);

  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255] as const;
}

const fillColor = (hex: string) => setFillingRgbColor(...rgb(hex));
const strokeColor = (hex: string) => setStrokingRgbColor(...rgb(hex));

/**
 * An exact quadratic segment. pdf-lib's appendQuadraticCurve writes PDF's
 * `v`, a cubic whose first control point is the start, which bends differently.
 */
function quadTo(from: Point, control: Point, to: Point) {
  return appendBezierCurve(
    from.x + (2 / 3) * (control.x - from.x),
    from.y + (2 / 3) * (control.y - from.y),
    to.x + (2 / 3) * (control.x - to.x),
    to.y + (2 / 3) * (control.y - to.y),
    to.x,
    to.y,
  );
}

function polygon(points: Point[]): PDFOperator[] {
  return [
    moveTo(points[0].x, points[0].y),
    ...points.slice(1).map((point) => lineTo(point.x, point.y)),
    closePath(),
  ];
}

/** Four Bézier quarters: the standard circle approximation, per axis. */
function ellipse(cx: number, cy: number, rx: number, ry: number): PDFOperator[] {
  const k = 0.5522847498;

  return [
    moveTo(cx + rx, cy),
    appendBezierCurve(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
    appendBezierCurve(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
    appendBezierCurve(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
    appendBezierCurve(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy),
    closePath(),
  ];
}

/** Same smoothing as the on-screen pen: quadratics through sample midpoints. */
function inkPath(points: Point[]): PDFOperator[] {
  const [first] = points;

  if (points.length < 3) {
    const last = points.at(-1) ?? first;

    return [moveTo(first.x, first.y), lineTo(last.x, last.y)];
  }

  const ops = [moveTo(first.x, first.y)];
  let current = first;

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    const middle = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };

    ops.push(quadTo(current, point, middle));
    current = middle;
  }

  const last = points[points.length - 1];

  return [...ops, lineTo(last.x, last.y)];
}

function strokeStyle(color: string, width: number): PDFOperator[] {
  return [
    strokeColor(color),
    setLineWidth(width),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
  ];
}

/**
 * Markup in the viewer sits in a multiply-blended layer: highlighter ink
 * tints the paper while black glyphs stay black. The same blend mode keeps
 * burned-in highlights from hiding the text they mark.
 */
function markupOps(annotation: PdfHighlightAnnotation, size: { width: number; height: number }, multiply: PDFName): PDFOperator[] {
  const bands = mergeHighlightRects(annotation.rects, size.width, size.height).map((rect) => ({
    x: rect.x * size.width,
    y: rect.y * size.height,
    width: rect.width * size.width,
    height: rect.height * size.height,
  }));
  const ops: PDFOperator[] = [pushGraphicsState(), setGraphicsState(multiply)];

  for (const band of bands) {
    const thickness = Math.max(1.25, band.height * 0.07);

    if (!annotation.markup) {
      ops.push(fillColor(annotation.color), rectangle(band.x - 1, band.y, band.width + 2, band.height), fill());
    } else if (annotation.markup === "underline") {
      ops.push(fillColor(annotation.color), rectangle(band.x, band.y + band.height * 0.96 - thickness, band.width, thickness), fill());
    } else if (annotation.markup === "strikethrough") {
      ops.push(fillColor(annotation.color), rectangle(band.x, band.y + band.height * 0.52 - thickness / 2, band.width, thickness), fill());
    } else {
      // A wave two of its heights long per period, clipped to the run.
      const waveHeight = Math.max(4, band.height * 0.2);
      const top = band.y + band.height * 1.04 - waveHeight;
      const middle = top + waveHeight / 2;
      const period = waveHeight * 2;
      const wave: PDFOperator[] = [moveTo(band.x, middle)];

      for (let x = band.x; x < band.x + band.width; x += period) {
        const half = { x: x + period / 2, y: middle };

        wave.push(
          quadTo({ x, y: middle }, { x: x + period / 4, y: top }, half),
          quadTo(half, { x: x + (period * 3) / 4, y: top + waveHeight }, { x: x + period, y: middle }),
        );
      }

      ops.push(
        pushGraphicsState(),
        rectangle(band.x, top - waveHeight, band.width, waveHeight * 3),
        clip(),
        endPath(),
        ...strokeStyle(annotation.color, (waveHeight * 1.5) / 4),
        ...wave,
        stroke(),
        popGraphicsState(),
      );
    }
  }

  return [...ops, popGraphicsState()];
}

function shapeOps(annotation: PdfShapeAnnotation, size: { width: number; height: number }): PDFOperator[] {
  const from = { x: annotation.from.x * size.width, y: annotation.from.y * size.height };
  const to = { x: annotation.to.x * size.width, y: annotation.to.y * size.height };
  const ops = [pushGraphicsState(), ...strokeStyle(annotation.color, annotation.strokeWidth)];

  if (isClosedShape(annotation.shape)) {
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const width = Math.abs(to.x - from.x);
    const height = Math.abs(to.y - from.y);

    ops.push(
      ...(annotation.shape === "rectangle"
        ? [rectangle(left, top, width, height)]
        : ellipse(left + width / 2, top + height / 2, width / 2, height / 2)),
      stroke(),
    );
  } else if (annotation.shape === "arrow") {
    const shaftEnd = arrowShaftEnd(from, to, annotation.strokeWidth);
    const head = arrowHeadPoints(from, to, annotation.strokeWidth)
      .split(" ")
      .map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return { x, y };
      });

    ops.push(
      moveTo(from.x, from.y),
      lineTo(shaftEnd.x, shaftEnd.y),
      stroke(),
      fillColor(annotation.color),
      setLineWidth(Math.max(1, annotation.strokeWidth / 2)),
      ...polygon(head),
      // Fill, then stroke the same outline to round the head's corners.
      fill(),
      ...polygon(head),
      stroke(),
    );
  } else {
    ops.push(moveTo(from.x, from.y), lineTo(to.x, to.y), stroke());
  }

  return [...ops, popGraphicsState()];
}

function inkOps(annotation: PdfInkAnnotation, size: { width: number; height: number }): PDFOperator[] {
  const points = annotation.points.map((point) => ({ x: point.x * size.width, y: point.y * size.height }));

  return [pushGraphicsState(), ...strokeStyle(annotation.color, annotation.strokeWidth), ...inkPath(points), stroke(), popGraphicsState()];
}

/** Viewer layering: highlights under drawings, notes on top of both. */
function layer(annotation: PdfAnnotation) {
  return annotation.type === "highlight" ? 0 : annotation.type === "text" ? 2 : 1;
}

export async function burnPdfAnnotations(
  source: Uint8Array | ArrayBuffer,
  annotations: readonly PdfAnnotation[],
  { renderNote }: { renderNote?: RenderPdfNote } = {},
): Promise<Uint8Array> {
  let document: PDFDocument;

  try {
    document = await PDFDocument.load(source, { updateMetadata: false });
  } catch (error) {
    // pdf-lib's errors are ES5 subclasses, so `instanceof` cannot tell them apart.
    if (error instanceof Error && /\bis encrypted\b/.test(error.message)) {
      throw new PdfExportError("This PDF is encrypted, so annotations cannot be added to it. Download the original instead.");
    }

    throw error;
  }

  const pages = document.getPages();
  const multiply = document.context.register(document.context.obj({ Type: "ExtGState", BM: "Multiply" }));
  const byPage = new Map<number, PdfAnnotation[]>();

  for (const annotation of annotations) {
    if (annotation.pageNumber >= 1 && annotation.pageNumber <= pages.length) {
      byPage.set(annotation.pageNumber, [...(byPage.get(annotation.pageNumber) ?? []), annotation]);
    }
  }

  for (const [pageNumber, pageAnnotations] of byPage) {
    const page = pages[pageNumber - 1];
    const viewport = pdfPageViewport(page);
    const size = { width: viewport.width, height: viewport.height };
    const multiplyName = page.node.newExtGState("LiberaGS", multiply);
    const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(...invertMatrix(viewport.transform))];

    for (const annotation of [...pageAnnotations].sort((a, b) => layer(a) - layer(b))) {
      if (annotation.type === "highlight") {
        ops.push(...markupOps(annotation, size, multiplyName));
      } else if (annotation.type === "shape") {
        ops.push(...shapeOps(annotation, size));
      } else if (annotation.type === "ink") {
        ops.push(...inkOps(annotation, size));
      } else if (renderNote && annotation.text.trim()) {
        const x = annotation.rect.x * size.width;
        const y = annotation.rect.y * size.height;
        const image = await renderNote(annotation, {
          width: annotation.rect.width * size.width,
          height: annotation.rect.height * size.height,
          maxHeight: size.height - y,
        });

        if (image) {
          const name = page.node.newXObject("LiberaNote", (await document.embedPng(image.png)).ref);

          // Image space is y-up; flip it into the y-down viewport.
          ops.push(
            pushGraphicsState(),
            concatTransformationMatrix(image.width, 0, 0, -image.height, x, y + image.height),
            drawObject(name),
            popGraphicsState(),
          );
        }
      }
    }

    page.pushOperators(...ops, popGraphicsState());
  }

  return document.save();
}
