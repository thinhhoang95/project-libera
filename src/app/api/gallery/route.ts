import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { getGallery } from "@/lib/storage/gallery";
import { withSharing } from "@/lib/storage/gallery-sharing";
import { galleryCatalogPage } from "@/lib/storage/gallery-catalog";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    if (request.nextUrl.searchParams.get("catalog") === "1") {
      const cursor = Math.max(0, Math.floor(Number(request.nextUrl.searchParams.get("cursor")) || 0));
      return NextResponse.json(await galleryCatalogPage(cursor, request.nextUrl.searchParams.get("revision") ?? ""), { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(await withSharing(await getGallery()), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
