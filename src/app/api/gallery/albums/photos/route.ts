import type { NextRequest } from "next/server";
import { updateAlbumPhotos } from "@/lib/storage/gallery";
import { galleryRoute, ids, text } from "../../route-helpers";

export const runtime = "nodejs";

/** Add photos to or remove them from an album without moving any files. */
export function PATCH(request: NextRequest) {
  return galleryRoute(request, async (body) => ({
    gallery: await updateAlbumPhotos(text(body.id), { add: ids(body.add), remove: ids(body.remove) }),
  }));
}
