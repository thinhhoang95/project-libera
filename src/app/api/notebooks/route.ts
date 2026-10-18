import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { createNotebook, deleteNotebook, renameNotebook, toStorageError } from "@/lib/storage";
import type { LiberaNotebookMetadata } from "@/lib/types";
import { sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { StorageError } from "@/lib/storage/errors";

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
    const body = (await request.json()) as Partial<LiberaNotebookMetadata> & {
      name?: string;
    };
    return NextResponse.json(
      await createNotebook(body.name ?? "", {
        color: body.color,
        emoji: body.emoji,
        groupId: body.groupId,
      }),
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
    const body = (await request.json()) as Partial<LiberaNotebookMetadata> & {
      path?: string;
      name?: string;
    };
    if (body.path !== body.name && sharedNotebookMarker(body.path ?? "")) {
      throw new StorageError("Renaming a shared notebook is not supported yet. Its current name is required to keep collaboration connected; color, emoji and group can still be changed.", 409);
    }
    return NextResponse.json(
      await renameNotebook(body.path ?? "", body.name ?? "", {
        color: body.color,
        emoji: body.emoji,
        groupId: body.groupId,
      }),
    );
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
    const notebook = request.nextUrl.searchParams.get("path") ?? "";
    const marker = sharedNotebookMarker(notebook);
    if (marker && !marker.revoked) throw new StorageError("Leave or take down this shared notebook using its sharing settings before deleting the local notebook.", 409);
    return NextResponse.json(await deleteNotebook(notebook));
  } catch (error) {
    return handleError(error);
  }
}
