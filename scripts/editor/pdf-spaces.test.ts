import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PDFDocument, PDFName } from "pdf-lib";
import { annotationAnchorRect, annotationLinkLabel } from "../../src/lib/annotation-links";
import { burnPdfAnnotations } from "../../src/lib/pdf-annotation-export";
import {
  PDF_SPACE_MAX_PAGE_GROWTH,
  PDF_SPACE_MAX_PER_PAGE,
  availableSpaceHeight,
  columnAt,
  columnBounds,
  fullWidthBand,
  normalizeSpaceLayout,
  reconcilePageSpaces,
  reconcilePdfSpaces,
} from "../../src/lib/pdf-space";
import {
  IDENTITY_PAGE_GEOMETRY,
  annotationToSurface,
  patchFromSurface,
  pdfPageGeometries,
  pdfPageGeometry,
  rigidPointsFromSurface,
  rigidRectFromSurface,
  textRectsFromSurface,
  type PdfPageGeometry,
} from "../../src/lib/pdf-space-geometry";
import { columnBlocks, inkMaskFromPixels, placeSpaceCut, snapCut } from "../../src/lib/pdf-space-layout";
import { readPdfAnnotations, writePdfAnnotations } from "../../src/lib/storage/annotations";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import type {
  PdfAnnotation,
  PdfHighlightAnnotation,
  PdfInkAnnotation,
  PdfShapeAnnotation,
  PdfSpaceAnnotation,
  PdfSpaceBand,
  PdfTextAnnotation,
} from "../../src/lib/types";

const TWO_COLUMNS: PdfSpaceBand = { top: 0.2, bottom: 0.8, splits: [0.5] };

function space(id: string, y: number, height: number, band: PdfSpaceBand = fullWidthBand(y), column = 0, createdAt = `2026-10-24T00:00:0${id.length % 10}Z`): PdfSpaceAnnotation {
  return { id, type: "space", pageNumber: 1, y, height, band, column, createdAt, updatedAt: createdAt };
}

function note(id: string, rect: PdfTextAnnotation["rect"], extra: Partial<PdfTextAnnotation> = {}): PdfTextAnnotation {
  return { id, type: "text", pageNumber: 1, text: id, fontSize: 10, rect, createdAt: "2026-10-24", updatedAt: "2026-10-24", ...extra };
}

function ink(id: string, points: PdfInkAnnotation["points"], extra: Partial<PdfInkAnnotation> = {}): PdfInkAnnotation {
  return { id, type: "ink", pageNumber: 1, color: "#1d4ed8", strokeWidth: 2, points, createdAt: "2026-10-24", updatedAt: "2026-10-24", ...extra };
}

function near(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${message ?? "value"}: ${actual} ≠ ${expected}`);
}

/** Small deterministic generator, so a failing case can be replayed. */
function random(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
}

function overlapArea(a: PdfAnnotationRectLike, b: PdfAnnotationRectLike) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 1e-12 && height > 1e-12 ? width * height : 0;
}
type PdfAnnotationRectLike = { x: number; y: number; width: number; height: number };

function assertTiles(geometry: PdfPageGeometry) {
  const area = geometry.pieces.reduce((total, piece) => total + piece.rect.width * piece.rect.height, 0);
  near(area, 1, "pieces cover the page");
  for (const [index, piece] of geometry.pieces.entries()) {
    for (const other of geometry.pieces.slice(index + 1)) assert.equal(overlapArea(piece.rect, other.rect), 0, "pieces overlap");
  }
}

test("space layouts are validated and malformed bands become full-width cuts", () => {
  assert.equal(normalizeSpaceLayout({ y: "0.5", height: 0.1 }), null);
  assert.equal(normalizeSpaceLayout({ y: 0.5 }), null);
  assert.deepEqual(normalizeSpaceLayout({ y: 1.4, height: 9 }), { y: 1, height: 1, band: fullWidthBand(1), column: 0 });
  assert.deepEqual(normalizeSpaceLayout({ y: 0.3, height: 0, band: { top: 0.3, bottom: 0.3, splits: [0.5] }, column: 1 }), {
    y: 0.3, height: 0.005, band: fullWidthBand(0.3), column: 0,
  });
  // Bands are ordered, splits sorted, de-duplicated and kept off the edges; the cut stays in its band.
  assert.deepEqual(normalizeSpaceLayout({
    y: 0.95, height: 0.1, band: { top: 0.8, bottom: 0.2, splits: [0.7, 0.3, 0.305, 0.001, "x", 0.5, 0.9, 0.95] }, column: 9,
  }), { y: 0.8, height: 0.1, band: { top: 0.2, bottom: 0.8, splits: [0.3, 0.5, 0.7, 0.9] }, column: 4 });
});

test("columns partition their band, outer columns reaching the page edges", () => {
  assert.deepEqual(columnBounds(TWO_COLUMNS, 0), { x0: 0, x1: 0.5 });
  assert.deepEqual(columnBounds(TWO_COLUMNS, 1), { x0: 0.5, x1: 1 });
  assert.equal(columnAt(TWO_COLUMNS, 0.02), 0);
  assert.equal(columnAt(TWO_COLUMNS, 0.5), 1);
  assert.equal(columnAt(fullWidthBand(0.4), 0.9), 0);
});

test("a page's spaces never disagree about a block's layout, and the oldest win", () => {
  const first = space("a", 0.4, 0.1, TWO_COLUMNS, 1, "2026-10-24T00:00:01Z");
  // Overlaps the stored block with another layout: adopts it, keeping its column by position.
  const conflicting = space("b", 0.5, 0.1, { top: 0.3, bottom: 0.9, splits: [0.6] }, 0, "2026-10-24T00:00:02Z");
  // A full-width cut inside the stored block adopts the block.
  const inside = space("c", 0.6, 0.05, undefined, 0, "2026-10-24T00:00:03Z");
  // Overlaps the block but its cut is outside it: becomes a full-width cut.
  const outside = space("d", 0.1, 0.05, { top: 0.05, bottom: 0.3, splits: [0.5] }, 1, "2026-10-24T00:00:04Z");
  const [a, b, c, d] = reconcilePageSpaces([first, conflicting, inside, outside]);

  assert.equal(a, first);
  assert.deepEqual([b.band, b.column, b.y], [TWO_COLUMNS, 0, 0.5]);
  assert.deepEqual([c.band, c.column], [TWO_COLUMNS, 1]);
  assert.deepEqual([d.band, d.column, d.y], [fullWidthBand(0.1), 0, 0.1]);

  // Age decides, not input order.
  const [older, newer] = reconcilePageSpaces([conflicting, first]);
  assert.equal(newer, first);
  assert.deepEqual(older.band, TWO_COLUMNS);
});

test("pages keep a bounded number and height of spaces, and ids are unique", () => {
  const many = Array.from({ length: 40 }, (_, index) => space(`s${index}`, index / 40, 0.01, undefined, 0, `2026-10-24T00:00:${String(index).padStart(2, "0")}Z`));
  assert.equal(reconcilePageSpaces(many).length, PDF_SPACE_MAX_PER_PAGE);

  const tall = [0.1, 0.3, 0.5, 0.7].map((y, index) => space(`t${index}`, y, 1, undefined, 0, `2026-10-24T00:00:0${index}Z`));
  assert.equal(PDF_SPACE_MAX_PAGE_GROWTH, 3);
  assert.deepEqual(reconcilePageSpaces(tall).map((kept) => kept.id), ["t0", "t1", "t2"]);

  const duplicate = { ...space("same", 0.2, 0.1), createdAt: "2026-10-25" };
  assert.deepEqual(reconcilePageSpaces([duplicate, space("same", 0.6, 0.1)]).map((kept) => kept.y), [0.6]);
  const otherPage = { ...space("same", 0.4, 0.1), pageNumber: 2, createdAt: "2026-10-25" };
  assert.deepEqual(reconcilePdfSpaces([space("same", 0.6, 0.1), otherPage]).map((kept) => kept.pageNumber), [1]);
});

test("creation and resizing reserve the other spaces before applying page limits", () => {
  const spaces = [space("a", 0.2, 1), space("b", 0.4, 1), space("c", 0.6, 0.9)];
  near(availableSpaceHeight(spaces), 0.1);
  near(availableSpaceHeight(spaces, "c"), 1);
  near(availableSpaceHeight([...spaces, space("d", 0.8, 0.1)]), 0);
  const many = Array.from({ length: 32 }, (_, index) => space(String(index), index / 32, 0.01));
  assert.equal(availableSpaceHeight(many), 0);
  assert.equal(availableSpaceHeight(many, "0"), 1);
});

test("references to a missing space, or one on another page, are dropped", () => {
  const onTwo = { ...space("s2", 0.5, 0.1), pageNumber: 2 };
  const result = reconcilePdfSpaces([
    space("s1", 0.5, 0.1),
    onTwo,
    note("kept", { x: 0.1, y: 0.01, width: 0.2, height: 0.05 }, { space: "s1" }),
    note("missing", { x: 0.1, y: 0.01, width: 0.2, height: 0.05 }, { space: "gone" }),
    note("elsewhere", { x: 0.1, y: 0.01, width: 0.2, height: 0.05 }, { space: "s2" }),
  ]);
  assert.deepEqual(result.map((annotation) => "space" in annotation ? annotation.space : null), [null, null, "s1", null, null]);
  assert.ok(!("space" in result[3]));
});

test("pages without spaces use the identity geometry", () => {
  assert.equal(pdfPageGeometry([]), IDENTITY_PAGE_GEOMETRY);
  const highlight: PdfHighlightAnnotation = { id: "h", type: "highlight", pageNumber: 1, color: "#fde047", rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }], createdAt: "", updatedAt: "" };
  assert.equal(annotationToSurface(highlight, IDENTITY_PAGE_GEOMETRY), highlight);
  const patch = { rect: { x: 0.1, y: 0.2, width: 0.1, height: 0.1 } };
  assert.equal(patchFromSurface(note("n", patch.rect), patch, IDENTITY_PAGE_GEOMETRY), patch);
  const geometries = pdfPageGeometries([highlight, { ...space("s", 0.5, 0.1), pageNumber: 3 }]);
  assert.deepEqual([...geometries.keys()], [3]);
});

test("a full-width space moves everything below its cut", () => {
  const geometry = pdfPageGeometry([space("s", 0.5, 0.2, undefined, 0, "2026-10-24T00:00:00Z")]);
  near(geometry.growth, 0.2);
  near(geometry.scale, 1.2);
  near(geometry.shiftAt(0.3, 0.49), 0);
  near(geometry.shiftAt(0.3, 0.5), 0.2);
  near(geometry.toView({ x: 0.9, y: 0.75 }).y, 0.95);
  assert.deepEqual(geometry.spaces, [{ id: "s", cut: 0.5, rect: { x: 0, y: 0.5, width: 1, height: 0.2 } }]);
  const inSpace = geometry.toDoc({ x: 0.2, y: 0.6 });
  assert.equal(inSpace.space, "s");
  near(inSpace.point.y, 0.1);
  near(geometry.toDoc({ x: 0.2, y: 0.8 }).point.y, 0.6);
  assert.deepEqual(geometry.pieces.map((piece) => [piece.rect.y, piece.rect.height, piece.shift]), [[0, 0.5, 0], [0.5, 0.5, 0.2]]);
  assert.deepEqual(geometry.fillers, []);
  assertTiles(geometry);
});

test("spaces at one cut stack in a fixed order", () => {
  const geometry = pdfPageGeometry([
    space("late", 0.5, 0.1, undefined, 0, "2026-10-24T00:00:02Z"),
    space("early", 0.5, 0.2, undefined, 0, "2026-10-24T00:00:01Z"),
  ]);
  assert.deepEqual(geometry.spaces.map(({ id }) => id), ["early", "late"]);
  near(geometry.spaces[0].rect.y, 0.5);
  near(geometry.spaces[1].rect.y, 0.7);
  assert.equal(geometry.toDoc({ x: 0.5, y: 0.75 }).space, "late");
  near(geometry.shiftAt(0.5, 0.6), 0.3);
});

test("nearby cuts remain distinct and near-equal overlapping bands adopt the oldest layout", () => {
  const geometry = pdfPageGeometry([space("a", 0.4, 0.1), space("b", 0.4000005, 0.1)]);
  assertTiles(geometry);
  near(geometry.toView({ x: 0.5, y: 0.40000025 }).y, 0.50000025);
  const older = space("old", 0.6, 0.1, TWO_COLUMNS, 1, "2026-10-24T00:00:00Z");
  const newer = space("new", 0.4, 0.1, { top: 0.2000005, bottom: 0.8000005, splits: [0.5000005] }, 0, "2026-10-25T00:00:00Z");
  const [adopted] = reconcilePageSpaces([newer, older]);
  assert.deepEqual(adopted.band, older.band);
  assertTiles(pdfPageGeometry([newer, older]));
});

test("content at cut boundaries round-trips through surface fractions", () => {
  const geometry = pdfPageGeometry([
    space("a", 0.2, 0.1), space("b", 0.4, 0.2), space("c", 0.6, 0.1),
  ]);
  for (const y of [0.2, 0.4, 0.6, 0.999]) {
    const original = note("n", { x: 0.1, y, width: 0.2, height: Math.min(0.02, 1 - y) });
    const surface = annotationToSurface(original, geometry);
    const patch = patchFromSurface(original, { rect: surface.rect }, geometry) as Partial<PdfTextAnnotation>;
    assert.equal(patch.space, undefined, `content at ${y} stays on the page`);
    near(patch.rect!.y, y);
  }
  for (const [y, height] of [[0.01, 0.14], [0.02, 0.21], [0.17, 0.44]]) {
    const geometry = pdfPageGeometry([space("s", y, height)]);
    for (const anchor of [undefined, "s"]) {
      const original = note("n", { x: 0.1, y: anchor ? 0 : y, width: 0.2, height: 0.01 }, anchor ? { space: anchor } : {});
      const surface = annotationToSurface(original, geometry);
      const patch = patchFromSurface(original, { rect: surface.rect }, geometry) as Partial<PdfTextAnnotation>;
      assert.equal(patch.space, anchor);
      near(patch.rect!.y, original.rect.y);
      near(annotationToSurface({ ...original, ...patch }, geometry).rect.y, surface.rect.y);
    }
  }
});

test("in a column block only the column opens; the block grows by its tallest column", () => {
  const geometry = pdfPageGeometry([
    space("left", 0.4, 0.1, TWO_COLUMNS, 0, "2026-10-24T00:00:01Z"),
    space("right", 0.6, 0.05, TWO_COLUMNS, 1, "2026-10-24T00:00:02Z"),
  ]);
  near(geometry.growth, 0.1);
  near(geometry.shiftAt(0.25, 0.3), 0, "left column above its cut");
  near(geometry.shiftAt(0.25, 0.5), 0.1, "left column below its cut");
  near(geometry.shiftAt(0.75, 0.5), 0, "right column above its own cut");
  near(geometry.shiftAt(0.75, 0.7), 0.05, "right column below its cut");
  near(geometry.shiftAt(0.75, 0.9), 0.1, "below the block, by the tallest column");
  near(geometry.shiftAt(0.25, 0.1), 0, "above the block");
  assert.equal(geometry.fillers.length, 1);
  const [box] = geometry.fillers;
  assert.deepEqual([box.x, box.width], [0.5, 0.5]);
  near(box.y, 0.85);
  near(box.height, 0.05);
  // Filler snaps to its top: the right column's last line of content.
  const filler = geometry.toDoc({ x: 0.8, y: 0.87 });
  assert.equal(filler.space, undefined);
  near(geometry.toView(filler.point).y, 0.85, "filler maps to its top");
  assertTiles(geometry);
  assert.equal(geometry.pieces.length, 2 + 2 + 2);
});

test("filler snaps to its top even when its column's last cut is at the block end", () => {
  const geometry = pdfPageGeometry([
    space("left", 0.8, 0.1, TWO_COLUMNS, 0),
    space("right", 0.6, 0.2, TWO_COLUMNS, 1),
  ]);
  const filler = geometry.fillers[0];
  const placed = geometry.toDoc({ x: 0.25, y: filler.y + filler.height / 2 });
  assert.equal(placed.space, undefined);
  near(geometry.toView(placed.point).y, filler.y);
  const draft = rigidRectFromSurface(geometry, { x: 0.1, y: (filler.y + filler.height / 2) / geometry.scale, width: 0.2, height: 0.02 / geometry.scale });
  near(annotationToSurface(note("n", draft.rect), geometry).rect.y * geometry.scale, filler.y);
  assertTiles(geometry);
});

test("view and document coordinates round-trip for any arrangement of spaces", () => {
  const next = random(7);
  for (let trial = 0; trial < 200; trial++) {
    const spaces: PdfSpaceAnnotation[] = [];
    const count = 1 + Math.floor(next() * 5);
    for (let index = 0; index < count; index++) {
      const createdAt = `2026-10-24T00:00:${String(index).padStart(2, "0")}Z`;
      if (next() < 0.4) spaces.push(space(`f${index}`, next(), 0.01 + next() * 0.2, undefined, 0, createdAt));
      else spaces.push(space(`c${index}`, 0.2 + next() * 0.6, 0.01 + next() * 0.2, TWO_COLUMNS, next() < 0.5 ? 0 : 1, createdAt));
    }
    const geometry = pdfPageGeometry(spaces);
    assertTiles(geometry);

    for (let sample = 0; sample < 50; sample++) {
      const point = { x: next(), y: next() };
      const view = geometry.toView(point);
      const back = geometry.toDoc(view);
      assert.equal(back.space, undefined, `trial ${trial}: content point landed in a space`);
      near(back.point.y, point.y, `trial ${trial}: y round trip`);
      // Pieces agree with shiftAt.
      const piece = geometry.pieces.find(({ rect }) => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height);
      if (piece) near(piece.shift, geometry.shiftAt(point.x, point.y), `trial ${trial}: piece shift`);
    }
    for (const { id, rect } of geometry.spaces) {
      const inside = geometry.toDoc({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      assert.equal(inside.space, id, `trial ${trial}: space ${id} is found`);
      near(inside.point.y, rect.height / 2);
    }
  }
});

test("notes and drawings move rigidly; highlights move line by line", () => {
  const geometry = pdfPageGeometry([space("s", 0.5, 0.25, undefined, 0, "2026-10-24T00:00:00Z")]);
  const highlight: PdfHighlightAnnotation = {
    id: "h", type: "highlight", pageNumber: 1, color: "#fde047", createdAt: "", updatedAt: "",
    rects: [{ x: 0.1, y: 0.45, width: 0.5, height: 0.02 }, { x: 0.1, y: 0.52, width: 0.5, height: 0.02 }],
  };
  const surfaceHighlight = annotationToSurface(highlight, geometry);
  near(surfaceHighlight.rects[0].y, 0.45 / 1.25);
  near(surfaceHighlight.rects[1].y, 0.77 / 1.25, "the second line moved down");
  near(surfaceHighlight.rects[1].height, 0.02 / 1.25);
  assert.equal(annotationToSurface(highlight, geometry), surfaceHighlight, "conversions are cached");

  // A stroke straddling the cut moves with its top, unstretched.
  const stroke = ink("i", [{ x: 0.4, y: 0.48 }, { x: 0.45, y: 0.55 }]);
  const surfaceStroke = annotationToSurface(stroke, geometry);
  near((surfaceStroke.points[1].y - surfaceStroke.points[0].y) * 1.25, 0.07, "stroke keeps its height");
  near(surfaceStroke.points[0].y * 1.25, 0.48);

  const shape: PdfShapeAnnotation = { id: "r", type: "shape", pageNumber: 1, shape: "rectangle", color: "#000000", strokeWidth: 1, from: { x: 0.2, y: 0.6 }, to: { x: 0.3, y: 0.7 }, createdAt: "", updatedAt: "" };
  near(annotationToSurface(shape, geometry).from.y * 1.25, 0.85);
});

test("annotations in a space are placed from its top and round-trip through edits", () => {
  const geometry = pdfPageGeometry([
    space("left", 0.4, 0.1, TWO_COLUMNS, 0, "2026-10-24T00:00:01Z"),
    space("right", 0.3, 0.2, TWO_COLUMNS, 1, "2026-10-24T00:00:02Z"),
  ]);
  const inSpace = note("n", { x: 0.55, y: 0.02, width: 0.3, height: 0.05 }, { space: "right" });
  const surface = annotationToSurface(inSpace, geometry);
  near(surface.rect.y * geometry.scale, 0.32);

  // A move the layer reports in surface fractions comes back in document terms.
  const moved = { ...surface.rect, y: surface.rect.y + 0.03 / geometry.scale };
  const patch = patchFromSurface(inSpace, { rect: moved }, geometry) as Partial<PdfTextAnnotation>;
  assert.equal(patch.space, "right");
  near(patch.rect!.y, 0.05);

  // Dragged onto the page below the space: it leaves the space.
  const out = patchFromSurface(inSpace, { rect: { ...surface.rect, y: 0.6 / geometry.scale } }, geometry) as Partial<PdfTextAnnotation>;
  assert.ok("space" in out && out.space === undefined);
  near(out.rect!.y, 0.4, "0.6 displayed is 0.4 in the right column below its 0.2 space");

  // Dragged into the left column's space from the page.
  const onPage = note("p", { x: 0.1, y: 0.1, width: 0.2, height: 0.05 });
  const into = patchFromSurface(onPage, { rect: { ...onPage.rect, y: 0.43 / geometry.scale } }, geometry) as Partial<PdfTextAnnotation>;
  assert.equal(into.space, "left");
  near(into.rect!.y, 0.03);
  const colorOnly = { color: "#ff0000" };
  assert.equal(patchFromSurface(onPage, colorOnly, geometry), colorOnly, "edits that move nothing pass through");
  assert.ok(!("space" in (patchFromSurface(onPage, { rect: onPage.rect }, geometry))), "no stray space key");

  // New drafts.
  const drawn = rigidPointsFromSurface(geometry, [{ x: 0.2, y: 0.42 / geometry.scale }, { x: 0.3, y: 0.46 / geometry.scale }]);
  assert.equal(drawn.space, "left");
  near(drawn.points[0].y, 0.02);
  near(drawn.points[1].y, 0.06);
  const placed = rigidRectFromSurface(geometry, { x: 0.6, y: 0.9 / geometry.scale, width: 0.2, height: 0.05 / geometry.scale });
  assert.equal(placed.space, undefined);
  near(placed.rect.y, 0.7, "in the right column, below its space");
  near(placed.rect.height, 0.05);
});

test("selection rects map back line by line, and never into a space", () => {
  const geometry = pdfPageGeometry([space("s", 0.5, 0.2, undefined, 0, "2026-10-24T00:00:00Z")]);
  const rects = textRectsFromSurface(geometry, [
    { x: 0.1, y: 0.45 / 1.2, width: 0.3, height: 0.024 / 1.2 },
    { x: 0.1, y: 0.75 / 1.2, width: 0.3, height: 0.024 / 1.2 },
    { x: 0.1, y: 0.6 / 1.2, width: 0.3, height: 0.024 / 1.2 },
  ]);
  near(rects[0].y, 0.45);
  near(rects[1].y, 0.55);
  near(rects[2].y, 0.5, "a box starting in a space belongs at its cut");
  near(rects[0].height, 0.024);
});

/** A page `rows` tall and 20 cells wide; `ink` rows are drawn in `inkColor` on `paper`. */
function pagePixels(rows: number, ink: (row: number) => boolean, paper = [255, 255, 255], inkColor = [0, 0, 0]) {
  const columns = 20;
  const data = new Uint8ClampedArray(columns * rows * 4);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      // Ink stays off the border, as a page's content stays inside its margins.
      const color = ink(row) && column > 1 && column < columns - 2 ? inkColor : paper;
      data.set([...color, 255], (row * columns + column) * 4);
    }
  }
  return inkMaskFromPixels(data, columns, rows);
}

test("the ink mask finds the page background and what is drawn on it", () => {
  const mask = pagePixels(10, (row) => row === 4);
  assert.equal(mask.background, "#ffffff");
  assert.deepEqual([...mask.ink.slice(4 * 20, 5 * 20)].filter(Boolean).length, 16);
  assert.equal(mask.ink.slice(0, 4 * 20).some(Boolean), false);
  const dark = pagePixels(10, (row) => row === 2, [20, 20, 30], [240, 240, 240]);
  assert.equal(dark.background, "#14141e", "slides with dark backgrounds");
  assert.equal(dark.ink.slice(2 * 20, 3 * 20).filter(Boolean).length, 16);
});

test("cuts snap to the blank paper between lines, never into a figure", () => {
  // A 40-row top margin, three lines with two-row gaps, a tall figure, a bottom margin.
  const inked = (row: number) => (row >= 40 && row <= 43) || (row >= 46 && row <= 49) || (row >= 52 && row <= 55) || (row >= 56 && row <= 150);
  const mask = pagePixels(200, inked);
  assert.deepEqual(snapCut(mask, 47.5 / 200), { y: 45 / 200, snapped: true }, "into the middle of the nearest line gap");
  assert.deepEqual(snapCut(mask, 20 / 200), { y: 20 / 200, snapped: true }, "in a margin the cut stays at the pointer");
  assert.deepEqual(snapCut(mask, 41.5 / 200), { y: 38 / 200, snapped: true }, "beside a margin: just inside it, clear of the text");
  assert.deepEqual(snapCut(mask, 100 / 200), { y: 0.5, snapped: false }, "deep in a figure nothing is near: unsnapped");
});

/**
 * A synthetic page 100 cells wide and 200 rows tall: a full-width title, a
 * two-column block of lines whose left column ends early, and a full-width
 * figure below.
 */
function twoColumnPage() {
  const columns = 100;
  const rows = 200;
  const ink = new Uint8Array(columns * rows);
  const draw = (row: number, from: number, to: number) => ink.fill(1, row * columns + from, row * columns + to + 1);
  for (let row = 10; row <= 14; row++) draw(row, 10, 89);
  for (let row = 30; row <= 120; row++) {
    if ((row - 30) % 4 === 3) continue;
    if (row <= 110) draw(row, 10, 45);
    draw(row, 55, 89);
  }
  for (let row = 135; row <= 170; row++) draw(row, 10, 89);
  return { columns, rows, ink, background: "#ffffff" };
}

test("column blocks are found between full-width content, even where a column ends early", () => {
  const blocks = columnBlocks(twoColumnPage());
  assert.equal(blocks.length, 1);
  near(blocks[0].top, 30 / 200);
  near(blocks[0].bottom, 121 / 200);
  assert.equal(blocks[0].splits.length, 1);
  near(blocks[0].splits[0], 0.505);
  // Long lines reaching into the gutter narrow it rather than ending the block.
  const reaching = twoColumnPage();
  for (const row of [70, 71, 72]) reaching.ink.fill(1, row * 100 + 46, row * 100 + 48 + 1);
  const narrowed = columnBlocks(reaching);
  assert.equal(narrowed.length, 1);
  near(narrowed[0].bottom, 121 / 200);
  near(narrowed[0].splits[0], 0.52);
  // A single column of lines has no block.
  const single = twoColumnPage();
  for (let row = 30; row <= 120; row++) single.ink.fill(1, row * 100 + 46, row * 100 + 55);
  assert.deepEqual(columnBlocks(single), []);
});

test("a space in a column block opens in the pointer's column, snapped in that column", () => {
  const mask = twoColumnPage();
  const left = placeSpaceCut(mask, { x: 0.3, y: 62.5 / 200 }, []);
  assert.equal(left.column, 0);
  assert.equal(left.band.splits.length, 1);
  near(left.y, 61.5 / 200);
  assert.equal(placeSpaceCut(mask, { x: 0.8, y: 62.5 / 200 }, []).column, 1);
  // Below the end of the left column: blank paper, the cut stays at the pointer.
  assert.deepEqual([placeSpaceCut(mask, { x: 0.3, y: 115.5 / 200 }, []).y, placeSpaceCut(mask, { x: 0.3, y: 115.5 / 200 }, []).column], [115.5 / 200, 0]);

  // Outside the block, or with Alt, the space opens across the page.
  const title = placeSpaceCut(mask, { x: 0.3, y: 12 / 200 }, []);
  assert.deepEqual([title.band.splits, title.band.top, title.band.bottom], [[], title.y, title.y]);
  const forced = placeSpaceCut(mask, { x: 0.3, y: 62.5 / 200 }, [], { fullWidth: true });
  assert.deepEqual(forced.band.splits, []);
  near(forced.y, 61.5 / 200);

  // Without a picture of the page yet, the cut is unsnapped and full width.
  assert.deepEqual(placeSpaceCut(null, { x: 0.3, y: 0.4 }, []), { y: 0.4, snapped: false, band: { top: 0.4, bottom: 0.4, splits: [] }, column: 0 });
});

test("a page's stored blocks decide new spaces, and found blocks never overlap them", () => {
  const mask = twoColumnPage();
  const stored: PdfSpaceBand = { top: 0.2, bottom: 0.5, splits: [0.6] };
  const inStored = placeSpaceCut(mask, { x: 0.55, y: 0.3 }, [stored]);
  assert.equal(inStored.band, stored);
  assert.equal(inStored.column, 0, "the stored split, not the found one, decides the column");
  // Alt cannot cut across a stored block.
  assert.equal(placeSpaceCut(mask, { x: 0.3, y: 0.3 }, [stored], { fullWidth: true }).band, stored);

  // A full-width cut stored inside the found block: the new block starts at it.
  const belowCut = placeSpaceCut(mask, { x: 0.3, y: 0.45 }, [fullWidthBand(0.3)]);
  near(belowCut.band.top, 0.3);
  near(belowCut.band.bottom, 121 / 200);
  const aboveCut = placeSpaceCut(mask, { x: 0.3, y: 0.25 }, [fullWidthBand(0.3)]);
  near(aboveCut.band.top, 30 / 200);
  near(aboveCut.band.bottom, 0.3);
  // A stored block overlapping the found one from above.
  const trimmed = placeSpaceCut(mask, { x: 0.3, y: 0.45 }, [{ top: 0.1, bottom: 0.3, splits: [0.5] }]);
  near(trimmed.band.top, 0.3);
  // Snapping never carries a full-width cut into a stored block.
  // (Pressed on the title's last line, the cut would snap down to 0.085, inside the block.)
  assert.deepEqual(
    placeSpaceCut(mask, { x: 0.3, y: 13.5 / 200 }, [{ top: 0.08, bottom: 0.4, splits: [0.5] }]),
    { y: 13.5 / 200, snapped: false, band: fullWidthBand(13.5 / 200), column: 0 },
  );
  near(placeSpaceCut(mask, { x: 0.3, y: 13.5 / 200 }, []).y, 0.085);
});

test("Shift bypasses snapping while keeping the stored column layout", () => {
  const mask = twoColumnPage();
  const point = { x: 0.3, y: 62.5 / 200 };
  const cut = placeSpaceCut(mask, point, [TWO_COLUMNS], { snap: false });
  assert.equal(cut.y, point.y);
  assert.equal(cut.snapped, false);
  assert.equal(cut.band, TWO_COLUMNS);
  assert.equal(cut.column, 0);
  const full = placeSpaceCut(mask, point, [], { fullWidth: true, snap: false });
  assert.deepEqual(full.band, fullWidthBand(point.y));
  assert.equal(full.y, point.y);
});

test("column detection only produces layouts the sidecar can preserve", () => {
  const columns = 300;
  const rows = 200;
  const ink = new Uint8Array(columns * rows);
  for (let row = 20; row < 180; row++) {
    for (let column = 0; column < 6; column++) ink.fill(1, row * columns + 5 + column * 49, row * columns + 43 + column * 49);
  }
  const bands = columnBlocks({ columns, rows, ink, background: "#ffffff" });
  assert.equal(bands.length, 1);
  assert.equal(bands[0].splits.length, 4);
  const layout = normalizeSpaceLayout({ y: 0.5, height: 0.1, band: bands[0], column: 4 })!;
  assert.deepEqual(layout.band, bands[0]);
  assert.equal(layout.column, 4);
});

test("link labels and anchors handle spaces", () => {
  const cut = space("s", 0.4, 0.1);
  assert.equal(annotationLinkLabel(cut, "fallback"), "fallback");
  assert.deepEqual(annotationAnchorRect(cut), { x: 0, y: 0.4, width: 1, height: 0 });
});

test("export leaves spaces, and what is in them, out for now", async () => {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  const bytes = await document.save();
  const annotations: PdfAnnotation[] = [
    space("s", 0.5, 0.1),
    note("in-space", { x: 0.1, y: 0.01, width: 0.2, height: 0.05 }, { space: "s" }),
    ink("in-space-ink", [{ x: 0.1, y: 0.01 }, { x: 0.2, y: 0.02 }], { space: "s" }),
  ];
  const burned = await PDFDocument.load(await burnPdfAnnotations(bytes, annotations, {
    renderNote: async () => { throw new Error("notes in spaces are not rendered"); },
  }));
  assert.equal(burned.getPages()[0].node.Resources()?.get(PDFName.of("ExtGState")), undefined, "nothing was drawn");
});

async function withLibrary(run: () => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "libera-pdf-spaces-"));
  const previous = process.env.LIBERA_DATA_DIR;
  const machine = process.env.LIBERA_MACHINE_ID;
  process.env.LIBERA_DATA_DIR = path.join(root, "library");
  process.env.LIBERA_MACHINE_ID = "computer-a";
  try {
    await createNotebook("Notes");
    const target = filePathFromParts("Notes", ["paper.pdf"]);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "PDF body");
    await run();
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    if (machine === undefined) delete process.env.LIBERA_MACHINE_ID; else process.env.LIBERA_MACHINE_ID = machine;
    await rm(root, { recursive: true, force: true });
  }
}

test("spaces and what sits in them are saved and read back", async () => withLibrary(async () => {
  const saved = await writePdfAnnotations("Notes/paper.pdf", [
    { ...space("s", 0.5, 0.1, TWO_COLUMNS, 1), fill: "#101010" },
    { ...space("bad", 0.5, "tall" as unknown as number) },
    { ...space("loud", 0.9, 0.1), fill: "red" },
    note("n", { x: 0.6, y: 0.02, width: 0.3, height: 0.05 }, { space: "s" }),
    ink("i", [{ x: 0.6, y: 0.02 }], { space: "s" }),
    note("orphan", { x: 0.6, y: 0.02, width: 0.3, height: 0.05 }, { space: "missing" }),
  ]);
  const read = await readPdfAnnotations("Notes/paper.pdf");
  assert.deepEqual(read.annotations, saved.annotations);
  assert.deepEqual(read.annotations.map((annotation) => annotation.id), ["s", "loud", "n", "i", "orphan"]);
  const [kept, loud, inNote, inInk, orphan] = read.annotations as [PdfSpaceAnnotation, PdfSpaceAnnotation, PdfTextAnnotation, PdfInkAnnotation, PdfTextAnnotation];
  assert.deepEqual([kept.y, kept.height, kept.band, kept.column, kept.fill], [0.5, 0.1, TWO_COLUMNS, 1, "#101010"]);
  assert.equal(loud.fill, undefined);
  assert.equal(inNote.space, "s");
  assert.equal(inInk.space, "s");
  assert.ok(!("space" in orphan));
}));

test("saving keeps annotation types and fields this build does not know", async () => withLibrary(async () => {
  const sidecar = pdfAnnotationsPath("Notes", ["paper.pdf"]);
  await writePdfAnnotations("Notes/paper.pdf", [note("n", { x: 0.1, y: 0.1, width: 0.2, height: 0.05 })]);
  const stored = JSON.parse(await readFile(sidecar, "utf8"));
  stored.annotations[0].future = { anchor: "kept" };
  stored.annotations.push({ id: "w", type: "wormhole", pageNumber: 1, depth: 3 });
  stored.annotations.push({ id: "huge", type: "wormhole", payload: "x".repeat(300 * 1024) });
  stored.annotations.push({ type: "wormhole" });
  // JSON can name a key __proto__; it must not become one.
  await writeFile(sidecar, JSON.stringify(stored).replace('"future":', '"__proto__":"ignored","future":'));

  const read = await readPdfAnnotations("Notes/paper.pdf");
  assert.deepEqual(read.annotations.map((annotation) => annotation.id), ["n"], "the viewer never sees unknown types");
  assert.ok(!("future" in read.annotations[0]));

  const moved = { ...read.annotations[0], rect: { x: 0.3, y: 0.3, width: 0.2, height: 0.05 } };
  const saved = await writePdfAnnotations("Notes/paper.pdf", [moved]);
  assert.ok(!("future" in saved.annotations[0]));
  const after = JSON.parse(await readFile(sidecar, "utf8")).annotations;
  assert.deepEqual(after.map((entry: { id?: string }) => entry.id), ["n", "w"]);
  assert.deepEqual(after[0].future, { anchor: "kept" });
  assert.deepEqual(after[0].rect, moved.rect, "known fields come from the save");
  assert.ok(!Object.hasOwn(after[0], "__proto__"));
  assert.deepEqual(after[1], { id: "w", type: "wormhole", pageNumber: 1, depth: 3 });

  // A known annotation removed by the viewer is removed, unknown fields and all.
  await writePdfAnnotations("Notes/paper.pdf", []);
  assert.deepEqual(JSON.parse(await readFile(sidecar, "utf8")).annotations.map((entry: { id?: string }) => entry.id), ["w"]);
}));
