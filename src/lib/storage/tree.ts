import { readdir, stat } from "node:fs/promises";
import { MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { assertSupportedFileName, getFileType } from "@/lib/storage/file-types";
import { pathExists } from "@/lib/storage/fs-utils";
import { readNotebookMetadata } from "@/lib/storage/notebook-metadata";
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
      const grandChildren = await readTreeDirectory(notebook, childParts);
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
    const children = await readTreeDirectory(entry.name, []);

    notebooks.push({
      kind: "notebook",
      name: entry.name,
      path: entry.name,
      createdAt: metadata.createdAt,
      color: metadata.color,
      emoji: metadata.emoji,
      updatedAt: latestIsoDate(
        notebookStats.mtime.toISOString(),
        ...latestTreeNodeUpdatedAt(children),
      ),
      children,
    });
  }

  return {
    root: getAdminRoot(),
    notebooks: notebooks.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
