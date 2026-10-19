/**
 * Detection and Segmentation results: the prompts, the detections YOLOE-26
 * found, the measurements and spatial statistics computed from them, and the
 * JSON file they are saved in. Shared by the server and the browser.
 */

export type Point = [number, number];
/** x1, y1, x2, y2 in image pixels. */
export type Box = [number, number, number, number];

export type TextPrompt = { id: string; type: "text"; label: string; color: string; text: string };
export type VisualPrompt = {
  id: string;
  type: "visual";
  label: string;
  color: string;
  /** Example boxes drawn on the photo itself, or on an uploaded reference image. */
  source: "photo" | "upload";
  /** The uploaded reference's file name. */
  name?: string;
  /** Reference image size; the photo's own for "photo". */
  width: number;
  height: number;
  /** Examples of one kind of object, in reference image pixels. */
  boxes: Box[];
  /** A small JPEG of the first example, as a data URL, to recognize the prompt by. */
  thumbnail?: string;
  /** An uploaded reference, downscaled, as a data URL, so a saved file can run again; `boxes` are in its pixels. */
  reference?: string;
};
export type DetectionPrompt = TextPrompt | VisualPrompt;

/**
 * Where an object came from: found by the model, found by the model and then
 * corrected by hand, or tagged by hand.
 */
export type DetectionOrigin = "model" | "edited" | "manual";
/** A box keeps its four corners axis-aligned; a polygon is any outline. */
export type DetectionShape = "box" | "polygon";
/** Control points join with straight lines, or with a smooth curve through them. */
export type CurveKind = "linear" | "smooth";

export type Detection = {
  /** 1-based: model detections in descending confidence, then hand-tagged ones. */
  id: number;
  /** The prompt that found it; "manual" for hand-tagged objects. */
  promptId: string;
  label: string;
  /** The model's score; 1 for hand-tagged objects, which the confidence filter never hides. */
  confidence: number;
  box: Box;
  /** The outline in image pixels: the model's mask, or the curve through the control points. Empty for a bare box. */
  polygon: Point[];
  /** Outline area in pixels², or the box's when there is no outline. */
  area: number;
  perimeter: number;
  centroid: Point;
  origin: DetectionOrigin;
  shape: DetectionShape;
  /** The points that define an edited or hand-drawn outline; `polygon` is sampled from them. */
  controlPoints?: Point[];
  curve?: CurveKind;
  /** What the model found, kept when the object is edited, so the change can be audited or reverted. */
  original?: { label: string; confidence: number; box: Box; polygon: Point[] };
  /** When it was last edited or tagged. */
  editedAt?: string;
};

/** A model detection removed by hand, recorded in saved files. */
export type RemovedDetection = { id: number; label: string; confidence: number; box: Box; origin: DetectionOrigin; removedAt: string };

/** Hand-tagged and edited objects always count; model detections only at or above the confidence filter. */
export function passesConfidence(detection: Detection, minConfidence: number) {
  return detection.origin !== "model" || detection.confidence >= minConfidence;
}

export const LENGTH_UNITS = ["px", "nm", "µm", "mm", "cm", "m"] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];
/** Physical length of one pixel; `unit: "px"` means uncalibrated. */
export type DetectionScale = { unit: LengthUnit; perPixel: number };
export const PIXEL_SCALE: DetectionScale = { unit: "px", perPixel: 1 };

export type DetectionModelInfo = {
  family: "YOLOE-26";
  variant: string;
  name: string;
  weights: string;
  textEncoder: string;
  framework: string;
  device: string;
  imageSize: number;
  confidence: number;
  iou: number;
  maxDetections: number;
};

export const DETECTION_FILE_FORMAT = "libera-detection";
export const DETECTION_FILE_VERSION = 1;

export type DetectionFile = {
  format: typeof DETECTION_FILE_FORMAT;
  version: typeof DETECTION_FILE_VERSION;
  createdAt: string;
  generator: { app: string; version: string };
  image: { name: string; width: number; height: number; source?: string };
  /** The model run, or null when every object was tagged by hand. */
  model: DetectionModelInfo | null;
  prompts: DetectionPrompt[];
  scale: DetectionScale;
  /** The confidence filter applied when the file was saved; detections below it are still included. */
  displayConfidence: number;
  detections: Detection[];
  /** Model detections the user deleted. */
  removedDetections: RemovedDetection[];
  /** How many objects of each origin the file holds. */
  provenance: { model: number; edited: number; manual: number; removed: number };
  statistics: DetectionStatistics;
  timing?: Record<string, unknown>;
};

/**
 * Prompt colors in fixed order: the categorical palette checked for
 * colour-blind separation on a dark surface (the tool's). Past eight they
 * repeat, so every overlay and table row also names its label.
 */
export const PROMPT_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

export function polygonArea(polygon: Point[]) {
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function polygonPerimeter(polygon: Point[]) {
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    sum += Math.hypot(x2 - x1, y2 - y1);
  }
  return sum;
}

/** The area-weighted centroid, or the vertices' mean for a degenerate outline. */
export function polygonCentroid(polygon: Point[]): Point {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    const n = Math.max(1, polygon.length);
    return [polygon.reduce((total, [x]) => total + x, 0) / n, polygon.reduce((total, [, y]) => total + y, 0) / n];
  }
  return [cx / (3 * area), cy / (3 * area)];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Measure one raw detection from the worker, to a hundredth of a pixel. */
export function measureDetection(raw: { box: Box; polygon: Point[] }): { area: number; perimeter: number; centroid: Point } {
  const [x1, y1, x2, y2] = raw.box;
  if (raw.polygon.length >= 3) {
    const [cx, cy] = polygonCentroid(raw.polygon);
    return { area: round2(polygonArea(raw.polygon)), perimeter: round2(polygonPerimeter(raw.polygon)), centroid: [round2(cx), round2(cy)] };
  }
  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);
  return { area: round2(width * height), perimeter: round2(2 * (width + height)), centroid: [round2((x1 + x2) / 2), round2((y1 + y2) / 2)] };
}

export type Summary = { n: number; mean: number; sd: number; median: number; q1: number; q3: number; min: number; max: number; cv: number };

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Descriptive statistics; the standard deviation is the sample one (n − 1). */
export function summarize(values: number[]): Summary {
  const n = values.length;
  if (!n) return { n: 0, mean: NaN, sd: NaN, median: NaN, q1: NaN, q3: NaN, min: NaN, max: NaN, cv: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((total, value) => total + value, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd, median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75), min: sorted[0], max: sorted[n - 1], cv: mean ? sd / mean : NaN };
}

/** ln Γ(x), Lanczos approximation. */
function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.000000000190015;
  for (const coefficient of c) series += coefficient / ++y;
  return -tmp + Math.log((2.5066282746310005 * series) / x);
}

/** The regularized upper incomplete gamma Q(a, x). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 500; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let n = 1; n < 500; n += 1) {
    const an = -n * (n - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** P(χ² ≥ x) with `df` degrees of freedom. */
export function chiSquareUpperTail(x: number, df: number) {
  return gammaQ(df / 2, x / 2);
}

/** Two-sided p-value of a standard normal z. */
export function normalTwoSided(z: number) {
  // Abramowitz and Stegun 7.1.26 for erfc.
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-(z * z) / 2);
  return Math.min(1, erfc);
}

export type SpatialPattern = "clustered" | "random" | "dispersed" | "insufficient";

export type NearestNeighbor = {
  /** Distances from each object to its nearest neighbour, in pixels. */
  distances: Summary;
  /** Clark–Evans aggregation index: observed ÷ expected mean distance under complete spatial randomness. */
  r: number;
  expected: number;
  z: number;
  p: number;
  pattern: SpatialPattern;
};

export type Quadrats = {
  columns: number;
  rows: number;
  counts: number[];
  /** Variance-to-mean ratio (index of dispersion): 1 random, above 1 clustered, below 1 regular. */
  vmr: number;
  chiSquare: number;
  df: number;
  p: number;
  /** Morisita's index of dispersion, 1 under randomness. */
  morisita: number;
  pattern: SpatialPattern;
};

export type ClassStatistics = {
  label: string;
  color: string;
  count: number;
  /** Objects per megapixel, or per unit² when calibrated. */
  density: number;
  /** Summed mask area ÷ image area; overlapping masks count twice. */
  coverage: number;
  area: Summary;
  equivalentDiameter: Summary;
  perimeter: Summary;
  /** 4πA ÷ P²: 1 for a circle, lower for elongated or ragged shapes. */
  circularity: Summary;
  /** Box long side ÷ short side. */
  aspectRatio: Summary;
  /** Model scores, leaving out hand-tagged objects. */
  confidence: Summary;
  origins: { model: number; edited: number; manual: number };
  centroid: { x: number; y: number; sdX: number; sdY: number };
  nearestNeighbor: NearestNeighbor | null;
  quadrats: Quadrats | null;
};

export type DetectionStatistics = {
  /** All detections at or above the display confidence, every prompt together, then each label. */
  overall: ClassStatistics;
  classes: ClassStatistics[];
  /** Units of the size statistics: pixels, or the calibrated unit. */
  unit: LengthUnit;
  imageArea: number;
};

/** Clark and Evans (1954), with Donnelly's edge correction for a rectangle. */
export function nearestNeighborStatistics(points: Point[], width: number, height: number): NearestNeighbor | null {
  const n = points.length;
  if (n < 2 || width <= 0 || height <= 0) return null;
  const distances = points.map(([x, y], index) => {
    let best = Infinity;
    for (let other = 0; other < n; other += 1) {
      if (other === index) continue;
      const distance = Math.hypot(points[other][0] - x, points[other][1] - y);
      if (distance < best) best = distance;
    }
    return best;
  });
  const area = width * height;
  const perimeter = 2 * (width + height);
  const observed = distances.reduce((total, value) => total + value, 0) / n;
  const expected = 0.5 * Math.sqrt(area / n) + (0.0514 + 0.041 / Math.sqrt(n)) * (perimeter / n);
  const standardError = Math.sqrt(0.0703 * area / (n * n) + 0.037 * perimeter * Math.sqrt(area / n ** 5));
  const r = observed / expected;
  const z = (observed - expected) / standardError;
  const p = normalTwoSided(z);
  const pattern: SpatialPattern = n < 5 ? "insufficient" : p >= 0.05 ? "random" : r < 1 ? "clustered" : "dispersed";
  return { distances: summarize(distances), r, expected, z, p, pattern };
}

/** Quadrat counts on a grid about as square as the image, five cells on the shorter side. */
export function quadratStatistics(points: Point[], width: number, height: number, cellsOnShortSide = 5): Quadrats | null {
  const n = points.length;
  if (n < 2 || width <= 0 || height <= 0) return null;
  const cell = Math.min(width, height) / cellsOnShortSide;
  const columns = Math.max(1, Math.round(width / cell));
  const rows = Math.max(1, Math.round(height / cell));
  const counts = new Array<number>(columns * rows).fill(0);
  for (const [x, y] of points) {
    const column = Math.min(columns - 1, Math.max(0, Math.floor((x / width) * columns)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((y / height) * rows)));
    counts[row * columns + column] += 1;
  }
  const q = counts.length;
  const mean = n / q;
  const variance = counts.reduce((total, count) => total + (count - mean) ** 2, 0) / (q - 1);
  const vmr = variance / mean;
  const chiSquare = (q - 1) * vmr;
  const df = q - 1;
  const upper = chiSquareUpperTail(chiSquare, df);
  const p = Math.min(1, 2 * Math.min(upper, 1 - upper));
  const morisita = q * counts.reduce((total, count) => total + count * (count - 1), 0) / (n * (n - 1));
  const pattern: SpatialPattern = n < 5 ? "insufficient" : p >= 0.05 ? "random" : vmr > 1 ? "clustered" : "dispersed";
  return { columns, rows, counts, vmr, chiSquare, df, p, morisita, pattern };
}

function classStatistics(label: string, color: string, detections: Detection[], width: number, height: number, scale: DetectionScale): ClassStatistics {
  const length = scale.unit === "px" ? 1 : scale.perPixel;
  const areaFactor = length * length;
  const imageArea = width * height * areaFactor;
  const areas = detections.map((detection) => detection.area * areaFactor);
  const perimeters = detections.map((detection) => detection.perimeter * length);
  const centroids = detections.map((detection) => detection.centroid);
  const xs = summarize(centroids.map(([x]) => x * length));
  const ys = summarize(centroids.map(([, y]) => y * length));
  const nn = nearestNeighborStatistics(centroids, width, height);
  return {
    label,
    color,
    count: detections.length,
    density: scale.unit === "px" ? detections.length / (width * height / 1e6) : detections.length / imageArea,
    coverage: areas.reduce((total, value) => total + value, 0) / imageArea,
    area: summarize(areas),
    equivalentDiameter: summarize(areas.map((area) => 2 * Math.sqrt(area / Math.PI))),
    perimeter: summarize(perimeters),
    circularity: summarize(detections.map((detection) => (detection.perimeter > 0 ? Math.min(1, (4 * Math.PI * detection.area) / detection.perimeter ** 2) : NaN)).filter(Number.isFinite)),
    aspectRatio: summarize(detections.map(({ box: [x1, y1, x2, y2] }) => {
      const sides = [Math.max(1e-6, x2 - x1), Math.max(1e-6, y2 - y1)];
      return Math.max(...sides) / Math.min(...sides);
    })),
    confidence: summarize(detections.filter((detection) => detection.origin !== "manual").map((detection) => detection.confidence)),
    origins: {
      model: detections.filter((detection) => detection.origin === "model").length,
      edited: detections.filter((detection) => detection.origin === "edited").length,
      manual: detections.filter((detection) => detection.origin === "manual").length,
    },
    centroid: { x: xs.mean, y: ys.mean, sdX: xs.sd, sdY: ys.sd },
    nearestNeighbor: nn && {
      ...nn,
      distances: scaleSummary(nn.distances, length),
      expected: nn.expected * length,
    },
    quadrats: quadratStatistics(centroids, width, height),
  };
}

function scaleSummary(summary: Summary, factor: number): Summary {
  return { ...summary, mean: summary.mean * factor, sd: summary.sd * factor, median: summary.median * factor, q1: summary.q1 * factor, q3: summary.q3 * factor, min: summary.min * factor, max: summary.max * factor };
}

/**
 * One color per label: the first prompt's with that label, then unused
 * palette colors for labels only hand tags use, in order of appearance.
 */
export function labelColors(prompts: DetectionPrompt[], detections: Array<{ label: string }>, extra: string[] = []) {
  const colors = new Map<string, string>();
  for (const prompt of prompts) if (!colors.has(prompt.label)) colors.set(prompt.label, prompt.color);
  const used = new Set(colors.values());
  let next = 0;
  for (const label of [...detections.map((detection) => detection.label), ...extra]) {
    if (colors.has(label)) continue;
    const free = PROMPT_COLORS.find((color) => !used.has(color));
    const color = free ?? PROMPT_COLORS[next++ % PROMPT_COLORS.length];
    used.add(color);
    colors.set(label, color);
  }
  return colors;
}

/** Statistics for the detections that pass the confidence filter, overall and per label, in prompt order. */
export function computeStatistics(detections: Detection[], prompts: DetectionPrompt[], width: number, height: number, scale: DetectionScale, minConfidence = 0): DetectionStatistics {
  const kept = detections.filter((detection) => passesConfidence(detection, minConfidence));
  const colors = labelColors(prompts, detections);
  const length = scale.unit === "px" ? 1 : scale.perPixel;
  return {
    overall: classStatistics("All objects", "#888888", kept, width, height, scale),
    classes: [...colors].map(([label, color]) => classStatistics(label, color, kept.filter((detection) => detection.label === label), width, height, scale)),
    unit: scale.unit,
    imageArea: width * height * length * length,
  };
}

/** Bins for a histogram, by Sturges' rule. */
export function histogram(values: number[], bins = Math.ceil(Math.log2(Math.max(1, values.length)) + 1)) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = max > min ? (max - min) / bins : 1;
  const counts = new Array<number>(bins).fill(0);
  for (const value of values) counts[Math.min(bins - 1, Math.floor((value - min) / width))] += 1;
  return counts.map((count, index) => ({ from: min + index * width, to: min + (index + 1) * width, count }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNumberArray(value: unknown, length?: number): value is number[] {
  return Array.isArray(value) && (length === undefined || value.length === length) && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

/**
 * Read a saved detection file, checking what the viewer relies on. Measurements
 * are recomputed from the outlines, so an edited file cannot disagree with them.
 */
export function parseDetectionFile(input: unknown): DetectionFile {
  if (!isRecord(input) || input.format !== DETECTION_FILE_FORMAT) throw new Error("This is not a Libera detection file.");
  if (input.version !== DETECTION_FILE_VERSION) throw new Error(`This detection file is version ${String(input.version)}; this Libera reads version ${DETECTION_FILE_VERSION}.`);
  const image = input.image;
  if (!isRecord(image) || typeof image.width !== "number" || typeof image.height !== "number" || image.width <= 0 || image.height <= 0) {
    throw new Error("The detection file does not say the image's size.");
  }
  if (!Array.isArray(input.prompts) || !Array.isArray(input.detections)) throw new Error("The detection file has no prompts or detections.");

  const prompts: DetectionPrompt[] = input.prompts.filter(isRecord).map((prompt, index) => {
    const base = {
      id: typeof prompt.id === "string" ? prompt.id : `prompt-${index}`,
      label: typeof prompt.label === "string" ? prompt.label : `Prompt ${index + 1}`,
      color: typeof prompt.color === "string" && /^#[0-9a-f]{6}$/i.test(prompt.color) ? prompt.color : PROMPT_COLORS[index % PROMPT_COLORS.length],
    };
    if (prompt.type === "visual") {
      return {
        ...base,
        type: "visual" as const,
        source: prompt.source === "upload" ? "upload" as const : "photo" as const,
        name: typeof prompt.name === "string" ? prompt.name : undefined,
        width: typeof prompt.width === "number" ? prompt.width : (image.width as number),
        height: typeof prompt.height === "number" ? prompt.height : (image.height as number),
        boxes: Array.isArray(prompt.boxes) ? prompt.boxes.filter((box): box is Box => isNumberArray(box, 4)) : [],
        thumbnail: typeof prompt.thumbnail === "string" && prompt.thumbnail.startsWith("data:image/") ? prompt.thumbnail : undefined,
        reference: typeof prompt.reference === "string" && prompt.reference.startsWith("data:image/") ? prompt.reference : undefined,
      };
    }
    return { ...base, type: "text" as const, text: typeof prompt.text === "string" ? prompt.text : base.label };
  });

  const points = (value: unknown) => (Array.isArray(value) ? value.filter((point): point is Point => isNumberArray(point, 2)) : []);
  const detections: Detection[] = input.detections.filter(isRecord).flatMap((detection, index) => {
    if (!isNumberArray(detection.box, 4) || typeof detection.confidence !== "number") return [];
    const polygon = points(detection.polygon);
    const promptId = typeof detection.promptId === "string" ? detection.promptId : "";
    const box = detection.box as Box;
    const origin: DetectionOrigin = detection.origin === "edited" || detection.origin === "manual" ? detection.origin : "model";
    const controlPoints = points(detection.controlPoints);
    const original = isRecord(detection.original) && isNumberArray(detection.original.box, 4) ? {
      label: String(detection.original.label ?? ""),
      confidence: Number(detection.original.confidence) || 0,
      box: detection.original.box as Box,
      polygon: points(detection.original.polygon),
    } : undefined;
    return [{
      id: typeof detection.id === "number" ? detection.id : index + 1,
      promptId,
      // An edited object may have been relabeled; otherwise the prompt names it.
      label: typeof detection.label === "string" && detection.label ? detection.label : prompts.find((entry) => entry.id === promptId)?.label ?? "object",
      confidence: detection.confidence,
      box,
      polygon,
      ...measureDetection({ box, polygon }),
      origin,
      shape: detection.shape === "box" || polygon.length < 3 ? "box" : "polygon",
      ...(controlPoints.length >= 3 ? { controlPoints, curve: detection.curve === "linear" ? "linear" as const : "smooth" as const } : {}),
      ...(original ? { original } : {}),
      ...(typeof detection.editedAt === "string" ? { editedAt: detection.editedAt } : {}),
    }];
  });
  const removedDetections: RemovedDetection[] = Array.isArray(input.removedDetections)
    ? input.removedDetections.filter(isRecord).flatMap((entry) => (isNumberArray(entry.box, 4) ? [{
      id: Number(entry.id) || 0,
      label: String(entry.label ?? ""),
      confidence: Number(entry.confidence) || 0,
      box: entry.box as Box,
      origin: entry.origin === "edited" || entry.origin === "manual" ? entry.origin : "model" as DetectionOrigin,
      removedAt: String(entry.removedAt ?? ""),
    }] : []))
    : [];

  const scaleInput = isRecord(input.scale) ? input.scale : {};
  const scale: DetectionScale = LENGTH_UNITS.includes(scaleInput.unit as LengthUnit) && typeof scaleInput.perPixel === "number" && scaleInput.perPixel > 0
    ? { unit: scaleInput.unit as LengthUnit, perPixel: scaleInput.perPixel }
    : PIXEL_SCALE;
  const model = isRecord(input.model) ? input.model : null;
  const width = image.width as number;
  const height = image.height as number;
  const displayConfidence = typeof input.displayConfidence === "number" ? input.displayConfidence : 0;

  return {
    format: DETECTION_FILE_FORMAT,
    version: DETECTION_FILE_VERSION,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : "",
    generator: isRecord(input.generator) ? { app: String(input.generator.app ?? ""), version: String(input.generator.version ?? "") } : { app: "", version: "" },
    image: { name: typeof image.name === "string" ? image.name : "", width, height, source: typeof image.source === "string" ? image.source : undefined },
    model: model && {
      family: "YOLOE-26",
      variant: String(model.variant ?? ""),
      name: String(model.name ?? ""),
      weights: String(model.weights ?? ""),
      textEncoder: String(model.textEncoder ?? ""),
      framework: String(model.framework ?? ""),
      device: String(model.device ?? ""),
      imageSize: Number(model.imageSize) || 0,
      confidence: Number(model.confidence) || 0,
      iou: Number(model.iou) || 0,
      maxDetections: Number(model.maxDetections) || 0,
    },
    prompts,
    scale,
    displayConfidence,
    detections,
    removedDetections,
    provenance: provenanceOf(detections, removedDetections),
    statistics: computeStatistics(detections, prompts, width, height, scale, displayConfidence),
    timing: isRecord(input.timing) ? input.timing : undefined,
  };
}

export function provenanceOf(detections: Detection[], removed: RemovedDetection[]) {
  return {
    model: detections.filter((detection) => detection.origin === "model").length,
    edited: detections.filter((detection) => detection.origin === "edited").length,
    manual: detections.filter((detection) => detection.origin === "manual").length,
    removed: removed.length,
  };
}
