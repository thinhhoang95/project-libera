/** Thumbnail layouts for the gallery: a square grid, or rows that keep each photo's shape. */

export type GalleryLayoutMode = "grid" | "justified";

/** Thumbnail size (grid) or row height (justified) for each zoom level, in CSS pixels. */
export const GALLERY_ZOOM_LEVELS = [64, 96, 136, 184, 248, 340, 460];
export const DEFAULT_GALLERY_ZOOM = 2;
export const GALLERY_GAP = 4;

/** Very wide or tall photos are clamped so a row never becomes a sliver. */
const MIN_RATIO = 0.4;
const MAX_RATIO = 3.2;

export function photoRatio(width?: number, height?: number) {
  if (!width || !height) return 1;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, width / height));
}

export type JustifiedRow = { start: number; end: number; height: number };

/**
 * Pack photos into rows that fill the width exactly, each about `targetHeight`
 * tall. The last row keeps the target height instead of stretching.
 */
export function justifiedRows(ratios: number[], containerWidth: number, targetHeight: number, gap = GALLERY_GAP): JustifiedRow[] {
  const rows: JustifiedRow[] = [];
  if (containerWidth <= 0) return rows;
  let start = 0;
  let ratioSum = 0;
  for (let index = 0; index < ratios.length; index += 1) {
    ratioSum += ratios[index];
    const count = index - start + 1;
    const widthAtTarget = ratioSum * targetHeight + gap * (count - 1);
    if (widthAtTarget >= containerWidth) {
      rows.push({ start, end: index + 1, height: (containerWidth - gap * (count - 1)) / ratioSum });
      start = index + 1;
      ratioSum = 0;
    }
  }
  if (start < ratios.length) rows.push({ start, end: ratios.length, height: targetHeight });
  return rows;
}
