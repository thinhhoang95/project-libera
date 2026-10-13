import { stat } from "node:fs/promises";
import { StorageError } from "@/lib/storage/errors";
import { assertSupportedFileName } from "@/lib/storage/file-types";
import {
  ensureAdminRoot,
  filePathFromParts,
  relativeFilePath,
  splitFilePath,
} from "@/lib/storage/paths";
import { getTree } from "@/lib/storage/tree";
import { setFileTagsForPath } from "@/lib/storage/workspace-metadata";

export async function updateFileTags(relativePath: string, tags: unknown) {
  await ensureAdminRoot();

  if (!Array.isArray(tags)) {
    throw new StorageError("Tags must be a list.", 400);
  }

  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertSupportedFileName(name);

  const targetStats = await stat(filePathFromParts(notebook, pathParts)).catch(() => null);

  if (!targetStats?.isFile()) {
    throw new StorageError("File was not found.", 404);
  }

  await setFileTagsForPath(relativeFilePath(notebook, pathParts), tags);

  return getTree();
}
