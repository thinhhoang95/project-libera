import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  assertImageFileName,
  assertPdfFileName,
} from "@/lib/storage/file-types";
import { ensureParentDirectory, pathExists } from "@/lib/storage/fs-utils";
import {
  ensureAdminRoot,
  filePathFromParts,
  imageAnnotationsPath,
  legacyImageAnnotationsPath,
  legacyPdfAnnotationsPath,
  pdfAnnotationsPath,
  relativeFilePath,
  splitFilePath,
} from "@/lib/storage/paths";
import { toStorageError } from "@/lib/storage/errors";
import type {
  ImageAnnotationsPayload,
  PdfAnnotation,
  PdfAnnotationRect,
  PdfAnnotationsPayload,
  PdfTextAnnotation,
} from "@/lib/types";

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
            typeof candidate.color === "string" && /^#[0-9a-f]{6}$/i.test(candidate.color)
              ? candidate.color
              : "#fde047",
          rects,
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
        fontSize: Math.round(clampNumber(candidate.fontSize, 4, 72, 8)),
        rect: normalizeAnnotationRect(
          (candidate as Partial<{ rect: Partial<PdfAnnotationRect> }>).rect ?? {},
        ),
        createdAt,
        updatedAt,
      });
    }
  }

  return annotations;
}

function normalizeImageAnnotations(input: unknown): PdfTextAnnotation[] {
  return normalizePdfAnnotations(input).filter(
    (annotation): annotation is PdfTextAnnotation => annotation.type === "text",
  );
}

export async function readPdfAnnotations(
  relativePath: string,
): Promise<PdfAnnotationsPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertPdfFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  try {
    const annotationsPath = (await pathExists(pdfAnnotationsPath(notebook, name)))
      ? pdfAnnotationsPath(notebook, name)
      : legacyPdfAnnotationsPath(notebook, name);
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

  const normalizedAnnotations = normalizePdfAnnotations(annotations);
  const annotationsPath = pdfAnnotationsPath(notebook, name);

  await ensureParentDirectory(annotationsPath);
  await writeFile(
    annotationsPath,
    `${JSON.stringify({ annotations: normalizedAnnotations }, null, 2)}\n`,
    "utf8",
  );
  await rm(legacyPdfAnnotationsPath(notebook, name), { force: true });

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
