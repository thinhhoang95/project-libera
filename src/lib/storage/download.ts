import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { IGNORED_DOWNLOAD_ENTRIES } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { ensureAdminRoot, notebookPath, assertSafeSegment } from "@/lib/storage/paths";

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

async function addDirectoryToZip(zip: JSZip, rootPath: string, currentPath: string) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (shouldSkipDownloadEntry(entry.name)) {
      continue;
    }

    const entryPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootPath, entryPath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      zip.folder(relativePath);
      await addDirectoryToZip(zip, rootPath, entryPath);
      continue;
    }

    if (entry.isFile()) {
      zip.file(relativePath, await readFile(entryPath));
    }
  }
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

  await addDirectoryToZip(rootFolder, targetPath, targetPath);

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
