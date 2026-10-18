import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { parsePhotoEdits } from "@/lib/photo-edits";
import { saveEditedImageCopy, toStorageError } from "@/lib/storage";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { saveSharedEditedImageCopy } from "@/lib/collab/shared-writes";

export const runtime = "nodejs";

/** Save edits to a notebook image as a copy beside it. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  let body: { path?: unknown; edits?: unknown };

  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request.", 400);
  }

  try {
    const imagePath = typeof body?.path === "string" ? body.path : "";
    const edits = parsePhotoEdits(body?.edits);
    // In a shared notebook the edited copy is a new blob added through the collab host.
    return NextResponse.json(
      isSharedNotebookPath(imagePath) ? await saveSharedEditedImageCopy(imagePath, edits) : await saveEditedImageCopy(imagePath, edits),
    );
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
