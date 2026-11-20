import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { copyFileIntoSharedDirectory, createSharedMarkdownFile, deleteSharedFile, listSharedEntries, moveSharedFile, saveSharedFileText } from "@/lib/collab/shared-writes";
import { attachSharedFileIdTo, resolveSharedActionFileId, sharedPathOfFileId } from "@/lib/collab/tree-file-ids";
import { isSharedOperationUnfinished } from "@/lib/collab/shared-outcomes";
import { StorageError } from "@/lib/storage/errors";
import { assertSafeSegment, splitDirectoryPath, splitFilePath } from "@/lib/storage/paths";
import { assertLocalFileIdentity, MoveCommittedError } from "@/lib/storage/files";
import {
  archiveFile,
  copyFileToDirectory,
  createMarkdownFile,
  deleteFile,
  moveFileToDirectory,
  moveFile,
  readLiberaFile,
  toStorageError,
  updateMarkdownFile,
} from "@/lib/storage";

export const runtime = "nodejs";

function handleError(error: unknown) {
  // The host committed a shared change but a step after it did not finish: say what it did, so the caller retargets and reports what stayed behind.
  if (isSharedOperationUnfinished(error)) {
    return NextResponse.json({ error: error.message, committed: error.committed, unfinished: error.unfinished }, { status: error.status });
  }
  const storageError = toStorageError(error);
  // A move that happened but whose result could not be built: say where the file is, so the caller can still retarget.
  const committed = storageError instanceof MoveCommittedError ? { moved: storageError.moved, unfinished: storageError.unfinished, ...(storageError.links ? { links: storageError.links } : {}) } : {};
  return NextResponse.json({ error: storageError.message, ...committed }, { status: storageError.status });
}

/**
 * The move from one notebook to another is the migration's (reviewed, crash
 * safe, with the references it needs); the direct move stays inside a notebook.
 */
function assertSameNotebook(path: string, destinationNotebook: string) {
  // An empty notebook is moveFile's own error to give.
  if (!destinationNotebook || splitFilePath(path).notebook === destinationNotebook) return;
  throw new StorageError("Moving a file to another notebook goes through the notebook migration, which carries its records and references. Use Move to notebook instead.", 409);
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    let filePath = request.nextUrl.searchParams.get("path") ?? "";
    // A shared file by identity: where the manifest lists it now (a moved file whose path changed again).
    const fileId = request.nextUrl.searchParams.get("fileId");
    const notebook = request.nextUrl.searchParams.get("notebook");
    if (fileId && notebook) {
      if (!isSharedNotebookPath(`${notebook}/.`)) throw new StorageError("Files are looked up by id only in shared notebooks.", 400);
      const found = await sharedPathOfFileId(notebook, fileId, listSharedEntries);
      if (!found) throw new StorageError("That file is no longer in the shared notebook.", 410);
      filePath = found;
    }
    const payload = await readLiberaFile(filePath, { requireContent: true });
    // A shared file's id is set only when the bytes this read returned are verified to be that manifest entry (no second read).
    if (isSharedNotebookPath(filePath)) await attachSharedFileIdTo(payload.file, payload.content, listSharedEntries);
    return NextResponse.json(payload);
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      notebook?: string;
      name?: string;
      content?: string;
      parentPath?: string;
    };

    const create = isSharedNotebookPath(body.parentPath || body.notebook || "")
      ? createSharedMarkdownFile
      : createMarkdownFile;
    return NextResponse.json(
      await create(
        body.notebook ?? "",
        body.name ?? "",
        body.content ?? "",
        body.parentPath,
      ),
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      path?: string;
      content?: string;
      /** The textVersion of the text the editor opened; a save is refused (409) when the file is another. */
      baseVersion?: string;
      destinationNotebook?: string;
      destinationName?: string;
      destinationDirectory?: string;
      copy?: boolean;
      archive?: boolean;
      /**
       * The file the caller saw at `path`; an action on another file there is refused. For a
       * shared notebook the host's file id; for a local one localFileIdentity of the tree node.
       */
      fileId?: string;
    };
    const expectedFileId = typeof body.fileId === "string" && body.fileId ? body.fileId : undefined;

    if (body.archive) {
      if (isSharedNotebookPath(body.path ?? "")) throw new StorageError("The archive is local-only. To remove a file from a shared notebook, use Delete; collaboration keeps a local recovery copy.", 409);
      return NextResponse.json(await archiveFile(body.path ?? "", { expectedFileId }));
    }

    if (body.copy && body.destinationDirectory) {
      const copy = isSharedNotebookPath(body.destinationDirectory) ? copyFileIntoSharedDirectory : copyFileToDirectory;
      return NextResponse.json(
        await copy(
          body.path ?? "",
          body.destinationDirectory,
          body.destinationName,
        ),
      );
    }

    if (body.destinationDirectory) {
      if (isSharedNotebookPath(body.path ?? "")) {
        // A shared file's action needs its identity: the row's, or one resolved here for this file alone.
        const sharedId = await resolveSharedActionFileId(body.path ?? "", expectedFileId, "moved", listSharedEntries);
        return NextResponse.json(await moveSharedFile(body.path ?? "", body.destinationDirectory, body.destinationName, { expectedFileId: sharedId }));
      }
      if (isSharedNotebookPath(body.destinationDirectory)) throw new StorageError("Moving files between shared and other notebooks is not supported. Use Copy to create a separate file in the destination notebook.", 409);
      assertSameNotebook(body.path ?? "", splitDirectoryPath(body.destinationDirectory).notebook);
      return NextResponse.json(
        await moveFileToDirectory(
          body.path ?? "",
          body.destinationDirectory,
          body.destinationName,
          { expectedFileId },
        ),
      );
    }

    if (body.destinationNotebook || body.destinationName) {
      if (isSharedNotebookPath(body.path ?? "")) {
        const sharedId = await resolveSharedActionFileId(body.path ?? "", expectedFileId, "renamed", listSharedEntries);
        const current = splitFilePath(body.path ?? "");
        const notebook = body.destinationNotebook ? assertSafeSegment(body.destinationNotebook, "Notebook name") : current.notebook;
        const parent = notebook === current.notebook ? current.pathParts.slice(0, -1) : [];
        return NextResponse.json(await moveSharedFile(body.path ?? "", [notebook, ...parent].join("/"), body.destinationName, { expectedFileId: sharedId }));
      }
      if (isSharedNotebookPath(body.destinationNotebook ?? "")) throw new StorageError("Moving files between shared and other notebooks is not supported. Use Copy to create a separate file in the destination notebook.", 409);
      assertSameNotebook(body.path ?? "", body.destinationNotebook ?? "");
      return NextResponse.json(
        await moveFile(
          body.path ?? "",
          body.destinationNotebook ?? "",
          body.destinationName ?? "",
          { expectedFileId },
        ),
      );
    }

    // A shared notebook's text documents are saved through the shared document;
    // only a text file it holds as a file arrives here, and is replaced whole.
    if (isSharedNotebookPath(body.path ?? "")) return NextResponse.json(await saveSharedFileText(body.path ?? "", body.content ?? ""));
    return NextResponse.json(await updateMarkdownFile(body.path ?? "", body.content ?? "", typeof body.baseVersion === "string" ? body.baseVersion : undefined));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const filePath = request.nextUrl.searchParams.get("path") ?? "";
    const fileId = request.nextUrl.searchParams.get("fileId") || undefined;
    if (isSharedNotebookPath(filePath)) {
      const sharedId = await resolveSharedActionFileId(filePath, fileId, "deleted", listSharedEntries);
      return NextResponse.json(await deleteSharedFile(filePath, { expectedFileId: sharedId }));
    }
    // A local file: the one the person chose, not another that took its path (deleteFile's own records are not touched here).
    if (fileId) await assertLocalFileIdentity(filePath, fileId);
    return NextResponse.json(await deleteFile(filePath));
  } catch (error) {
    return handleError(error);
  }
}
