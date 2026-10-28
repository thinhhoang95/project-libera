import type { PdfSpaceBand } from "@/lib/types";
import { PDF_SPACE_MAX_SPLITS } from "@/lib/pdf-space";

/*
 * Where a space may open on a page, read from a downsampled picture of it
 * (docs/create-space-plan.md, "Layout analysis"). Pixels rather than text
 * runs, so figures, drawings, equations and scanned pages count as content.
 */

/** A page's ink, one byte per cell (1 where the page is not background), in document layout. */
export type PdfInkMask = {
  columns: number;
  rows: number;
  ink: Uint8Array;
  /** The page background, as `#rrggbb`. */
  background: string;
};

// A cell is ink when its color is this far (sum of channel differences) from the background.
const INK_THRESHOLD = 40;
// Blank runs at most this tall (page heights) are gaps between lines or
// paragraphs: the cut goes in their middle. Taller runs are margins or section
// gaps, where the cut stays at the pointer.
const SNAP_RUN_MAX = 0.05;
// How far a cut may move to reach blank paper, in page heights.
const SNAP_REACH = 0.03;
// Distance kept from content when the cut lands at the edge of a tall run.
const EDGE_CLEARANCE = 0.008;

function hex(value: number) {
  return value.toString(16).padStart(2, "0");
}

/** Builds a mask from RGBA pixels: the background is the most common color along the border. */
export function inkMaskFromPixels(data: Uint8ClampedArray, columns: number, rows: number): PdfInkMask {
  const counts = new Map<number, { count: number; r: number; g: number; b: number }>();
  const sample = (index: number) => {
    const offset = index * 4;
    if (data[offset + 3] < 128) return;
    // Five bits per channel, so antialiasing noise does not split the vote.
    const key = ((data[offset] >> 3) << 10) | ((data[offset + 1] >> 3) << 5) | (data[offset + 2] >> 3);
    const entry = counts.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    entry.count++;
    entry.r += data[offset];
    entry.g += data[offset + 1];
    entry.b += data[offset + 2];
    counts.set(key, entry);
  };
  for (let column = 0; column < columns; column++) {
    sample(column);
    sample((rows - 1) * columns + column);
  }
  for (let row = 0; row < rows; row++) {
    sample(row * columns);
    sample(row * columns + columns - 1);
  }

  let best = { count: 0, r: 255, g: 255, b: 255 };
  for (const entry of counts.values()) if (entry.count > best.count) best = entry;
  const r = best.count ? Math.round(best.r / best.count) : 255;
  const g = best.count ? Math.round(best.g / best.count) : 255;
  const b = best.count ? Math.round(best.b / best.count) : 255;

  const ink = new Uint8Array(columns * rows);
  for (let index = 0; index < ink.length; index++) {
    const offset = index * 4;
    // Unrendered (transparent) areas count as paper.
    if (data[offset + 3] < 128) continue;
    const distance = Math.abs(data[offset] - r) + Math.abs(data[offset + 1] - g) + Math.abs(data[offset + 2] - b);
    if (distance > INK_THRESHOLD) ink[index] = 1;
  }

  return { columns, rows, ink, background: `#${hex(r)}${hex(g)}${hex(b)}` };
}

const blankRowCache = new WeakMap<PdfInkMask, Map<string, Uint8Array>>();

/** 1 for each row with no ink between cell columns `from` (inclusive) and `to` (exclusive). */
function blankRows(mask: PdfInkMask, from = 0, to = mask.columns) {
  let cache = blankRowCache.get(mask);
  if (!cache) blankRowCache.set(mask, cache = new Map());
  const key = `${from}:${to}`;
  let blank = cache.get(key);
  if (blank) return blank;
  blank = new Uint8Array(mask.rows);
  for (let row = 0; row < mask.rows; row++) {
    let empty = 1;
    for (let offset = row * mask.columns + from, end = row * mask.columns + to; offset < end; offset++) {
      if (mask.ink[offset]) {
        empty = 0;
        break;
      }
    }
    blank[row] = empty;
  }
  cache.set(key, blank);
  return blank;
}

/**
 * Moves a cut at `y` (page fraction) to blank paper, so it never splits a
 * line, an equation or a figure. Only the page between `x0` and `x1` counts,
 * so a cut in one column ignores the others. Unsnapped when nothing blank is
 * near: the cut then goes where the pointer is.
 */
export function snapCut(mask: PdfInkMask, y: number, x0 = 0, x1 = 1): { y: number; snapped: boolean } {
  const from = Math.max(0, Math.min(mask.columns - 1, Math.floor(x0 * mask.columns)));
  const to = Math.max(from + 1, Math.min(mask.columns, Math.ceil(x1 * mask.columns)));
  const blank = blankRows(mask, from, to);
  const { rows } = mask;
  const pointer = Math.min(rows - 1, Math.max(0, Math.floor(y * rows)));
  const reach = Math.ceil(SNAP_REACH * rows);
  let found = -1;

  for (let distance = 0; distance <= reach && found < 0; distance++) {
    if (pointer - distance >= 0 && blank[pointer - distance]) found = pointer - distance;
    else if (pointer + distance < rows && blank[pointer + distance]) found = pointer + distance;
  }
  if (found < 0) return { y, snapped: false };

  let top = found;
  let bottom = found;
  while (top > 0 && blank[top - 1]) top--;
  while (bottom < rows - 1 && blank[bottom + 1]) bottom++;
  const runRows = bottom - top + 1;

  if (runRows / rows <= SNAP_RUN_MAX) return { y: (top + bottom + 1) / 2 / rows, snapped: true };
  if (pointer >= top && pointer <= bottom) return { y, snapped: true };
  // A tall run beside the pointer: cut just inside it, clear of the content.
  const clearance = Math.min(runRows / 2, Math.ceil(EDGE_CLEARANCE * rows));
  return { y: (pointer < top ? top + clearance : bottom + 1 - clearance) / rows, snapped: true };
}

// ---------------------------------------------------------------------------
// Column blocks: runs of the page where columns stand side by side between
// full-width elements (a title, a spanning figure, a footer).

// A gutter is a blank strip at least this wide (page widths) through a block.
const MIN_GUTTER = 0.015;
// Each column is at least this wide (page widths), so tables of narrow cells
// and bullet strips are not columns.
const MIN_COLUMN = 0.12;
// A column block is at least this tall (page heights).
const MIN_BLOCK = 0.06;

type Slab = { top: number; bottom: number; ink: Uint8Array };
type Block = { top: number; bottom: number; ink: Uint8Array; gutters: [number, number][] };

/** Rows with ink, grouped into slabs separated by rows blank across the page. */
function slabs(mask: PdfInkMask): Slab[] {
  const blank = blankRows(mask);
  const found: Slab[] = [];
  for (let row = 0; row < mask.rows; row++) {
    if (blank[row]) continue;
    const top = row;
    while (row + 1 < mask.rows && !blank[row + 1]) row++;
    const ink = new Uint8Array(mask.columns);
    for (let r = top; r <= row; r++) {
      for (let column = 0, offset = r * mask.columns; column < mask.columns; column++, offset++) {
        if (mask.ink[offset]) ink[column] = 1;
      }
    }
    found.push({ top, bottom: row, ink });
  }
  return found;
}

/**
 * The widest blank strip of `ink` inside `gutter`, when it is still wide
 * enough to be a gutter: a line reaching a little into the gutter narrows it
 * rather than ending the block.
 */
function narrowGutter(ink: Uint8Array, [from, to]: [number, number], minGutter: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (let column = from; column <= to; column++) {
    if (ink[column]) continue;
    const start = column;
    while (column + 1 <= to && !ink[column + 1]) column++;
    if (!best || column - start > best[1] - best[0]) best = [start, column];
  }
  return best && best[1] - best[0] + 1 >= minGutter ? best : null;
}

/** Every gutter narrowed to what `ink` leaves blank, or null when one closes. */
function narrowGutters(ink: Uint8Array, gutterList: [number, number][], minGutter: number) {
  const narrowed: [number, number][] = [];
  for (const gutter of gutterList) {
    const kept = narrowGutter(ink, gutter, minGutter);
    if (!kept) return null;
    narrowed.push(kept);
  }
  return narrowed;
}

/** Blank strips inside the content of `ink` that leave wide enough columns on every side. */
function gutters(ink: Uint8Array, columns: number): [number, number][] {
  let first = 0;
  let last = columns - 1;
  while (first < columns && !ink[first]) first++;
  while (last >= 0 && !ink[last]) last--;
  if (last <= first) return [];

  const minGutter = Math.ceil(MIN_GUTTER * columns);
  const minColumn = MIN_COLUMN * columns;
  const kept: [number, number][] = [];
  let edge = first;
  for (let column = first; column <= last; column++) {
    if (ink[column]) continue;
    const start = column;
    while (column + 1 <= last && !ink[column + 1]) column++;
    if (column - start + 1 < minGutter || start - edge < minColumn) continue;
    kept.push([start, column]);
    edge = column + 1;
    if (kept.length === PDF_SPACE_MAX_SPLITS) break;
  }
  // The last column must be wide enough too.
  while (kept.length && last - kept[kept.length - 1][1] < minColumn) kept.pop();
  return kept;
}

const blockCache = new WeakMap<PdfInkMask, PdfSpaceBand[]>();

/**
 * The page's column blocks, as bands: where columns stand side by side, with
 * splits at the middle of each gutter. A block's lines may end early in some
 * columns (the last lines of a page) and still belong to it, as long as its
 * gutters stay blank. Full-width content ends a block.
 */
export function columnBlocks(mask: PdfInkMask): PdfSpaceBand[] {
  const cached = blockCache.get(mask);
  if (cached) return cached;
  const blocks: Block[] = [];
  const minGutter = Math.ceil(MIN_GUTTER * mask.columns);

  for (const slab of slabs(mask)) {
    const current = blocks.at(-1);
    const own = gutters(slab.ink, mask.columns);
    const sameColumns = current?.gutters.length ? narrowGutters(slab.ink, current.gutters, minGutter) : null;
    // What came before may be one column of this block, such as a heading over the left column.
    const joinsColumns = current && !current.gutters.length && own.length ? narrowGutters(current.ink, own, minGutter) : null;
    const moreFullWidth = current && !current.gutters.length && !own.length;

    if (!current || !(sameColumns || joinsColumns || moreFullWidth)) {
      blocks.push({ top: slab.top, bottom: slab.bottom, ink: slab.ink.slice(), gutters: own });
      continue;
    }
    if (sameColumns) current.gutters = sameColumns;
    if (joinsColumns) current.gutters = joinsColumns;
    current.bottom = slab.bottom;
    for (let column = 0; column < mask.columns; column++) if (slab.ink[column]) current.ink[column] = 1;
  }

  const bands = blocks
    .filter((block) => block.gutters.length && (block.bottom + 1 - block.top) / mask.rows >= MIN_BLOCK)
    .map((block) => ({
      top: block.top / mask.rows,
      bottom: (block.bottom + 1) / mask.rows,
      splits: block.gutters.map(([from, to]) => (from + to + 1) / 2 / mask.columns),
    }));
  blockCache.set(mask, bands);
  return bands;
}

/** Where a new space opens: its cut, and the block layout and column it opens in. */
export type PdfSpaceCut = { y: number; snapped: boolean; band: PdfSpaceBand; column: number };

function isFullWidth(band: PdfSpaceBand) {
  return band.bottom - band.top <= 1e-6;
}

/** Narrows a found block so it does not overlap the page's stored bands, keeping the side holding `y`. */
function trimBlock(block: PdfSpaceBand, stored: readonly PdfSpaceBand[], y: number): PdfSpaceBand | null {
  let { top, bottom } = block;
  for (const band of stored) {
    if (isFullWidth(band)) {
      if (top < band.top && band.top < bottom) {
        if (band.top <= y) top = band.top;
        else bottom = band.top;
      }
    } else if (band.top < bottom && top < band.bottom) {
      if (band.bottom <= y) top = Math.max(top, band.bottom);
      else if (band.top >= y) bottom = Math.min(bottom, band.top);
      else return null;
    }
  }
  return bottom - top > 1e-6 && top < y && y < bottom ? { top, bottom, splits: [...block.splits] } : null;
}

/**
 * Places a new space at document point `point`. Inside a column block the
 * space opens in the pointer's column only; a block stored with the page's
 * spaces wins over a fresh analysis, so all spaces in one block agree on its
 * columns. Elsewhere, or with `fullWidth`, it opens across the page. The cut
 * snaps to blank paper in its column; without a mask (the page is still
 * rendering) it stays at the pointer.
 */
export function placeSpaceCut(
  mask: PdfInkMask | null,
  point: { x: number; y: number },
  stored: readonly PdfSpaceBand[],
  { fullWidth = false, snap = true }: { fullWidth?: boolean; snap?: boolean } = {},
): PdfSpaceCut {
  const inside = (band: PdfSpaceBand, y: number) => !isFullWidth(band) && band.top < y && y < band.bottom;
  let band = stored.find((candidate) => inside(candidate, point.y)) ?? null;

  if (!band && !fullWidth && mask) {
    const block = columnBlocks(mask).find((candidate) => inside(candidate, point.y));
    band = block ? trimBlock(block, stored, point.y) : null;
  }

  if (!band) {
    const cut = mask && snap ? snapCut(mask, point.y) : { y: point.y, snapped: false };
    // Snapping must not carry a full-width cut into a stored block.
    const y = stored.some((candidate) => inside(candidate, cut.y)) ? point.y : cut.y;
    return { y, snapped: cut.snapped && y === cut.y, band: { top: y, bottom: y, splits: [] }, column: 0 };
  }

  let column = 0;
  while (column < band.splits.length && point.x >= band.splits[column]) column++;
  const x0 = band.splits[column - 1] ?? 0;
  const x1 = band.splits[column] ?? 1;
  const cut = mask && snap ? snapCut(mask, point.y, x0, x1) : { y: point.y, snapped: false };
  return { y: Math.min(band.bottom, Math.max(band.top, cut.y)), snapped: cut.snapped, band, column };
}
