import { mkdir, rename, rm, stat } from "node:fs/promises";
import { StorageError } from "@/lib/storage/errors";
import { pathExists } from "@/lib/storage/fs-utils";
import {
  normalizeNotebookMetadata,
  readNotebookMetadata,
  writeNotebookMetadata,
} from "@/lib/storage/notebook-metadata";
import { ensureAdminRoot, notebookPath } from "@/lib/storage/paths";
import { getTree } from "@/lib/storage/tree";
import {
  removeNotebookPanelExpandedPathPrefix,
  readWorkspaceMetadata,
  removeStarredFilePathPrefix,
  renameNotebookPanelExpandedPathPrefix,
  renameStarredFilePathPrefix,
  writeWorkspaceMetadata,
} from "@/lib/storage/workspace-metadata";
import type { LiberaNotebookMetadata } from "@/lib/types";

export async function createNotebook(
  name: string,
  metadataInput?: Partial<LiberaNotebookMetadata>,
) {
  await ensureAdminRoot();
  const targetPath = notebookPath(name);

  if (await pathExists(targetPath)) {
    throw new StorageError("Notebook already exists.", 409);
  }

  await mkdir(targetPath);
  await writeNotebookMetadata(
    name,
    normalizeNotebookMetadata(metadataInput, new Date().toISOString()),
  );

  return getTree();
}

export async function renameNotebook(
  currentName: string,
  nextName: string,
  metadataInput?: Partial<LiberaNotebookMetadata>,
) {
  await ensureAdminRoot();
  const currentPath = notebookPath(currentName);
  const nextPath = notebookPath(nextName);
  const currentStats = await stat(currentPath);
  const existingMetadata = await readNotebookMetadata(
    currentName,
    currentStats.birthtime.toISOString(),
  );

  if (currentPath !== nextPath && (await pathExists(nextPath))) {
    throw new StorageError("Destination notebook already exists.", 409);
  }

  if (currentPath !== nextPath) {
    await rename(currentPath, nextPath);
  }

  await writeNotebookMetadata(
    nextName,
    normalizeNotebookMetadata(
      {
        ...existingMetadata,
        color: metadataInput?.color ?? existingMetadata.color,
        emoji: metadataInput?.emoji ?? existingMetadata.emoji,
        groupId: metadataInput?.groupId ?? existingMetadata.groupId,
      },
      existingMetadata.createdAt,
    ),
  );
  await renameNotebookViewOption(currentName, nextName);
  await renameNotebookPanelExpandedPathPrefix(currentName, nextName);
  await renameStarredFilePathPrefix(currentName, nextName);

  return getTree();
}

export async function deleteNotebook(name: string) {
  await ensureAdminRoot();
  await rm(notebookPath(name), { recursive: true });
  await removeNotebookViewOption(name);
  await removeNotebookPanelExpandedPathPrefix(name);
  await removeStarredFilePathPrefix(name);

  return getTree();
}

async function renameNotebookViewOption(currentName: string, nextName: string) {
  if (currentName === nextName) {
    return;
  }

  const workspaceMetadata = await readWorkspaceMetadata();

  if (!workspaceMetadata.notebookViewOptions.hiddenNotebookNames.includes(currentName)) {
    return;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    notebookViewOptions: {
      ...workspaceMetadata.notebookViewOptions,
      hiddenNotebookNames: workspaceMetadata.notebookViewOptions.hiddenNotebookNames.map(
        (notebookName) => (notebookName === currentName ? nextName : notebookName),
      ),
    },
  });
}

async function removeNotebookViewOption(name: string) {
  const workspaceMetadata = await readWorkspaceMetadata();

  if (!workspaceMetadata.notebookViewOptions.hiddenNotebookNames.includes(name)) {
    return;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    notebookViewOptions: {
      ...workspaceMetadata.notebookViewOptions,
      hiddenNotebookNames: workspaceMetadata.notebookViewOptions.hiddenNotebookNames.filter(
        (notebookName) => notebookName !== name,
      ),
    },
  });
}
