/**
 * Ink: pen strokes stored beside a document (docs/ink-plan.md).
 *
 * Every surface (a PDF page, a Markdown ink block, a note's text, a photo)
 * has its own uniform units. Strokes keep raw pen samples, packed by
 * `codec.ts`; outlines are computed when drawn.
 */

export const INK_FORMAT = "libera-ink";
export const INK_VERSION = 1;

export type InkBrush = "pen" | "marker" | "highlighter";
export type InkLineStyle = "solid" | "dashed" | "dotted";

export const INK_BRUSHES: readonly InkBrush[] = ["pen", "marker", "highlighter"];
export const INK_LINE_STYLES: readonly InkLineStyle[] = ["solid", "dashed", "dotted"];

/** One pen sample in surface units. Pressure runs 0–1; tilt is in degrees. */
export type InkSample = {
  x: number;
  y: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  /** Milliseconds since the stroke's first sample. */
  t?: number;
};

export type InkRect = { x: number; y: number; width: number; height: number };

export type InkStroke = {
  id: string;
  /** A brush this version may not know draws as a pen; it is kept as written. */
  brush: InkBrush | (string & {});
  color: `#${string}`;
  opacity: number;
  /** Nominal tip width, in surface units. */
  width: number;
  lineStyle: InkLineStyle;
  /** Packed samples (`encodeInkSamples`). */
  points: string;
  /** Sample bounds, ignoring the tip width. */
  bounds: InkRect;
  /** Where the stroke sits, for surfaces with sub-areas (a PDF space). */
  anchor?: { space?: string };
  /** Overlay ink on note text: the anchored group it belongs to. */
  group?: string;
  createdAt: string;
};

/** The units, and size in them, of the surface a chunk's strokes are drawn on. */
export type InkFrame = { unit: "pt" | "px"; width: number; height: number };

export type InkAuthor = { key: string; name?: string };

/** The bytes of the PDF or image the ink was drawn on, to find it after a rename. */
export type InkSource = { size: number; sha256: string };

/** One author's file for one chunk. Only that author ever writes it. */
export type InkAuthorFile = {
  format: typeof INK_FORMAT;
  version: number;
  author: InkAuthor;
  source?: InkSource;
  frame: InkFrame;
  strokes: InkStroke[];
  /** Ids of strokes this author erased that belong to other authors. */
  erased: string[];
  /** Bumped on each write of this file. */
  revision: number;
};

/** A stroke in a merged chunk, with the author whose file holds it. */
export type MergedInkStroke = { stroke: InkStroke; author: string };

/** All authors' ink for one chunk. */
export type InkChunk = {
  frame: InkFrame | null;
  strokes: MergedInkStroke[];
};

/** Changes to one author's file. */
export type InkOps = {
  add?: InkStroke[];
  /** Ids to erase, whoever drew them (`applyInkOps`). */
  erase?: string[];
  /**
   * Undo of erasing another author's stroke. The stroke itself comes along in
   * case its author's file has dropped it meanwhile.
   */
  unerase?: InkStroke[];
};

export function isInkBrush(value: unknown): value is InkBrush {
  return typeof value === "string" && (INK_BRUSHES as readonly string[]).includes(value);
}

export function isInkLineStyle(value: unknown): value is InkLineStyle {
  return typeof value === "string" && (INK_LINE_STYLES as readonly string[]).includes(value);
}

export function isHexColor(value: unknown): value is `#${string}` {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

/** A random id for a stroke or group: 16 base-36 characters. */
export function createInkId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}
