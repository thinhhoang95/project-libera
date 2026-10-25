import { cropPixels, orientedSize, type CropRect, type PhotoEdits } from "@/lib/photo-edits";
import type { InkFrame, InkRect } from "@/lib/ink/types";

type Point = { x: number; y: number };
type Size = { width: number; height: number };

/*
 * Mapping between a surface's units and the screen, and, for gallery photos,
 * between the original photo (where strokes are stored) and the edited file
 * shown today (docs/ink-plan.md, "Gallery photos").
 */

/** How a surface is drawn on screen: CSS px per unit, and where its origin is. */
export type InkViewport = { scale: number; offsetX: number; offsetY: number };

export function viewportForFrame(frame: InkFrame, cssWidth: number, offsetX = 0, offsetY = 0): InkViewport {
  return { scale: frame.width > 0 ? cssWidth / frame.width : 1, offsetX, offsetY };
}

export function unitsToCss(point: Point, viewport: InkViewport): Point {
  return { x: point.x * viewport.scale + viewport.offsetX, y: point.y * viewport.scale + viewport.offsetY };
}

export function cssToUnits(point: Point, viewport: InkViewport): Point {
  return { x: (point.x - viewport.offsetX) / viewport.scale, y: (point.y - viewport.offsetY) / viewport.scale };
}

export function rectToCss(rect: InkRect, viewport: InkViewport): InkRect {
  return { x: rect.x * viewport.scale + viewport.offsetX, y: rect.y * viewport.scale + viewport.offsetY, width: rect.width * viewport.scale, height: rect.height * viewport.scale };
}

// ---- Gallery photo views ------------------------------------------------------

/**
 * How the current file is made from the original: the geometric part of the
 * photo edits baked into it so far, in the editor's order (rotate → flip →
 * crop). Color edits do not move ink and are not kept.
 */
export type PhotoInkView = Pick<PhotoEdits, "rotate" | "flipH" | "flipV" | "crop">;

export const IDENTITY_PHOTO_VIEW: PhotoInkView = { rotate: 0, flipH: false, flipV: false, crop: null };

/** A quarter-turn-and-mirror map of the unit square: p → M·p + t. */
type Orientation = { a: number; b: number; c: number; d: number; tx: number; ty: number };

function orientation(view: Pick<PhotoInkView, "rotate" | "flipH" | "flipV">): Orientation {
  // Clockwise quarter turns: (x, y) → (1 − y, x), as `rotateCropClockwise`.
  let current: Orientation = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  for (let turn = 0; turn < view.rotate / 90; turn += 1) {
    current = { a: -current.c, b: -current.d, c: current.a, d: current.b, tx: 1 - current.ty, ty: current.tx };
  }
  if (view.flipH) current = { ...current, a: -current.a, b: -current.b, tx: 1 - current.tx };
  if (view.flipV) current = { ...current, c: -current.c, d: -current.d, ty: 1 - current.ty };
  return current;
}

const orient = (point: Point, o: Orientation): Point => ({ x: o.a * point.x + o.b * point.y + o.tx, y: o.c * point.x + o.d * point.y + o.ty });

function invert(o: Orientation): Orientation {
  // The linear part is orthogonal: its inverse is its transpose.
  const a = o.a;
  const b = o.c;
  const c = o.b;
  const d = o.d;
  return { a, b, c, d, tx: -(a * o.tx + b * o.ty), ty: -(c * o.tx + d * o.ty) };
}

const sameOrientation = (x: Orientation, y: Orientation) =>
  [x.a - y.a, x.b - y.b, x.c - y.c, x.d - y.d, x.tx - y.tx, x.ty - y.ty].every((value) => Math.abs(value) < 1e-9);

const ROTATIONS: readonly PhotoInkView["rotate"][] = [0, 90, 180, 270];

/** The rotate and horizontal flip that make an orientation (vertical flips fold into them). */
function viewOf(target: Orientation): Pick<PhotoInkView, "rotate" | "flipH" | "flipV"> {
  for (const flipH of [false, true]) {
    for (const rotate of ROTATIONS) {
      if (sameOrientation(orientation({ rotate, flipH, flipV: false }), target)) return { rotate, flipH, flipV: false };
    }
  }
  throw new Error("Not a quarter-turn orientation.");
}

function orientRect(rect: CropRect, o: Orientation): CropRect {
  const a = orient({ x: rect.x, y: rect.y }, o);
  const b = orient({ x: rect.x + rect.width, y: rect.y + rect.height }, o);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

const FULL: CropRect = { x: 0, y: 0, width: 1, height: 1 };
const isFull = (rect: CropRect) => Math.abs(rect.x) < 1e-9 && Math.abs(rect.y) < 1e-9 && Math.abs(rect.width - 1) < 1e-9 && Math.abs(rect.height - 1) < 1e-9;

/**
 * The view after an edit is baked into a file that already shows `view`.
 * The edit's crop is relative to the edited file turned by the edit.
 */
export function composePhotoViews(view: PhotoInkView, edit: PhotoInkView): PhotoInkView {
  const first = orientation(view);
  const second = orientation(edit);
  const combined: Orientation = {
    a: second.a * first.a + second.b * first.c,
    b: second.a * first.b + second.b * first.d,
    c: second.c * first.a + second.d * first.c,
    d: second.c * first.b + second.d * first.d,
    tx: second.a * first.tx + second.b * first.ty + second.tx,
    ty: second.c * first.tx + second.d * first.ty + second.ty,
  };
  // The current file's area, in the original turned by the combined orientation.
  const area = orientRect(view.crop ?? FULL, second);
  const crop = edit.crop
    ? { x: area.x + edit.crop.x * area.width, y: area.y + edit.crop.y * area.height, width: edit.crop.width * area.width, height: edit.crop.height * area.height }
    : area;
  return { ...viewOf(combined), crop: isFull(crop) ? null : crop };
}

/** The pixel size of the current file, from the original's EXIF-upright size. */
export function photoViewSize(original: Size, view: PhotoInkView): Size {
  const turned = orientedSize(original.width, original.height, view.rotate);
  const region = cropPixels(view.crop, turned.width, turned.height);
  return { width: region.width, height: region.height };
}

/** A point on the original (pixels) to the same point on the current file (pixels). */
export function originalToView(point: Point, original: Size, view: PhotoInkView): Point {
  const turned = orientedSize(original.width, original.height, view.rotate);
  const unit = orient({ x: point.x / original.width, y: point.y / original.height }, orientation(view));
  const region = cropPixels(view.crop, turned.width, turned.height);
  return { x: unit.x * turned.width - region.left, y: unit.y * turned.height - region.top };
}

/** A point on the current file (pixels) back to the original (pixels). */
export function viewToOriginal(point: Point, original: Size, view: PhotoInkView): Point {
  const turned = orientedSize(original.width, original.height, view.rotate);
  const region = cropPixels(view.crop, turned.width, turned.height);
  const unit = orient({ x: (point.x + region.left) / turned.width, y: (point.y + region.top) / turned.height }, invert(orientation(view)));
  return { x: unit.x * original.width, y: unit.y * original.height };
}

/**
 * The view as a 2D affine map from original pixels to current-file pixels,
 * `[a, b, c, d, e, f]` as canvas `setTransform` takes it, so whole strokes
 * draw through it without mapping each sample.
 */
export function photoViewMatrix(original: Size, view: PhotoInkView): [number, number, number, number, number, number] {
  const origin = originalToView({ x: 0, y: 0 }, original, view);
  const xAxis = originalToView({ x: 1, y: 0 }, original, view);
  const yAxis = originalToView({ x: 0, y: 1 }, original, view);
  return [xAxis.x - origin.x, xAxis.y - origin.y, yAxis.x - origin.x, yAxis.y - origin.y, origin.x, origin.y];
}

export function normalizePhotoInkView(value: unknown): PhotoInkView {
  if (typeof value !== "object" || value === null) return IDENTITY_PHOTO_VIEW;
  const { rotate, flipH, flipV, crop } = value as Record<string, unknown>;
  const validCrop = typeof crop === "object" && crop !== null
    && ["x", "y", "width", "height"].every((key) => typeof (crop as Record<string, unknown>)[key] === "number" && Number.isFinite((crop as Record<string, number>)[key]))
    ? crop as CropRect
    : null;
  return {
    rotate: rotate === 90 || rotate === 180 || rotate === 270 ? rotate : 0,
    flipH: flipH === true,
    flipV: flipV === true,
    crop: validCrop && validCrop.width > 0 && validCrop.height > 0 ? validCrop : null,
  };
}
