import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { StorageError } from "@/lib/storage/errors";
import {
  assertSupportedFileName,
  ensureMarkdownName,
  getContentType,
} from "@/lib/storage/file-types";
import {
  assertDirectoryExists,
  copyFileIfExists,
  ensureParentDirectory,
  findAvailableFilePath,
  moveFileIfExists,
  pathExists,
} from "@/lib/storage/fs-utils";
import {
  copyPdfTextCache,
  deletePdfTextCache,
  deletePdfTextCacheDirectory,
  movePdfTextCache,
  movePdfTextCacheDirectory,
} from "@/lib/storage/pdf-text-cache";
import { pruneUnusedMarkdownImageAssets } from "@/lib/storage/markdown-assets";
import {
  assertSafeSegment,
  ensureAdminRoot,
  filePathFromParts,
  imageAnnotationsPath,
  itemPath,
  legacyImageAnnotationsPath,
  legacyPdfAnnotationsPath,
  markdownAssetsDirectoryPath,
  markdownAssetsDirectoryPathForDirectory,
  markdownAssetsDirectoryPathFromParts,
  notebookPath,
  pdfAnnotationsPath,
  rawFileUrl,
  relativeFilePath,
  splitDirectoryPath,
  splitFilePath,
} from "@/lib/storage/paths";
import { getTree, getFileNode } from "@/lib/storage/tree";
import type { LiberaFilePayload } from "@/lib/types";

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
  await pruneUnusedMarkdownImageAssets(relativePath, content);

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
  await moveRelatedMetadata(
    current.notebook,
    current.name,
    current.pathParts,
    safeNextNotebook,
    safeNextName,
    nextParts,
    currentFileType,
    nextFileType,
  );

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
  await movePdfTextCacheDirectory(current.notebook, current.pathParts, [
    ...parentParts,
    safeNextName,
  ]);
  await moveFileIfExists(
    markdownAssetsDirectoryPathForDirectory(current.notebook, current.pathParts),
    markdownAssetsDirectoryPathForDirectory(current.notebook, [
      ...parentParts,
      safeNextName,
    ]),
  );

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
  await deletePdfTextCacheDirectory(current.notebook, current.pathParts);
  await rm(markdownAssetsDirectoryPathForDirectory(current.notebook, current.pathParts), {
    force: true,
    recursive: true,
  });

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
  await moveRelatedMetadata(
    current.notebook,
    current.name,
    current.pathParts,
    destination.notebook,
    safeNextName,
    nextParts,
    currentFileType,
    nextFileType,
  );

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
  await copyRelatedMetadata(
    current.notebook,
    current.name,
    current.pathParts,
    destination.notebook,
    safeNextName,
    nextParts,
    currentFileType,
  );

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
    await deletePdfTextCache(notebook, pathParts);
  }

  if (fileType === "image") {
    await rm(imageAnnotationsPath(notebook, name), { force: true });
    await rm(legacyImageAnnotationsPath(notebook, name), { force: true });
  }

  if (fileType === "markdown") {
    await rm(markdownAssetsDirectoryPathFromParts(notebook, pathParts), {
      force: true,
      recursive: true,
    });
    await rm(markdownAssetsDirectoryPath(notebook, name), {
      force: true,
      recursive: true,
    });
  }

  return getTree();
}

export async function writeUploadedFile(
  notebook: string,
  upload: File,
  destinationPath?: string,
) {
  await ensureAdminRoot();
  const destination = destinationPath?.trim()
    ? splitDirectoryPath(destinationPath)
    : { notebook: assertSafeSegment(notebook, "Notebook name"), pathParts: [] };
  const safeNotebook = destination.notebook;
  const safeName = assertSafeSegment(upload.name, "File name");
  assertSupportedFileName(safeName);

  const destinationDirectoryPath = itemPath(safeNotebook, destination.pathParts);

  await assertDirectoryExists(destinationDirectoryPath, "Destination folder was not found.");

  const targetParts = [...destination.pathParts, safeName];
  const targetPath = filePathFromParts(safeNotebook, targetParts);

  if (await pathExists(targetPath)) {
    throw new StorageError(`File already exists: ${safeName}`, 409);
  }

  await writeFile(targetPath, Buffer.from(await upload.arrayBuffer()));

  return getFileNode(safeNotebook, targetParts);
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

async function moveRelatedMetadata(
  currentNotebook: string,
  currentName: string,
  currentPathParts: string[],
  nextNotebook: string,
  nextName: string,
  nextPathParts: string[],
  currentFileType: string,
  nextFileType: string,
) {
  if (currentFileType === "pdf" && nextFileType === "pdf") {
    await moveFileIfExists(
      pdfAnnotationsPath(currentNotebook, currentName),
      pdfAnnotationsPath(nextNotebook, nextName),
    );
    await moveFileIfExists(
      legacyPdfAnnotationsPath(currentNotebook, currentName),
      pdfAnnotationsPath(nextNotebook, nextName),
    );
    await movePdfTextCache(
      currentNotebook,
      currentPathParts,
      nextNotebook,
      nextPathParts,
    );
  } else if (currentFileType === "pdf") {
    await rm(pdfAnnotationsPath(currentNotebook, currentName), { force: true });
    await rm(legacyPdfAnnotationsPath(currentNotebook, currentName), { force: true });
    await deletePdfTextCache(currentNotebook, currentPathParts);
  }

  if (currentFileType === "image" && nextFileType === "image") {
    await moveFileIfExists(
      imageAnnotationsPath(currentNotebook, currentName),
      imageAnnotationsPath(nextNotebook, nextName),
    );
    await moveFileIfExists(
      legacyImageAnnotationsPath(currentNotebook, currentName),
      imageAnnotationsPath(nextNotebook, nextName),
    );
  } else if (currentFileType === "image") {
    await rm(imageAnnotationsPath(currentNotebook, currentName), { force: true });
    await rm(legacyImageAnnotationsPath(currentNotebook, currentName), { force: true });
  }

  if (currentFileType === "markdown" && nextFileType === "markdown") {
    const currentAssetsPath = markdownAssetsDirectoryPathFromParts(
      currentNotebook,
      currentPathParts,
    );
    const nextAssetsPath = markdownAssetsDirectoryPathFromParts(
      nextNotebook,
      nextPathParts,
    );

    if ((await pathExists(currentAssetsPath)) && !(await pathExists(nextAssetsPath))) {
      await ensureParentDirectory(nextAssetsPath);
      await rename(currentAssetsPath, nextAssetsPath);
    }

    const currentLegacyAssetsPath = markdownAssetsDirectoryPath(
      currentNotebook,
      currentName,
    );
    const nextLegacyAssetsPath = markdownAssetsDirectoryPath(nextNotebook, nextName);

    if (
      currentLegacyAssetsPath !== currentAssetsPath &&
      (await pathExists(currentLegacyAssetsPath)) &&
      !(await pathExists(nextLegacyAssetsPath))
    ) {
      await ensureParentDirectory(nextLegacyAssetsPath);
      await rename(currentLegacyAssetsPath, nextLegacyAssetsPath);
    }
  }
}

async function copyRelatedMetadata(
  currentNotebook: string,
  currentName: string,
  currentPathParts: string[],
  nextNotebook: string,
  nextName: string,
  nextPathParts: string[],
  currentFileType: string,
) {
  if (currentFileType === "pdf") {
    await copyFileIfExists(
      pdfAnnotationsPath(currentNotebook, currentName),
      pdfAnnotationsPath(nextNotebook, nextName),
    );
    await copyPdfTextCache(currentNotebook, currentPathParts, nextNotebook, nextPathParts);
  }

  if (currentFileType === "image") {
    await copyFileIfExists(
      imageAnnotationsPath(currentNotebook, currentName),
      imageAnnotationsPath(nextNotebook, nextName),
    );
  }

  if (currentFileType === "markdown") {
    const currentAssetsPath = markdownAssetsDirectoryPathFromParts(
      currentNotebook,
      currentPathParts,
    );
    const nextAssetsPath = markdownAssetsDirectoryPathFromParts(
      nextNotebook,
      nextPathParts,
    );

    if ((await pathExists(currentAssetsPath)) && !(await pathExists(nextAssetsPath))) {
      await cp(currentAssetsPath, nextAssetsPath, { recursive: true });
    }

    const currentLegacyAssetsPath = markdownAssetsDirectoryPath(
      currentNotebook,
      currentName,
    );
    const nextLegacyAssetsPath = markdownAssetsDirectoryPath(nextNotebook, nextName);

    if (
      currentLegacyAssetsPath !== currentAssetsPath &&
      (await pathExists(currentLegacyAssetsPath)) &&
      !(await pathExists(nextLegacyAssetsPath))
    ) {
      await cp(currentLegacyAssetsPath, nextLegacyAssetsPath, { recursive: true });
    }
  }
}
