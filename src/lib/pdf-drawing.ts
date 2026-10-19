import type {
  PdfAnnotationPoint,
  PdfAnnotationRect,
  PdfInkAnnotation,
  PdfShapeAnnotation,
  PdfShapeKind,
} from "@/lib/types";

/** Pen strokes and shapes: annotations drawn on the page rather than over text. */
export type PdfDrawingAnnotation = PdfShapeAnnotation | PdfInkAnnotation;

type Size = { width: number; height: number };
type Point = { x: number; y: number };

export function isDrawingAnnotation(annotation: { type: string }): annotation is PdfDrawingAnnotation {
  return annotation.type === "shape" || annotation.type === "ink";
}

export function isClosedShape(shape: PdfShapeKind) {
  return shape === "rectangle" || shape === "ellipse";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Page-fraction bounds of a drawing, ignoring stroke width. */
export function drawingBounds(annotation: PdfDrawingAnnotation): PdfAnnotationRect {
  const points = annotation.type === "ink" ? annotation.points : [annotation.from, annotation.to];
  let left = 1;
  let top = 1;
  let right = 0;
  let bottom = 0;

  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }

  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Moves a drawing by a page-fraction delta, keeping all of it on the page. */
export function translateDrawing(
  annotation: PdfDrawingAnnotation,
  deltaX: number,
  deltaY: number,
): Pick<PdfInkAnnotation, "points"> | Pick<PdfShapeAnnotation, "from" | "to"> {
  const bounds = drawingBounds(annotation);
  const dx = clamp(deltaX, -bounds.x, 1 - bounds.x - bounds.width);
  const dy = clamp(deltaY, -bounds.y, 1 - bounds.y - bounds.height);
  const move = (point: PdfAnnotationPoint) => ({ x: point.x + dx, y: point.y + dy });

  if (annotation.type === "ink") {
    return { points: annotation.points.map(move) };
  }

  return { from: move(annotation.from), to: move(annotation.to) };
}

export function toPixels(point: PdfAnnotationPoint, size: Size): Point {
  return { x: point.x * size.width, y: point.y * size.height };
}

export function distanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1) : 0;

  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function distanceToPolyline(point: Point, points: Point[]) {
  if (points.length === 1) {
    return Math.hypot(point.x - points[0].x, point.y - points[0].y);
  }

  let distance = Infinity;

  for (let index = 1; index < points.length; index += 1) {
    distance = Math.min(distance, distanceToSegment(point, points[index - 1], points[index]));
  }

  return distance;
}

/**
 * Whether a pixel point touches a drawing's visible stroke. Rectangles and
 * ellipses are outlines, so only their edge counts, never their inside.
 */
export function hitTestDrawing(
  annotation: PdfDrawingAnnotation,
  point: Point,
  size: Size,
  zoom: number,
  tolerance: number,
) {
  const reach = tolerance + (annotation.strokeWidth * zoom) / 2;

  if (annotation.type === "ink") {
    return distanceToPolyline(point, annotation.points.map((item) => toPixels(item, size))) <= reach;
  }

  const from = toPixels(annotation.from, size);
  const to = toPixels(annotation.to, size);

  if (annotation.shape === "line" || annotation.shape === "arrow") {
    return distanceToSegment(point, from, to) <= reach;
  }

  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);

  if (annotation.shape === "rectangle") {
    const corners = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
      { x: left, y: top },
    ];

    return distanceToPolyline(point, corners) <= reach;
  }

  const rx = (right - left) / 2;
  const ry = (bottom - top) / 2;

  if (rx < 1 || ry < 1) {
    return distanceToSegment(point, { x: left, y: top }, { x: right, y: bottom }) <= reach;
  }

  // Radial distance from the outline, scaled back to pixels: close enough for
  // picking, and exact for circles.
  const normalized = Math.hypot((point.x - left - rx) / rx, (point.y - top - ry) / ry);

  return Math.abs(normalized - 1) * Math.min(rx, ry) <= reach;
}

/**
 * Shift-drag constraints: squares and circles for closed shapes, and lines
 * snapped to the nearest 45°.
 */
export function constrainShapeEnd(shape: PdfShapeKind, from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  if (isClosedShape(shape)) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));

    return { x: from.x + Math.sign(dx || 1) * side, y: from.y + Math.sign(dy || 1) * side };
  }

  const length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);

  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

/** The filled head of an arrow ending at `to`, as SVG polygon points. */
export function arrowHeadPoints(from: Point, to: Point, strokeWidthPx: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.max(8, strokeWidthPx * 4);
  const spread = Math.PI / 7;
  const corner = (side: number) => ({
    x: to.x - length * Math.cos(angle + side * spread),
    y: to.y - length * Math.sin(angle + side * spread),
  });
  const left = corner(-1);
  const right = corner(1);

  return `${to.x},${to.y} ${left.x},${left.y} ${right.x},${right.y}`;
}

/** Where the arrow's shaft stops, so its square end hides inside the head. */
export function arrowShaftEnd(from: Point, to: Point, strokeWidthPx: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const inset = Math.min(length, Math.max(8, strokeWidthPx * 4) * 0.6);

  return length
    ? { x: to.x - ((to.x - from.x) / length) * inset, y: to.y - ((to.y - from.y) / length) * inset }
    : to;
}

/**
 * A smooth SVG path through pen samples: quadratic curves between the
 * midpoints of successive samples, which removes the jitter of raw input.
 */
export function smoothStrokePath(points: Point[]) {
  if (!points.length) {
    return "";
  }

  const [first] = points;

  if (points.length === 1) {
    // A tap leaves a dot: round caps on a zero-length segment.
    return `M${first.x} ${first.y}L${first.x} ${first.y}`;
  }

  if (points.length === 2) {
    return `M${first.x} ${first.y}L${points[1].x} ${points[1].y}`;
  }

  let path = `M${first.x} ${first.y}`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];

    path += `Q${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.y + next.y) / 2}`;
  }

  const last = points[points.length - 1];

  return `${path}L${last.x} ${last.y}`;
}

/** Whether a new pen sample is far enough from the last one to keep. */
export function shouldKeepSample(last: Point | undefined, next: Point, minDistancePx: number) {
  return !last || Math.hypot(next.x - last.x, next.y - last.y) >= minDistancePx;
}
