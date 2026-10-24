import type { NextRequest } from "next/server";
import { savePhotosToGallery } from "@/lib/storage/gallery";
import { galleryRoute, ids } from "../../route-helpers";

export const runtime = "nodejs";

/** Copy photos out of shared albums into this gallery. */
export function POST(request: NextRequest) {
  return galleryRoute(request, (body) => savePhotosToGallery(ids(body.ids)));
}
