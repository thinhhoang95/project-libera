import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { copyFileIntoSharedDirectory, createSharedMarkdownFile, deleteSharedFile, moveSharedFile } from "@/lib/collab/shared-writes";
import { StorageError } from "@/lib/storage/errors";
import { assertSafeSegment, splitFilePath } from "@/lib/storage/paths";
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
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const filePath = request.nextUrl.searchParams.get("path") ?? "";
    return NextResponse.json(await readLiberaFile(filePath, { requireContent: true }));
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
      destinationNotebook?: string;
      destinationName?: string;
      destinationDirectory?: string;
      copy?: boolean;
      archive?: boolean;
    };

    if (body.archive) {
      if (isSharedNotebookPath(body.path ?? "")) throw new StorageError("The archive is local-only. To remove a file from a shared notebook, use Delete; collaboration keeps a local recovery copy.", 409);
      return NextResponse.json(await archiveFile(body.path ?? ""));
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
        return NextResponse.json(await moveSharedFile(body.path ?? "", body.destinationDirectory, body.destinationName));
      }
      if (isSharedNotebookPath(body.destinationDirectory)) throw new StorageError("Moving files between shared and other notebooks is not supported. Use Copy to create a separate file in the destination notebook.", 409);
      return NextResponse.json(
        await moveFileToDirectory(
          body.path ?? "",
          body.destinationDirectory,
          body.destinationName,
        ),
      );
    }

    if (body.destinationNotebook || body.destinationName) {
      if (isSharedNotebookPath(body.path ?? "")) {
        const current = splitFilePath(body.path ?? "");
        const notebook = body.destinationNotebook ? assertSafeSegment(body.destinationNotebook, "Notebook name") : current.notebook;
        const parent = notebook === current.notebook ? current.pathParts.slice(0, -1) : [];
        return NextResponse.json(await moveSharedFile(body.path ?? "", [notebook, ...parent].join("/"), body.destinationName));
      }
      if (isSharedNotebookPath(body.destinationNotebook ?? "")) throw new StorageError("Moving files between shared and other notebooks is not supported. Use Copy to create a separate file in the destination notebook.", 409);
      return NextResponse.json(
        await moveFile(
          body.path ?? "",
          body.destinationNotebook ?? "",
          body.destinationName ?? "",
        ),
      );
    }

    return NextResponse.json(await updateMarkdownFile(body.path ?? "", body.content ?? ""));
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
    const remove = isSharedNotebookPath(filePath) ? deleteSharedFile : deleteFile;
    return NextResponse.json(await remove(filePath));
  } catch (error) {
    return handleError(error);
  }
}
