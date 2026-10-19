import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { lastBibMirrorResult, regenerateBibMirror } from "@/lib/references/bib-mirror";
import { LibraryOpError } from "@/lib/references/library-ops";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment } from "@/lib/storage/paths";
import { readReferenceLibrary, updateReferenceLibrary } from "@/lib/storage/references";

// The generated references.bib of a notebook (references/bib-mirror.ts).
// POST { notebook, enabled } turns the mirror on or off and, when on, writes
// it at once → { library, mirror: BibMirrorResult }. Turning it off leaves an
// existing file in place. GET ?notebook= → { enabled, mirror? } (the last
// result in this process).

export const runtime = "nodejs";

function handleError(error: unknown, fallback: string) {
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
    const library = await readReferenceLibrary(notebook);
    const mirror = lastBibMirrorResult(notebook);
    return NextResponse.json({ enabled: library.settings?.bibMirror === true, ...(mirror ? { mirror } : {}) });
  } catch (error) {
    return handleError(error, "Could not read the .bib mirror setting.");
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    let body: unknown;
    try { body = await request.json(); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { notebook: notebookValue, enabled } = body as Record<string, unknown>;
    if (typeof notebookValue !== "string") return jsonError("Notebook name is required.");
    if (typeof enabled !== "boolean") return jsonError("enabled must be true or false.");
    const notebook = assertSafeSegment(notebookValue, "Notebook name");
    const library = await updateReferenceLibrary(notebook, null, [{ op: "set-settings", settings: { bibMirror: enabled } }]);
    // The commit scheduled a debounced rewrite; do it now instead.
    const mirror = await regenerateBibMirror(notebook, library);
    return NextResponse.json({ library, mirror });
  } catch (error) {
    return handleError(error, "Could not change the .bib mirror.");
  }
}
