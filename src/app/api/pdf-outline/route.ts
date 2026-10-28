import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { deletePdfOutlineFile, readPdfOutline } from "@/lib/storage/pdf-outlines";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = error instanceof StorageError || (error as { code?: string })?.code ? toStorageError(error) : null;
  if (storageError) return jsonError(storageError.message, storageError.status);
  return jsonError(error instanceof Error ? error.message : "Something went wrong.", 500);
}

/** A PDF's outline (`?path=…`): its own bookmarks, and the one the AI Agent generated. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await readPdfOutline(request.nextUrl.searchParams.get("path") ?? ""));
  } catch (error) {
    return handleError(error);
  }
}

/** Delete the generated outline's side-car (`?path=…`); it can be generated again. */
export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const path = request.nextUrl.searchParams.get("path") ?? "";
    await deletePdfOutlineFile(path);
    return NextResponse.json(await readPdfOutline(path));
  } catch (error) {
    return handleError(error);
  }
}
