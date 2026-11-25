import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { isSharedNotebookPath, sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { deleteSharedFile, listSharedEntries, moveSharedFile } from "@/lib/collab/shared-writes";
import { resolveSharedActionFileId } from "@/lib/collab/tree-file-ids";
import { StorageError } from "@/lib/storage/errors";
import {
  assertOneStorageDomain,
  BatchRefusedError,
  deleteFiles,
  moveFilesToDirectory,
  normalizeBatchPath,
  preflightSharedMove,
  sameNotebook,
  type BatchDomain,
  type BatchItem,
} from "@/lib/storage/batch-files";
import { splitDirectoryPath, splitFilePath } from "@/lib/storage/paths";
import { followSharedMovedLinks } from "@/lib/storage/shared-move-links";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Several files of one notebook moved or deleted in one request.
 *
 *   { action: "move", items: [{ path, fileId? }], destinationDirectory }
 *     200 { moved: [{ from, to, payload, unfinished? }], failed: { path, error } | null, notMoved: string[], unchanged: string[] }
 *     409 { error, problems: [{ path, message }] }: refused before anything moved
 *   { action: "delete", items: [{ path, fileId? }] }
 *     200 { deleted: string[], failed: [{ path, error }], unfinished?: [{ path, steps }] }
 *
 * Each file goes through the single operation (so every record follows it); see storage/batch-files.ts.
 * Every item is classified first (local notebook, shared notebook, or a shared notebook's local-only
 * archive) and a selection that mixes storages is refused whole.
 */

/** Which storage handles the path; `_archive` of a shared notebook is local-only recovery storage. */
function domainOf(liberaPath: string): BatchDomain {
  if (isSharedNotebookPath(liberaPath)) return "shared";
  return sharedNotebookMarker(liberaPath.split("/")[0] ?? "") ? "archive" : "local";
}
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = (await request.json()) as { action?: string; items?: { path?: unknown; fileId?: unknown }[]; destinationDirectory?: string };
    const items: BatchItem[] = (Array.isArray(body.items) ? body.items : []).map((item) => ({
      // One spelling per path (duplicate or leading slashes dropped) before anything is classified by it.
      path: typeof item.path === "string" ? normalizeBatchPath(item.path) : "",
      fileId: typeof item.fileId === "string" && item.fileId ? item.fileId : undefined,
    }));
    if (!items.length) throw new StorageError("Choose at least one file.", 400);
    // Parsed up front: a malformed path is the caller's error, before anything is touched.
    for (const item of items) splitFilePath(item.path);
    if (!sameNotebook(items.map((item) => item.path))) throw new StorageError("A batch is files of one notebook.", 400);
    const destinationDirectory = normalizeBatchPath(body.destinationDirectory ?? "");
    const move = body.action === "move";
    if (body.action === "delete") assertOneStorageDomain(items, null, domainOf);
    const shared = domainOf(items[0].path) === "shared";

    if (body.action === "delete") {
      // Each delete returns as soon as its own cleanup is done: no tree read and no wait per file (the host's tree event
      // and the app's one refresh after the batch show the result).
      return NextResponse.json(await deleteFiles(items, shared ? {
        // The id is resolved for the one file acted on, as the single-file route does: a row without one (an unverified binary) has its disk copy checked against the manifest entry first.
        remove: async (item) => deleteSharedFile(item.path, { expectedFileId: await resolveSharedActionFileId(item.path, item.fileId, "deleted", listSharedEntries), deferRefresh: true }),
      } : {}));
    }

    if (move) {
      const destination = splitDirectoryPath(destinationDirectory).notebook;
      if (destination !== splitFilePath(items[0].path).notebook) {
        throw new StorageError("Moving files to another notebook goes through the notebook migration, which carries their records and references. Use Move to notebook instead.", 409);
      }
      assertOneStorageDomain(items, destinationDirectory, domainOf);
      if (shared) {
        return NextResponse.json(await moveFilesToDirectory(items, destinationDirectory, {
          preflight: (batch, directory) => preflightSharedMove(batch, directory, () => listSharedEntries(destination)),
          // Links follow once after the last file (the shared notes through the host), not once per file.
          move: async (item, directory) => moveSharedFile(item.path, directory, undefined, { expectedFileId: await resolveSharedActionFileId(item.path, item.fileId, "moved", listSharedEntries), deferLinks: true }),
          followLinks: async (moves) => {
            const followed = await followSharedMovedLinks(moves);
            return { links: followed.links, ...(followed.unfinished.length ? { unfinished: { step: "links" as const, status: "failed" as const, message: followed.unfinished.join("; ") } } : {}) };
          },
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
