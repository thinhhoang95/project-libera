import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { StorageError } from "@/lib/storage/errors";
import { readNotebookMetadata, writeNotebookMetadata } from "@/lib/storage/notebook-metadata";
import { ensureAdminRoot, getAdminRoot, notebookPath } from "@/lib/storage/paths";
import { getTree } from "@/lib/storage/tree";
import {
  normalizeNotebookViewOptions,
  readWorkspaceMetadata,
  writeWorkspaceMetadata,
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

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

async function readNotebookMetadataWithFallback(
  notebook: string,
): Promise<LiberaNotebookMetadata> {
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

  const metadata = await readWorkspaceMetadata();
  const title = normalizeGroupTitle(input.title);
  const notebookNames = normalizeNotebookNames(input.notebookNames);
  const now = new Date().toISOString();

  assertUniqueGroupTitle(metadata.notebookGroups, title);
  assertNotebookNamesExist(notebookNames, new Set(await listNotebookNames()));

  const group: LiberaNotebookGroup = {
    id: randomUUID(),
    title,
    description: normalizeGroupDescription(input.description),
    createdAt: now,
    updatedAt: now,
  };

  await writeWorkspaceMetadata({
    ...metadata,
    notebookGroups: [...metadata.notebookGroups, group],
  });
  await assignNotebooksToGroup(group.id, notebookNames);

  return getTree();
}

export async function updateNotebookGroup(
  id: string,
  input: NotebookGroupInput,
) {
  await ensureAdminRoot();

  const metadata = await readWorkspaceMetadata();
  const existingGroup = metadata.notebookGroups.find((group) => group.id === id);

  if (!existingGroup) {
    throw new StorageError("Group was not found.", 404);
  }

  const title = normalizeGroupTitle(input.title);
  const notebookNames = normalizeNotebookNames(input.notebookNames);

  assertUniqueGroupTitle(metadata.notebookGroups, title, id);
  assertNotebookNamesExist(notebookNames, new Set(await listNotebookNames()));

  await writeWorkspaceMetadata({
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
  });
  await assignNotebooksToGroup(id, notebookNames);

  return getTree();
}

export async function deleteNotebookGroup(id: string) {
  await ensureAdminRoot();

  const metadata = await readWorkspaceMetadata();
  const existingGroup = metadata.notebookGroups.find((group) => group.id === id);

  if (!existingGroup) {
    throw new StorageError("Group was not found.", 404);
  }

  await writeWorkspaceMetadata({
    ...metadata,
    notebookGroups: metadata.notebookGroups.filter((group) => group.id !== id),
    notebookViewOptions: {
      hiddenGroupIds: metadata.notebookViewOptions.hiddenGroupIds.filter(
        (groupId) => groupId !== id,
      ),
      hiddenNotebookNames: metadata.notebookViewOptions.hiddenNotebookNames,
      showArchive: metadata.notebookViewOptions.showArchive,
    },
  });
  await unassignDeletedGroup(id);

  return getTree();
}

export async function updateNotebookViewOptions(
  input: Partial<LiberaNotebookViewOptions>,
) {
  await ensureAdminRoot();

  const metadata = await readWorkspaceMetadata();
  const notebookViewOptions = normalizeNotebookViewOptions({
    ...metadata.notebookViewOptions,
    ...input,
  });

  await writeWorkspaceMetadata({
    ...metadata,
    notebookViewOptions,
  });

  return getTree();
}
