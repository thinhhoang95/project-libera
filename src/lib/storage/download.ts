import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { ARCHIVE_DIR, IGNORED_DOWNLOAD_ENTRIES } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { ensureAdminRoot, notebookPath, assertSafeSegment } from "@/lib/storage/paths";
import { listSharedAuthorityEntries, readSharedAuthorityEntry } from "@/lib/storage/shared-source";

function sanitizeZipName(name: string) {
  return (
    name
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "notebook"
  );
}

function shouldSkipDownloadEntry(name: string) {
  return name.startsWith("._") || IGNORED_DOWNLOAD_ENTRIES.has(name);
}

/**
 * What a shared notebook's manifest never lists: the local `_archive` and
 * hidden bookkeeping (.libera, the marker). Only these come from the disk of
 * a shared notebook; everything else is the manifest's, so a file the cloud has
 * not delivered is still exported and a deleted one still on disk is not.
 */
function isLocalOnly(relativePath: string) {
  const segments = relativePath.split("/");
  return segments[0] === ARCHIVE_DIR || segments.some((segment) => segment.startsWith("."));
}

async function addDirectoryToZip(zip: JSZip, rootPath: string, currentPath: string, include: (relativePath: string) => boolean) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldSkipDownloadEntry(entry.name)) {
      continue;
    }

    const entryPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, entryPath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      if (include(relativePath)) zip.folder(relativePath);
      await addDirectoryToZip(zip, rootPath, entryPath, include);
      continue;
    }

    if (entry.isFile() && include(relativePath)) {
      zip.file(relativePath, await readFile(entryPath));
    }
  }
}

/** A shared notebook: entries and bytes from the host's manifest, the disk only for what the manifest never holds. */
async function addSharedNotebookToZip(zip: JSZip, notebook: string, rootPath: string, entries: NonNullable<Awaited<ReturnType<typeof listSharedAuthorityEntries>>>) {
  const prefix = `${notebook}/`;
  for (const entry of entries) {
    const relativePath = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
    if (relativePath.split("/").some(shouldSkipDownloadEntry)) continue;
    if (entry.kind === "folder") {
      zip.folder(relativePath);
      continue;
    }
    const bytes = await readSharedAuthorityEntry(entry);
    // Left the manifest since the listing: it is gone, not a file to take from the disk.
    if (bytes) zip.file(relativePath, bytes);
  }
  await addDirectoryToZip(zip, rootPath, rootPath, isLocalOnly);
}

export async function createNotebookZip(name: string) {
  await ensureAdminRoot();
  const safeName = assertSafeSegment(name, "Notebook name");
  const targetPath = notebookPath(safeName);
  const stats = await stat(targetPath);

  if (!stats.isDirectory()) {
    throw new StorageError("Notebook was not found.", 404);
  }

  const zip = new JSZip();
  const rootFolderName = sanitizeZipName(safeName);
  const rootFolder = zip.folder(rootFolderName);

  if (!rootFolder) {
    throw new StorageError("Could not prepare notebook download.", 500);
  }

  const shared = await listSharedAuthorityEntries(safeName);
  if (shared) await addSharedNotebookToZip(rootFolder, safeName, targetPath, shared);
  else await addDirectoryToZip(rootFolder, targetPath, targetPath, () => true);

  return {
    fileName: `${rootFolderName}.zip`,
    body: await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: {
        level: 6,
      },
    }),
  };
}
