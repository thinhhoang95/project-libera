import { NextRequest, NextResponse } from "next/server";
import { renewArchiveAccess, requireArchiveAccess } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { archivePhotos, deleteArchivedPhotos, getArchive } from "@/lib/storage/gallery";
import { galleryRoute, ids } from "../route-helpers";
import { archiveSummary } from "@/lib/gallery-catalog";

export const runtime = "nodejs";

/** List the Protected Archive; only while it is unlocked. */
export async function GET(request: NextRequest) {
  const accessError = requireArchiveAccess(request);
  if (accessError) return accessError;
  try {
    const archive = await getArchive();
    return renewArchiveAccess(NextResponse.json(request.headers.get("X-Libera-Gallery") === "catalog" ? archiveSummary(archive) : archive, { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}

/** Send photos to the archive. Hiding photos needs no password; seeing them again does. */
export function POST(request: NextRequest) {
  return galleryRoute(request, (body) => archivePhotos(ids(body.ids)));
}

/** Delete archived photos from disk for good. */
export function DELETE(request: NextRequest) {
  return galleryRoute(request, (body) => deleteArchivedPhotos(ids(body.ids)), { archive: true });
}
