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
  return validPoint(value) && finiteNumber((value as JsonRecord).width) && finiteNumber((value as JsonRecord).height);
}

function geometryViolation(type: string, value: unknown): string | null {
  if (!isPlainJsonRecord(value)) return "geometry must be a plain JSON object.";
  if (jsonBytes(value) > PdfLimits.maxGeometryBytes) return "geometry is too large.";
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
    case "space":
      return finiteNumber(value.y) && finiteNumber(value.height) ? null : "A space needs a cut and a height.";
    default:
      // A type from a newer client: only its size and page are checked.
      return null;
  }
}

function styleViolation(value: unknown): string | null {
  if (!isPlainJsonRecord(value)) return "style must be a plain JSON object.";
  if (jsonBytes(value) > PdfLimits.maxStyleBytes) return "style is too large.";
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
    case PdfMarkFields.geometry:
      return geometryViolation(type, value);
    case PdfMarkFields.style:
      return styleViolation(value);
    case PdfMarkFields.space:
      return value === undefined || (typeof value === "string" && value.length <= 200) ? null : "space must be a mark id.";
    case PdfMarkFields.sourceHash:
      return value === undefined || (typeof value === "string" && SHA256_HEX.test(value)) ? null : "sourceHash must be a SHA-256.";
    case PdfMarkFields.deleted:
      if (value === undefined) return null;
      return isPlainJsonRecord(value) && typeof value.by === "string" && typeof value.at === "string" ? null : "deleted must say who and when.";
    default:
      return `Marks have no ${field} field.`;
  }
}

/** The fields a new mark must have. */
export const PDF_REQUIRED_FIELDS: readonly string[] = [PdfMarkFields.id, PdfMarkFields.type, PdfMarkFields.createdAt, PdfMarkFields.createdBy, PdfMarkFields.geometry];
