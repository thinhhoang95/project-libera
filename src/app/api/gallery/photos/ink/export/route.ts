import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { contentDisposition } from "@/lib/content-disposition";
import { toStorageError } from "@/lib/storage";
import { exportGalleryPhotoWithInk } from "@/lib/storage/gallery";

export const runtime = "nodejs";

/** `?id=`: the photo with its ink drawn on, as a download; the photo itself is unchanged. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const photo = await exportGalleryPhotoWithInk(request.nextUrl.searchParams.get("id") ?? "");
    return new NextResponse(new Uint8Array(photo.body), {
      headers: {
        "Content-Disposition": contentDisposition("attachment", photo.name),
        "Content-Type": photo.contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
