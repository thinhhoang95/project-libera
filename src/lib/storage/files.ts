import { migrateImageAnnotationDirectory, migrateImageAnnotations, migratePdfAnnotationDirectory, migratePdfAnnotations, updatePdfCommentThreads, writePdfAnnotations } from "./annotations";
import { moveReviewPath, deleteReviewPath, copyReviewPath } from "./markdown-reviews";
import { detachReferenceAttachments, moveReferenceAttachments } from "./references";
import { copyReferencesOnMove, type ReferenceMoveResult } from "@/lib/references/moves";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
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
  findAvailableFilePath,
  movePath,
  pathExists,
} from "@/lib/storage/fs-utils";
import { copyPdfTextCache } from "@/lib/storage/pdf-text-cache";
import {
  cleanupMarkdownImageAssets,
  copyMarkdownImageAssets,
  copyPythonSidecar,
  deletePythonSidecar,
  markdownPathsInFolder,
  movePythonSidecar,
  migratePythonSidecar,
  pruneUnusedMarkdownImageAssets,
  readMarkdownAssetDocuments,
} from "@/lib/storage/markdown-assets";
import {
  assertSafeSegment,
  audioPeaksPath,
  definitionsPath,
  ensureAdminRoot,
  filePathFromParts,
  imageAnnotationsPath,
  itemPath,
  notebookPath,
  pdfAnnotationsPath,
  pdfOutlinePath,
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
import { isTextFileType, type LiberaFileMovePayload, type LiberaFilePayload } from "@/lib/types";
import { normalizePdfCommentThreads } from "@/lib/pdf-comments";
import { copyInkFolder, copyInkThroughEdit, supportsInk } from "@/lib/storage/ink";
import { moveFileSidecars, moveFolderSidecars, removeFileSidecars, removeFolderSidecars } from "@/lib/storage/sidecars";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { copyTranscript } from "@/lib/storage/transcripts";
import { DEFINITIONS_FILE_TYPES } from "@/lib/definitions";
import { notifyReferenceFilesAdded } from "@/lib/references/jobs";
import { assertNotSharedItem, isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { assertNotMigrating, itemLibraryPath } from "@/lib/storage/migration-fence";
import { readSharedAuthorityBytes } from "@/lib/storage/shared-source";

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
  await assertNotMigrating(itemLibraryPath(safeNotebook, targetParts));

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
  await assertNotMigrating(itemLibraryPath(notebook, pathParts));
  const previous = fileType === "markdown" ? await readFile(filePathFromParts(notebook, pathParts), "utf8") : undefined;
  await writeFile(filePathFromParts(notebook, pathParts), content, "utf8");
  if (fileType === "markdown") await pruneUnusedMarkdownImageAssets(relativePath, content, previous);
  notifySearchChanges([relativePath]);

  return readLiberaFile(relativePath);
}

export async function moveFile(relativePath: string, nextNotebook: string, nextName: string): Promise<LiberaFileMovePayload> {
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
  await assertNotMigrating(itemLibraryPath(current.notebook, current.pathParts));
  assertNotSharedItem(safeNextNotebook, nextParts);
  await assertNotMigrating(itemLibraryPath(safeNextNotebook, nextParts));

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination file already exists.", 409);
  }

  if (currentFileType === "pdf") await migratePdfAnnotations(current.notebook, current.pathParts);
  if (currentFileType === "image") await migrateImageAnnotations(current.notebook, current.pathParts);
  const images = await prepareMarkdownImageMove(currentRelativePath, nextRelativePath, currentFileType, nextFileType);
  try { await movePath(currentPath, nextPath); }
  catch (error) { await images?.discard(); throw error; }
  await finishMarkdownImageMove(currentRelativePath, nextRelativePath, images);
  await moveRelatedMetadata(
    current.notebook,
    current.pathParts,
    safeNextNotebook,
    nextParts,
    currentFileType,
    nextFileType,
  );
  await moveReviewPath(currentRelativePath, nextRelativePath);
  await moveReferenceAttachments(currentRelativePath, nextRelativePath);
  await renameFileMetadataPath(currentRelativePath, nextRelativePath);
  // After the attachment wiring, so copied entries see this file's new path.
  const references = await copyCitedReferences(current.notebook, safeNextNotebook, currentRelativePath, nextRelativePath);
  notifySearchChanges([currentRelativePath, nextRelativePath]);

  return withReferences({ ...await readLiberaFile(nextRelativePath), ...(images ? { imageSources: images.imageSources } : {}) }, references);
}

async function prepareMarkdownImageMove(from: string, to: string, currentType: string, nextType: string) {
  if (currentType === "markdown") await migratePythonSidecar(from);
  if (currentType !== "markdown" || nextType !== "markdown" || splitFilePath(from).notebook === splitFilePath(to).notebook) return null;
  const source = splitFilePath(from);
  const previous = await readFile(filePathFromParts(source.notebook, source.pathParts), "utf8");
  const images = await copyMarkdownImageAssets(from, to, previous, true);
  try {
    if (await readFile(filePathFromParts(source.notebook, source.pathParts), "utf8") !== previous) {
      throw new StorageError("The document changed while its images were being copied. Try moving it again.", 409);
    }
    return { ...images, previous };
  } catch (error) { await images.discard(); throw error; }
}

async function finishMarkdownImageMove(from: string, to: string, images: Awaited<ReturnType<typeof prepareMarkdownImageMove>>) {
  if (!images) return;
  const destination = splitFilePath(to);
  await writeFile(filePathFromParts(destination.notebook, destination.pathParts), images.content, "utf8");
  await cleanupMarkdownImageAssets(splitFilePath(from).notebook, [{ documentPath: from, content: images.previous }]);
}

/**
 * Markdown moved to another notebook takes the references it cites along
 * (src/lib/references/moves.ts). Never fails the move.
 */
async function copyCitedReferences(fromNotebook: string, toNotebook: string, from: string, to: string) {
  if (fromNotebook === toNotebook || assertSupportedFileName(to.split("/").at(-1) ?? "") !== "markdown") return null;
  return copyReferencesOnMove(fromNotebook, toNotebook, [{ from, to }]);
}

/**
 * A cross-notebook Markdown move adds `references` to the file payload: what
 * was copied, reused and rewritten, and the key map to apply to an open draft.
 */
function withReferences<T extends object>(payload: T, references: ReferenceMoveResult | null): T & { references?: ReferenceMoveResult } {
  return references ? { ...payload, references } : payload;
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
  await assertNotMigrating(itemLibraryPath(parent.notebook, [...parent.pathParts, safeName]));

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
  await assertNotMigrating(itemLibraryPath(current.notebook, current.pathParts));
  assertNotSharedItem(current.notebook, nextParts);
  await assertNotMigrating(itemLibraryPath(current.notebook, nextParts));

  await assertDirectoryExists(currentPath, "Folder was not found.");

  if (currentPath === nextPath) {
    return getTree();
  }

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination folder already exists.", 409);
  }

  await migratePdfAnnotationDirectory(current.notebook, current.pathParts);
  await migrateImageAnnotationDirectory(current.notebook, current.pathParts);
  const notes = await markdownPathsInFolder(current.notebook, current.pathParts);
  for (const note of notes) await migratePythonSidecar(note);
  await rename(currentPath, nextPath);
  await moveFolderSidecars(current.notebook, current.pathParts, current.notebook, nextParts);
  await moveFolderPythonSidecars(notes, relativeFilePath(current.notebook, current.pathParts), relativeFilePath(current.notebook, nextParts));
  // Image URLs are relative to the notebook root, so their paths stay stable.
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
  await assertNotMigrating(itemLibraryPath(current.notebook, current.pathParts));
  await assertDirectoryExists(currentPath, "Folder was not found.");

  const archiveDirectoryPath = itemPath(current.notebook, [ARCHIVE_DIR]);
  await mkdir(archiveDirectoryPath, { recursive: true });

  const currentName = current.pathParts.at(-1) ?? "";
  const available = await findAvailableDirectoryPath(archiveDirectoryPath, currentName);
  const nextParts = [ARCHIVE_DIR, available.name];
  const currentRelativePath = relativeFilePath(current.notebook, current.pathParts);
  const nextRelativePath = relativeFilePath(current.notebook, nextParts);

  await migratePdfAnnotationDirectory(current.notebook, current.pathParts);
  await migrateImageAnnotationDirectory(current.notebook, current.pathParts);
  const notes = await markdownPathsInFolder(current.notebook, current.pathParts);
  for (const note of notes) await migratePythonSidecar(note);
  await rename(currentPath, available.path);
  await moveFolderSidecars(current.notebook, current.pathParts, current.notebook, nextParts);
  await moveFolderPythonSidecars(notes, currentRelativePath, nextRelativePath);
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
  await assertNotMigrating(itemLibraryPath(current.notebook, current.pathParts));
  await assertDirectoryExists(targetPath, "Folder was not found.");
  const markdown = (await readMarkdownAssetDocuments(current.notebook)).documents.filter((document) =>
    document.documentPath.startsWith(`${relativePath}/`));
  await migratePdfAnnotationDirectory(current.notebook, current.pathParts);
  await migrateImageAnnotationDirectory(current.notebook, current.pathParts);
  await rm(targetPath, { recursive: true });
  await removeFolderSidecars(current.notebook, current.pathParts);
  for (const document of markdown) await deletePythonSidecar(document.documentPath);
  await cleanupMarkdownImageAssets(current.notebook, markdown);
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
): Promise<LiberaFileMovePayload> {
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
  await assertNotMigrating(itemLibraryPath(current.notebook, current.pathParts));
  assertNotSharedItem(destination.notebook, nextParts);
  await assertNotMigrating(itemLibraryPath(destination.notebook, nextParts));

  if (currentPath === nextPath) {
    return readLiberaFile(nextRelativePath);
  }

  if (await pathExists(nextPath)) {
    throw new StorageError("Destination file already exists.", 409);
  }

  if (currentFileType === "pdf") await migratePdfAnnotations(current.notebook, current.pathParts);
  if (currentFileType === "image") await migrateImageAnnotations(current.notebook, current.pathParts);
  const images = await prepareMarkdownImageMove(currentRelativePath, nextRelativePath, currentFileType, nextFileType);
  try { await movePath(currentPath, nextPath); }
  catch (error) { await images?.discard(); throw error; }
  await finishMarkdownImageMove(currentRelativePath, nextRelativePath, images);
  await moveRelatedMetadata(
    current.notebook,
    current.pathParts,
    destination.notebook,
    nextParts,
    currentFileType,
    nextFileType,
  );
  await moveReviewPath(currentRelativePath, nextRelativePath);
  await moveReferenceAttachments(currentRelativePath, nextRelativePath);
  await renameFileMetadataPath(currentRelativePath, nextRelativePath);
  // After the attachment wiring, so copied entries see this file's new path.
  const references = await copyCitedReferences(current.notebook, destination.notebook, currentRelativePath, nextRelativePath);
  notifySearchChanges([currentRelativePath, nextRelativePath]);

  return withReferences({ ...await readLiberaFile(nextRelativePath), ...(images ? { imageSources: images.imageSources } : {}) }, references);
}

export async function archiveFile(relativePath: string) {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);

  if (current.pathParts[0] === ARCHIVE_DIR) {
    throw new StorageError("File is already archived.");
  }

  assertNotSharedItem(current.notebook, current.pathParts);

  await assertNotMigrating(itemLibraryPath(current.notebook, current.pathParts));
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
  if (currentFileType === "image") await migrateImageAnnotations(current.notebook, current.pathParts);
  if (currentFileType === "markdown") await migratePythonSidecar(currentRelativePath);
  await rename(currentPath, available.path);
  await moveRelatedMetadata(
    current.notebook,
    current.pathParts,
    current.notebook,
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
  await assertNotMigrating(itemLibraryPath(destination.notebook, [...destination.pathParts, requestedName]));

  await assertDirectoryExists(destinationPath, "Destination folder was not found.");
  // A shared notebook's disk copy can lag what collaborators see (a
  // follower's cloud copy, a write still waiting): copy the shared version,
  // read before anything is created so a failure leaves nothing behind.
  const sharedSource = isSharedNotebookPath(relativePath);
  const sharedText = sharedSource && isTextFileType(currentFileType) ? await readSharedTextForCopy(relativePath) : null;
  const livePdf = sharedSource && currentFileType === "pdf" ? await livePdfAnnotationsForCopy(relativePath) : null;
  // Likewise for a binary: the host's current bytes, not a lagging working file.
  const sharedBytes = sharedSource && !isTextFileType(currentFileType) ? await readSharedAuthorityBytes(relativePath) : null;

  let available;
  for (;;) {
    available = await findAvailableFilePath(destinationPath, requestedName);
    try {
      if (sharedBytes) await writeFile(available.path, sharedBytes, { flag: "wx" });
      else await copyFile(filePathFromParts(current.notebook, current.pathParts), available.path, constants.COPYFILE_EXCL);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const safeNextName = available.name;
  const nextParts = [...destination.pathParts, safeNextName];
  if (sharedText !== null) await writeFile(available.path, sharedText, "utf8");

  if (currentFileType === "pdf") await migratePdfAnnotations(current.notebook, current.pathParts);
  if (currentFileType === "image") await migrateImageAnnotations(current.notebook, current.pathParts);
  if (currentFileType === "markdown") {
    let images;
    try {
      const content = await readFile(available.path, "utf8");
      images = await copyMarkdownImageAssets(relativePath, relativeFilePath(destination.notebook, nextParts), content);
      await writeFile(available.path, images.content, "utf8");
    } catch (error) {
      await images?.discard();
      await rm(available.path, { force: true });
      throw error;
    }
  }
  await copyRelatedMetadata(
    current.notebook,
    current.pathParts,
    destination.notebook,
    nextParts,
    currentFileType,
  );

  // A live PDF's marks and comments are in its shared document, not the sidecar on disk.
  if (livePdf) {
    const copyPath = relativeFilePath(destination.notebook, nextParts);
    await writePdfAnnotations(copyPath, livePdf.marks);
    await updatePdfCommentThreads(copyPath, () => ({ threads: livePdf.threads, result: undefined }));
  }

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
  await assertNotMigrating(itemLibraryPath(notebook, pathParts));

  if (fileType === "pdf") await migratePdfAnnotations(notebook, pathParts);
  if (fileType === "image") await migrateImageAnnotations(notebook, pathParts);
  const markdown = fileType === "markdown" ? await readFile(filePathFromParts(notebook, pathParts), "utf8") : null;
  await rm(filePathFromParts(notebook, pathParts));
  await removeFileSidecars(notebook, pathParts, fileType);

  if (markdown !== null) {
    await cleanupMarkdownImageAssets(notebook, [{ documentPath: relativePath, content: markdown }]);
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
  await assertNotMigrating(itemLibraryPath(safeNotebook, targetParts));

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

  await assertNotMigrating(itemLibraryPath(notebook, pathParts));

  const { format, extension } = editedPhotoFormat(name);
  const body = await renderEditedPhoto(filePathFromParts(notebook, pathParts), edits, format);
  const directoryParts = pathParts.slice(0, -1);
  const available = await findAvailableFilePath(
    itemPath(notebook, directoryParts),
    `${path.basename(name, path.extname(name))} (edited)${extension}`,
  );

  await writeFile(available.path, body, { flag: "wx" });
  // The copy keeps the original's ink, moved with the crop and turns.
  await copyInkThroughEdit(relativeFilePath(notebook, pathParts), relativeFilePath(notebook, [...directoryParts, available.name]), edits);
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
    // The working file, also in a shared notebook: this serves every viewer
    // (images, PDFs, audio), so it must not round-trip each read through the
    // host. A follower's view refreshes when the new bytes arrive; copies and
    // exports, which outlive the moment, read the host's version instead.
    body: await readFile(targetPath),
    contentType: getContentType(name, fileType),
    node,
  };
}

/** Transcripts and waveforms of the recordings in a renamed or archived folder. */
/** Where a raw file is, without reading it, so large recordings can be streamed in ranges. */
export async function locateRawFile(relativePath: string) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  const fileType = assertSupportedFileName(name);
  const node = await getFileNode(notebook, pathParts);
  return { absolutePath: filePathFromParts(notebook, pathParts), contentType: getContentType(name, fileType), fileType, node };
}

/** The Python sidecars of a moved folder's notes, whose paths follow the notes' (markdown-assets.ts). */
async function moveFolderPythonSidecars(notes: string[], from: string, to: string) {
  for (const note of notes) await movePythonSidecar(note, `${to}${note.slice(from.length)}`);
}


async function moveRelatedMetadata(
  currentNotebook: string,
  currentPathParts: string[],
  nextNotebook: string,
  nextPathParts: string[],
  currentFileType: string,
  nextFileType: string,
) {
  // Sidecars (annotations, ink, transcripts, ...) follow a file that keeps its
  // kind; ink chunks and annotations are per kind of file, so they are
  // removed when it becomes another kind (storage/sidecars.ts).
  await moveFileSidecars(currentNotebook, currentPathParts, nextNotebook, nextPathParts, currentFileType, nextFileType);
}

/** The shared document's text, or null (then the disk bytes are copied) when the host cannot answer. */
async function readSharedTextForCopy(sourcePath: string): Promise<string | null> {
  // Imported here: shared-writes reaches back into storage.
  const { readSharedText } = await import("@/lib/collab/shared-writes");
  return (await readSharedText(sourcePath).catch(() => null))?.text ?? null;
}

/**
 * A live PDF's marks and comments, from its shared document, for a local
 * copy; null when the PDF is not live. They become the copy's own: new ids,
 * so sharing this notebook later imports them instead of taking them for
 * copies of server threads.
 */
async function livePdfAnnotationsForCopy(sourcePath: string) {
  const { livePdfSnapshot, resolveSharedPdf } = await import("@/lib/collab/host-client");
  const source = await resolveSharedPdf(sourcePath).catch(() => null);
  if (!source) return null;
  const snapshot = await livePdfSnapshot(source.docId);
  const ids = new Map<string, string>();
  const fresh = (id: string) => { if (!ids.has(id)) ids.set(id, randomUUID()); return ids.get(id)!; };
  const marks = snapshot.marks.map((value) => {
    const mark = value as { id: string; space?: string };
    return { ...mark, id: fresh(mark.id), ...(mark.space ? { space: fresh(mark.space) } : {}) };
  });
  const threads = normalizePdfCommentThreads(snapshot.comments ?? [], randomUUID)
    .map((thread) => ({ ...thread, id: randomUUID(), messages: thread.messages.map((message) => ({ ...message, id: randomUUID() })) }));
  return { marks, threads };
}

async function copyRelatedMetadata(
  currentNotebook: string,
  currentPathParts: string[],
  nextNotebook: string,
  nextPathParts: string[],
  currentFileType: string,
) {
  if (currentFileType === "pdf") {
    await copyFileIfExists(
      pdfAnnotationsPath(currentNotebook, currentPathParts),
      pdfAnnotationsPath(nextNotebook, nextPathParts),
    );
    await copyPdfTextCache(currentNotebook, currentPathParts, nextNotebook, nextPathParts);
    // The outline describes the bytes, which the copy shares.
    await copyFileIfExists(pdfOutlinePath(currentNotebook, currentPathParts), pdfOutlinePath(nextNotebook, nextPathParts));
  }

  if (currentFileType === "image") {
    await copyFileIfExists(
      imageAnnotationsPath(currentNotebook, currentPathParts),
      imageAnnotationsPath(nextNotebook, nextPathParts),
    );
  }

  if (currentFileType === "audio") {
    // The waveform is a local cache; the transcript may be a shared notebook's companion.
    await copyFileIfExists(audioPeaksPath(currentNotebook, currentPathParts), audioPeaksPath(nextNotebook, nextPathParts));
    await copyTranscript(relativeFilePath(currentNotebook, currentPathParts), relativeFilePath(nextNotebook, nextPathParts));
  }

  if (currentFileType === "markdown") {
    await copyPythonSidecar(relativeFilePath(currentNotebook, currentPathParts), relativeFilePath(nextNotebook, nextPathParts));
  }

  if (supportsDefinitionsType(currentFileType)) {
    await copyFileIfExists(definitionsPath(currentNotebook, currentPathParts), definitionsPath(nextNotebook, nextPathParts));
  }

  if (supportsInk(currentFileType)) await copyInkFolder(currentNotebook, currentPathParts, nextNotebook, nextPathParts);
}

function supportsDefinitionsType(fileType: string) {
  return DEFINITIONS_FILE_TYPES.some((type) => type === fileType);
}
