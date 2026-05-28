import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertPdfFileName } from "@/lib/storage/file-types";
import {
  copyFileIfExists,
  ensureParentDirectory,
  moveFileIfExists,
  pathExists,
} from "@/lib/storage/fs-utils";
import {
  ensureAdminRoot,
  filePathFromParts,
  pdfTextCacheDirectoryPath,
  pdfTextCachePath,
  relativeFilePath,
  splitFilePath,
} from "@/lib/storage/paths";
import type { PdfTextCachePayload, PdfTextPage } from "@/lib/types";

const PDF_TEXT_CACHE_VERSION = 1;
const PDFJS_DIST_PATH = path.join(process.cwd(), "node_modules", "pdfjs-dist");
const PDF_WORKER_SRC = pathToFileURL(
  path.join(PDFJS_DIST_PATH, "legacy", "build", "pdf.worker.mjs"),
).toString();
const PDF_STANDARD_FONT_DATA_URL = pathToFileURL(
  `${path.join(PDFJS_DIST_PATH, "standard_fonts")}${path.sep}`,
).toString();

type StoredPdfTextCache = {
  version?: unknown;
  path?: unknown;
  pdfUpdatedAt?: unknown;
  pdfSize?: unknown;
  generatedAt?: unknown;
  pages?: unknown;
};

function normalizeWhitespace(text: string) {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageTextFromItems(items: unknown[]) {
  let text = "";

  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item)) {
      continue;
    }

    const textItem = item as { str?: unknown; hasEOL?: unknown };
    const value = typeof textItem.str === "string" ? textItem.str : "";

    if (!value) {
      continue;
    }

    if (text && !text.endsWith("\n") && !/^\s/.test(value)) {
      text += " ";
    }

    text += value;

    if (textItem.hasEOL) {
      text += "\n";
    }
  }

  return normalizeWhitespace(text);
}

function normalizePages(input: unknown): PdfTextPage[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((page): PdfTextPage | null => {
      if (!page || typeof page !== "object") {
        return null;
      }

      const candidate = page as Partial<PdfTextPage>;
      const pageNumber =
        typeof candidate.pageNumber === "number" && Number.isFinite(candidate.pageNumber)
          ? Math.floor(candidate.pageNumber)
          : 0;

      if (pageNumber < 1) {
        return null;
      }

      return {
        pageNumber,
        text: typeof candidate.text === "string" ? candidate.text : "",
      };
    })
    .filter((page): page is PdfTextPage => page !== null);
}

function normalizeStoredCache(
  input: StoredPdfTextCache,
  fallbackPath: string,
): PdfTextCachePayload {
  return {
    path: typeof input.path === "string" && input.path ? input.path : fallbackPath,
    pdfUpdatedAt:
      typeof input.pdfUpdatedAt === "string" && input.pdfUpdatedAt
        ? input.pdfUpdatedAt
        : "",
    pdfSize:
      typeof input.pdfSize === "number" && Number.isFinite(input.pdfSize)
        ? input.pdfSize
        : 0,
    generatedAt:
      typeof input.generatedAt === "string" && input.generatedAt
        ? input.generatedAt
        : "",
    pages: normalizePages(input.pages),
  };
}

function isFreshCache(
  cache: StoredPdfTextCache,
  relativePath: string,
  pdfUpdatedAt: string,
  pdfSize: number,
) {
  return (
    cache.version === PDF_TEXT_CACHE_VERSION &&
    cache.path === relativePath &&
    cache.pdfUpdatedAt === pdfUpdatedAt &&
    cache.pdfSize === pdfSize &&
    Array.isArray(cache.pages)
  );
}

async function extractPdfTextPages(targetPath: string): Promise<PdfTextPage[]> {
  const { GlobalWorkerOptions, VerbosityLevel, getDocument } = await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  );
  GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  const loadingTask = getDocument({
    data: new Uint8Array(await readFile(targetPath)),
    disableFontFace: true,
    standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
    verbosity: VerbosityLevel.ERRORS,
  });
  const document = await loadingTask.promise;

  try {
    const pages: PdfTextPage[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();

      pages.push({
        pageNumber,
        text: pageTextFromItems(textContent.items),
      });
    }

    return pages;
  } finally {
    await document.destroy();
  }
}

export async function readPdfTextCache(
  relativePath: string,
): Promise<PdfTextCachePayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertPdfFileName(name);

  const targetPath = filePathFromParts(notebook, pathParts);
  const stats = await stat(targetPath);
  const normalizedRelativePath = relativeFilePath(notebook, pathParts);
  const pdfUpdatedAt = stats.mtime.toISOString();
  const cachePath = pdfTextCachePath(notebook, pathParts);

  try {
    if (await pathExists(cachePath)) {
      const storedCache = JSON.parse(
        await readFile(cachePath, "utf8"),
      ) as StoredPdfTextCache;

      if (isFreshCache(storedCache, normalizedRelativePath, pdfUpdatedAt, stats.size)) {
        return normalizeStoredCache(storedCache, normalizedRelativePath);
      }
    }
  } catch {
    // Invalid or unreadable cache files are replaced below.
  }

  const payload: PdfTextCachePayload = {
    path: normalizedRelativePath,
    pdfUpdatedAt,
    pdfSize: stats.size,
    generatedAt: new Date().toISOString(),
    pages: await extractPdfTextPages(targetPath),
  };

  await ensureParentDirectory(cachePath);
  await writeFile(
    cachePath,
    `${JSON.stringify({ version: PDF_TEXT_CACHE_VERSION, ...payload }, null, 2)}\n`,
    "utf8",
  );

  return payload;
}

export async function ensurePdfTextCache(relativePath: string) {
  await readPdfTextCache(relativePath);
}

export async function deletePdfTextCache(notebook: string, pathParts: string[]) {
  await rm(pdfTextCachePath(notebook, pathParts), { force: true });
}

export async function deletePdfTextCacheDirectory(
  notebook: string,
  pathParts: string[],
) {
  await rm(pdfTextCacheDirectoryPath(notebook, pathParts), {
    force: true,
    recursive: true,
  });
}

export async function movePdfTextCache(
  currentNotebook: string,
  currentPathParts: string[],
  nextNotebook: string,
  nextPathParts: string[],
) {
  await moveFileIfExists(
    pdfTextCachePath(currentNotebook, currentPathParts),
    pdfTextCachePath(nextNotebook, nextPathParts),
  );
}

export async function movePdfTextCacheDirectory(
  notebook: string,
  currentPathParts: string[],
  nextPathParts: string[],
) {
  await moveFileIfExists(
    pdfTextCacheDirectoryPath(notebook, currentPathParts),
    pdfTextCacheDirectoryPath(notebook, nextPathParts),
  );
}

export async function copyPdfTextCache(
  currentNotebook: string,
  currentPathParts: string[],
  nextNotebook: string,
  nextPathParts: string[],
) {
  await copyFileIfExists(
    pdfTextCachePath(currentNotebook, currentPathParts),
    pdfTextCachePath(nextNotebook, nextPathParts),
  );
}
