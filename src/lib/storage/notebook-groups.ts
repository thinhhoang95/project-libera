import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { StorageError } from "@/lib/storage/errors";
import { readNotebookMetadata, writeNotebookMetadata } from "@/lib/storage/notebook-metadata";
import {
  ensureAdminRoot,
  getAdminRoot,
  getLinkedFolder,
  getLinkedFolders,
  notebookPath,
} from "@/lib/storage/paths";
import { getTree, LINKED_FOLDER_METADATA_DEFAULTS } from "@/lib/storage/tree";
import {
  normalizeNotebookViewOptions,
  updateWorkspaceMetadata,
} from "@/lib/storage/workspace-metadata";
import type {
  LiberaNotebookGroup,
  LiberaNotebookMetadata,
  LiberaNotebookViewOptions,
} from "@/lib/types";

type NotebookGroupInput = {
  description?: string | null;
  notebookNames?: string[] | null;
  title?: string | null;
};

function normalizeGroupTitle(title: string | null | undefined) {
  const trimmed = title?.trim() ?? "";

  if (!trimmed) {
    throw new StorageError("Group title is required.");
  }

  return trimmed;
}

function normalizeGroupDescription(description: string | null | undefined) {
  return description?.trim() ?? "";
}

function normalizeNotebookNames(notebookNames: string[] | null | undefined) {
  if (!Array.isArray(notebookNames)) {
    return new Set<string>();
  }

  return new Set(
    notebookNames
      .filter((notebookName): notebookName is string => typeof notebookName === "string")
      .map((notebookName) => notebookName.trim())
      .filter(Boolean),
  );
}

function assertUniqueGroupTitle(
  groups: LiberaNotebookGroup[],
  title: string,
  currentGroupId?: string,
) {
  const normalizedTitle = title.toLowerCase();
  const duplicate = groups.find(
    (group) =>
      group.id !== currentGroupId && group.title.toLowerCase() === normalizedTitle,
  );

  if (duplicate) {
    throw new StorageError("Group title already exists.", 409);
  }
}

async function listNotebookNames() {
  await ensureAdminRoot();

  const entries = await readdir(getAdminRoot(), { withFileTypes: true });

  const folderNames = getLinkedFolders().map((folder) => folder.name);

  return [
    ...entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !folderNames.includes(entry.name))
      .map((entry) => entry.name),
    ...folderNames,
  ];
}

export async function readNotebookMetadataWithFallback(
  notebook: string,
): Promise<LiberaNotebookMetadata> {
  if (getLinkedFolder(notebook)) {
    // A linked folder may be unplugged; its metadata lives in the data folder.
    return readNotebookMetadata(notebook, new Date(0).toISOString(), LINKED_FOLDER_METADATA_DEFAULTS);
  }

  const notebookStats = await stat(notebookPath(notebook));
  return readNotebookMetadata(notebook, notebookStats.birthtime.toISOString());
}

async function assignNotebooksToGroup(groupId: string, notebookNames: Set<string>) {
  const existingNotebookNames = new Set(await listNotebookNames());

  assertNotebookNamesExist(notebookNames, existingNotebookNames);

  for (const notebookName of existingNotebookNames) {
    const metadata = await readNotebookMetadataWithFallback(notebookName);
    const nextGroupId = notebookNames.has(notebookName)
      ? groupId
      : metadata.groupId === groupId
        ? null
        : metadata.groupId;

    if (metadata.groupId === nextGroupId) {
      continue;
    }

    await writeNotebookMetadata(notebookName, {
      ...metadata,
      groupId: nextGroupId,
    });
  }
}

function assertNotebookNamesExist(
  notebookNames: Set<string>,
  existingNotebookNames: Set<string>,
) {
  for (const notebookName of notebookNames) {
    if (!existingNotebookNames.has(notebookName)) {
      throw new StorageError(`Notebook ${notebookName} was not found.`, 404);
    }
  }
}

async function unassignDeletedGroup(groupId: string) {
  for (const notebookName of await listNotebookNames()) {
    const metadata = await readNotebookMetadataWithFallback(notebookName);

    if (metadata.groupId !== groupId) {
      continue;
    }

    await writeNotebookMetadata(notebookName, {
      ...metadata,
      groupId: null,
    });
  }
}

export async function createNotebookGroup(input: NotebookGroupInput) {
  await ensureAdminRoot();

  const title = normalizeGroupTitle(input.title);
  const notebookNames = normalizeNotebookNames(input.notebookNames);
  const now = new Date().toISOString();

  assertNotebookNamesExist(notebookNames, new Set(await listNotebookNames()));

  const group: LiberaNotebookGroup = {
    id: randomUUID(),
    title,
    description: normalizeGroupDescription(input.description),
    createdAt: now,
    updatedAt: now,
  };

  // Through the settings queue, so a star or a move's rekey saved at the same time is not erased.
  await updateWorkspaceMetadata((metadata) => {
    assertUniqueGroupTitle(metadata.notebookGroups, title);
    return { ...metadata, notebookGroups: [...metadata.notebookGroups, group] };
  });
  await assignNotebooksToGroup(group.id, notebookNames);

  return getTree();
}

export async function updateNotebookGroup(
  id: string,
  input: NotebookGroupInput,
) {
  await ensureAdminRoot();

  const title = normalizeGroupTitle(input.title);
  const notebookNames = normalizeNotebookNames(input.notebookNames);

  assertNotebookNamesExist(notebookNames, new Set(await listNotebookNames()));

  await updateWorkspaceMetadata((metadata) => {
    if (!metadata.notebookGroups.some((group) => group.id === id)) {
      throw new StorageError("Group was not found.", 404);
    }
    assertUniqueGroupTitle(metadata.notebookGroups, title, id);
    return {
      ...metadata,
      notebookGroups: metadata.notebookGroups.map((group) =>
        group.id === id
          ? {
              ...group,
              title,
              description: normalizeGroupDescription(input.description),
              updatedAt: new Date().toISOString(),
            }
          : group,
      ),
    };
  });
  await assignNotebooksToGroup(id, notebookNames);

  return getTree();
}

export async function deleteNotebookGroup(id: string) {
  await ensureAdminRoot();

  await updateWorkspaceMetadata((metadata) => {
    if (!metadata.notebookGroups.some((group) => group.id === id)) {
      throw new StorageError("Group was not found.", 404);
    }
    return {
      ...metadata,
      notebookGroups: metadata.notebookGroups.filter((group) => group.id !== id),
      notebookViewOptions: {
        hiddenGroupIds: metadata.notebookViewOptions.hiddenGroupIds.filter(
          (groupId) => groupId !== id,
        ),
        hiddenNotebookNames: metadata.notebookViewOptions.hiddenNotebookNames,
        showArchive: metadata.notebookViewOptions.showArchive,
        showFileDetails: metadata.notebookViewOptions.showFileDetails,
      },
    };
  });
  await unassignDeletedGroup(id);

  return getTree();
}

export async function updateNotebookViewOptions(
  input: Partial<LiberaNotebookViewOptions>,
) {
  await ensureAdminRoot();

  await updateWorkspaceMetadata((metadata) => ({
    ...metadata,
    notebookViewOptions: normalizeNotebookViewOptions({
      ...metadata.notebookViewOptions,
      ...input,
    }),
  }));

  return getTree();
}
