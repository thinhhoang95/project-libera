import type { NextRequest } from "next/server";
import { shareGalleryPhoto } from "@/lib/storage/gallery";
import { galleryRoute, text } from "../../route-helpers";
import { shareOptions } from "../../share-options";

export const runtime = "nodejs";

/** Share one photo on its own (collaboration). */
export function POST(request: NextRequest) {
  return galleryRoute(request, (body) => shareGalleryPhoto(text(body.photoId), shareOptions(body)));
}
