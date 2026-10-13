import type { NextRequest } from "next/server";
import { parsePhotoEdits } from "@/lib/photo-edits";
import { editPhoto, revertPhoto } from "@/lib/storage/gallery";
import { galleryRoute, text } from "../../route-helpers";

export const runtime = "nodejs";

/** Save edits over the photo (keeping its original) or as a copy, or revert to the original. */
export function POST(request: NextRequest) {
  return galleryRoute(request, async (body) => {
    if (body.action === "revert") return { id: text(body.id), gallery: await revertPhoto(text(body.id)) };
    return editPhoto(text(body.id), parsePhotoEdits(body.edits), body.mode === "copy" ? "copy" : "replace");
  });
}
