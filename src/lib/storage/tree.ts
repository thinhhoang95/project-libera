import { readdir, stat } from "node:fs/promises";
import { ARCHIVE_DIR, MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { assertSupportedFileName, getFileType } from "@/lib/storage/file-types";
import { pathExists } from "@/lib/storage/fs-utils";
import { readNotebookMetadata } from "@/lib/storage/notebook-metadata";
import { readWorkspaceMetadata } from "@/lib/storage/workspace-metadata";
import {
  ensureAdminRoot,
  filePathFromParts,
  getAdminRoot,
  imageAnnotationsPath,
  itemPath,
  legacyImageAnnotationsPath,
  legacyPdfAnnotationsPath,
  notebookPath,
  pdfAnnotationsPath,
  relativeFilePath,
  relativeItemPath,
} from "@/lib/storage/paths";
import type {
  LiberaFileNode,
  LiberaNotebookViewOptions,
  LiberaNotebookNode,
  LiberaTree,
  LiberaTreeNode,
} from "@/lib/types";

function shouldSkipTreeEntry(name: string, options?: { showArchive?: boolean }) {
  return (
    name.startsWith(".") ||
    name.startsWith("._") ||
    name === "__MACOSX" ||
    name === MARKDOWN_ASSETS_DIR ||
    (name === ARCHIVE_DIR && !options?.showArchive)
  );
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
  name: string,
  fileType: LiberaFileNode["fileType"],
  fileUpdatedAt: string,
) {
  if (fileType === "pdf") {
    return latestIsoDate(
      fileUpdatedAt,
      ...(await latestExistingPathMtime([
        pdfAnnotationsPath(notebook, name),
        legacyPdfAnnotationsPath(notebook, name),
      ])),
    );
  }

  if (fileType === "image") {
    return latestIsoDate(
      fileUpdatedAt,
      ...(await latestExistingPathMtime([
        imageAnnotationsPath(notebook, name),
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
    size: stats.size,
    updatedAt: await getFileUpdatedAt(
      notebook,
      name,
      fileType,
      stats.mtime.toISOString(),
    ),
  };
}

async function readTreeDirectory(
  notebook: string,
  parentParts: string[],
  options: { showArchive?: boolean } = {},
): Promise<LiberaTreeNode[]> {
  const directoryPath = itemPath(notebook, parentParts);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const children: LiberaTreeNode[] = [];

  for (const entry of entries) {
    if (shouldSkipTreeEntry(entry.name, options)) {
      continue;
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

export async function getTree(): Promise<LiberaTree> {
  await ensureAdminRoot();

  const workspaceMetadata = await readWorkspaceMetadata();
  const validGroupIds = new Set(
    workspaceMetadata.notebookGroups.map((group) => group.id),
  );
  const entries = await readdir(getAdminRoot(), { withFileTypes: true });
  const notebooks: LiberaNotebookNode[] = [];
  const filePaths = new Set<string>();
  const expandablePaths = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const currentNotebookPath = notebookPath(entry.name);
    const notebookStats = await stat(currentNotebookPath);
    const metadata = await readNotebookMetadata(
      entry.name,
      notebookStats.birthtime.toISOString(),
    );
    const children = await readTreeDirectory(entry.name, [], {
      showArchive: workspaceMetadata.notebookViewOptions.showArchive,
    });

    notebooks.push({
      kind: "notebook",
      name: entry.name,
      path: entry.name,
      createdAt: metadata.createdAt,
      color: metadata.color,
      emoji: metadata.emoji,
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

  return {
    root: getAdminRoot(),
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
    notebooks: notebooks.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
