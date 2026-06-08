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
import { setStarredFilePath } from "@/lib/storage/workspace-metadata";

export async function updateStarredFile(relativePath: string, starred: boolean) {
  await ensureAdminRoot();

  const { notebook, name, pathParts } = splitFilePath(relativePath);
  assertSupportedFileName(name);

  const targetStats = await stat(filePathFromParts(notebook, pathParts)).catch(() => null);

  if (!targetStats?.isFile()) {
    throw new StorageError("File was not found.", 404);
  }

  await setStarredFilePath(relativeFilePath(notebook, pathParts), starred);

  return getTree();
}
