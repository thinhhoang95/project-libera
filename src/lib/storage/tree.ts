import { prunePdfTextCaches } from "@/lib/storage/pdf-text-cache";
import { pruneAudioSidecars } from "@/lib/storage/transcripts";
import { populateRelatedNotebooks } from "@/lib/storage/notebook-links";
import { scheduleReferenceReattach } from "@/lib/storage/references";
import { readLastNotebookName } from "@/lib/storage/last-notebook";
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { ARCHIVE_DIR, MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { assertSupportedFileName, getFileType } from "@/lib/storage/file-types";
import { pathExists } from "@/lib/storage/fs-utils";
import { readNotebookMetadata } from "@/lib/storage/notebook-metadata";
import { readWorkspaceMetadata } from "@/lib/storage/workspace-metadata";
import { mergeLegacyFolderState } from "@/lib/storage/directory-mode";
import {
  ensureAdminRoot,
  filePathFromParts,
  getAdminRoot,
  getLinkedFolders,
  imageAnnotationsPath,
  itemPath,
  legacyImageAnnotationsPath,
  legacyPdfAnnotationsPath,
  legacyFlatPdfAnnotationsPath,
  notebookPath,
  pdfAnnotationsPath,
  relativeFilePath,
  relativeItemPath,
  type LinkedFolder,
} from "@/lib/storage/paths";
import type {
  LiberaFileNode,
  LiberaNotebookViewOptions,
  LiberaNotebookNode,
  LiberaTree,
  LiberaTreeNode,
} from "@/lib/types";

type TreeReadOptions = {
  showArchive?: boolean;
  /** Set for a linked folder, which may be a large project rather than a notebook. */
  budget?: { remaining: number; truncated: boolean };
};

// Dependency and build folders hold no notes and can be enormous.
const SKIPPED_LINKED_FOLDER_ENTRIES = new Set(["node_modules", "__pycache__", "bower_components"]);
const LINKED_FOLDER_ENTRY_LIMIT = 20_000;
export const LINKED_FOLDER_METADATA_DEFAULTS = { emoji: "📁", color: "#475569" };

function shouldSkipTreeEntry(name: string, options?: TreeReadOptions) {
  return !isVisibleTreeEntry(name, Boolean(options?.budget)) ||
    (name === ARCHIVE_DIR && !options?.showArchive);
}

/** Shared by the UI tree and the uncapped Search metadata walk. */
export function isVisibleTreeEntry(name: string, linked = false) {
  return !(
    name.startsWith(".") ||
    name.startsWith("._") ||
    name === "__MACOSX" ||
    name === MARKDOWN_ASSETS_DIR ||
    (linked && SKIPPED_LINKED_FOLDER_ENTRIES.has(name))
  );
}

/** Targeted search updates use the same exclusions as a full library walk. */
export function isVisibleTreeFile(notebook: string, pathParts: string[]) {
  const linked = getLinkedFolders().some((folder) => folder.name === notebook);
  return !notebook.startsWith(".") && pathParts.every((name) =>
    isVisibleTreeEntry(name, linked));
}

function sortTreeNodes(left: LiberaTreeNode, right: LiberaTreeNode) {
  if (left.kind !== right.kind) {
    return left.kind === "folder" ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

function latestIsoDate(...dates: string[]) {
  return new Date(
    Math.max(...dates.map((date) => new Date(date).getTime()).filter(Number.isFinite)),
  ).toISOString();
}

async function latestExistingPathMtime(paths: string[]) {
  const mtimes: string[] = [];

  for (const targetPath of paths) {
    if (await pathExists(targetPath)) {
      mtimes.push((await stat(targetPath)).mtime.toISOString());
    }
  }

  return mtimes;
}

async function getFileUpdatedAt(
  notebook: string,
  pathParts: string[],
  fileType: LiberaFileNode["fileType"],
  fileUpdatedAt: string,
) {
  const name = pathParts.at(-1)!;
  if (fileType === "pdf") {
    return latestIsoDate(
      fileUpdatedAt,
      ...(await latestExistingPathMtime([
        pdfAnnotationsPath(notebook, pathParts),
        legacyFlatPdfAnnotationsPath(notebook, name),
        legacyPdfAnnotationsPath(notebook, name),
      ])),
    );
  }

  if (fileType === "image") {
    return latestIsoDate(
      fileUpdatedAt,
      ...(await latestExistingPathMtime([
        imageAnnotationsPath(notebook, pathParts),
        legacyImageAnnotationsPath(notebook, name),
      ])),
    );
  }

  return fileUpdatedAt;
}

function latestTreeNodeUpdatedAt(nodes: LiberaTreeNode[]) {
  return nodes.map((node) => node.updatedAt);
}

function collectFilePaths(nodes: LiberaTreeNode[], filePaths: Set<string>) {
  for (const node of nodes) {
    if (node.kind === "file") {
      filePaths.add(node.path);
      continue;
    }

    collectFilePaths(node.children, filePaths);
  }
}

function collectExpandablePaths(nodes: LiberaTreeNode[], paths: Set<string>) {
  for (const node of nodes) {
    if (node.kind !== "folder") {
      continue;
    }

    paths.add(node.path);
    collectExpandablePaths(node.children, paths);
  }
}

function normalizeTreeViewOptions({
  notebookNames,
  validGroupIds,
  viewOptions,
}: {
  notebookNames: Set<string>;
  validGroupIds: Set<string>;
  viewOptions: LiberaNotebookViewOptions;
}): LiberaNotebookViewOptions {
  return {
    hiddenGroupIds: viewOptions.hiddenGroupIds.filter((groupId) =>
      validGroupIds.has(groupId),
    ),
    hiddenNotebookNames: viewOptions.hiddenNotebookNames.filter((notebookName) =>
      notebookNames.has(notebookName),
    ),
    showArchive: viewOptions.showArchive,
  };
}

export async function getFileNode(
  notebook: string,
  pathParts: string[] | string,
): Promise<LiberaFileNode> {
  const normalizedPathParts = Array.isArray(pathParts) ? pathParts : [pathParts];
  const name = normalizedPathParts.at(-1) ?? "";
  const targetPath = filePathFromParts(notebook, normalizedPathParts);
  const stats = await stat(targetPath);
  const fileType = assertSupportedFileName(name);

  if (!stats.isFile()) {
    throw new StorageError("Path is not a file.");
  }

  return {
    kind: "file",
    name,
    path: relativeFilePath(notebook, normalizedPathParts),
    notebook,
    fileType,
    createdAt: stats.birthtime.toISOString(),
    changedAt: stats.ctime.toISOString(),
    size: stats.size,
    updatedAt: await getFileUpdatedAt(
      notebook,
      normalizedPathParts,
      fileType,
      stats.mtime.toISOString(),
    ),
  };
}

async function readTreeDirectory(
  notebook: string,
  parentParts: string[],
  options: TreeReadOptions = {},
): Promise<LiberaTreeNode[]> {
  const directoryPath = itemPath(notebook, parentParts);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const children: LiberaTreeNode[] = [];

  for (const entry of entries) {
    if (shouldSkipTreeEntry(entry.name, options)) {
      continue;
    }

    if (options.budget) {
      if (options.budget.remaining <= 0) {
        options.budget.truncated = true;
        break;
      }

      options.budget.remaining -= 1;
    }

    const childParts = [...parentParts, entry.name];

    if (entry.isDirectory()) {
      const stats = await stat(itemPath(notebook, childParts));
      const grandChildren = await readTreeDirectory(notebook, childParts, options);
      children.push({
        kind: "folder",
        name: entry.name,
        path: relativeItemPath(notebook, childParts),
        notebook,
        createdAt: stats.birthtime.toISOString(),
        updatedAt: latestIsoDate(
          stats.mtime.toISOString(),
          ...latestTreeNodeUpdatedAt(grandChildren),
        ),
        children: grandChildren,
      });
      continue;
    }

    if (entry.isFile() && getFileType(entry.name)) {
      children.push(await getFileNode(notebook, childParts));
    }
  }

  return children.sort(sortTreeNodes);
}

async function getLinkedFolderNode(
  folder: LinkedFolder,
  options: { showArchive: boolean; validGroupIds: Set<string> },
): Promise<LiberaNotebookNode> {
  let folderStats: Stats | null = null;

  try {
    folderStats = folder.unresolved ? null : await stat(folder.path);
    if (!folderStats?.isDirectory()) folderStats = null;
  } catch {
    // A moved folder or an unplugged drive stays linked and shows as missing.
  }

  const fallbackDate = (folderStats?.birthtime ?? new Date(0)).toISOString();
  const metadata = await readNotebookMetadata(folder.name, fallbackDate, LINKED_FOLDER_METADATA_DEFAULTS);
  const budget = { remaining: LINKED_FOLDER_ENTRY_LIMIT, truncated: false };
  const children = folderStats
    ? await readTreeDirectory(folder.name, [], { showArchive: options.showArchive, budget })
    : [];

  return {
    kind: "notebook",
    name: folder.name,
    path: folder.name,
    folder: { path: folder.path, truncated: budget.truncated, ...(folderStats ? {} : { missing: true }) },
    createdAt: metadata.createdAt,
    color: metadata.color,
    emoji: metadata.emoji,
    illustration: metadata.illustration,
    groupId:
      metadata.groupId && options.validGroupIds.has(metadata.groupId)
        ? metadata.groupId
        : null,
    updatedAt: latestIsoDate(
      folderStats?.mtime.toISOString() ?? fallbackDate,
      ...latestTreeNodeUpdatedAt(children),
    ),
    children,
  };
}

export async function getTree(options: { includeArchive?: boolean } = {}): Promise<LiberaTree> {
  await ensureAdminRoot();

  const linkedFolders = getLinkedFolders();
  // Folders carried over from the single-folder mode bring their stars and tags.
  for (const folder of linkedFolders) await mergeLegacyFolderState(folder);

  const workspaceMetadata = await readWorkspaceMetadata();
  const validGroupIds = new Set(
    workspaceMetadata.notebookGroups.map((group) => group.id),
  );
  const entries = await readdir(getAdminRoot(), { withFileTypes: true });
  const linkedFolderNames = new Set(linkedFolders.map((folder) => folder.name));
  const showArchive = Boolean(options.includeArchive || workspaceMetadata.notebookViewOptions.showArchive);
  const notebooks: LiberaNotebookNode[] = [];
  const filePaths = new Set<string>();
  const expandablePaths = new Set<string>();

  for (const entry of entries) {
    // A linked folder's name wins over a notebook created on disk behind Libera's back.
    if (!entry.isDirectory() || entry.name.startsWith(".") || linkedFolderNames.has(entry.name)) {
      continue;
    }

    const currentNotebookPath = notebookPath(entry.name);
    const notebookStats = await stat(currentNotebookPath);
    const metadata = await readNotebookMetadata(
      entry.name,
      notebookStats.birthtime.toISOString(),
    );
    const children = await readTreeDirectory(entry.name, [], { showArchive });
    await prunePdfTextCaches(entry.name).catch(() => undefined);
    await pruneAudioSidecars(entry.name).catch(() => undefined);

    notebooks.push({
      kind: "notebook",
      name: entry.name,
      path: entry.name,
      createdAt: metadata.createdAt,
      color: metadata.color,
      emoji: metadata.emoji,
      illustration: metadata.illustration,
      groupId:
        metadata.groupId && validGroupIds.has(metadata.groupId)
          ? metadata.groupId
          : null,
      updatedAt: latestIsoDate(
        notebookStats.mtime.toISOString(),
        ...latestTreeNodeUpdatedAt(children),
      ),
      children,
    });
    collectFilePaths(children, filePaths);
    expandablePaths.add(entry.name);
    collectExpandablePaths(children, expandablePaths);
  }

  for (const folder of linkedFolders) {
    const node = await getLinkedFolderNode(folder, { showArchive, validGroupIds });
    if (!node.folder?.missing) {
      await prunePdfTextCaches(folder.name).catch(() => undefined);
      await pruneAudioSidecars(folder.name).catch(() => undefined);
    }
    notebooks.push(node);
    collectFilePaths(node.children, filePaths);
    expandablePaths.add(node.name);
    collectExpandablePaths(node.children, expandablePaths);
  }

  await populateRelatedNotebooks(notebooks);
  // Re-attach reference files moved outside Libera, in the background.
  void scheduleReferenceReattach();

  return {
    archiveIncluded: showArchive,
    root: getAdminRoot(),
    lastNotebookName: await readLastNotebookName(),
    notebookPanelExpandedPaths:
      workspaceMetadata.notebookPanelExpandedPaths === null
        ? null
        : workspaceMetadata.notebookPanelExpandedPaths.filter((expandedPath) =>
            expandablePaths.has(expandedPath),
          ),
    notebookGroups: workspaceMetadata.notebookGroups,
    notebookViewOptions: normalizeTreeViewOptions({
      notebookNames: new Set(notebooks.map((notebook) => notebook.name)),
      validGroupIds,
      viewOptions: workspaceMetadata.notebookViewOptions,
    }),
    starredFilePaths: workspaceMetadata.starredFilePaths.filter((filePath) =>
      filePaths.has(filePath),
    ),
    fileTags: Object.fromEntries(
      Object.entries(workspaceMetadata.fileTags).filter(([filePath]) => filePaths.has(filePath)),
    ),
    notebooks: notebooks.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
