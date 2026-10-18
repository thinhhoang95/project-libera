import { deletePdfAnnotationDirectory, migratePdfAnnotationDirectory, migratePdfAnnotations } from "./annotations";
import { moveReviewPath, deleteReviewPath, copyReviewPath } from "./markdown-reviews";
import { detachReferenceAttachments, moveReferenceAttachments } from "./references";
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_DIR, MAX_TEXT_FILE_BYTES } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { hasEdits, type PhotoEdits } from "@/lib/photo-edits";
import { editedPhotoFormat, renderEditedPhoto } from "@/lib/photo-edits-server";
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
  movePath,
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
  markdownAssetsDirectoryPath,
  markdownAssetsDirectoryPathForDirectory,
  markdownAssetsDirectoryPathFromParts,
  notebookPath,
  pdfAnnotationsPath,
  pdfAnnotationsDirectoryPath,
  rawFileUrl,
  relativeFilePath,
  splitDirectoryPath,
  splitFilePath,
} from "@/lib/storage/paths";
import { getTree, getFileNode } from "@/lib/storage/tree";
import {
  removeNotebookPanelExpandedPathPrefix,
  removeFileMetadataPath,
  removeFileMetadataPathPrefix,
  renameNotebookPanelExpandedPathPrefix,
  renameFileMetadataPath,
  renameFileMetadataPathPrefix,
} from "@/lib/storage/workspace-metadata";
import { isTextFileType, type LiberaFilePayload } from "@/lib/types";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { notifyReferenceFilesAdded } from "@/lib/references/jobs";
import { assertNotSharedItem } from "@/lib/collab/shared-notebook";

/** Reads a file for a tab. Text files come with their content, except plain
 * text files that are too large or turn out to be binary: those throw when
 * `requireContent` is set (opening a tab) and otherwise only get a raw URL. */
export async function readLiberaFile(
  relativePath: string,
  { requireContent = false }: { requireContent?: boolean } = {},
): Promise<LiberaFilePayload> {
  await ensureAdminRoot();
  const { notebook, pathParts } = splitFilePath(relativePath);
  const node = await getFileNode(notebook, pathParts);
  const raw = { file: node, rawUrl: rawFileUrl(node.path) };

  if (!isTextFileType(node.fileType)) {
    return raw;
  }

  if (node.fileType === "text" && node.size > MAX_TEXT_FILE_BYTES) {
    if (!requireContent) return raw;
    throw new StorageError(`${node.name} is too large to open as text (limit ${MAX_TEXT_FILE_BYTES / 1024 / 1024} MB).`, 413);
  }

  const content = await readFile(filePathFromParts(notebook, pathParts), "utf8");

  // A NUL byte means the file is binary despite its name; editing and saving
  // it as text would corrupt it.
  if (node.fileType === "text" && content.includes("\u0000")) {
    if (!requireContent) return raw;
    throw new StorageError(`${node.name} is not a text file.`, 415);
  }

  return {
    file: node,
    content,
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
  // Files in a shared notebook are created through the collab host (manifest).
  assertNotSharedItem(safeNotebook, targetParts);

  if (!(await pathExists(parentDirectoryPath))) {
    throw new StorageError("Notebook does not exist.", 404);
  }

  await assertDirectoryExists(parentDirectoryPath, "Destination folder is not a folder.");

  if (await pathExists(targetPath)) {
    throw new StorageError("File already exists.", 409);
  }

  await writeFile(targetPath, content, "utf8");
  notifySearchChanges([relativeFilePath(safeNotebook, targetParts)]);

  return readLiberaFile(relativeFilePath(safeNotebook, targetParts));
}

export async function updateMarkdownFile(relativePath: string, content: string) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  const fileType = assertSupportedFileName(name);

  if (!isTextFileType(fileType)) {
    throw new StorageError("Only text files can be edited.");
  }

  // A shared file is a working copy of a CRDT document; edits go through the host.
  assertNotSharedItem(notebook, pathParts);
  await writeFile(filePathFromParts(notebook, pathParts), content, "utf8");
  if (fileType === "markdown") await pruneUnusedMarkdownImageAssets(relativePath, content);
  notifySearchChanges([relativePath]);

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
  const currentRelativePath = relativeFilePath(current.notebook, current.pathParts);
  const nextRelativePath = relativeFilePath(safeNextNotebook, nextParts);
  assertNotSharedItem(current.notebook, current.pathParts);
  assertNotSharedItem(safeNextNotebook, nextParts);

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination file already exists.", 409);
  }

  if (currentFileType === "pdf") await migratePdfAnnotations(current.notebook, current.pathParts);
  await movePath(currentPath, nextPath);
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
  await moveReviewPath(currentRelativePath, nextRelativePath);
  await moveReferenceAttachments(currentRelativePath, nextRelativePath);
  await renameFileMetadataPath(currentRelativePath, nextRelativePath);
  notifySearchChanges([currentRelativePath, nextRelativePath]);

  return readLiberaFile(nextRelativePath);
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
  assertNotSharedItem(parent.notebook, [...parent.pathParts, safeName]);

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
  const nextParts = [...parentParts, safeNextName];
  const nextPath = itemPath(current.notebook, nextParts);
  assertNotSharedItem(current.notebook, current.pathParts);
  assertNotSharedItem(current.notebook, nextParts);

  await assertDirectoryExists(currentPath, "Folder was not found.");

  if (currentPath === nextPath) {
    return getTree();
  }

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination folder already exists.", 409);
  }

  await migratePdfAnnotationDirectory(current.notebook, current.pathParts);
  await rename(currentPath, nextPath);
  await moveFileIfExists(pdfAnnotationsDirectoryPath(current.notebook, current.pathParts), pdfAnnotationsDirectoryPath(current.notebook, nextParts));
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
  await moveReviewPath(relativeFilePath(current.notebook, current.pathParts), relativeFilePath(current.notebook, nextParts));
  await moveReferenceAttachments(relativeFilePath(current.notebook, current.pathParts), relativeFilePath(current.notebook, nextParts));
  await renameFileMetadataPathPrefix(
    relativeFilePath(current.notebook, current.pathParts),
    relativeFilePath(current.notebook, nextParts),
  );
  await renameNotebookPanelExpandedPathPrefix(
    relativeFilePath(current.notebook, current.pathParts),
    relativeFilePath(current.notebook, nextParts),
  );
  notifySearchChanges();

  return getTree();
}

async function findAvailableDirectoryPath(directory: string, directoryName: string) {
  let candidateName = directoryName;
  let candidatePath = path.join(directory, candidateName);
  let index = 1;

  while (await pathExists(candidatePath)) {
    candidateName = `${directoryName}-${index}`;
    candidatePath = path.join(directory, candidateName);
    index += 1;
  }

  return {
    name: candidateName,
    path: candidatePath,
  };
}

export async function archiveFolder(relativePath: string) {
  await ensureAdminRoot();
  const current = splitDirectoryPath(relativePath);

  if (!current.pathParts.length) {
    throw new StorageError("Use notebook delete to remove a notebook.");
  }

  if (current.pathParts[0] === ARCHIVE_DIR) {
    throw new StorageError("Folder is already archived.");
  }

  const currentPath = itemPath(current.notebook, current.pathParts);
  assertNotSharedItem(current.notebook, current.pathParts);
  await assertDirectoryExists(currentPath, "Folder was not found.");

  const archiveDirectoryPath = itemPath(current.notebook, [ARCHIVE_DIR]);
  await mkdir(archiveDirectoryPath, { recursive: true });

  const currentName = current.pathParts.at(-1) ?? "";
  const available = await findAvailableDirectoryPath(archiveDirectoryPath, currentName);
  const nextParts = [ARCHIVE_DIR, available.name];
  const currentRelativePath = relativeFilePath(current.notebook, current.pathParts);
  const nextRelativePath = relativeFilePath(current.notebook, nextParts);

  await migratePdfAnnotationDirectory(current.notebook, current.pathParts);
  await rename(currentPath, available.path);
  await moveFileIfExists(pdfAnnotationsDirectoryPath(current.notebook, current.pathParts), pdfAnnotationsDirectoryPath(current.notebook, nextParts));
  await movePdfTextCacheDirectory(current.notebook, current.pathParts, nextParts);
  await moveFileIfExists(
    markdownAssetsDirectoryPathForDirectory(current.notebook, current.pathParts),
    markdownAssetsDirectoryPathForDirectory(current.notebook, nextParts),
  );
  await moveReviewPath(relativeFilePath(current.notebook, current.pathParts), relativeFilePath(current.notebook, nextParts));
  await moveReferenceAttachments(relativeFilePath(current.notebook, current.pathParts), relativeFilePath(current.notebook, nextParts));
  await renameFileMetadataPathPrefix(currentRelativePath, nextRelativePath);
  await renameNotebookPanelExpandedPathPrefix(currentRelativePath, nextRelativePath);
  notifySearchChanges();

  return { ...await getTree(), moved: { from: currentRelativePath, to: nextRelativePath } };
}

export async function deleteFolder(relativePath: string) {
  await ensureAdminRoot();
  const current = splitDirectoryPath(relativePath);

  if (!current.pathParts.length) {
    throw new StorageError("Use notebook delete to remove a notebook.");
  }

  const targetPath = itemPath(current.notebook, current.pathParts);
  assertNotSharedItem(current.notebook, current.pathParts);
  await assertDirectoryExists(targetPath, "Folder was not found.");
  await migratePdfAnnotationDirectory(current.notebook, current.pathParts);
  await rm(targetPath, { recursive: true });
  await deletePdfAnnotationDirectory(current.notebook, current.pathParts);
  await deletePdfTextCacheDirectory(current.notebook, current.pathParts);
  await rm(markdownAssetsDirectoryPathForDirectory(current.notebook, current.pathParts), {
    force: true,
    recursive: true,
  });
  await deleteReviewPath(relativeFilePath(current.notebook, current.pathParts));
  await detachReferenceAttachments(relativeFilePath(current.notebook, current.pathParts));
  await removeFileMetadataPathPrefix(relativeFilePath(current.notebook, current.pathParts));
  await removeNotebookPanelExpandedPathPrefix(
    relativeFilePath(current.notebook, current.pathParts),
  );
  notifySearchChanges();

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
  const currentRelativePath = relativeFilePath(current.notebook, current.pathParts);
  const nextRelativePath = relativeFilePath(destination.notebook, nextParts);
  assertNotSharedItem(current.notebook, current.pathParts);
  assertNotSharedItem(destination.notebook, nextParts);

  if (currentPath === nextPath) {
    return readLiberaFile(nextRelativePath);
  }

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination file already exists.", 409);
  }

  if (currentFileType === "pdf") await migratePdfAnnotations(current.notebook, current.pathParts);
  await movePath(currentPath, nextPath);
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
  await moveReviewPath(currentRelativePath, nextRelativePath);
  await moveReferenceAttachments(currentRelativePath, nextRelativePath);
  await renameFileMetadataPath(currentRelativePath, nextRelativePath);
  notifySearchChanges([currentRelativePath, nextRelativePath]);

  return readLiberaFile(nextRelativePath);
}

export async function archiveFile(relativePath: string) {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);

  if (current.pathParts[0] === ARCHIVE_DIR) {
    throw new StorageError("File is already archived.");
  }

  assertNotSharedItem(current.notebook, current.pathParts);
  const archiveDirectoryPath = itemPath(current.notebook, [ARCHIVE_DIR]);
  await mkdir(archiveDirectoryPath, { recursive: true });

  const currentFileType = assertSupportedFileName(current.name);
  const available = await findAvailableFilePath(archiveDirectoryPath, current.name);
  const safeNextName = available.name;
  const nextFileType = assertSupportedFileName(safeNextName);
  const nextParts = [ARCHIVE_DIR, safeNextName];
  const currentPath = filePathFromParts(current.notebook, current.pathParts);
  const currentRelativePath = relativeFilePath(current.notebook, current.pathParts);
  const nextRelativePath = relativeFilePath(current.notebook, nextParts);

  if (currentFileType === "pdf") await migratePdfAnnotations(current.notebook, current.pathParts);
  await rename(currentPath, available.path);
  await moveRelatedMetadata(
    current.notebook,
    current.name,
    current.pathParts,
    current.notebook,
    safeNextName,
    nextParts,
    currentFileType,
    nextFileType,
  );
  await moveReviewPath(currentRelativePath, nextRelativePath);
  await moveReferenceAttachments(currentRelativePath, nextRelativePath);
  await renameFileMetadataPath(currentRelativePath, nextRelativePath);
  notifySearchChanges([currentRelativePath, nextRelativePath]);

  return readLiberaFile(nextRelativePath);
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
  // Copying out of a shared notebook is a read; copying into one is a write.
  assertNotSharedItem(destination.notebook, [...destination.pathParts, requestedName]);

  await assertDirectoryExists(destinationPath, "Destination folder was not found.");

  const available = await findAvailableFilePath(destinationPath, requestedName);
  const safeNextName = available.name;
  const nextParts = [...destination.pathParts, safeNextName];

  if (currentFileType === "pdf") await migratePdfAnnotations(current.notebook, current.pathParts);
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

  await copyReviewPath(relativePath, relativeFilePath(destination.notebook, nextParts));
  // A copy is a new file: no reference is attached to it, and the original keeps its references.
  notifySearchChanges([relativeFilePath(destination.notebook, nextParts)]);
  return readLiberaFile(relativeFilePath(destination.notebook, nextParts));
}

export async function deleteFile(relativePath: string) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  const fileType = assertSupportedFileName(name);
  assertNotSharedItem(notebook, pathParts);

  if (fileType === "pdf") await migratePdfAnnotations(notebook, pathParts);
  await rm(filePathFromParts(notebook, pathParts));

  if (fileType === "pdf") {
    await rm(pdfAnnotationsPath(notebook, pathParts), { force: true });
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
  await deleteReviewPath(relativeFilePath(notebook, pathParts));
  await detachReferenceAttachments(relativeFilePath(notebook, pathParts));
  await removeFileMetadataPath(relativeFilePath(notebook, pathParts));
  notifySearchChanges([relativeFilePath(notebook, pathParts)]);

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
  // Uploads, generated images and gallery saves into notebooks land here.
  assertNotSharedItem(safeNotebook, targetParts);

  if (await pathExists(targetPath)) {
    throw new StorageError(`File already exists: ${safeName}`, 409);
  }

  await writeFile(targetPath, Buffer.from(await upload.arrayBuffer()));
  notifySearchChanges([relativeFilePath(safeNotebook, targetParts)]);
  notifyReferenceFilesAdded([relativeFilePath(safeNotebook, targetParts)]);

  return getFileNode(safeNotebook, targetParts);
}

/**
 * Render edits to a notebook image as a new file beside it. The original, and
 * the text annotations placed on it, are left as they are.
 */
export async function saveEditedImageCopy(relativePath: string, edits: PhotoEdits) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);

  if (assertSupportedFileName(name) !== "image") {
    throw new StorageError("Only images can be edited here.");
  }

  if (!hasEdits(edits)) {
    throw new StorageError("There are no changes to save.");
  }

  assertNotSharedItem(notebook, pathParts);

  const { format, extension } = editedPhotoFormat(name);
  const body = await renderEditedPhoto(filePathFromParts(notebook, pathParts), edits, format);
  const directoryParts = pathParts.slice(0, -1);
  const available = await findAvailableFilePath(
    itemPath(notebook, directoryParts),
    `${path.basename(name, path.extname(name))} (edited)${extension}`,
  );

  await writeFile(available.path, body, { flag: "wx" });
  notifySearchChanges([relativeFilePath(notebook, [...directoryParts, available.name])]);

  return {
    file: await getFileNode(notebook, [...directoryParts, available.name]),
    tree: await getTree(),
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
      pdfAnnotationsPath(currentNotebook, currentPathParts),
      pdfAnnotationsPath(nextNotebook, nextPathParts),
    );
    await movePdfTextCache(
      currentNotebook,
      currentPathParts,
      nextNotebook,
      nextPathParts,
    );
  } else if (currentFileType === "pdf") {
    await rm(pdfAnnotationsPath(currentNotebook, currentPathParts), { force: true });
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
      await movePath(currentAssetsPath, nextAssetsPath);
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
      await movePath(currentLegacyAssetsPath, nextLegacyAssetsPath);
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
      pdfAnnotationsPath(currentNotebook, currentPathParts),
      pdfAnnotationsPath(nextNotebook, nextPathParts),
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
