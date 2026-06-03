import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  ADMIN_USER,
  ANNOTATIONS_DIR,
  IMAGE_ANNOTATIONS_SUFFIX,
  LIBERA_SYSTEM_DIR,
  MARKDOWN_ASSETS_DIR,
  NOTEBOOK_METADATA_FILE,
  PDF_ANNOTATIONS_SUFFIX,
  PDF_TEXT_CACHE_DIR,
  WORKSPACE_METADATA_FILE,
} from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";

function getDataRoot() {
  return path.resolve(process.env.LIBERA_DATA_DIR ?? "data/libera");
}

export function getAdminRoot() {
  return path.join(getDataRoot(), "users", ADMIN_USER);
}

export async function ensureAdminRoot() {
  await mkdir(getAdminRoot(), { recursive: true });
}

export function assertSafeSegment(segment: string, label: string) {
  const trimmed = segment.trim();

  if (!trimmed) {
    throw new StorageError(`${label} is required.`);
  }

  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new StorageError(`${label} contains unsupported characters.`);
  }

  return trimmed;
}

export function assertSafeUserSegment(segment: string, label: string) {
  const trimmed = assertSafeSegment(segment, label);

  if (
    trimmed.startsWith(".") ||
    trimmed.startsWith("._") ||
    trimmed === "__MACOSX" ||
    trimmed === MARKDOWN_ASSETS_DIR
  ) {
    throw new StorageError(`${label} is reserved.`);
  }

  return trimmed;
}

export function assertInsideAdminRoot(targetPath: string) {
  const relative = path.relative(getAdminRoot(), targetPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new StorageError("Path escapes the Libera data directory.");
  }
}

export function notebookPath(name: string) {
  const safeName = assertSafeSegment(name, "Notebook name");
  const targetPath = path.join(getAdminRoot(), safeName);
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function workspaceMetadataPath() {
  const targetPath = path.join(getAdminRoot(), WORKSPACE_METADATA_FILE);
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function itemPath(
  notebook: string,
  pathParts: string[],
  itemLabel = "Path segment",
) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safePathParts = pathParts.map((part) => assertSafeUserSegment(part, itemLabel));
  const targetPath = path.join(getAdminRoot(), safeNotebook, ...safePathParts);
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function filePath(notebook: string, name: string) {
  return itemPath(notebook, [name], "File name");
}

export function filePathFromParts(notebook: string, pathParts: string[]) {
  if (!pathParts.length) {
    throw new StorageError("File path is invalid.");
  }

  return itemPath(notebook, pathParts, "File path segment");
}

export function pdfAnnotationsPath(notebook: string, name: string) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safeName = assertSafeSegment(name, "File name");
  const targetPath = path.join(
    getAdminRoot(),
    safeNotebook,
    LIBERA_SYSTEM_DIR,
    ANNOTATIONS_DIR,
    "pdf",
    `${safeName}.json`,
  );
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function legacyPdfAnnotationsPath(notebook: string, name: string) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safeName = assertSafeSegment(name, "File name");
  const targetPath = path.join(
    getAdminRoot(),
    safeNotebook,
    `.${safeName}${PDF_ANNOTATIONS_SUFFIX}`,
  );
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function pdfTextCachePath(notebook: string, pathParts: string[]) {
  if (!pathParts.length) {
    throw new StorageError("PDF cache path is invalid.");
  }

  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safePathParts = pathParts.map((part) =>
    assertSafeUserSegment(part, "File path segment"),
  );
  const targetPath = path.join(
    getAdminRoot(),
    safeNotebook,
    LIBERA_SYSTEM_DIR,
    PDF_TEXT_CACHE_DIR,
    ...safePathParts.slice(0, -1),
    `${safePathParts.at(-1)}.json`,
  );
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function pdfTextCacheDirectoryPath(notebook: string, pathParts: string[]) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safePathParts = pathParts.map((part) =>
    assertSafeUserSegment(part, "Folder path segment"),
  );
  const targetPath = path.join(
    getAdminRoot(),
    safeNotebook,
    LIBERA_SYSTEM_DIR,
    PDF_TEXT_CACHE_DIR,
    ...safePathParts,
  );
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function imageAnnotationsPath(notebook: string, name: string) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safeName = assertSafeSegment(name, "File name");
  const targetPath = path.join(
    getAdminRoot(),
    safeNotebook,
    LIBERA_SYSTEM_DIR,
    ANNOTATIONS_DIR,
    "image",
    `${safeName}.json`,
  );
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function legacyImageAnnotationsPath(notebook: string, name: string) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safeName = assertSafeSegment(name, "File name");
  const targetPath = path.join(
    getAdminRoot(),
    safeNotebook,
    `.${safeName}${IMAGE_ANNOTATIONS_SUFFIX}`,
  );
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function markdownAssetsDirectoryName(markdownName: string) {
  const stem = path.basename(markdownName, path.extname(markdownName));
  return markdownAssetSafeSegment(stem, "note");
}

function markdownAssetSafeSegment(segment: string, fallback = "asset") {
  const normalized = segment
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

export function markdownAssetsDirectoryPathFromParts(
  notebook: string,
  markdownPathParts: string[],
) {
  if (!markdownPathParts.length) {
    throw new StorageError("Markdown asset path is invalid.");
  }

  const folderParts = markdownPathParts
    .slice(0, -1)
    .map((part) => markdownAssetSafeSegment(part));
  const targetPath = path.join(
    notebookPath(notebook),
    MARKDOWN_ASSETS_DIR,
    ...folderParts,
    markdownAssetsDirectoryName(markdownPathParts.at(-1) ?? ""),
  );
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function markdownAssetsDirectoryPathForDirectory(
  notebook: string,
  pathParts: string[],
) {
  const targetPath = path.join(
    notebookPath(notebook),
    MARKDOWN_ASSETS_DIR,
    ...pathParts.map((part) => markdownAssetSafeSegment(part)),
  );
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function markdownAssetsPathPrefix(markdownPathParts: string[]) {
  if (!markdownPathParts.length) {
    throw new StorageError("Markdown asset path is invalid.");
  }

  return [
    MARKDOWN_ASSETS_DIR,
    ...markdownPathParts.slice(0, -1).map((part) => markdownAssetSafeSegment(part)),
    markdownAssetsDirectoryName(markdownPathParts.at(-1) ?? ""),
  ].join("/");
}

export function markdownAssetsDirectoryPath(notebook: string, markdownName: string) {
  const targetPath = path.join(
    notebookPath(notebook),
    MARKDOWN_ASSETS_DIR,
    markdownAssetsDirectoryName(markdownName),
  );
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function notebookMetadataPath(name: string) {
  const targetPath = path.join(notebookPath(name), NOTEBOOK_METADATA_FILE);
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

export function splitStoragePath(relativePath: string) {
  if (!relativePath || relativePath.includes("\\") || relativePath.includes("\0")) {
    throw new StorageError("Path is invalid.");
  }

  const parts = relativePath.split("/").filter(Boolean);

  if (parts.length < 1) {
    throw new StorageError("Path must include a notebook.");
  }

  const [notebook, ...pathParts] = parts;

  return {
    notebook: assertSafeSegment(notebook, "Notebook name"),
    pathParts: pathParts.map((part) => assertSafeUserSegment(part, "Path segment")),
  };
}

export function splitFilePath(relativePath: string) {
  const parsed = splitStoragePath(relativePath);

  if (!parsed.pathParts.length) {
    throw new StorageError("File path must be in notebook/file format.");
  }

  return {
    ...parsed,
    name: parsed.pathParts.at(-1) ?? "",
  };
}

export function splitDirectoryPath(relativePath: string) {
  return splitStoragePath(relativePath);
}

export function relativeItemPath(notebook: string, pathParts: string[]) {
  return [notebook, ...pathParts].join("/");
}

export function relativeFilePath(notebook: string, nameOrPathParts: string | string[]) {
  return relativeItemPath(
    notebook,
    Array.isArray(nameOrPathParts) ? nameOrPathParts : [nameOrPathParts],
  );
}

export function rawFileUrl(relativePath: string) {
  return `/api/files/raw/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

export function normalizeMarkdownAssetPath(assetPath: string) {
  let normalized = assetPath.trim().replace(/^\.\/+/, "");

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original string if it is not URI-encoded.
  }

  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    path.isAbsolute(normalized)
  ) {
    throw new StorageError("Markdown asset path is invalid.");
  }

  const parts = normalized.split("/");

  if (
    parts.length < 3 ||
    parts[0] !== MARKDOWN_ASSETS_DIR ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new StorageError("Markdown asset path is invalid.");
  }

  return parts.join("/");
}

export function markdownAssetPath(notebook: string, assetPath: string) {
  const normalized = normalizeMarkdownAssetPath(assetPath);
  const targetPath = path.join(notebookPath(notebook), normalized);
  assertInsideAdminRoot(targetPath);
  return {
    normalized,
    targetPath,
  };
}
