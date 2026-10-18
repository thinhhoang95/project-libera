import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  assertImageFileName,
  assertPdfFileName,
} from "@/lib/storage/file-types";
import { copyFileIfExists, ensureParentDirectory, pathExists, writeJsonAtomically } from "@/lib/storage/fs-utils";
import {
  ensureAdminRoot,
  filePathFromParts,
  imageAnnotationsPath,
  legacyImageAnnotationsPath,
  legacyPdfAnnotationsPath,
  legacyFlatPdfAnnotationsPath,
  notebookPath,
  pdfAnnotationsDirectoryPath,
  pdfAnnotationsPath,
  relativeFilePath,
  splitFilePath,
} from "@/lib/storage/paths";
import { toStorageError } from "@/lib/storage/errors";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { normalizePdfHighlightQuote } from "@/lib/pdf-highlight-quote";
import type {
  ImageAnnotationsPayload,
  PdfAnnotation,
  PdfAnnotationPoint,
  PdfAnnotationRect,
  PdfAnnotationsPayload,
  PdfHighlightAnnotation,
  PdfInkAnnotation,
  PdfShapeAnnotation,
  PdfShapeKind,
  PdfTextAnnotation,
  PdfTextAnnotationFont,
} from "@/lib/types";

const PENDING_PDF_MIGRATIONS = Symbol.for("libera.pendingPdfAnnotationMigrations");
const migrationState = globalThis as { [PENDING_PDF_MIGRATIONS]?: Map<string, Promise<void>> };
const pendingMigrations = migrationState[PENDING_PDF_MIGRATIONS] ??= new Map<string, Promise<void>>();

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const PDF_TEXT_ANNOTATION_FONTS: readonly PdfTextAnnotationFont[] = ["sans", "serif", "hand", "mono"];
const PDF_MARKUP_STYLES: readonly NonNullable<PdfHighlightAnnotation["markup"]>[] = ["underline", "strikethrough", "squiggly"];
const PDF_SHAPE_KINDS: readonly PdfShapeKind[] = ["rectangle", "ellipse", "line", "arrow"];
const MAX_INK_POINTS = 5_000;

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function normalizeAnnotationRect(input: Partial<PdfAnnotationRect>): PdfAnnotationRect {
  const x = clampNumber(input.x, 0, 0.999, 0);
  const y = clampNumber(input.y, 0, 0.999, 0);
  const width = clampNumber(input.width, 0.001, 1 - x, 0.001);
  const height = clampNumber(input.height, 0.001, 1 - y, 0.001);

  return {
    x,
    y,
    width,
    height,
  };
}

function normalizeAnnotationPoint(input: unknown): PdfAnnotationPoint {
  const point = (input && typeof input === "object" ? input : {}) as Partial<PdfAnnotationPoint>;

  return { x: clampNumber(point.x, 0, 1, 0), y: clampNumber(point.y, 0, 1, 0) };
}

function inkColor(value: unknown) {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value) ? value : "#1d4ed8";
}

function normalizePdfAnnotations(input: unknown): PdfAnnotation[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const annotations: PdfAnnotation[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const candidate = item as Partial<PdfAnnotation>;
    const type = candidate.type;
    const id =
      typeof candidate.id === "string" && candidate.id.trim()
        ? candidate.id.slice(0, 120)
        : randomUUID();
    const pageNumber = Math.floor(clampNumber(candidate.pageNumber, 1, 10_000, 1));
    const createdAt =
      typeof candidate.createdAt === "string" && candidate.createdAt.trim()
        ? candidate.createdAt
        : new Date().toISOString();
    const updatedAt =
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : createdAt;

    if (type === "highlight") {
      const rects = Array.isArray(candidate.rects)
        ? candidate.rects
            .map((rect) => normalizeAnnotationRect(rect as Partial<PdfAnnotationRect>))
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .slice(0, 200)
        : [];

      if (rects.length) {
        annotations.push({
          id,
          type,
          pageNumber,
          color:
            typeof candidate.color === "string" && HEX_COLOR_PATTERN.test(candidate.color)
              ? candidate.color
              : "#fde047",
          rects,
          quote: typeof candidate.quote === "string"
            ? normalizePdfHighlightQuote(candidate.quote)
            : undefined,
          ...(PDF_MARKUP_STYLES.includes(candidate.markup as never)
            ? { markup: candidate.markup }
            : {}),
          createdAt,
          updatedAt,
        });
      }
    }

    if (type === "text") {
      annotations.push({
        id,
        type,
        pageNumber,
        text:
          typeof candidate.text === "string"
            ? candidate.text.slice(0, 10_000)
            : "",
        fontSize: Math.round(clampNumber(candidate.fontSize, 4, 72, 10)),
        ...(typeof candidate.color === "string" && HEX_COLOR_PATTERN.test(candidate.color)
          ? { color: candidate.color }
          : {}),
        ...(typeof candidate.fontFamily === "string" &&
        PDF_TEXT_ANNOTATION_FONTS.includes(candidate.fontFamily as PdfTextAnnotationFont)
          ? { fontFamily: candidate.fontFamily as PdfTextAnnotationFont }
          : {}),
        rect: normalizeAnnotationRect(
          (candidate as Partial<{ rect: Partial<PdfAnnotationRect> }>).rect ?? {},
        ),
        createdAt,
        updatedAt,
      });
    }

    if (type === "shape") {
      const shape = candidate as Partial<PdfShapeAnnotation>;

      if (PDF_SHAPE_KINDS.includes(shape.shape as PdfShapeKind)) {
        annotations.push({
          id,
          type,
          pageNumber,
          shape: shape.shape as PdfShapeKind,
          color: inkColor(shape.color),
          strokeWidth: clampNumber(shape.strokeWidth, 0.5, 24, 2),
          from: normalizeAnnotationPoint(shape.from),
          to: normalizeAnnotationPoint(shape.to),
          createdAt,
          updatedAt,
        });
      }
    }

    if (type === "ink") {
      const ink = candidate as Partial<PdfInkAnnotation>;
      const points = Array.isArray(ink.points)
        ? ink.points.slice(0, MAX_INK_POINTS).map(normalizeAnnotationPoint)
        : [];

      if (points.length) {
        annotations.push({
          id,
          type,
          pageNumber,
          color: inkColor(ink.color),
          strokeWidth: clampNumber(ink.strokeWidth, 0.5, 24, 2),
          points,
          createdAt,
          updatedAt,
        });
      }
    }
  }

  return annotations;
}

function normalizeImageAnnotations(input: unknown): PdfTextAnnotation[] {
  return normalizePdfAnnotations(input).filter(
    (annotation): annotation is PdfTextAnnotation => annotation.type === "text",
  );
}

/** Enumerate real PDFs without following symlinks or entering app/dependency state. */
async function pdfPaths(notebook: string, parts: string[] = []): Promise<string[][]> {
  const entries = await readdir(path.join(notebookPath(notebook), ...parts), { withFileTypes: true });
  const found: string[][] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ["node_modules", "__pycache__", "bower_components", "_assets"].includes(entry.name)) continue;
    const child = [...parts, entry.name];
    if (entry.isDirectory()) found.push(...await pdfPaths(notebook, child));
    else if (entry.isFile() && /\.pdf$/i.test(entry.name)) found.push(child);
  }
  return found;
}

/** Flat legacy notes have no owner path. Never guess when basenames collide. */
export async function migratePdfAnnotations(notebook: string, parts: string[]) {
  const key = pdfAnnotationsPath(notebook, parts);
  const pending = pendingMigrations.get(key);
  if (pending) return pending;
  const work = migrateLegacyPdfAnnotations(notebook, parts);
  pendingMigrations.set(key, work);
  try { await work; } finally { if (pendingMigrations.get(key) === work) pendingMigrations.delete(key); }
}

async function archiveLegacyAnnotations(target: string, reason: string) {
  try { await rename(target, `${target}.${reason}-${randomUUID()}`); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function migrateLegacyPdfAnnotations(notebook: string, parts: string[]) {
  const target = pdfAnnotationsPath(notebook, parts);
  const name = parts.at(-1)!;
  const legacy = [legacyFlatPdfAnnotationsPath(notebook, name), legacyPdfAnnotationsPath(notebook, name)];
  if (!(await pathExists(legacy[0])) && !(await pathExists(legacy[1]))) return;
  const matches = (await pdfPaths(notebook)).filter((file) => file.at(-1) === name);
  if (matches.length !== 1 || matches[0].join("/") !== parts.join("/")) {
    // Quarantine ambiguous notes so a later deletion cannot make their owner
    // appear unambiguous and attach them to an unrelated surviving PDF.
    for (const old of legacy) {
      if (await pathExists(old)) await archiveLegacyAnnotations(old, "ambiguous");
    }
    return;
  }
  const source = (await pathExists(legacy[0])) ? legacy[0] : legacy[1];
  await ensureParentDirectory(target);
  try { await copyFileIfExists(source, target, { exclusive: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Retain recovery copies, including older sidecars shadowed by a modern file.
  for (const old of legacy) {
    if (await pathExists(old)) await archiveLegacyAnnotations(old, "migrated");
  }
}

export async function migratePdfAnnotationDirectory(notebook: string, parts: string[]) {
  for (const file of await pdfPaths(notebook, parts)) await migratePdfAnnotations(notebook, file);
}

export async function deletePdfAnnotationDirectory(notebook: string, parts: string[]) {
  await rm(pdfAnnotationsDirectoryPath(notebook, parts), { force: true, recursive: true });
}

export async function readPdfAnnotations(
  relativePath: string,
): Promise<PdfAnnotationsPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertPdfFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  let annotationsPath = pdfAnnotationsPath(notebook, pathParts);
  try {
    await migratePdfAnnotations(notebook, pathParts);
  } catch (error) {
    if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    // A read-only library can still read uniquely owned old notes without
    // claiming that their migration or a write succeeded.
    if (!(await pathExists(annotationsPath))) {
      const matches = (await pdfPaths(notebook)).filter((file) => file.at(-1) === name);
      if (matches.length === 1 && matches[0].join("/") === pathParts.join("/")) {
        const flat = legacyFlatPdfAnnotationsPath(notebook, name);
        annotationsPath = await pathExists(flat) ? flat : legacyPdfAnnotationsPath(notebook, name);
      }
    }
  }

  try {
    const payload = JSON.parse(await readFile(annotationsPath, "utf8")) as {
      annotations?: unknown;
    };

    return {
      path: relativeFilePath(notebook, pathParts),
      annotations: normalizePdfAnnotations(payload.annotations),
    };
  } catch (error) {
    const storageError = toStorageError(error);

    if (storageError.status === 404) {
      return {
        path: relativeFilePath(notebook, pathParts),
        annotations: [],
      };
    }

    throw error;
  }
}

export async function writePdfAnnotations(
  relativePath: string,
  annotations: unknown,
): Promise<PdfAnnotationsPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertPdfFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  await migratePdfAnnotations(notebook, pathParts);
  const normalizedAnnotations = normalizePdfAnnotations(annotations);
  const annotationsPath = pdfAnnotationsPath(notebook, pathParts);

  await writeJsonAtomically(annotationsPath, { annotations: normalizedAnnotations });
  // Highlight quotes are Global Search passages of the PDF.
  notifySearchChanges([relativeFilePath(notebook, pathParts)]);

  return {
    path: relativeFilePath(notebook, pathParts),
    annotations: normalizedAnnotations,
  };
}

export async function readImageAnnotations(
  relativePath: string,
): Promise<ImageAnnotationsPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertImageFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  try {
    const payload = JSON.parse(
      await readFile(
        (await pathExists(imageAnnotationsPath(notebook, name)))
          ? imageAnnotationsPath(notebook, name)
          : legacyImageAnnotationsPath(notebook, name),
        "utf8",
      ),
    ) as {
      annotations?: unknown;
    };

    return {
      path: relativeFilePath(notebook, pathParts),
      annotations: normalizeImageAnnotations(payload.annotations),
    };
  } catch (error) {
    const storageError = toStorageError(error);

    if (storageError.status === 404) {
      return {
        path: relativeFilePath(notebook, pathParts),
        annotations: [],
      };
    }

    throw error;
  }
}

export async function writeImageAnnotations(
  relativePath: string,
  annotations: unknown,
): Promise<ImageAnnotationsPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertImageFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  const normalizedAnnotations = normalizeImageAnnotations(annotations);
  const annotationsPath = imageAnnotationsPath(notebook, name);

  await ensureParentDirectory(annotationsPath);
  await writeFile(
    annotationsPath,
    `${JSON.stringify({ annotations: normalizedAnnotations }, null, 2)}\n`,
    "utf8",
  );
  await rm(legacyImageAnnotationsPath(notebook, name), { force: true });

  return {
    path: relativeFilePath(notebook, pathParts),
    annotations: normalizedAnnotations,
  };
}
