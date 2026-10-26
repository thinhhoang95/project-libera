import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { contentDisposition } from "@/lib/content-disposition";
import { toStorageError } from "@/lib/storage";
import { streamGalleryPhoto, readGalleryThumbnail } from "@/lib/storage/gallery";

export const runtime = "nodejs";

type GalleryRawRouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

export async function GET(request: NextRequest, context: GalleryRawRouteContext) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const { path } = await context.params;
    const photoPath = path.map(decodeURIComponent).join("/");
    const photo = request.nextUrl.searchParams.get("thumbnail") === "1"
      ? await readGalleryThumbnail(photoPath, Number(request.nextUrl.searchParams.get("size")) || 640)
      : await streamGalleryPhoto(photoPath, request.signal);
    return new NextResponse(photo.body instanceof Uint8Array ? new Uint8Array(photo.body) : photo.body, {
      headers: {
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": contentDisposition("inline", photo.name),
        "Content-Type": photo.contentType,
        // Generated SVGs are shown as images only; never let them run script.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
