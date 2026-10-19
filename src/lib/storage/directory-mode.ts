import { mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import {
  baseFolderName,
  directoryMachineKey,
  ensureDirectoryIdentity,
  libraryNotebookNames,
  normalizeDirectoryPath,
  readDirectoryModeState,
  uniqueFolderName,
  withRecentDirectory,
  writeDirectoryModeState,
} from "../../../electron/directory-mode.cjs";
import { WORKSPACE_METADATA_FILE } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getFileType } from "@/lib/storage/file-types";
import { pathExists } from "@/lib/storage/fs-utils";
import { mergeReviewDocuments } from "@/lib/storage/markdown-reviews";
import {
  assertSafeSegment,
  ensureAdminRoot,
  getAdminRoot,
  getLinkedFolder,
  getLinkedFolders,
  type LinkedFolder,
} from "@/lib/storage/paths";
import {
  normalizeWorkspaceMetadata,
  readWorkspaceMetadata,
  writeWorkspaceMetadata,
} from "@/lib/storage/workspace-metadata";
import type { ReviewDocument } from "@/lib/markdown-review";
import { notifySearchChanges } from "@/lib/storage/search-updates";

export type DirectoryModeSummary = {
  folders: Array<{ name: string; path: string }>;
  recent: string[];
};

export function getDirectoryModeSummary(): DirectoryModeSummary {
  return {
    folders: getLinkedFolders().map(({ name, path: folderPath }) => ({ name, path: folderPath })),
    recent: readDirectoryModeState(getAdminRoot()).recent,
  };
}

function isInside(parentPath: string, targetPath: string) {
  const relative = path.relative(parentPath, targetPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertLinkableDirectory(input: unknown) {
  const directoryPath = normalizeDirectoryPath(input);

  if (!directoryPath || !path.isAbsolute(directoryPath)) {
    throw new StorageError("Choose a folder to open.");
  }

  if (path.parse(directoryPath).root === directoryPath) {
    throw new StorageError("Choose a folder inside a drive, not the drive itself.");
  }

  // Notebooks and Libera's own state already live in the library.
  if (isInside(normalizeDirectoryPath(getAdminRoot()), directoryPath)) {
    throw new StorageError("This folder is already part of your Libera library.");
  }

  try {
    if (!(await stat(directoryPath)).isDirectory()) throw new Error();
  } catch {
    throw new StorageError("Folder was not found.", 404);
  }

  return directoryPath;
}

function remapPrefix(value: string, from: string, to: string) {
  if (from === to) return value;
  return value === from || value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;
}

/**
 * Folders opened before folders joined the library kept their stars, tags and
 * review comments in their own state root. Fold them into the library once.
 */
export async function mergeLegacyFolderState(folder: LinkedFolder) {
  const legacyName = baseFolderName(folder.path);
  const remap = (value: string) => remapPrefix(value, legacyName, folder.name);
  const metadataPath = path.join(folder.stateRoot, WORKSPACE_METADATA_FILE);

  if (await pathExists(metadataPath)) {
    try {
      const legacy = normalizeWorkspaceMetadata(JSON.parse(await readFile(metadataPath, "utf8")));
      const current = await readWorkspaceMetadata();
      const fileTags = { ...current.fileTags };

      for (const [filePath, tags] of Object.entries(legacy.fileTags)) {
        const target = remap(filePath);
        fileTags[target] = [...new Set([...(fileTags[target] ?? []), ...tags])];
      }

      await writeWorkspaceMetadata({
        ...current,
        notebookPanelExpandedPaths: current.notebookPanelExpandedPaths === null
          ? null
          : [...new Set([...current.notebookPanelExpandedPaths, ...(legacy.notebookPanelExpandedPaths ?? []).map(remap)])],
        starredFilePaths: [...new Set([...current.starredFilePaths, ...legacy.starredFilePaths.map(remap)])],
        fileTags,
      });
    } catch {
      // Unreadable legacy state is left in place; the folder still links.
      return;
    }
    await rename(metadataPath, `${metadataPath}.merged`);
  }

  const reviewsPath = path.join(folder.stateRoot, ".libera", "markdown-reviews.json");

  if (await pathExists(reviewsPath)) {
    try {
      const legacy = JSON.parse(await readFile(reviewsPath, "utf8")) as { schemaVersion?: number; documents?: ReviewDocument[] };
      if (legacy.schemaVersion === 1 && Array.isArray(legacy.documents)) {
        await mergeReviewDocuments(legacy.documents.map((document) => ({ ...document, key: remap(document.key) })));
      }
    } catch {
      return;
    }
    await rename(reviewsPath, `${reviewsPath}.merged`);
  }
}

/** Link a folder into the library, or return the existing link for it. */
export async function openDirectory(input: unknown) {
  const directoryPath = await assertLinkableDirectory(input);
  await ensureAdminRoot();
  const adminRoot = getAdminRoot();
  const state = readDirectoryModeState(adminRoot);
  const id = ensureDirectoryIdentity(adminRoot, directoryPath);
  const existing = state.folders.find((folder) => folder.path === directoryPath || (id && folder.id === id));
  const name = existing?.name ?? uniqueFolderName(
    baseFolderName(directoryPath),
    [...libraryNotebookNames(adminRoot), ...state.folders.map((folder) => folder.name)],
  );

  writeDirectoryModeState(adminRoot, {
    ...state,
    folders: existing
      ? state.folders.map((folder) => folder === existing ? { ...folder, path: directoryPath, ...(id ? { id } : {}),
        locations: { ...folder.locations, [directoryMachineKey()]: directoryPath } } : folder)
      : [...state.folders, { name, path: directoryPath, ...(id ? { id } : {}), locations: { [directoryMachineKey()]: directoryPath } }],
    recent: withRecentDirectory(state.recent, directoryPath),
  });

  const folder = getLinkedFolder(name);
  if (folder) {
    await mkdir(folder.stateRoot, { recursive: true });
    await mergeLegacyFolderState(folder);
  }

  const changed = !existing || existing.path !== directoryPath;
  if (changed) notifySearchChanges();
  return { ...getDirectoryModeSummary(), name, changed };
}

/** Remove a folder from the library. Its files on disk are never touched. */
export function closeDirectory(name: unknown) {
  const safeName = assertSafeSegment(typeof name === "string" ? name : "", "Folder name");
  const adminRoot = getAdminRoot();
  const state = readDirectoryModeState(adminRoot);

  if (!state.folders.some((folder) => folder.name === safeName)) {
    throw new StorageError("That folder is not linked to Libera.", 404);
  }

  writeDirectoryModeState(adminRoot, {
    ...state,
    folders: state.folders.filter((folder) => folder.name !== safeName),
  });
  notifySearchChanges();
  return getDirectoryModeSummary();
}

/** Give a linked folder a different name in Libera. The folder on disk keeps its name. */
export function renameLinkedFolder(currentName: string, nextName: string) {
  const adminRoot = getAdminRoot();
  const state = readDirectoryModeState(adminRoot);
  const folder = state.folders.find((item) => item.name === currentName);

  if (!folder) {
    throw new StorageError("That folder is not linked to Libera.", 404);
  }

  if (currentName === nextName) return;

  const taken = [
    ...libraryNotebookNames(adminRoot),
    ...state.folders.filter((item) => item !== folder).map((item) => item.name),
  ].map((name) => name.toLowerCase());

  if (taken.includes(nextName.toLowerCase())) {
    throw new StorageError("A notebook or folder already uses this name.", 409);
  }

  if (nextName.startsWith(".")) {
    throw new StorageError("Folder name is reserved.");
  }

  writeDirectoryModeState(adminRoot, {
    ...state,
    folders: state.folders.map((item) => item === folder ? { ...item, name: nextName } : item),
  });
  notifySearchChanges();
}

export function clearRecentDirectories() {
  const state = readDirectoryModeState(getAdminRoot());
  writeDirectoryModeState(getAdminRoot(), { ...state, recent: [] });
  return getDirectoryModeSummary();
}

/**
 * Open a single file. Files inside a notebook or a linked folder open in
 * place; anything else links its parent folder first.
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

  // Prefer the deepest linked folder when links overlap.
  const containingFolder = getLinkedFolders()
    .filter((folder) => isInside(folder.path, filePath))
    .sort((left, right) => right.path.length - left.path.length)[0];

  if (containingFolder) {
    const parts = path.relative(containingFolder.path, filePath).split(path.sep);
    return { ...getDirectoryModeSummary(), changed: false, filePath: [containingFolder.name, ...parts].join("/") };
  }

  const adminRoot = getAdminRoot();
  if (isInside(adminRoot, filePath)) {
    const parts = path.relative(adminRoot, filePath).split(path.sep);
    // Library files must be inside a notebook folder.
    if (parts.length > 1) {
      return { ...getDirectoryModeSummary(), changed: false, filePath: parts.join("/") };
    }
    throw new StorageError("Move this file into a notebook to open it.");
  }

  const linked = await openDirectory(path.dirname(filePath));
  return {
    ...linked,
    filePath: `${linked.name}/${path.basename(filePath)}`,
  };
}
