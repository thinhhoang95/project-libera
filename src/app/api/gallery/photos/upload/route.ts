import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { getGallery, importGalleryPhoto } from "@/lib/storage/gallery";
import { withSharing } from "@/lib/storage/gallery-sharing";
import { gallerySummary } from "@/lib/gallery-catalog";

export const runtime = "nodejs";

const MAX_FILES = 100;

/**
 * Adds photos from the user's computer to the gallery, or to an album. A file
 * that cannot be added is reported and the others are still saved.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  let formData: FormData;
  try { formData = await request.formData(); } catch { return jsonError("Invalid upload.", 400); }
  const albumId = String(formData.get("albumId") ?? "");
  const files = formData.getAll("files").filter((item): item is File => item instanceof File);
  if (!files.length) return jsonError("Choose at least one photo.", 400);
  if (files.length > MAX_FILES) return jsonError(`Add up to ${MAX_FILES} photos at a time.`, 400);
  try {
    const added: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const file of files) {
      try {
        added.push((await importGalleryPhoto(albumId, file.name, Buffer.from(await file.arrayBuffer()))).id);
      } catch (error) {
        failed.push({ name: file.name, error: toStorageError(error).message });
      }
    }
    const gallery = await withSharing(await getGallery({ incremental: true }));
    return NextResponse.json({ added, failed, gallery: request.headers.get("X-Libera-Gallery") === "catalog" ? gallerySummary(gallery) : gallery });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
