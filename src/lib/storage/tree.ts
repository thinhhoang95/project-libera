import { readdir, stat } from "node:fs/promises";
import { MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { assertSupportedFileName, getFileType } from "@/lib/storage/file-types";
import { readNotebookMetadata } from "@/lib/storage/notebook-metadata";
import {
  ensureAdminRoot,
  filePathFromParts,
  getAdminRoot,
  itemPath,
  notebookPath,
  relativeFilePath,
  relativeItemPath,
} from "@/lib/storage/paths";
import type {
  LiberaFileNode,
  LiberaNotebookNode,
  LiberaTree,
  LiberaTreeNode,
} from "@/lib/types";

function shouldSkipTreeEntry(name: string) {
  return (
    name.startsWith(".") ||
    name.startsWith("._") ||
    name === "__MACOSX" ||
    name === MARKDOWN_ASSETS_DIR
  );
}

function sortTreeNodes(left: LiberaTreeNode, right: LiberaTreeNode) {
  if (left.kind !== right.kind) {
    return left.kind === "folder" ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
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
    size: stats.size,
    updatedAt: stats.mtime.toISOString(),
  };
}

async function readTreeDirectory(
  notebook: string,
  parentParts: string[],
): Promise<LiberaTreeNode[]> {
  const directoryPath = itemPath(notebook, parentParts);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const children: LiberaTreeNode[] = [];

  for (const entry of entries) {
    if (shouldSkipTreeEntry(entry.name)) {
      continue;
    }

    const childParts = [...parentParts, entry.name];

    if (entry.isDirectory()) {
      const stats = await stat(itemPath(notebook, childParts));
      children.push({
        kind: "folder",
        name: entry.name,
        path: relativeItemPath(notebook, childParts),
        notebook,
        updatedAt: stats.mtime.toISOString(),
        children: await readTreeDirectory(notebook, childParts),
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

  const entries = await readdir(getAdminRoot(), { withFileTypes: true });
  const notebooks: LiberaNotebookNode[] = [];

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
    notebooks.push({
      kind: "notebook",
      name: entry.name,
      path: entry.name,
      createdAt: metadata.createdAt,
      color: metadata.color,
      emoji: metadata.emoji,
      updatedAt: notebookStats.mtime.toISOString(),
      children: await readTreeDirectory(entry.name, []),
    });
  }

  return {
    root: getAdminRoot(),
    notebooks: notebooks.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
