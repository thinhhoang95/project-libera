import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { contentDisposition } from "@/lib/content-disposition";
import { getMarkdownImageAsset, toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const documentPath = request.nextUrl.searchParams.get("document") ?? "";
    const assetPath = request.nextUrl.searchParams.get("asset") ?? "";
    const asset = await getMarkdownImageAsset(documentPath, assetPath);

    return new NextResponse(asset.body, {
      headers: {
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": contentDisposition("inline", asset.fileName),
        "Content-Type": asset.contentType,
      },
    });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
