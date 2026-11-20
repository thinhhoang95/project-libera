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
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { diffText } from "../../../electron/collab/notebooks/text-diff";
import { hasEdits, type PhotoEdits } from "@/lib/photo-edits";
import { StorageError } from "@/lib/storage/errors";
import { assertMarkdownFileName, assertSupportedFileName, ensureImageName, ensureMarkdownName, getFileType, normalizeAssetFileName } from "@/lib/storage/file-types";
import { copyTranscript, transcriptCompanionPath } from "@/lib/storage/transcripts";
import { copyInkThroughEdit, inkFolderPath, inkLibraryPath, supportsInk } from "@/lib/storage/ink";
import { destinationRecords } from "@/lib/storage/destination-records";
import { migrateImageAnnotations, migratePdfAnnotations } from "@/lib/storage/annotations";
import { mapReferencesForCopyText } from "@/lib/references/moves";
import { rewriteCitationKeys } from "@/lib/references/citation-syntax";
import { DEFINITIONS_FILE_TYPES } from "@/lib/definitions";
import { rewriteMarkdownImageSources } from "@/lib/markdown-image-sources";
import { pythonSidecarPath, withPreviousPythonFigureSources } from "@/lib/python/sidecar";
import { followCommittedChange } from "@/lib/storage/shared-record-follow";
import { assertDirectoryExists, copyFileIfExists, pathExists } from "@/lib/storage/fs-utils";
import {
  assertSafeSegment,
  definitionsPath,
  ensureAdminRoot,
  filePathFromParts,
  imageAnnotationsPath,
  itemPath,
  markdownAssetsDirectoryPathFromParts,
  markdownAssetsPathPrefix,
  notebookPath,
  pdfAnnotationsPath,
  pdfOutlinePath,
  rawFileUrl,
  relativeFilePath,
  splitDirectoryPath,
  splitFilePath,
} from "@/lib/storage/paths";
import { MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { copyReviewPath } from "@/lib/storage/markdown-reviews";
import { getFileNode, getTree } from "@/lib/storage/tree";
import { assertCopyKeepsType, assertNoLeftoverFolderRecords, assertNoLeftoverRecords, readLiberaFile } from "@/lib/storage/files";
import { readSharedAuthorityBytes, readSharedSourceSnapshot, sharedSourceGone } from "@/lib/storage/shared-source";
import { getMarkdownImageAssetBySource, markdownAssetSourceTarget, markdownImageSources, migratePythonSidecar } from "@/lib/storage/markdown-assets";
import type { ReferenceMoveResult } from "@/lib/references/moves";
import { isTextFileType, type LiberaFileMovePayload, type LiberaFileNode, type LiberaFilePayload, type LiberaMoveStep, type LiberaTree, type MarkdownImageAssetPayload } from "@/lib/types";
import { CollabHostError, resolveSharedPdf, livePdfSnapshot, readProjectBlob, listProjectEntries, applyEdits, collabHostConfig, createSuggestions, createThreadAtRange, createThreadMessage, enqueueCommand, fileOp, getDocText, listAnchoredThreads, listProjects, resolveSharedPath, withdrawSuggestions, type HostClientConfig } from "./host-client";
import type { AnchoredThreadsResponse, CreateThreadAtRangeResponse, DocText, FileOpResult, ResolvedDoc, TextEdit, WithdrawSuggestionsResponse } from "./local-api";
import type { AiActorHint, Provenance } from "./protocol/actor";
import { SharedOperationUnfinishedError, type SharedCommittedChange } from "./shared-outcomes";
import { canWriteSubdoc } from "./protocol/roles";
import { SharedDocumentError, sharedManifestPath, sharedNotebookMarker } from "./shared-notebook";

/** How long a save waits for the folder's writer before answering from what it knows. */
const ARRIVAL_WAIT_MS = 1_000;
const ARRIVAL_CHECK_MS = 50;

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
 * The control API caps request bodies at 16 MB, and base64 adds a third, so
 * larger files (recordings, mostly) are staged on disk for the host instead.
 */
export const MAX_SHARED_BLOB_BYTES = 11 * 1024 * 1024;
/** The collaboration server's default blob limit (server MAX_BLOB_BYTES). */
export const MAX_STAGED_BLOB_BYTES = 100 * 1024 * 1024;

export interface SharedWriteOptions {
  /** Defaults to the host this launch was given (LIBERA_COLLAB_HOST_URL/TOKEN). */
  config?: HostClientConfig | null;
}

/** Options of a rename or delete of one file: the file the caller saw at the path. */
export interface SharedIdentityOptions extends SharedWriteOptions {
  /**
   * The file id the UI showed at this path. The host refuses (409) when the
   * path now belongs to another file, instead of acting on whatever is there.
   * Without it the host acts on the file at the path.
   */
  expectedFileId?: string;
  /**
   * Delete only: a batch deletes many files and does its own one wait and one
   * refresh at the end, so the call returns right after its own cleanup, null
   * instead of the tree.
   */
  deferRefresh?: boolean;
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

/** The host's code for a project it has not joined (NotebookServiceImpl.runningProject). */
const HOST_NOT_JOINED = "not-joined";
export const NOT_JOINED_ERROR = "notebook-not-joined";

/**
 * A shared notebook whose folder is here (synced by OneDrive or the like
 * from another device or Libera profile) but which this Libera has not
 * joined. 409, not 404: nothing was written, and callers that ignore a
 * missing file must not mistake this for one.
 */
function notJoinedError(liberaPath: string): SharedWriteError {
  const notebook = liberaPath.replace(/\\/g, "/").split("/").filter(Boolean)[0] ?? liberaPath;
  return new SharedWriteError(
    409,
    NOT_JOINED_ERROR,
    `${notebook} is a shared notebook synced to this computer from another device or Libera profile, but this Libera has not joined it, so ${liberaPath} cannot be changed here. Nothing was written. Sign in to the collaboration account that shares it (it is joined automatically), or open its invitation link.`,
  );
}

/** notJoinedError when the path's notebook has a marker whose project the host does not run; null otherwise. */
async function notJoined(liberaPath: string, config: HostClientConfig): Promise<SharedWriteError | null> {
  const notebook = liberaPath.replace(/\\/g, "/").split("/").filter(Boolean)[0];
  const marker = notebook ? sharedNotebookMarker(notebook) : null;
  if (!marker || marker.revoked) return null;
  const projects = await listProjects(config).catch(() => null);
  if (!projects || projects.some((project) => project.projectId === marker.projectId)) return null;
  return notJoinedError(liberaPath);
}

/** Host errors as SharedWriteErrors that name the file; anything else is rethrown. */
function asSharedWriteError(liberaPath: string, error: unknown): never {
  if (error instanceof SharedWriteError) throw error;
  if (error instanceof CollabHostError && error.code === HOST_NOT_JOINED) throw notJoinedError(liberaPath);
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
    const unjoined = await notJoined(liberaPath, config);
    if (unjoined) throw unjoined;
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
  /** With `replaceOwn`: edits already pending as an earlier suggestion, not suggested again. */
  repeatedCount?: number;
  /** With `replaceOwn`: earlier suggestions withdrawn because this change revises them. */
  withdrawnCount?: number;
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
 *
 * `replaceOwn`: the change is this AI's current version of the passages it
 * touches, so it replaces the user's own pending suggestions from the same
 * feature there instead of piling up copies (see CreateSuggestionsRequest).
 */
export async function suggestSharedText(
  liberaPath: string,
  before: string,
  nextText: string,
  ai: AiActorHint & { title?: string; reason?: string },
  options: SharedWriteOptions & { doc?: ResolvedDoc; replaceOwn?: boolean } = {},
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
    ...(options.replaceOwn ? { replaceOwn: true } : {}),
  }, config));
  const current = await host(liberaPath, () => getDocText(doc.docId, config));
  const repeated = new Set(response.repeatedIndexes ?? []);
  return {
    doc,
    // What this change created; repeats belong to the earlier suggestion (and its run's undo).
    suggestionIds: response.suggestionIds.filter((_, index) => !repeated.has(index)),
    staleCount: response.staleIndexes.length,
    ...(response.repeatedIndexes?.length ? { repeatedCount: response.repeatedIndexes.length } : {}),
    ...(response.withdrawnIds?.length ? { withdrawnCount: response.withdrawnIds.length } : {}),
    text: current.text,
  };
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

/** Failures worth queuing a reply for: the server is unreachable or busy, not a refusal. */
function queueable(error: unknown) {
  if (!(error instanceof CollabHostError)) return false;
  if (error.code === "collab-unavailable" || error.code === "collab-disabled" || error.code === "host-unavailable" || error.code === "collab-host-auth") return false;
  if (error.code === "network" || error.code === "offline" || error.code === "needs-sign-in") return true;
  return [0, 408, 429, 500, 502, 503, 504].includes(error.status);
}

export type SharedReplyResult = { queued: false; messageId: string } | { queued: true; messageId: string; commandId: string };

/**
 * A reply in a shared comment thread, as the user (an AI actor when `ai` is
 * given). Sent to the server at once; when it cannot be reached, queued in
 * the host's command queue like a reply typed in the Comments panel offline.
 */
export async function replyToSharedThread(
  liberaPath: string,
  input: { threadId: string; body: string; ai?: AiActorHint; doc?: ResolvedDoc },
  options: SharedWriteOptions = {},
): Promise<SharedReplyResult> {
  const config = hostConfig(liberaPath, options);
  const doc = input.doc ?? (await requireSharedDoc(liberaPath, { config }));
  if (!canSuggestShared(doc)) {
    throw new SharedWriteError(403, "forbidden", isRevoked(doc) ? `${liberaPath} is read-only: access to its shared notebook was revoked.` : `Your role in this shared notebook (${doc.role}) cannot comment on ${liberaPath}.`);
  }
  const request = { id: `msg-${randomUUID()}`, body: input.body, ...(input.ai ? { ai: input.ai } : {}) };
  try {
    await createThreadMessage(input.threadId, request, config);
    return { queued: false, messageId: request.id };
  } catch (error) {
    if (!queueable(error)) return asSharedWriteError(liberaPath, error);
  }
  const commandId = `cmd-${randomUUID()}`;
  await host(liberaPath, () => enqueueCommand({ id: commandId, kind: "message.create", threadId: input.threadId, body: request }, config));
  return { queued: true, messageId: request.id, commandId };
}

/** A shared document's comment threads and replies, anchored in the live text the response carries. */
export async function readSharedThreads(liberaPath: string, options: SharedWriteOptions & { doc?: ResolvedDoc } = {}): Promise<AnchoredThreadsResponse> {
  const config = hostConfig(liberaPath, options);
  const doc = options.doc ?? (await requireSharedDoc(liberaPath, { config }));
  try {
    return await listAnchoredThreads(doc.docId, config);
  } catch (error) {
    if (!(error instanceof CollabHostError)) throw error;
    throw new SharedWriteError(error.status, error.code, `Could not read the comments on ${liberaPath} from the shared notebook: ${error.message}`);
  }
}

function manifestTarget(liberaPath: string): { notebook: string; projectId: string; path: string } {
  const target = sharedManifestPath(liberaPath);
  if (!target) throw new SharedWriteError(400, "not-shared", `${liberaPath} is not in a shared notebook.`);
  return target;
}

/** Creates a new file in a shared notebook (a text document, or a blob for other types). Returns the Libera paths created. */
export async function createSharedFile(liberaPath: string, content: string, options: SharedWriteOptions & { recordsChecked?: boolean } = {}): Promise<FileOpResult> {
  const target = manifestTarget(liberaPath);
  const config = hostConfig(liberaPath, options);
  // A new file never takes over the records of one that was there before (a copy has checked its own name).
  if (!options.recordsChecked) {
    const { notebook, pathParts } = splitFilePath(liberaPath);
    await assertSharedPathFree(notebook, pathParts, getFileType(pathParts.at(-1) ?? "") ?? "text", options, "create");
  }
  return host(liberaPath, () => fileOp(target.projectId, { op: "create-file", path: target.path, content }, config));
}

/**
 * A shared notebook's authoritative file list, with Libera paths
 * (`<notebook>/<path>`): what the manifest holds, which on a follower can be
 * ahead of the disk and never includes a deleted file still on disk.
 */
export async function listSharedEntries(notebook: string, options: SharedWriteOptions = {}): Promise<import("./local-api").FileListEntry[]> {
  const marker = sharedNotebookMarker(notebook);
  if (!marker?.projectId) throw new SharedWriteError(400, "not-shared", `${notebook} is not a shared notebook.`);
  const config = hostConfig(notebook, options);
  const result = await host(notebook, () => listProjectEntries(marker.projectId, config));
  if (!result || !Array.isArray(result.entries)) throw new SharedWriteError(503, "unavailable", "The host did not return the shared notebook's file list.");
  return result.entries.map((entry) => ({ ...entry, path: `${notebook}/${entry.path}` }));
}

/** The host's latest blob, independent of delayed cloud materialization. */
export async function readSharedBlob(liberaPath: string, options: SharedWriteOptions = {}): Promise<import("./local-api").FileBlobResponse> {
  const target = manifestTarget(liberaPath);
  const config = hostConfig(liberaPath, options);
  const result = await host(liberaPath, () => readProjectBlob(target.projectId, target.path, config));
  if (!result || !(result.contentBase64 === null || typeof result.contentBase64 === "string") ||
      result.contentBase64 !== null && (!result.fileId || !result.blobHash)) {
    throw new SharedWriteError(503, "unavailable", "The host did not return the shared file's current state. Retry the save.");
  }
  return result;
}

/**
 * The authoritative bytes of one entry of `listSharedEntries`: a document's
 * live text, or a blob's content. Null for a folder, or a blob that left the
 * manifest between the listing and this read.
 */
export async function readSharedEntryBytes(entry: import("./local-api").FileListEntry, options: SharedWriteOptions = {}): Promise<Buffer | null> {
  if (entry.kind === "folder") return null;
  if (entry.kind === "doc") {
    if (!entry.docId) return null;
    const docId = entry.docId;
    const config = hostConfig(entry.path, options);
    return Buffer.from((await host(entry.path, () => getDocText(docId, config))).text, "utf8");
  }
  const blob = await readSharedBlob(entry.path, options);
  return blob.contentBase64 === null ? null : Buffer.from(blob.contentBase64, "base64");
}

/**
 * Saves a text file a shared notebook holds as a file rather than a document
 * (too large, or not text, when it was added): its bytes are replaced through
 * the host, as for any shared binary file, so the last save wins. A text
 * document is refused here (409 shared-document): its edits go through the
 * shared document, never a whole-file save.
 */
export async function saveSharedFileText(liberaPath: string, content: string, options: SharedWriteOptions & { expectedFileId?: string; expectedBlobHash?: string; expectedText?: string } = {}): Promise<LiberaFilePayload> {
  await ensureAdminRoot();
  // Without a host's answer it may be a document: refuse as the storage guard does.
  const config = options.config === undefined ? collabHostConfig() : options.config;
  if (!config) throw new SharedDocumentError(liberaPath);
  const doc = await resolveSharedPath(liberaPath, config).catch(() => undefined);
  if (doc !== null) throw new SharedDocumentError(liberaPath);
  let { expectedFileId, expectedBlobHash } = options;
  if ((!expectedFileId || !expectedBlobHash) && options.expectedText !== undefined) {
    // A caller that has just compared the text it merged against: bound to the host's version of exactly that text.
    const blob = await readSharedBlob(liberaPath, options);
    if (blob.contentBase64 === null || Buffer.from(blob.contentBase64, "base64").toString("utf8") !== options.expectedText) {
      throw new SharedWriteError(409, "conflict", `${liberaPath} changed before it could be saved. Nothing was written.`);
    }
    expectedFileId = blob.fileId;
    expectedBlobHash = blob.blobHash;
  }
  // A replacement names the file and the version it replaces: a stale save can neither create a new file at an old path nor replace another file.
  if (!expectedFileId || !expectedBlobHash) {
    throw new SharedWriteError(409, "conflict", `${liberaPath} cannot be saved without the version it was opened from. Reload the file and save again. Nothing was written.`);
  }
  const bytes = new TextEncoder().encode(content);
  const saved = await writeSharedBlob(liberaPath, bytes, { ...options, replaceOnly: true, expectedFileId, expectedBlobHash });
  // The path the host answers for (the file's own, even if a collaborator moved it meanwhile).
  liberaPath = saved.paths[0] ?? liberaPath;
  notifySearchChanges([liberaPath]);
  return savedFile(liberaPath, bytes.byteLength, async () => content);
}

/**
 * Adds a binary file to a shared notebook, or replaces the bytes of an
 * existing one, as a manifest blob. A new text file (.md, .tex, …) becomes a
 * document instead. Returns the Libera paths written.
 */
export async function writeSharedBlob(liberaPath: string, bytes: Uint8Array, options: SharedWriteOptions & { createOnly?: boolean; replaceOnly?: boolean; expectedFileId?: string; expectedBlobHash?: string; ownerFileId?: string; pdfSeed?: import("./protocol/pdf").PdfImportRequest } = {}): Promise<FileOpResult> {
  const target = manifestTarget(liberaPath);
  if (bytes.byteLength > MAX_STAGED_BLOB_BYTES) {
    throw new SharedWriteError(
      413,
      "too-large",
      `${liberaPath} is too large to add to a shared notebook (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_STAGED_BLOB_BYTES / 1024 / 1024} MB).`,
    );
  }
  const config = hostConfig(liberaPath, options);
  const createOnly = { ...(options.createOnly ? { createOnly: true } : {}), ...(options.replaceOnly ? { replaceOnly: true } : {}),
    ...(options.expectedFileId ? { expectedFileId: options.expectedFileId } : {}),
    ...(options.expectedBlobHash ? { expectedBlobHash: options.expectedBlobHash } : {}), ...(options.pdfSeed ? { pdfSeed: options.pdfSeed } : {}) };
  // A companion save (ink, transcript) names the owner file it was made for.
  if (options.ownerFileId) Object.assign(createOnly, { ownerFileId: options.ownerFileId });
  if (bytes.byteLength <= MAX_SHARED_BLOB_BYTES) {
    const contentBase64 =Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    return host(liberaPath, () => fileOp(target.projectId, { op: "write-blob", path: target.path, contentBase64, ...createOnly }, config));
  }
  // Too large for a request: hand the host a file in the notebook's own
  // collaboration folder, which it reads and removes.
  const staged = randomUUID();
  const file = path.join(await ensureSharedIncomingDirectory(target.notebook), staged);
  await writeFile(file, bytes);
  try {
    return await host(liberaPath, () => fileOp(target.projectId, { op: "write-blob", path: target.path, stagedFile: staged, ...createOnly }, config));
  } finally {
    await rm(file, { force: true });
  }
}

/** Where large blobs wait for the collab host: `<notebook>/.libera/collab/incoming` (fs-ops STATE_DIRECTORY). */
export function sharedIncomingDirectory(notebook: string) {
  return path.join(notebookPath(notebook), ".libera", "collab", "incoming");
}

/**
 * Creates the incoming folder one level at a time below the notebook, never
 * the notebook itself: a notebook removed in Finder meanwhile must not come
 * back as an empty folder holding only Libera's bookkeeping.
 */
export async function ensureSharedIncomingDirectory(notebook: string): Promise<string> {
  let directory = notebookPath(notebook);
  for (const segment of [".libera", "collab", "incoming"]) {
    directory = path.join(directory, segment);
    try {
      await mkdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new SharedWriteError(503, "notebook-unavailable", "The shared notebook folder is missing. Restore it before adding files.");
      if (code !== "EEXIST") throw error;
    }
  }
  return directory;
}

/**
 * Deletes a manifest entry by path, for files Libera does not list (a
 * recording's companion transcript). Nothing happens when it is not shared.
 */
export async function deleteSharedEntry(liberaPath: string, options: SharedWriteOptions = {}): Promise<void> {
  const target = manifestTarget(liberaPath);
  const config = hostConfig(liberaPath, options);
  await host(liberaPath, () => fileOp(target.projectId, { op: "delete", path: target.path }, config)).catch((error: unknown) => {
    if (error instanceof SharedWriteError && error.status === 404) return;
    throw error;
  });
}

// ------------------------------------------------------------ Libera's file writers, for shared targets
//
// The upload, Markdown image, edited-image and "save to notebook folder"
// routes call these instead of their src/lib/storage writers when the target
// is in a shared notebook (isSharedNotebookPath). They validate like the
// storage writers, then add the file through the host, which writes the
// working copy before answering, so the result can be read back from disk.

/** The user-facing new note/LaTeX/text action, with the same validation as the local writer. */
/**
 * Whether a file the host has accepted is on this disk. A host that follows
 * a folder leaves the disk to the folder's writer, in another Libera on this
 * computer or another, so the file can arrive a moment later, or much later
 * through a sync client. The save has succeeded either way.
 */
async function fileArrived(liberaPath: string): Promise<boolean> {
  return diskCaughtUp(liberaPath, true);
}

async function diskCaughtUp(liberaPath: string, present: boolean): Promise<boolean> {
  const { notebook, pathParts } = splitFilePath(liberaPath);
  const target = filePathFromParts(notebook, pathParts);
  const deadline = Date.now() + ARRIVAL_WAIT_MS;
  while ((await pathExists(target)) !== present) {
    if (Date.now() >= deadline) return false;
    await sleep(ARRIVAL_CHECK_MS);
  }
  return true;
}

function fileOnItsWay(liberaPath: string, size: number): LiberaFileNode {
  const { notebook, name, pathParts } = splitFilePath(liberaPath);
  const now = new Date().toISOString();
  return { kind: "file", name, path: relativeFilePath(notebook, pathParts), notebook, fileType: assertSupportedFileName(name), createdAt: now, changedAt: now, updatedAt: now, size };
}

/** The node of a file the host has accepted, from the disk once it is there. */
export async function savedNode(liberaPath: string, size: number): Promise<LiberaFileNode> {
  if (!(await fileArrived(liberaPath))) return fileOnItsWay(liberaPath, size);
  const { notebook, pathParts } = splitFilePath(liberaPath);
  return getFileNode(notebook, pathParts);
}

/** The payload of a file the host has accepted, from the disk once it is there. */
async function savedFile(liberaPath: string, size: number, content: () => Promise<string | undefined>): Promise<LiberaFilePayload> {
  if (await fileArrived(liberaPath)) return readLiberaFile(liberaPath);
  const file = fileOnItsWay(liberaPath, size);
  return isTextFileType(file.fileType) ? { file, content: await content() } : { file, rawUrl: rawFileUrl(file.path) };
}

/**
 * Whether the host's manifest holds a file (or, with `folder`, a folder) at
 * this path. A follower's disk can lag the manifest, so the disk saying "not
 * here" is not the shared notebook's answer. Any failure to ask answers no.
 */
async function sharedEntryKnown(liberaPath: string, options: SharedWriteOptions, folder: boolean): Promise<boolean> {
  try {
    const target = manifestTarget(liberaPath);
    const result = await readProjectBlob(target.projectId, target.path, hostConfig(liberaPath, options));
    // A blob answers with its bytes; a folder or a document is the host's 409 "not a binary file".
    return result?.contentBase64 != null && !folder;
  } catch (error) {
    return error instanceof CollabHostError && error.status === 409 && error.code === "conflict";
  }
}

/** assertDirectoryExists, except that a folder the manifest knows but the disk has not received yet exists. */
async function assertSharedDirectoryExists(directory: string, liberaPath: string, message: string, options: SharedWriteOptions) {
  try {
    await assertDirectoryExists(directory, message);
  } catch (error) {
    if (!(await sharedEntryKnown(liberaPath, options, true))) throw error;
  }
}

/** getFileNode, or a size-less stand-in for a file the manifest has and the disk has not received yet. */
async function getSharedFileNode(notebook: string, pathParts: string[], options: SharedWriteOptions) {
  try {
    return await getFileNode(notebook, pathParts);
  } catch (error) {
    if (!(await sharedEntryKnown(relativeFilePath(notebook, pathParts), options, false))) throw error;
    return { size: 0 };
  }
}

export async function createSharedMarkdownFile(notebook: string, name: string, content = "", parentPath?: string, options: SharedWriteOptions = {}) {
  await ensureAdminRoot();
  const parent = parentPath
    ? splitDirectoryPath(parentPath)
    : { notebook: assertSafeSegment(notebook, "Notebook name"), pathParts: [] };
  const safeName = ensureMarkdownName(name);
  const targetParts = [...parent.pathParts, safeName];
  const parentDirectory = itemPath(parent.notebook, parent.pathParts);
  if (!parent.pathParts.length && !(await pathExists(parentDirectory))) throw new StorageError("Notebook does not exist.", 404);
  await assertSharedDirectoryExists(parentDirectory, relativeFilePath(parent.notebook, parent.pathParts), "Destination folder is not a folder.", options);
  if (await pathExists(filePathFromParts(parent.notebook, targetParts))) throw new StorageError("File already exists.", 409);
  const liberaPath = relativeFilePath(parent.notebook, targetParts);
  const created = await createSharedFile(liberaPath, content, options);
  // The path the host's layout gave the file: another device's create can take the name first.
  const placed = created.paths[0] ?? liberaPath;
  notifySearchChanges([placed]);
  return savedFile(placed, Buffer.byteLength(content), async () => content);
}

/** Creates a folder through the manifest so collaborators receive it too. */
export async function createSharedFolder(parentPath: string, name: string, options: SharedWriteOptions = {}): Promise<LiberaTree> {
  await ensureAdminRoot();
  const parent = splitDirectoryPath(parentPath);
  const safeName = assertSafeSegment(name, "Folder name");
  await assertSharedDirectoryExists(itemPath(parent.notebook, parent.pathParts), relativeFilePath(parent.notebook, parent.pathParts), "Parent folder was not found.", options);
  const targetParts = [...parent.pathParts, safeName];
  if (await pathExists(itemPath(parent.notebook, targetParts))) throw new StorageError("Folder already exists.", 409);
  const liberaPath = relativeFilePath(parent.notebook, targetParts);
  const target = manifestTarget(liberaPath);
  const config = hostConfig(liberaPath, options);
  await host(liberaPath, () => fileOp(target.projectId, { op: "create-folder", path: target.path }, config));
  return getTree();
}

/**
 * Whether two paths name the same file or folder: on a case-insensitive disk,
 * "Note.md" exists because "note.md" does. A case-only rename is not a
 * conflict with itself; the host stages it.
 */
async function sameItem(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([stat(left).catch(() => null), stat(right).catch(() => null)]);
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

/** Rename or move within a shared notebook, preserving the manifest entry and document identity. */
export async function moveSharedFile(relativePath: string, destinationDirectory: string, destinationName?: string, options: SharedIdentityOptions = {}) {
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
  const moving = await getSharedFileNode(current.notebook, current.pathParts, options);
  await assertSharedDirectoryExists(itemPath(destination.notebook, destination.pathParts), relativeFilePath(destination.notebook, destination.pathParts), "Destination folder was not found.", options);
  const target = filePathFromParts(destination.notebook, nextParts);
  const own = await sameItem(filePathFromParts(current.notebook, current.pathParts), target);
  if (sourcePath !== nextPath && await pathExists(target) && !own) {
    throw new StorageError("Destination file already exists.", 409);
  }
  // A slot free in the manifest can still hold records of an earlier file on this computer: refused before the host moves anything, as a local move is.
  if (sourcePath !== nextPath && !own) await assertNoLeftoverRecords(destination.notebook, nextParts, assertSupportedFileName(safeName));
  const config = hostConfig(sourcePath, options);
  // The manifest's file ID, before the host moves it: it ties this computer's records to the file, not to a path another file may take.
  const fileId = options.expectedFileId ?? await manifestFileIdAt(current.notebook, sourcePath, options);
  const result = await host(sourcePath, () => fileOp(source.projectId, { op: "rename", path: source.path, to: nextParts.join("/"), ...(options.expectedFileId ? { expectedFileId: options.expectedFileId } : {}) }, config));
  // The host has moved the file and cannot be asked to undo it: from here every step runs, and what stayed behind is reported.
  const committed = committedChanges([{ from: sourcePath, to: nextPath, ...(fileId ? { fileId } : {}) }], result);
  // (The links that pointed at the file follow here, right after the host commits.)
  // The records kept on this computer follow through the host's log of manifest moves (src/lib/storage/shared-record-follow.ts): a response lost after this point, or an exit, is applied by the next drain.
  const followed = sourcePath === nextPath ? { unfinished: [] as string[] } : await followCommittedChange(current.notebook, committed, { config });
  if (followed.unfinished.length) {
    throw new SharedOperationUnfinishedError(`The file was moved, but these records could not be moved with it and stay at the old path: ${followed.unfinished.join("; ")}. Run Check Notebook to settle them.`, committed, followed.unfinished);
  }
  return savedFile(nextPath, moving.size, () => readSharedText(nextPath, options).then((result) => result.text, () => undefined));
}

/** The manifest file ID at a Libera path, or undefined when the list cannot be read or has nothing there. */
async function manifestFileIdAt(notebook: string, liberaPath: string, options: SharedWriteOptions): Promise<string | undefined> {
  try {
    return (await listSharedEntries(notebook, options)).find((entry) => entry.path === liberaPath)?.fileId;
  } catch {
    return undefined;
  }
}

type PlannedChange = SharedCommittedChange & { kind?: "file" | "folder" };

/**
 * The mapping an operation committed, for SharedOperationUnfinishedError and the
 * records' follow-up. One place: the host's result says exactly what it moved
 * (`moves`, companions included); `planned` (the list read before) stands in when it does not.
 */
function committedChanges(planned: PlannedChange[], result: FileOpResult): PlannedChange[] {
  if (!result.moves?.length) return planned;
  const kinds = new Map(planned.map((change) => [change.from, change.kind]));
  const committed: PlannedChange[] = result.moves.map((move) => ({ from: move.from, to: move.to, fileId: move.fileId, kind: kinds.get(move.from) ?? "file" }));
  // A folder the manifest holds only as the directory of its files has no entry of its own, so no move: its panel state and tags still follow.
  for (const change of planned) if (change.kind === "folder" && !change.fileId && !committed.some((move) => move.from === change.from)) committed.push(change);
  return committed;
}

/** The folder itself and everything under it in the manifest list, mapped to the renamed folder (`nextPath`) or to nothing (a delete). */
function plannedFolderChanges(entries: import("./local-api").FileListEntry[], folderPath: string, nextPath: string | null): PlannedChange[] {
  const planned: PlannedChange[] = [];
  let hasFolder = false;
  for (const entry of entries) {
    if (entry.path !== folderPath && !entry.path.startsWith(`${folderPath}/`)) continue;
    if (entry.path === folderPath) hasFolder = true;
    planned.push({ from: entry.path, to: nextPath === null ? null : nextPath + entry.path.slice(folderPath.length), fileId: entry.fileId, kind: entry.kind === "folder" ? "folder" : "file" });
  }
  // A folder the manifest holds only as the directory of its files has no entry of its own; its panel state and tags still follow.
  if (!hasFolder) planned.push({ from: folderPath, to: nextPath, kind: "folder" });
  return planned;
}

/** Delete via the manifest; the host removes the working copy and syncs the deletion. */
export async function deleteSharedFile(relativePath: string, options: SharedIdentityOptions & { deferRefresh: true }): Promise<null>;
export async function deleteSharedFile(relativePath: string, options?: SharedIdentityOptions): Promise<LiberaTree>;
export async function deleteSharedFile(relativePath: string, options: SharedIdentityOptions = {}): Promise<LiberaTree | null> {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);
  const liberaPath = relativeFilePath(current.notebook, current.pathParts);
  await getSharedFileNode(current.notebook, current.pathParts, options);
  const target = manifestTarget(liberaPath);
  const config = hostConfig(liberaPath, options);
  const fileId = options.expectedFileId ?? await manifestFileIdAt(current.notebook, liberaPath, options);
  const result = await host(liberaPath, () => fileOp(target.projectId, { op: "delete", path: target.path, ...(options.expectedFileId ? { expectedFileId: options.expectedFileId } : {}) }, config));
  // The host has deleted it and cannot be asked to undo it. This user deleted it, so the records kept on this computer go too, as in a local notebook:
  // through the host's log of manifest changes, so an exit before this finishes is applied by the next drain. Every step runs; what stayed behind is reported.
  const committed = committedChanges([{ from: liberaPath, to: null, ...(fileId ? { fileId } : {}) }], result);
  const followed = await followCommittedChange(current.notebook, committed, { config });
  if (followed.unfinished.length) {
    throw new SharedOperationUnfinishedError(`The file was deleted, but its ${followed.unfinished.join(", ")} could not be removed. Run Check Notebook to settle them.`, committed, followed.unfinished);
  }
  if (options.deferRefresh) return null;
  // If it is slower than this, the host says when the file has left the disk.
  await diskCaughtUp(liberaPath, false);
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
  await assertSharedDirectoryExists(itemPath(current.notebook, current.pathParts), sourcePath, "Folder was not found.", options);
  if (sourcePath !== nextPath && await pathExists(itemPath(current.notebook, parts))) {
    // The host places a folder's files back into the folder the disk already has, so its case would not change.
    if (await sameItem(itemPath(current.notebook, current.pathParts), itemPath(current.notebook, parts))) {
      throw new StorageError("A shared folder's name cannot change only in letter case. Rename it to a different name first.", 409);
    }
    throw new StorageError("Destination folder already exists.", 409);
  }
  // A name free in the manifest can still hold records of earlier files on this computer: refused before the host renames, as a local rename is.
  if (sourcePath !== nextPath) await assertNoLeftoverFolderRecords(current.notebook, parts);
  // The files under the folder, as the manifest has them before the rename: their records move with them below.
  const listed = sourcePath === nextPath ? [] : await listSharedEntries(current.notebook, options);
  const reviewed = listed.filter((entry) => entry.path.startsWith(`${sourcePath}/`));
  const config = hostConfig(sourcePath, options);
  // The host renames the folder only if it still holds exactly the entries listed here.
  const result = await host(sourcePath, () => fileOp(source.projectId, { op: "rename", path: source.path, to: parts.join("/"), ...(sourcePath === nextPath ? {} : { expectedDescendantIds: reviewed.map((entry) => entry.fileId) }) }, config));
  // The manifest has renamed; the host cannot be asked to undo it. The records kept on this computer follow, as for a local folder rename:
  // through the host's log, with every step run and what could not move reported.
  const committed = committedChanges(sourcePath === nextPath ? [] : plannedFolderChanges(listed, sourcePath, nextPath), result);
  // (The links that pointed into the folder follow here, right after the host commits.)
  const followed = committed.length ? await followCommittedChange(current.notebook, committed, { config }) : { unfinished: [] as string[] };
  if (followed.unfinished.length) {
    throw new SharedOperationUnfinishedError(`The folder was renamed, but these records could not be moved with it and stay at the old path: ${followed.unfinished.join("; ")}. Run Check Notebook to settle them.`, committed, followed.unfinished);
  }
  return getTree();
}

export async function deleteSharedFolder(relativePath: string, options: SharedWriteOptions = {}): Promise<LiberaTree> {
  await ensureAdminRoot();
  const current = splitDirectoryPath(relativePath);
  if (!current.pathParts.length) throw new StorageError("Use notebook delete to remove a notebook.");
  const liberaPath = relativeFilePath(current.notebook, current.pathParts);
  const target = manifestTarget(liberaPath);
  await assertSharedDirectoryExists(itemPath(current.notebook, current.pathParts), liberaPath, "Folder was not found.", options);
  const config = hostConfig(liberaPath, options);
  // The host deletes the folder only if it still holds exactly the entries listed here.
  const listed = await listSharedEntries(current.notebook, options);
  const reviewed = listed.filter((entry) => entry.path.startsWith(`${liberaPath}/`));
  const result = await host(liberaPath, () => fileOp(target.projectId, { op: "delete", path: target.path, expectedDescendantIds: reviewed.map((entry) => entry.fileId) }, config));
  // The host has deleted them and cannot be asked to undo it. The records kept on this computer go too, as in a local folder delete:
  // through the host's log; every step runs and what stayed behind is reported.
  const committed = committedChanges(plannedFolderChanges(listed, liberaPath, null), result);
  const followed = await followCommittedChange(current.notebook, committed, { config });
  if (followed.unfinished.length) {
    throw new SharedOperationUnfinishedError(`The folder was deleted, but its ${followed.unfinished.join(", ")} could not be removed. Run Check Notebook to settle them.`, committed, followed.unfinished);
  }
  return getTree();
}

/**
 * The records the manifest holds for a path that is vacant: companions (ink,
 * a note's Python code, a recording's transcript) of a file that was there
 * before. The disk side is assertNoLeftoverRecords; a follower's disk can lag.
 */
function manifestCompanionRecords(entryPaths: string[], notebook: string, parts: string[], fileType: string): string[] {
  const lower = entryPaths.map((entry) => entry.toLowerCase());
  const relative = relativeFilePath(notebook, parts);
  const kept: string[] = [];
  if (supportsInk(fileType) && lower.some((entry) => entry.startsWith(`${inkLibraryPath(notebook, parts)}/`.toLowerCase()))) kept.push("ink");
  if (fileType === "markdown" && lower.includes(pythonSidecarPath(relative).toLowerCase())) kept.push("Python code");
  if (fileType === "audio" && lower.includes(transcriptCompanionPath(relative).toLowerCase())) kept.push("transcript");
  return kept;
}

/**
 * A new file at a path of a shared notebook must not take over the records of a
 * file that was there before (as a move onto it is refused): this computer's
 * records, and the companions the manifest still lists. A host that cannot list
 * the notebook is an error: the check cannot be made.
 */
async function assertSharedPathFree(notebook: string, parts: string[], fileType: string, options: SharedWriteOptions, again: string) {
  await assertNoLeftoverRecords(notebook, parts, fileType, false, undefined, again);
  const kept = manifestCompanionRecords((await listSharedEntries(notebook, options)).map((entry) => entry.path), notebook, parts, fileType);
  if (!kept.length) return;
  const list = kept.length > 1 ? `${kept.slice(0, -1).join(", ")} and ${kept.at(-1)}` : kept[0];
  throw new StorageError(`${relativeFilePath(notebook, parts)} still has the ${list} of a file that was there before. Check the notebook to give them to a file or remove them, then ${again} again.`, 409);
}

/** The ink files of a file, by name, from the host's manifest (shared source) or the disk. */
async function readSourceInk(relativePath: string, fileType: string, listed: import("./local-api").FileListEntry[] | null): Promise<{ name: string; bytes: Buffer }[]> {
  if (!supportsInk(fileType)) return [];
  const source = splitFilePath(relativePath);
  if (listed) {
    const prefix = `${inkLibraryPath(source.notebook, source.pathParts)}/`;
    const files: { name: string; bytes: Buffer }[] = [];
    for (const entry of listed) {
      if (entry.kind !== "blob" || !entry.path.startsWith(prefix) || entry.path.slice(prefix.length).includes("/")) continue;
      const blob = await readSharedBlob(entry.path);
      if (blob.contentBase64 !== null) files.push({ name: entry.path.slice(prefix.length), bytes: Buffer.from(blob.contentBase64, "base64") });
    }
    return files;
  }
  const folder = inkFolderPath(source.notebook, source.pathParts);
  const names = await readdir(folder, { withFileTypes: true }).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
  return Promise.all(names.filter((entry) => entry.isFile()).map(async (entry) => ({ name: entry.name, bytes: await readFile(path.join(folder, entry.name)) })));
}

/** A note's Python code, from the host (shared source) or the disk; null when it has none. */
async function readSourcePython(relativePath: string, shared: boolean): Promise<string | null> {
  const codePath = pythonSidecarPath(relativePath);
  if (shared) {
    const code = await readSharedSourceSnapshot(codePath, true);
    if (code.authority) return code.kind === "absent" ? null : code.kind === "text" ? code.text : code.bytes.toString("utf8");
  } else {
    await migratePythonSidecar(relativePath);
  }
  const target = splitFilePath(codePath);
  return readFile(filePathFromParts(target.notebook, target.pathParts), "utf8").catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
}

/**
 * Copy into a shared notebook as a new manifest entry. The copy is built from one
 * identity-bound snapshot of the source (the host's text or blob for a shared
 * source, so the follower's disk copy is not needed, and a source the host no
 * longer lists is refused), mapped and rewritten before the host creates anything,
 * and published as supplied. Everything after the host commits (records, search)
 * uses the committed file ID and the path the host chose; a step that fails is
 * reported in `unfinished` and never undoes the copy.
 */
export async function copyFileIntoSharedDirectory(relativePath: string, destinationDirectory: string, destinationName?: string, options: SharedWriteOptions = {}): Promise<LiberaFileMovePayload> {
  await ensureAdminRoot();
  const current = splitFilePath(relativePath);
  const destination = splitDirectoryPath(destinationDirectory);
  const extension = path.extname(current.name);
  const requestedName = destinationName?.trim()
    ? assertSafeSegment(destinationName, "File name")
    : `${path.basename(current.name, extension)} copy${extension}`;
  const fileType = assertSupportedFileName(current.name);
  assertCopyKeepsType(fileType, requestedName);
  const textFile = isTextFileType(fileType);

  // One read of the source: the host's version, or (no host to ask) the disk's.
  const snapshot = await readSharedSourceSnapshot(relativePath, textFile);
  if (snapshot.authority && snapshot.kind === "absent") throw sharedSourceGone(relativePath);
  let sourceBytes: Buffer | null = null;
  let sourceText: string | null = null;
  if (snapshot.authority) {
    if (snapshot.kind === "text") sourceText = snapshot.text;
    else if (snapshot.kind === "blob") sourceBytes = snapshot.bytes;
  } else {
    await getFileNode(current.notebook, current.pathParts);
    if (textFile) sourceText = (await readLiberaFile(relativePath, { requireContent: true })).content ?? "";
    else sourceBytes = await readFile(filePathFromParts(current.notebook, current.pathParts));
  }
  if (textFile && sourceText === null) sourceText = (sourceBytes ?? Buffer.alloc(0)).toString("utf8");

  const directory = itemPath(destination.notebook, destination.pathParts);
  if (destination.pathParts.length) await assertSharedDirectoryExists(directory, relativeFilePath(destination.notebook, destination.pathParts), "Destination folder was not found.", options);
  else await assertDirectoryExists(directory, "Destination folder was not found.");

  // A name that holds no file (on disk or in the manifest), nor records of one that was there before.
  const listed = await listSharedEntries(destination.notebook, options);
  const listedPaths = listed.map((entry) => entry.path);
  const taken = new Set(listedPaths.map((entry) => entry.toLowerCase()));
  const records = await destinationRecords();
  if (records.blocker) throw new StorageError(records.blocker, 409);
  const requestedExtension = path.extname(requestedName);
  const stem = path.basename(requestedName, requestedExtension);
  let parts: string[];
  for (let index = 0; ; index += 1) {
    const candidate = [...destination.pathParts, index ? `${stem}-${index}${requestedExtension}` : requestedName];
    if (taken.has(relativeFilePath(destination.notebook, candidate).toLowerCase())) continue;
    if (await pathExists(itemPath(destination.notebook, candidate))) continue;
    if ((await records.at(destination.notebook, candidate, fileType)).length || manifestCompanionRecords(listedPaths, destination.notebook, candidate, fileType).length) continue;
    parts = candidate;
    break;
  }
  const liberaPath = relativeFilePath(destination.notebook, parts);
  // Validate the destination and service before creating anything.
  manifestTarget(liberaPath);
  const config = hostConfig(liberaPath, options);

  // The source's records, read before anything is created so a failure leaves nothing behind.
  const sourceIsShared = snapshot.authority;
  const sourceListed = !sourceIsShared ? null : current.notebook === destination.notebook ? listed : await listSharedEntries(current.notebook, options);
  if (fileType === "pdf") await migratePdfAnnotations(current.notebook, current.pathParts);
  if (fileType === "image") await migrateImageAnnotations(current.notebook, current.pathParts);
  const ink = await readSourceInk(relativePath, fileType, sourceListed);
  const python = fileType === "markdown" ? await readSourcePython(relativePath, sourceIsShared) : null;

  const unfinished: LiberaMoveStep[] = [];
  const createdAssets: { path: string; fileId?: string }[] = [];
  const removeCreatedAssets = async () => {
    const left: string[] = [];
    for (const asset of createdAssets.reverse()) {
      const assetTarget = manifestTarget(asset.path);
      try { await host(asset.path, () => fileOp(assetTarget.projectId, { op: "delete", path: assetTarget.path, ...(asset.fileId ? { expectedFileId: asset.fileId } : {}) }, config)); }
      catch (error) { if (!(error instanceof SharedWriteError && error.status === 404)) left.push(asset.path); }
    }
    createdAssets.length = 0;
    return left;
  };
  const failed = async (error: unknown, remove: boolean): Promise<never> => {
    const left = remove ? await removeCreatedAssets() : createdAssets.map((asset) => asset.path);
    if (!left.length) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const stuck = remove ? `The images added for the copy could not be removed: ${left.join(", ")}. Run Check Notebook to settle them.` : `Images were added for the copy and may belong to it: ${left.join(", ")}.`;
    throw new StorageError(`${message} ${stuck}`, error instanceof StorageError ? error.status : 500);
  };

  let content = sourceText;
  let references: ReferenceMoveResult | null = null;
  let keyMap = new Map<string, string>();
  let pdfSeed: import("./protocol/pdf").PdfImportRequest | undefined;
  let copiedImages = 0;
  let placed: FileOpResult;
  try {
    if (fileType === "markdown" && content !== null) {
      // The copy cites what the destination library holds: references are copied or mapped as for a move, in its text.
      try {
        const mapped = await mapReferencesForCopyText(current.notebook, destination.notebook, content);
        content = mapped.text;
        references = mapped.references;
        keyMap = mapped.map;
      } catch (error) {
        throw new StorageError(`The references ${relativePath} cites could not be copied into ${destination.notebook}, so nothing was copied: ${error instanceof Error ? error.message : String(error)}`, 409);
      }
      // Give the copy its own assets; deleting or editing an original must not break a copy. Parsed image destinations only.
      const imageSources: Record<string, string> = {};
      const copied = new Map<string, string>();
      let missing = 0;
      for (const source of markdownImageSources(content)) {
        if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(source)) continue;
        if (source.startsWith("/") && !source.startsWith("/api/markdown-assets/raw") && !source.startsWith("/api/files/raw/")) continue;
        let asset;
        try { asset = await getMarkdownImageAssetBySource(relativePath, source, { authoritative: true }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            // Kept in its original namespace, so an unrelated image of the destination cannot take its place.
            const missingTarget = markdownAssetSourceTarget(relativePath, source);
            if (missingTarget) imageSources[source] = `/api/markdown-assets/raw?document=${encodeURIComponent(missingTarget.documentPath)}&asset=${encodeURIComponent(missingTarget.assetPath)}`;
            missing += 1;
            continue;
          }
          if (error instanceof StorageError && error.status < 409) continue;
          throw error;
        }
        const origin = markdownAssetSourceTarget(relativePath, source);
        const key = source.startsWith("/api/files/raw/") ? `raw:${asset.assetPath}` : `asset:${splitFilePath(origin?.documentPath ?? relativePath).notebook}/${asset.assetPath}`;
        const existing = copied.get(key);
        if (existing) { imageSources[source] = existing; continue; }
        const assetPath = `${markdownAssetsPathPrefix(parts)}/${randomUUID()}/${assertSafeSegment(asset.fileName, "Image name")}`;
        const written = await writeSharedBlob(`${destination.notebook}/${assetPath}`, new Uint8Array(asset.body), { ...options, createOnly: true });
        const writtenPath = written.paths[0] ?? `${destination.notebook}/${assetPath}`;
        createdAssets.push({ path: writtenPath, ...(written.fileId ? { fileId: written.fileId } : {}) });
        imageSources[source] = writtenPath.slice(destination.notebook.length + 1);
        copied.set(key, imageSources[source]);
      }
      content = rewriteMarkdownImageSources(content, imageSources);
      copiedImages = createdAssets.length;
      if (missing) unfinished.push({ step: "images", status: "held", message: `${missing} image${missing === 1 ? "" : "s"} the note links to could not be found, so ${missing === 1 ? "it stays" : "they stay"} linked to the original's location.` });
    }

    if (fileType === "pdf") {
      const source = snapshot.authority ? await host(relativePath, () => resolveSharedPdf(relativePath, config)) : null;
      if (source) pdfSeed = await host(relativePath, () => livePdfSnapshot(source.docId, config));
      else {
        const sidecar = await readFile(pdfAnnotationsPath(current.notebook, current.pathParts), "utf8").then((text) => JSON.parse(text)).catch((error) => { if (error.code === "ENOENT") return {}; throw error; });
        pdfSeed = { marks: sidecar.annotations ?? [], comments: sidecar.comments ?? [], sourceHash: sidecar.source?.contentHash };
      }
      const ids = new Map<string, string>();
      const fresh = (id: string) => { if (!ids.has(id)) ids.set(id, randomUUID()); return ids.get(id)!; };
      pdfSeed.marks = pdfSeed.marks.map((value) => {
        const mark = value as { id: string; space?: string };
        return { ...mark, id: fresh(mark.id), ...(mark.space ? { space: fresh(mark.space) } : {}) };
      });
    }
  } catch (error) {
    return failed(error, true);
  }

  try {
    placed = content !== null
      ? await createSharedFile(liberaPath, content, { ...options, recordsChecked: true })
      : await writeSharedBlob(liberaPath, new Uint8Array(sourceBytes ?? Buffer.alloc(0)), { ...options, createOnly: true, pdfSeed });
  } catch (error) {
    // A clear refusal leaves nothing: the assets are removed. Anything else may have committed the copy.
    return failed(error, error instanceof SharedWriteError && error.status >= 400 && error.status < 500);
  }

  // Committed. From here nothing fails the copy: each step reports itself.
  const placedPath = placed.paths[0] ?? liberaPath;
  const placedParts = splitFilePath(placedPath).pathParts;
  const step = async (name: LiberaMoveStep["step"], what: string, run: () => Promise<unknown>) => {
    try { await run(); }
    catch (error) {
      console.error(`[files] ${what} did not follow the copy of ${relativePath} to ${placedPath}:`, error);
      unfinished.push({ step: name, status: "failed", message: `${what} did not copy: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  if (placedPath.toLowerCase() !== liberaPath.toLowerCase() && copiedImages) {
    unfinished.push({ step: "images", status: "held", message: `Another collaborator took the name at the same moment, so the copy is ${placedPath}. Its images stay under ${liberaPath}.` });
  }
  notifySearchChanges([placedPath]);

  // The records follow the committed file only: it may have been moved or deleted by a collaborator since.
  let owned = true;
  await step("metadata", "The records of the copy", async () => {
    const mine = (await listSharedEntries(destination.notebook, options)).find((entry) => entry.path.toLowerCase() === placedPath.toLowerCase());
    if (!mine || (placed.fileId && mine.fileId !== placed.fileId)) {
      owned = false;
      unfinished.push({ step: "metadata", status: "held", message: `${placedPath} was moved or deleted by a collaborator right after it was copied, so its records (annotations, ink, Python code, review comments) were not copied.` });
    }
  });
  if (owned) {
    const publish = async (what: string, filePath: string, bytes: Uint8Array) => { await step("metadata", what, () => writeSharedBlob(filePath, bytes, { ...options, createOnly: true, ...(placed.fileId ? { ownerFileId: placed.fileId } : {}) })); };
    if (python !== null) await publish("The Python code", pythonSidecarPath(placedPath), new TextEncoder().encode(withPreviousPythonFigureSources(python, [])));
    for (const file of ink) await publish("The ink", `${inkLibraryPath(destination.notebook, placedParts)}/${file.name}`, new Uint8Array(file.bytes));
    if (fileType === "audio") await step("metadata", "The transcript", () => copyTranscript(relativePath, placedPath));
    const copyLocal = (what: string, from: string, to: string) => step("metadata", what, () => copyFileIfExists(from, to, { exclusive: true }));
    if (fileType === "pdf") {
      // A copy's marks are its own. On a notebook with live PDFs, the host merged them into the copy's document.
      await step("metadata", "The annotations", async () => {
        if (!(await listProjects(config)).find((project) => project.notebook === destination.notebook)?.pdfLive) {
          await copyFileIfExists(pdfAnnotationsPath(current.notebook, current.pathParts), pdfAnnotationsPath(destination.notebook, placedParts), { exclusive: true });
        }
      });
      await copyLocal("The outline", pdfOutlinePath(current.notebook, current.pathParts), pdfOutlinePath(destination.notebook, placedParts));
    }
    if (fileType === "image") await copyLocal("The annotations", imageAnnotationsPath(current.notebook, current.pathParts), imageAnnotationsPath(destination.notebook, placedParts));
    if (DEFINITIONS_FILE_TYPES.some((type) => type === fileType)) await copyLocal("The definitions", definitionsPath(current.notebook, current.pathParts), definitionsPath(destination.notebook, placedParts));
    await step("reviews", "The review comments", () => copyReviewPath(relativePath, placedPath, keyMap.size ? (text) => rewriteCitationKeys(text, keyMap).text : undefined));
  }
  if (references && keyMap.size) references.drafts.push({ path: placedPath, map: Object.fromEntries(keyMap) });

  const file = await savedFile(placedPath, content !== null ? Buffer.byteLength(content) : (sourceBytes?.byteLength ?? 0), async () => content ?? undefined);
  return { ...file, ...(references ? { references } : {}), ...(unfinished.length ? { unfinished } : {}) };
}

/** The host refused a createOnly write because the path is taken in the manifest. */
function isSharedNameTaken(error: unknown) {
  return error instanceof SharedWriteError && error.status === 409 && error.code === "conflict";
}

/**
 * Creates a new blob under the first name that is free on disk AND in the
 * host's manifest (a follower's disk can lag it): each attempt is createOnly,
 * and the host's "already exists" refusal moves on to the next candidate.
 */
async function createSharedBlobAtFreeName(directory: string, libraryPath: (name: string) => string, fileName: string, bytes: Uint8Array, options: SharedWriteOptions): Promise<string> {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  const records = await destinationRecords();
  if (records.blocker) throw new StorageError(records.blocker, 409);
  const fileType = getFileType(fileName);
  for (let index = 0; index < 1000; index += 1) {
    const candidate = index === 0 ? fileName : `${stem}-${index}${extension}`;
    if (await pathExists(path.join(directory, candidate))) continue;
    // Not a name that still holds the records of an earlier file.
    // (A note's _assets folder holds uploads, not files with records.)
    const [namedNotebook, ...namedParts] = libraryPath(candidate).split("/");
    if (namedParts[0] !== MARKDOWN_ASSETS_DIR && (await records.at(namedNotebook, namedParts, fileType)).length) continue;
    try {
      const placed = await writeSharedBlob(libraryPath(candidate), bytes, { ...options, createOnly: true });
      // The name the host's layout gave it, which differs when another device created the same name at once.
      return placed.paths[0] ? path.posix.basename(placed.paths[0]) : candidate;
    } catch (error) {
      if (!isSharedNameTaken(error)) throw error;
    }
  }
  throw new StorageError(`Could not find a free name for ${fileName}.`, 409);
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
  // A name that holds the records of an earlier file is refused, as a move onto it is.
  await assertSharedPathFree(destination.notebook, targetParts, assertSupportedFileName(safeName), options, "upload");
  // createOnly: the disk may lag the manifest, so a free name here proves nothing about the shared notebook.
  const created = await writeSharedBlob(liberaPath, new Uint8Array(await upload.arrayBuffer()), { ...options, createOnly: true }).catch((error) => {
    if (isSharedNameTaken(error)) throw new StorageError(`File already exists: ${safeName}`, 409);
    throw error;
  });
  const placed = created.paths[0] ?? liberaPath;
  notifySearchChanges([placed]);
  return savedNode(placed, upload.size);
}

/** writeMarkdownImageAsset for a document in a shared notebook: the image becomes a blob under the notebook's _assets. */
export async function writeSharedMarkdownImageAsset(documentPath: string, upload: File, options: SharedWriteOptions = {}): Promise<MarkdownImageAssetPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  await stat(filePathFromParts(notebook, pathParts));
  const safeName = normalizeAssetFileName(ensureImageName(upload.name));
  const assetName = await createSharedBlobAtFreeName(markdownAssetsDirectoryPathFromParts(notebook, pathParts), (name) => `${notebook}/${markdownAssetsPathPrefix(pathParts)}/${name}`, safeName, new Uint8Array(await upload.arrayBuffer()), options);
  const assetPath = `${markdownAssetsPathPrefix(pathParts)}/${assetName}`;
  return {
    assetPath,
    markdown: `![${path.basename(assetName, path.extname(assetName))}](${assetPath})`,
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
  const body = await renderEditedPhoto((await readSharedAuthorityBytes(relativePath)) ?? filePathFromParts(notebook, pathParts), edits, format);
  const directoryParts = pathParts.slice(0, -1);
  const editedName = await createSharedBlobAtFreeName(itemPath(notebook, directoryParts), (candidate) => relativeFilePath(notebook, [...directoryParts, candidate]), `${path.basename(name, path.extname(name))} (edited)${extension}`, new Uint8Array(body), options);
  const liberaPath = relativeFilePath(notebook, [...directoryParts, editedName]);
  await copyInkThroughEdit(relativeFilePath(notebook, pathParts), liberaPath, edits);
  notifySearchChanges([liberaPath]);
  return { file: await savedNode(liberaPath, body.byteLength), tree: await getTree() };
}
