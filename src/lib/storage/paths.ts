import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  directoryModeStatePath,
  directoryStateRoot,
  readDirectoryModeState,
} from "../../../electron/directory-mode.cjs";
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
  const configuredDataRoot = process.env.LIBERA_DATA_DIR;

  if (!configuredDataRoot) {
    return path.join(process.cwd(), "data", "libera");
  }

  return path.isAbsolute(configuredDataRoot)
    ? configuredDataRoot
    : path.join(/*turbopackIgnore: true*/ process.cwd(), configuredDataRoot);
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
  assertInsideRoot(getAdminRoot(), targetPath);
}

function assertInsideRoot(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new StorageError("Path escapes the Libera data directory.");
  }
}

/** An external folder opened in Directory mode. It replaces the notebook library. */
export type MountedDirectory = {
  /** The single notebook name that addresses the folder, e.g. `name/notes.md`. */
  name: string;
  path: string;
  /** App-owned state for this folder, kept in the data directory. */
  stateRoot: string;
};

type MountedDirectoryCache = { key: string; mounted: MountedDirectory | null };
const MOUNTED_DIRECTORY_CACHE = Symbol.for("libera.mountedDirectory");

export function mountedDirectoryName(directoryPath: string) {
  return path.basename(directoryPath).trim() || "Folder";
}

/**
 * Read the open folder. The state file can be written by another server
 * worker, so cache only while its identity on disk is unchanged.
 */
export function getMountedDirectory(): MountedDirectory | null {
  const adminRoot = getAdminRoot();
  const statePath = directoryModeStatePath(adminRoot);
  let key = `${statePath}:missing`;

  try {
    const stats = statSync(statePath);
    key = `${statePath}:${stats.ino}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    // No state file means Notebook mode.
  }

  const cache = globalThis as { [MOUNTED_DIRECTORY_CACHE]?: MountedDirectoryCache };
  const cached = cache[MOUNTED_DIRECTORY_CACHE];

  if (cached?.key === key) {
    return cached.mounted;
  }

  const { current } = readDirectoryModeState(adminRoot);
  const mounted = current
    ? { name: mountedDirectoryName(current), path: current, stateRoot: directoryStateRoot(adminRoot, current) }
    : null;
  cache[MOUNTED_DIRECTORY_CACHE] = { key, mounted };
  return mounted;
}

/** Where library-level state lives: the admin root, or the open folder's state root. */
export function getStateRoot() {
  return getMountedDirectory()?.stateRoot ?? getAdminRoot();
}

function notebookRootPath(safeNotebook: string) {
  const mounted = getMountedDirectory();

  if (!mounted) {
    const targetPath = path.join(getAdminRoot(), safeNotebook);
    assertInsideAdminRoot(targetPath);
    return targetPath;
  }

  // Directory mode only exposes the open folder; links and attachments cannot
  // reach notebooks or other folders.
  if (safeNotebook !== mounted.name) {
    throw new StorageError("Only files in the open folder are available.", 404);
  }

  return mounted.path;
}

function notebookChildPath(safeNotebook: string, ...parts: string[]) {
  const rootPath = notebookRootPath(safeNotebook);
  const targetPath = path.join(rootPath, ...parts);
  assertInsideRoot(rootPath, targetPath);
  return targetPath;
}

/** Libera's per-notebook system folder. An open folder keeps it in the data directory. */
function notebookSystemPath(safeNotebook: string, ...parts: string[]) {
  const mounted = getMountedDirectory();

  if (!mounted) {
    return notebookChildPath(safeNotebook, LIBERA_SYSTEM_DIR, ...parts);
  }

  notebookRootPath(safeNotebook);
  const systemRoot = path.join(mounted.stateRoot, LIBERA_SYSTEM_DIR);
  const targetPath = path.join(systemRoot, ...parts);
  assertInsideRoot(systemRoot, targetPath);
  return targetPath;
}

export function notebookPath(name: string) {
  return notebookRootPath(assertSafeSegment(name, "Notebook name"));
}

export function workspaceMetadataPath() {
  return path.join(getStateRoot(), WORKSPACE_METADATA_FILE);
}

export function itemPath(
  notebook: string,
  pathParts: string[],
  itemLabel = "Path segment",
) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safePathParts = pathParts.map((part) => assertSafeUserSegment(part, itemLabel));
  return notebookChildPath(safeNotebook, ...safePathParts);
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
  return notebookSystemPath(safeNotebook, ANNOTATIONS_DIR, "pdf", `${safeName}.json`);
}

export function legacyPdfAnnotationsPath(notebook: string, name: string) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safeName = assertSafeSegment(name, "File name");
  return notebookChildPath(safeNotebook, `.${safeName}${PDF_ANNOTATIONS_SUFFIX}`);
}

export function pdfTextCachePath(notebook: string, pathParts: string[]) {
  if (!pathParts.length) {
    throw new StorageError("PDF cache path is invalid.");
  }

  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safePathParts = pathParts.map((part) =>
    assertSafeUserSegment(part, "File path segment"),
  );
  return notebookSystemPath(
    safeNotebook,
    PDF_TEXT_CACHE_DIR,
    ...safePathParts.slice(0, -1),
    `${safePathParts.at(-1)}.json`,
  );
}

export function pdfTextCacheDirectoryPath(notebook: string, pathParts: string[]) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safePathParts = pathParts.map((part) =>
    assertSafeUserSegment(part, "Folder path segment"),
  );
  return notebookSystemPath(safeNotebook, PDF_TEXT_CACHE_DIR, ...safePathParts);
}

export function imageAnnotationsPath(notebook: string, name: string) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safeName = assertSafeSegment(name, "File name");
  return notebookSystemPath(safeNotebook, ANNOTATIONS_DIR, "image", `${safeName}.json`);
}

export function legacyImageAnnotationsPath(notebook: string, name: string) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safeName = assertSafeSegment(name, "File name");
  return notebookChildPath(safeNotebook, `.${safeName}${IMAGE_ANNOTATIONS_SUFFIX}`);
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
  return notebookChildPath(
    assertSafeSegment(notebook, "Notebook name"),
    MARKDOWN_ASSETS_DIR,
    ...folderParts,
    markdownAssetsDirectoryName(markdownPathParts.at(-1) ?? ""),
  );
}

export function markdownAssetsDirectoryPathForDirectory(
  notebook: string,
  pathParts: string[],
) {
  return notebookChildPath(
    assertSafeSegment(notebook, "Notebook name"),
    MARKDOWN_ASSETS_DIR,
    ...pathParts.map((part) => markdownAssetSafeSegment(part)),
  );
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
  return notebookChildPath(
    assertSafeSegment(notebook, "Notebook name"),
    MARKDOWN_ASSETS_DIR,
    markdownAssetsDirectoryName(markdownName),
  );
}

export function notebookMetadataPath(name: string) {
  const safeName = assertSafeSegment(name, "Notebook name");
  const mounted = getMountedDirectory();

  if (mounted) {
    notebookRootPath(safeName);
    return path.join(mounted.stateRoot, NOTEBOOK_METADATA_FILE);
  }

  return notebookChildPath(safeName, NOTEBOOK_METADATA_FILE);
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
  const targetPath = notebookChildPath(
    assertSafeSegment(notebook, "Notebook name"),
    ...normalized.split("/"),
  );
  return {
    normalized,
    targetPath,
  };
}
