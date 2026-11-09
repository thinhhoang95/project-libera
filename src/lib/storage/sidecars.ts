import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DEFINITIONS_FILE_TYPES } from "@/lib/definitions";
import { pythonSidecarPath } from "@/lib/python/sidecar";
import { INK_DIR } from "@/lib/storage/constants";
import { getFileType } from "@/lib/storage/file-types";
import { moveFileIfExists, pathExists } from "@/lib/storage/fs-utils";
import { inkFolderPath, supportsInk } from "@/lib/storage/ink";
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
};

const is = (...types: string[]) => (fileType: string) => types.includes(fileType);

function inkDirectory(notebook: string, folderParts: string[]) {
  if (folderParts.length) return inkFolderPath(notebook, folderParts);
  return path.join(notebookPath(notebook), INK_DIR);
}

export const SIDECAR_KINDS: readonly SidecarKind[] = [
  { id: "pdf-annotations", appliesTo: is("pdf"), filePath: pdfAnnotationsPath, directoryPath: pdfAnnotationsDirectoryPath, layout: "json" },
  { id: "pdf-outline", appliesTo: is("pdf"), filePath: pdfOutlinePath, directoryPath: pdfOutlinesDirectoryPath, layout: "json" },
  { id: "pdf-text", appliesTo: is("pdf"), filePath: pdfTextCachePath, directoryPath: pdfTextCacheDirectoryPath, layout: "json", cache: true },
  { id: "image-annotations", appliesTo: is("image"), filePath: imageAnnotationsPath, directoryPath: imageAnnotationsDirectoryPath, layout: "json" },
  { id: "transcript", appliesTo: is("audio"), filePath: transcriptPath, directoryPath: (notebook, parts) => audioSidecarDirectories(notebook, parts)[0], layout: "json" },
  { id: "audio-peaks", appliesTo: is("audio"), filePath: audioPeaksPath, directoryPath: (notebook, parts) => audioSidecarDirectories(notebook, parts)[1], layout: "json", cache: true },
  { id: "definitions", appliesTo: is(...DEFINITIONS_FILE_TYPES), filePath: definitionsPath, directoryPath: definitionsDirectoryPath, layout: "json" },
  { id: "ink", appliesTo: (fileType) => supportsInk(fileType), filePath: inkFolderPath, directoryPath: inkDirectory, layout: "folder" },
];

/** The path helpers in paths.ts that are per-file sidecars, for the guard test. */
export const SIDECAR_PATH_HELPERS = ["pdfAnnotationsPath", "pdfOutlinePath", "pdfTextCachePath", "imageAnnotationsPath", "transcriptPath", "audioPeaksPath", "definitionsPath"] as const;

async function moveKind(kind: SidecarKind, from: string, to: string) {
  if (!kind.cache) return moveFileIfExists(from, to);
  try { await moveFileIfExists(from, to); }
  catch { await rm(from, { force: true, recursive: true }).catch(() => undefined); }
}

/**
 * A file moved (or renamed) from one path to another: its sidecars follow when
 * it keeps its kind of file, and are removed when it becomes another kind.
 */
export async function moveFileSidecars(
  fromNotebook: string,
  fromParts: string[],
  toNotebook: string,
  toParts: string[],
  fromType: string,
  toType: string,
) {
  for (const kind of SIDECAR_KINDS) {
    if (!kind.appliesTo(fromType)) continue;
    const from = kind.filePath(fromNotebook, fromParts);
    if (toType === fromType) await moveKind(kind, from, kind.filePath(toNotebook, toParts));
    else await rm(from, { force: true, recursive: true }).catch(kind.cache ? () => undefined : (error) => { throw error; });
  }
  if (fromType === "markdown") {
    const from = `${fromNotebook}/${fromParts.join("/")}`;
    if (toType === "markdown") await movePythonSidecar(from, `${toNotebook}/${toParts.join("/")}`);
    else await deletePythonSidecar(from);
  }
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
    await moveKind(kind, kind.directoryPath(fromNotebook, fromParts), kind.directoryPath(toNotebook, toParts));
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

export type OrphanedSidecar = ExistingSidecar & { filePath: string };

async function entries(directory: string): Promise<Dirent[]> {
  try { return await readdir(directory, { withFileTypes: true }); } catch { return []; }
}

async function isFileOfType(notebook: string, parts: string[], kind: SidecarKind) {
  try {
    const type = getFileType(parts.at(-1) ?? "");
    if (!type || !kind.appliesTo(type)) return false;
    return (await stat(filePathFromParts(notebook, parts))).isFile();
  } catch { return false; }
}

function safeParts(parts: string[]) {
  try { for (const part of parts) assertSafeUserSegment(part, "Path segment"); return true; } catch { return false; }
}

/**
 * Sidecars in a notebook whose file is not there (or is no longer a file of
 * their kind). Libera keeps such sidecars on purpose in some cases (a file
 * moved outside the app can be re-attached), so this is a report, not a
 * cleanup. Migration uses it to prove that it left nothing behind.
 */
export async function findOrphanedSidecars(notebook: string): Promise<OrphanedSidecar[]> {
  const orphans: OrphanedSidecar[] = [];
  for (const kind of SIDECAR_KINDS) {
    const root = kind.directoryPath(notebook, []);
    const walk = async (directory: string, parts: string[]) => {
      const children = await entries(directory);
      if (kind.layout === "folder" && parts.length && children.some((child) => child.isFile())) {
        if (safeParts(parts) && !(await isFileOfType(notebook, parts, kind))) orphans.push({ kind: kind.id, path: directory, filePath: `${notebook}/${parts.join("/")}` });
        return;
      }
      for (const child of children) {
        const target = path.join(directory, child.name);
        if (child.isDirectory()) await walk(target, [...parts, child.name]);
        else if (kind.layout === "json" && child.isFile() && child.name.endsWith(".json")) {
          const fileParts = [...parts, child.name.slice(0, -".json".length)];
          if (safeParts(fileParts) && !(await isFileOfType(notebook, fileParts, kind))) orphans.push({ kind: kind.id, path: target, filePath: `${notebook}/${fileParts.join("/")}` });
        }
      }
    };
    await walk(root, []);
  }
  return orphans;
}
