import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { readPdfAnnotations, toStorageError, writePdfAnnotations } from "@/lib/storage";
import { collabHostConfig, resolveSharedPdf } from "@/lib/collab/host-client";
import { isSharedNotebookPath, SharedDocumentError } from "@/lib/collab/shared-notebook";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const filePath = request.nextUrl.searchParams.get("path") ?? "";
    return NextResponse.json(await readPdfAnnotations(filePath));
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      path?: string;
      annotations?: unknown;
    };

    // A live PDF's sidecar is a copy the host writes. With the host down
    // nothing says so, and the write stands: the next start merges new marks.
    const path = body.path ?? "";
    const config = isSharedNotebookPath(path) ? collabHostConfig() : null;
    if (config && await resolveSharedPdf(path, config).catch(() => null)) throw new SharedDocumentError(path);

    return NextResponse.json(
      await writePdfAnnotations(path, body.annotations ?? []),
    );
  } catch (error) {
    return handleError(error);
  }
}
