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
import { cachedPdfIdentity } from "@/lib/storage/pdf-identity";
import { ORPHAN_GRACE_MS, ORPHAN_RETENTION_MS } from "@/lib/storage/pdf-sidecars";
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
function assertChunkFor(fileType: string, chunk: string) {
  if (!isInkChunkName(chunk)) throw new StorageError("Ink chunk is invalid.");
  const valid = fileType === "pdf"
    ? pageNumberOfChunk(chunk) !== null
    : fileType === "markdown"
      ? chunk === "text" || chunk.startsWith("block-")
      : fileType === "image" && chunk === "image";
  if (!valid) throw new StorageError("That ink chunk does not belong to this kind of file.");
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

export function withInkLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const task = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  locks.set(key, task);
  void task.finally(() => { if (locks.get(key) === task) locks.delete(key); }).catch(() => undefined);
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
    const files = (await readInkFolder(folder, new Set([chunk]))).get(chunk) ?? [];
    const others = files.filter((file) => file.author.key !== author.key);
    let own = files.find((file) => file.author.key === author.key);
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
    let current = changed ? [...others, next] : files;

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
        await writeSharedBlob(inkLibraryPath(notebook, pathParts, fileName), new Uint8Array(bytes));
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
      if (onDisk !== svg) await publishRendering(notebook, rendering, svg, shared);
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

async function publishRendering(notebook: string, rendering: { normalized: string; targetPath: string }, svg: string, shared: boolean) {
  if (shared) {
    const { writeSharedBlob } = await import("@/lib/collab/shared-writes");
    await writeSharedBlob(`${notebook}/${rendering.normalized}`, new TextEncoder().encode(svg));
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
  await rm(to, { recursive: true, force: true });
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, errorOnExist: false, force: true });
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

/** The PDF or image bytes an ink folder's files recorded, from the first that has them. */
async function folderSource(folder: string): Promise<InkSource | null> {
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const name of names) {
    if (!parseInkFileName(name)) continue;
    const source = (await readAuthorFile(path.join(folder, name)))?.source;
    if (source) return source;
  }
  return null;
}

async function fileExists(libraryPath: string): Promise<boolean | null> {
  try {
    const { notebook, pathParts } = splitFilePath(libraryPath);
    return (await stat(filePathFromParts(notebook, pathParts))).isFile();
  } catch (error) {
    // Unreadable (offline drive, permissions): not known to be gone.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
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

  const taken = new Set<string>();
  const missing: Array<(typeof folders)[number] & { source: InkSource | null }> = [];
  for (const found of folders) {
    const exists = await fileExists(found.libraryPath);
    if (exists === false) missing.push({ ...found, source: await folderSource(found.folder) });
    else taken.add(found.libraryPath.toLowerCase());
  }

  const hashes = new Map<string, Promise<string | null>>();
  async function match(source: InkSource) {
    const matches: string[] = [];
    for (const candidate of files) {
      if (candidate.size !== source.size || taken.has(candidate.path.toLowerCase())) continue;
      if (!hashes.has(candidate.path)) {
        const { notebook: owner, pathParts } = splitFilePath(candidate.path);
        hashes.set(candidate.path, cachedPdfIdentity(filePathFromParts(owner, pathParts)).then((identity) => identity.contentHash, () => null));
      }
      if (await hashes.get(candidate.path) === source.sha256) matches.push(candidate.path);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  let reattached = 0;
  let setAside = 0;
  for (const found of missing) {
    const target = found.source ? await match(found.source) : null;
    if (target) {
      const { notebook: owner, pathParts } = splitFilePath(target);
      const destination = inkFolderPath(owner, pathParts);
      if (!(await pathExists(destination))) {
        await moveFileIfExists(found.folder, destination);
        taken.add(target.toLowerCase());
        missingSince.delete(found.folder);
        reattached += 1;
        continue;
      }
    }
    const first = missingSince.get(found.folder) ?? now;
    missingSince.set(found.folder, first);
    if (now - first >= ORPHAN_GRACE_MS) {
      const name = `${now}-${randomUUID().slice(0, 8)}`;
      await moveFileIfExists(found.folder, path.join(orphanDirectory, name, "ink"));
      const record: InkOrphanRecord = { originalPath: found.libraryPath, orphanedAt: new Date(now).toISOString(), source: found.source };
      await writeJsonAtomically(path.join(orphanDirectory, name, "record.json"), record);
      missingSince.delete(found.folder);
      setAside += 1;
    }
  }

  for (const name of storedNames) {
    const directory = path.join(orphanDirectory, name);
    let record: InkOrphanRecord;
    try { record = JSON.parse(await readFile(path.join(directory, "record.json"), "utf8")) as InkOrphanRecord; } catch { continue; }
    if (typeof record.originalPath !== "string") continue;
    let target: string | null = null;
    if (record.source) target = await match(record.source);
    // Without the bytes, only the file coming back under its old path is its own.
    else if (await fileExists(record.originalPath) && !taken.has(record.originalPath.toLowerCase())) target = record.originalPath;
    if (target) {
      const { notebook: owner, pathParts } = splitFilePath(target);
      const destination = inkFolderPath(owner, pathParts);
      if (!(await pathExists(destination))) {
        await moveFileIfExists(path.join(directory, "ink"), destination);
        await rm(directory, { recursive: true, force: true });
        taken.add(target.toLowerCase());
        reattached += 1;
        continue;
      }
    }
    if (now - Date.parse(record.orphanedAt) > ORPHAN_RETENTION_MS) await rm(directory, { recursive: true, force: true });
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
