import { NextRequest, NextResponse } from "next/server";
import { renewArchiveAccess, requireArchiveAccess } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { getGalleryPhotoDetails } from "@/lib/storage/gallery";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const accessError = requireArchiveAccess(request);
  if (accessError) return accessError;
  try {
    const contents = await getGalleryPhotoDetails(request.nextUrl.searchParams.get("id") ?? "", true);
    return renewArchiveAccess(NextResponse.json(contents.photos[0], { headers: { "Cache-Control": "no-store" } }));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
