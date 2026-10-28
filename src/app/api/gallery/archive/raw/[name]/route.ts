import { NextRequest, NextResponse } from "next/server";
import { renewArchiveAccess, requireArchiveAccess } from "@/lib/api";
import { contentDisposition } from "@/lib/content-disposition";
import { toStorageError } from "@/lib/storage";
import { streamArchivedPhoto, readArchivedThumbnail } from "@/lib/storage/gallery";

export const runtime = "nodejs";

type ArchiveRawRouteContext = {
  params: Promise<{
    name: string;
  }>;
};

export async function GET(request: NextRequest, context: ArchiveRawRouteContext) {
  const accessError = requireArchiveAccess(request);
  if (accessError) return accessError;
  try {
    const name = decodeURIComponent((await context.params).name);
    const photo = request.nextUrl.searchParams.get("thumbnail") === "1"
      ? await readArchivedThumbnail(name, Number(request.nextUrl.searchParams.get("size")) || 640, request.signal)
      : await streamArchivedPhoto(name, request.signal);
    return renewArchiveAccess(new NextResponse(photo.body instanceof Uint8Array ? new Uint8Array(photo.body) : photo.body, {
      headers: {
        // Never keep archived photos in a cache that outlives the unlock.
        "Cache-Control": "no-store",
        "Content-Disposition": contentDisposition("inline", photo.name),
        "Content-Type": photo.contentType,
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    }));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
