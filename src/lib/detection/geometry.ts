/**
 * Outline geometry for hand-tagged and edited objects: reducing a dense mask
 * outline or freehand stroke to a few control points, and the smooth curve
 * drawn through them.
 */
import { measureDetection, type Box, type CurveKind, type Detection, type DetectionShape, type Point } from "@/lib/detection/results";

function distanceToSegment([x, y]: Point, [x1, y1]: Point, [x2, y2]: Point) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length)) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** Ramer–Douglas–Peucker on an open polyline. */
function simplifyOpen(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  let index = 0;
  let farthest = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = distanceToSegment(points[i], points[0], points[points.length - 1]);
    if (distance > farthest) {
      farthest = distance;
      index = i;
    }
  }
  if (farthest <= tolerance) return [points[0], points[points.length - 1]];
  return [...simplifyOpen(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyOpen(points.slice(index), tolerance)];
}

/** Ramer–Douglas–Peucker on a closed outline, split at the first point and the point farthest from it. */
export function simplifyClosed(points: Point[], tolerance: number): Point[] {
  if (points.length <= 4) return points;
  let far = 0;
  let best = -1;
  for (let i = 0; i < points.length; i += 1) {
    const distance = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (distance > best) {
      best = distance;
      far = i;
    }
  }
  const first = simplifyOpen(points.slice(0, far + 1), tolerance);
  const second = simplifyOpen([...points.slice(far), points[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/**
 * Few enough control points to drag comfortably, but enough to follow the
 * outline: the smallest tolerance giving at most `maxPoints`.
 */
export function controlPointsFor(outline: Point[], maxPoints = 24, minPoints = 6): Point[] {
  if (outline.length <= maxPoints) return outline.map(([x, y]) => [x, y]);
  const xs = outline.map(([x]) => x);
  const ys = outline.map(([, y]) => y);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  let low = 0;
  let high = size / 4;
  let result = simplifyClosed(outline, high);
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    const candidate = simplifyClosed(outline, middle);
    if (candidate.length > maxPoints) low = middle;
    else {
      high = middle;
      result = candidate;
    }
  }
  if (result.length < minPoints) result = evenlySpaced(outline, minPoints);
  return result.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
}

/** `count` points spaced evenly along a closed outline. */
function evenlySpaced(outline: Point[], count: number): Point[] {
  const lengths = [0];
  for (let i = 1; i <= outline.length; i += 1) {
    const [x1, y1] = outline[i - 1];
    const [x2, y2] = outline[i % outline.length];
    lengths.push(lengths[i - 1] + Math.hypot(x2 - x1, y2 - y1));
  }
  const total = lengths[lengths.length - 1];
  const result: Point[] = [];
  let segment = 0;
  for (let k = 0; k < count; k += 1) {
    const target = (total * k) / count;
    while (segment < outline.length - 1 && lengths[segment + 1] < target) segment += 1;
    const span = lengths[segment + 1] - lengths[segment] || 1;
    const t = (target - lengths[segment]) / span;
    const [x1, y1] = outline[segment];
    const [x2, y2] = outline[(segment + 1) % outline.length];
    result.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
  }
  return result;
}

/**
 * A closed centripetal Catmull–Rom spline through the control points: smooth,
 * passing through every point, and free of the loops and cusps the uniform
 * spline makes when points are unevenly spaced.
 */
export function smoothClosedCurve(points: Point[], samplesPerSegment = 12): Point[] {
  const n = points.length;
  if (n < 3) return points;
  const result: Point[] = [];
  const knot = (a: Point, b: Point) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  for (let i = 0; i < n; i += 1) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let s = 0; s < samplesPerSegment; s += 1) {
      const t = t1 + ((t2 - t1) * s) / samplesPerSegment;
      const lerp = (a: Point, b: Point, ta: number, tb: number): Point => {
        const w = (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      };
      const a1 = lerp(p0, p1, t0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      const point = lerp(b1, b2, t1, t2);
      result.push([Math.round(point[0] * 10) / 10, Math.round(point[1] * 10) / 10]);
    }
  }
  return result;
}

/** A freehand stroke, steadied: a moving average removes hand tremor before the control points are picked. */
export function smoothStroke(stroke: Point[], radius = 3): Point[] {
  const n = stroke.length;
  if (n < 5) return stroke;
  return stroke.map((_, index) => {
    let x = 0;
    let y = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const [px, py] = stroke[(index + offset + n) % n];
      x += px;
      y += py;
      count += 1;
    }
    return [x / count, y / count] as Point;
  });
}

export function boxCorners([x1, y1, x2, y2]: Box): Point[] {
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
}

export function boundsOf(points: Point[]): Box {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((value) => Math.round(value * 100) / 100) as Box;
}

/** The outline a shape's control points define. */
export function outlineOf(shape: DetectionShape, points: Point[], curve: CurveKind) {
  if (shape === "box") return boxCorners(boundsOf(points));
  return curve === "smooth" ? smoothClosedCurve(points) : points;
}

export type Geometry = { shape: DetectionShape; points: Point[]; curve: CurveKind };

/** The control points to edit an object by: its box corners, its saved control points, or a few points along its mask. */
export function editableGeometry(detection: Detection): Geometry {
  if (detection.shape === "box" || detection.polygon.length < 3) return { shape: "box", points: boxCorners(detection.box), curve: "linear" };
  if (detection.controlPoints && detection.controlPoints.length >= 3) return { shape: "polygon", points: detection.controlPoints, curve: detection.curve ?? "smooth" };
  return { shape: "polygon", points: controlPointsFor(detection.polygon), curve: "smooth" };
}

/**
 * The object with a new outline, measured again. A model detection becomes
 * "edited", keeping what the model found the first time it changes.
 */
export function withGeometry(detection: Detection, geometry: Geometry, at = new Date().toISOString()): Detection {
  const outline = outlineOf(geometry.shape, geometry.points, geometry.curve);
  const box = boundsOf(outline);
  const polygon = geometry.shape === "box" ? [] : outline;
  return {
    ...detection,
    box,
    polygon,
    ...measureDetection({ box, polygon }),
    shape: geometry.shape,
    controlPoints: geometry.shape === "box" ? undefined : geometry.points,
    curve: geometry.shape === "box" ? undefined : geometry.curve,
    ...markEdited(detection),
    editedAt: at,
  };
}

/** The fields that record a change to a model detection. */
export function markEdited(detection: Detection): Pick<Detection, "origin" | "original"> {
  if (detection.origin === "manual") return { origin: "manual", original: undefined };
  return {
    origin: "edited",
    original: detection.original ?? { label: detection.label, confidence: detection.confidence, box: detection.box, polygon: detection.polygon },
  };
}

/** A new hand-tagged object. */
export function manualDetection(id: number, label: string, geometry: Geometry, at = new Date().toISOString()): Detection {
  const base: Detection = {
    id,
    promptId: "manual",
    label,
    confidence: 1,
    box: [0, 0, 0, 0],
    polygon: [],
    area: 0,
    perimeter: 0,
    centroid: [0, 0],
    origin: "manual",
    shape: geometry.shape,
  };
  return withGeometry(base, geometry, at);
}

/** Intersection over union of two boxes. */
export function boxIou(a: Box, b: Box) {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = width * height;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Where to insert a point clicked near the outline: after the control point that starts the nearest segment. */
export function nearestSegment(points: Point[], point: Point) {
  let best = 0;
  let distance = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const d = distanceToSegment(point, points[i], points[(i + 1) % points.length]);
    if (d < distance) {
      distance = d;
      best = i;
    }
  }
  return { index: best + 1, distance };
}
