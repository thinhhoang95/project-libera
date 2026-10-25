// Ink throughput on this computer (docs/ink-plan.md, "Performance budget"):
// the CPU work behind drawing and saving a dense page. Canvas painting is not
// measured here (no canvas in Node); geometry is what a redraw recomputes when
// the Path2D cache is cold. Run with `npm run bench:ink`.

import { performance } from "node:perf_hooks";
import { decodeInkSamples, emptyInkAuthorFile, encodeInkSamples, sampleBounds } from "../../src/lib/ink/codec";
import { outlinePath, simplifySamples, strokeOutline } from "../../src/lib/ink/geometry";
import { applyInkOps, mergeInkFiles } from "../../src/lib/ink/merge";
import { inkToSvg } from "../../src/lib/ink/svg";
import type { InkSample, InkStroke } from "../../src/lib/ink/types";

const STROKES = 5000;
const SAMPLES_PER_STROKE = 60;

function handwriting(index: number): InkSample[] {
  const x0 = 40 + (index % 50) * 10;
  const y0 = 60 + Math.floor(index / 50) * 7;
  return Array.from({ length: SAMPLES_PER_STROKE }, (_, step) => ({
    x: x0 + step * 0.35 + Math.sin(step / 3 + index) * 3,
    y: y0 + Math.cos(step / 4 + index) * 4,
    pressure: 0.35 + Math.sin(step / 10) * 0.25,
    tiltX: 20,
    tiltY: -10,
    t: step * 4,
  }));
}

function time<T>(label: string, run: () => T, per = STROKES) {
  const start = performance.now();
  const result = run();
  const elapsed = performance.now() - start;
  console.log(`${label.padEnd(44)} ${elapsed.toFixed(1).padStart(8)} ms   ${(elapsed / per * 1000).toFixed(1).padStart(7)} µs each`);
  return result;
}

const raw = Array.from({ length: STROKES }, (_, index) => handwriting(index));
const simplified = time("simplify (RDP, 0.1 unit)", () => raw.map((samples) => simplifySamples(samples, 0.1)));
const kept = simplified.reduce((sum, samples) => sum + samples.length, 0) / (STROKES * SAMPLES_PER_STROKE);
console.log(`  samples kept: ${(kept * 100).toFixed(0)}%`);
const packed = time("encode", () => simplified.map((samples) => encodeInkSamples(samples)));
console.log(`  bytes per kept sample: ${(packed.reduce((sum, text) => sum + text.length * 0.75, 0) / simplified.reduce((sum, samples) => sum + samples.length, 0)).toFixed(2)}`);
time("decode", () => packed.map((text) => decodeInkSamples(text)));
const outlines = time("pen outline (perfect-freehand)", () => simplified.map((samples) => strokeOutline(samples, "pen", 1.5)));
time("outline → SVG path data (Path2D input)", () => outlines.map((outline) => outlinePath(outline)));

const strokes: InkStroke[] = packed.map((points, index) => ({
  id: `s${index}`,
  brush: "pen",
  color: "#1f2328",
  opacity: 1,
  width: 1.5,
  lineStyle: "solid",
  points,
  bounds: sampleBounds(simplified[index]),
  createdAt: new Date(1_700_000_000_000 + index).toISOString(),
}));
const frame = { unit: "pt" as const, width: 612, height: 792 };
const file = time("apply 5,000 additions to one author file", () => applyInkOps(emptyInkAuthorFile({ key: "aaaaaa" }, frame), { add: strokes }), 1);
const json = JSON.stringify(file);
console.log(`  author file: ${(json.length / 1024).toFixed(0)} KB for ${STROKES} strokes`);
time("parse + merge 3 authors' files", () => mergeInkFiles([0, 1, 2].map(() => JSON.parse(json))), 1);
time("one more stroke into that file", () => applyInkOps(file, { add: [{ ...strokes[0], id: "extra" }] }), 1);
time("SVG of the whole page", () => inkToSvg(strokes, frame), 1);
