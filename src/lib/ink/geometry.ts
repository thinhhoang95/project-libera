import { getStroke } from "perfect-freehand";
import { strokeOptions } from "@/lib/ink/tools";
import type { InkRect, InkSample } from "@/lib/ink/types";

/*
 * Stroke geometry, in surface units. Outlines come from `perfect-freehand`;
 * dashed and dotted strokes draw their smoothed centerline instead.
 */

type Point = { x: number; y: number };

/** Whether samples carry real pressure, not a mouse's constant 0.5 (or 0). */
export function hasPressure(samples: readonly InkSample[]) {
  if (samples.length < 2) return false;
  const first = samples[0].pressure;
  return samples.some((sample) => Math.abs(sample.pressure - first) > 0.01);
}

/** The filled outline of a pen, marker or highlighter stroke, as [x, y] pairs. */
export function strokeOutline(samples: readonly InkSample[], brush: string, width: number, complete = true): number[][] {
  if (!samples.length) return [];
  const simulate = brush === "pen" && !hasPressure(samples);
  return getStroke(
    samples.map((sample) => [sample.x, sample.y, simulate ? 0.5 : sample.pressure]),
    strokeOptions(brush, width, complete, simulate),
  );
}

const round = (value: number) => Math.round(value * 100) / 100;

/** A closed SVG path through outline points: quadratic curves between their midpoints. */
export function outlinePath(outline: readonly number[][]) {
  if (outline.length < 2) return "";
  const [first] = outline;
  let path = `M${round(first[0])} ${round(first[1])}Q`;
  for (let index = 0; index < outline.length; index += 1) {
    const [x0, y0] = outline[index];
    const [x1, y1] = outline[(index + 1) % outline.length];
    path += `${round(x0)} ${round(y0)} ${round((x0 + x1) / 2)} ${round((y0 + y1) / 2)} `;
  }
  return `${path.trimEnd()}Z`;
}

/** An open SVG path along the samples, smoothed the same way, for dashed and dotted strokes. */
export function centerlinePath(samples: readonly Point[]) {
  if (!samples.length) return "";
  const [first] = samples;
  if (samples.length === 1) return `M${round(first.x)} ${round(first.y)}L${round(first.x)} ${round(first.y)}`;
  let path = `M${round(first.x)} ${round(first.y)}`;
  for (let index = 1; index < samples.length - 1; index += 1) {
    const point = samples[index];
    const next = samples[index + 1];
    path += `Q${round(point.x)} ${round(point.y)} ${round((point.x + next.x) / 2)} ${round((point.y + next.y) / 2)}`;
  }
  const last = samples[samples.length - 1];
  return `${path}L${round(last.x)} ${round(last.y)}`;
}

/** Half the widest visible extent of a stroke, for hit testing and dirty rects. */
export function strokeReach(brush: string, width: number) {
  return brush === "pen" ? width * 0.8 : width / 2;
}

export function inflateRect(rect: InkRect, by: number): InkRect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}

export function rectsIntersect(a: InkRect, b: InkRect) {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

export function unionRect(a: InkRect | null, b: InkRect): InkRect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function distanceToSegmentSquared(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0;
  const x = start.x + t * dx - point.x;
  const y = start.y + t * dy - point.y;
  return x * x + y * y;
}

/** Whether a circle touches a stroke's centerline widened by `reach`. */
export function hitTestSamples(samples: readonly Point[], reach: number, center: Point, radius: number) {
  const limit = (reach + radius) ** 2;
  if (samples.length === 1) return (samples[0].x - center.x) ** 2 + (samples[0].y - center.y) ** 2 <= limit;
  for (let index = 1; index < samples.length; index += 1) {
    if (distanceToSegmentSquared(center, samples[index - 1], samples[index]) <= limit) return true;
  }
  return false;
}

function lerpSample(a: InkSample, b: InkSample, t: number): InkSample {
  const sample: InkSample = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: a.pressure + (b.pressure - a.pressure) * t };
  if (a.tiltX !== undefined && b.tiltX !== undefined) sample.tiltX = a.tiltX + (b.tiltX - a.tiltX) * t;
  if (a.tiltY !== undefined && b.tiltY !== undefined) sample.tiltY = a.tiltY + (b.tiltY - a.tiltY) * t;
  if (a.t !== undefined && b.t !== undefined) sample.t = a.t + (b.t - a.t) * t;
  return sample;
}

/** The part of segment a→b (as t from 0 to 1) inside a circle, or null. */
function insideInterval(a: Point, b: Point, center: Point, radius: number): [number, number] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - center.x;
  const fy = a.y - center.y;
  const qa = dx * dx + dy * dy;
  const qc = fx * fx + fy * fy - radius * radius;
  if (qa === 0) return qc <= 0 ? [0, 1] : null;
  const qb = 2 * (fx * dx + fy * dy);
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const from = Math.max(0, (-qb - root) / (2 * qa));
  const to = Math.min(1, (-qb + root) / (2 * qa));
  return from <= to ? [from, to] : null;
}

const isInside = (point: Point, center: Point, radius: number) => (point.x - center.x) ** 2 + (point.y - center.y) ** 2 < radius * radius;

/**
 * The partial eraser: cuts a stroke where a circle (already widened by the
 * stroke's reach) covers its centerline. Returns the pieces left, which may
 * be none, or null when the circle misses the stroke.
 */
export function splitSamplesByCircle(samples: readonly InkSample[], center: Point, radius: number): InkSample[][] | null {
  if (!samples.length) return null;
  if (samples.length === 1) return isInside(samples[0], center, radius) ? [] : null;

  const pieces: InkSample[][] = [];
  let current: InkSample[] = isInside(samples[0], center, radius) ? [] : [samples[0]];
  let cut = current.length === 0;

  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1];
    const b = samples[index];
    const inside = insideInterval(a, b, center, radius);

    if (!inside || (inside[0] === inside[1] && inside[0] > 0 && inside[0] < 1)) {
      // Missed, or only grazed at one point.
      current.push(b);
      continue;
    }

    cut = true;
    const [from, to] = inside;
    if (from > 0) current.push(lerpSample(a, b, from));
    if (current.length) pieces.push(current);
    current = [];
    if (to < 1) current.push(lerpSample(a, b, to), b);
  }

  if (current.length) pieces.push(current);
  if (!cut) return null;
  return pieces.filter((piece) => piece.length >= 2 && pathLength(piece) > 0);
}

export function pathLength(samples: readonly Point[]) {
  let length = 0;
  for (let index = 1; index < samples.length; index += 1) {
    length += Math.hypot(samples[index].x - samples[index - 1].x, samples[index].y - samples[index - 1].y);
  }
  return length;
}

/**
 * Ramer–Douglas–Peucker over the centerline. A sample is also kept where
 * pressure turns, so a pen's thick and thin parts keep their shape.
 */
export function simplifySamples(samples: readonly InkSample[], tolerance: number, pressureTolerance = 0.08): InkSample[] {
  if (samples.length <= 2 || tolerance <= 0) return [...samples];
  const keep = new Uint8Array(samples.length);
  keep[0] = 1;
  keep[samples.length - 1] = 1;
  const stack: [number, number][] = [[0, samples.length - 1]];
  const limit = tolerance * tolerance;

  while (stack.length) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let distance = limit;
    let pressureFarthest = -1;
    let pressureDistance = pressureTolerance;

    for (let index = first + 1; index < last; index += 1) {
      const squared = distanceToSegmentSquared(samples[index], samples[first], samples[last]);
      if (squared > distance) {
        distance = squared;
        farthest = index;
      }
      const span = last - first;
      const expected = samples[first].pressure + ((samples[last].pressure - samples[first].pressure) * (index - first)) / span;
      const pressureOff = Math.abs(samples[index].pressure - expected);
      if (pressureOff > pressureDistance) {
        pressureDistance = pressureOff;
        pressureFarthest = index;
      }
    }

    const split = farthest >= 0 ? farthest : pressureFarthest;
    if (split >= 0) {
      keep[split] = 1;
      stack.push([first, split], [split, last]);
    }
  }

  return samples.filter((_, index) => keep[index] === 1);
}
