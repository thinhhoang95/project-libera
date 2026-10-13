import type { NextRequest } from "next/server";
import { createAlbum, deleteAlbum, renameAlbum } from "@/lib/storage/gallery";
import { galleryRoute, ids, text } from "../route-helpers";

export const runtime = "nodejs";

/** Create an album; the photos given are moved into its new folder. */
export function POST(request: NextRequest) {
  return galleryRoute(request, (body) => createAlbum(text(body.name), ids(body.photoIds)));
}

export function PATCH(request: NextRequest) {
  return galleryRoute(request, async (body) => ({ gallery: await renameAlbum(text(body.id), text(body.name)) }));
}

/** Delete an album only; its photos stay in the gallery and on disk. */
export function DELETE(request: NextRequest) {
  return galleryRoute(request, async (body) => ({ gallery: await deleteAlbum(text(body.id)) }));
}
