import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { parsePhotoEdits } from "@/lib/photo-edits";
import { saveEditedImageCopy, toStorageError } from "@/lib/storage";

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
    return NextResponse.json(
      await saveEditedImageCopy(
        typeof body?.path === "string" ? body.path : "",
        parsePhotoEdits(body?.edits),
      ),
    );
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
