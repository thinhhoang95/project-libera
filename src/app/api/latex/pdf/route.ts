import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { contentDisposition } from "@/lib/content-disposition";
import { readLatexSnapshot } from "@/lib/latex/build";
import { toStorageError } from "@/lib/storage";
import { StorageError } from "@/lib/storage/errors";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const rootPath = request.nextUrl.searchParams.get("path") ?? "";
  const buildId = request.nextUrl.searchParams.get("build") ?? "";

  try {
    const snapshot = await readLatexSnapshot(rootPath, buildId);
    const body = await readFile(snapshot.pdfPath).catch(() => {
      throw new StorageError("This build is no longer available. Compile again.", 404);
    });
    const fileName = `${rootPath.split("/").at(-1)?.replace(/\.tex$/i, "") || "document"}.pdf`;
    return new NextResponse(new Uint8Array(body), {
      headers: {
        // Builds are immutable snapshots, so a cached copy never goes stale.
        "Cache-Control": "private, max-age=3600, immutable",
        "Content-Disposition": contentDisposition(request.nextUrl.searchParams.has("download") ? "attachment" : "inline", fileName),
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }
}
