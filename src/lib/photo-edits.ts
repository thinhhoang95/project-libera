/**
 * Photo edits shared by the editor preview (an SVG filter on a canvas) and the
 * server (sharp), so the saved photo matches what the editor showed.
 *
 * Order: rotate → flip → crop → brightness/contrast → color matrix → vignette.
 */

export type CropRect = { x: number; y: number; width: number; height: number };

export type PhotoAdjustments = {
  /** Each runs from -100 to 100, except vignette which runs from 0 to 100. */
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  tint: number;
  vignette: number;
};

export type PhotoEdits = PhotoAdjustments & {
  /** Clockwise quarter turns. */
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** Normalized to the rotated and flipped photo; null keeps the whole photo. */
  crop: CropRect | null;
};

export const NO_ADJUSTMENTS: PhotoAdjustments = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, tint: 0, vignette: 0 };
export const NO_EDITS: PhotoEdits = { ...NO_ADJUSTMENTS, rotate: 0, flipH: false, flipV: false, crop: null };

export const ADJUSTMENT_CONTROLS: Array<{ key: keyof PhotoAdjustments; label: string; min: number; max: number }> = [
  { key: "brightness", label: "Brightness", min: -100, max: 100 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
  { key: "warmth", label: "Warmth", min: -100, max: 100 },
  { key: "tint", label: "Tint", min: -100, max: 100 },
  { key: "vignette", label: "Vignette", min: 0, max: 100 },
];

export const FILTER_PRESETS: Array<{ id: string; label: string; adjustments: PhotoAdjustments }> = [
  { id: "original", label: "Original", adjustments: NO_ADJUSTMENTS },
  { id: "vivid", label: "Vivid", adjustments: { ...NO_ADJUSTMENTS, contrast: 18, saturation: 40, brightness: 4 } },
  { id: "warm", label: "Warm", adjustments: { ...NO_ADJUSTMENTS, warmth: 45, saturation: 10, brightness: 4 } },
  { id: "cool", label: "Cool", adjustments: { ...NO_ADJUSTMENTS, warmth: -45, tint: -8, contrast: 6 } },
  { id: "fade", label: "Fade", adjustments: { ...NO_ADJUSTMENTS, contrast: -35, brightness: 10, saturation: -25 } },
  { id: "matte", label: "Matte", adjustments: { ...NO_ADJUSTMENTS, contrast: -20, saturation: -10, warmth: 12, vignette: 30 } },
  { id: "mono", label: "Mono", adjustments: { ...NO_ADJUSTMENTS, saturation: -100 } },
  { id: "noir", label: "Noir", adjustments: { ...NO_ADJUSTMENTS, saturation: -100, contrast: 45, brightness: -6, vignette: 45 } },
];

export const CROP_ASPECTS: Array<{ id: string; label: string; ratio: number | "original" | null }> = [
  { id: "free", label: "Free", ratio: null },
  { id: "original", label: "Original", ratio: "original" },
  { id: "1:1", label: "Square", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:4", label: "3:4", ratio: 3 / 4 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "2:3", label: "2:3", ratio: 2 / 3 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
];

const LUMINANCE = [0.2126, 0.7152, 0.0722];

function clamp(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0;
}

/** Normalize submitted edits; anything out of range is clamped or dropped. */
export function parsePhotoEdits(value: unknown): PhotoEdits {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const rotate = [0, 90, 180, 270].includes(input.rotate as number) ? input.rotate as PhotoEdits["rotate"] : 0;
  let crop: CropRect | null = null;
  if (input.crop && typeof input.crop === "object") {
    const raw = input.crop as Record<string, unknown>;
    const x = clamp(raw.x, 0, 1);
    const y = clamp(raw.y, 0, 1);
    const width = clamp(raw.width, 0, 1 - x);
    const height = clamp(raw.height, 0, 1 - y);
    if (width > 0.001 && height > 0.001 && (width < 0.9999 || height < 0.9999)) crop = { x, y, width, height };
  }
  const edits: PhotoEdits = { ...NO_EDITS, rotate, flipH: input.flipH === true, flipV: input.flipV === true, crop };
  for (const control of ADJUSTMENT_CONTROLS) edits[control.key] = Math.round(clamp(input[control.key], control.min, control.max));
  return edits;
}

export function hasEdits(edits: PhotoEdits) {
  return edits.rotate !== 0 || edits.flipH || edits.flipV || edits.crop !== null || hasAdjustments(edits);
}

export function hasAdjustments(adjustments: PhotoAdjustments) {
  return ADJUSTMENT_CONTROLS.some((control) => adjustments[control.key] !== 0);
}

/** Brightness then contrast, as one per-channel `value * slope + intercept` on 0–1 values. */
export function toneCurve(adjustments: PhotoAdjustments) {
  const brightness = 1 + adjustments.brightness / 200;
  const contrast = 1 + adjustments.contrast / (adjustments.contrast < 0 ? 125 : 100);
  return { slope: brightness * contrast, intercept: 0.5 * (1 - contrast) };
}

/** Saturation, warmth and tint as one 3×3 matrix on 0–1 RGB values. */
export function colorMatrix(adjustments: PhotoAdjustments): number[][] {
  const saturation = 1 + adjustments.saturation / 100;
  const [lr, lg, lb] = LUMINANCE;
  const saturate = [
    [lr + (1 - lr) * saturation, lg - lg * saturation, lb - lb * saturation],
    [lr - lr * saturation, lg + (1 - lg) * saturation, lb - lb * saturation],
    [lr - lr * saturation, lg - lg * saturation, lb + (1 - lb) * saturation],
  ];
  const warmth = adjustments.warmth / 100;
  const tint = adjustments.tint / 100;
  const gains = [1 + 0.14 * warmth + 0.05 * tint, 1 + 0.02 * warmth - 0.1 * tint, 1 - 0.14 * warmth + 0.05 * tint];
  return saturate.map((row, index) => row.map((value) => value * gains[index]));
}

/** Darkest corner opacity for a vignette strength. */
export function vignetteOpacity(adjustments: PhotoAdjustments) {
  return (adjustments.vignette / 100) * 0.75;
}

/** Inner radius (0–1 of the farthest corner) where the vignette starts. */
export const VIGNETTE_START = 0.45;

/** The size of the photo after quarter turns. */
export function orientedSize(width: number, height: number, rotate: PhotoEdits["rotate"]) {
  return rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height };
}

/** Keep a crop on the same part of the photo when the photo is turned or flipped. */
export function rotateCropClockwise(crop: CropRect | null): CropRect | null {
  return crop && { x: 1 - crop.y - crop.height, y: crop.x, width: crop.height, height: crop.width };
}

export function rotateCropCounterClockwise(crop: CropRect | null): CropRect | null {
  return crop && { x: crop.y, y: 1 - crop.x - crop.width, width: crop.height, height: crop.width };
}

export function flipCrop(crop: CropRect | null, axis: "horizontal" | "vertical"): CropRect | null {
  if (!crop) return crop;
  return axis === "horizontal" ? { ...crop, x: 1 - crop.x - crop.width } : { ...crop, y: 1 - crop.y - crop.height };
}

/** Pixel rectangle of a crop inside a photo of the given (oriented) size. */
export function cropPixels(crop: CropRect | null, width: number, height: number) {
  if (!crop) return { left: 0, top: 0, width, height };
  const left = Math.min(width - 1, Math.max(0, Math.round(crop.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.round(crop.y * height)));
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, Math.round(crop.width * width))),
    height: Math.max(1, Math.min(height - top, Math.round(crop.height * height))),
  };
}
