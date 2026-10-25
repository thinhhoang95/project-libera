import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertImageFileName,
  assertPdfFileName,
  getFileType,
} from "@/lib/storage/file-types";
import { copyFileIfExists, ensureParentDirectory, pathExists, writeJsonForSource } from "@/lib/storage/fs-utils";
import { readFileSignature } from "@/lib/storage/file-signature";
import { cachedPdfIdentity, parsePdfIdentity } from "@/lib/storage/pdf-identity";
import {
  ensureAdminRoot,
  filePathFromParts,
  getStateRoot,
  imageAnnotationsPath,
  imageAnnotationsDirectoryPath,
  legacyFlatImageAnnotationsPath,
  legacyImageAnnotationsPath,
  legacyPdfAnnotationsPath,
  legacyFlatPdfAnnotationsPath,
  notebookPath,
  pdfAnnotationsDirectoryPath,
  pdfAnnotationsPath,
  relativeFilePath,
  splitFilePath,
} from "@/lib/storage/paths";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { normalizePdfHighlightQuote } from "@/lib/pdf-highlight-quote";
import { normalizePdfCommentThreads } from "@/lib/pdf-comments";
import { normalizeSpaceLayout, reconcilePdfSpaces } from "@/lib/pdf-space";
import type {
  ImageAnnotationsPayload,
  PdfAnnotation,
  PdfAnnotationPoint,
  PdfAnnotationRect,
  PdfAnnotationsPayload,
  PdfCommentThread,
  PdfCommentsPayload,
  PdfHighlightAnnotation,
  PdfInkAnnotation,
  PdfShapeAnnotation,
  PdfShapeKind,
  PdfSpaceAnnotation,
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

/** The space a note or drawing sits in; orphaned references are dropped after all are read. */
function spaceReference(value: unknown): { space?: string } {
  return typeof value === "string" && value.trim() ? { space: value.slice(0, 120) } : {};
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
        ...spaceReference((candidate as Partial<PdfTextAnnotation>).space),
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
          ...spaceReference(shape.space),
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
          ...spaceReference(ink.space),
          createdAt,
          updatedAt,
        });
      }
    }

    if (type === "space") {
      const space = candidate as Partial<PdfSpaceAnnotation>;
      const layout = normalizeSpaceLayout(space);

      if (layout) {
        annotations.push({
          id,
          type,
          pageNumber,
          ...layout,
          ...(typeof space.fill === "string" && HEX_COLOR_PATTERN.test(space.fill) ? { fill: space.fill } : {}),
          createdAt,
          updatedAt,
        });
      }
    }
  }

  return reconcilePdfSpaces(annotations);
}

// Every field normalizePdfAnnotations reads, by type. Keep in step with it.
const PDF_ANNOTATION_COMMON_FIELDS = ["id", "type", "pageNumber", "createdAt", "updatedAt"];
const PDF_ANNOTATION_FIELDS: Record<PdfAnnotation["type"], readonly string[]> = {
  highlight: ["color", "rects", "quote", "markup"],
  text: ["text", "fontSize", "color", "fontFamily", "rect", "space"],
  shape: ["shape", "color", "strokeWidth", "from", "to", "space"],
  ink: ["color", "strokeWidth", "points", "space"],
  space: ["y", "height", "band", "column", "fill"],
};
const MAX_PRESERVED_ANNOTATIONS = 1_000;
const MAX_PRESERVED_JSON_LENGTH = 256 * 1024;

function isKnownPdfAnnotationType(type: unknown): type is PdfAnnotation["type"] {
  return typeof type === "string" && Object.hasOwn(PDF_ANNOTATION_FIELDS, type);
}

function fitsPreservedJson(value: unknown) {
  try {
    return (JSON.stringify(value) ?? "").length <= MAX_PRESERVED_JSON_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Keeps what a newer Libera stored and this build cannot read: annotations of
 * unknown types, and unknown fields of annotations it does know. The viewer
 * never receives them, so saving its list must not delete them.
 */
function withPreservedUnknowns(stored: unknown, annotations: PdfAnnotation[]): unknown[] {
  const result: unknown[] = [...annotations];
  if (!Array.isArray(stored)) return result;
  const indexById = new Map(annotations.map((annotation, index) => [annotation.id, index]));
  const ids = new Set(indexById.keys());
  let preserved = 0;

  for (const item of stored) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string") continue;

    if (isKnownPdfAnnotationType(entry.type)) {
      const index = indexById.get(entry.id);
      if (index === undefined || annotations[index].type !== entry.type) continue;
      const known = PDF_ANNOTATION_FIELDS[entry.type];
      const extras = Object.entries(entry).filter(([key, value]) =>
        key !== "__proto__" &&
        !PDF_ANNOTATION_COMMON_FIELDS.includes(key) &&
        !known.includes(key) &&
        fitsPreservedJson(value));
      if (extras.length) result[index] = { ...annotations[index], ...Object.fromEntries(extras) };
    } else if (
      typeof entry.type === "string" &&
      preserved < MAX_PRESERVED_ANNOTATIONS &&
      !ids.has(entry.id) &&
      fitsPreservedJson(entry)
    ) {
      result.push(entry);
      ids.add(entry.id);
      preserved++;
    }
  }

  return result;
}

function normalizeImageAnnotations(input: unknown): PdfTextAnnotation[] {
  // Images have no spaces, so every note sits on the image itself.
  return normalizePdfAnnotations(input).flatMap((annotation) => {
    if (annotation.type !== "text") return [];
    const note = { ...annotation };
    delete note.space;
    return [note];
  });
}

/** Enumerate annotated files without following symlinks or entering app/dependency state. */
async function annotationFilePaths(notebook: string, parts: string[] = [], kind: "pdf" | "image" = "pdf"): Promise<string[][]> {
  const entries = await readdir(path.join(notebookPath(notebook), ...parts), { withFileTypes: true });
  const found: string[][] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ["node_modules", "__pycache__", "bower_components", "_assets"].includes(entry.name)) continue;
    const child = [...parts, entry.name];
    if (entry.isDirectory()) found.push(...await annotationFilePaths(notebook, child, kind));
    else if (entry.isFile() && getFileType(entry.name) === kind) found.push(child);
  }
  return found;
}

/** Flat legacy notes have no owner path. Never guess when basenames collide. */
export async function migratePdfAnnotations(notebook: string, parts: string[]) {
  const key = pdfAnnotationsPath(notebook, parts);
  const pending = pendingMigrations.get(key);
  if (pending) return pending;
  const work = migrateLegacyAnnotations(notebook, parts, "pdf");
  pendingMigrations.set(key, work);
  try { await work; } finally { if (pendingMigrations.get(key) === work) pendingMigrations.delete(key); }
}

async function archiveLegacyAnnotations(target: string, reason: string) {
  try { await rename(target, `${target}.${reason}-${randomUUID()}`); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function migrateLegacyAnnotations(notebook: string, parts: string[], kind: "pdf" | "image") {
  const target = kind === "pdf" ? pdfAnnotationsPath(notebook, parts) : imageAnnotationsPath(notebook, parts);
  const name = parts.at(-1)!;
  const legacy = kind === "pdf"
    ? [legacyFlatPdfAnnotationsPath(notebook, name), legacyPdfAnnotationsPath(notebook, name)]
    : [legacyFlatImageAnnotationsPath(notebook, name), legacyImageAnnotationsPath(notebook, name)];
  if (!(await pathExists(legacy[0])) && !(await pathExists(legacy[1]))) return;
  const matches = (await annotationFilePaths(notebook, [], kind)).filter((file) => file.at(-1)?.toLowerCase() === name.toLowerCase());
  if (matches.length !== 1 || matches[0].join("/") !== parts.join("/")) {
    // Quarantine ambiguous notes so a later deletion cannot make their owner
    // appear unambiguous and attach them to an unrelated surviving file.
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
  for (const file of await annotationFilePaths(notebook, parts)) await migratePdfAnnotations(notebook, file);
}

export async function migrateImageAnnotations(notebook: string, parts: string[]) {
  const key = imageAnnotationsPath(notebook, parts);
  const pending = pendingMigrations.get(key);
  if (pending) return pending;
  const work = migrateLegacyAnnotations(notebook, parts, "image");
  pendingMigrations.set(key, work);
  try { await work; } finally { if (pendingMigrations.get(key) === work) pendingMigrations.delete(key); }
}

export async function migrateImageAnnotationDirectory(notebook: string, parts: string[]) {
  for (const file of await annotationFilePaths(notebook, parts, "image")) await migrateImageAnnotations(notebook, file);
}

export async function deleteImageAnnotationDirectory(notebook: string, parts: string[]) {
  await rm(imageAnnotationsDirectoryPath(notebook, parts), { force: true, recursive: true });
}

export async function deletePdfAnnotationDirectory(notebook: string, parts: string[]) {
  await rm(pdfAnnotationsDirectoryPath(notebook, parts), { force: true, recursive: true });
}

/** Where a PDF's sidecar is read from: a read-only library can still read uniquely owned old notes. */
async function pdfSidecarForRead(notebook: string, name: string, pathParts: string[]) {
  const annotationsPath = pdfAnnotationsPath(notebook, pathParts);
  try {
    await migratePdfAnnotations(notebook, pathParts);
  } catch (error) {
    if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    // Without claiming that their migration or a write succeeded.
    if (!(await pathExists(annotationsPath))) {
      const matches = (await annotationFilePaths(notebook)).filter((file) => file.at(-1)?.toLowerCase() === name.toLowerCase());
      if (matches.length === 1 && matches[0].join("/") === pathParts.join("/")) {
        const flat = legacyFlatPdfAnnotationsPath(notebook, name);
        return await pathExists(flat) ? flat : legacyPdfAnnotationsPath(notebook, name);
      }
    }
  }
  return annotationsPath;
}

type PdfSidecar = { annotations?: unknown; comments?: unknown; source?: unknown };

/** The sidecar's JSON, or an empty one when the PDF has none yet. */
async function readPdfSidecar(annotationsPath: string): Promise<PdfSidecar> {
  try {
    const payload = JSON.parse(await readFile(annotationsPath, "utf8")) as PdfSidecar;
    return payload && typeof payload === "object" ? payload : {};
  } catch (error) {
    if (toStorageError(error).status === 404) return {};
    throw error;
  }
}

const PDF_SIDECAR_LOCKS = Symbol.for("libera.pdfSidecarLocks");
const lockState = globalThis as { [PDF_SIDECAR_LOCKS]?: Map<string, Promise<unknown>> };
const sidecarLocks = lockState[PDF_SIDECAR_LOCKS] ??= new Map<string, Promise<unknown>>();

/**
 * The sidecar holds a PDF's markup and its comment threads, written by
 * different hands (the viewer saves whole markup lists; comments change one
 * thread at a time, also from the agent). Each write reads the sidecar and
 * keeps the other half, one writer at a time: queued in this process, and an
 * OS lock file across Next workers. The lock lives in the library's state
 * folder, not beside the sidecar, so a folder move never carries a held lock.
 */
async function withPdfSidecar<T>(annotationsPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = sidecarLocks.get(annotationsPath) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => withSidecarFileLock(annotationsPath, fn));
  sidecarLocks.set(annotationsPath, task);
  try { return await task; } finally { if (sidecarLocks.get(annotationsPath) === task) sidecarLocks.delete(annotationsPath); }
}

async function withSidecarFileLock<T>(annotationsPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(getStateRoot(), ".libera", "locks", `pdf-sidecar-${createHash("sha256").update(annotationsPath).digest("hex").slice(0, 32)}.lock`);
  await mkdir(path.dirname(lockPath), { recursive: true });
  let lock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lock = await open(lockPath, "wx", 0o600); await lock.writeFile(String(process.pid)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Recover a lock left by a dead worker. Never steal from a live owner.
      try {
        const owner = Number(await readFile(lockPath, "utf8"));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") await rm(lockPath, { force: true }); }
        } else if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await rm(lockPath, { force: true });
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      await delay(50);
    }
  }
  if (!lock) throw new StorageError("The PDF's notes are busy. Retry; if the app crashed, restart it.", 409);
  try { return await fn(); } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

/** Rewrites one half of a PDF's sidecar, keeping the other as it is on disk. */
async function updatePdfSidecar<T>(relativePath: string, change: (sidecar: PdfSidecar) => { sidecar: PdfSidecar; result: T }): Promise<T> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertPdfFileName(name);
  const sourcePath = filePathFromParts(notebook, pathParts);
  const signature = await readFileSignature(sourcePath);

  await migratePdfAnnotations(notebook, pathParts);
  const annotationsPath = pdfAnnotationsPath(notebook, pathParts);
  return withPdfSidecar(annotationsPath, async () => {
    const { sidecar, result } = change(await readPdfSidecar(annotationsPath));
    const comments = Array.isArray(sidecar.comments) && sidecar.comments.length ? { comments: sidecar.comments } : {};
    // The PDF's bytes, so the notes can find it again after a rename outside Libera (pdf-sidecars.ts).
    const source = await cachedPdfIdentity(sourcePath).catch(() => parsePdfIdentity(sidecar.source));
    await writeJsonForSource(annotationsPath, { annotations: Array.isArray(sidecar.annotations) ? sidecar.annotations : [], ...comments, ...(source ? { source } : {}) }, sourcePath, signature);
    return result;
  });
}

/** Records the PDF's identity in an existing side-car written before side-cars kept it. */
export async function recordPdfAnnotationsSource(relativePath: string) {
  await updatePdfSidecar(relativePath, (sidecar) => ({ sidecar, result: undefined }));
}

export async function readPdfAnnotations(
  relativePath: string,
): Promise<PdfAnnotationsPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertPdfFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  const sidecar = await readPdfSidecar(await pdfSidecarForRead(notebook, name, pathParts));
  return {
    path: relativeFilePath(notebook, pathParts),
    annotations: normalizePdfAnnotations(sidecar.annotations),
  };
}

export async function writePdfAnnotations(
  relativePath: string,
  annotations: unknown,
): Promise<PdfAnnotationsPayload> {
  const { notebook, pathParts } = splitFilePath(relativePath);
  const normalizedAnnotations = normalizePdfAnnotations(annotations);
  await updatePdfSidecar(relativePath, (sidecar) => ({
    sidecar: { ...sidecar, annotations: withPreservedUnknowns(sidecar.annotations, normalizedAnnotations) },
    result: undefined,
  }));
  // Highlight quotes are Global Search passages of the PDF.
  notifySearchChanges([relativeFilePath(notebook, pathParts)]);

  return {
    path: relativeFilePath(notebook, pathParts),
    annotations: normalizedAnnotations,
  };
}

/** A PDF's review comment threads, in the order they were added. */
export async function readPdfCommentThreads(relativePath: string): Promise<PdfCommentsPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertPdfFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  const sidecar = await readPdfSidecar(await pdfSidecarForRead(notebook, name, pathParts));
  return { path: relativeFilePath(notebook, pathParts), threads: normalizePdfCommentThreads(sidecar.comments, randomUUID) };
}

/**
 * Changes a PDF's comment threads under the sidecar lock. `change` gets the
 * threads on disk and returns the new list (it may throw to change nothing).
 */
export async function updatePdfCommentThreads<T>(
  relativePath: string,
  change: (threads: PdfCommentThread[]) => { threads: PdfCommentThread[]; result: T },
): Promise<{ payload: PdfCommentsPayload; result: T }> {
  const { notebook, pathParts } = splitFilePath(relativePath);
  return updatePdfSidecar(relativePath, (sidecar) => {
    const { threads, result } = change(normalizePdfCommentThreads(sidecar.comments, randomUUID));
    return { sidecar: { ...sidecar, comments: threads }, result: { payload: { path: relativeFilePath(notebook, pathParts), threads }, result } };
  });
}

export async function readImageAnnotations(
  relativePath: string,
): Promise<ImageAnnotationsPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertImageFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  let annotationsPath = imageAnnotationsPath(notebook, pathParts);
  try { await migrateImageAnnotations(notebook, pathParts); }
  catch (error) {
    if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    if (!(await pathExists(annotationsPath))) {
      const matches = (await annotationFilePaths(notebook, [], "image")).filter((file) => file.at(-1)?.toLowerCase() === name.toLowerCase());
      if (matches.length === 1 && matches[0].join("/") === pathParts.join("/")) {
        const flat = legacyFlatImageAnnotationsPath(notebook, name);
        annotationsPath = await pathExists(flat) ? flat : legacyImageAnnotationsPath(notebook, name);
      }
    }
  }

  try {
    const payload = JSON.parse(
      await readFile(annotationsPath, "utf8"),
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
  const sourcePath = filePathFromParts(notebook, pathParts);
  const signature = await readFileSignature(sourcePath);

  await migrateImageAnnotations(notebook, pathParts);
  const normalizedAnnotations = normalizeImageAnnotations(annotations);
  const annotationsPath = imageAnnotationsPath(notebook, pathParts);

  await writeJsonForSource(annotationsPath, { annotations: normalizedAnnotations }, sourcePath, signature);

  return {
    path: relativeFilePath(notebook, pathParts),
    annotations: normalizedAnnotations,
  };
}
