import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { getGalleryPhotoDetails } from "@/lib/storage/gallery";
import { withSharing } from "@/lib/storage/gallery-sharing";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const contents = await withSharing(await getGalleryPhotoDetails(request.nextUrl.searchParams.get("id") ?? ""));
    return NextResponse.json(contents.photos[0], { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
