import { readFile, rm, stat } from "node:fs/promises";
import { readFileContentHash, readFileSignature } from "@/lib/storage/file-signature";
import { assertPdfFileName } from "@/lib/storage/file-types";
import { writeJsonForSource } from "@/lib/storage/fs-utils";
import { ensureAdminRoot, filePathFromParts, pdfOutlinePath, relativeFilePath, splitFilePath } from "@/lib/storage/paths";
import { openPdfDocument } from "@/lib/storage/pdf-text-cache";
import {
  MAX_OUTLINE_ENTRIES,
  MAX_OUTLINE_LEVEL,
  cleanOutlineTitle,
  parsePdfOutlineFile,
  type PdfOutlineEntry,
  type PdfOutlineFile,
  type PdfOutlinePayload,
} from "@/lib/pdf-outline";

// A PDF's outline for the Outlines tab: its own bookmarks, read with pdf.js,
// or the one the AI Agent generated into a side-car beside the notebook's
// other Libera data, `.libera/outlines/by-path/<folders>/<name>.json`. The
// side-car follows the PDF when Libera renames, moves, copies, archives or
// deletes it (files.ts), and when that happens elsewhere (pdf-sidecars.ts).
// Writes go through writeJsonForSource: a PDF renamed, deleted or changed
// while its outline was being generated gets no outline at its old path.

type Located = { notebook: string; pathParts: string[]; relativePath: string; document: string; sidecar: string };

function locate(relativePath: string): Located {
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertPdfFileName(name);
  return {
    notebook,
    pathParts,
    relativePath: relativeFilePath(notebook, pathParts),
    document: filePathFromParts(notebook, pathParts),
    sidecar: pdfOutlinePath(notebook, pathParts),
  };
}

// ---------------------------------------------------------------------------
// Embedded bookmarks
// ---------------------------------------------------------------------------

type PdfDocument = Awaited<ReturnType<typeof openPdfDocument>>;
type RawOutlineItem = { title?: unknown; dest?: unknown; items?: unknown };

/** Where an explicit or named destination points: its page, and how far down it (0 = top). */
async function resolveDestination(document: PdfDocument, dest: unknown, views: Map<number, number[]>): Promise<{ page?: number; top?: number }> {
  let explicit = dest;
  if (typeof dest === "string") explicit = await document.getDestination(dest).catch(() => null);
  if (!Array.isArray(explicit) || !explicit.length) return {};
  const reference = explicit[0];
  let index: number | null = null;
  if (typeof reference === "number" && Number.isInteger(reference)) index = reference;
  else if (reference && typeof reference === "object") index = await document.getPageIndex(reference as { num: number; gen: number }).catch(() => null);
  if (index === null || index < 0 || index >= document.numPages) return {};
  const page = index + 1;
  const kind = (explicit[1] as { name?: unknown } | undefined)?.name;
  const y = kind === "XYZ" ? explicit[3] : kind === "FitH" || kind === "FitBH" ? explicit[2] : kind === "FitR" ? explicit[5] : null;
  if (typeof y !== "number" || !Number.isFinite(y)) return { page };
  let view = views.get(page);
  if (!view) {
    view = await document.getPage(page).then((pdfPage) => pdfPage.view).catch(() => undefined);
    if (view) views.set(page, view);
  }
  const height = view ? view[3] - view[1] : 0;
  return height > 0 ? { page, top: Math.min(1, Math.max(0, 1 - (y - view![1]) / height)) } : { page };
}

/** The bookmark tree, flattened in order with levels (deeper than the deepest level shown sit at it). */
export async function flattenEmbeddedOutline(document: PdfDocument): Promise<PdfOutlineEntry[]> {
  const outline = (await document.getOutline()) as RawOutlineItem[] | null;
  if (!outline?.length) return [];
  const entries: PdfOutlineEntry[] = [];
  const views = new Map<number, number[]>();
  async function walk(items: RawOutlineItem[], level: number) {
    for (const item of items) {
      if (entries.length >= MAX_OUTLINE_ENTRIES) return;
      const title = cleanOutlineTitle(item.title);
      const children = Array.isArray(item.items) ? item.items as RawOutlineItem[] : [];
      if (title) {
        const target = await resolveDestination(document, item.dest, views);
        entries.push({ id: `b${entries.length + 1}`, title, level: Math.min(level, MAX_OUTLINE_LEVEL), ...target });
      }
      // An untitled bookmark's children take its place.
      if (children.length) await walk(children, title ? level + 1 : level);
    }
  }
  await walk(outline, 1);
  return entries;
}

const MAX_REMEMBERED_OUTLINES = 24;
const embeddedOutlines = new Map<string, Promise<PdfOutlineEntry[]>>();

/** The PDF's own bookmarks; remembered while the file is unchanged. */
export async function readEmbeddedPdfOutline(relativePath: string): Promise<PdfOutlineEntry[]> {
  await ensureAdminRoot();
  const { document } = locate(relativePath);
  const signature = await readFileSignature(document);
  const known = embeddedOutlines.get(signature);
  if (known) return known;
  const task = (async () => {
    const pdf = await openPdfDocument(document);
    try { return await flattenEmbeddedOutline(pdf); } finally { await pdf.destroy(); }
  })();
  embeddedOutlines.set(signature, task);
  task.catch(() => { if (embeddedOutlines.get(signature) === task) embeddedOutlines.delete(signature); });
  while (embeddedOutlines.size > MAX_REMEMBERED_OUTLINES) embeddedOutlines.delete(embeddedOutlines.keys().next().value!);
  return task;
}

// ---------------------------------------------------------------------------
// Page text with type sizes, for the outliners
// ---------------------------------------------------------------------------

type TextItem = { str?: unknown; transform?: unknown; height?: unknown; hasEOL?: unknown };

/** Lines set this much larger than the body text are marked for the outliners. */
const LARGE_TYPE = 1.12;

/**
 * Each page's text, one line per printed line, with lines set in larger type
 * than the body marked by their relative size: "[×1.6] 2 Methods". Plain
 * extracted text cannot tell a heading from a sentence; the type size can.
 */
export async function readPdfOutlinerPages(relativePath: string): Promise<string[]> {
  await ensureAdminRoot();
  const { document } = locate(relativePath);
  const pdf = await openPdfDocument(document);
  try {
    const pages: Array<Array<{ text: string; size: number }>> = [];
    const sizes = new Map<number, number>();
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: Array<{ text: string; size: number }> = [];
      let current = { text: "", size: 0 };
      let lastY: number | null = null;
      for (const raw of content.items as TextItem[]) {
        const value = typeof raw.str === "string" ? raw.str : "";
        const transform = Array.isArray(raw.transform) ? raw.transform as number[] : [];
        const size = Math.abs(Math.hypot(transform[2] ?? 0, transform[3] ?? 0)) || (typeof raw.height === "number" ? raw.height : 0);
        const y = typeof transform[5] === "number" ? transform[5] : null;
        if (current.text && y !== null && lastY !== null && Math.abs(y - lastY) > Math.max(2, size * 0.6)) {
          lines.push(current);
          current = { text: "", size: 0 };
        }
        if (value.trim()) {
          if (current.text && !current.text.endsWith(" ") && !/^\s/.test(value)) current.text += " ";
          current.text += value;
          current.size = Math.max(current.size, size);
          const rounded = Math.round(size * 2) / 2;
          sizes.set(rounded, (sizes.get(rounded) ?? 0) + value.length);
        }
        if (y !== null) lastY = y;
        if (raw.hasEOL && current.text) {
          lines.push(current);
          current = { text: "", size: 0 };
        }
      }
      if (current.text) lines.push(current);
      pages.push(lines.map((line) => ({ text: line.text.replace(/\s+/g, " ").trim(), size: line.size })).filter((line) => line.text));
      page.cleanup();
    }
    let body = 0;
    let most = -1;
    for (const [size, count] of sizes) if (count > most) { body = size; most = count; }
    return pages.map((lines) => lines.map((line) => {
      const ratio = body > 0 ? line.size / body : 1;
      return ratio >= LARGE_TYPE && line.text.length <= 200 ? `[×${ratio.toFixed(1)}] ${line.text}` : line.text;
    }).join("\n"));
  } finally {
    await pdf.destroy();
  }
}

// ---------------------------------------------------------------------------
// The generated outline's side-car
// ---------------------------------------------------------------------------

export type PdfSourceSnapshot = { signature: string; size: number; contentHash: string };

/** The PDF's identity now, to write its outline only if it is still the same file. */
export async function readPdfSourceSnapshot(relativePath: string): Promise<PdfSourceSnapshot> {
  const { document } = locate(relativePath);
  const signature = await readFileSignature(document);
  const contentHash = await readFileContentHash(document);
  return { signature, size: Number(signature.split(":")[0]), contentHash };
}

export async function readPdfOutlineFile(relativePath: string): Promise<PdfOutlineFile | null> {
  const { sidecar } = locate(relativePath);
  try {
    return parsePdfOutlineFile(JSON.parse(await readFile(sidecar, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Writes the outline if the PDF is still the file `snapshot` describes: same
 * path, bytes and signature. Throws a 409 StorageError otherwise.
 */
export async function writePdfOutlineFile(relativePath: string, outline: PdfOutlineFile, snapshot: PdfSourceSnapshot) {
  const { sidecar, document } = locate(relativePath);
  await writeJsonForSource(sidecar, outline, document, snapshot.signature, snapshot.contentHash);
}

export async function deletePdfOutlineFile(relativePath: string) {
  await rm(locate(relativePath).sidecar, { force: true });
}

/** What the Outlines tab shows: the bookmarks, the generated outline, and whether the PDF changed since. */
export async function readPdfOutline(relativePath: string): Promise<PdfOutlinePayload> {
  await ensureAdminRoot();
  const located = locate(relativePath);
  await stat(located.document);
  let embedded: PdfOutlineEntry[] = [];
  let embeddedError: string | undefined;
  try { embedded = await readEmbeddedPdfOutline(located.relativePath); }
  catch (error) { embeddedError = error instanceof Error ? error.message : "The PDF's bookmarks could not be read."; }
  const generated = await readPdfOutlineFile(located.relativePath);
  let stale = false;
  if (generated?.source) {
    const current = await readPdfSourceSnapshot(located.relativePath).catch(() => null);
    stale = Boolean(current && (current.size !== generated.source.size || current.contentHash !== generated.source.contentHash));
  }
  return { path: located.relativePath, embedded, ...(embeddedError ? { embeddedError } : {}), generated, stale };
}
