import { NextRequest, NextResponse } from "next/server";
import { StorageError } from "@/lib/storage/errors";
import { requireAuth } from "@/lib/api";
import { readPdfAnnotations, toStorageError, writePdfAnnotations } from "@/lib/storage";
import { CollabHostError, collabHostConfig, resolveSharedPdf } from "@/lib/collab/host-client";
import { isSharedNotebookPath, SharedDocumentError } from "@/lib/collab/shared-notebook";

export const runtime = "nodejs";

function handleError(error: unknown) {
  if (error instanceof CollabHostError) return NextResponse.json({ error: error.message }, { status: error.status });
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

    // Only a successful resolution can authorize a sidecar write.
    const path = body.path ?? "";
    if (isSharedNotebookPath(path)) {
      const config = collabHostConfig();
      if (!config) throw new StorageError("Live PDF status is unavailable.", 503);
      if (await resolveSharedPdf(path, config)) throw new SharedDocumentError(path);
    }

    return NextResponse.json(
      await writePdfAnnotations(path, body.annotations ?? []),
    );
  } catch (error) {
    return handleError(error);
  }
}
