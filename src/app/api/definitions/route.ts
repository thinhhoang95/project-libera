import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { deleteDefinitions, readDefinitions } from "@/lib/storage/definitions";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = error instanceof StorageError || (error as { code?: string })?.code ? toStorageError(error) : null;
  if (storageError) return jsonError(storageError.message, storageError.status);
  return jsonError(error instanceof Error ? error.message : "Something went wrong.", 500);
}

/** A document's definitions and notation cards (`?path=…`), written by the AI Agent. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await readDefinitions(request.nextUrl.searchParams.get("path") ?? ""));
  } catch (error) {
    return handleError(error);
  }
}

/** Delete the cards' side-car file (`?path=…`); they can be generated again. */
export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const path = request.nextUrl.searchParams.get("path") ?? "";
    await deleteDefinitions(path);
    return NextResponse.json(await readDefinitions(path));
  } catch (error) {
    return handleError(error);
  }
}
