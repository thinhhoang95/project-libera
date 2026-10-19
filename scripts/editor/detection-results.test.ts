import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DETECTION_PREFERENCES,
  inspectDetectionFolder,
  normalizeDetectionPreferences,
} from "../../electron/detection-preferences.cjs";
import {
  chiSquareUpperTail,
  computeStatistics,
  measureDetection,
  nearestNeighborStatistics,
  parseDetectionFile,
  passesConfidence,
  polygonArea,
  polygonCentroid,
  quadratStatistics,
  summarize,
  type Detection,
  type DetectionPrompt,
  type Point,
} from "../../src/lib/detection/results";

const close = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

test("preferences fall back to defaults and clamp numbers", () => {
  assert.deepEqual(normalizeDetectionPreferences(undefined), DEFAULT_DETECTION_PREFERENCES);
  const preferences = normalizeDetectionPreferences({ variant: "x", device: "gpu", confidence: "1.5", iou: 0.01, maxDetections: "12.6", imageSize: "960" });
  assert.equal(preferences.variant, "x");
  assert.equal(preferences.device, "cpu");
  assert.equal(preferences.confidence, 0.99);
  assert.equal(preferences.iou, 0.05);
  assert.equal(preferences.maxDetections, 13);
  assert.equal(preferences.imageSize, 960);
});

test("an empty or missing folder has nothing installed", () => {
  const report = inspectDetectionFolder("/nonexistent/libera-detection");
  assert.equal(report.exists, false);
  assert.equal(report.runtime, false);
  assert.deepEqual(Object.values(report.variants), [false, false, false, false, false]);
});

test("polygon measurements", () => {
  const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(polygonArea(square), 100);
  assert.deepEqual(polygonCentroid(square), [5, 5]);
  const measured = measureDetection({ box: [0, 0, 10, 10], polygon: square });
  assert.equal(measured.perimeter, 40);
  // Without a mask, the box stands in.
  assert.deepEqual(measureDetection({ box: [2, 2, 6, 4], polygon: [] }), { area: 8, perimeter: 12, centroid: [4, 3] });
});

test("descriptive statistics use the sample standard deviation", () => {
  const summary = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(summary.mean, 5);
  close(summary.sd, 2.138089935);
  assert.equal(summary.median, 4.5);
  assert.equal(summary.min, 2);
  assert.equal(summary.max, 9);
});

test("chi-square upper tail matches tables", () => {
  close(chiSquareUpperTail(3.841, 1), 0.05, 1e-3);
  close(chiSquareUpperTail(36.415, 24), 0.05, 1e-3);
  close(chiSquareUpperTail(0, 4), 1);
});

test("a regular grid is dispersed and a tight cluster is clustered", () => {
  const grid: Point[] = [];
  for (let x = 0; x < 10; x += 1) for (let y = 0; y < 10; y += 1) grid.push([50 + x * 100, 50 + y * 100]);
  const regular = nearestNeighborStatistics(grid, 1000, 1000)!;
  assert.ok(regular.r > 1.5, `R = ${regular.r}`);
  assert.equal(regular.pattern, "dispersed");

  const cluster: Point[] = grid.map(([x, y]) => [480 + x / 50, 480 + y / 50]);
  const clustered = nearestNeighborStatistics(cluster, 1000, 1000)!;
  assert.ok(clustered.r < 0.5, `R = ${clustered.r}`);
  assert.equal(clustered.pattern, "clustered");
  assert.equal(quadratStatistics(cluster, 1000, 1000)!.pattern, "clustered");
  const quadrats = quadratStatistics(grid, 1000, 1000)!;
  assert.equal(quadrats.columns * quadrats.rows, 25);
  assert.equal(quadrats.counts.reduce((total, count) => total + count, 0), 100);
});

test("statistics group prompts by label and respect the confidence filter and scale", () => {
  const prompts: DetectionPrompt[] = [
    { id: "a", type: "text", label: "cell", text: "cell", color: "#3987e5" },
    { id: "b", type: "visual", label: "cell", color: "#d95926", source: "photo", width: 100, height: 100, boxes: [[0, 0, 10, 10]] },
    { id: "c", type: "text", label: "nucleus", text: "nucleus", color: "#199e70" },
  ];
  const detection = (id: number, promptId: string, label: string, confidence: number, x: number): Detection => ({
    id, promptId, label, confidence, box: [x, 0, x + 10, 10], polygon: [], ...measureDetection({ box: [x, 0, x + 10, 10], polygon: [] }), origin: "model", shape: "box",
  });
  const detections = [detection(1, "a", "cell", 0.9, 0), detection(2, "b", "cell", 0.8, 20), detection(3, "c", "nucleus", 0.2, 40)];
  const statistics = computeStatistics(detections, prompts, 100, 100, { unit: "µm", perPixel: 0.5 }, 0.5);
  assert.deepEqual(statistics.classes.map((entry) => [entry.label, entry.count]), [["cell", 2], ["nucleus", 0]]);
  assert.equal(statistics.overall.count, 2);
  // 10 × 10 px at 0.5 µm per pixel is 25 µm².
  assert.equal(statistics.classes[0].area.mean, 25);
  close(statistics.classes[0].coverage, 50 / 2500);
});

test("detection files round-trip and measurements are recomputed", () => {
  const file = parseDetectionFile({
    format: "libera-detection",
    version: 1,
    createdAt: "2026-10-19T00:00:00.000Z",
    image: { name: "cells.jpg", width: 200, height: 100 },
    model: { family: "YOLOE-26", variant: "s", name: "YOLOE-26s", imageSize: 640, confidence: 0.25 },
    prompts: [{ id: "a", type: "text", label: "cell", text: "cell", color: "#3987e5" }],
    scale: { unit: "mm", perPixel: 0.01 },
    displayConfidence: 0.3,
    detections: [{ id: 1, promptId: "a", label: "cell", confidence: 0.7, box: [0, 0, 10, 10], polygon: [[0, 0], [10, 0], [10, 10], [0, 10]], area: 999 }],
  });
  assert.equal(file.detections[0].area, 100);
  assert.equal(file.scale.unit, "mm");
  assert.equal(file.model?.name, "YOLOE-26s");
  assert.equal(file.detections[0].origin, "model");
  assert.equal(file.statistics.overall.count, 1);
  assert.throws(() => parseDetectionFile({ format: "other" }), /not a Libera detection file/);
  assert.throws(() => parseDetectionFile({ format: "libera-detection", version: 2 }), /version 2/);
});

test("a dense outline reduces to a few control points, and the smooth curve passes through them", async () => {
  const { controlPointsFor, smoothClosedCurve } = await import("../../src/lib/detection/geometry");
  const circle: Point[] = Array.from({ length: 400 }, (_, i) => [100 + 50 * Math.cos((i / 400) * 2 * Math.PI), 100 + 50 * Math.sin((i / 400) * 2 * Math.PI)]);
  const points = controlPointsFor(circle);
  assert.ok(points.length >= 6 && points.length <= 24, `${points.length} points`);
  const curve = smoothClosedCurve(points);
  for (const [x, y] of points) assert.ok(curve.some(([cx, cy]) => Math.hypot(cx - x, cy - y) < 0.2), "the curve passes through each control point");
  // The curve stays close to the circle it approximates.
  close(polygonArea(curve), Math.PI * 50 * 50, Math.PI * 50 * 50 * 0.02);
});

test("editing a model detection marks it edited and keeps the original; hand tags are manual", async () => {
  const { manualDetection, withGeometry, editableGeometry, markEdited } = await import("../../src/lib/detection/geometry");
  const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const model: Detection = { id: 1, promptId: "a", label: "cell", confidence: 0.8, box: [0, 0, 10, 10], polygon: square, ...measureDetection({ box: [0, 0, 10, 10], polygon: square }), origin: "model", shape: "polygon" };
  const geometry = editableGeometry(model);
  assert.equal(geometry.shape, "polygon");
  const edited = withGeometry(model, { ...geometry, points: [[0, 0], [20, 0], [20, 10], [0, 10]], curve: "linear" }, "2026-10-19T00:00:00.000Z");
  assert.equal(edited.origin, "edited");
  assert.deepEqual(edited.original?.box, [0, 0, 10, 10]);
  assert.equal(edited.area, 200);
  assert.deepEqual(edited.box, [0, 0, 20, 10]);
  // A second edit keeps the first original.
  assert.deepEqual(withGeometry(edited, { shape: "polygon", points: square, curve: "linear" }).original?.box, [0, 0, 10, 10]);
  assert.equal(markEdited(edited).origin, "edited");

  const manual = manualDetection(2, "nucleus", { shape: "box", points: [[5, 5], [15, 5], [15, 25], [5, 25]], curve: "linear" });
  assert.equal(manual.origin, "manual");
  assert.equal(manual.original, undefined);
  assert.deepEqual(manual.box, [5, 5, 15, 25]);
  assert.equal(manual.area, 200);
  // Manual and edited objects pass any confidence filter; model ones need the score.
  assert.equal(passesConfidence(manual, 0.99), true);
  assert.equal(passesConfidence(edited, 0.99), true);
  assert.equal(passesConfidence(model, 0.9), false);
});

test("saved files keep provenance, control points and removed detections", () => {
  const file = parseDetectionFile({
    format: "libera-detection",
    version: 1,
    image: { name: "cells.jpg", width: 100, height: 100 },
    model: null,
    prompts: [],
    detections: [
      { id: 1, promptId: "manual", label: "seed", confidence: 1, box: [0, 0, 10, 10], polygon: [[0, 0], [10, 0], [10, 10], [0, 10]], origin: "manual", shape: "polygon", controlPoints: [[0, 0], [10, 0], [10, 10], [0, 10]], curve: "linear", editedAt: "2026-10-19T00:00:00.000Z" },
      { id: 2, promptId: "a", label: "cell", confidence: 0.4, box: [20, 20, 30, 30], polygon: [], origin: "edited", shape: "box", original: { label: "blob", confidence: 0.4, box: [21, 21, 29, 29], polygon: [] } },
    ],
    removedDetections: [{ id: 3, label: "cell", confidence: 0.3, box: [50, 50, 60, 60], origin: "model", removedAt: "2026-10-19T00:00:00.000Z" }],
  });
  assert.equal(file.model, null);
  assert.deepEqual(file.provenance, { model: 0, edited: 1, manual: 1, removed: 1 });
  assert.equal(file.detections[0].curve, "linear");
  assert.equal(file.detections[0].controlPoints?.length, 4);
  assert.equal(file.detections[1].original?.label, "blob");
  assert.equal(file.detections[1].label, "cell");
  assert.deepEqual(file.statistics.overall.origins, { model: 0, edited: 1, manual: 1 });
  // Confidence statistics leave out the manual object.
  assert.equal(file.statistics.overall.confidence.n, 1);
});
