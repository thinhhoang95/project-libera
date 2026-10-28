import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { flattenGalleryPhotoInk, readGalleryPhotoInk, resolveGalleryPhotoInk, writeGalleryPhotoInk } from "@/lib/storage/gallery";
import { galleryRoute, text } from "../../route-helpers";

export const runtime = "nodejs";

/** `?id=`: a gallery photo's ink, and how the photo shown today is made from the one it was drawn on. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await readGalleryPhotoInk(request.nextUrl.searchParams.get("id") ?? ""));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}

/** `{ id, ops }`: changes to this computer's ink on the photo. */
export function PATCH(request: NextRequest) {
  return galleryRoute(request, (body) => writeGalleryPhotoInk(text(body.id), body.ops));
}

/**
 * `{ id, action }`: after the photo changed outside Libera, "keep" or
 * "discard" its ink; or "flatten" it into the photo (revertable).
 */
export function POST(request: NextRequest) {
  return galleryRoute(request, async (body) => {
    const id = text(body.id);
    if (body.action === "flatten") return { gallery: await flattenGalleryPhotoInk(id) };
    return resolveGalleryPhotoInk(id, body.action === "discard" ? "discard" : "keep");
  });
}
