import { readFile, writeFile } from "node:fs/promises";
import { workspaceMetadataPath } from "@/lib/storage/paths";
import type {
  LiberaNotebookGroup,
  LiberaNotebookViewOptions,
} from "@/lib/types";

export type LiberaWorkspaceMetadata = {
  notebookGroups: LiberaNotebookGroup[];
  notebookViewOptions: LiberaNotebookViewOptions;
  starredFilePaths: string[];
};

const DEFAULT_NOTEBOOK_VIEW_OPTIONS: LiberaNotebookViewOptions = {
  hiddenGroupIds: [],
  hiddenNotebookNames: [],
};

const DEFAULT_WORKSPACE_METADATA: LiberaWorkspaceMetadata = {
  notebookGroups: [],
  notebookViewOptions: DEFAULT_NOTEBOOK_VIEW_OPTIONS,
  starredFilePaths: [],
};

function normalizeDate(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  return Number.isFinite(Date.parse(value)) ? value : fallback;
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeNotebookGroups(value: unknown): LiberaNotebookGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const groups: LiberaNotebookGroup[] = [];
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const candidate = item as Partial<LiberaNotebookGroup>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    const normalizedTitle = title.toLowerCase();

    if (!id || !title || seenIds.has(id) || seenTitles.has(normalizedTitle)) {
      continue;
    }

    const createdAt = normalizeDate(candidate.createdAt, new Date().toISOString());

    groups.push({
      id,
      title,
      description:
        typeof candidate.description === "string"
          ? candidate.description.trim()
          : "",
      createdAt,
      updatedAt: normalizeDate(candidate.updatedAt, createdAt),
    });
    seenIds.add(id);
    seenTitles.add(normalizedTitle);
  }

  return groups;
}

export function normalizeNotebookViewOptions(
  value: unknown,
): LiberaNotebookViewOptions {
  if (!value || typeof value !== "object") {
    return DEFAULT_NOTEBOOK_VIEW_OPTIONS;
  }

  const candidate = value as Partial<LiberaNotebookViewOptions>;

  return {
    hiddenGroupIds: normalizeStringArray(candidate.hiddenGroupIds),
    hiddenNotebookNames: normalizeStringArray(candidate.hiddenNotebookNames),
  };
}

export function normalizeWorkspaceMetadata(value: unknown): LiberaWorkspaceMetadata {
  if (!value || typeof value !== "object") {
    return DEFAULT_WORKSPACE_METADATA;
  }

  const candidate = value as Partial<LiberaWorkspaceMetadata>;

  return {
    notebookGroups: normalizeNotebookGroups(candidate.notebookGroups),
    notebookViewOptions: normalizeNotebookViewOptions(candidate.notebookViewOptions),
    starredFilePaths: normalizeStringArray(candidate.starredFilePaths),
  };
}

export async function readWorkspaceMetadata(): Promise<LiberaWorkspaceMetadata> {
  try {
    return normalizeWorkspaceMetadata(
      JSON.parse(await readFile(workspaceMetadataPath(), "utf8")),
    );
  } catch {
    return normalizeWorkspaceMetadata(undefined);
  }
}

export async function writeWorkspaceMetadata(metadata: LiberaWorkspaceMetadata) {
  await writeFile(
    workspaceMetadataPath(),
    `${JSON.stringify(normalizeWorkspaceMetadata(metadata), null, 2)}\n`,
    "utf8",
  );
}

export async function setStarredFilePath(filePath: string, starred: boolean) {
  const workspaceMetadata = await readWorkspaceMetadata();
  const starredFilePaths = workspaceMetadata.starredFilePaths.filter(
    (starredFilePath) => starredFilePath !== filePath,
  );

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    starredFilePaths: starred ? [filePath, ...starredFilePaths] : starredFilePaths,
  });
}

export async function renameStarredFilePath(currentPath: string, nextPath: string) {
  if (currentPath === nextPath) {
    return;
  }

  const workspaceMetadata = await readWorkspaceMetadata();

  if (!workspaceMetadata.starredFilePaths.includes(currentPath)) {
    return;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    starredFilePaths: workspaceMetadata.starredFilePaths.map((starredFilePath) =>
      starredFilePath === currentPath ? nextPath : starredFilePath,
    ),
  });
}

export async function removeStarredFilePath(filePath: string) {
  const workspaceMetadata = await readWorkspaceMetadata();

  if (!workspaceMetadata.starredFilePaths.includes(filePath)) {
    return;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    starredFilePaths: workspaceMetadata.starredFilePaths.filter(
      (starredFilePath) => starredFilePath !== filePath,
    ),
  });
}

export async function renameStarredFilePathPrefix(
  currentPrefix: string,
  nextPrefix: string,
) {
  if (currentPrefix === nextPrefix) {
    return;
  }

  const workspaceMetadata = await readWorkspaceMetadata();
  let changed = false;
  const starredFilePaths = workspaceMetadata.starredFilePaths.map((starredFilePath) => {
    if (!starredFilePath.startsWith(`${currentPrefix}/`)) {
      return starredFilePath;
    }

    changed = true;
    return `${nextPrefix}/${starredFilePath.slice(currentPrefix.length + 1)}`;
  });

  if (!changed) {
    return;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    starredFilePaths,
  });
}

export async function removeStarredFilePathPrefix(prefix: string) {
  const workspaceMetadata = await readWorkspaceMetadata();
  const starredFilePaths = workspaceMetadata.starredFilePaths.filter(
    (starredFilePath) => !starredFilePath.startsWith(`${prefix}/`),
  );

  if (starredFilePaths.length === workspaceMetadata.starredFilePaths.length) {
    return;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    starredFilePaths,
  });
}
