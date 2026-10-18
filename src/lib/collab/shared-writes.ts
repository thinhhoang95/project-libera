// Server-side writes to shared files (collaboration map §7.6, M1.11).
//
// A shared notebook's files are working copies the collab host writes from
// the CRDT, so Libera's own writers (the agent, OCR, uploads, image saves)
// must change them through the host's control API: text as minimal edits
// with provenance, new files and binaries as manifest file operations. Then
// every change is attributed, reaches collaborators, and is never mistaken
// for an "external" edit of the working copy.
//
// Nothing here falls back to the disk. When the host is unavailable
// (collaboration disabled for this launch, or the host not running) every
// helper throws a 503 SharedWriteError and nothing is written.
//
// Errors are StorageErrors, so routes that answer `toStorageError(error)`
// and the agent's tool loop report the message as it is.

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { diffText } from "../../../electron/collab/notebooks/text-diff";
import { hasEdits, type PhotoEdits } from "@/lib/photo-edits";
import { StorageError } from "@/lib/storage/errors";
import { assertMarkdownFileName, assertSupportedFileName, ensureImageName, ensureMarkdownName, normalizeAssetFileName } from "@/lib/storage/file-types";
import { assertDirectoryExists, findAvailableFilePath, pathExists } from "@/lib/storage/fs-utils";
import {
  assertSafeSegment,
  ensureAdminRoot,
  filePathFromParts,
  itemPath,
  markdownAssetsDirectoryPathFromParts,
  markdownAssetsPathPrefix,
  relativeFilePath,
  splitDirectoryPath,
  splitFilePath,
} from "@/lib/storage/paths";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { getFileNode, getTree } from "@/lib/storage/tree";
import { readLiberaFile } from "@/lib/storage/files";
import { removeFileMetadataPath, renameFileMetadataPath, removeFileMetadataPathPrefix, renameFileMetadataPathPrefix, removeNotebookPanelExpandedPathPrefix, renameNotebookPanelExpandedPathPrefix } from "@/lib/storage/workspace-metadata";
import { getMarkdownImageAssetBySource, markdownImageSources } from "@/lib/storage/markdown-assets";
import { isTextFileType, type LiberaFileNode, type LiberaTree, type MarkdownImageAssetPayload } from "@/lib/types";
import { CollabHostError, applyEdits, collabHostConfig, createSuggestions, createThreadAtRange, fileOp, getDocText, resolveSharedPath, withdrawSuggestions, type HostClientConfig } from "./host-client";
import type { CreateThreadAtRangeResponse, DocText, ResolvedDoc, TextEdit, WithdrawSuggestionsResponse } from "./local-api";
import type { AiActorHint, Provenance } from "./protocol/actor";
import { canWriteSubdoc } from "./protocol/roles";
import { isSharedNotebookPath, sharedManifestPath } from "./shared-notebook";

/** A refused or failed shared write. `code` is the host's error code (or one of ours). */
export class SharedWriteError extends StorageError {
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message, status);
    this.name = "SharedWriteError";
    this.code = code;
  }
}

/**
 * The control API caps request bodies at 16 MB, and base64 adds a third.
 * Larger files cannot be added to a shared notebook through the host yet.
 */
export const MAX_SHARED_BLOB_BYTES = 11 * 1024 * 1024;

export interface SharedWriteOptions {
  /** Defaults to the host this launch was given (LIBERA_COLLAB_HOST_URL/TOKEN). */
  config?: HostClientConfig | null;
}

function hostConfig(liberaPath: string, options: SharedWriteOptions): HostClientConfig {
  const config = options.config === undefined ? collabHostConfig() : options.config;
  if (!config) {
    throw new SharedWriteError(
      503,
      "collab-disabled",
      `${liberaPath} is in a shared notebook, and collaboration is not running in this Libera, so it cannot be changed now. Nothing was written.`,
    );
  }
  return config;
}

/** Host errors as SharedWriteErrors that name the file; anything else is rethrown. */
function asSharedWriteError(liberaPath: string, error: unknown): never {
  if (error instanceof SharedWriteError) throw error;
  if (error instanceof CollabHostError) {
    const message = error.code === "collab-unavailable" || error.code === "collab-disabled"
      ? `${liberaPath} is in a shared notebook, and the collaboration service is not running, so it cannot be changed now. Nothing was written. ${error.message}`
      : `Could not change ${liberaPath} in the shared notebook: ${error.message}`;
    throw new SharedWriteError(error.status, error.code, message);
  }
  throw error;
}

async function host<T>(liberaPath: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return asSharedWriteError(liberaPath, error);
  }
}

/** Whether the role on a shared document may change its text. */
export function canEditSharedContent(doc: Pick<ResolvedDoc, "role" | "readOnly">): boolean {
  return !doc.readOnly && canWriteSubdoc(doc.role, "content");
}

/** The shared document behind a Libera path in a shared notebook. Throws when it is not one or the host is unavailable. */
export async function requireSharedDoc(liberaPath: string, options: SharedWriteOptions = {}): Promise<ResolvedDoc> {
  const config = hostConfig(liberaPath, options);
  const doc = await host(liberaPath, () => resolveSharedPath(liberaPath, config));
  if (!doc) {
    throw new SharedWriteError(
      404,
      "not-shared-document",
      `${liberaPath} is in a shared notebook but is not one of its documents (it may still be syncing, or the file type is not shared as text).`,
    );
  }
  return doc;
}

/** The document's current text from the host, which is newer than the working copy on disk. */
export async function readSharedText(liberaPath: string, options: SharedWriteOptions & { doc?: ResolvedDoc } = {}): Promise<{ doc: ResolvedDoc; text: string; status: DocText["status"] }> {
  const config = hostConfig(liberaPath, options);
  const doc = options.doc ?? (await requireSharedDoc(liberaPath, { config }));
  const current = await host(liberaPath, () => getDocText(doc.docId, config));
  return { doc, text: current.text, status: current.status };
}

/**
 * Minimal edits from `before` to `after`, each carrying the text it replaces
 * so the host refuses the batch if the document moved on. Only the changed
 * characters are replaced, which keeps collaborators' cursors, comment
 * anchors and concurrent edits elsewhere intact.
 */
export function sharedTextEdits(before: string, after: string): TextEdit[] {
  return diffText(before, after).map((edit) => ({ start: edit.start, end: edit.end, text: edit.text, before: before.slice(edit.start, edit.end) }));
}

export interface SharedTextWriteResult {
  /** True when the edits were applied; false for a conflict, or when the text was already `nextText`. */
  applied: boolean;
  /** The document's text after the call (the current text on a conflict). */
  text: string;
  /** The document no longer matched `expectedBefore`, or changed between reading and writing. */
  conflict: boolean;
  doc: ResolvedDoc;
}

/**
 * Changes a shared document's text to `nextText` as minimal edits with
 * `provenance`. With `expectedBefore`, refuses (conflict) unless the live
 * text is exactly that, so a caller that built `nextText` from an earlier
 * read never overwrites a collaborator's newer edit.
 */
export async function writeSharedText(
  liberaPath: string,
  nextText: string,
  provenance: Provenance,
  options: SharedWriteOptions & { expectedBefore?: string; doc?: ResolvedDoc } = {},
): Promise<SharedTextWriteResult> {
  const config = hostConfig(liberaPath, options);
  const doc = options.doc ?? (await requireSharedDoc(liberaPath, { config }));
  if (!canEditSharedContent(doc)) {
    throw new SharedWriteError(
      403,
      "forbidden",
      doc.readOnly
        ? `${liberaPath} is read-only: access to its shared notebook was revoked.`
        : `Your role in this shared notebook (${doc.role}) cannot edit ${liberaPath}.`,
    );
  }
  const current = await host(liberaPath, () => getDocText(doc.docId, config));
  if (options.expectedBefore !== undefined && current.text !== options.expectedBefore) {
    return { applied: false, text: current.text, conflict: true, doc };
  }
  if (current.text === nextText) return { applied: false, text: current.text, conflict: false, doc };
  const edits = sharedTextEdits(current.text, nextText);
  const response = await host(liberaPath, () => applyEdits(doc.docId, { edits, provenance }, config));
  return { applied: response.applied, text: response.text, conflict: !response.applied, doc };
}

/** Access to the document's notebook was revoked. Hosts before `revoked` existed said so only through readOnly on an editor role. */
function isRevoked(doc: Pick<ResolvedDoc, "role" | "readOnly" | "revoked">): boolean {
  return doc.revoked === true || (doc.revoked === undefined && doc.readOnly && canWriteSubdoc(doc.role, "content"));
}

/**
 * Whether the role on a shared document may suggest (and comment):
 * commenters, editors and owners. `readOnly` alone does not say no: it is
 * set for commenters, whose text is read-only but whose suggestions are not.
 */
export function canSuggestShared(doc: Pick<ResolvedDoc, "role" | "readOnly" | "revoked">): boolean {
  return !isRevoked(doc) && canWriteSubdoc(doc.role, "annotations");
}

export interface SharedSuggestResult {
  doc: ResolvedDoc;
  suggestionIds: string[];
  /** Suggestions created stale: their passage changed after `before` was read. */
  staleCount: number;
  /** The document's text now (unchanged by suggesting). */
  text: string;
}

/**
 * Proposes changing a shared document from `before` (the text the caller
 * read) to `nextText` as overlay suggestions acting for the user (plan
 * M3.4): `content` is untouched until someone who may decide accepts them.
 * Edits are made on `before` and mapped onto the live text by the host, so
 * a collaborator's edit elsewhere only shifts them; a passage that changed
 * meanwhile becomes a stale suggestion. Several edits are one group.
 */
export async function suggestSharedText(
  liberaPath: string,
  before: string,
  nextText: string,
  ai: AiActorHint & { title?: string; reason?: string },
  options: SharedWriteOptions & { doc?: ResolvedDoc } = {},
): Promise<SharedSuggestResult> {
  const config = hostConfig(liberaPath, options);
  const doc = options.doc ?? (await requireSharedDoc(liberaPath, { config }));
  if (!canSuggestShared(doc)) {
    throw new SharedWriteError(
      403,
      "forbidden",
      isRevoked(doc) ? `${liberaPath} is read-only: access to its shared notebook was revoked.` : `Your role in this shared notebook (${doc.role}) cannot suggest changes to ${liberaPath}.`,
    );
  }
  const edits = sharedTextEdits(before, nextText);
  if (!edits.length) {
    const current = await host(liberaPath, () => getDocText(doc.docId, config));
    return { doc, suggestionIds: [], staleCount: 0, text: current.text };
  }
  const { title, reason, ...hint } = ai;
  const response = await host(liberaPath, () => createSuggestions(doc.docId, {
    edits,
    snapshot: before,
    ai: hint,
    // One tool call's edits are one change: accepted or rejected together.
    ...(edits.length > 1 ? { groupId: `ai-${randomUUID()}` } : {}),
    ...(title ? { title } : {}),
    ...(reason ? { reason } : {}),
  }, config));
  const current = await host(liberaPath, () => getDocText(doc.docId, config));
  return { doc, suggestionIds: response.suggestionIds, staleCount: response.staleIndexes.length, text: current.text };
}

/** Withdraws the user's pending suggestions on a shared document made by one AI run (agent undo). */
export async function withdrawSharedRun(liberaPath: string, docId: string, runId: string, options: SharedWriteOptions = {}): Promise<WithdrawSuggestionsResponse> {
  const config = hostConfig(liberaPath, options);
  return host(liberaPath, () => withdrawSuggestions(docId, { runId }, config));
}

/**
 * A comment thread on a passage of a shared document, written through the
 * host (the anchor goes into the document's annotations): `range` is in
 * offsets of `snapshot`, the text the caller read.
 */
export async function commentOnSharedText(
  liberaPath: string,
  input: { range: { start: number; end: number }; snapshot: string; body: string; ai?: AiActorHint; doc?: ResolvedDoc },
  options: SharedWriteOptions = {},
): Promise<CreateThreadAtRangeResponse> {
  const config = hostConfig(liberaPath, options);
  const doc = input.doc ?? (await requireSharedDoc(liberaPath, { config }));
  if (!canSuggestShared(doc)) {
    throw new SharedWriteError(403, "forbidden", isRevoked(doc) ? `${liberaPath} is read-only: access to its shared notebook was revoked.` : `Your role in this shared notebook (${doc.role}) cannot comment on ${liberaPath}.`);
  }
  return host(liberaPath, () => createThreadAtRange(doc.docId, { range: input.range, snapshot: input.snapshot, body: input.body, ...(input.ai ? { ai: input.ai } : {}) }, config));
}

function manifestTarget(liberaPath: string): { projectId: string; path: string } {
  const target = sharedManifestPath(liberaPath);
  if (!target) throw new SharedWriteError(400, "not-shared", `${liberaPath} is not in a shared notebook.`);
  return target;
}

/** Creates a new file in a shared notebook (a text document, or a blob for other types). Returns the Libera paths created. */
export async function createSharedFile(liberaPath: string, content: string, options: SharedWriteOptions = {}): Promise<{ paths: string[] }> {
  const target = manifestTarget(liberaPath);
  const config = hostConfig(liberaPath, options);
  return host(liberaPath, () => fileOp(target.projectId, { op: "create-file", path: target.path, content }, config));
}

/**
 * Adds a binary file to a shared notebook, or replaces the bytes of an
 * existing one, as a manifest blob. A new text file (.md, .tex, …) becomes a
 * document instead. Returns the Libera paths written.
 */
export async function writeSharedBlob(liberaPath: string, bytes: Uint8Array, options: SharedWriteOptions & { createOnly?: boolean } = {}): Promise<{ paths: string[] }> {
  const target = manifestTarget(liberaPath);
  if (bytes.byteLength > MAX_SHARED_BLOB_BYTES) {
    throw new SharedWriteError(
      413,
      "too-large",
      `${liberaPath} is too large to add to a shared notebook (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_SHARED_BLOB_BYTES / 1024 / 1024} MB).`,
    );
  }
  const config = hostConfig(liberaPath, options);
  const contentBase64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  return host(liberaPath, () => fileOp(target.projectId, { op: "write-blob", path: target.path, contentBase64, ...(options.createOnly ? { createOnly: true } : {}) }, config));
}

// ------------------------------------------------------------ Libera's file writers, for shared targets
//
// The upload, Markdown image, edited-image and "save to notebook folder"
// routes call these instead of their src/lib/storage writers when the target
// is in a shared notebook (isSharedNotebookPath). They validate like the
// storage writers, then add the file through the host, which writes the
// working copy before answering, so the result can be read back from disk.

/** The user-facing new note/LaTeX/text action, with the same validation as the local writer. */
export async function createSharedMarkdownFile(notebook: string, name: string, content = "", parentPath?: string, options: SharedWriteOptions = {}) {
  await ensureAdminRoot();
  const parent = parentPath
    ? splitDirectoryPath(parentPath)
    : { notebook: assertSafeSegment(notebook, "Notebook name"), pathParts: [] };
  const safeName = ensureMarkdownName(name);
  const targetParts = [...parent.pathParts, safeName];
  const parentDirectory = itemPath(parent.notebook, parent.pathParts);
  if (!(await pathExists(parentDirectory))) throw new StorageError("Notebook does not exist.", 404);
  await assertDirectoryExists(parentDirectory, "Destination folder is not a folder.");
  if (await pathExists(filePathFromParts(parent.notebook, targetParts))) throw new StorageError("File already exists.", 409);
  const liberaPath = relativeFilePath(parent.notebook, targetParts);
  await createSharedFile(liberaPath, content, options);
  notifySearchChanges([liberaPath]);
  return readLiberaFile(liberaPath);
}

/** Creates a folder through the manifest so collaborators receive it too. */
export async function createSharedFolder(parentPath: string, name: string, options: SharedWriteOptions = {}): Promise<LiberaTree> {
  await ensureAdminRoot();
  const parent = splitDirectoryPath(parentPath);
  const safeName = assertSafeSegment(name, "Folder name");
  await assertDirectoryExists(itemPath(parent.notebook, parent.pathParts), "Parent folder was not found.");
  const targetParts = [...parent.pathParts, safeName];
  if (await pathExists(itemPath(parent.notebook, targetParts))) throw new StorageError("Folder already exists.", 409);
  const liberaPath = relativeFilePath(parent.notebook, targetParts);
  const target = manifestTarget(liberaPath);
  const config = hostConfig(liberaPath, options);
  await host(liberaPath, () => fileOp(target.projectId, { op: "create-folder", path: target.path }, config));
  return getTree();
}

/** Rename or move within a shared notebook, preserving the manifest entry and document identity. */
export async function moveSharedFile(relativePath: string, destinationDirectory: string, destinationName?: string, options: SharedWriteOptions = {}) {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);
  const destination = splitDirectoryPath(destinationDirectory);
  const safeName = destinationName?.trim() ? assertSafeSegment(destinationName, "File name") : current.name;
  assertSupportedFileName(safeName);
  const sourcePath = relativeFilePath(current.notebook, current.pathParts);
  const nextParts = [...destination.pathParts, safeName];
  const nextPath = relativeFilePath(destination.notebook, nextParts);
  const source = manifestTarget(sourcePath);
  if (destination.notebook !== current.notebook || !sharedManifestPath(nextPath)) {
    throw new StorageError("Files in a shared notebook can only be moved within that notebook.");
  }
  await getFileNode(current.notebook, current.pathParts);
  await assertDirectoryExists(itemPath(destination.notebook, destination.pathParts), "Destination folder was not found.");
  if (sourcePath !== nextPath && await pathExists(filePathFromParts(destination.notebook, nextParts))) {
    throw new StorageError("Destination file already exists.", 409);
  }
  const config = hostConfig(sourcePath, options);
  await host(sourcePath, () => fileOp(source.projectId, { op: "rename", path: source.path, to: nextParts.join("/") }, config));
  await renameFileMetadataPath(sourcePath, nextPath);
  notifySearchChanges([sourcePath, nextPath]);
  return readLiberaFile(nextPath);
}

/** Delete via the manifest; the host removes the working copy and syncs the deletion. */
export async function deleteSharedFile(relativePath: string, options: SharedWriteOptions = {}): Promise<LiberaTree> {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);
  const liberaPath = relativeFilePath(current.notebook, current.pathParts);
  await getFileNode(current.notebook, current.pathParts);
  const target = manifestTarget(liberaPath);
  const config = hostConfig(liberaPath, options);
  await host(liberaPath, () => fileOp(target.projectId, { op: "delete", path: target.path }, config));
  await removeFileMetadataPath(liberaPath);
  notifySearchChanges([liberaPath]);
  return getTree();
}

/** Folder operations apply to all descendant manifest entries, preserving their document IDs. */
export async function renameSharedFolder(relativePath: string, name: string, options: SharedWriteOptions = {}): Promise<LiberaTree> {
  await ensureAdminRoot();
  const current = splitDirectoryPath(relativePath);
  if (!current.pathParts.length) throw new StorageError("Use notebook edit to rename a notebook.");
  const safeName = assertSafeSegment(name, "Folder name");
  const parts = [...current.pathParts.slice(0, -1), safeName];
  const sourcePath = relativeFilePath(current.notebook, current.pathParts);
  const nextPath = relativeFilePath(current.notebook, parts);
  const source = manifestTarget(sourcePath);
  if (!sharedManifestPath(nextPath)) throw new StorageError("A shared folder cannot be moved into the local archive.");
  await assertDirectoryExists(itemPath(current.notebook, current.pathParts), "Folder was not found.");
  if (sourcePath !== nextPath && await pathExists(itemPath(current.notebook, parts))) throw new StorageError("Destination folder already exists.", 409);
  const config = hostConfig(sourcePath, options);
  await host(sourcePath, () => fileOp(source.projectId, { op: "rename", path: source.path, to: parts.join("/") }, config));
  await renameFileMetadataPathPrefix(sourcePath, nextPath);
  await renameNotebookPanelExpandedPathPrefix(sourcePath, nextPath);
  notifySearchChanges();
  return getTree();
}

export async function deleteSharedFolder(relativePath: string, options: SharedWriteOptions = {}): Promise<LiberaTree> {
  await ensureAdminRoot();
  const current = splitDirectoryPath(relativePath);
  if (!current.pathParts.length) throw new StorageError("Use notebook delete to remove a notebook.");
  const liberaPath = relativeFilePath(current.notebook, current.pathParts);
  const target = manifestTarget(liberaPath);
  await assertDirectoryExists(itemPath(current.notebook, current.pathParts), "Folder was not found.");
  const config = hostConfig(liberaPath, options);
  await host(liberaPath, () => fileOp(target.projectId, { op: "delete", path: target.path }, config));
  await removeFileMetadataPathPrefix(liberaPath);
  await removeNotebookPanelExpandedPathPrefix(liberaPath);
  notifySearchChanges();
  return getTree();
}

/** Copy into a shared notebook as a new manifest entry, using live text for shared sources. */
export async function copyFileIntoSharedDirectory(relativePath: string, destinationDirectory: string, destinationName?: string, options: SharedWriteOptions = {}) {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);
  const destination = splitDirectoryPath(destinationDirectory);
  const extension = path.extname(current.name);
  const requestedName = destinationName?.trim()
    ? assertSafeSegment(destinationName, "File name")
    : `${path.basename(current.name, extension)} copy${extension}`;
  assertSupportedFileName(requestedName);
  const node = await getFileNode(current.notebook, current.pathParts);
  const directory = itemPath(destination.notebook, destination.pathParts);
  await assertDirectoryExists(directory, "Destination folder was not found.");
  const available = await findAvailableFilePath(directory, requestedName);
  const parts = [...destination.pathParts, available.name];
  const liberaPath = relativeFilePath(destination.notebook, parts);
  // Validate the destination and service before creating any copied attachments.
  manifestTarget(liberaPath);
  hostConfig(liberaPath, options);
  if (isTextFileType(node.fileType)) {
    let content = isSharedNotebookPath(relativePath)
      ? (await readSharedText(relativePath, options)).text
      : (await readLiberaFile(relativePath, { requireContent: true })).content ?? "";
    if (node.fileType === "markdown") {
      // Give the copy its own assets; deleting or editing an original must not
      // break a copy, including copies made into a different notebook.
      for (const source of markdownImageSources(content)) {
        if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(source)) continue;
        if (source.startsWith("/") && !source.startsWith("/api/markdown-assets/raw") && !source.startsWith("/api/files/raw/")) continue;
        const asset = await getMarkdownImageAssetBySource(relativePath, source);
        const assetPath = `${markdownAssetsPathPrefix(parts)}/${randomUUID()}/${assertSafeSegment(asset.fileName, "Image name")}`;
        await writeSharedBlob(`${destination.notebook}/${assetPath}`, new Uint8Array(asset.body), { ...options, createOnly: true });
        content = content.split(source).join(assetPath);
      }
    }
    await createSharedFile(liberaPath, content, options);
  } else {
    await writeSharedBlob(liberaPath, new Uint8Array(await readFile(filePathFromParts(current.notebook, current.pathParts))), { ...options, createOnly: true });
  }
  notifySearchChanges([liberaPath]);
  return readLiberaFile(liberaPath);
}

/** writeUploadedFile for a shared notebook: the upload becomes a manifest blob (or a document, for text files). */
export async function writeSharedUpload(notebook: string, upload: File, destinationPath?: string, options: SharedWriteOptions = {}): Promise<LiberaFileNode> {
  await ensureAdminRoot();
  const destination = destinationPath?.trim()
    ? splitDirectoryPath(destinationPath)
    : { notebook: assertSafeSegment(notebook, "Notebook name"), pathParts: [] };
  const safeName = assertSafeSegment(upload.name, "File name");
  assertSupportedFileName(safeName);
  await assertDirectoryExists(itemPath(destination.notebook, destination.pathParts), "Destination folder was not found.");
  const targetParts = [...destination.pathParts, safeName];
  if (await pathExists(filePathFromParts(destination.notebook, targetParts))) throw new StorageError(`File already exists: ${safeName}`, 409);
  const liberaPath = relativeFilePath(destination.notebook, targetParts);
  await writeSharedBlob(liberaPath, new Uint8Array(await upload.arrayBuffer()), options);
  notifySearchChanges([liberaPath]);
  return getFileNode(destination.notebook, targetParts);
}

/** writeMarkdownImageAsset for a document in a shared notebook: the image becomes a blob under the notebook's _assets. */
export async function writeSharedMarkdownImageAsset(documentPath: string, upload: File, options: SharedWriteOptions = {}): Promise<MarkdownImageAssetPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  await stat(filePathFromParts(notebook, pathParts));
  const safeName = normalizeAssetFileName(ensureImageName(upload.name));
  const available = await findAvailableFilePath(markdownAssetsDirectoryPathFromParts(notebook, pathParts), safeName);
  const assetPath = `${markdownAssetsPathPrefix(pathParts)}/${available.name}`;
  await writeSharedBlob(`${notebook}/${assetPath}`, new Uint8Array(await upload.arrayBuffer()), options);
  return {
    assetPath,
    markdown: `![${path.basename(available.name, path.extname(available.name))}](${assetPath})`,
    rawUrl: `/api/markdown-assets/raw?document=${encodeURIComponent(relativeFilePath(notebook, pathParts))}&asset=${encodeURIComponent(assetPath)}`,
  };
}

/** saveEditedImageCopy for an image in a shared notebook: the edited copy is a new blob beside it. */
export async function saveSharedEditedImageCopy(relativePath: string, edits: PhotoEdits, options: SharedWriteOptions = {}): Promise<{ file: LiberaFileNode; tree: LiberaTree }> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  if (assertSupportedFileName(name) !== "image") throw new StorageError("Only images can be edited here.");
  if (!hasEdits(edits)) throw new StorageError("There are no changes to save.");
  // sharp is loaded only when an image is actually edited.
  const { editedPhotoFormat, renderEditedPhoto } = await import("@/lib/photo-edits-server");
  const { format, extension } = editedPhotoFormat(name);
  const body = await renderEditedPhoto(filePathFromParts(notebook, pathParts), edits, format);
  const directoryParts = pathParts.slice(0, -1);
  const available = await findAvailableFilePath(itemPath(notebook, directoryParts), `${path.basename(name, path.extname(name))} (edited)${extension}`);
  const targetParts = [...directoryParts, available.name];
  const liberaPath = relativeFilePath(notebook, targetParts);
  await writeSharedBlob(liberaPath, new Uint8Array(body), options);
  notifySearchChanges([liberaPath]);
  return { file: await getFileNode(notebook, targetParts), tree: await getTree() };
}
