"use client";

import { strokeSamples } from "@/lib/ink/codec";
import { inflateRect, rectsIntersect, strokeOutline, strokeReach, unionRect } from "@/lib/ink/geometry";
import { InkSpatialIndex } from "@/lib/ink/spatial-index";
import { dashPattern } from "@/lib/ink/tools";
import type { InkFrame, InkRect, InkSample, InkStroke } from "@/lib/ink/types";

/*
 * Committed ink on two canvases: highlighters on one (multiply-blended by
 * CSS, under the pens) and everything else on the other. Nothing here runs
 * on its own: drawing happens when strokes change or the surface resizes
 * (docs/ink-plan.md, "Rendering engine").
 *
 * - Each stroke's Path2D is built once, in surface units, and drawn through
 *   the canvas transform, so a new size never recomputes geometry.
 * - A new stroke is drawn on top of what is there; erasing redraws only the
 *   rectangle it touched, with the strokes the spatial index finds there.
 */

/** Canvas backing stores larger than this are drawn at a lower resolution. */
const MAX_CANVAS_PIXELS = 16_000_000;
/** Device pixel ratios above this cost memory and fill rate for no visible gain on ink. */
const MAX_DPR = 2;

const paths = new WeakMap<InkStroke, Path2D>();

/*
 * Paths are built from numbers, not from SVG path text: formatting and
 * parsing the text was the slowest step of a cold redraw (ink-bench.ts).
 * The curves are the same as geometry.ts's outlinePath and centerlinePath.
 */

/** A closed path through outline points: quadratic curves between their midpoints. */
function outlinePath2D(outline: readonly number[][]) {
  const path = new Path2D();
  if (outline.length < 2) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let index = 0; index < outline.length; index += 1) {
    const [x0, y0] = outline[index];
    const [x1, y1] = outline[(index + 1) % outline.length];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

/** An open path along samples, smoothed the same way: dashed and dotted strokes. */
function centerlinePath2D(samples: readonly { x: number; y: number }[]) {
  const path = new Path2D();
  if (!samples.length) return path;
  path.moveTo(samples[0].x, samples[0].y);
  if (samples.length === 1) {
    path.lineTo(samples[0].x, samples[0].y);
    return path;
  }
  for (let index = 1; index < samples.length - 1; index += 1) {
    const point = samples[index];
    const next = samples[index + 1];
    path.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
  }
  const last = samples[samples.length - 1];
  path.lineTo(last.x, last.y);
  return path;
}

function strokePath(stroke: InkStroke) {
  let path = paths.get(stroke);
  if (!path) {
    const samples = strokeSamples(stroke);
    path = stroke.lineStyle === "solid" ? outlinePath2D(strokeOutline(samples, stroke.brush, stroke.width)) : centerlinePath2D(samples);
    paths.set(stroke, path);
  }
  return path;
}

/** Draws one stroke in surface units on a context already set to its transform. */
export function paintStroke(context: CanvasRenderingContext2D, stroke: InkStroke) {
  const path = strokePath(stroke);
  context.globalAlpha = stroke.opacity;
  if (stroke.lineStyle === "solid") {
    context.fillStyle = stroke.color;
    context.fill(path);
    return;
  }
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.setLineDash(dashPattern(stroke.lineStyle, stroke.width));
  context.stroke(path);
  context.setLineDash([]);
}

/** Draws samples still being written, without caching: the live stroke. */
export function paintLiveStroke(context: CanvasRenderingContext2D, samples: readonly InkSample[], style: Pick<InkStroke, "brush" | "color" | "opacity" | "width" | "lineStyle">) {
  if (!samples.length) return;
  context.globalAlpha = style.opacity;
  if (style.lineStyle === "solid") {
    context.fillStyle = style.color;
    context.fill(outlinePath2D(strokeOutline(samples, style.brush, style.width, false)));
    return;
  }
  context.strokeStyle = style.color;
  context.lineWidth = style.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.setLineDash(dashPattern(style.lineStyle, style.width));
  context.stroke(centerlinePath2D(samples));
  context.setLineDash([]);
}

/** A 2D affine map, `[a, b, c, d, e, f]` as canvas `setTransform` takes it. */
export type InkMatrix = readonly [number, number, number, number, number, number];
export const IDENTITY_INK_MATRIX: InkMatrix = [1, 0, 0, 1, 0, 0];

/**
 * How a surface is drawn: its CSS size, CSS px per view unit (`scale`), backing
 * pixels per CSS px (`dpr`), and the map from stroke units to view units (a
 * gallery photo edited since it was inked; identity elsewhere).
 */
export type InkCanvasSize = { cssWidth: number; cssHeight: number; scale: number; dpr: number; matrix?: InkMatrix };

/** On battery, ink is drawn at most this many device pixels per CSS pixel (ink-power.ts). */
const MAX_DPR_ON_BATTERY = 1.5;

/**
 * Backing pixels per CSS px: the screen's ratio times any zoom an ancestor
 * applies (so a zoomed photo's ink stays sharp), capped by `MAX_DPR` (1.5 on
 * battery) and the canvas pixel budget.
 */
export function inkCanvasRatio(cssWidth: number, cssHeight: number, devicePixelRatio = globalThis.devicePixelRatio || 1, zoom = 1, onBattery = false) {
  const area = Math.max(1, cssWidth * cssHeight);
  const cap = (onBattery ? MAX_DPR_ON_BATTERY : MAX_DPR) * Math.max(1, zoom);
  return Math.max(0.5, Math.min(devicePixelRatio * Math.max(1, zoom), cap, Math.sqrt(MAX_CANVAS_PIXELS / area)));
}

/** Sets a context to draw in stroke units for a surface of this size. */
export function applyInkTransform(context: CanvasRenderingContext2D, size: InkCanvasSize) {
  const ratio = size.dpr * size.scale;
  const [a, b, c, d, e, f] = size.matrix ?? IDENTITY_INK_MATRIX;
  context.setTransform(ratio * a, ratio * b, ratio * c, ratio * d, ratio * e, ratio * f);
}

export function sizeCanvas(canvas: HTMLCanvasElement, size: InkCanvasSize) {
  const width = Math.max(1, Math.round(size.cssWidth * size.dpr));
  const height = Math.max(1, Math.round(size.cssHeight * size.dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

export class InkRenderer {
  private order: InkStroke[] = [];
  private readonly byId = new Map<string, InkStroke>();
  private readonly index: InkSpatialIndex;
  private size: InkCanvasSize | null = null;
  private released = false;

  constructor(private readonly canvases: { highlight: HTMLCanvasElement; pen: HTMLCanvasElement }, frame: InkFrame) {
    this.index = new InkSpatialIndex(Math.max(16, frame.width / 10));
  }

  /** The strokes as drawn now, oldest first. */
  get strokes(): readonly InkStroke[] {
    return this.order;
  }

  has(id: string) {
    return this.byId.has(id);
  }

  private bounds(stroke: InkStroke) {
    return inflateRect(stroke.bounds, strokeReach(stroke.brush, stroke.width) + 1);
  }

  private context(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context || !this.size) return null;
    applyInkTransform(context, this.size);
    return context;
  }

  private canvasFor(stroke: InkStroke) {
    return stroke.brush === "highlighter" ? this.canvases.highlight : this.canvases.pen;
  }

  /** Sets the size the surface is shown at and redraws everything. */
  resize(size: InkCanvasSize) {
    this.size = size;
    if (this.released) return;
    sizeCanvas(this.canvases.highlight, size);
    sizeCanvas(this.canvases.pen, size);
    this.redraw(null);
  }

  /**
   * Replaces the strokes. When the old list is a prefix of the new one (a
   * stroke was just added), only the new strokes are painted; otherwise the
   * area every removed, changed or inserted stroke covers is redrawn.
   */
  setStrokes(strokes: readonly InkStroke[]) {
    const previous = this.order;
    const appendedOnly = previous.length <= strokes.length && previous.every((stroke, position) => strokes[position] === stroke);
    let dirty: InkRect | null = null;
    if (!appendedOnly) {
      const next = new Map(strokes.map((stroke) => [stroke.id, stroke]));
      for (const stroke of previous) if (next.get(stroke.id) !== stroke) dirty = unionRect(dirty, this.bounds(stroke));
      for (const stroke of strokes) if (this.byId.get(stroke.id) !== stroke) dirty = unionRect(dirty, this.bounds(stroke));
    }

    this.order = [...strokes];
    this.byId.clear();
    this.index.clear();
    for (const stroke of strokes) {
      this.byId.set(stroke.id, stroke);
      this.index.insert(stroke.id, this.bounds(stroke));
    }

    if (appendedOnly) for (const stroke of strokes.slice(previous.length)) this.paint(stroke);
    // The same strokes in another order: repaint all of it.
    else this.redraw(dirty);
  }

  private paint(stroke: InkStroke) {
    if (this.released) return;
    const context = this.context(this.canvasFor(stroke));
    if (context) paintStroke(context, stroke);
  }

  /** Redraws one area (in surface units), or everything. */
  private redraw(area: InkRect | null) {
    if (this.released || !this.size) return;
    for (const canvas of [this.canvases.highlight, this.canvases.pen]) {
      const context = this.context(canvas);
      if (!context) continue;
      context.save();
      if (area) {
        context.beginPath();
        context.rect(area.x, area.y, area.width, area.height);
        context.clip();
        context.clearRect(area.x, area.y, area.width, area.height);
      } else {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        applyInkTransform(context, this.size);
      }
      const near = area ? this.index.query(area) : null;
      for (const stroke of this.order) {
        if (this.canvasFor(stroke) !== canvas) continue;
        if (near && (!near.has(stroke.id) || !rectsIntersect(this.bounds(stroke), area!))) continue;
        paintStroke(context, stroke);
      }
      context.restore();
    }
  }

  /** Strokes whose bounds meet a rectangle in surface units. */
  near(rect: InkRect): InkStroke[] {
    const ids = this.index.query(rect);
    return this.order.filter((stroke) => ids.has(stroke.id));
  }

  /** Frees the backing stores while the surface is far off screen. */
  release() {
    if (this.released) return;
    this.released = true;
    for (const canvas of [this.canvases.highlight, this.canvases.pen]) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /** Brings the backing stores back and repaints from the path cache. */
  restore() {
    if (!this.released) return;
    this.released = false;
    if (this.size) this.resize(this.size);
  }
}
