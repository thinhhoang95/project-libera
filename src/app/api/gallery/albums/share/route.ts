import type { NextRequest } from "next/server";
import { shareGalleryAlbum } from "@/lib/storage/gallery";
import { galleryRoute, text } from "../../route-helpers";
import { shareOptions } from "../../share-options";

export const runtime = "nodejs";

/** Share an album with other people (collaboration). */
export function POST(request: NextRequest) {
  return galleryRoute(request, (body) => shareGalleryAlbum(text(body.albumId), shareOptions(body)));
}
