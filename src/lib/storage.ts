import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type {
  ImageAnnotationsPayload,
  LiberaFileNode,
  LiberaFilePayload,
  LiberaFileType,
  LiberaNotebookMetadata,
  LiberaNotebookNode,
  LiberaTree,
  LiberaTreeNode,
  MarkdownImageAssetPayload,
  PdfAnnotation,
  PdfAnnotationRect,
  PdfAnnotationsPayload,
  PdfTextAnnotation,
} from "@/lib/types";

const ADMIN_USER = "admin";
const NOTEBOOK_METADATA_FILE = ".libera-notebook.json";
const PDF_ANNOTATIONS_SUFFIX = ".libera-pdf-annotations.json";
const IMAGE_ANNOTATIONS_SUFFIX = ".libera-image-annotations.json";
const LIBERA_SYSTEM_DIR = ".libera";
const ANNOTATIONS_DIR = "annotations";
const MARKDOWN_ASSETS_DIR = "_assets";
const DEFAULT_NOTEBOOK_COLOR = "#64748b";
const DEFAULT_NOTEBOOK_EMOJI = "📓";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const IGNORED_DOWNLOAD_ENTRIES = new Set([".DS_Store", "__MACOSX"]);

export const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ...MARKDOWN_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...PDF_EXTENSIONS,
]);

export class StorageError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "StorageError";
    this.status = status;
  }
}

function getDataRoot() {
  return path.resolve(process.env.LIBERA_DATA_DIR ?? "data/libera");
}

export function getAdminRoot() {
  return path.join(getDataRoot(), "users", ADMIN_USER);
}

export async function ensureAdminRoot() {
  await mkdir(getAdminRoot(), { recursive: true });
}

function assertSafeSegment(segment: string, label: string) {
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

function assertSafeUserSegment(segment: string, label: string) {
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

function assertInsideAdminRoot(targetPath: string) {
  const relative = path.relative(getAdminRoot(), targetPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new StorageError("Path escapes the Libera data directory.");
  }
}

function notebookPath(name: string) {
  const safeName = assertSafeSegment(name, "Notebook name");
  const targetPath = path.join(getAdminRoot(), safeName);
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

function itemPath(notebook: string, pathParts: string[], itemLabel = "Path segment") {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safePathParts = pathParts.map((part) => assertSafeUserSegment(part, itemLabel));
  const targetPath = path.join(getAdminRoot(), safeNotebook, ...safePathParts);
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

function filePath(notebook: string, name: string) {
  return itemPath(notebook, [name], "File name");
}

function filePathFromParts(notebook: string, pathParts: string[]) {
  if (!pathParts.length) {
    throw new StorageError("File path is invalid.");
  }

  return itemPath(notebook, pathParts, "File path segment");
}

function pdfAnnotationsPath(notebook: string, name: string) {
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

function legacyPdfAnnotationsPath(notebook: string, name: string) {
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

function imageAnnotationsPath(notebook: string, name: string) {
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

function legacyImageAnnotationsPath(notebook: string, name: string) {
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

function markdownAssetsDirectoryName(markdownName: string) {
  const stem = path.basename(markdownName, path.extname(markdownName));
  const normalized = stem
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "note";
}

function markdownAssetsDirectoryPath(notebook: string, markdownName: string) {
  const targetPath = path.join(
    notebookPath(notebook),
    MARKDOWN_ASSETS_DIR,
    markdownAssetsDirectoryName(markdownName),
  );
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

function notebookMetadataPath(name: string) {
  const targetPath = path.join(notebookPath(name), NOTEBOOK_METADATA_FILE);
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

function splitStoragePath(relativePath: string) {
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

function splitFilePath(relativePath: string) {
  const parsed = splitStoragePath(relativePath);

  if (!parsed.pathParts.length) {
    throw new StorageError("File path must be in notebook/file format.");
  }

  return {
    ...parsed,
    name: parsed.pathParts.at(-1) ?? "",
  };
}

function splitDirectoryPath(relativePath: string) {
  return splitStoragePath(relativePath);
}

function getFileType(name: string): LiberaFileType | null {
  const extension = path.extname(name).toLowerCase();

  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return "markdown";
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (PDF_EXTENSIONS.has(extension)) {
    return "pdf";
  }

  return null;
}

function assertSupportedFileName(name: string) {
  const fileType = getFileType(name);

  if (!fileType) {
    throw new StorageError("Only Markdown, image, and PDF files are supported.");
  }

  return fileType;
}

function assertPdfFileName(name: string) {
  const fileType = assertSupportedFileName(name);

  if (fileType !== "pdf") {
    throw new StorageError("PDF annotations can only be used with PDF files.");
  }
}

function assertImageFileName(name: string) {
  const fileType = assertSupportedFileName(name);

  if (fileType !== "image") {
    throw new StorageError("Image annotations can only be used with image files.");
  }
}

function assertMarkdownFileName(name: string) {
  const fileType = assertSupportedFileName(name);

  if (fileType !== "markdown") {
    throw new StorageError("Markdown assets can only be attached to Markdown files.");
  }
}

function ensureMarkdownName(name: string) {
  const safeName = assertSafeSegment(name, "File name");

  if (path.extname(safeName)) {
    const fileType = assertSupportedFileName(safeName);

    if (fileType !== "markdown") {
      throw new StorageError("New note files must use a Markdown extension.");
    }

    return safeName;
  }

  return `${safeName}.md`;
}

function ensureImageName(name: string) {
  const safeName = assertSafeSegment(name, "Image file name");
  const fileType = assertSupportedFileName(safeName);

  if (fileType !== "image") {
    throw new StorageError("Only image files can be inserted into Markdown.");
  }

  return safeName;
}

function normalizeAssetFileName(name: string) {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  const normalizedStem = stem
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return `${normalizedStem || "image"}${extension.toLowerCase()}`;
}

function relativeItemPath(notebook: string, pathParts: string[]) {
  return [notebook, ...pathParts].join("/");
}

function relativeFilePath(notebook: string, nameOrPathParts: string | string[]) {
  return relativeItemPath(notebook, Array.isArray(nameOrPathParts) ? nameOrPathParts : [nameOrPathParts]);
}

function rawFileUrl(relativePath: string) {
  return `/api/files/raw/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizeMarkdownAssetPath(assetPath: string) {
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

function markdownAssetPath(notebook: string, assetPath: string) {
  const normalized = normalizeMarkdownAssetPath(assetPath);
  const targetPath = path.join(notebookPath(notebook), normalized);
  assertInsideAdminRoot(targetPath);
  return {
    normalized,
    targetPath,
  };
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertDirectoryExists(targetPath: string, message: string) {
  const stats = await stat(targetPath);

  if (!stats.isDirectory()) {
    throw new StorageError(message, 400);
  }

  return stats;
}

async function ensureParentDirectory(targetPath: string) {
  await mkdir(path.dirname(targetPath), { recursive: true });
}

async function findAvailableFilePath(directory: string, fileName: string) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let candidateName = fileName;
  let candidatePath = path.join(directory, candidateName);
  let index = 1;

  while (await pathExists(candidatePath)) {
    candidateName = `${stem}-${index}${extension}`;
    candidatePath = path.join(directory, candidateName);
    index += 1;
  }

  return {
    name: candidateName,
    path: candidatePath,
  };
}

async function moveFileIfExists(currentPath: string, nextPath: string) {
  if (!(await pathExists(currentPath))) {
    return;
  }

  await ensureParentDirectory(nextPath);
  await rm(nextPath, { force: true });
  await rename(currentPath, nextPath);
}

async function copyFileIfExists(currentPath: string, nextPath: string) {
  if (!(await pathExists(currentPath))) {
    return;
  }

  await ensureParentDirectory(nextPath);
  await copyFile(currentPath, nextPath);
}

function sanitizeZipName(name: string) {
  return name
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "notebook";
}

function shouldSkipDownloadEntry(name: string) {
  return name.startsWith("._") || IGNORED_DOWNLOAD_ENTRIES.has(name);
}

async function addDirectoryToZip(zip: JSZip, rootPath: string, currentPath: string) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldSkipDownloadEntry(entry.name)) {
      continue;
    }

    const entryPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, entryPath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      zip.folder(relativePath);
      await addDirectoryToZip(zip, rootPath, entryPath);
      continue;
    }

    if (entry.isFile()) {
      zip.file(relativePath, await readFile(entryPath));
    }
  }
}

function normalizeNotebookColor(color: string | undefined) {
  const trimmed = color?.trim();

  if (!trimmed) {
    return DEFAULT_NOTEBOOK_COLOR;
  }

  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : DEFAULT_NOTEBOOK_COLOR;
}

function normalizeNotebookEmoji(emoji: string | undefined) {
  const trimmed = emoji?.trim();

  if (!trimmed) {
    return DEFAULT_NOTEBOOK_EMOJI;
  }

  return Array.from(trimmed).slice(0, 2).join("");
}

function normalizeNotebookMetadata(
  input: Partial<LiberaNotebookMetadata> | undefined,
  fallbackCreatedAt: string,
): LiberaNotebookMetadata {
  return {
    createdAt:
      typeof input?.createdAt === "string" && input.createdAt.trim()
        ? input.createdAt
        : fallbackCreatedAt,
    color: normalizeNotebookColor(input?.color),
    emoji: normalizeNotebookEmoji(input?.emoji),
  };
}

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

async function readNotebookMetadata(
  notebook: string,
  fallbackCreatedAt: string,
): Promise<LiberaNotebookMetadata> {
  try {
    const metadata = JSON.parse(
      await readFile(notebookMetadataPath(notebook), "utf8"),
    ) as Partial<LiberaNotebookMetadata>;

    return normalizeNotebookMetadata(metadata, fallbackCreatedAt);
  } catch {
    return normalizeNotebookMetadata(undefined, fallbackCreatedAt);
  }
}

async function writeNotebookMetadata(
  notebook: string,
  metadata: LiberaNotebookMetadata,
) {
  await writeFile(
    notebookMetadataPath(notebook),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

function shouldSkipTreeEntry(name: string) {
  return (
    name.startsWith(".") ||
    name.startsWith("._") ||
    name === "__MACOSX" ||
    name === MARKDOWN_ASSETS_DIR
  );
}

function sortTreeNodes(left: LiberaTreeNode, right: LiberaTreeNode) {
  if (left.kind !== right.kind) {
    return left.kind === "folder" ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

async function getFileNode(
  notebook: string,
  pathParts: string[] | string,
): Promise<LiberaFileNode> {
  const normalizedPathParts = Array.isArray(pathParts) ? pathParts : [pathParts];
  const name = normalizedPathParts.at(-1) ?? "";
  const targetPath = filePathFromParts(notebook, normalizedPathParts);
  const stats = await stat(targetPath);
  const fileType = assertSupportedFileName(name);

  if (!stats.isFile()) {
    throw new StorageError("Path is not a file.");
  }

  return {
    kind: "file",
    name,
    path: relativeFilePath(notebook, normalizedPathParts),
    notebook,
    fileType,
    size: stats.size,
    updatedAt: stats.mtime.toISOString(),
  };
}

async function readTreeDirectory(
  notebook: string,
  parentParts: string[],
): Promise<LiberaTreeNode[]> {
  const directoryPath = itemPath(notebook, parentParts);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const children: LiberaTreeNode[] = [];

  for (const entry of entries) {
    if (shouldSkipTreeEntry(entry.name)) {
      continue;
    }

    const childParts = [...parentParts, entry.name];

    if (entry.isDirectory()) {
      const stats = await stat(itemPath(notebook, childParts));
      children.push({
        kind: "folder",
        name: entry.name,
        path: relativeItemPath(notebook, childParts),
        notebook,
        updatedAt: stats.mtime.toISOString(),
        children: await readTreeDirectory(notebook, childParts),
      });
      continue;
    }

    if (entry.isFile() && getFileType(entry.name)) {
      children.push(await getFileNode(notebook, childParts));
    }
  }

  return children.sort(sortTreeNodes);
}

export async function getTree(): Promise<LiberaTree> {
  await ensureAdminRoot();

  const entries = await readdir(getAdminRoot(), { withFileTypes: true });
  const notebooks: LiberaNotebookNode[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const currentNotebookPath = notebookPath(entry.name);
    const notebookStats = await stat(currentNotebookPath);
    const metadata = await readNotebookMetadata(
      entry.name,
      notebookStats.birthtime.toISOString(),
    );
    notebooks.push({
      kind: "notebook",
      name: entry.name,
      path: entry.name,
      createdAt: metadata.createdAt,
      color: metadata.color,
      emoji: metadata.emoji,
      updatedAt: notebookStats.mtime.toISOString(),
      children: await readTreeDirectory(entry.name, []),
    });
  }

  return {
    root: getAdminRoot(),
    notebooks: notebooks.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function createNotebook(
  name: string,
  metadataInput?: Partial<LiberaNotebookMetadata>,
) {
  await ensureAdminRoot();
  const targetPath = notebookPath(name);

  if (await pathExists(targetPath)) {
    throw new StorageError("Notebook already exists.", 409);
  }

  await mkdir(targetPath);
  await writeNotebookMetadata(
    name,
    normalizeNotebookMetadata(metadataInput, new Date().toISOString()),
  );

  return getTree();
}

export async function renameNotebook(
  currentName: string,
  nextName: string,
  metadataInput?: Partial<LiberaNotebookMetadata>,
) {
  await ensureAdminRoot();
  const currentPath = notebookPath(currentName);
  const nextPath = notebookPath(nextName);
  const currentStats = await stat(currentPath);
  const existingMetadata = await readNotebookMetadata(
    currentName,
    currentStats.birthtime.toISOString(),
  );

  if (currentPath !== nextPath && (await pathExists(nextPath))) {
    throw new StorageError("Destination notebook already exists.", 409);
  }

  if (currentPath !== nextPath) {
    await rename(currentPath, nextPath);
  }

  await writeNotebookMetadata(
    nextName,
    normalizeNotebookMetadata(
      {
        ...existingMetadata,
        color: metadataInput?.color ?? existingMetadata.color,
        emoji: metadataInput?.emoji ?? existingMetadata.emoji,
      },
      existingMetadata.createdAt,
    ),
  );

  return getTree();
}

export async function deleteNotebook(name: string) {
  await ensureAdminRoot();
  await rm(notebookPath(name), { recursive: true });

  return getTree();
}

export async function createNotebookZip(name: string) {
  await ensureAdminRoot();
  const safeName = assertSafeSegment(name, "Notebook name");
  const targetPath = notebookPath(safeName);
  const stats = await stat(targetPath);

  if (!stats.isDirectory()) {
    throw new StorageError("Notebook was not found.", 404);
  }

  const zip = new JSZip();
  const rootFolderName = sanitizeZipName(safeName);
  const rootFolder = zip.folder(rootFolderName);

  if (!rootFolder) {
    throw new StorageError("Could not prepare notebook download.", 500);
  }

  await addDirectoryToZip(rootFolder, targetPath, targetPath);

  return {
    fileName: `${rootFolderName}.zip`,
    body: await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: {
        level: 6,
      },
    }),
  };
}

export async function readLiberaFile(relativePath: string): Promise<LiberaFilePayload> {
  await ensureAdminRoot();
  const { notebook, pathParts } = splitFilePath(relativePath);
  const node = await getFileNode(notebook, pathParts);

  if (node.fileType !== "markdown") {
    return {
      file: node,
      rawUrl: rawFileUrl(node.path),
    };
  }

  return {
    file: node,
    content: await readFile(filePathFromParts(notebook, pathParts), "utf8"),
  };
}

export async function createMarkdownFile(
  notebook: string,
  name: string,
  content = "",
  parentPath?: string,
) {
  await ensureAdminRoot();
  const parent = parentPath
    ? splitDirectoryPath(parentPath)
    : { notebook: assertSafeSegment(notebook, "Notebook name"), pathParts: [] };
  const safeNotebook = parent.notebook;
  const safeName = ensureMarkdownName(name);
  const targetParts = [...parent.pathParts, safeName];
  const targetPath = filePathFromParts(safeNotebook, targetParts);
  const parentDirectoryPath = itemPath(safeNotebook, parent.pathParts);

  if (!(await pathExists(parentDirectoryPath))) {
    throw new StorageError("Notebook does not exist.", 404);
  }

  await assertDirectoryExists(parentDirectoryPath, "Destination folder is not a folder.");

  if (await pathExists(targetPath)) {
    throw new StorageError("File already exists.", 409);
  }

  await writeFile(targetPath, content, "utf8");

  return readLiberaFile(relativeFilePath(safeNotebook, targetParts));
}

export async function updateMarkdownFile(relativePath: string, content: string) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  const fileType = assertSupportedFileName(name);

  if (fileType !== "markdown") {
    throw new StorageError("Only Markdown files can be edited.");
  }

  await writeFile(filePathFromParts(notebook, pathParts), content, "utf8");

  return readLiberaFile(relativePath);
}

export async function moveFile(relativePath: string, nextNotebook: string, nextName: string) {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);
  const safeNextNotebook = assertSafeSegment(nextNotebook, "Notebook name");
  const safeNextName = assertSafeSegment(nextName, "File name");
  const currentDirectory = current.pathParts.slice(0, -1);
  const currentFileType = assertSupportedFileName(current.name);
  const nextFileType = assertSupportedFileName(safeNextName);

  if (!(await pathExists(notebookPath(safeNextNotebook)))) {
    throw new StorageError("Destination notebook does not exist.", 404);
  }

  const currentPath = filePathFromParts(current.notebook, current.pathParts);
  const nextParts =
    current.notebook === safeNextNotebook ? [...currentDirectory, safeNextName] : [safeNextName];
  const nextPath = filePathFromParts(safeNextNotebook, nextParts);

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination file already exists.", 409);
  }

  await rename(currentPath, nextPath);

  if (currentFileType === "pdf" && nextFileType === "pdf") {
    await moveFileIfExists(
      pdfAnnotationsPath(current.notebook, current.name),
      pdfAnnotationsPath(safeNextNotebook, safeNextName),
    );
    await moveFileIfExists(
      legacyPdfAnnotationsPath(current.notebook, current.name),
      pdfAnnotationsPath(safeNextNotebook, safeNextName),
    );
  } else if (currentFileType === "pdf") {
    await rm(pdfAnnotationsPath(current.notebook, current.name), { force: true });
    await rm(legacyPdfAnnotationsPath(current.notebook, current.name), { force: true });
  }

  if (currentFileType === "image" && nextFileType === "image") {
    await moveFileIfExists(
      imageAnnotationsPath(current.notebook, current.name),
      imageAnnotationsPath(safeNextNotebook, safeNextName),
    );
    await moveFileIfExists(
      legacyImageAnnotationsPath(current.notebook, current.name),
      imageAnnotationsPath(safeNextNotebook, safeNextName),
    );
  } else if (currentFileType === "image") {
    await rm(imageAnnotationsPath(current.notebook, current.name), { force: true });
    await rm(legacyImageAnnotationsPath(current.notebook, current.name), { force: true });
  }

  if (currentFileType === "markdown" && nextFileType === "markdown") {
    const currentAssetsPath = markdownAssetsDirectoryPath(current.notebook, current.name);
    const nextAssetsPath = markdownAssetsDirectoryPath(safeNextNotebook, safeNextName);

    if (
      currentPath !== nextPath &&
      (await pathExists(currentAssetsPath)) &&
      !(await pathExists(nextAssetsPath))
    ) {
      await ensureParentDirectory(nextAssetsPath);
      await rename(currentAssetsPath, nextAssetsPath);
    }
  }

  return readLiberaFile(relativeFilePath(safeNextNotebook, nextParts));
}

function suggestedCopyName(name: string) {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  return `${stem} copy${extension}`;
}

export async function createFolder(parentPath: string, name: string) {
  await ensureAdminRoot();
  const parent = splitDirectoryPath(parentPath);
  const safeName = assertSafeSegment(name, "Folder name");
  const parentTargetPath = itemPath(parent.notebook, parent.pathParts);

  await assertDirectoryExists(parentTargetPath, "Parent folder was not found.");

  const targetPath = itemPath(parent.notebook, [...parent.pathParts, safeName]);

  if (await pathExists(targetPath)) {
    throw new StorageError("Folder already exists.", 409);
  }

  await mkdir(targetPath);

  return getTree();
}

export async function renameFolder(relativePath: string, nextName: string) {
  await ensureAdminRoot();
  const current = splitDirectoryPath(relativePath);

  if (!current.pathParts.length) {
    throw new StorageError("Use notebook edit to rename a notebook.");
  }

  const safeNextName = assertSafeSegment(nextName, "Folder name");
  const parentParts = current.pathParts.slice(0, -1);
  const currentPath = itemPath(current.notebook, current.pathParts);
  const nextPath = itemPath(current.notebook, [...parentParts, safeNextName]);

  await assertDirectoryExists(currentPath, "Folder was not found.");

  if (currentPath === nextPath) {
    return getTree();
  }

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination folder already exists.", 409);
  }

  await rename(currentPath, nextPath);

  return getTree();
}

export async function deleteFolder(relativePath: string) {
  await ensureAdminRoot();
  const current = splitDirectoryPath(relativePath);

  if (!current.pathParts.length) {
    throw new StorageError("Use notebook delete to remove a notebook.");
  }

  const targetPath = itemPath(current.notebook, current.pathParts);
  await assertDirectoryExists(targetPath, "Folder was not found.");
  await rm(targetPath, { recursive: true });

  return getTree();
}

export async function moveFileToDirectory(
  relativePath: string,
  destinationDirectory: string,
  destinationName?: string,
) {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);
  const destination = splitDirectoryPath(destinationDirectory);
  const safeNextName = destinationName?.trim()
    ? assertSafeSegment(destinationName, "File name")
    : current.name;
  const currentFileType = assertSupportedFileName(current.name);
  const nextFileType = assertSupportedFileName(safeNextName);
  const destinationPath = itemPath(destination.notebook, destination.pathParts);

  await assertDirectoryExists(destinationPath, "Destination folder was not found.");

  const currentPath = filePathFromParts(current.notebook, current.pathParts);
  const nextParts = [...destination.pathParts, safeNextName];
  const nextPath = filePathFromParts(destination.notebook, nextParts);

  if (currentPath === nextPath) {
    return readLiberaFile(relativeFilePath(destination.notebook, nextParts));
  }

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination file already exists.", 409);
  }

  await rename(currentPath, nextPath);

  if (currentFileType === "pdf" && nextFileType === "pdf") {
    await moveFileIfExists(
      pdfAnnotationsPath(current.notebook, current.name),
      pdfAnnotationsPath(destination.notebook, safeNextName),
    );
    await moveFileIfExists(
      legacyPdfAnnotationsPath(current.notebook, current.name),
      pdfAnnotationsPath(destination.notebook, safeNextName),
    );
  } else if (currentFileType === "pdf") {
    await rm(pdfAnnotationsPath(current.notebook, current.name), { force: true });
    await rm(legacyPdfAnnotationsPath(current.notebook, current.name), { force: true });
  }

  if (currentFileType === "image" && nextFileType === "image") {
    await moveFileIfExists(
      imageAnnotationsPath(current.notebook, current.name),
      imageAnnotationsPath(destination.notebook, safeNextName),
    );
    await moveFileIfExists(
      legacyImageAnnotationsPath(current.notebook, current.name),
      imageAnnotationsPath(destination.notebook, safeNextName),
    );
  } else if (currentFileType === "image") {
    await rm(imageAnnotationsPath(current.notebook, current.name), { force: true });
    await rm(legacyImageAnnotationsPath(current.notebook, current.name), { force: true });
  }

  if (currentFileType === "markdown" && nextFileType === "markdown") {
    const currentAssetsPath = markdownAssetsDirectoryPath(current.notebook, current.name);
    const nextAssetsPath = markdownAssetsDirectoryPath(destination.notebook, safeNextName);

    if ((await pathExists(currentAssetsPath)) && !(await pathExists(nextAssetsPath))) {
      await ensureParentDirectory(nextAssetsPath);
      await rename(currentAssetsPath, nextAssetsPath);
    }
  }

  return readLiberaFile(relativeFilePath(destination.notebook, nextParts));
}

export async function copyFileToDirectory(
  relativePath: string,
  destinationDirectory: string,
  destinationName?: string,
) {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);
  const destination = splitDirectoryPath(destinationDirectory);
  const requestedName = destinationName?.trim()
    ? assertSafeSegment(destinationName, "File name")
    : suggestedCopyName(current.name);
  const currentFileType = assertSupportedFileName(current.name);
  assertSupportedFileName(requestedName);
  const destinationPath = itemPath(destination.notebook, destination.pathParts);

  await assertDirectoryExists(destinationPath, "Destination folder was not found.");

  const available = await findAvailableFilePath(destinationPath, requestedName);
  const safeNextName = available.name;
  const nextParts = [...destination.pathParts, safeNextName];

  await copyFile(filePathFromParts(current.notebook, current.pathParts), available.path);

  if (currentFileType === "pdf") {
    await copyFileIfExists(
      pdfAnnotationsPath(current.notebook, current.name),
      pdfAnnotationsPath(destination.notebook, safeNextName),
    );
  }

  if (currentFileType === "image") {
    await copyFileIfExists(
      imageAnnotationsPath(current.notebook, current.name),
      imageAnnotationsPath(destination.notebook, safeNextName),
    );
  }

  if (currentFileType === "markdown") {
    const currentAssetsPath = markdownAssetsDirectoryPath(current.notebook, current.name);
    const nextAssetsPath = markdownAssetsDirectoryPath(destination.notebook, safeNextName);

    if ((await pathExists(currentAssetsPath)) && !(await pathExists(nextAssetsPath))) {
      await cp(currentAssetsPath, nextAssetsPath, { recursive: true });
    }
  }

  return readLiberaFile(relativeFilePath(destination.notebook, nextParts));
}

export async function deleteFile(relativePath: string) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  const fileType = assertSupportedFileName(name);

  await rm(filePathFromParts(notebook, pathParts));

  if (fileType === "pdf") {
    await rm(pdfAnnotationsPath(notebook, name), { force: true });
    await rm(legacyPdfAnnotationsPath(notebook, name), { force: true });
  }

  if (fileType === "image") {
    await rm(imageAnnotationsPath(notebook, name), { force: true });
    await rm(legacyImageAnnotationsPath(notebook, name), { force: true });
  }

  if (fileType === "markdown") {
    await rm(markdownAssetsDirectoryPath(notebook, name), {
      force: true,
      recursive: true,
    });
  }

  return getTree();
}

export async function writeUploadedFile(notebook: string, upload: File) {
  await ensureAdminRoot();
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safeName = assertSafeSegment(upload.name, "File name");
  assertSupportedFileName(safeName);

  if (!(await pathExists(notebookPath(safeNotebook)))) {
    throw new StorageError("Notebook does not exist.", 404);
  }

  const targetPath = filePath(safeNotebook, safeName);

  if (await pathExists(targetPath)) {
    throw new StorageError(`File already exists: ${safeName}`, 409);
  }

  await writeFile(targetPath, Buffer.from(await upload.arrayBuffer()));

  return getFileNode(safeNotebook, safeName);
}

export async function writeMarkdownImageAsset(
  documentPath: string,
  upload: File,
): Promise<MarkdownImageAssetPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  const safeName = normalizeAssetFileName(ensureImageName(upload.name));
  const assetDirectory = markdownAssetsDirectoryPath(notebook, name);
  await mkdir(assetDirectory, { recursive: true });

  const available = await findAvailableFilePath(assetDirectory, safeName);
  await writeFile(available.path, Buffer.from(await upload.arrayBuffer()));

  const assetPath = `${MARKDOWN_ASSETS_DIR}/${markdownAssetsDirectoryName(
    name,
  )}/${available.name}`;

  return {
    assetPath,
    markdown: `![${path.basename(available.name, path.extname(available.name))}](${assetPath})`,
    rawUrl: `/api/markdown-assets/raw?document=${encodeURIComponent(
      relativeFilePath(notebook, pathParts),
    )}&asset=${encodeURIComponent(assetPath)}`,
  };
}

export async function getRawFile(relativePath: string) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  const fileType = assertSupportedFileName(name);
  const targetPath = filePathFromParts(notebook, pathParts);
  const node = await getFileNode(notebook, pathParts);

  return {
    body: await readFile(targetPath),
    contentType: getContentType(name, fileType),
    node,
  };
}

export async function getMarkdownImageAsset(documentPath: string, assetPath: string) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  const asset = markdownAssetPath(notebook, assetPath);
  const fileName = path.basename(asset.normalized);
  const fileType = assertSupportedFileName(fileName);

  if (fileType !== "image") {
    throw new StorageError("Markdown asset is not an image.");
  }

  return {
    body: await readFile(asset.targetPath),
    contentType: getContentType(fileName, fileType),
    assetPath: asset.normalized,
    fileName,
  };
}

export async function getMarkdownImageAssetBySource(
  documentPath: string,
  imageSource: string,
) {
  const source = imageSource.trim();

  if (!source) {
    throw new StorageError("Image source is required.");
  }

  if (source.startsWith("/api/markdown-assets/raw")) {
    const url = new URL(source, "http://libera.local");
    const sourceDocumentPath = url.searchParams.get("document") ?? documentPath;
    const assetPath = url.searchParams.get("asset") ?? "";
    return getMarkdownImageAsset(sourceDocumentPath, assetPath);
  }

  if (source.startsWith("/api/files/raw/")) {
    const rawPath = source
      .slice("/api/files/raw/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const rawFile = await getRawFile(rawPath);

    if (rawFile.node.fileType !== "image") {
      throw new StorageError("Markdown image source is not an image.");
    }

    return {
      body: rawFile.body,
      contentType: rawFile.contentType,
      assetPath: rawPath,
      fileName: rawFile.node.name,
    };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    throw new StorageError("Only local Markdown images can be converted.");
  }

  return getMarkdownImageAsset(documentPath, source);
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

function getContentType(name: string, fileType: LiberaFileType) {
  const extension = path.extname(name).toLowerCase();

  if (fileType === "pdf") {
    return "application/pdf";
  }

  if (fileType === "markdown") {
    return "text/markdown; charset=utf-8";
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".gif") {
    return "image/gif";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  return "application/octet-stream";
}

export function toStorageError(error: unknown) {
  if (error instanceof StorageError) {
    return error;
  }

  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: string }).code;

    if (code === "ENOENT") {
      return new StorageError("Requested item was not found.", 404);
    }
  }

  return new StorageError("Storage operation failed.", 500);
}
