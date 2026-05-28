import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { createNotebookZip, toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const notebook = request.nextUrl.searchParams.get("path") ?? "";
    const download = await createNotebookZip(notebook);

    return new NextResponse(
      new Blob([new Uint8Array(download.body)], { type: "application/zip" }),
      {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename="${download.fileName.replaceAll(
            '"',
            "",
          )}"`,
          "Content-Type": "application/zip",
        },
      },
    );
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
