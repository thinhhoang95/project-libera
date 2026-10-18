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

import { stat } from "node:fs/promises";
import path from "node:path";

import { diffText } from "../../../electron/collab/notebooks/text-diff";
import { hasEdits, type PhotoEdits } from "@/lib/photo-edits";
import { StorageError } from "@/lib/storage/errors";
import { assertMarkdownFileName, assertSupportedFileName, ensureImageName, normalizeAssetFileName } from "@/lib/storage/file-types";
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
import type { LiberaFileNode, LiberaTree, MarkdownImageAssetPayload } from "@/lib/types";
import { CollabHostError, applyEdits, collabHostConfig, fileOp, getDocText, resolveSharedPath, type HostClientConfig } from "./host-client";
import type { DocText, ResolvedDoc, TextEdit } from "./local-api";
import type { Provenance } from "./protocol/actor";
import { canWriteSubdoc } from "./protocol/roles";
import { sharedManifestPath } from "./shared-notebook";

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
export async function writeSharedBlob(liberaPath: string, bytes: Uint8Array, options: SharedWriteOptions = {}): Promise<{ paths: string[] }> {
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
  return host(liberaPath, () => fileOp(target.projectId, { op: "write-blob", path: target.path, contentBase64 }, config));
}

// ------------------------------------------------------------ Libera's file writers, for shared targets
//
// The upload, Markdown image, edited-image and "save to notebook folder"
// routes call these instead of their src/lib/storage writers when the target
// is in a shared notebook (isSharedNotebookPath). They validate like the
// storage writers, then add the file through the host, which writes the
// working copy before answering, so the result can be read back from disk.

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
