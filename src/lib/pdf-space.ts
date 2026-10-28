import type { PdfAnnotation, PdfSpaceAnnotation, PdfSpaceBand } from "@/lib/types";

/*
 * Spaces open blank room in a PDF page as displayed (see
 * docs/create-space-plan.md). These helpers keep a page's spaces consistent:
 * every space in one column block agrees on its layout, and pages stay a
 * bounded size. Shared by the sidecar normalizer and the viewer.
 */

export const PDF_SPACE_MIN_HEIGHT = 0.005;
/** Notes in a space measure y from its top, so a space is at most one page tall. */
export const PDF_SPACE_MAX_HEIGHT = 1;
export const PDF_SPACE_MAX_PER_PAGE = 32;
/** Total inserted height per page, in page heights. */
export const PDF_SPACE_MAX_PAGE_GROWTH = 3;
export const PDF_SPACE_MAX_SPLITS = 4;
// Column splits closer than this (page widths) are one boundary.
const MIN_COLUMN_WIDTH = 0.02;
const EPSILON = 1e-6;

/** A full-width cut: a band of zero height at the cut. */
export function isFullWidthBand(band: PdfSpaceBand) {
  return band.bottom - band.top <= EPSILON;
}

export function fullWidthBand(y: number): PdfSpaceBand {
  return { top: y, bottom: y, splits: [] };
}

/** The x range of one column; outer columns reach the page edges. */
export function columnBounds(band: PdfSpaceBand, column: number) {
  return { x0: band.splits[column - 1] ?? 0, x1: band.splits[column] ?? 1 };
}

export function columnAt(band: PdfSpaceBand, x: number) {
  let column = 0;
  while (column < band.splits.length && x >= band.splits[column]) column++;
  return column;
}

/** Room left for a new space, or for resizing `id`, without evicting other spaces on save. */
export function availableSpaceHeight(spaces: readonly PdfSpaceAnnotation[], id?: string) {
  const others = spaces.filter((space) => space.id !== id);
  if (others.length >= PDF_SPACE_MAX_PER_PAGE) return 0;
  return Math.max(0, Math.min(PDF_SPACE_MAX_HEIGHT, PDF_SPACE_MAX_PAGE_GROWTH - others.reduce((sum, space) => sum + space.height, 0)));
}

/** Stacking order of spaces at one cut, and the order of a column's spaces. */
export function compareSpaces(a: PdfSpaceAnnotation, b: PdfSpaceAnnotation) {
  return a.y - b.y || compareAge(a, b);
}

function compareAge(a: PdfSpaceAnnotation, b: PdfSpaceAnnotation) {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function sameBand(a: PdfSpaceBand, b: PdfSpaceBand) {
  return (
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.splits.length === b.splits.length &&
    a.splits.every((split, index) => split === b.splits[index])
  );
}

function bandsOverlap(a: PdfSpaceBand, b: PdfSpaceBand) {
  if (isFullWidthBand(a) && isFullWidthBand(b)) return a.top === b.top;
  if (isFullWidthBand(a)) return b.top < a.top && a.top < b.bottom;
  if (isFullWidthBand(b)) return a.top < b.top && b.top < a.bottom;
  return a.top < b.bottom && b.top < a.bottom;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Validates a stored space's cut, height and layout. Null when the cut or
 * height is unusable; a malformed band falls back to a full-width cut.
 */
export function normalizeSpaceLayout(input: {
  y?: unknown;
  height?: unknown;
  band?: unknown;
  column?: unknown;
}): Pick<PdfSpaceAnnotation, "y" | "height" | "band" | "column"> | null {
  if (!finite(input.y) || !finite(input.height)) return null;
  const y = clamp(input.y, 0, 1);
  const height = clamp(input.height, PDF_SPACE_MIN_HEIGHT, PDF_SPACE_MAX_HEIGHT);
  const band = (input.band && typeof input.band === "object" ? input.band : {}) as Partial<Record<keyof PdfSpaceBand, unknown>>;

  if (!finite(band.top) || !finite(band.bottom)) return { y, height, band: fullWidthBand(y), column: 0 };
  const top = clamp(Math.min(band.top, band.bottom), 0, 1);
  const bottom = clamp(Math.max(band.top, band.bottom), 0, 1);
  if (bottom - top <= EPSILON) return { y, height, band: fullWidthBand(y), column: 0 };

  const splits: number[] = [];
  for (const split of (Array.isArray(band.splits) ? band.splits : []).filter(finite).sort((a, b) => a - b)) {
    if (split < MIN_COLUMN_WIDTH || split > 1 - MIN_COLUMN_WIDTH) continue;
    if (splits.length && split - splits[splits.length - 1] < MIN_COLUMN_WIDTH) continue;
    splits.push(split);
    if (splits.length === PDF_SPACE_MAX_SPLITS) break;
  }
  const column = finite(input.column) ? clamp(Math.floor(input.column), 0, splits.length) : 0;

  return { y: clamp(y, top, bottom), height, band: { top, bottom, splits }, column };
}

/** The space moved into another block's layout, keeping its column by position. */
function adoptBand(space: PdfSpaceAnnotation, band: PdfSpaceBand): PdfSpaceAnnotation {
  const { x0, x1 } = columnBounds(space.band, space.column);
  return {
    ...space,
    y: clamp(space.y, band.top, band.bottom),
    band: { ...band, splits: [...band.splits] },
    column: columnAt(band, (x0 + x1) / 2),
  };
}

/**
 * Makes one page's spaces consistent. The oldest spaces win: bands never
 * overlap (a conflicting space adopts the stored band containing its cut, or
 * becomes a full-width cut), ids are unique, and the count and total height
 * are bounded. Returns each input space as kept (possibly adjusted), or
 * undefined when it is dropped.
 */
function reconcileAligned(spaces: readonly PdfSpaceAnnotation[], takenIds: Set<string>) {
  const bands: PdfSpaceBand[] = [];
  const placedAt: (PdfSpaceAnnotation | undefined)[] = spaces.map(() => undefined);
  const order = spaces.map((space, index) => ({ space, index }))
    .sort((a, b) => compareAge(a.space, b.space) || a.index - b.index);
  let count = 0;
  let growth = 0;

  for (const { space, index } of order) {
    if (count >= PDF_SPACE_MAX_PER_PAGE || takenIds.has(space.id)) continue;
    // Bound the total inserted height, including spaces in parallel columns.
    if (growth + space.height > PDF_SPACE_MAX_PAGE_GROWTH + EPSILON) continue;

    let placed = space;
    const overlapping = bands.filter((band) => bandsOverlap(band, space.band));

    if (overlapping.length && !(overlapping.length === 1 && sameBand(overlapping[0], space.band))) {
      const container = bands.find((band) => !isFullWidthBand(band) && band.top < space.y && space.y < band.bottom);
      placed = container ? adoptBand(space, container) : { ...space, band: fullWidthBand(space.y), column: 0 };
    }

    if (!bands.some((band) => sameBand(band, placed.band))) bands.push(placed.band);
    placedAt[index] = placed;
    takenIds.add(space.id);
    count++;
    growth += placed.height;
  }

  return placedAt;
}

/** {@link reconcilePdfSpaces} for the spaces of one page. Kept spaces stay in input order. */
export function reconcilePageSpaces(spaces: readonly PdfSpaceAnnotation[]): PdfSpaceAnnotation[] {
  return reconcileAligned(spaces, new Set()).filter((space): space is PdfSpaceAnnotation => Boolean(space));
}

/**
 * Makes every page's spaces consistent (the oldest win: bands never overlap,
 * ids are unique, count and total height are bounded) and drops `space`
 * references to a space that is missing or on another page; such
 * annotations then sit on the page itself.
 */
export function reconcilePdfSpaces(annotations: readonly PdfAnnotation[]): PdfAnnotation[] {
  const spacesByPage = new Map<number, { space: PdfSpaceAnnotation; index: number }[]>();
  annotations.forEach((annotation, index) => {
    if (annotation.type !== "space") return;
    spacesByPage.set(annotation.pageNumber, [...(spacesByPage.get(annotation.pageNumber) ?? []), { space: annotation, index }]);
  });

  const placed = new Map<number, PdfSpaceAnnotation | undefined>();
  const pageOfSpace = new Map<string, number>();
  const takenIds = new Set<string>();
  for (const [pageNumber, entries] of [...spacesByPage].sort(([a], [b]) => a - b)) {
    const kept = reconcileAligned(entries.map((entry) => entry.space), takenIds);
    entries.forEach((entry, position) => {
      placed.set(entry.index, kept[position]);
      if (kept[position]) pageOfSpace.set(entry.space.id, pageNumber);
    });
  }

  const result: PdfAnnotation[] = [];
  annotations.forEach((annotation, index) => {
    if (annotation.type === "space") {
      const space = placed.get(index);
      if (space) result.push(space);
    } else if ("space" in annotation && annotation.space !== undefined && pageOfSpace.get(annotation.space) !== annotation.pageNumber) {
      const rest = { ...annotation };
      delete rest.space;
      result.push(rest);
    } else {
      result.push(annotation);
    }
  });
  return result;
}
