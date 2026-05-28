import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LiberaFileNode, LiberaFilePayload, LiberaFileType, LiberaNotebookNode, LiberaTree } from "@/lib/types";

const ADMIN_USER = "admin";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const PDF_EXTENSIONS = new Set([".pdf"]);

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
  return path.resolve(
    process.env.LIBERA_DATA_DIR ??
      path.join(/* turbopackIgnore: true */ process.cwd(), "data", "libera"),
  );
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

function filePath(notebook: string, name: string) {
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safeName = assertSafeSegment(name, "File name");
  const targetPath = path.join(getAdminRoot(), safeNotebook, safeName);
  assertInsideAdminRoot(targetPath);
  return targetPath;
}

function splitFilePath(relativePath: string) {
  if (!relativePath || relativePath.includes("\\") || relativePath.includes("\0")) {
    throw new StorageError("File path is invalid.");
  }

  const parts = relativePath.split("/");

  if (parts.length !== 2) {
    throw new StorageError("File path must be in notebook/file format.");
  }

  const [notebook, name] = parts;

  return {
    notebook: assertSafeSegment(notebook, "Notebook name"),
    name: assertSafeSegment(name, "File name"),
  };
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

function relativeFilePath(notebook: string, name: string) {
  return `${notebook}/${name}`;
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function getFileNode(notebook: string, name: string): Promise<LiberaFileNode> {
  const targetPath = filePath(notebook, name);
  const stats = await stat(targetPath);
  const fileType = assertSupportedFileName(name);

  if (!stats.isFile()) {
    throw new StorageError("Path is not a file.");
  }

  return {
    kind: "file",
    name,
    path: relativeFilePath(notebook, name),
    notebook,
    fileType,
    size: stats.size,
    updatedAt: stats.mtime.toISOString(),
  };
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
    const notebookEntries = await readdir(currentNotebookPath, { withFileTypes: true });
    const children: LiberaFileNode[] = [];

    for (const child of notebookEntries) {
      if (!child.isFile() || child.name.startsWith(".") || !getFileType(child.name)) {
        continue;
      }

      children.push(await getFileNode(entry.name, child.name));
    }

    notebooks.push({
      kind: "notebook",
      name: entry.name,
      path: entry.name,
      updatedAt: notebookStats.mtime.toISOString(),
      children: children.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

  return {
    root: getAdminRoot(),
    notebooks: notebooks.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function createNotebook(name: string) {
  await ensureAdminRoot();
  const targetPath = notebookPath(name);

  if (await pathExists(targetPath)) {
    throw new StorageError("Notebook already exists.", 409);
  }

  await mkdir(targetPath);

  return getTree();
}

export async function renameNotebook(currentName: string, nextName: string) {
  await ensureAdminRoot();
  const currentPath = notebookPath(currentName);
  const nextPath = notebookPath(nextName);

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination notebook already exists.", 409);
  }

  await rename(currentPath, nextPath);

  return getTree();
}

export async function deleteNotebook(name: string) {
  await ensureAdminRoot();
  await rm(notebookPath(name), { recursive: true });

  return getTree();
}

export async function readLiberaFile(relativePath: string): Promise<LiberaFilePayload> {
  await ensureAdminRoot();
  const { notebook, name } = splitFilePath(relativePath);
  const node = await getFileNode(notebook, name);

  if (node.fileType !== "markdown") {
    return {
      file: node,
      rawUrl: `/api/files/raw/${encodeURIComponent(notebook)}/${encodeURIComponent(name)}`,
    };
  }

  return {
    file: node,
    content: await readFile(filePath(notebook, name), "utf8"),
  };
}

export async function createMarkdownFile(notebook: string, name: string, content = "") {
  await ensureAdminRoot();
  const safeNotebook = assertSafeSegment(notebook, "Notebook name");
  const safeName = ensureMarkdownName(name);
  const targetPath = filePath(safeNotebook, safeName);

  if (!(await pathExists(notebookPath(safeNotebook)))) {
    throw new StorageError("Notebook does not exist.", 404);
  }

  if (await pathExists(targetPath)) {
    throw new StorageError("File already exists.", 409);
  }

  await writeFile(targetPath, content, "utf8");

  return readLiberaFile(relativeFilePath(safeNotebook, safeName));
}

export async function updateMarkdownFile(relativePath: string, content: string) {
  await ensureAdminRoot();
  const { notebook, name } = splitFilePath(relativePath);
  const fileType = assertSupportedFileName(name);

  if (fileType !== "markdown") {
    throw new StorageError("Only Markdown files can be edited.");
  }

  await writeFile(filePath(notebook, name), content, "utf8");

  return readLiberaFile(relativePath);
}

export async function moveFile(relativePath: string, nextNotebook: string, nextName: string) {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);
  const safeNextNotebook = assertSafeSegment(nextNotebook, "Notebook name");
  const safeNextName = assertSafeSegment(nextName, "File name");

  assertSupportedFileName(safeNextName);

  if (!(await pathExists(notebookPath(safeNextNotebook)))) {
    throw new StorageError("Destination notebook does not exist.", 404);
  }

  const currentPath = filePath(current.notebook, current.name);
  const nextPath = filePath(safeNextNotebook, safeNextName);

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination file already exists.", 409);
  }

  await rename(currentPath, nextPath);

  return readLiberaFile(relativeFilePath(safeNextNotebook, safeNextName));
}

export async function deleteFile(relativePath: string) {
  await ensureAdminRoot();
  const { notebook, name } = splitFilePath(relativePath);
  await rm(filePath(notebook, name));

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

export async function getRawFile(relativePath: string) {
  await ensureAdminRoot();
  const { notebook, name } = splitFilePath(relativePath);
  const fileType = assertSupportedFileName(name);
  const targetPath = filePath(notebook, name);
  const node = await getFileNode(notebook, name);

  return {
    body: await readFile(targetPath),
    contentType: getContentType(name, fileType),
    node,
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
