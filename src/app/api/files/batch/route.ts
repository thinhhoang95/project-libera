import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { deleteSharedFile, moveSharedFile } from "@/lib/collab/shared-writes";
import { StorageError } from "@/lib/storage/errors";
import {
  BatchRefusedError,
  deleteFiles,
  moveFilesToDirectory,
  preflightSharedMove,
  sameNotebook,
  type BatchItem,
} from "@/lib/storage/batch-files";
import { splitDirectoryPath, splitFilePath } from "@/lib/storage/paths";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Several files of one notebook moved or deleted in one request.
 *
 *   { action: "move", items: [{ path, fileId? }], destinationDirectory }
 *     200 { moved: [{ from, to, payload }], failed: { path, error } | null, notMoved: string[], unchanged: string[] }
 *     409 { error, problems: [{ path, message }] }: refused before anything moved
 *   { action: "delete", items: [{ path, fileId? }] }
 *     200 { deleted: string[], failed: [{ path, error }] }
 *
 * Each file goes through the single operation (so every record follows it); see storage/batch-files.ts.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = (await request.json()) as { action?: string; items?: { path?: unknown; fileId?: unknown }[]; destinationDirectory?: string };
    const items: BatchItem[] = (Array.isArray(body.items) ? body.items : []).map((item) => ({
      path: typeof item.path === "string" ? item.path : "",
      fileId: typeof item.fileId === "string" && item.fileId ? item.fileId : undefined,
    }));
    if (!items.length) throw new StorageError("Choose at least one file.", 400);
    // Parsed up front: a malformed path is the caller's error, before anything is touched.
    for (const item of items) splitFilePath(item.path);
    if (!sameNotebook(items.map((item) => item.path))) throw new StorageError("A batch is files of one notebook.", 400);
    const shared = isSharedNotebookPath(items[0].path);

    if (body.action === "delete") {
      return NextResponse.json(await deleteFiles(items, shared ? { remove: (item) => deleteSharedFile(item.path, { expectedFileId: item.fileId }) } : {}));
    }

    if (body.action === "move") {
      const destinationDirectory = body.destinationDirectory ?? "";
      const destination = splitDirectoryPath(destinationDirectory).notebook;
      if (destination !== splitFilePath(items[0].path).notebook) {
        throw new StorageError("Moving files to another notebook goes through the notebook migration, which carries their records and references. Use Move to notebook instead.", 409);
      }
      if (shared) {
        return NextResponse.json(await moveFilesToDirectory(items, destinationDirectory, {
          preflight: preflightSharedMove,
          move: (item, directory) => moveSharedFile(item.path, directory, undefined, { expectedFileId: item.fileId }),
        }));
      }
      return NextResponse.json(await moveFilesToDirectory(items, destinationDirectory));
    }

    throw new StorageError("Unknown batch action.", 400);
  } catch (error) {
    const storageError = toStorageError(error);
    const problems = error instanceof BatchRefusedError ? { problems: error.problems } : {};
    return NextResponse.json({ error: storageError.message, ...problems }, { status: storageError.status });
  }
}
