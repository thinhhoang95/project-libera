import { readFile } from "node:fs/promises";
import { writeJsonState } from "./json-state";
import { workspaceMetadataPath } from "@/lib/storage/paths";
import type {
  LiberaNotebookGroup,
  LiberaNotebookViewOptions,
} from "@/lib/types";

export type LiberaWorkspaceMetadata = {
  notebookPanelExpandedPaths: string[] | null;
  notebookGroups: LiberaNotebookGroup[];
  notebookViewOptions: LiberaNotebookViewOptions;
  starredFilePaths: string[];
  /** Manual tags keyed by relative file path. */
  fileTags: Record<string, string[]>;
};

const DEFAULT_NOTEBOOK_VIEW_OPTIONS: LiberaNotebookViewOptions = {
  hiddenGroupIds: [],
  hiddenNotebookNames: [],
  showArchive: false,
};

const DEFAULT_WORKSPACE_METADATA: LiberaWorkspaceMetadata = {
  notebookPanelExpandedPaths: null,
  notebookGroups: [],
  notebookViewOptions: DEFAULT_NOTEBOOK_VIEW_OPTIONS,
  starredFilePaths: [],
  fileTags: {},
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

const MAX_TAG_LENGTH = 40;

/** Trims, de-duplicates (case-insensitively) and drops empty tags. */
export function normalizeFileTags(value: unknown) {
  const seen = new Set<string>();

  return normalizeStringArray(value)
    .map((tag) => tag.replace(/\s+/g, " ").slice(0, MAX_TAG_LENGTH))
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeFileTagMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([filePath, tags]) => [filePath, normalizeFileTags(tags)] as const)
      .filter(([filePath, tags]) => filePath && tags.length),
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
    showArchive: candidate.showArchive === true,
  };
}

export function normalizeWorkspaceMetadata(value: unknown): LiberaWorkspaceMetadata {
  if (!value || typeof value !== "object") {
    return DEFAULT_WORKSPACE_METADATA;
  }

  const candidate = value as Partial<LiberaWorkspaceMetadata>;

  return {
    notebookPanelExpandedPaths: Array.isArray(candidate.notebookPanelExpandedPaths)
      ? normalizeStringArray(candidate.notebookPanelExpandedPaths)
      : null,
    notebookGroups: normalizeNotebookGroups(candidate.notebookGroups),
    notebookViewOptions: normalizeNotebookViewOptions(candidate.notebookViewOptions),
    starredFilePaths: normalizeStringArray(candidate.starredFilePaths),
    fileTags: normalizeFileTagMap(candidate.fileTags),
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
  await writeJsonState(workspaceMetadataPath(), normalizeWorkspaceMetadata(metadata));
}

export async function setNotebookPanelExpandedPaths(expandedPaths: string[]) {
  const workspaceMetadata = await readWorkspaceMetadata();

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    notebookPanelExpandedPaths: normalizeStringArray(expandedPaths),
  });
}

export async function renameNotebookPanelExpandedPathPrefix(
  currentPrefix: string,
  nextPrefix: string,
) {
  if (currentPrefix === nextPrefix) {
    return;
  }

  const workspaceMetadata = await readWorkspaceMetadata();

  if (!workspaceMetadata.notebookPanelExpandedPaths) {
    return;
  }

  let changed = false;
  const notebookPanelExpandedPaths = workspaceMetadata.notebookPanelExpandedPaths.map(
    (expandedPath) => {
      if (expandedPath === currentPrefix) {
        changed = true;
        return nextPrefix;
      }

      if (expandedPath.startsWith(`${currentPrefix}/`)) {
        changed = true;
        return `${nextPrefix}/${expandedPath.slice(currentPrefix.length + 1)}`;
      }

      return expandedPath;
    },
  );

  if (!changed) {
    return;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    notebookPanelExpandedPaths,
  });
}

export async function removeNotebookPanelExpandedPathPrefix(prefix: string) {
  const workspaceMetadata = await readWorkspaceMetadata();

  if (!workspaceMetadata.notebookPanelExpandedPaths) {
    return;
  }

  const notebookPanelExpandedPaths = workspaceMetadata.notebookPanelExpandedPaths.filter(
    (expandedPath) =>
      expandedPath !== prefix && !expandedPath.startsWith(`${prefix}/`),
  );

  if (
    notebookPanelExpandedPaths.length ===
    workspaceMetadata.notebookPanelExpandedPaths.length
  ) {
    return;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    notebookPanelExpandedPaths,
  });
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

/** Keeps per-file metadata (stars, tags) attached to a file that moved. */
export async function renameFileMetadataPath(currentPath: string, nextPath: string) {
  if (currentPath === nextPath) {
    return;
  }

  const workspaceMetadata = await readWorkspaceMetadata();
  const tags = workspaceMetadata.fileTags[currentPath];

  if (!workspaceMetadata.starredFilePaths.includes(currentPath) && !tags) {
    return;
  }

  const fileTags = { ...workspaceMetadata.fileTags };

  if (tags) {
    delete fileTags[currentPath];
    fileTags[nextPath] = tags;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    fileTags,
    starredFilePaths: workspaceMetadata.starredFilePaths.map((starredFilePath) =>
      starredFilePath === currentPath ? nextPath : starredFilePath,
    ),
  });
}

export async function removeFileMetadataPath(filePath: string) {
  const workspaceMetadata = await readWorkspaceMetadata();

  if (!workspaceMetadata.starredFilePaths.includes(filePath) && !workspaceMetadata.fileTags[filePath]) {
    return;
  }

  const fileTags = { ...workspaceMetadata.fileTags };
  delete fileTags[filePath];

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    fileTags,
    starredFilePaths: workspaceMetadata.starredFilePaths.filter(
      (starredFilePath) => starredFilePath !== filePath,
    ),
  });
}

export async function renameFileMetadataPathPrefix(
  currentPrefix: string,
  nextPrefix: string,
) {
  if (currentPrefix === nextPrefix) {
    return;
  }

  const workspaceMetadata = await readWorkspaceMetadata();
  let changed = false;
  const remap = (filePath: string) => {
    if (!filePath.startsWith(`${currentPrefix}/`)) {
      return filePath;
    }

    changed = true;
    return `${nextPrefix}/${filePath.slice(currentPrefix.length + 1)}`;
  };
  const starredFilePaths = workspaceMetadata.starredFilePaths.map(remap);
  const fileTags = Object.fromEntries(
    Object.entries(workspaceMetadata.fileTags).map(([filePath, tags]) => [remap(filePath), tags]),
  );

  if (!changed) {
    return;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    fileTags,
    starredFilePaths,
  });
}

export async function removeFileMetadataPathPrefix(prefix: string) {
  const workspaceMetadata = await readWorkspaceMetadata();
  const inside = (filePath: string) => filePath.startsWith(`${prefix}/`);
  const starredFilePaths = workspaceMetadata.starredFilePaths.filter((filePath) => !inside(filePath));
  const fileTags = Object.fromEntries(
    Object.entries(workspaceMetadata.fileTags).filter(([filePath]) => !inside(filePath)),
  );

  if (
    starredFilePaths.length === workspaceMetadata.starredFilePaths.length &&
    Object.keys(fileTags).length === Object.keys(workspaceMetadata.fileTags).length
  ) {
    return;
  }

  await writeWorkspaceMetadata({
    ...workspaceMetadata,
    fileTags,
    starredFilePaths,
  });
}

export async function setFileTagsForPath(filePath: string, tags: string[]) {
  const workspaceMetadata = await readWorkspaceMetadata();
  const fileTags = { ...workspaceMetadata.fileTags };
  const normalized = normalizeFileTags(tags);

  if (normalized.length) {
    fileTags[filePath] = normalized;
  } else {
    delete fileTags[filePath];
  }

  await writeWorkspaceMetadata({ ...workspaceMetadata, fileTags });
}
