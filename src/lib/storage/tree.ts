import { prunePdfTextCaches } from "@/lib/storage/pdf-text-cache";
import { pdfFilesOf, reconcilePdfSidecars } from "@/lib/storage/pdf-sidecars";
import { inkSourceFilesOf, reconcileInkFolders } from "@/lib/storage/ink";
import { pruneAudioSidecars } from "@/lib/storage/transcripts";
import { extractNotebookLinkDestinations, populateRelatedNotebooks } from "@/lib/storage/notebook-links";
import { readTextSnapshot } from "@/lib/storage/file-signature";
import { scheduleReferenceReattach } from "@/lib/storage/references";
import { readLastNotebookName } from "@/lib/storage/last-notebook";
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_DIR, INK_DIR, MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { assertSupportedFileName, getFileType } from "@/lib/storage/file-types";
import { pathExists } from "@/lib/storage/fs-utils";
import { readNotebookMetadata } from "@/lib/storage/notebook-metadata";
import { readWorkspaceMetadata } from "@/lib/storage/workspace-metadata";
import { mergeLegacyFolderState } from "@/lib/storage/directory-mode";
import { isNotebookMigrating, whenNotebookIdle } from "@/lib/storage/migration-fence";
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

/**
 * What one notebook's walk learned about itself, for upkeep: whether it saw
 * everything it was meant to (a child that raced away, a folder that could not
 * be listed or the linked-folder cap each make it incomplete), and the hidden
 * archive folders it passed over.
 */
type TreeWalk = {
  incomplete: boolean;
  hiddenArchives: string[][];
  budget?: { remaining: number; truncated: boolean };
};

type TreeReadOptions = {
  showArchive?: boolean;
  /** Set for a linked folder, which may be a large project rather than a notebook. */
  budget?: { remaining: number; truncated: boolean };
  walk?: TreeWalk;
};

/** A folder or file that is no longer there is a race with Explorer or a sync client; anything else is one that cannot be read. */
function isAbsentError(error: unknown) {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

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
    name === INK_DIR ||
    (linked && SKIPPED_LINKED_FOLDER_ENTRIES.has(name))
  );
}

/**
 * A notebook's visible files (library paths), without the tree's upkeep: no
 * index, prune or reconcile, so a check can read a notebook without changing
 * it. The archive is left out unless `includeArchive`. `onHidden` sees each
 * entry the tree hides. `unreadable` lists the folders that could not be
 * listed (a folder that raced away is not one), so "exactly one file has this
 * name" can be told from "one that could be seen".
 */
export async function listVisibleNotebookFiles(notebook: string, { limit = 20_000, onHidden, includeArchive = false }: { limit?: number; onHidden?: (libraryPath: string, name: string) => void; includeArchive?: boolean } = {}) {
  const linked = getLinkedFolders().some((folder) => folder.name === notebook);
  const root = notebookPath(notebook);
  const files: string[] = [];
  const unreadable: string[] = [];
  let truncated = false;
  const walk = async (parts: string[]) => {
    let entries;
    try { entries = await readdir(path.join(root, ...parts), { withFileTypes: true }); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) unreadable.push([notebook, ...parts].join("/"));
      return;
    }
    for (const entry of entries) {
      if (!parts.length && entry.name === ARCHIVE_DIR && !includeArchive) continue;
      if (!isVisibleTreeEntry(entry.name, linked)) { onHidden?.([notebook, ...parts, entry.name].join("/"), entry.name); continue; }
      if (files.length >= limit) { truncated = true; return; }
      if (entry.isDirectory()) await walk([...parts, entry.name]);
      else if (entry.isFile() && getFileType(entry.name)) files.push([notebook, ...parts, entry.name].join("/"));
    }
  };
  await walk([]);
  return { files, truncated, unreadable };
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
    showFileDetails: viewOptions.showFileDetails,
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

/**
 * A folder's nodes. A child that races away between the listing and its
 * `stat`, or a subfolder that cannot be listed, is left out (or shown empty)
 * and noted in `options.walk` instead of failing the whole refresh. Only the
 * listing of `parentParts` itself throws: the caller decides what that means.
 */
async function readTreeDirectory(
  notebook: string,
  parentParts: string[],
  options: TreeReadOptions = {},
): Promise<LiberaTreeNode[]> {
  const directoryPath = itemPath(notebook, parentParts);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const children: LiberaTreeNode[] = [];
  const skipped = () => { if (options.walk) options.walk.incomplete = true; };

  for (const entry of entries) {
    if (shouldSkipTreeEntry(entry.name, options)) {
      if (entry.name === ARCHIVE_DIR && entry.isDirectory() && !options.showArchive) options.walk?.hiddenArchives.push([...parentParts, entry.name]);
      continue;
    }

    if (options.budget) {
      if (options.budget.remaining <= 0) {
        options.budget.truncated = true;
        skipped();
        break;
      }

      options.budget.remaining -= 1;
    }

    const childParts = [...parentParts, entry.name];

    if (entry.isDirectory()) {
      let stats: Stats;
      try { stats = await stat(itemPath(notebook, childParts)); }
      catch { skipped(); continue; }
      let grandChildren: LiberaTreeNode[] = [];
      try { grandChildren = await readTreeDirectory(notebook, childParts, options); }
      catch (error) {
        skipped();
        if (isAbsentError(error)) continue;
      }
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
      try { children.push(await getFileNode(notebook, childParts)); }
      catch { skipped(); }
    }
  }

  return children.sort(sortTreeNodes);
}

/** A notebook's top level, or nothing (and an incomplete walk) when it cannot be listed. */
async function readTreeRoot(notebook: string, options: TreeReadOptions) {
  try { return await readTreeDirectory(notebook, [], options); }
  catch {
    if (options.walk) options.walk.incomplete = true;
    return [];
  }
}

async function getLinkedFolderNode(
  folder: LinkedFolder,
  options: { showArchive: boolean; validGroupIds: Set<string> },
  walk?: TreeWalk,
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
  if (walk) walk.budget = budget;
  const children = folderStats
    ? await readTreeRoot(folder.name, { showArchive: options.showArchive, budget, walk })
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
    illustrationPath: metadata.illustrationPath,
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

/** How often a notebook's sidecar upkeep runs on reads that allow it to be skipped. */
export const TREE_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const maintenanceRanAt = new Map<string, number>();
let maintenanceClock = () => Date.now();

/** Tests: forget when upkeep last ran, and use the real clock again. */
export function resetTreeMaintenance() {
  maintenanceRanAt.clear();
  maintenanceClock = () => Date.now();
}

/** Tests: the time the upkeep interval is measured against. */
export function setTreeMaintenanceClock(now: () => number) {
  maintenanceClock = now;
}

// Routine refreshes (shared edits) must not prune and reconcile every notebook
// each time: that walks sidecar folders on disk for nothing.
function maintenanceDue(notebook: string, mode: "always" | "throttled") {
  if (mode === "always") return true;
  const now = maintenanceClock();
  const last = maintenanceRanAt.get(notebook);
  if (last !== undefined && now >= last && now - last < TREE_MAINTENANCE_INTERVAL_MS) return false;
  maintenanceRanAt.set(notebook, now);
  return true;
}

/**
 * Every file a moved file's side files could now be at, whatever the rail
 * shows: the tree's own files and the archive folders it hides. Null when the
 * walk did not see all of it (a folder that could not be read, a child that
 * raced away, the linked-folder cap): a match among part of the files cannot
 * be called unique.
 */
async function upkeepCandidates(notebook: string, children: LiberaTreeNode[], walk: TreeWalk) {
  const nodes = [...children];
  // The list grows while archives are read, which may hold archives of their own.
  for (let index = 0; index < walk.hiddenArchives.length; index += 1) {
    try { nodes.push(...await readTreeDirectory(notebook, walk.hiddenArchives[index], { showArchive: true, budget: walk.budget, walk })); }
    catch { walk.incomplete = true; }
  }
  return walk.incomplete ? null : nodes;
}

const maintainNotebookSidecars = (notebook: string, children: LiberaTreeNode[], walk: TreeWalk) => whenNotebookIdle(notebook, () => maintainSidecars(notebook, children, walk));

async function maintainSidecars(notebook: string, children: LiberaTreeNode[], walk: TreeWalk) {
  await prunePdfTextCaches(notebook).catch(() => undefined);
  await pruneAudioSidecars(notebook).catch(() => undefined);
  // Without the whole picture nothing is matched, set aside or expired: the
  // next refresh that sees every folder does it.
  const candidates = await upkeepCandidates(notebook, children, walk);
  if (!candidates) return;
  await reconcilePdfSidecars(notebook, pdfFilesOf(candidates)).catch(() => undefined);
  await reconcileInkFolders(notebook, inkSourceFilesOf(candidates)).catch(() => undefined);
}

/**
 * Sidecar upkeep runs on every read unless `maintenance` is "throttled", which
 * runs it at most once per notebook per TREE_MAINTENANCE_INTERVAL_MS.
 */
export async function getTree(options: { includeArchive?: boolean; maintenance?: "always" | "throttled" } = {}): Promise<LiberaTree> {
  const maintenance = options.maintenance ?? "always";
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
  let incomplete = false;

  for (const entry of entries) {
    // A linked folder's name wins over a notebook created on disk behind Libera's back.
    if (!entry.isDirectory() || entry.name.startsWith(".") || linkedFolderNames.has(entry.name)) {
      continue;
    }

    const currentNotebookPath = notebookPath(entry.name);
    let notebookStats: Stats;
    // A notebook removed since the listing is not one any more; the others still load.
    try { notebookStats = await stat(currentNotebookPath); }
    catch { incomplete = true; continue; }
    const metadata = await readNotebookMetadata(
      entry.name,
      notebookStats.birthtime.toISOString(),
    );
    const walk: TreeWalk = { incomplete: false, hiddenArchives: [] };
    const children = await readTreeRoot(entry.name, { showArchive, walk });
    // A migration that has not finished may have moved a file but not yet its
    // sidecars: they are not orphans, and pruning them would lose them.
    if (maintenanceDue(entry.name, maintenance) && !(await isNotebookMigrating(entry.name))) {
      await maintainNotebookSidecars(entry.name, children, walk);
    }
    if (walk.incomplete) incomplete = true;

    notebooks.push({
      kind: "notebook",
      name: entry.name,
      path: entry.name,
      createdAt: metadata.createdAt,
      color: metadata.color,
      emoji: metadata.emoji,
      illustration: metadata.illustration,
      illustrationPath: metadata.illustrationPath,
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
    const walk: TreeWalk = { incomplete: false, hiddenArchives: [] };
    const node = await getLinkedFolderNode(folder, { showArchive, validGroupIds }, walk);
    if (!node.folder?.missing) {
      if (maintenanceDue(folder.name, maintenance) && !(await isNotebookMigrating(folder.name))) {
        await maintainNotebookSidecars(folder.name, node.children, walk);
      }
    }
    if (walk.incomplete) incomplete = true;
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
    ...(incomplete ? { incomplete: true } : {}),
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

/**
 * One notebook's node, read without the library-wide upkeep `getTree` does
 * (pruning, reconciling, reattaching): a shared edit refreshes just the
 * notebook it touched. Links to files in other notebooks are not resolved here
 * (that needs every notebook's files); the caller keeps the earlier ones.
 * Null when there is no such notebook.
 */
export async function getNotebookNode(name: string, options: { includeArchive?: boolean } = {}): Promise<LiberaNotebookNode | null> {
  if (!name || name.startsWith(".") || /[\\/\0]/.test(name)) return null;
  await ensureAdminRoot();
  const workspaceMetadata = await readWorkspaceMetadata();
  const validGroupIds = new Set(workspaceMetadata.notebookGroups.map((group) => group.id));
  const showArchive = Boolean(options.includeArchive || workspaceMetadata.notebookViewOptions.showArchive);
  const linked = getLinkedFolders().find((folder) => folder.name === name);
  let node: LiberaNotebookNode;
  if (linked) {
    node = await getLinkedFolderNode(linked, { showArchive, validGroupIds });
  } else {
    let notebookStats: Stats;
    try {
      notebookStats = await stat(notebookPath(name));
    } catch {
      return null;
    }
    if (!notebookStats.isDirectory()) return null;
    const metadata = await readNotebookMetadata(name, notebookStats.birthtime.toISOString());
    const children = await readTreeRoot(name, { showArchive });
    node = {
      kind: "notebook",
      name,
      path: name,
      createdAt: metadata.createdAt,
      color: metadata.color,
      emoji: metadata.emoji,
      illustration: metadata.illustration,
      illustrationPath: metadata.illustrationPath,
      groupId: metadata.groupId && validGroupIds.has(metadata.groupId) ? metadata.groupId : null,
      updatedAt: latestIsoDate(notebookStats.mtime.toISOString(), ...latestTreeNodeUpdatedAt(children)),
      children,
    };
  }
  await populateRelatedNotebooks([node]);
  return node;
}

/**
 * Gives each file node the shared file id the host listed for its path. Only
 * where the listing agrees with the node: the tree is read from the working
 * copy, which cloud sync can leave behind the manifest, and a different size
 * means this path may still hold another file than the one the listing names.
 * Without a verifiable match the node carries no id and the host checks nothing.
 */
export function attachFileIds(
  nodes: LiberaTreeNode[],
  entries: readonly { path: string; fileId: string; kind: "doc" | "blob" | "folder"; size?: number }[],
) {
  const byPath = new Map(entries.filter((entry) => entry.kind !== "folder").map((entry) => [entry.path, entry]));
  const visit = (list: LiberaTreeNode[]) => {
    for (const node of list) {
      if (node.kind === "folder") { visit(node.children); continue; }
      const entry = byPath.get(node.path);
      if (entry && (entry.size === undefined || entry.size === node.size)) node.fileId = entry.fileId;
    }
  };
  visit(nodes);
}

export type LiberaFileMetadata = {
  node: LiberaFileNode;
  /** A Markdown note's link targets as written; the shown tree resolves them against its files. */
  linkDestinations?: string[];
};

/**
 * The file nodes for just these library paths, in the same shape the tree
 * gives them, with none of its walk or upkeep. An entry is null for a path
 * that is gone, hidden or not a supported file: the caller then reads the
 * whole tree.
 */
export async function getFileMetadata(paths: string[]): Promise<{ path: string; metadata: LiberaFileMetadata | null }[]> {
  return Promise.all(paths.map(async (libraryPath) => {
    try {
      const [notebook, ...parts] = libraryPath.split("/");
      if (!notebook || !parts.length || !isVisibleTreeFile(notebook, parts)) return { path: libraryPath, metadata: null };
      const node = await getFileNode(notebook, parts);
      if (node.fileType !== "markdown") return { path: libraryPath, metadata: { node } };
      const snapshot = await readTextSnapshot(filePathFromParts(notebook, parts));
      return { path: libraryPath, metadata: { node, linkDestinations: extractNotebookLinkDestinations(snapshot.content) } };
    } catch {
      return { path: libraryPath, metadata: null };
    }
  }));
}
