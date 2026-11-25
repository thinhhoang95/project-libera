import { moveReviewPath, deleteReviewPath } from "./markdown-reviews";
import { discardReviewsUnder, transformReviewBaselines } from "@/lib/agent/review-store";
import { readFile } from "node:fs/promises";
import { markdownImageSources, rewriteMarkdownImageSources } from "@/lib/markdown-image-sources";
import { libraryNotebookNames } from "@/lib/storage/library-links";
import { readMarkdownAssetDocuments } from "@/lib/storage/markdown-assets";
import { stopBibTether } from "@/lib/references/bib-tether";
import { dropBibMirror } from "@/lib/references/bib-mirror";
import { followMovedLinks } from "@/lib/storage/move-links";
import { dropPathKeyedStores, followPathKeyedStores } from "@/lib/storage/path-keyed-stores";
import { withNotebookOperation } from "@/lib/storage/migration-fence";
import type { LiberaLinkRewrites, LiberaMoveStep } from "@/lib/types";
import { detachReferenceAttachments, moveReferenceAttachments } from "./references";
import { randomInt } from "node:crypto";
import { NOTEBOOK_ILLUSTRATION_IDS } from "@/lib/notebook-illustrations";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { isNotebookMigrating } from "@/lib/storage/migration-fence";
import { withMovedReviewsUnder } from "@/lib/agent/review-store";
import { StorageError } from "@/lib/storage/errors";
import { pathExists, replaceFileIfUnchanged, withPathLocks } from "@/lib/storage/fs-utils";
import { foldedFileName } from "@/lib/storage/file-names";
import {
  normalizeNotebookMetadata,
  readNotebookMetadata,
  writeNotebookMetadata,
} from "@/lib/storage/notebook-metadata";
import { renameLinkedFolder } from "@/lib/storage/directory-mode";
import {
  assertSafeSegment,
  ensureAdminRoot,
  filePathFromParts,
  splitFilePath,
  getLinkedFolder,
  getLinkedFolders,
  notebookPath,
} from "@/lib/storage/paths";
import { getTree, LINKED_FOLDER_METADATA_DEFAULTS } from "@/lib/storage/tree";
import {
  removeNotebookPanelExpandedPathPrefix,
  removeFileMetadataPathPrefix,
  renameNotebookPanelExpandedPathPrefix,
  renameFileMetadataPathPrefix,
  updateWorkspaceMetadata,
} from "@/lib/storage/workspace-metadata";
import type { LiberaNotebookMetadata, LiberaTree } from "@/lib/types";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { remapLastNotebookName } from "@/lib/storage/last-notebook";
import { assertNotSharedItem, SharedDocumentError, sharedNotebookMarker } from "@/lib/collab/shared-notebook";

/** Whether two paths are the same directory on disk (a case-insensitive disk answers for both spellings of a name). */
async function isSameDirectory(first: string, second: string) {
  try {
    const [a, b] = await Promise.all([stat(first), stat(second)]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

/** An unfinished migration holds a notebook (as source or destination): it can't be renamed or deleted until it ends. */
async function assertNotebookNotMigrating(name: string, action: string) {
  if (await isNotebookMigrating(name)) {
    throw new StorageError(`${name} is part of a notebook migration that has not finished, so it can't be ${action} yet. Finish or stop the migration first.`, 409);
  }
}

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

/**
 * Renames a notebook (or changes its color, emoji or group). Under the locks of both folders and, for a real
 * rename, as an operation on both names, so a migration, Try to fix or another rename can't run in between.
 * Then the links and image addresses other notes hold into it follow (move-links.ts); the tree comes back
 * with what they did, as a folder rename's does.
 */
export async function renameNotebook(
  currentName: string,
  nextName: string,
  metadataInput?: Partial<LiberaNotebookMetadata>,
): Promise<LiberaTree & { links?: LiberaLinkRewrites; unfinished?: LiberaMoveStep[] }> {
  await ensureAdminRoot();
  const safeCurrentName = assertSafeSegment(currentName, "Notebook name");
  const safeNextName = assertSafeSegment(nextName, "Notebook name");
  const locked = () => withPathLocks([notebookPath(safeCurrentName), notebookPath(safeNextName)], () => renameNotebookLocked(safeCurrentName, safeNextName, metadataInput));
  if (safeCurrentName !== safeNextName) await withNotebookOperation(safeCurrentName, () => withNotebookOperation(safeNextName, locked));
  else await locked();
  if (safeCurrentName === safeNextName) return getTree();
  const moved = await followMovedLinks([{ from: safeCurrentName, to: safeNextName, folder: true }]);
  const { links } = moved;
  // `/api/markdown-assets/raw?document=Old/...` names a note by its library path: it follows the rename too.
  const addressFailure = await followAssetAddresses(safeCurrentName, safeNextName);
  const unfinished = addressFailure
    ? { step: "links" as const, status: "failed" as const, message: [moved.unfinished?.message, addressFailure].filter(Boolean).join("; ") }
    : moved.unfinished;
  return {
    ...await getTree(),
    ...(links.rewritten.length || links.skipped.length || links.unchecked.length ? { links } : {}),
    ...(unfinished ? { unfinished: [unfinished] } : {}),
  };
}

const assetDocumentWithin = (document: string, folder: string) => document === folder || document.startsWith(`${folder}/`);

/** A note's text with the markdown-asset addresses that name a note under `from` made to name it under `to`. */
function rewriteAssetAddresses(text: string, from: string, to: string) {
  if (!text.includes("markdown-assets/raw")) return text;
  const sources: Record<string, string> = {};
  for (const source of markdownImageSources(text)) {
    if (!source.startsWith("/api/markdown-assets/raw")) continue;
    const next = source.replace(/([?&]document=)([^&#]*)/, (whole, head: string, value: string) => {
      let document: string;
      try { document = decodeURIComponent(value); } catch { return whole; }
      return assetDocumentWithin(document, from) ? `${head}${encodeURIComponent(`${to}${document.slice(from.length)}`)}` : whole;
    });
    if (next !== source) sources[source] = next;
  }
  return rewriteMarkdownImageSources(text, sources);
}

/**
 * After a notebook rename: every note (of every local notebook, the renamed one included) that shows an
 * image by `/api/markdown-assets/raw?document=<note of the renamed notebook>` gets the new name, under the
 * note's own lock and only over the text just read. Returns what failed, or null.
 */
async function followAssetAddresses(from: string, to: string): Promise<string | null> {
  const changed: string[] = [];
  const failures: string[] = [];
  for (const notebook of await libraryNotebookNames()) {
    let documents;
    try { ({ documents } = await readMarkdownAssetDocuments(notebook)); } catch (error) { failures.push(`${notebook}: ${error instanceof Error ? error.message : String(error)}`); continue; }
    for (const document of documents) {
      if (!document.content.includes(`document=${encodeURIComponent(from)}`)) continue;
      if (rewriteAssetAddresses(document.content, from, to) === document.content) continue;
      const { notebook: owner, pathParts } = splitFilePath(document.documentPath);
      const target = filePathFromParts(owner, pathParts);
      try {
        await withPathLocks([target], async () => {
          const bytes = await readFile(target);
          const text = bytes.toString("utf8");
          const next = rewriteAssetAddresses(text, from, to);
          if (next === text || !Buffer.from(text, "utf8").equals(bytes)) return;
          await replaceFileIfUnchanged(target, Buffer.from(next, "utf8"), bytes, { gone: "The note is no longer there.", changed: "The note changed while its images were being updated." });
          changed.push(document.documentPath);
        });
      } catch (error) { failures.push(`${document.documentPath}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  if (changed.length) {
    await transformReviewBaselines(new Map(changed.map((changedPath) => [changedPath, (text: string) => rewriteAssetAddresses(text, from, to)]))).catch((error) => failures.push(`pending reviews: ${error instanceof Error ? error.message : String(error)}`));
    notifySearchChanges(changed);
  }
  return failures.length ? `Image addresses did not follow: ${failures.join("; ")}` : null;
}

async function renameNotebookLocked(
  safeCurrentName: string,
  safeNextName: string,
  metadataInput?: Partial<LiberaNotebookMetadata>,
) {
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

  if (safeCurrentName !== safeNextName) {
    await assertNotebookNotMigrating(safeCurrentName, "renamed");
    await assertNotebookNotMigrating(safeNextName, "renamed to");
  }

  if (linkedFolder) {
    // Only the folder's name in Libera changes; the folder on disk keeps its name.
    await withMovedReviewsUnder(safeCurrentName, safeNextName, async () => renameLinkedFolder(safeCurrentName, safeNextName));
  } else {
    const nextPath = notebookPath(safeNextName);

    if (currentPath !== nextPath) {
      // On a case-insensitive disk the new spelling finds the notebook itself: that is a rename, not a clash.
      const caseOnly = foldedFileName(safeCurrentName) === foldedFileName(safeNextName) && await isSameDirectory(currentPath, nextPath);
      if (!caseOnly && (await pathExists(nextPath))) {
        throw new StorageError("Destination notebook already exists.", 409);
      }
      await withMovedReviewsUnder(safeCurrentName, safeNextName, () => rename(currentPath, nextPath));
    }
  }

  await writeNotebookMetadata(
    safeNextName,
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
  await followNotebookRootRename(safeCurrentName, safeNextName);
}

/**
 * The library-level records that name a notebook folder, moved to its new name: view options, panel
 * expansion, review keys, agent run history, reference attachments, stars and tags, the last notebook.
 * Also what a shared notebook's records need when the host rebinds it to a renamed folder
 * (root-transitions.ts); every step is idempotent.
 */
export async function followNotebookRootRename(currentName: string, nextName: string) {
  await renameNotebookViewOption(currentName, nextName);
  await renameNotebookPanelExpandedPathPrefix(currentName, nextName);
  // An empty review already at a destination key (a notebook of this name was deleted, or a file opened there) gives way to the moved one.
  await moveReviewPath(currentName, nextName, { replaceEmpty: true });
  // Undo history of agent runs names files by notebook too (pending reviews moved with the folder above).
  if (currentName !== nextName) {
    const { recordMovedRunFolder } = await import("@/lib/agent/snapshots");
    await recordMovedRunFolder(currentName, nextName);
  }
  // The notebook's own library moves with its folder; pointers into it are renamed here.
  await moveReferenceAttachments(currentName, nextName);
  await renameFileMetadataPathPrefix(currentName, nextName);
  // Saved chats that quote the notebook's files.
  if (currentName !== nextName) await followPathKeyedStores([{ from: currentName, to: nextName, folder: true }]);
  await remapLastNotebookName(currentName, nextName);
  if (currentName !== nextName) notifySearchChanges();
}

/** `byMigration`: the migration that made this notebook removes it again while undoing itself, so its own journal does not hold it. */
export async function deleteNotebook(name: string, { byMigration = false } = {}) {
  if (getLinkedFolder(assertSafeSegment(name, "Notebook name"))) {
    // Never delete a user's own folder from disk through the notebook action.
    throw new StorageError("Remove the folder from Libera instead. Its files stay on disk.", 409);
  }

  // A shared notebook is removed by leaving the project first. Once access is
  // revoked the folder is only a local copy, which the user may delete.
  const marker = sharedNotebookMarker(assertSafeSegment(name, "Notebook name"));
  if (marker && !marker.revoked) throw new SharedDocumentError(name);

  if (!byMigration) await assertNotebookNotMigrating(name, "deleted");
  await ensureAdminRoot();
  // Nothing may keep working on the folder that is about to go: its .bib watchers and pending mirror write stop first.
  stopBibTether(name);
  dropBibMirror(name);
  await rm(notebookPath(name), { recursive: true });
  await removeNotebookViewOption(name);
  await removeNotebookPanelExpandedPathPrefix(name);
  await deleteReviewPath(name);
  // Pending agent reviews of its files would block a later notebook of the same name.
  await discardReviewsUnder(name);
  await dropPathKeyedStores([name]);
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

  // Through the settings queue, so a star or a move's rekey saved at the same time is not erased.
  await updateWorkspaceMetadata((workspaceMetadata) => {
    if (!workspaceMetadata.notebookViewOptions.hiddenNotebookNames.includes(currentName)) return null;
    return {
      ...workspaceMetadata,
      notebookViewOptions: {
        ...workspaceMetadata.notebookViewOptions,
        hiddenNotebookNames: workspaceMetadata.notebookViewOptions.hiddenNotebookNames.map(
          (notebookName) => (notebookName === currentName ? nextName : notebookName),
        ),
      },
    };
  });
}

async function removeNotebookViewOption(name: string) {
  await updateWorkspaceMetadata((workspaceMetadata) => {
    if (!workspaceMetadata.notebookViewOptions.hiddenNotebookNames.includes(name)) return null;
    return {
      ...workspaceMetadata,
      notebookViewOptions: {
        ...workspaceMetadata.notebookViewOptions,
        hiddenNotebookNames: workspaceMetadata.notebookViewOptions.hiddenNotebookNames.filter(
          (notebookName) => notebookName !== name,
        ),
      },
    };
  });
}
