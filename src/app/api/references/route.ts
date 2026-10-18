import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { LibraryOpError } from "@/lib/references/library-ops";
import type { ReferenceLibraryOp } from "@/lib/references/types";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment } from "@/lib/storage/paths";
import { readReferenceLibrary, ReferenceRevisionConflict, updateReferenceLibrary } from "@/lib/storage/references";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 20_000_000;
const MAX_OPS = 10_000;

function handleError(error: unknown, fallback: string) {
  if (error instanceof ReferenceRevisionConflict) {
    return NextResponse.json({ error: error.message, library: error.library }, { status: 409 });
  }
  if (error instanceof LibraryOpError) return jsonError(error.message, 400);
  if (error instanceof StorageError) return jsonError(error.message, error.status);
  const storageError = toStorageError(error);
  if (storageError.status === 500) console.error(`[references] ${fallback}`, error);
  return jsonError(storageError.status === 500 ? fallback : storageError.message, storageError.status);
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const notebook = assertSafeSegment(request.nextUrl.searchParams.get("notebook") ?? "", "Notebook name");
    return NextResponse.json({ library: await readReferenceLibrary(notebook) });
  } catch (error) {
    return handleError(error, "Could not read the reference library.");
  }
}

export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonError("The change is too large.", 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { notebook, revision, ops } = body as { notebook?: unknown; revision?: unknown; ops?: unknown };
    if (typeof notebook !== "string") return jsonError("Notebook name is required.");
    const safeNotebook = assertSafeSegment(notebook, "Notebook name");
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return jsonError("Library revision is required.");
    if (!Array.isArray(ops)) return jsonError("Library changes must be a list.");
    if (ops.length > MAX_OPS) return jsonError(`At most ${MAX_OPS} changes can be applied at once.`, 413);
    const library = await updateReferenceLibrary(safeNotebook, revision, ops as ReferenceLibraryOp[]);
    return NextResponse.json({ library });
  } catch (error) {
    return handleError(error, "Could not update the reference library.");
  }
}
