import type { NextRequest } from "next/server";
import { restoreArchivedPhotos } from "@/lib/storage/gallery";
import { galleryRoute, ids } from "../../route-helpers";

export const runtime = "nodejs";

/** Put archived photos back in the gallery, in the folder and albums they came from. */
export function POST(request: NextRequest) {
  return galleryRoute(request, (body) => restoreArchivedPhotos(ids(body.ids)), { archive: true });
}
