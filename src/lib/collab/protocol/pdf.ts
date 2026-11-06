// Shared PDFs (docs/collaboration/pdf-realtime-plan.md).
//
// A shared PDF's bytes stay a blob. Its marks live in a document of kind
// "pdf", in the `annotations` sub-document, so commenters can write them.
// This module names the keys and validates stored values for the server and
// every client, and has no runtime dependencies: it must not import yjs.

export const PdfKeys = {
  /** Y.Map<markId, Y.Map> of the marks, deleted ones included. */
  marks: "pdfMarks",
  /** Y.Map<sidecarHash, PdfImportRecord>: local sidecars already merged. */
  imports: "pdfImports",
  /** Y.Map<anchorId, record>: where each comment thread is on the page. */
  anchors: "pdfAnchors",
} as const;

/** Key of the manifest `settings` flag that turns live PDFs on for a notebook. */
export const PDF_LIVE_SETTING = "pdfLive";

export const PDF_DOC_PREFIX = "pdf_";
const PDF_DOC_DIGEST_LENGTH = 40;

/** What hashes to a PDF's document id, so any client can name it while offline. */
export function pdfDocIdSeed(projectId: string, fileId: string): string {
  return `libera-pdf\u0000${projectId}\u0000${fileId}`;
}

/** The document id from the base64url SHA-256 of {@link pdfDocIdSeed}. */
export function pdfDocIdFromDigest(digest: string): string {
  return `${PDF_DOC_PREFIX}${digest.slice(0, PDF_DOC_DIGEST_LENGTH)}`;
}

export function isPdfDocId(docId: string): boolean {
  return docId.startsWith(PDF_DOC_PREFIX);
}

export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

export const PDF_MARK_TYPES = ["highlight", "shape", "ink", "text", "space"] as const;
export type PdfMarkType = (typeof PDF_MARK_TYPES)[number];

/** A mark's fields in the CRDT. Field groups merge independently. */
export const PdfMarkFields = {
  id: "id",
  type: "type",
  createdAt: "createdAt",
  createdBy: "createdBy",
  updatedAt: "updatedAt",
  updatedBy: "updatedBy",
  /** Where the mark is: page, rectangles, points and any field not named here. */
  geometry: "geometry",
  /** How it is drawn. */
  style: "style",
  /** The id of the space the mark sits in. */
  space: "space",
  /** A note's Markdown, a Y.Text. */
  text: "text",
  /** The PDF version the mark was placed on. */
  sourceHash: "sourceHash",
  /** Who deleted the mark, and when; absent while it is live. */
  deleted: "deleted",
} as const;

export const PDF_IMMUTABLE_FIELDS: readonly string[] = [PdfMarkFields.id, PdfMarkFields.type, PdfMarkFields.createdAt, PdfMarkFields.createdBy];

/** Annotation fields stored in `style`; the rest of a mark goes in `geometry`. */
export const PDF_STYLE_KEYS: readonly string[] = ["color", "strokeWidth", "markup", "shape", "fontSize", "fontFamily", "fill"];

export const PdfLimits = {
  /** Longest note, as the sidecar normalizer allows. */
  maxTextLength: 10_000,
  /** Largest geometry: an ink stroke at the sidecar's 5,000-point limit. */
  maxGeometryBytes: 512 * 1024,
  maxStyleBytes: 2 * 1024,
  maxPageNumber: 10_000,
  /** Live and deleted marks in one document. */
  maxMarks: 100_000,
  /** PDF documents in one project. */
  maxDocuments: 20_000,
} as const;

export interface PdfDeletion {
  by: string;
  at: string;
}

export interface PdfImportRecord {
  by: string;
  at: string;
}

type JsonRecord = Record<string, unknown>;

/** Additive REST operation: old clients need no wire changes. */
export interface PdfImportRequest {
  marks: unknown[];
  comments?: unknown[];
  sourceHash?: string;
  hash?: string;
}

export function pdfAnnotationValues(annotation: JsonRecord, accountId: string, sourceHash?: string): JsonRecord {
  const geometry: JsonRecord = {};
  const style: JsonRecord = {};
  const metadata = ["id", "type", "createdAt", "updatedAt", "space", "text", "sourceHash"];
  for (const [key, value] of Object.entries(annotation)) {
    if (value !== undefined && !metadata.includes(key)) (PDF_STYLE_KEYS.includes(key) ? style : geometry)[key] = value;
  }
  return { id: annotation.id, type: annotation.type, createdAt: annotation.createdAt, updatedAt: annotation.updatedAt,
    createdBy: accountId, updatedBy: accountId, geometry, style,
    ...(annotation.space !== undefined ? { space: annotation.space } : {}),
    ...(annotation.type === "text" ? { text: annotation.text } : {}), ...(annotation.sourceHash !== undefined || sourceHash ? { sourceHash: annotation.sourceHash ?? sourceHash } : {}) };
}

export function isPlainJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHAPES: readonly string[] = ["rectangle", "ellipse", "line", "arrow"];
const MARKUPS: readonly string[] = ["underline", "strikethrough", "squiggly"];
const FONTS: readonly string[] = ["sans", "serif", "hand", "mono"];

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function jsonBytes(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function validPoint(value: unknown): boolean {
  return isPlainJsonRecord(value) && finiteNumber(value.x) && finiteNumber(value.y);
}

function validRect(value: unknown): boolean {
  if (!isPlainJsonRecord(value) || !validPoint(value)) return false;
  return finiteNumber(value.width) && value.width >= 0 && finiteNumber(value.height) && value.height >= 0;
}

function geometryViolation(type: string, value: unknown): string | null {
  if (!isPlainJsonRecord(value)) return "geometry must be a plain JSON object.";
  if (jsonBytes(value) > PdfLimits.maxGeometryBytes) return "geometry is too large.";
  for (const key of Object.keys(value)) {
    if (PDF_STYLE_KEYS.includes(key) || Object.values(PdfMarkFields).includes(key as typeof PdfMarkFields.id)) return `geometry cannot override ${key}.`;
  }
  if (value.quote !== undefined && (typeof value.quote !== "string" || value.quote.length > 4000)) return "quote is too long.";
  const page = value.pageNumber;
  if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > PdfLimits.maxPageNumber) return "pageNumber is not a page.";
  switch (type) {
    case "highlight":
      return Array.isArray(value.rects) && value.rects.length > 0 && value.rects.every(validRect) ? null : "A highlight needs rectangles.";
    case "shape":
      return validPoint(value.from) && validPoint(value.to) ? null : "A shape needs two points.";
    case "ink":
      return Array.isArray(value.points) && value.points.length > 0 && value.points.every(validPoint) ? null : "A stroke needs points.";
    case "text":
      return validRect(value.rect) ? null : "A note needs a rectangle.";
    case "space": {
      const band = value.band;
      return finiteNumber(value.y) && finiteNumber(value.height) && value.height > 0
        && isPlainJsonRecord(band) && finiteNumber(band.top) && finiteNumber(band.bottom) && band.bottom >= band.top
        && Array.isArray(band.splits) && band.splits.length <= 100 && band.splits.every((split, index, splits) => finiteNumber(split) && split >= 0 && split <= 1 && (index === 0 || split > splits[index - 1]))
        && Number.isInteger(value.column) && (value.column as number) >= 0 && (value.column as number) <= band.splits.length
        ? null : "A space needs a cut, height, band and column.";
    }
    default:
      // A type from a newer client: only its size and page are checked.
      return null;
  }
}

function styleViolation(type: string, value: unknown): string | null {
  if (!isPlainJsonRecord(value)) return "style must be a plain JSON object.";
  if (jsonBytes(value) > PdfLimits.maxStyleBytes) return "style is too large.";
  const required: Record<string, string[]> = { highlight: ["color"], shape: ["shape", "color", "strokeWidth"], ink: ["color", "strokeWidth"], text: ["fontSize"] };
  for (const key of required[type] ?? []) if (value[key] === undefined) return `A ${type} needs ${key}.`;
  for (const key of Object.keys(value)) if (!PDF_STYLE_KEYS.includes(key)) return `style cannot override ${key}.`;
  for (const key of ["color", "fill"]) {
    if (value[key] !== undefined && !(typeof value[key] === "string" && HEX_COLOR.test(value[key]))) return `${key} must be a hex colour.`;
  }
  for (const key of ["strokeWidth", "fontSize"]) {
    if (value[key] !== undefined && !finiteNumber(value[key])) return `${key} must be a number.`;
  }
  if (value.shape !== undefined && !SHAPES.includes(value.shape as string)) return "Unknown shape.";
  if (value.markup !== undefined && !MARKUPS.includes(value.markup as string)) return "Unknown markup.";
  if (value.fontFamily !== undefined && !FONTS.includes(value.fontFamily as string)) return "Unknown font.";
  return null;
}

/**
 * Why `value` cannot be stored in a mark's `field`, or null. `type` is the
 * mark's type. The text field is a Y.Text and is checked by its length.
 */
export function pdfMarkFieldViolation(type: string, field: string, value: unknown): string | null {
  switch (field) {
    case PdfMarkFields.id:
    case PdfMarkFields.createdBy:
    case PdfMarkFields.updatedBy:
      return typeof value === "string" && value.length > 0 && value.length <= 200 ? null : `${field} must be a short string.`;
    case PdfMarkFields.type:
      return typeof value === "string" && value.length > 0 && value.length <= 40 ? null : "type must be a short string.";
    case PdfMarkFields.createdAt:
    case PdfMarkFields.updatedAt:
      return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? null : `${field} must be a date.`;
    case PdfMarkFields.text:
      return type === "text" && typeof value === "string" && value.length <= PdfLimits.maxTextLength ? null : "This note is too long or invalid.";
    case PdfMarkFields.geometry:
      return geometryViolation(type, value);
    case PdfMarkFields.style:
      return styleViolation(type, value);
    case PdfMarkFields.space:
      return value === undefined || (typeof value === "string" && value.length <= 200) ? null : "space must be a mark id.";
    case PdfMarkFields.sourceHash:
      return value === undefined || (typeof value === "string" && SHA256_HEX.test(value)) ? null : "sourceHash must be a SHA-256.";
    case PdfMarkFields.deleted:
      if (value === undefined) return null;
      return isPlainJsonRecord(value) && !pdfMarkFieldViolation(type, "createdBy", value.by) && !pdfMarkFieldViolation(type, "createdAt", value.at) ? null : "deleted must say who and when.";
    default:
      return `Marks have no ${field} field.`;
  }
}

/** The fields a new mark must have. */
export const PDF_REQUIRED_FIELDS: readonly string[] = [PdfMarkFields.id, PdfMarkFields.type, PdfMarkFields.createdAt, PdfMarkFields.createdBy, PdfMarkFields.geometry];

/** Complete plain values, also used before a client queues a mutation. */
export function pdfMarkValuesViolation(fields: Record<string, unknown>): string | null {
  const type = String(fields.type ?? "");
  for (const field of [...PDF_REQUIRED_FIELDS, ...(type === "text" ? ["text"] : [])]) {
    if (fields[field] === undefined) return `A mark needs ${field}.`;
  }
  const requiredStyle: Record<string, string[]> = { highlight: ["color"], shape: ["shape", "color", "strokeWidth"], ink: ["color", "strokeWidth"], text: ["fontSize"] };
  for (const key of requiredStyle[type] ?? []) {
    if (!isPlainJsonRecord(fields.style) || fields.style[key] === undefined) return `A ${type} needs ${key}.`;
  }
  for (const [field, value] of Object.entries(fields)) {
    const problem = pdfMarkFieldViolation(type, field, value);
    if (problem) return problem;
  }
  return null;
}

/** Anchors are checked before storage and again before projecting remote threads. */
export function pdfAnchorViolation(value: unknown): string | null {
  if (!isPlainJsonRecord(value) || typeof value.quote !== "string" || value.quote.length > 4000) return "An anchor needs a quote.";
  if (!Array.isArray(value.segments) || !value.segments.length || value.segments.length > 50) return "An anchor needs segments.";
  for (const segment of value.segments) {
    if (!isPlainJsonRecord(segment) || !Number.isInteger(segment.pageNumber) || (segment.pageNumber as number) < 1 || (segment.pageNumber as number) > PdfLimits.maxPageNumber
      || !Array.isArray(segment.rects) || !segment.rects.length || segment.rects.length > 200 || !segment.rects.every(validRect)) return "Invalid anchor segment.";
  }
  return jsonBytes(value) > 64 * 1024 ? "Anchor is too large." : null;
}
