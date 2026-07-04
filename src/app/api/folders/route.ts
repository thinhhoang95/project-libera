import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
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

    return NextResponse.json(await createFolder(body.parentPath ?? "", body.name ?? ""));
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
      return NextResponse.json(await archiveFolder(body.path ?? ""));
    }

    return NextResponse.json(await renameFolder(body.path ?? "", body.name ?? ""));
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
    return NextResponse.json(await deleteFolder(folderPath));
  } catch (error) {
    return handleError(error);
  }
}
