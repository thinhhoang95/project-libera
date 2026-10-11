import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  normalizeDirectoryPath,
  readDirectoryModeState,
  withRecentDirectory,
  writeDirectoryModeState,
} from "../../../electron/directory-mode.cjs";
import { StorageError } from "@/lib/storage/errors";
import { getFileType } from "@/lib/storage/file-types";
import {
  ensureAdminRoot,
  getAdminRoot,
  getMountedDirectory,
  mountedDirectoryName,
} from "@/lib/storage/paths";

export type DirectoryModeSummary = {
  current: { name: string; path: string } | null;
  recent: string[];
};

export function getDirectoryModeSummary(): DirectoryModeSummary {
  const mounted = getMountedDirectory();
  return {
    current: mounted ? { name: mounted.name, path: mounted.path } : null,
    recent: readDirectoryModeState(getAdminRoot()).recent,
  };
}

function isInside(parentPath: string, targetPath: string) {
  const relative = path.relative(parentPath, targetPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertOpenableDirectory(input: unknown) {
  const directoryPath = normalizeDirectoryPath(input);

  if (!directoryPath || !path.isAbsolute(directoryPath)) {
    throw new StorageError("Choose a folder to open.");
  }

  if (path.parse(directoryPath).root === directoryPath) {
    throw new StorageError("Choose a folder inside a drive, not the drive itself.");
  }

  // The library root holds app state next to notebooks; open notebooks in Notebook mode.
  if (directoryPath === normalizeDirectoryPath(getAdminRoot())) {
    throw new StorageError("This is the Libera library. Close the folder to return to your notebooks.");
  }

  try {
    if (!(await stat(directoryPath)).isDirectory()) throw new Error();
  } catch {
    throw new StorageError("Folder was not found.", 404);
  }

  return directoryPath;
}

export async function openDirectory(input: unknown) {
  const directoryPath = await assertOpenableDirectory(input);
  await ensureAdminRoot();
  const state = readDirectoryModeState(getAdminRoot());
  writeDirectoryModeState(getAdminRoot(), {
    version: 1,
    current: directoryPath,
    recent: withRecentDirectory(state.recent, directoryPath),
  });
  const mounted = getMountedDirectory();
  if (mounted) await mkdir(mounted.stateRoot, { recursive: true });
  return getDirectoryModeSummary();
}

export function closeDirectory() {
  const state = readDirectoryModeState(getAdminRoot());
  if (state.current) writeDirectoryModeState(getAdminRoot(), { ...state, current: null });
  return getDirectoryModeSummary();
}

export function clearRecentDirectories() {
  const state = readDirectoryModeState(getAdminRoot());
  writeDirectoryModeState(getAdminRoot(), { ...state, recent: state.current ? [state.current] : [] });
  return getDirectoryModeSummary();
}

/**
 * Open a single file. Files already inside the open folder (or the library in
 * Notebook mode) open in place; anything else opens its parent folder.
 */
export async function openFileLocation(input: unknown) {
  const filePath = normalizeDirectoryPath(input);

  if (!filePath || !path.isAbsolute(filePath)) {
    throw new StorageError("Choose a file to open.");
  }

  if (!getFileType(filePath)) {
    throw new StorageError("Libera cannot open this file type.");
  }

  try {
    if (!(await stat(filePath)).isFile()) throw new Error();
  } catch {
    throw new StorageError("File was not found.", 404);
  }

  const mounted = getMountedDirectory();
  const contextRoot = mounted?.path ?? getAdminRoot();
  const contextName = mounted?.name;

  if (isInside(contextRoot, filePath)) {
    const parts = path.relative(contextRoot, filePath).split(path.sep);
    const relativePath = contextName ? [contextName, ...parts].join("/") : parts.join("/");
    // Library files must be inside a notebook folder.
    if (contextName || parts.length > 1) {
      return { ...getDirectoryModeSummary(), changed: false, filePath: relativePath };
    }
  }

  const directoryPath = path.dirname(filePath);
  const summary = await openDirectory(directoryPath);
  return {
    ...summary,
    changed: true,
    filePath: `${mountedDirectoryName(directoryPath)}/${path.basename(filePath)}`,
  };
}
