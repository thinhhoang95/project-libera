import type { NextRequest } from "next/server";
import { deletePhotos, setPhotosStarred } from "@/lib/storage/gallery";
import { galleryRoute, ids } from "../route-helpers";

export const runtime = "nodejs";

export function PATCH(request: NextRequest) {
  return galleryRoute(request, async (body) => ({ gallery: await setPhotosStarred(ids(body.ids), body.starred === true) }));
}

export function DELETE(request: NextRequest) {
  return galleryRoute(request, (body) => deletePhotos(ids(body.ids)));
}
