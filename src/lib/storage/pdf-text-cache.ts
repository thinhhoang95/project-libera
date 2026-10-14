import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertPdfFileName } from "@/lib/storage/file-types";
import { readFileSignature } from "@/lib/storage/file-signature";
import {
  copyFileIfExists,
  moveFileIfExists,
  writeJsonAtomically,
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

const PDF_TEXT_CACHE_VERSION = 3;
const PENDING_PDF_READS = Symbol.for("libera.pendingPdfTextReads");
const pdfReadState = globalThis as { [PENDING_PDF_READS]?: Map<string, Promise<PdfTextCachePayload>> };
const pendingReads = pdfReadState[PENDING_PDF_READS] ??= new Map<string, Promise<PdfTextCachePayload>>();
// Resolve from the running server bundle so this also works in standalone builds.
// Webpack replaces createRequire(import.meta.url) with undefined and rewrites
// direct require.resolve calls to bundle IDs instead of filesystem paths.
const nodeRequire = eval("require") as NodeRequire;
const PDFJS_DIST_PATH = path.dirname(nodeRequire.resolve("pdfjs-dist/package.json"));
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
  pdfSignature?: unknown;
  pdfContentHash?: unknown;
  pageCount?: unknown;
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

export function pageTextFromItems(items: unknown[]) {
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

function validPages(input: unknown): input is PdfTextPage[] {
  return Array.isArray(input) && input.length > 0 && input.every((page, index) =>
    page && typeof page === "object" && page.pageNumber === index + 1 && typeof page.text === "string",
  );
}

type PdfIdentity = { signature: string; hash: string; updatedAt: string; size: number };

async function pdfIdentity(targetPath: string): Promise<PdfIdentity> {
  const signature = await readFileSignature(targetPath);
  const stats = await stat(targetPath);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(targetPath)) hash.update(bytes);
  await assertUnchanged(targetPath, signature);
  return { signature, hash: hash.digest("hex"), updatedAt: stats.mtime.toISOString(), size: stats.size };
}

async function assertUnchanged(targetPath: string, signature: string) {
  if (await readFileSignature(targetPath) !== signature) {
    throw new Error("The PDF changed while being read. Try again.");
  }
}

function isFreshCache(cache: StoredPdfTextCache, relativePath: string, identity: PdfIdentity) {
  if (!cache || !validPages(cache.pages)) return false;
  if (cache.version === PDF_TEXT_CACHE_VERSION) {
    return cache.pdfContentHash === identity.hash && cache.pdfSize === identity.size && cache.pageCount === cache.pages.length;
  }
  // Old caches have no portable content identity. Upgrade only when their
  // original local file signature still proves which bytes were extracted.
  return cache.version === 2 && cache.path === relativePath && cache.pdfUpdatedAt === identity.updatedAt &&
    cache.pdfSize === identity.size && cache.pdfSignature === identity.signature;
}

function cachePayload(cache: StoredPdfTextCache, relativePath: string, identity: PdfIdentity): PdfTextCachePayload {
  return {
    path: relativePath,
    pdfUpdatedAt: identity.updatedAt,
    pdfSize: identity.size,
    generatedAt: typeof cache.generatedAt === "string" ? cache.generatedAt : "",
    pages: cache.pages as PdfTextPage[],
  };
}

async function storedCache(cachePath: string): Promise<StoredPdfTextCache | null> {
  try { return JSON.parse(await readFile(cachePath, "utf8")); } catch { return null; }
}

async function persistCache(cachePath: string, payload: PdfTextCachePayload, identity: PdfIdentity, targetPath: string) {
  const stored = { version: PDF_TEXT_CACHE_VERSION, pdfContentHash: identity.hash, pageCount: payload.pages.length, ...payload };
  try {
    await writeJsonAtomically(cachePath, stored, () => assertUnchanged(targetPath, identity.signature));
  } catch {
    // A cache is optional. The PDF's identity is still checked below, so a
    // storage failure cannot turn a changed/deleted PDF into a successful read.
  }
  try {
    await assertUnchanged(targetPath, identity.signature);
  } catch (error) {
    // A delete/move can race publication. Only remove the cache we published.
    const current = await storedCache(cachePath);
    if (current?.pdfContentHash === identity.hash && current?.generatedAt === payload.generatedAt) {
      await rm(cachePath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
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

/** Read fresh cached pages without starting extraction. Portable caches are verified against all PDF bytes. */
export async function readFreshPdfTextCache(relativePath: string): Promise<PdfTextCachePayload | null> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertPdfFileName(name);
  const targetPath = filePathFromParts(notebook, pathParts);
  const identity = await pdfIdentity(targetPath);
  const normalizedPath = relativeFilePath(notebook, pathParts);
  const cache = await storedCache(pdfTextCachePath(notebook, pathParts));
  if (!cache || !isFreshCache(cache, normalizedPath, identity)) return null;
  await assertUnchanged(targetPath, identity.signature);
  return cachePayload(cache, normalizedPath, identity);
}

/** Read/extract once per file, sharing work between Search, Deep Search and chat. */
export async function readPdfTextCache(
  relativePath: string,
  { extractPages = extractPdfTextPages }: { extractPages?: (absolutePath: string) => Promise<PdfTextPage[]> } = {},
): Promise<PdfTextCachePayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertPdfFileName(name);
  const targetPath = filePathFromParts(notebook, pathParts);
  const normalizedPath = relativeFilePath(notebook, pathParts);
  const cachePath = pdfTextCachePath(notebook, pathParts);
  const signature = await readFileSignature(targetPath);
  const key = JSON.stringify([targetPath, cachePath, signature]);
  const pending = pendingReads.get(key);
  if (pending) return { ...await pending, path: normalizedPath };

  const work = (async () => {
    const identity = await pdfIdentity(targetPath);
    if (identity.signature !== signature) throw new Error("The PDF changed while being read. Try again.");
    const cache = await storedCache(cachePath);
    if (cache && isFreshCache(cache, normalizedPath, identity)) {
      const payload = cachePayload(cache, normalizedPath, identity);
      if (cache.version !== PDF_TEXT_CACHE_VERSION) await persistCache(cachePath, payload, identity, targetPath);
      await assertUnchanged(targetPath, signature);
      return payload;
    }
    const pages = await extractPages(targetPath);
    if (!validPages(pages)) throw new Error("PDF extraction returned incomplete or invalid pages.");
    await assertUnchanged(targetPath, signature);
    const payload: PdfTextCachePayload = {
      path: normalizedPath, pdfUpdatedAt: identity.updatedAt, pdfSize: identity.size,
      generatedAt: new Date().toISOString(), pages,
    };
    await persistCache(cachePath, payload, identity, targetPath);
    return payload;
  })();
  pendingReads.set(key, work);
  try { return await work; } finally { if (pendingReads.get(key) === work) pendingReads.delete(key); }
}

/** Remove caches for externally deleted PDFs; unreadable/offline files are retained. */
export async function prunePdfTextCaches(notebook: string, pathParts: string[] = []) {
  const directory = pdfTextCacheDirectoryPath(notebook, pathParts);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      await prunePdfTextCaches(notebook, [...pathParts, entry.name]);
    } else if (entry.isFile() && /\.pdf\.json$/i.test(entry.name)) {
      const parts = [...pathParts, entry.name.slice(0, -5)];
      try { await stat(filePathFromParts(notebook, parts)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await rm(path.join(directory, entry.name), { force: true }).catch(() => undefined);
        }
      }
    }
  }
}

export async function ensurePdfTextCache(relativePath: string) {
  await readPdfTextCache(relativePath);
}

export async function deletePdfTextCache(notebook: string, pathParts: string[]) {
  await rm(pdfTextCachePath(notebook, pathParts), { force: true }).catch(() => undefined);
}

export async function deletePdfTextCacheDirectory(
  notebook: string,
  pathParts: string[],
) {
  await rm(pdfTextCacheDirectoryPath(notebook, pathParts), {
    force: true,
    recursive: true,
  }).catch(() => undefined);
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
  ).catch(() => undefined);
}

export async function movePdfTextCacheDirectory(
  notebook: string,
  currentPathParts: string[],
  nextPathParts: string[],
) {
  await moveFileIfExists(
    pdfTextCacheDirectoryPath(notebook, currentPathParts),
    pdfTextCacheDirectoryPath(notebook, nextPathParts),
  ).catch(() => undefined);
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
  ).catch(() => undefined);
}
