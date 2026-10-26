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

export type GalleryRow = {
  top: number; height: number; group: number; start: number; end: number;
  /** Headings participate in the same virtual list as photo rows. */
  heading?: true;
};
export type GalleryRows = {
  rows: GalleryRow[]; height: number; tileWidth: number;
  photoTops: Map<string, { top: number; sectionTop: number }>;
  timeline: { tops: number[]; times: number[] };
};

/** All offsets come from metadata, never from mounting/measuring offscreen tiles. */
export function galleryRows(
  groups: Array<{ photos: Array<{ id: string; createdAt: string; width?: number; height?: number }> }>,
  mode: GalleryLayoutMode, width: number, size: number,
): GalleryRows {
  const available = Math.max(1, width);
  const columns = Math.max(1, Math.floor((available + GALLERY_GAP) / (size + GALLERY_GAP)));
  const tileWidth = (available - (columns - 1) * GALLERY_GAP) / columns;
  const rows: GalleryRow[] = [];
  const photoTops: GalleryRows["photoTops"] = new Map();
  const timeline: GalleryRows["timeline"] = { tops: [], times: [] };
  let top = 0;
  groups.forEach((group, groupIndex) => {
    const sectionTop = top;
    rows.push({ top, height: 48, group: groupIndex, start: 0, end: 0, heading: true });
    top += 48;
    const packed = mode === "justified"
      ? justifiedRows(group.photos.map((photo) => photoRatio(photo.width, photo.height)), available, size)
      : Array.from({ length: Math.ceil(group.photos.length / columns) }, (_, index) => ({ start: index * columns, end: Math.min(group.photos.length, (index + 1) * columns), height: tileWidth }));
    for (const row of packed) {
      rows.push({ ...row, top, group: groupIndex });
      timeline.tops.push(top);
      timeline.times.push(Date.parse(group.photos[row.start].createdAt));
      for (let index = row.start; index < row.end; index++) photoTops.set(group.photos[index].id, { top, sectionTop });
      top += row.height + GALLERY_GAP;
    }
    if (packed.length) top -= GALLERY_GAP;
  });
  return { rows, height: top, tileWidth, photoTops, timeline };
}

/** Binary search bounds the work of each scroll to the viewport and overscan. */
export function visibleGalleryRows(rows: GalleryRow[], top: number, height: number, overscan = 400) {
  const start = Math.max(0, top - overscan);
  const end = top + Math.max(1, height) + overscan;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].top + rows[middle].height < start) low = middle + 1;
    else high = middle;
  }
  const first = low;
  while (low < rows.length && rows[low].top <= end) low++;
  return rows.slice(first, low);
}
