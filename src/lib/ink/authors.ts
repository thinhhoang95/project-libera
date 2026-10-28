/*
 * Ink files are named `<chunk>.<author key>.ink`. The author key is random,
 * one per user and computer, so two computers of one person never write the
 * same file either. It never contains the person's name or email.
 */

export const INK_FILE_EXTENSION = ".ink";

const AUTHOR_KEY = /^[a-z0-9]{6,32}$/;
const CHUNK = /^(?:page-\d{4,6}|block-[a-z0-9]{1,32}|text|image|photo)$/;

export function isInkAuthorKey(value: unknown): value is string {
  return typeof value === "string" && AUTHOR_KEY.test(value);
}

export function isInkChunkName(value: unknown): value is string {
  return typeof value === "string" && CHUNK.test(value);
}

export function createInkAuthorKey() {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}

/** The chunk holding a PDF page's ink, numbered from 1. */
export function pdfPageChunk(pageNumber: number) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 999_999) throw new RangeError("No such page.");
  return `page-${String(pageNumber).padStart(4, "0")}`;
}

export function pageNumberOfChunk(chunk: string) {
  const match = /^page-(\d{4,6})$/.exec(chunk);
  return match ? Number(match[1]) : null;
}

export function inkFileName(chunk: string, author: string) {
  if (!isInkChunkName(chunk) || !isInkAuthorKey(author)) throw new RangeError("Invalid ink file name.");
  return `${chunk}.${author}${INK_FILE_EXTENSION}`;
}

/** The chunk and author of an ink file name, or null for any other file. */
export function parseInkFileName(name: string): { chunk: string; author: string } | null {
  if (!name.endsWith(INK_FILE_EXTENSION)) return null;
  const stem = name.slice(0, -INK_FILE_EXTENSION.length);
  const dot = stem.lastIndexOf(".");
  if (dot < 0) return null;
  const chunk = stem.slice(0, dot);
  const author = stem.slice(dot + 1);
  return isInkChunkName(chunk) && isInkAuthorKey(author) ? { chunk, author } : null;
}
