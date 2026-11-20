import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DEFINITIONS_FILE_TYPES, parseDefinitionsFile } from "@/lib/definitions";
import { parseInkFileName } from "@/lib/ink/authors";
import { parsePdfOutlineFile } from "@/lib/pdf-outline";
import { inspectImageSidecar, inspectPdfSidecar } from "@/lib/storage/annotations";
import { inspectPdfTextCache } from "@/lib/storage/pdf-text-cache";
import { parseTranscript } from "@/lib/storage/transcripts";
import { inspectAudioPeaksCache } from "@/lib/transcription/peaks";
import { pythonSidecarPath } from "@/lib/python/sidecar";
import { INK_DIR } from "@/lib/storage/constants";
import { getFileType } from "@/lib/storage/file-types";
import { fileExistence } from "@/lib/storage/library-links";
import { StorageError } from "@/lib/storage/errors";
import { moveFileIfExists, moveWithoutReplacing, pathExists } from "@/lib/storage/fs-utils";
import { inkFolderPath, inspectInkFolder, supportsInk, type InkFolderInspection } from "@/lib/storage/ink";
import { deletePythonSidecar, movePythonSidecar } from "@/lib/storage/markdown-assets";
import {
  assertSafeUserSegment,
  audioPeaksPath,
  audioSidecarDirectories,
  definitionsDirectoryPath,
  definitionsPath,
  filePathFromParts,
  imageAnnotationsDirectoryPath,
  imageAnnotationsPath,
  notebookPath,
  pdfAnnotationsDirectoryPath,
  pdfAnnotationsPath,
  pdfOutlinePath,
  pdfOutlinesDirectoryPath,
  pdfTextCacheDirectoryPath,
  pdfTextCachePath,
  splitFilePath,
  transcriptPath,
} from "@/lib/storage/paths";

// Every sidecar Libera keeps for a file at a path derived from the file's own
// path. Moves (of a file, a folder, or a batch between notebooks) and
// deletions go through this one list, so a new kind of sidecar cannot be
// carried by one operation and forgotten by another. A guard test
// (scripts/editor/notebook-migration.test.ts) fails when paths.ts gains a
// per-file sidecar path that is not listed here.
//
// The Python code of a note is the one exception: it lives in the note's
// `_assets` folder, needs its legacy layout migrated first, and is handled by
// markdown-assets.ts. It is still moved and removed through the helpers below.

export type SidecarKind = {
  id: string;
  appliesTo: (fileType: string) => boolean;
  /** The sidecar of one file. */
  filePath: (notebook: string, pathParts: string[]) => string;
  /** Where the sidecars of everything inside a folder live (the kind's root for `[]`). */
  directoryPath: (notebook: string, folderParts: string[]) => string;
  /** `json`: one `<name>.json` per file. `folder`: one folder per file (ink). */
  layout: "json" | "folder";
  /** A derived cache: failing to move it never fails the operation, and it is dropped instead. */
  cache?: boolean;
  /** The owner's reading of a saved `json` side file, for the notebook check: null (or a throw) when it is not one the owner reads. */
  inspect?: (value: unknown) => SidecarInspection | null;
  /** The same for a `folder` side file. */
  inspectFolder?: (folder: string, fileType: string) => Promise<InkFolderInspection>;
};

/** What a side file's owner makes of its saved content (storage/integrity.ts reports it). */
export type SidecarInspection = {
  /** Records in the file the owner's reader leaves out: not shown, and lost when it is next saved whole. */
  dropped: number;
  /** What those records are, plural ("annotations"). */
  records: string;
  /**
   * The file it was made for, when it recorded that: its size tells cheaply
   * that it was made for another version, and its content hash (SHA-256)
   * finds the file again after a move outside the app.
   */
  source: { size: number; contentHash: string | null } | null;
};

/** An inspection from an owner's parser: records it leaves out are those in the file but not in its result. */
function parsed<T>(parse: (value: unknown) => T | null, records: string, list: (value: Record<string, unknown>) => unknown, kept: (file: T) => number, source: (file: T) => SidecarInspection["source"]) {
  return (value: unknown): SidecarInspection | null => {
    const file = parse(value);
    if (!file) return null;
    const stored = list(value as Record<string, unknown>);
    return { dropped: Math.max(0, (Array.isArray(stored) ? stored.length : 0) - kept(file)), records, source: source(file) };
  };
}

const is = (...types: string[]) => (fileType: string) => types.includes(fileType);

function inkDirectory(notebook: string, folderParts: string[]) {
  if (folderParts.length) return inkFolderPath(notebook, folderParts);
  return path.join(notebookPath(notebook), INK_DIR);
}

export const SIDECAR_KINDS: readonly SidecarKind[] = [
  { id: "pdf-annotations", appliesTo: is("pdf"), filePath: pdfAnnotationsPath, directoryPath: pdfAnnotationsDirectoryPath, layout: "json", inspect: inspectPdfSidecar },
  { id: "pdf-outline", appliesTo: is("pdf"), filePath: pdfOutlinePath, directoryPath: pdfOutlinesDirectoryPath, layout: "json",
    inspect: parsed(parsePdfOutlineFile, "outline entries", (value) => value.entries, (file) => file.entries.length, (file) => file.source) },
  { id: "pdf-text", appliesTo: is("pdf"), filePath: pdfTextCachePath, directoryPath: pdfTextCacheDirectoryPath, layout: "json", cache: true, inspect: inspectPdfTextCache },
  { id: "image-annotations", appliesTo: is("image"), filePath: imageAnnotationsPath, directoryPath: imageAnnotationsDirectoryPath, layout: "json", inspect: inspectImageSidecar },
  { id: "transcript", appliesTo: is("audio"), filePath: transcriptPath, directoryPath: (notebook, parts) => audioSidecarDirectories(notebook, parts)[0], layout: "json",
    inspect: parsed(parseTranscript, "transcript segments", (value) => value.segments, (file) => file.segments.length, (file) => file.audio.size ? { size: file.audio.size, contentHash: file.audio.contentHash ?? null } : null) },
  { id: "audio-peaks", appliesTo: is("audio"), filePath: audioPeaksPath, directoryPath: (notebook, parts) => audioSidecarDirectories(notebook, parts)[1], layout: "json", cache: true, inspect: inspectAudioPeaksCache },
  { id: "definitions", appliesTo: is(...DEFINITIONS_FILE_TYPES), filePath: definitionsPath, directoryPath: definitionsDirectoryPath, layout: "json",
    inspect: parsed(parseDefinitionsFile, "definitions", (value) => value.entries, (file) => file.entries.length, (file) => file.source) },
  { id: "ink", appliesTo: (fileType) => supportsInk(fileType), filePath: inkFolderPath, directoryPath: inkDirectory, layout: "folder", inspectFolder: inspectInkFolder },
];

/** The path helpers in paths.ts that are per-file sidecars, for the guard test. */
export const SIDECAR_PATH_HELPERS = ["pdfAnnotationsPath", "pdfOutlinePath", "pdfTextCachePath", "imageAnnotationsPath", "transcriptPath", "audioPeaksPath", "definitionsPath"] as const;

async function moveKind(kind: SidecarKind, from: string, to: string) {
  if (!kind.cache) return moveFileIfExists(from, to);
  try { await moveFileIfExists(from, to); }
  catch { await rm(from, { force: true, recursive: true }).catch(() => undefined); }
}

/**
 * The non-cache records of a file (by SIDECAR_KINDS id, "python" for a note's
 * code) that a change of its file type would leave without a home: records of
 * a kind the new type has no use for. Caches are not records; they are made again.
 */
export async function lostSidecarRecords(notebook: string, parts: string[], fromType: string, toType: string): Promise<string[]> {
  if (fromType === toType) return [];
  const caches = new Set(SIDECAR_KINDS.filter((kind) => kind.cache).map((kind) => kind.id));
  const keptKinds = new Set(SIDECAR_KINDS.filter((kind) => kind.appliesTo(toType)).map((kind) => kind.id));
  const lost: string[] = [];
  for (const sidecar of await existingSidecars(notebook, parts, fromType)) {
    if (caches.has(sidecar.kind) || keptKinds.has(sidecar.kind)) continue;
    // An ink folder with nothing in it holds no strokes.
    if (sidecar.kind === "ink" && !(await readdir(sidecar.path).catch(() => ["?"])).length) continue;
    lost.push(sidecar.kind);
  }
  return lost;
}

/**
 * A file moved (or renamed) from one path to another: its sidecars follow when
 * the new type of file still has them. Records the new type has no use for are
 * never deleted: the move is refused instead (lostSidecarRecords); only caches
 * are dropped.
 *
 * All or nothing: if a sidecar can't be moved, those already moved are put
 * back before the error is rethrown. On success the result puts them all back
 * (for a caller whose own later step failed).
 */
export async function moveFileSidecars(
  fromNotebook: string,
  fromParts: string[],
  toNotebook: string,
  toParts: string[],
  fromType: string,
  toType: string,
): Promise<() => Promise<void>> {
  const lost = await lostSidecarRecords(fromNotebook, fromParts, fromType, toType);
  if (lost.length) throw new StorageError(`${fromNotebook}/${fromParts.join("/")} still has records (${lost.join(", ")}) that a ${toType} file cannot keep.`, 409);
  const moved: { from: string; to: string }[] = [];
  let python: { from: string; to: string } | null = null;
  const undo = async () => {
    const stuck: string[] = [];
    if (python) {
      const { from, to } = python;
      try { await movePythonSidecar(to, from); } catch { stuck.push(`its Python code is now at ${to}`); }
    }
    for (const entry of [...moved].reverse()) {
      try { await moveFileIfExists(entry.to, entry.from); } catch { stuck.push(`${entry.from} is now at ${entry.to}`); }
    }
    if (stuck.length) throw new StorageError(`Could not put the records of ${fromNotebook}/${fromParts.join("/")} back: ${stuck.join("; ")}.`, 500);
  };
  try {
    for (const kind of SIDECAR_KINDS) {
      if (!kind.appliesTo(fromType)) continue;
      const from = kind.filePath(fromNotebook, fromParts);
      if (kind.appliesTo(toType)) {
        const to = kind.filePath(toNotebook, toParts);
        const present = from !== to && await pathExists(from);
        await moveKind(kind, from, to);
        if (present && (!kind.cache || await pathExists(to))) moved.push({ from, to });
      } else {
        // Only a cache can be left here: the rest was refused above.
        await rm(from, { force: true, recursive: true }).catch(kind.cache ? () => undefined : (error) => { throw error; });
      }
    }
    if (fromType === "markdown") {
      const from = `${fromNotebook}/${fromParts.join("/")}`;
      if (toType === "markdown") {
        const to = `${toNotebook}/${toParts.join("/")}`;
        await movePythonSidecar(from, to);
        python = { from, to };
      } else await deletePythonSidecar(from);
    }
  } catch (error) {
    await undo();
    throw error;
  }
  return undo;
}

/** A file was deleted: remove the sidecars of its kind. */
export async function removeFileSidecars(notebook: string, pathParts: string[], fileType: string) {
  for (const kind of SIDECAR_KINDS) {
    if (!kind.appliesTo(fileType)) continue;
    await rm(kind.filePath(notebook, pathParts), { force: true, recursive: true }).catch(kind.cache ? () => undefined : (error) => { throw error; });
  }
  if (fileType === "markdown") await deletePythonSidecar(`${notebook}/${pathParts.join("/")}`);
}

/**
 * A folder moved inside its notebook (rename, archive): the sidecar folders of
 * everything inside follow. Python sidecars are per note (markdown-assets.ts)
 * and stay with the caller.
 */
export async function moveFolderSidecars(fromNotebook: string, fromParts: string[], toNotebook: string, toParts: string[]) {
  for (const kind of SIDECAR_KINDS) {
    const from = kind.directoryPath(fromNotebook, fromParts);
    const to = kind.directoryPath(toNotebook, toParts);
    // A cache is made again and may replace one; anything else never replaces what is there.
    if (kind.cache) await moveKind(kind, from, to);
    else await moveWithoutReplacing(from, to);
  }
}

/** A folder was deleted: remove the sidecar folders of everything inside. */
export async function removeFolderSidecars(notebook: string, folderParts: string[]) {
  for (const kind of SIDECAR_KINDS) {
    await rm(kind.directoryPath(notebook, folderParts), { force: true, recursive: true }).catch(kind.cache ? () => undefined : (error) => { throw error; });
  }
}

export type ExistingSidecar = { kind: string; path: string };

/** The sidecars on disk for a file path, whether or not the file itself exists. */
export async function existingSidecars(notebook: string, pathParts: string[], fileType: string | null = getFileType(pathParts.at(-1) ?? "")): Promise<ExistingSidecar[]> {
  const found: ExistingSidecar[] = [];
  if (!fileType) return found;
  for (const kind of SIDECAR_KINDS) {
    if (!kind.appliesTo(fileType)) continue;
    const target = kind.filePath(notebook, pathParts);
    if (await pathExists(target)) found.push({ kind: kind.id, path: target });
  }
  if (fileType === "markdown") {
    const python = splitFilePath(pythonSidecarPath(`${notebook}/${pathParts.join("/")}`));
    const target = filePathFromParts(python.notebook, python.pathParts);
    if (await pathExists(target)) found.push({ kind: "python", path: target });
  }
  return found;
}

export type ListedSidecar = ExistingSidecar & { kindInfo: SidecarKind; filePath: string; fileParts: string[] };
export type OrphanedSidecar = ExistingSidecar & { filePath: string };

/** A folder's entries; a folder that is there but can't be read is reported to `unreadable`. */
async function entries(directory: string, unreadable?: string[]): Promise<Dirent[]> {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) unreadable?.push(directory);
    return [];
  }
}

/**
 * Every per-file sidecar on disk in a notebook (SIDECAR_KINDS), with the
 * file path it belongs to. Read only; the orphan report and the notebook
 * check (storage/integrity.ts) build on it.
 */
export async function listSidecars(notebook: string): Promise<{ sidecars: ListedSidecar[]; unreadable: string[] }> {
  const listed: ListedSidecar[] = [];
  const unreadable: string[] = [];
  for (const kind of SIDECAR_KINDS) {
    const root = kind.directoryPath(notebook, []);
    const walk = async (directory: string, parts: string[]) => {
      const children = await entries(directory, unreadable);
      // A file's ink folder holds ink files the reader accepts (as listInkFolders
      // does). Stray files (a sync conflict copy, system files) don't make a
      // folder one, and a folder of other files may hold the ink folders of the
      // files inside it, so subfolders are walked either way.
      if (kind.layout === "folder" && parts.length && children.some((child) => child.isFile() && parseInkFileName(child.name))) {
        listed.push({ kind: kind.id, kindInfo: kind, path: directory, filePath: `${notebook}/${parts.join("/")}`, fileParts: parts });
      }
      for (const child of children) {
        const target = path.join(directory, child.name);
        if (child.isDirectory()) await walk(target, [...parts, child.name]);
        else if (kind.layout === "json" && child.isFile() && child.name.endsWith(".json")) {
          const fileParts = [...parts, child.name.slice(0, -".json".length)];
          listed.push({ kind: kind.id, kindInfo: kind, path: target, filePath: `${notebook}/${fileParts.join("/")}`, fileParts });
        }
      }
    };
    await walk(root, []);
  }
  return { sidecars: listed, unreadable };
}

/**
 * Whether the file is there by the exact names its folders list, each folder
 * on the way included, as the app's tree and every record keyed by path see
 * it: on a case-insensitive disk (macOS, Windows) `stat` also says yes to
 * `Paper.pdf` when the file, or a folder above it, was renamed to `paper.pdf`
 * outside the app, and its side files would never be found. Null when it can't be told (no permission, a drive offline): such a
 * file is not taken for gone.
 */
async function isFileOfType(notebook: string, parts: string[], kind: SidecarKind, existence: ReturnType<typeof fileExistence>): Promise<boolean | null> {
  const type = getFileType(parts.at(-1) ?? "");
  if (!type || !kind.appliesTo(type)) return false;
  return existence.isFile([notebook, ...parts].join("/"));
}

function safeParts(parts: string[]) {
  try { for (const part of parts) assertSafeUserSegment(part, "Path segment"); return true; } catch { return false; }
}

/**
 * Sidecars in a notebook whose file is not there (or is no longer a file of
 * their kind). Libera keeps such sidecars on purpose in some cases (a file
 * moved outside the app can be re-attached), so this is a report, not a
 * cleanup. Python code left by deleted notes is in `_assets`: see
 * unreferencedMarkdownAssets.
 */
export async function findOrphanedSidecars(notebook: string, listed?: ListedSidecar[]): Promise<OrphanedSidecar[]> {
  const orphans: OrphanedSidecar[] = [];
  const existence = fileExistence();
  for (const sidecar of listed ?? (await listSidecars(notebook)).sidecars) {
    if (safeParts(sidecar.fileParts) && (await isFileOfType(notebook, sidecar.fileParts, sidecar.kindInfo, existence)) === false) {
      orphans.push({ kind: sidecar.kind, path: sidecar.path, filePath: sidecar.filePath });
    }
  }
  return orphans;
}
