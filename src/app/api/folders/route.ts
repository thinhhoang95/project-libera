import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { createSharedFolder, deleteSharedFolder, renameSharedFolder } from "@/lib/collab/shared-writes";
import { StorageError } from "@/lib/storage/errors";
import {
  archiveFolder,
  createFolder,
  deleteFolder,
  renameFolder,
  toStorageError,
} from "@/lib/storage";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      parentPath?: string;
      name?: string;
    };

    const create = isSharedNotebookPath(body.parentPath ?? "") ? createSharedFolder : createFolder;
    return NextResponse.json(await create(body.parentPath ?? "", body.name ?? ""));
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
      archive?: boolean;
      path?: string;
      name?: string;
    };

    if (body.archive) {
      if (isSharedNotebookPath(body.path ?? "")) throw new StorageError("The archive is local-only. To remove a folder from a shared notebook, use Delete; collaboration keeps local recovery copies of its files.", 409);
      return NextResponse.json(await archiveFolder(body.path ?? ""));
    }

    const rename = isSharedNotebookPath(body.path ?? "") ? renameSharedFolder : renameFolder;
    return NextResponse.json(await rename(body.path ?? "", body.name ?? ""));
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
    const folderPath = request.nextUrl.searchParams.get("path") ?? "";
    const remove = isSharedNotebookPath(folderPath) ? deleteSharedFolder : deleteFolder;
    return NextResponse.json(await remove(folderPath));
  } catch (error) {
    return handleError(error);
  }
}
