import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseInkBlockSource } from "@/lib/ink/block";
import { createInkAuthorKey, inkFileName, isInkAuthorKey, isInkChunkName, pageNumberOfChunk, parseInkFileName } from "@/lib/ink/authors";
import { canWriteInkFile, emptyInkAuthorFile, encodeInkSamples, normalizeInkAuthorFile, normalizeInkFrame, normalizeInkStroke, sampleBounds, strokeSamples } from "@/lib/ink/codec";
import { originalToView, photoViewSize, type PhotoInkView } from "@/lib/ink/frame";
import { applyInkOps, mergeInkFiles } from "@/lib/ink/merge";
import { inkToSvg } from "@/lib/ink/svg";
import type { InkAuthor, InkAuthorFile, InkFrame, InkOps, InkSource, InkStroke, MergedInkStroke } from "@/lib/ink/types";
import { isSharedNotebookPath, sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { INK_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getFileType } from "@/lib/storage/file-types";
import { moveFileIfExists, pathExists, writeJsonAtomically } from "@/lib/storage/fs-utils";
import { fileExistence } from "@/lib/storage/library-links";
import { cachedPdfIdentity } from "@/lib/storage/pdf-identity";
import { matchByIdentity, mayBeBack, moveToFreeSlot, ORPHAN_GRACE_MS, ORPHAN_RETENTION_MS, slotTakenBy } from "@/lib/storage/pdf-sidecars";
import { assertNotMigrating } from "@/lib/storage/migration-fence";
import {
  ensureAdminRoot,
  filePathFromParts,
  getDataRoot,
  markdownAssetPath,
  notebookPath,
  orphanedSidecarsDirectoryPath,
  relativeFilePath,
  splitFilePath,
} from "@/lib/storage/paths";

// A notebook file's ink lives in `<notebook>/_ink/<folders>/<file name>/`,
// one file per chunk and author: `page-0001.<author>.ink` (docs/ink-plan.md,
// "Storage"). Only this computer's author file is ever written here; other
// authors' files arrive through the collab host or a sync client and are
// only read. files.ts takes the folder along when Libera renames, moves,
// copies, archives or deletes the file; shared-writes.ts does the same
// through the host for shared notebooks; `reconcileInkFolders` follows PDFs
// and images renamed outside Libera.

/** Files that take ink, by Libera file type. */
type InkFileType = "pdf" | "image" | "markdown";
const INK_FILE_TYPES: ReadonlySet<string> = new Set<InkFileType>(["pdf", "image", "markdown"]);
/** An author file larger than this is refused rather than written. */
const MAX_INK_FILE_BYTES = 16 * 1024 * 1024;
const MAX_STROKES_PER_FILE = 50_000;

export function supportsInk(fileType: string | null): fileType is InkFileType {
  return fileType !== null && INK_FILE_TYPES.has(fileType);
}

/** The folder holding a file's (or a folder's files') ink. */
export function inkFolderPath(notebook: string, pathParts: string[]) {
  // filePathFromParts checks every segment; the ink folder mirrors them.
  const filePath = filePathFromParts(notebook, pathParts);
  const root = notebookPath(notebook);
  return path.join(root, INK_DIR, path.relative(root, filePath));
}

/** The library path of an ink folder or file, for the collab host. */
export function inkLibraryPath(notebook: string, pathParts: string[], fileName?: string) {
  return [notebook, INK_DIR, ...pathParts, ...(fileName ? [fileName] : [])].join("/");
}

/** Which chunks a file type has: PDF pages, or a note's blocks and text, or one image. */
/** Whether a chunk is one this kind of file has: a PDF's pages, a note's text and blocks, an image. */
function chunkFits(fileType: string, chunk: string) {
  return fileType === "pdf"
    ? pageNumberOfChunk(chunk) !== null
    : fileType === "markdown"
      ? chunk === "text" || chunk.startsWith("block-")
      : fileType === "image" && chunk === "image";
}

function assertChunkFor(fileType: string, chunk: string) {
  if (!isInkChunkName(chunk)) throw new StorageError("Ink chunk is invalid.");
  if (!chunkFits(fileType, chunk)) throw new StorageError("That ink chunk does not belong to this kind of file.");
}

/**
 * The ink files of a folder that a file of `fileType` has no chunk for (a PDF's
 * pages are not an image's, an image's chunk is not a note's), by name. A
 * rename to another file type is refused while there are any, as for any
 * other record the new type cannot use. Reads names only; throws when the
 * folder can't be listed.
 */
export async function inkChunksTheTypeLacks(folder: string, fileType: string): Promise<string[]> {
  return (await readdir(folder)).filter((name) => {
    const parsed = parseInkFileName(name);
    return parsed !== null && !chunkFits(fileType, parsed.chunk);
  });
}

export type InkFolderInspection = {
  /** Ink files the reader leaves out: not readable as ink, or named for another author than the one inside. */
  unreadable: string[];
  /** Ink files of a chunk this kind of file does not have, so never shown. */
  misplaced: string[];
  /** Strokes left out of the files that are read. */
  droppedStrokes: number;
  /** The bytes of the file the ink was drawn on, as each author file recorded them. */
  sources: InkSource[];
  /** The same, with the author file that recorded each. */
  sourceFiles: { name: string; source: InkSource }[];
  bytes: number;
};

/**
 * What the ink reader (readInkFolder) makes of one file's ink folder, for the
 * notebook check (storage/integrity.ts). Reads only; a folder that can't be
 * listed throws.
 */
export async function inspectInkFolder(folder: string, fileType: string): Promise<InkFolderInspection> {
  const result: InkFolderInspection = { unreadable: [], misplaced: [], droppedStrokes: 0, sources: [], sourceFiles: [], bytes: 0 };
  for (const name of await readdir(folder)) {
    // Other files (a sync service's conflict copy, system files) are not ink.
    const parsed = parseInkFileName(name);
    if (!parsed) continue;
    if (!chunkFits(fileType, parsed.chunk)) result.misplaced.push(name);
    let text: string;
    try { text = await readFile(path.join(folder, name), "utf8"); } catch { result.unreadable.push(name); continue; }
    result.bytes += text.length;
    let stored: unknown = null;
    try { stored = JSON.parse(text); } catch { /* Not ink. */ }
    const file = normalizeInkAuthorFile(stored);
    if (!file || file.author.key !== parsed.author) { result.unreadable.push(name); continue; }
    const strokes = (stored as { strokes?: unknown }).strokes;
    result.droppedStrokes += Math.max(0, (Array.isArray(strokes) ? strokes.length : 0) - file.strokes.length);
    if (file.source) { result.sources.push(file.source); result.sourceFiles.push({ name, source: file.source }); }
  }
  return result;
}

// ---- This computer's author --------------------------------------------------

let authorTask: Promise<InkAuthor> | null = null;

/**
 * Per user and computer: next to the user's Libera config, never in the master
 * directory, which may sync to the same person's other computers.
 */
function authorPath() {
  const config = process.env.LIBERA_CONFIG_PATH;
  return config ? path.join(path.dirname(config), "ink-author.json") : path.join(getDataRoot(), ".libera", "local", "ink-author.json");
}

export function inkAuthor(): Promise<InkAuthor> {
  authorTask ??= (async () => {
    const file = authorPath();
    try {
      const value = JSON.parse(await readFile(file, "utf8")) as { key?: unknown };
      if (isInkAuthorKey(value.key)) return { key: value.key };
    } catch {
      // Missing or unreadable: make one.
    }
    const author = { key: createInkAuthorKey() };
    await writeJsonAtomically(file, author);
    return author;
  })();
  authorTask.catch(() => { authorTask = null; });
  return authorTask;
}

// ---- Reading ---------------------------------------------------------------------

export type InkChunkPayload = {
  chunk: string;
  frame: InkFrame | null;
  strokes: MergedInkStroke[];
  /** This author's file revision; 0 when they have not inked here. */
  revision: number;
  /** A Markdown ink block's rendering was asked about and is not on disk: the next Save writes it. */
  renderingMissing?: boolean;
};

export type InkPayload = {
  path: string;
  author: string;
  chunks: InkChunkPayload[];
};

async function readAuthorFile(file: string): Promise<InkAuthorFile | null> {
  try {
    return normalizeInkAuthorFile(JSON.parse(await readFile(file, "utf8")));
  } catch {
    // Missing, half-synced or corrupt: it holds no ink we can draw.
    return null;
  }
}

/** Every author's file in a folder, by chunk. */
export async function readInkFolder(folder: string, only?: Set<string>) {
  const byChunk = new Map<string, InkAuthorFile[]>();
  const names = await readdir(folder).catch(() => [] as string[]);
  await Promise.all(names.map(async (name) => {
    const parsed = parseInkFileName(name);
    if (!parsed || (only && !only.has(parsed.chunk))) return;
    const file = await readAuthorFile(path.join(folder, name));
    // A file renamed by hand to another author's name is not that author's.
    if (!file || file.author.key !== parsed.author) return;
    const list = byChunk.get(parsed.chunk) ?? [];
    list.push(file);
    byChunk.set(parsed.chunk, list);
  }));
  return byChunk;
}

export function chunkPayload(chunk: string, files: InkAuthorFile[], author: string): InkChunkPayload {
  const merged = mergeInkFiles(files);
  return { chunk, frame: merged.frame, strokes: merged.strokes, revision: files.find((file) => file.author.key === author)?.revision ?? 0 };
}

async function assertInkFile(relativePath: string) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(relativePath);
  const fileType = getFileType(name);
  if (!supportsInk(fileType)) throw new StorageError("This kind of file does not take ink.");
  const sourcePath = filePathFromParts(notebook, pathParts);
  await stat(sourcePath);
  return { notebook, pathParts, fileType, sourcePath, folder: inkFolderPath(notebook, pathParts) };
}

/**
 * Merged ink of a file: the chunks asked for, or every chunk with ink. With
 * `rendering` (one Markdown ink block), says whether its SVG is missing.
 */
export async function readInk(relativePath: string, chunks?: string[], rendering?: string): Promise<InkPayload> {
  const { notebook, pathParts, fileType, folder } = await assertInkFile(relativePath);
  for (const chunk of chunks ?? []) assertChunkFor(fileType, chunk);
  const author = await inkAuthor();
  const byChunk = await readInkFolder(folder, chunks ? new Set(chunks) : undefined);
  const names = chunks ?? [...byChunk.keys()].sort();
  const payload = {
    path: relativeFilePath(notebook, pathParts),
    author: author.key,
    chunks: names.map((chunk) => chunkPayload(chunk, byChunk.get(chunk) ?? [], author.key)),
  };
  if (rendering !== undefined && names.length === 1) {
    const target = renderingTarget(notebook, names[0], rendering);
    payload.chunks[0].renderingMissing = !(await pathExists(target.targetPath));
  }
  return payload;
}

// ---- Writing -----------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/**
 * On Windows, replacing a file fails with EPERM or EBUSY while another
 * handle has it open: a reader in another window, the search indexer or an
 * antivirus scan. Those holds are brief, so the publish is retried.
 */
export async function publishInkFile(target: string, value: unknown) {
  // Compact: an author file is uploaded whole by sync clients on every save.
  await publishText(target, `${JSON.stringify(value)}\n`);
}

/** Writes a whole file under a temporary name and renames it into place. */
async function publishText(target: string, text: string) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (attempt >= 7 || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 15 * 2 ** attempt));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** How long a save waits for the earlier save of the same record before it gives up (the earlier one may be stuck on a provider or the host). */
export const INK_LOCK_WAIT_MS = 30_000;

/**
 * Runs `work` after the earlier work on `key`. A save does not wait forever
 * behind one that is stuck: after `waitMs` it fails with a retryable 503 and
 * nothing was changed, and the lock still covers the stuck work, so a later
 * save never runs beside it.
 */
export function withInkLock<T>(key: string, work: () => Promise<T>, waitMs = INK_LOCK_WAIT_MS): Promise<T> {
  const previous = locks.get(key);
  const task = (async () => {
    if (previous) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), waitMs); timer.unref?.(); });
      const outcome = await Promise.race([previous.then(() => false, () => false), timedOut]);
      clearTimeout(timer);
      if (outcome) throw new StorageError("An earlier save of this ink is still in progress. Nothing was changed; try again in a moment.", 503);
    }
    return work();
  })();
  const tail = Promise.allSettled([previous ?? Promise.resolve(), task]).then(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return task;
}

function normalizeStrokes(value: unknown, label: string): InkStroke[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new StorageError(`Ink ${label} must be a list.`);
  return value.map((item) => {
    const stroke = normalizeInkStroke(item);
    if (!stroke) throw new StorageError("A stroke is malformed.");
    return stroke;
  });
}

export function normalizeInkOps(value: unknown): InkOps {
  if (typeof value !== "object" || value === null) throw new StorageError("Ink changes are missing.");
  const { add, erase, unerase } = value as Record<string, unknown>;
  if (erase !== undefined && (!Array.isArray(erase) || !erase.every((id) => typeof id === "string" && id.length <= 64))) throw new StorageError("Ink erase ids are invalid.");
  return { add: normalizeStrokes(add, "additions"), erase: (erase as string[] | undefined) ?? [], unerase: normalizeStrokes(unerase, "restorations") };
}

async function sourceIdentity(fileType: string, sourcePath: string): Promise<InkSource | undefined> {
  // A note's text changes all the time; only PDFs and images are found again by their bytes.
  if (fileType === "markdown") return undefined;
  const identity = await cachedPdfIdentity(sourcePath).catch(() => null);
  return identity ? { size: identity.size, sha256: identity.contentHash } : undefined;
}

export type WriteInkOptions = {
  /**
   * For a Markdown ink block: the image source of its rendering in the note
   * (`_assets/…/ink-<id>.svg`), rewritten from the merged strokes after the
   * change, and created when missing.
   */
  rendering?: string;
};

/**
 * Applies this author's changes to one chunk and returns the merged chunk.
 * `frame` describes the surface; it is recorded when the author first inks
 * the chunk, and a Markdown ink block's new height is recorded with it.
 */
export async function writeInk(relativePath: string, chunk: string, opsValue: unknown, frameValue: unknown, options: WriteInkOptions = {}): Promise<InkPayload> {
  // A file a notebook migration is moving is written after the migration.
  await assertNotMigrating(relativePath);
  const { notebook, pathParts, fileType, sourcePath, folder } = await assertInkFile(relativePath);
  assertChunkFor(fileType, chunk);
  const ops = normalizeInkOps(opsValue);
  const frame = normalizeInkFrame(frameValue);
  const rendering = options.rendering === undefined ? null : renderingTarget(notebook, chunk, options.rendering);
  const author = await inkAuthor();
  const fileName = inkFileName(chunk, author.key);
  const target = path.join(folder, fileName);
  const libraryPath = relativeFilePath(notebook, pathParts);
  const shared = isSharedNotebookPath(libraryPath);

  return withInkLock(target, async () => {
    // The rendering's version before anything is merged: if another device
    // publishes a newer one meanwhile, ours (merged from older strokes) must not replace it.
    const renderingAuthority = shared && rendering ? await (await import("@/lib/collab/shared-writes")).readSharedBlob(`${notebook}/${rendering.normalized}`).catch(() => null) : null;
    const files = (await readInkFolder(folder, new Set([chunk]))).get(chunk) ?? [];
    let others = files.filter((file) => file.author.key !== author.key);
    let own = files.find((file) => file.author.key === author.key);
    // A follower's disk file may lag every successful save. Merge against
    // the host's acknowledged blob and fence the replacement by its identity.
    const inkPath = inkLibraryPath(notebook, pathParts, fileName);
    let ownerFileId: string | undefined;
    const authority = shared ? await (await import("@/lib/collab/shared-writes")).readSharedBlob(inkPath) : null;
    if (authority) {
      own = authority.contentBase64 === null ? undefined : normalizeInkAuthorFile(JSON.parse(Buffer.from(authority.contentBase64, "base64").toString("utf8"))) ?? undefined;
      if (authority.contentBase64 !== null && (!own || own.author.key !== author.key)) throw new StorageError("The shared ink author file is invalid; it was kept unchanged.", 409);
    }
    if (shared) {
      // Other authors' files on a follower's disk may lag the host: merge their acknowledged strokes.
      const { listSharedEntries, readSharedBlob } = await import("@/lib/collab/shared-writes");
      const readAuthor = async (authorKey: string) => {
        const theirs = await readSharedBlob(inkLibraryPath(notebook, pathParts, inkFileName(chunk, authorKey))).catch(() => null);
        if (!theirs || theirs.contentBase64 === null) return null;
        try {
          const parsed = normalizeInkAuthorFile(JSON.parse(Buffer.from(theirs.contentBase64, "base64").toString("utf8")));
          return parsed && parsed.author.key === authorKey ? parsed : null;
        } catch { return null; }
      };
      others = await Promise.all(others.map(async (file) => (await readAuthor(file.author.key)) ?? file));
      // Authors whose files have not reached this disk yet: the manifest lists them under the drawing's ink folder.
      const known = new Set([author.key, ...others.map((file) => file.author.key)]);
      const listed = await listSharedEntries(notebook).catch(() => []);
      // The drawing's owner as the manifest has it now: the save is bound to this file (see writeSharedBlob).
      ownerFileId = listed.find((entry) => entry.kind !== "folder" && entry.path === libraryPath)?.fileId;
      const folderPrefix = `${inkLibraryPath(notebook, pathParts)}/`;
      const arrived: string[] = [];
      for (const entry of listed) {
        if (entry.kind !== "blob" || !entry.path.startsWith(folderPrefix)) continue;
        const parsed = parseInkFileName(entry.path.slice(folderPrefix.length));
        if (parsed && parsed.chunk === chunk && !known.has(parsed.author)) { known.add(parsed.author); arrived.push(parsed.author); }
      }
      others = [...others, ...(await Promise.all(arrived.map(readAuthor))).filter((file): file is InkAuthorFile => file !== null)];
    }
    if (own && !canWriteInkFile(own)) throw new StorageError("This ink was saved by a newer version of Libera. Update Libera to change it.", 409);
    if (!own) {
      const first = frame ?? others[0]?.frame;
      if (!first) throw new StorageError("Ink needs the surface's frame.");
      own = emptyInkAuthorFile(author, first);
    }

    let next = applyInkOps(own, ops, others);
    // Only a block's height changes after it is made; pages and photos keep their size.
    const resized = chunk.startsWith("block-") && frame && frame.width === next.frame.width && frame.height !== next.frame.height;
    if (resized) next = { ...next, frame: { ...next.frame, height: frame.height }, revision: next === own ? next.revision + 1 : next.revision };
    const changed = next !== own;
    let current = [...others, next];

    if (changed) {
      if (next.strokes.length > MAX_STROKES_PER_FILE) throw new StorageError("This page holds too much ink.", 413);
      const source = await sourceIdentity(fileType, sourcePath);
      const written: InkAuthorFile = source ? { ...next, source } : next;
      const bytes = Buffer.from(`${JSON.stringify(written)}
`, "utf8");
      if (bytes.byteLength > MAX_INK_FILE_BYTES) throw new StorageError("This page holds too much ink.", 413);

      if (shared) {
        // Shared notebooks are written through the host, which syncs the file.
        // Imported here: shared-writes reaches back into storage.
        const { writeSharedBlob } = await import("@/lib/collab/shared-writes");
        await writeSharedBlob(inkPath, new Uint8Array(bytes), {
          ...(authority?.fileId ? { expectedFileId: authority.fileId, expectedBlobHash: authority.blobHash } : { createOnly: true }),
          ...(ownerFileId ? { ownerFileId } : {}),
        });
      } else {
        await mkdir(folder, { recursive: true });
        await publishInkFile(target, written);
      }
      current = [...others, written];
    }

    const payload = chunkPayload(chunk, current, author.key);
    // Rendered on every save, so a save whose SVG failed earlier repairs it;
    // written only when it differs, since each write is a sync upload.
    if (rendering) {
      const svg = inkToSvg(payload.strokes.map((item) => item.stroke), payload.frame ?? own.frame, "Ink");
      const onDisk = await readFile(rendering.targetPath, "utf8").catch(() => null);
      if (onDisk !== svg) await publishRendering(notebook, rendering, svg, shared, renderingAuthority);
    }
    return { path: libraryPath, author: author.key, chunks: [payload] };
  });
}

function renderingTarget(notebook: string, chunk: string, source: unknown) {
  if (typeof source !== "string" || !chunk.startsWith("block-")) throw new StorageError("Only ink blocks have a rendering.");
  const asset = markdownAssetPath(notebook, source);
  if (parseInkBlockSource(asset.normalized) !== chunk.slice("block-".length)) throw new StorageError("The rendering does not belong to this ink block.");
  return asset;
}

async function publishRendering(notebook: string, rendering: { normalized: string; targetPath: string }, svg: string, shared: boolean, authority: { fileId?: string | null; blobHash?: string | null; contentBase64: string | null } | null = null) {
  if (shared) {
    const { writeSharedBlob, SharedWriteError } = await import("@/lib/collab/shared-writes");
    try {
      // Only replaces the rendering this save started from; a newer one stays, and the next save repairs it.
      await writeSharedBlob(`${notebook}/${rendering.normalized}`, new TextEncoder().encode(svg),
        authority?.contentBase64 !== null && authority?.fileId && authority.blobHash
          ? { expectedFileId: authority.fileId, expectedBlobHash: authority.blobHash }
          : authority ? { createOnly: true } : {});
    } catch (error) {
      if (!(error instanceof SharedWriteError && error.code === "conflict")) throw error;
    }
    return;
  }
  await publishText(rendering.targetPath, svg);
}

// ---- Following the file (local notebooks) -------------------------------------------

/** Moves a file's or folder's ink with it. The folder may not exist. */
export async function moveInkFolder(fromNotebook: string, fromParts: string[], toNotebook: string, toParts: string[]) {
  await moveFileIfExists(inkFolderPath(fromNotebook, fromParts), inkFolderPath(toNotebook, toParts));
}

/** A copy keeps every author's ink. */
export async function copyInkFolder(fromNotebook: string, fromParts: string[], toNotebook: string, toParts: string[]) {
  const from = inkFolderPath(fromNotebook, fromParts);
  const to = inkFolderPath(toNotebook, toParts);
  if (from === to || !(await pathExists(from))) return;
  await mkdir(path.dirname(to), { recursive: true });
  // Never over strokes already there: a copy's name is checked free, so a file here means a race, and it fails.
  await cp(from, to, { recursive: true, errorOnExist: true, force: false });
}

/** Deleting a file in Libera deletes its ink, as it does its other notes. */
export async function deleteInkFolder(notebook: string, pathParts: string[]) {
  await rm(inkFolderPath(notebook, pathParts), { recursive: true, force: true });
}

/**
 * Strokes in a photo's pixels mapped through photo edits (rotate, flip, crop):
 * what an edited copy keeps of the original's ink, or what flattening draws.
 * Widths do not change; quarter turns, flips and crops do not scale.
 */
export function mapInkThroughView(file: InkAuthorFile, view: PhotoInkView): InkAuthorFile {
  const original = { width: file.frame.width, height: file.frame.height };
  const size = photoViewSize(original, view);
  const strokes = file.strokes.map((stroke) => {
    const samples = strokeSamples(stroke).map((sample) => ({ ...sample, ...originalToView(sample, original, view) }));
    return { ...stroke, points: encodeInkSamples(samples), bounds: sampleBounds(samples) };
  });
  return { ...file, frame: { ...file.frame, width: size.width, height: size.height }, strokes };
}

/**
 * An edited copy of a notebook image takes the original's ink, every
 * author's, mapped through the edit. `targetPath` is the copy's library path.
 */
export async function copyInkThroughEdit(sourcePath: string, targetPath: string, edits: PhotoInkView) {
  const source = splitFilePath(sourcePath);
  const target = splitFilePath(targetPath);
  const files = (await readInkFolder(inkFolderPath(source.notebook, source.pathParts), new Set(["image"]))).get("image") ?? [];
  if (!files.length) return;
  const shared = isSharedNotebookPath(targetPath);
  const folder = inkFolderPath(target.notebook, target.pathParts);
  // The copy is a different file: ink finds it by its own bytes.
  const identity = await cachedPdfIdentity(filePathFromParts(target.notebook, target.pathParts)).catch(() => null);
  for (const file of files) {
    const mapped: InkAuthorFile = { ...mapInkThroughView(file, edits), ...(identity ? { source: { size: identity.size, sha256: identity.contentHash } } : {}) };
    const name = inkFileName("image", file.author.key);
    if (shared) {
      const { writeSharedBlob } = await import("@/lib/collab/shared-writes");
      await writeSharedBlob(inkLibraryPath(target.notebook, target.pathParts, name), new TextEncoder().encode(`${JSON.stringify(mapped)}
`));
    } else {
      await mkdir(folder, { recursive: true });
      await publishInkFile(path.join(folder, name), mapped);
    }
  }
}

// ---- Files renamed or deleted outside Libera ------------------------------------------

type InkOrphanRecord = { originalPath: string; orphanedAt: string; source: InkSource | null };

const missingSince = new Map<string, number>();

/**
 * Ink folders under `_ink`: folders that directly hold at least one ink file.
 * Listing only: an ink file is read (for its PDF's bytes) only once its
 * PDF is missing, since reading an online-only synced file downloads it.
 */
async function listInkFolders(notebook: string) {
  const found: Array<{ folder: string; libraryPath: string }> = [];
  async function visit(directory: string, parts: string[]) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    const holdsInk = entries.some((entry) => entry.isFile() && parseInkFileName(entry.name));
    if (holdsInk && parts.length) found.push({ folder: directory, libraryPath: relativeFilePath(notebook, parts) });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(path.join(directory, entry.name), [...parts, entry.name]);
    }
  }
  await visit(path.join(notebookPath(notebook), INK_DIR), []);
  return found;
}

/**
 * The PDF or image bytes an ink folder's files recorded: null when none
 * recorded any, "conflict" when its files name different bytes (pages drawn on
 * different versions of the file), which no one file can take as a whole.
 */
async function folderSource(folder: string): Promise<InkSource | null | "conflict"> {
  const names = await readdir(folder).catch(() => [] as string[]);
  let found: InkSource | null = null;
  for (const name of names) {
    if (!parseInkFileName(name)) continue;
    const source = (await readAuthorFile(path.join(folder, name)))?.source;
    if (!source) continue;
    if (found && (found.size !== source.size || found.sha256 !== source.sha256)) return "conflict";
    found ??= source;
  }
  return found;
}

/** Whether the file is there by the exact names its folders list (as the tree and the notebook check see it); null when unreadable (offline drive, permissions): not known to be gone. */
function fileExists(libraryPath: string, existence = fileExistence()): Promise<boolean | null> {
  return existence.isFile(libraryPath);
}

/**
 * Re-attaches or sets aside the ink of files renamed, moved or deleted
 * outside Libera, as `reconcilePdfSidecars` does for PDF side-cars. `files`
 * are the notebook's PDFs and images (library path and size). Shared
 * notebooks are skipped: the host moves their ink with their files.
 */
export async function reconcileInkFolders(notebook: string, files: Array<{ path: string; size: number }>, { now = Date.now() }: { now?: number } = {}) {
  if (sharedNotebookMarker(notebook)) return { reattached: 0, setAside: 0 };
  const folders = await listInkFolders(notebook);
  const orphanDirectory = orphanedSidecarsDirectoryPath(notebook, "ink");
  const storedNames = await readdir(orphanDirectory).catch(() => [] as string[]);
  if (!folders.length && !storedNames.length) return { reattached: 0, setAside: 0 };

  const missing: Array<(typeof folders)[number] & { source: InkSource | null | "conflict" }> = [];
  const existence = fileExistence();
  for (const found of folders) {
    if (await fileExists(found.libraryPath, existence) === false) missing.push({ ...found, source: await folderSource(found.folder) });
  }

  const hashes = new Map<string, Promise<string | null>>();
  // A slot is taken by the file system's own rules (case included), as it is for PDF side-cars and in the check.
  const slotTaken = slotTakenBy(inkFolderPath);
  const match = (source: InkSource) => matchByIdentity({ size: source.size, contentHash: source.sha256 }, files, slotTaken, hashes);

  let reattached = 0;
  let setAside = 0;
  for (const found of missing) {
    // Whole-folder reattachment needs one file for all pages: with several versions in it, nothing is moved or set aside.
    if (found.source === "conflict") continue;
    const target = found.source ? await match(found.source) : null;
    if (target) {
      const { notebook: owner, pathParts } = splitFilePath(target);
      // Exclusive: ink saved there since the check above is kept, and the folder stays until the move has published it.
      if (await moveToFreeSlot(found.folder, inkFolderPath(owner, pathParts))) {
        missingSince.delete(found.folder);
        reattached += 1;
        continue;
      }
    }
    const first = missingSince.get(found.folder) ?? now;
    missingSince.set(found.folder, first);
    if (now - first >= ORPHAN_GRACE_MS) {
      // The origin is recorded before the folder moves, so an interruption leaves a record to find, not ink with no past.
      const name = `${now}-${randomUUID().slice(0, 8)}`;
      const directory = path.join(orphanDirectory, name);
      const record: InkOrphanRecord = { originalPath: found.libraryPath, orphanedAt: new Date(now).toISOString(), source: found.source };
      await writeJsonAtomically(path.join(directory, "record.json"), record);
      if (await moveToFreeSlot(found.folder, path.join(directory, "ink"))) setAside += 1;
      // Nothing moved (the folder is gone): the record names nothing.
      else await rm(directory, { recursive: true, force: true });
      missingSince.delete(found.folder);
    }
  }

  for (const name of storedNames) {
    const directory = path.join(orphanDirectory, name);
    let record: InkOrphanRecord;
    try { record = JSON.parse(await readFile(path.join(directory, "record.json"), "utf8")) as InkOrphanRecord; } catch { continue; }
    if (typeof record.originalPath !== "string") continue;
    const age = now - Date.parse(record.orphanedAt);
    const kept = path.join(directory, "ink");
    // A record without its folder is a set-aside interrupted before the move (the folder is still where it was) or whose folder is gone: it holds no ink.
    if (!(await pathExists(kept))) {
      if (age > ORPHAN_GRACE_MS) await rm(directory, { recursive: true, force: true });
      continue;
    }
    // A folder whose pages name different versions of the file goes to none of them.
    if (await folderSource(kept) === "conflict") continue;
    let target: string | null = null;
    if (record.source) target = await match(record.source);
    // Without the bytes, only the file coming back under its old path is its own.
    else if (await fileExists(record.originalPath, existence) && !(await slotTaken(record.originalPath))) target = record.originalPath;
    if (target) {
      const { notebook: owner, pathParts } = splitFilePath(target);
      if (await moveToFreeSlot(kept, inkFolderPath(owner, pathParts))) {
        await rm(directory, { recursive: true, force: true });
        reattached += 1;
        continue;
      }
    }
    const source = record.source ? { size: record.source.size, contentHash: record.source.sha256 } : null;
    if (age > ORPHAN_RETENTION_MS && !(await mayBeBack({ originalPath: record.originalPath, source }, files, hashes, fileExists))) await rm(directory, { recursive: true, force: true });
  }

  return { reattached, setAside };
}

/** Library paths and sizes of the PDFs and images in a tree's nodes. */
export function inkSourceFilesOf(nodes: Array<{ kind: string; path: string; size?: number; fileType?: string; children?: unknown[] }>, into: Array<{ path: string; size: number }> = []) {
  for (const node of nodes) {
    if (node.kind === "file" && (node.fileType === "pdf" || node.fileType === "image") && typeof node.size === "number") into.push({ path: node.path, size: node.size });
    else if (Array.isArray(node.children)) inkSourceFilesOf(node.children as typeof nodes, into);
  }
  return into;
}

/** For tests: forget the cached author and missing-folder timers. */
export function resetInkStorageForTests() {
  authorTask = null;
  missingSince.clear();
}
