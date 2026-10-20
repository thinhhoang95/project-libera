import { moveReviewPath, deleteReviewPath } from "./markdown-reviews";
import { detachReferenceAttachments, moveReferenceAttachments } from "./references";
import { randomInt } from "node:crypto";
import { NOTEBOOK_ILLUSTRATION_IDS } from "@/lib/notebook-illustrations";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { StorageError } from "@/lib/storage/errors";
import { pathExists } from "@/lib/storage/fs-utils";
import {
  normalizeNotebookMetadata,
  readNotebookMetadata,
  writeNotebookMetadata,
} from "@/lib/storage/notebook-metadata";
import { renameLinkedFolder } from "@/lib/storage/directory-mode";
import {
  assertSafeSegment,
  ensureAdminRoot,
  getLinkedFolder,
  getLinkedFolders,
  notebookPath,
} from "@/lib/storage/paths";
import { getTree, LINKED_FOLDER_METADATA_DEFAULTS } from "@/lib/storage/tree";
import {
  removeNotebookPanelExpandedPathPrefix,
  readWorkspaceMetadata,
  removeFileMetadataPathPrefix,
  renameNotebookPanelExpandedPathPrefix,
  renameFileMetadataPathPrefix,
  writeWorkspaceMetadata,
} from "@/lib/storage/workspace-metadata";
import type { LiberaNotebookMetadata } from "@/lib/types";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { remapLastNotebookName } from "@/lib/storage/last-notebook";
import { assertNotSharedItem, SharedDocumentError, sharedNotebookMarker } from "@/lib/collab/shared-notebook";

/** Notebooks and linked folders share one namespace of top-level names. */
function assertNameNotUsedByFolder(name: string, except?: string) {
  const normalized = name.trim().toLowerCase();

  if (getLinkedFolders().some((folder) => folder.name !== except && folder.name.toLowerCase() === normalized)) {
    throw new StorageError("A linked folder already uses this name.", 409);
  }
}

export async function createNotebook(
  name: string,
  metadataInput?: Partial<LiberaNotebookMetadata>,
) {
  assertNameNotUsedByFolder(name);
  await ensureAdminRoot();
  const targetPath = notebookPath(name);

  if (await pathExists(targetPath)) {
    throw new StorageError("Notebook already exists.", 409);
  }

  await mkdir(targetPath);
  await writeNotebookMetadata(
    name,
    normalizeNotebookMetadata({
      ...metadataInput,
      illustration: NOTEBOOK_ILLUSTRATION_IDS[randomInt(NOTEBOOK_ILLUSTRATION_IDS.length)],
    }, new Date().toISOString()),
  );

  return getTree();
}

export async function renameNotebook(
  currentName: string,
  nextName: string,
  metadataInput?: Partial<LiberaNotebookMetadata>,
) {
  await ensureAdminRoot();
  const safeCurrentName = assertSafeSegment(currentName, "Notebook name");
  const safeNextName = assertSafeSegment(nextName, "Notebook name");
  const linkedFolder = getLinkedFolder(safeCurrentName);
  assertNameNotUsedByFolder(safeNextName, linkedFolder?.name);
  const currentPath = notebookPath(safeCurrentName);
  const existingMetadata = linkedFolder
    ? await readNotebookMetadata(safeCurrentName, new Date(0).toISOString(), LINKED_FOLDER_METADATA_DEFAULTS)
    : await readNotebookMetadata(
        safeCurrentName,
        (await stat(currentPath)).birthtime.toISOString(),
      );

  // The host knows a shared notebook by its folder; renaming it on disk would
  // orphan the project. Changing only the color or emoji is still fine.
  if (!linkedFolder && safeCurrentName !== safeNextName) assertNotSharedItem(safeCurrentName);

  if (linkedFolder) {
    // Only the folder's name in Libera changes; the folder on disk keeps its name.
    renameLinkedFolder(safeCurrentName, safeNextName);
  } else {
    const nextPath = notebookPath(safeNextName);

    if (currentPath !== nextPath && (await pathExists(nextPath))) {
      throw new StorageError("Destination notebook already exists.", 409);
    }

    if (currentPath !== nextPath) {
      await rename(currentPath, nextPath);
    }
  }

  currentName = safeCurrentName;
  nextName = safeNextName;

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
  await moveReviewPath(currentName, nextName);
  // The notebook's own library moves with its folder; pointers into it are renamed here.
  await moveReferenceAttachments(currentName, nextName);
  await renameFileMetadataPathPrefix(currentName, nextName);
  await remapLastNotebookName(currentName, nextName);
  if (currentName !== nextName) notifySearchChanges();

  return getTree();
}

export async function deleteNotebook(name: string) {
  if (getLinkedFolder(assertSafeSegment(name, "Notebook name"))) {
    // Never delete a user's own folder from disk through the notebook action.
    throw new StorageError("Remove the folder from Libera instead. Its files stay on disk.", 409);
  }

  // A shared notebook is removed by leaving the project first. Once access is
  // revoked the folder is only a local copy, which the user may delete.
  const marker = sharedNotebookMarker(assertSafeSegment(name, "Notebook name"));
  if (marker && !marker.revoked) throw new SharedDocumentError(name);

  await ensureAdminRoot();
  await rm(notebookPath(name), { recursive: true });
  await removeNotebookViewOption(name);
  await removeNotebookPanelExpandedPathPrefix(name);
  await deleteReviewPath(name);
  // The notebook's own library was deleted with its folder; other libraries lose pointers into it.
  await detachReferenceAttachments(assertSafeSegment(name, "Notebook name"));
  await removeFileMetadataPathPrefix(name);
  await remapLastNotebookName(name);
  notifySearchChanges();

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
