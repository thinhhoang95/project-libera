"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { inkMaskFromPixels, type PdfInkMask } from "@/lib/pdf-space-layout";
import { IDENTITY_PAGE_GEOMETRY, pieceIndexAt, type PdfPageGeometry } from "@/lib/pdf-space-geometry";
import type { PdfAnnotationRect } from "@/lib/types";

/*
 * A page with spaces is shown as pieces of its one PDF.js rendering, each
 * moved down by its own amount (docs/create-space-plan.md, "Raster pieces").
 * Moving a piece is CSS only: canvases and text spans translate by a custom
 * property per piece, set on the page. Opening a cut only re-slices bitmaps.
 */

/** A rendered part of the page: its document rectangle and the canvas holding it. */
export type RasterPiece = { rect: PdfAnnotationRect; canvas: HTMLCanvasElement };

const FULL_PAGE: PdfAnnotationRect = { x: 0, y: 0, width: 1, height: 1 };
const MASK_COLUMNS = 400;

export function pieceVariable(index: number) {
  return `--pdf-piece-${index}`;
}

/** The custom properties that move each piece, in CSS pixels for a page `pageHeight` tall. */
export function pieceShiftStyle(geometry: PdfPageGeometry, pageHeight: number): CSSProperties | undefined {
  if (geometry === IDENTITY_PAGE_GEOMETRY) return undefined;
  return Object.fromEntries(geometry.pieces.map((piece, index) => [pieceVariable(index), `${piece.shift * pageHeight}px`])) as CSSProperties;
}

/** A rectangle on the whole page's bitmap grid, so neighbouring pieces meet exactly. */
function pixelBox(rect: PdfAnnotationRect, width: number, height: number) {
  return {
    x0: Math.round(rect.x * width),
    y0: Math.round(rect.y * height),
    x1: Math.round((rect.x + rect.width) * width),
    y1: Math.round((rect.y + rect.height) * height),
  };
}

/**
 * Copies the bitmap held by `sources` into one new canvas per rectangle, at
 * the same resolution. `width` × `height` is the whole page's bitmap size.
 */
export function repartitionRaster(sources: readonly RasterPiece[], rects: readonly PdfAnnotationRect[], width: number, height: number): RasterPiece[] {
  return rects.map((rect) => {
    const box = pixelBox(rect, width, height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, box.x1 - box.x0);
    canvas.height = Math.max(1, box.y1 - box.y0);
    const context = canvas.getContext("2d");

    for (const source of context ? sources : []) {
      const from = pixelBox(source.rect, width, height);
      const left = Math.max(box.x0, from.x0);
      const top = Math.max(box.y0, from.y0);
      const right = Math.min(box.x1, from.x1);
      const bottom = Math.min(box.y1, from.y1);
      if (right <= left || bottom <= top || !source.canvas.width || !source.canvas.height) continue;
      context!.drawImage(source.canvas, left - from.x0, top - from.y0, right - left, bottom - top, left - box.x0, top - box.y0, right - left, bottom - top);
    }

    return { rect, canvas };
  });
}

export function releaseRaster(pieces: readonly RasterPiece[]) {
  for (const { canvas } of pieces) {
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  }
}

/** Positions a piece canvas in a host the size of the original page. */
export function placePiece(canvas: HTMLCanvasElement, rect: PdfAnnotationRect, index: number) {
  Object.assign(canvas.style, {
    position: "absolute",
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
    translate: `0 var(${pieceVariable(index)}, 0px)`,
  });
}

/**
 * Moves each PDF.js text span with the piece it sits in. Spans keep their
 * place in the DOM, so selection, copy and find are unaffected.
 */
export function assignTextPieces(textDivs: readonly HTMLElement[], geometry: PdfPageGeometry, pageSize: { width: number; height: number }) {
  for (const div of textDivs) {
    if (geometry === IDENTITY_PAGE_GEOMETRY) {
      div.style.translate = "";
      continue;
    }
    // Marked-content spans use scaled PDF pixels instead of percentages.
    const fraction = (value: string, size: number) => value.endsWith("%")
      ? parseFloat(value) / 100
      : Number(value.match(/\*\s*(-?[\d.]+)px\s*\)/)?.[1] ?? NaN) / size;
    const x = fraction(div.style.left, pageSize.width);
    const y = fraction(div.style.top, pageSize.height);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    div.style.translate = `0 var(${pieceVariable(pieceIndexAt(geometry, x, y))}, 0px)`;
  }
}

/** A downsampled picture of the page's content, from its canvases laid out as on the original page. */
export function buildInkMask(sources: readonly RasterPiece[], aspect: number): PdfInkMask | null {
  const columns = MASK_COLUMNS;
  const rows = Math.max(1, Math.round(columns * aspect));
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !sources.length) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  for (const { canvas: source, rect } of sources) {
    if (!source.width || !source.height) continue;
    context.drawImage(source, rect.x * columns, rect.y * rows, rect.width * columns, rect.height * rows);
  }

  try {
    return inkMaskFromPixels(context.getImageData(0, 0, columns, rows).data, columns, rows);
  } catch {
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

type RasterState = {
  /** The whole page's bitmap size at the last finished render. */
  bitmap: { width: number; height: number } | null;
  pieces: RasterPiece[];
  structureKey: string;
  rendering: boolean;
  mask: PdfInkMask | null;
};

/**
 * Keeps a page's rendering split into the pieces of its geometry. The page
 * canvas is the PDF.js target; while the page has spaces its bitmap lives in
 * the pieces instead, so memory stays one page's worth.
 */
export function usePdfSpaceRaster({
  canvasRef,
  hostRef,
  geometry,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Covers the original page (top-left of the sheet, unscaled by spaces). */
  hostRef: RefObject<HTMLElement | null>;
  geometry: PdfPageGeometry;
}) {
  const stateRef = useRef<RasterState>({ bitmap: null, pieces: [], structureKey: "", rendering: false, mask: null });
  const geometryRef = useRef(geometry);

  const apply = useCallback(() => {
    const state = stateRef.current;
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const next = geometryRef.current;
    if (!state.bitmap || !canvas || !host) return;
    // Mid-render the page canvas holds a partial bitmap; the render's end applies.
    if (state.rendering && !state.pieces.length) return;
    if (next === IDENTITY_PAGE_GEOMETRY ? !state.pieces.length : state.structureKey === next.structureKey && state.pieces.length) return;

    const { width, height } = state.bitmap;
    const sources = state.pieces.length ? state.pieces : [{ rect: FULL_PAGE, canvas }];

    if (next === IDENTITY_PAGE_GEOMETRY) {
      // PDF.js owns the target until its render settles. The old pieces can
      // show the unsplit page at zero shift in the meantime.
      if (state.rendering) return;
      // The last space is gone: the page canvas shows the page again.
      const [whole] = repartitionRaster(sources, [FULL_PAGE], width, height);
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.drawImage(whole.canvas, 0, 0);
      releaseRaster([whole, ...state.pieces]);
      state.pieces = [];
      canvas.style.visibility = "";
    } else {
      const pieces = repartitionRaster(sources, next.pieces.map((piece) => piece.rect), width, height);
      pieces.forEach((piece, index) => placePiece(piece.canvas, piece.rect, index));
      host.replaceChildren(...pieces.map((piece) => piece.canvas));
      releaseRaster(state.pieces);
      state.pieces = pieces;
      if (!state.rendering) {
        // The pieces hold the bitmap now.
        canvas.width = 0;
        canvas.height = 0;
      }
      canvas.style.visibility = "hidden";
    }
    state.structureKey = next.structureKey;
  }, [canvasRef, hostRef]);

  useLayoutEffect(() => {
    geometryRef.current = geometry;
    apply();
  }, [apply, geometry]);

  useEffect(() => () => {
    releaseRaster(stateRef.current.pieces);
    stateRef.current.pieces = [];
    stateRef.current.bitmap = null;
    stateRef.current.mask = null;
  }, []);

  /** Call before PDF.js starts drawing into the page canvas. */
  const renderStarted = useCallback(() => {
    stateRef.current.rendering = true;
  }, []);

  /** Call when PDF.js has finished drawing the whole page into the page canvas. */
  const renderFinished = useCallback(() => {
    const state = stateRef.current;
    const canvas = canvasRef.current;
    state.rendering = false;
    if (!canvas) return;
    // A fresh rendering replaces whatever the pieces held.
    releaseRaster(state.pieces);
    state.pieces = [];
    state.bitmap = { width: canvas.width, height: canvas.height };
    state.structureKey = "";
    state.mask = null;
    canvas.style.visibility = "";
    apply();
  }, [apply, canvasRef]);

  /** The page's ink, built on first use after each change to what is shown. */
  const inkMask = useCallback((aspect: number) => {
    const state = stateRef.current;
    const canvas = canvasRef.current;
    if (state.mask) return state.mask;
    if (!state.bitmap || state.rendering && !state.pieces.length) return null;
    const sources = state.pieces.length ? state.pieces : canvas ? [{ rect: FULL_PAGE, canvas }] : [];
    state.mask = buildInkMask(sources, aspect);
    return state.mask;
  }, [canvasRef]);

  return { renderStarted, renderFinished, inkMask };
}
