import { migrateImageAnnotationDirectory, migrateImageAnnotations, migratePdfAnnotationDirectory, migratePdfAnnotations, updatePdfCommentThreads, writePdfAnnotations } from "./annotations";
import { moveReviewPath, moveReviewPaths, deleteReviewPath, copyReviewPath } from "./markdown-reviews";
import { discardReviewsAt, discardReviewsUnder, hasReviewEntry, listReviewEntryPaths, transformReviewBaselines, withMovedReview, withMovedReviewsUnder } from "@/lib/agent/review-store";
import { reviewIndexBlocker } from "./destination-records";
import { rewriteMarkdownImageSources } from "@/lib/markdown-image-sources";
import { rewriteCitationKeys } from "@/lib/references/citation-syntax";
import { isEmptyReview, type ReviewDocument } from "@/lib/markdown-review";
import { inspectReviewDocuments, inspectReviewKeys } from "./review-files";
import { readWorkspaceMetadata } from "./workspace-metadata";
import { detachReferenceAttachments, inspectReferenceLibrary, moveReferenceAttachments } from "./references";
import { libraryNotebookNames } from "./library-links";
import { followMovedLinks } from "./move-links";
import { rewriteMovedPaths } from "@/lib/move-rewrites";
import { copyReferencesOnMove, type ReferenceMoveResult } from "@/lib/references/moves";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { ARCHIVE_DIR, MARKDOWN_ASSETS_DIR, MAX_TEXT_FILE_BYTES } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { hasEdits, type PhotoEdits } from "@/lib/photo-edits";
import { editedPhotoFormat, renderEditedPhoto } from "@/lib/photo-edits-server";
import {
  assertSupportedFileName,
  ensureMarkdownName,
  getContentType,
} from "@/lib/storage/file-types";
import {
  assertCanCreateParents,
  assertDirectoryExists,
  copyFileIfExists,
  holdsFiles,
  isCaseOnlyRename,
  moveFileWithoutReplacing,
  pathExists,
  replaceFileIfUnchanged,
  withPathLocks,
} from "@/lib/storage/fs-utils";
import { localFileIdentity } from "@/lib/storage/file-identity";
import { copyPdfTextCache } from "@/lib/storage/pdf-text-cache";
import {
  cleanupMarkdownImageAssets,
  copyMarkdownImageAssets,
  copyPythonSidecar,
  deletePythonSidecar,
  markdownDocumentsInFolder,
  markdownImageTargets,
  markdownPathsInFolder,
  movePythonSidecar,
  migratePythonSidecar,
  pruneUnusedMarkdownImageAssets,
  pythonCodeAt,
} from "@/lib/storage/markdown-assets";
import {
  assertSafeSegment,
  audioPeaksPath,
  definitionsPath,
  ensureAdminRoot,
  filePathFromParts,
  getStateRoot,
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
import { isTextFileType, type LiberaFileMovePayload, type LiberaFolderMovePayload, type LiberaLinkRewrites, type LiberaMoveStep, type LiberaFilePayload, type LiberaFileType } from "@/lib/types";
import { normalizePdfCommentThreads } from "@/lib/pdf-comments";
import { copyInkFolder, copyInkThroughEdit, supportsInk } from "@/lib/storage/ink";
import { existingSidecars, legacyAnnotationSidecars, lostSidecarRecords, moveFileSidecars, moveFolderSidecars, removeFileSidecars, removeFolderSidecars, SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { copyTranscript } from "@/lib/storage/transcripts";
import { DEFINITIONS_FILE_TYPES } from "@/lib/definitions";
import { notifyReferenceFilesAdded } from "@/lib/references/jobs";
import { assertNotSharedItem, isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { assertNotMigrating, assertNothingMigratingWithin, itemLibraryPath } from "@/lib/storage/migration-fence";
import { readSharedSourceSnapshot, sharedSourceGone } from "@/lib/storage/shared-source";
import { destinationRecords } from "@/lib/storage/destination-records";

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
    version: textVersion(content),
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

/** Identifies a text file's content: the editor sends the version of the text it opened (see updateMarkdownFile). */
export function textVersion(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Saves a text file. With `baseVersion` (the textVersion of what the editor
 * opened or last saved) the save is refused with 409 when the file on disk is
 * another version (a cloud copy arrived, another window saved) or is gone (it
 * was moved or deleted), so a stale tab never replaces newer bytes or brings an
 * old name back. Without it the file is replaced whatever it holds. The bytes
 * are staged in a temporary file and renamed into place, so a cloud provider
 * never uploads a half-written file. A save and a move of the same path never
 * interleave (withPathLocks), and a file put at the name after the save read
 * it is not overwritten (replaceFileIfUnchanged).
 */
export async function updateMarkdownFile(relativePath: string, content: string, baseVersion?: string) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  const fileType = assertSupportedFileName(name);

  if (!isTextFileType(fileType)) {
    throw new StorageError("Only text files can be edited.");
  }

  // A shared file is a working copy of a CRDT document; edits go through the host.
  assertNotSharedItem(notebook, pathParts);
  await assertNotMigrating(itemLibraryPath(notebook, pathParts));
  const absolute = filePathFromParts(notebook, pathParts);
  const gone = `${name} is no longer there (it was moved or deleted), so this save was not applied. Your text is still in the editor.`;
  const changed = `${name} changed on disk since you opened it, so this save was not applied. Your text is still in the editor.`;
  // Under the file's lock, so a move of this path (which holds it too) never runs between the checks and the write.
  const previous = await withPathLocks([absolute], async () => {
    const bytes = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new StorageError(gone, 409);
      throw error;
    });
    const onDisk = bytes.toString("utf8");
    // Saving what the file already holds is no conflict, whoever wrote it.
    if (baseVersion !== undefined && textVersion(onDisk) !== baseVersion && onDisk !== content) throw new StorageError(changed, 409);
    // A path that lost its folder is not recreated: the plain write failed there too.
    if (!(await pathExists(path.dirname(absolute)))) throw new StorageError("Folder was not found.", 404);
    // Published only while the file still holds what was just read: a file put there since is refused, not replaced.
    await replaceFileIfUnchanged(absolute, Buffer.from(content, "utf8"), bytes, { gone, changed });
    return fileType === "markdown" ? onDisk : undefined;
  });
  if (fileType === "markdown") await pruneUnusedMarkdownImageAssets(relativePath, content, previous);
  notifySearchChanges([relativePath]);

  return readLiberaFile(relativePath);
}

/**
 * `expectedFileId`: the identity the caller saw for the file it chose
 * (localFileIdentity of its tree node). A move, archive or delete of a path
 * that holds another file by then is refused (409) instead of acted on.
 */
export type LocalFileActionOptions = {
  expectedFileId?: string;
  /** The caller runs the links step itself, once for all its moves (a batch: batch-files.ts), so links between files moving together keep their form. */
  deferLinks?: boolean;
};

/** What a move says when a file is at its destination (the archive tells it from other refusals to try another name). */
const DESTINATION_TAKEN = "Destination file already exists.";

/** How many names are tried for a copy or an archive before giving up (a damaged store would otherwise show every name taken). */
const MAX_NAME_ATTEMPTS = 500;

/** A destination that still holds records of a file that was there before. */
class LeftoverRecordsError extends StorageError {}

export async function moveFile(relativePath: string, nextNotebook: string, nextName: string, options: LocalFileActionOptions = {}): Promise<LiberaFileMovePayload> {
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

  // A file moved onto its own path is where it was: nothing to do (not a clash with itself).
  if (currentPath === nextPath) return readLiberaFile(nextRelativePath);

  // The same file under another spelling (a case-only rename on a case-insensitive disk) is not a clash.
  const caseOnly = await isCaseOnlyRename(currentPath, nextPath);
  if (!caseOnly && await pathExists(nextPath)) {
    throw new StorageError(DESTINATION_TAKEN, 409);
  }

  return performFileMove({
    notebook: current.notebook, pathParts: current.pathParts, nextNotebook: safeNextNotebook, nextParts,
    currentPath, nextPath, currentRelativePath, nextRelativePath, currentFileType, nextFileType, caseOnly,
  }, options);
}

type FileMove = {
  notebook: string;
  pathParts: string[];
  nextNotebook: string;
  nextParts: string[];
  currentPath: string;
  nextPath: string;
  currentRelativePath: string;
  nextRelativePath: string;
  currentFileType: LiberaFileType;
  nextFileType: LiberaFileType;
  /** The destination is the file itself under another spelling of its name. */
  caseOnly: boolean;
};

/** The source file as the move first saw it; a different file by the time it is moved is refused. */
type SourceSnapshot = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint };

const sourceChanged = (relative: string) => new StorageError(`${relative} changed since it was read: another file or another version is at that path now, so nothing was changed. Refresh the notebook and try again.`, 409);

/**
 * Refuses (409) when the path no longer holds the file the person chose: the
 * identity their screen showed (`expectedFileId`) must still match, and so
 * must the snapshot taken when this action began. Read only; called at the
 * start and again right before the destructive step.
 */
async function assertSourceIsStill(currentPath: string, relative: string, expectedFileId?: string, snapshot?: SourceSnapshot): Promise<SourceSnapshot> {
  const stats = await stat(currentPath, { bigint: true }).catch(() => null);
  if (!stats?.isFile()) throw new StorageError(`${relative} is no longer there, so nothing was changed. Refresh the notebook and try again.`, 409);
  if (expectedFileId !== undefined) {
    const plain = await stat(currentPath);
    if (localFileIdentity({ createdAt: plain.birthtime.toISOString(), size: plain.size }) !== expectedFileId) throw sourceChanged(relative);
  }
  const now = { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs };
  if (snapshot && (now.dev !== snapshot.dev || now.ino !== snapshot.ino || now.size !== snapshot.size || now.mtimeNs !== snapshot.mtimeNs)) throw sourceChanged(relative);
  return now;
}

/** For a delete: the same identity check, at the entry (the record handling of a delete is deleteFile's own). */
export async function assertLocalFileIdentity(relativePath: string, expectedFileId: string) {
  const { notebook, pathParts } = splitFilePath(relativePath);
  await assertSourceIsStill(filePathFromParts(notebook, pathParts), relativePath, expectedFileId);
}

/**
 * Everything a move of one file does once its destination is known. Checks
 * first, so a refusal leaves everything as it was; then the document and its
 * sidecars move together, all or nothing (moveDocumentWithSidecars). Under the
 * lock of both names, so a save of either (updateMarkdownFile) or another
 * move to the name can't run in between. Then, with the locks released (the
 * rewrite takes each note's own), paths in notes follow (move-links.ts).
 */
async function performFileMove(move: FileMove, options: LocalFileActionOptions = {}): Promise<LiberaFileMovePayload> {
  const moves = [{ from: move.currentRelativePath, to: move.nextRelativePath }];
  let payload: LiberaFileMovePayload;
  try { payload = await withPathLocks([move.currentPath, move.nextPath], () => performLockedFileMove(move, options)); }
  catch (error) {
    // The file moved but its result could not be read: links still follow, and the error says what they did.
    if (error instanceof MoveCommittedError && !options.deferLinks) {
      const { links, unfinished } = await followMovedLinks(moves);
      error.links = links;
      if (unfinished) error.unfinished.push(unfinished);
    }
    throw error;
  }
  if (options.deferLinks) return payload;
  const { links, unfinished } = await followMovedLinks(moves);
  const own = links.rewritten.find((note) => note.path === move.nextRelativePath)?.rewrite;
  // The moved note's own text changed: the payload carries what is on disk now (the same rewrite of what it read, if it can't be read again).
  const file = own ? await readLiberaFile(move.nextRelativePath).catch(() => null) : null;
  const content = own && !file && payload.content !== undefined ? rewriteMovedPaths(payload.content, move.nextRelativePath, own) : undefined;
  const steps = [...payload.unfinished ?? [], ...(unfinished ? [unfinished] : [])];
  return {
    ...payload,
    ...(file ?? (content !== undefined ? { content, version: textVersion(content) } : {})),
    ...(links.rewritten.length || links.skipped.length || links.unchecked.length ? { links } : {}),
    ...(steps.length ? { moved: { from: move.currentRelativePath, to: move.nextRelativePath }, unfinished: steps } : {}),
  };
}

async function performLockedFileMove(move: FileMove, { expectedFileId }: LocalFileActionOptions): Promise<LiberaFileMovePayload> {
  const { notebook, pathParts, nextNotebook, nextParts, currentRelativePath, nextRelativePath, currentFileType, nextFileType } = move;
  const snapshot = await assertSourceIsStill(move.currentPath, currentRelativePath, expectedFileId);
  await assertNoLeftoverRecords(nextNotebook, nextParts, nextFileType, move.caseOnly, notebook === nextNotebook ? pathParts : undefined);
  await assertTypeChangeLosesNothing(notebook, pathParts, currentRelativePath, currentFileType, nextFileType);
  await assertSidecarsCanMove(nextNotebook, nextParts, currentFileType, nextFileType);

  if (currentFileType === "pdf") await migratePdfAnnotations(notebook, pathParts);
  if (currentFileType === "image") await migrateImageAnnotations(notebook, pathParts);
  const images = await prepareMarkdownImageMove(currentRelativePath, nextRelativePath, currentFileType, nextFileType);
  const stillTheSource = () => assertSourceIsStill(move.currentPath, currentRelativePath, expectedFileId, snapshot);
  try { await movePathWithReview(currentRelativePath, nextRelativePath, nextFileType, images, () => moveDocumentWithSidecars(move, stillTheSource)); }
  catch (error) { await images?.discard(); throw error; }

  // The file has moved: from here nothing fails the request. Each step reports itself, so a caller can still retarget what it has open.
  const unfinished: LiberaMoveStep[] = [];
  const step = async <T>(name: LiberaMoveStep["step"], run: () => Promise<T>): Promise<T | undefined> => {
    try { return await run(); }
    catch (error) {
      console.error(`[files] ${name} did not follow ${currentRelativePath} to ${nextRelativePath}:`, error);
      unfinished.push({ step: name, status: "failed", message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  };
  await step("images", () => finishMarkdownImageMove(currentRelativePath, nextRelativePath, images));
  unfinished.push(...(await moveDerivedRecords(currentRelativePath, nextRelativePath)).unfinished);
  // After the attachment wiring, so copied entries see this file's new path.
  const references = await step("references", () => copyCitedReferences(notebook, nextNotebook, currentRelativePath, nextRelativePath)) ?? null;
  await step("history", () => recordFileMove(currentRelativePath, nextRelativePath, currentFileType, images, references));
  notifySearchChanges([currentRelativePath, nextRelativePath]);

  let file: LiberaFilePayload;
  try { file = await readLiberaFile(nextRelativePath); }
  catch (error) { throw new MoveCommittedError(`${currentRelativePath} was moved to ${nextRelativePath}, but reading it there failed: ${error instanceof Error ? error.message : String(error)}`, { from: currentRelativePath, to: nextRelativePath }, unfinished); }
  return withReferences({
    ...file,
    ...(images ? { imageSources: images.imageSources } : {}),
    ...(unfinished.length ? { moved: { from: currentRelativePath, to: nextRelativePath }, unfinished } : {}),
  }, references);
}

/** The move happened but the result could not be built: the error carries what the caller needs to retarget (the route sends it), and what links did. */
export class MoveCommittedError extends StorageError {
  links?: LiberaLinkRewrites;
  constructor(message: string, readonly moved: { from: string; to: string }, readonly unfinished: LiberaMoveStep[]) {
    super(message, 500);
  }
}

/**
 * The records a file has at a path of their own, beside its sidecars (which
 * SIDECAR_KINDS lists): review comments, reference attachments, and the
 * workspace's per-path metadata (stars, tags, ...). One list for the move of a
 * local file and of a shared one, so neither forgets a kind. Throws the first
 * failure, after trying every kind.
 */
export async function movePathDerivedRecords(from: string, to: string) {
  const { errors } = await moveDerivedRecords(from, to);
  if (errors.length) throw errors[0];
}

/** Every kind of record, each tried whatever the one before did; what did not finish is reported, not thrown. */
async function moveDerivedRecords(from: string, to: string) {
  const unfinished: LiberaMoveStep[] = [];
  const errors: unknown[] = [];
  const attempt = async (step: LiberaMoveStep["step"], run: () => Promise<LiberaMoveStep | void>) => {
    try { const held = await run(); if (held) unfinished.push(held); }
    catch (error) {
      console.error(`[files] ${step} did not follow ${from} to ${to}:`, error);
      errors.push(error);
      unfinished.push({ step, status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  await attempt("reviews", async () => {
    // A destination that gained comments meanwhile keeps them, and the review moving there stays where it was.
    const stayed = await moveReviewPaths(new Map([[from, to]]), { replaceEmpty: true });
    if (stayed.includes(from)) return { step: "reviews", status: "held", message: `The review comments of ${from} were kept at that path: ${to} has comments of its own.` };
  });
  await attempt("attachments", () => moveReferenceAttachments(from, to));
  await attempt("metadata", () => renameFileMetadataPath(from, to));
  return { unfinished, errors };
}

/**
 * The document, then its sidecars. If the sidecars can't follow, the document
 * goes back (the sidecars put themselves back), so the caller sees a failure
 * with everything at the old place. If the document can't go back, the error
 * says where it is. Neither move replaces what is at its destination: a file
 * that arrived there after the checks is kept and the move is refused (409);
 * `stillTheSource` runs right before the document moves.
 */
async function moveDocumentWithSidecars(move: FileMove, stillTheSource: () => Promise<unknown>) {
  await stillTheSource();
  await moveFileWithoutReplacing(move.currentPath, move.nextPath, { caseOnly: move.caseOnly });
  try {
    await moveRelatedMetadata(move.notebook, move.pathParts, move.nextNotebook, move.nextParts, move.currentFileType, move.nextFileType);
  } catch (error) {
    try { await moveFileWithoutReplacing(move.nextPath, move.currentPath, { caseOnly: move.caseOnly }); }
    catch { throw new StorageError(`${move.currentRelativePath} could not be moved, and could not be put back: it is now at ${move.nextRelativePath}. ${error instanceof Error ? error.message : ""}`.trim(), 500); }
    throw error;
  }
}

/** Throws when something that is not a folder blocks a folder the file's records would need at the destination. */
async function assertSidecarsCanMove(notebook: string, parts: string[], fromType: string, toType: string) {
  for (const kind of SIDECAR_KINDS) {
    if (!kind.appliesTo(fromType) || !kind.appliesTo(toType)) continue;
    await assertCanCreateParents(kind.filePath(notebook, parts), `${relativeFilePath(notebook, parts)} can't be moved here: a file is where its ${RECORD_NAMES[kind.id] ?? kind.id} would be kept. Remove it, then move again.`);
  }
}

/**
 * A change of file type (rename to another extension) never deletes a
 * record: refused when the file has records the new type has no use for. The
 * bytes are not converted; only caches are dropped.
 */
export async function assertTypeChangeLosesNothing(notebook: string, parts: string[], relative: string, fromType: LiberaFileType, toType: LiberaFileType, ignore?: ReadonlySet<string>) {
  if (fromType === toType) return;
  const names = new Set((await lostSidecarRecords(notebook, parts, fromType, toType, ignore)).map((kind) => RECORD_NAMES[kind] ?? kind));
  // A review follows only a text file (movePathWithReview).
  if (isTextFileType(fromType) && !isTextFileType(toType)) {
    const reviews = await inspectReviewDocuments<ReviewDocument>(getStateRoot(), relative);
    if (!reviews || !reviews.every(isEmptyReview)) names.add("review comments");
    if (await hasReviewEntry(relative)) names.add("pending agent changes");
  }
  // A note's images are kept by the notes that show them (Check Notebook reads Markdown notes only): a text file shows none, so they would be left unused.
  if (fromType === "markdown" && toType !== "markdown" && await embedsNotebookImages(notebook, parts, relative)) names.add("images");
  if (!names.size) return;
  const list = [...names];
  const text = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0];
  throw new StorageError(`${relative} has ${text} that a ${toType} file cannot keep. Remove them or keep the file type, then rename again.`, 409);
}

/** Whether the note shows an image kept in the notebook's `_assets` that is there. A note that can't be read is not shown to have none. */
async function embedsNotebookImages(notebook: string, parts: string[], relative: string) {
  let text: string;
  try { text = await readFile(filePathFromParts(notebook, parts), "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  for (const target of markdownImageTargets(relative, text)) {
    if (target.libraryPath?.split("/")[1] === MARKDOWN_ASSETS_DIR && target.absolutePath && await pathExists(target.absolutePath)) return true;
  }
  return false;
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

/** Published in one rename (staged beside it), so a crash or a reader never sees a half-written note. */
async function writeFileAtomically(target: string, content: string) {
  const staged = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, content, { encoding: "utf8", flag: "wx" });
    await rename(staged, target);
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
}

async function finishMarkdownImageMove(from: string, to: string, images: Awaited<ReturnType<typeof prepareMarkdownImageMove>>) {
  if (!images) return;
  const destination = splitFilePath(to);
  await writeFileAtomically(filePathFromParts(destination.notebook, destination.pathParts), images.content);
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

type ImageMove = Awaited<ReturnType<typeof prepareMarkdownImageMove>>;

/** A note's image rewrites as applied to its text, for its review baseline and undo history. */
const imageRewrite = (images: ImageMove) => (text: string) => images ? rewriteMarkdownImageSources(text, images.imageSources) : text;

/** The move itself, with the file's pending agent review following: written at the new path before the file moves, removed from the old one after (review-store.ts). */
function movePathWithReview(from: string, to: string, nextType: LiberaFileType, images: ImageMove, move: () => Promise<void>) {
  // A review path must name a text file; a file renamed to another kind leaves its review to be dropped.
  return isTextFileType(nextType) ? withMovedReview(from, to, imageRewrite(images), move) : move();
}

/**
 * After a file moved in the app: undo history of the agent runs that changed
 * it follows, and the text those records hold is rewritten as the move
 * rewrote the file (image paths, citation keys), as for a notebook migration.
 */
async function recordFileMove(from: string, to: string, fileType: LiberaFileType, images: ImageMove, references: ReferenceMoveResult | null) {
  if (!isTextFileType(fileType)) return;
  const draft = references?.drafts.find((candidate) => candidate.path === to);
  const keys = draft ? new Map(Object.entries(draft.map)) : null;
  const rewrite = imageRewrite(images);
  const transform = keys ? (text: string) => rewriteCitationKeys(rewrite(text), keys).text : rewrite;
  if (keys) await transformReviewBaselines(new Map([[to, (text: string) => rewriteCitationKeys(text, keys).text]]));
  let hashes: { before: string; after: string } | undefined;
  if (images && (keys || images.content !== images.previous)) {
    const target = splitFilePath(to);
    const now = await readFile(filePathFromParts(target.notebook, target.pathParts), "utf8").catch(() => null);
    // A run that wrote the text as it was before the move counts as having written it as it is now.
    if (now !== null) hashes = { before: hashText(images.previous), after: hashText(now) };
  }
  // Imported here: snapshots reaches back into storage through shared-writes.
  const { recordMovedRunFiles } = await import("@/lib/agent/snapshots");
  await recordMovedRunFiles(new Map([[from, { to, ...(images || keys ? { transform } : {}), ...(hashes ? { hashes } : {}) }]]));
}

/** After a folder moved in the app: undo history of the files under it follows. */
async function recordFolderMove(from: string, to: string) {
  const { recordMovedRunFolder } = await import("@/lib/agent/snapshots");
  await recordMovedRunFolder(from, to);
}

const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

// What a file's records are called when a move refuses to take them over.
const RECORD_NAMES: Record<string, string> = {
  "pdf-annotations": "annotations", "image-annotations": "annotations", "pdf-outline": "outline", transcript: "transcript",
  definitions: "definitions", ink: "ink", python: "Python code",
};

/**
 * A path can still hold the records of a file deleted outside the app. A move
 * onto it would destroy those of a kind the moving file has and hand the rest
 * to it (a star, annotations): refused, to be settled by Check Notebook.
 * Caches are made again, so they may be replaced; so may an empty review,
 * which is what opening a note makes.
 */
export async function assertNoLeftoverRecords(notebook: string, parts: string[], fileType: string, ownSidecars = false, moving?: string[], again = "move") {
  const names = await leftoverRecords(notebook, parts, fileType, ownSidecars, moving);
  if (!names.length) return;
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  throw new LeftoverRecordsError(`${relativeFilePath(notebook, parts)} still has the ${list} of a file that was there before. Check the notebook to give them to a file or remove them, then ${again} again.`, 409);
}

/**
 * What records of a file that was there before a path still holds (assertNoLeftoverRecords). Reads only.
 * One reader for every destination check (destination-records.ts). A store that can't be read refuses
 * the move (409): it can't be shown that nothing is there.
 * `ownSidecars`: the path is the file's own under another spelling of its name (a case-only rename), so the sidecar paths found there are the file's, not an earlier file's.
 * `moving`: the file moving there from the same notebook, which is not a rival owner of older-layout notes.
 */
async function leftoverRecords(notebook: string, parts: string[], fileType: string, ownSidecars = false, moving?: string[]) {
  const records = await destinationRecords();
  if (records.blocker) throw new LeftoverRecordsError(records.blocker, 409);
  return records.at(notebook, parts, fileType, { ownSidecars, moving });
}

/**
 * A folder renamed onto a vacant name may find the records of files that were
 * there before (deleted outside the app): refused like a file move, before
 * anything moves. `ownSidecars`: the name is the folder's own under another spelling.
 */
export async function assertNoLeftoverFolderRecords(notebook: string, parts: string[], ownSidecars = false, incomingNotes: string[] = []) {
  const names = await leftoverFolderRecords(notebook, parts, ownSidecars, incomingNotes);
  if (!names.length) return;
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  throw new StorageError(`${relativeFilePath(notebook, parts)} still has the ${list} of files that were there before. Check the notebook to give them to a file or remove them, then rename again.`, 409);
}

/**
 * What records of files that were there before a folder name still holds (assertNoLeftoverFolderRecords). Reads only.
 * `incomingNotes`: the paths the moving folder's notes will take, whose Python code may already be there.
 */
async function leftoverFolderRecords(notebook: string, parts: string[], ownSidecars = false, incomingNotes: string[] = []) {
  const prefix = `${relativeFilePath(notebook, parts)}/`;
  const kept = new Set<string>();
  if (!ownSidecars && (await pythonCodeAt(incomingNotes)).length) kept.add(RECORD_NAMES.python);
  if (!ownSidecars) {
    for (const kind of SIDECAR_KINDS) {
      if (!kind.cache && await holdsFiles(kind.directoryPath(notebook, parts))) kept.add(RECORD_NAMES[kind.id] ?? kind.id);
    }
  }
  const reviews = await inspectReviewKeys(getStateRoot());
  if (reviews.damaged) kept.add("review comments");
  for (const key of new Set(reviews.keys.filter((candidate) => candidate.startsWith(prefix)))) {
    const documents = await inspectReviewDocuments<ReviewDocument>(getStateRoot(), key);
    if (!documents || !documents.every(isEmptyReview)) { kept.add("review comments"); break; }
  }
  if ((await listReviewEntryPaths()).paths.some((candidate) => candidate.startsWith(prefix))) kept.add("pending agent changes");
  const metadata = await readWorkspaceMetadata();
  if (metadata.starredFilePaths.some((candidate) => candidate.startsWith(prefix))) kept.add("star");
  if (Object.keys(metadata.fileTags).some((candidate) => candidate.startsWith(prefix))) kept.add("tags");
  for (const library of await libraryNotebookNames()) {
    const inspected = await inspectReferenceLibrary(library).catch(() => null);
    if (!inspected || "damaged" in inspected) continue;
    if (Object.values(inspected.library?.entries ?? {}).some((entry) => entry.attachments.some((attachment) => attachment.kind !== "url" && attachment.path.startsWith(prefix)))) { kept.add("reference attachment"); break; }
  }
  return [...kept];
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

/**
 * A folder moved (renamed or archived) and its records with it: paths in
 * notes follow it (move-links.ts), and the tree comes back with what they did.
 */
async function folderMovePayload(from: string, to: string): Promise<LiberaFolderMovePayload> {
  const { links, unfinished } = await followMovedLinks([{ from, to, folder: true }]);
  return {
    ...await getTree(),
    ...(links.rewritten.length || links.skipped.length || links.unchecked.length ? { links } : {}),
    ...(unfinished ? { unfinished: [unfinished] } : {}),
  };
}

export async function renameFolder(relativePath: string, nextName: string): Promise<LiberaFolderMovePayload> {
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
  return withPathLocks([currentPath, nextPath], async () => {
    assertNotSharedItem(current.notebook, current.pathParts);
    await assertNotMigrating(itemLibraryPath(current.notebook, current.pathParts));
    await assertNothingMigratingWithin(itemLibraryPath(current.notebook, current.pathParts));
    assertNotSharedItem(current.notebook, nextParts);
    await assertNotMigrating(itemLibraryPath(current.notebook, nextParts));

    await assertDirectoryExists(currentPath, "Folder was not found.");

    if (currentPath === nextPath) {
      return getTree();
    }

    // The same folder under another spelling (a case-only rename on a case-insensitive disk) is not a clash.
    const caseOnly = await isCaseOnlyRename(currentPath, nextPath);
    if (!caseOnly && await pathExists(nextPath)) {
      throw new StorageError("Destination folder already exists.", 409);
    }
    // Scanned before anything moves: a folder that can't be read in full refuses here.
    const notes = await markdownPathsInFolder(current.notebook, current.pathParts);
    const from = relativeFilePath(current.notebook, current.pathParts);
    const to = relativeFilePath(current.notebook, nextParts);
    await assertNoLeftoverFolderRecords(current.notebook, nextParts, caseOnly, notes.map((note) => `${to}${note.slice(from.length)}`));

    await migratePdfAnnotationDirectory(current.notebook, current.pathParts);
    await migrateImageAnnotationDirectory(current.notebook, current.pathParts);
    for (const note of notes) await migratePythonSidecar(note);
    // Image URLs are relative to the notebook root, so their paths stay stable.
    await moveFolderWithRecords(current.notebook, current.pathParts, nextParts, currentPath, nextPath, notes, caseOnly);
    notifySearchChanges();

    return folderMovePayload(from, to);
  });
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
  return withPathLocks([currentPath, itemPath(current.notebook, [ARCHIVE_DIR])], async () => {
    assertNotSharedItem(current.notebook, current.pathParts);
    await assertNotMigrating(itemLibraryPath(current.notebook, current.pathParts));
    await assertNothingMigratingWithin(itemLibraryPath(current.notebook, current.pathParts));
    await assertDirectoryExists(currentPath, "Folder was not found.");

    // Scanned before anything moves: a folder that can't be read in full refuses here.
    const notes = await markdownPathsInFolder(current.notebook, current.pathParts);
    const currentRelativePath = relativeFilePath(current.notebook, current.pathParts);

    const archiveDirectoryPath = itemPath(current.notebook, [ARCHIVE_DIR]);
    await mkdir(archiveDirectoryPath, { recursive: true });

    const currentName = current.pathParts.at(-1) ?? "";
    // The archive picks its own name: one that holds no folder, nor records (Python code of the notes included) of files that were there before.
    const incoming = (name: string) => notes.map((note) => `${relativeFilePath(current.notebook, [ARCHIVE_DIR, name])}${note.slice(currentRelativePath.length)}`);
    let available = await findAvailableDirectoryPath(archiveDirectoryPath, currentName);
    const indexBlocker = await reviewIndexBlocker();
    if (indexBlocker) throw new StorageError(indexBlocker, 409);
    for (let index = 1; (await leftoverFolderRecords(current.notebook, [ARCHIVE_DIR, available.name], false, incoming(available.name))).length; index += 1) {
      available = await findAvailableDirectoryPath(archiveDirectoryPath, `${currentName}-${index}`);
    }
    const nextParts = [ARCHIVE_DIR, available.name];
    const nextRelativePath = relativeFilePath(current.notebook, nextParts);

    await migratePdfAnnotationDirectory(current.notebook, current.pathParts);
    await migrateImageAnnotationDirectory(current.notebook, current.pathParts);
    for (const note of notes) await migratePythonSidecar(note);
    await moveFolderWithRecords(current.notebook, current.pathParts, nextParts, currentPath, available.path, notes);
    notifySearchChanges();

    return { ...await folderMovePayload(currentRelativePath, nextRelativePath), moved: { from: currentRelativePath, to: nextRelativePath } };
  });
}

export async function deleteFolder(relativePath: string) {
  await ensureAdminRoot();
  const current = splitDirectoryPath(relativePath);

  if (!current.pathParts.length) {
    throw new StorageError("Use notebook delete to remove a notebook.");
  }

  const targetPath = itemPath(current.notebook, current.pathParts);
  return withPathLocks([targetPath], async () => {
    assertNotSharedItem(current.notebook, current.pathParts);
    await assertNotMigrating(itemLibraryPath(current.notebook, current.pathParts));
    await assertNothingMigratingWithin(itemLibraryPath(current.notebook, current.pathParts));
    await assertDirectoryExists(targetPath, "Folder was not found.");
    // The folder's own notes, read in full before anything is deleted: a note the scan missed would keep its code and images.
    const markdown = await markdownDocumentsInFolder(current.notebook, current.pathParts);
    await migratePdfAnnotationDirectory(current.notebook, current.pathParts);
    await migrateImageAnnotationDirectory(current.notebook, current.pathParts);
    await rm(targetPath, { recursive: true });
    await removeFolderSidecars(current.notebook, current.pathParts);
    for (const document of markdown) await deletePythonSidecar(document.documentPath);
    const imagesCleaned = await cleanupMarkdownImageAssets(current.notebook, markdown);
    await deleteReviewPath(relativeFilePath(current.notebook, current.pathParts));
    await discardReviewsUnder(relativeFilePath(current.notebook, current.pathParts));
    await detachReferenceAttachments(relativeFilePath(current.notebook, current.pathParts));
    await removeFileMetadataPathPrefix(relativeFilePath(current.notebook, current.pathParts));
    await removeNotebookPanelExpandedPathPrefix(
      relativeFilePath(current.notebook, current.pathParts),
    );
    notifySearchChanges();
    // Not silent: the folder and its records are gone, but images in _assets could not be checked against the rest of the notebook.
    if (!imagesCleaned) throw new StorageError(`${relativePath} was deleted, but the images its notes uploaded were left behind, because the notebook could not be read in full to check that no other note uses them. Check Notebook lists them.`, 409);

    return getTree();
  });
}

export async function moveFileToDirectory(
  relativePath: string,
  destinationDirectory: string,
  destinationName?: string,
  options: LocalFileActionOptions = {},
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

  const caseOnly = await isCaseOnlyRename(currentPath, nextPath);
  if (!caseOnly && await pathExists(nextPath)) {
    throw new StorageError(DESTINATION_TAKEN, 409);
  }

  return performFileMove({
    notebook: current.notebook, pathParts: current.pathParts, nextNotebook: destination.notebook, nextParts,
    currentPath, nextPath, currentRelativePath, nextRelativePath, currentFileType, nextFileType, caseOnly,
  }, options);
}

/**
 * Moves a file into the notebook's archive under a name of its own. The same
 * preflight, commit and rollback as any move (performFileMove), so a record
 * that can't follow leaves the file where it was.
 */
export async function archiveFile(relativePath: string, options: LocalFileActionOptions = {}): Promise<LiberaFileMovePayload> {
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
  // The archive picks its own name: one that holds no file, nor records of a file that was there before.
  // A name taken meanwhile (a file or records that arrived after the check, seen under the move's locks) is
  // given up and the next one tried; the checks themselves are the move's own (performLockedFileMove).
  const extension = path.extname(current.name);
  const stem = path.basename(current.name, extension);
  const currentPath = filePathFromParts(current.notebook, current.pathParts);
  let records = await destinationRecords();
  for (let index = 0; index <= MAX_NAME_ATTEMPTS; index += 1) {
    if (records.blocker) throw new StorageError(records.blocker, 409);
    const safeNextName = index ? `${stem}-${index}${extension}` : current.name;
    const nextParts = [ARCHIVE_DIR, safeNextName];
    const nextPath = path.join(archiveDirectoryPath, safeNextName);
    if (await pathExists(nextPath) || (await records.at(current.notebook, nextParts, currentFileType)).length) continue;
    try {
      // Archive is a move: links to the file, and the file's own, follow it like any other.
      return await performFileMove({
        notebook: current.notebook, pathParts: current.pathParts, nextNotebook: current.notebook, nextParts,
        currentPath, nextPath,
        currentRelativePath: relativeFilePath(current.notebook, current.pathParts), nextRelativePath: relativeFilePath(current.notebook, nextParts),
        currentFileType, nextFileType: assertSupportedFileName(safeNextName), caseOnly: false,
      }, options);
    } catch (error) {
      if (!(error instanceof LeftoverRecordsError || (error instanceof StorageError && error.status === 409 && error.message === DESTINATION_TAKEN))) throw error;
      records = await destinationRecords();
    }
  }
  throw new StorageError(`No free name was found in the archive for ${current.name}. Check the notebook, then try again.`, 409);
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
  assertCopyKeepsType(currentFileType, requestedName);
  const destinationPath = itemPath(destination.notebook, destination.pathParts);
  // Copying out of a shared notebook is a read; copying into one is a write.
  assertNotSharedItem(destination.notebook, [...destination.pathParts, requestedName]);
  await assertNotMigrating(itemLibraryPath(destination.notebook, [...destination.pathParts, requestedName]));

  await assertDirectoryExists(destinationPath, "Destination folder was not found.");
  // A shared notebook's disk copy can lag what collaborators see (a
  // follower's cloud copy, a write still waiting): copy the shared version,
  // read before anything is created so a failure leaves nothing behind.
  // The host's version, read once: its text, or a blob's bytes. An entry the host no
  // longer lists was deleted or moved by a collaborator: refused, never built from
  // the bytes a lagging disk still holds. Only when there is no host to ask is the disk the copy.
  const sharedSource = isSharedNotebookPath(relativePath);
  const snapshot = sharedSource ? await readSharedSourceSnapshot(relativePath, isTextFileType(currentFileType)) : null;
  if (snapshot?.authority && snapshot.kind === "absent") throw sharedSourceGone(relativePath);
  const sharedBody = snapshot?.authority ? (snapshot.kind === "text" ? Buffer.from(snapshot.text, "utf8") : snapshot.kind === "blob" ? snapshot.bytes : null) : null;
  const livePdf = sharedSource && currentFileType === "pdf" ? await livePdfAnnotationsForCopy(relativePath) : null;

  let available;
  for (;;) {
    available = await findAvailableCopyPath(destination.notebook, destination.pathParts, requestedName, currentFileType);
    try {
      // The supplied bytes are published exclusively: the follower's own file is not needed.
      if (sharedBody) await writeFile(available.path, sharedBody, { flag: "wx" });
      else await copyFile(filePathFromParts(current.notebook, current.pathParts), available.path, constants.COPYFILE_EXCL);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const safeNextName = available.name;
  const nextParts = [...destination.pathParts, safeNextName];

  if (currentFileType === "pdf") await migratePdfAnnotations(current.notebook, current.pathParts);
  if (currentFileType === "image") await migrateImageAnnotations(current.notebook, current.pathParts);
  let images: Awaited<ReturnType<typeof copyMarkdownImageAssets>> | undefined;
  if (currentFileType === "markdown") {
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
  try {
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
  } catch (error) {
    // The copy is not made: no file, and none of the records or images it had started to take, are left at the destination (it was free of them when the name was chosen).
    await images?.discard().catch(() => undefined);
    await removeFileSidecars(destination.notebook, nextParts, currentFileType).catch(() => undefined);
    await rm(available.path, { force: true }).catch(() => undefined);
    throw error;
  }

  const copyPath = relativeFilePath(destination.notebook, nextParts);
  // A copy in another notebook cites what that notebook's library holds: references are copied or
  // mapped as for a move, and the copied review's snapshot follows the same key map.
  const references = await copyCitedReferences(current.notebook, destination.notebook, relativePath, copyPath);
  const keys = references?.drafts.find((draft) => draft.path === copyPath)?.map;
  await copyReviewPath(relativePath, copyPath, keys ? (text) => rewriteCitationKeys(text, new Map(Object.entries(keys))).text : undefined);
  // A copy is a new file: no reference is attached to it, and the original keeps its references.
  notifySearchChanges([copyPath]);
  return withReferences(await readLiberaFile(copyPath), references);
}

/**
 * A copy keeps the file's type: its bytes, records and viewer all follow the
 * source, so another extension would open a PDF as an image or leave a note's
 * records on a plain text file. Changing type is a rename, which checks what
 * the records can keep.
 */
export function assertCopyKeepsType(sourceType: LiberaFileType, name: string) {
  if (assertSupportedFileName(name) !== sourceType) {
    throw new StorageError(`A copy keeps its file type (${sourceType}): "${name}" would be another type. Keep the extension, or rename the copy afterwards.`, 400);
  }
}

/**
 * A free name for a copy: no file there, and none of the records of a file
 * that was there before (annotations, review comments, tags, ...), which the
 * copy would otherwise take over or replace. Reads only.
 */
export async function findAvailableCopyPath(notebook: string, directoryParts: string[], fileName: string, fileType: string) {
  const records = await destinationRecords();
  // A store that can't be read shows every name taken: report it instead of looking on (as the archive does).
  if (records.blocker) throw new StorageError(records.blocker, 409);
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  for (let index = 0; index <= MAX_NAME_ATTEMPTS; index += 1) {
    const name = index ? `${stem}-${index}${extension}` : fileName;
    const target = itemPath(notebook, [...directoryParts, name]);
    if (await pathExists(target) || (await records.at(notebook, [...directoryParts, name], fileType)).length) continue;
    return { name, path: target };
  }
  throw new StorageError(`No free name was found for ${fileName}. Check the notebook, then try again.`, 409);
}

/**
 * `expectedFileId`: the identity the caller saw for the file it chose. Checked under the file's lock,
 * right before the delete, so a file put at the path since is refused (409), not deleted.
 */
export async function deleteFile(relativePath: string, { expectedFileId }: { expectedFileId?: string } = {}) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  const fileType = assertSupportedFileName(name);
  assertNotSharedItem(notebook, pathParts);
  await assertNotMigrating(itemLibraryPath(notebook, pathParts));
  const absolute = filePathFromParts(notebook, pathParts);

  await withPathLocks([absolute], async () => {
    if (expectedFileId !== undefined) await assertSourceIsStill(absolute, relativePath, expectedFileId);
    if (fileType === "pdf") await migratePdfAnnotations(notebook, pathParts);
    if (fileType === "image") await migrateImageAnnotations(notebook, pathParts);
    const markdown = fileType === "markdown" ? await readFile(absolute, "utf8") : null;
    await rm(absolute);
    await removeFileSidecars(notebook, pathParts, fileType);

    if (markdown !== null) {
      await cleanupMarkdownImageAssets(notebook, [{ documentPath: relativePath, content: markdown }]);
    }
    await deleteReviewPath(relativeFilePath(notebook, pathParts));
    await discardReviewsAt(relativeFilePath(notebook, pathParts));
    await detachReferenceAttachments(relativeFilePath(notebook, pathParts));
    await removeFileMetadataPath(relativeFilePath(notebook, pathParts));
    notifySearchChanges([relativeFilePath(notebook, pathParts)]);
  });

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
  // A name with no file and none of the records of a file that was there before (the copy would take them over).
  let available;
  for (let attempt = 0; ; attempt += 1) {
    available = await findAvailableCopyPath(notebook, directoryParts, `${path.basename(name, path.extname(name))} (edited)${extension}`, "image");
    try { await writeFile(available.path, body, { flag: "wx" }); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= MAX_NAME_ATTEMPTS) throw error; }
  }
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

/**
 * A step of a folder move. `run` may return its own way back, for a step that
 * knows exactly which transfers it completed (and rolls back its own failure);
 * otherwise `undo` takes the whole step back.
 */
type FolderMoveStep = { run: () => Promise<unknown>; undo?: () => Promise<unknown> };

/**
 * Moves a folder and everything keyed by its path (sidecars, Python code,
 * reviews, undo history, references, metadata). The folder moves first; if a
 * later step fails (a locked or newly occupied sidecar destination), the
 * completed steps are taken back in reverse so the folder never ends
 * half-moved. Only transfers that completed are reversed. A take-back that
 * fails is reported with what is stuck, after the original error's message.
 */
async function moveFolderWithRecords(notebook: string, fromParts: string[], toParts: string[], fromPath: string, toPath: string, notes: string[], caseOnly = false) {
  const from = relativeFilePath(notebook, fromParts);
  const to = relativeFilePath(notebook, toParts);
  const steps: FolderMoveStep[] = [
    // Published without replacing anything at the destination (an empty folder made there meanwhile is kept, not overwritten).
    { run: () => withMovedReviewsUnder(from, to, () => publishFolder(fromPath, toPath, caseOnly)), undo: () => withMovedReviewsUnder(to, from, () => moveFileWithoutReplacing(toPath, fromPath, { caseOnly })) },
    { run: () => moveFolderSidecars(notebook, fromParts, notebook, toParts) },
    { run: () => moveFolderPythonSidecars(notes, from, to) },
    // An empty review already at a destination gives way, so the moved review is the one that is found (as for a single file).
    { run: () => moveReviewPath(from, to, { replaceEmpty: true }), undo: () => moveReviewPath(to, from) },
    { run: () => recordFolderMove(from, to), undo: () => recordFolderMove(to, from) },
    { run: () => moveReferenceAttachments(from, to), undo: () => moveReferenceAttachments(to, from) },
    { run: () => renameFileMetadataPathPrefix(from, to), undo: () => renameFileMetadataPathPrefix(to, from) },
    { run: () => renameNotebookPanelExpandedPathPrefix(from, to), undo: () => renameNotebookPanelExpandedPathPrefix(to, from) },
  ];
  const done: (() => Promise<unknown>)[] = [];
  for (const step of steps) {
    try {
      const back = await step.run();
      done.push(typeof back === "function" ? back as () => Promise<unknown> : step.undo ?? (async () => undefined));
    } catch (error) {
      const stuck: string[] = [];
      for (const undo of done.reverse()) {
        try { await undo(); } catch (undoError) { stuck.push(undoError instanceof Error ? undoError.message : String(undoError)); }
      }
      if (stuck.length) throw new StorageError(`${error instanceof Error ? error.message : String(error)} ${stuck.join(" ")}`, 500);
      throw error;
    }
  }
}

/** The folder itself, never replacing anything at its destination (a folder, even an empty one, made there meanwhile is refused: 409). */
async function publishFolder(fromPath: string, toPath: string, caseOnly: boolean) {
  try { await moveFileWithoutReplacing(fromPath, toPath, { caseOnly }); }
  catch (error) {
    if (error instanceof StorageError && error.status === 409) throw new StorageError("Destination folder already exists.", 409);
    throw error;
  }
}

/** The notes' Python code follows them (its paths follow the notes', markdown-assets.ts). Never replaces code at a destination; a failure puts back exactly the code that moved. */
async function moveFolderPythonSidecars(notes: string[], from: string, to: string) {
  const moved: string[] = [];
  const target = (note: string) => `${to}${note.slice(from.length)}`;
  const undo = async () => {
    const stuck: string[] = [];
    for (const note of [...moved].reverse()) {
      try { await movePythonSidecar(target(note), note, { replace: false }); } catch { stuck.push(`the Python code of ${note} is now at ${target(note)}.`); }
    }
    moved.length = 0;
    if (stuck.length) throw new StorageError(`Could not put back: ${stuck.join(" ")}`, 500);
  };
  try {
    for (const note of notes) {
      // Only code this note had is recorded as moved: a note with none must not take back code that arrived at its new path.
      const had = (await pythonCodeAt([note])).length > 0;
      if (!(await movePythonSidecar(note, target(note), { replace: false }))) throw new StorageError(`${target(note)} already has Python code of a file that was there before, so the code of ${note} was left where it is.`, 409);
      if (had) moved.push(note);
    }
  } catch (error) {
    try { await undo(); }
    catch (stuck) { throw new StorageError(`${error instanceof Error ? error.message : String(error)} ${(stuck as Error).message}`, 500); }
    throw error;
  }
  return undo;
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
      { exclusive: true },
    );
    await copyPdfTextCache(currentNotebook, currentPathParts, nextNotebook, nextPathParts);
    // The outline describes the bytes, which the copy shares.
    await copyFileIfExists(pdfOutlinePath(currentNotebook, currentPathParts), pdfOutlinePath(nextNotebook, nextPathParts), { exclusive: true });
  }

  if (currentFileType === "image") {
    await copyFileIfExists(
      imageAnnotationsPath(currentNotebook, currentPathParts),
      imageAnnotationsPath(nextNotebook, nextPathParts),
      { exclusive: true },
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
    await copyFileIfExists(definitionsPath(currentNotebook, currentPathParts), definitionsPath(nextNotebook, nextPathParts), { exclusive: true });
  }

  if (supportsInk(currentFileType)) await copyInkFolder(currentNotebook, currentPathParts, nextNotebook, nextPathParts);
}

function supportsDefinitionsType(fileType: string) {
  return DEFINITIONS_FILE_TYPES.some((type) => type === fileType);
}
