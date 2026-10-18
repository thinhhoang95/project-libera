import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment } from "@/lib/storage/paths";
import { refreshNotebookCitations } from "@/lib/storage/reference-citations";

export const runtime = "nodejs";

// GET ?notebook=N[&includeArchive=1] → { byFile, byKey } (the "Citation index"
// contract in docs/references/lanes.md). Keys are as written in the saved
// files; the client resolves aliases and merges in its open drafts. Without
// includeArchive, the archive is indexed when the library shows it.

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const notebook = assertSafeSegment(request.nextUrl.searchParams.get("notebook") ?? "", "Notebook name");
    const archive = request.nextUrl.searchParams.get("includeArchive");
    const { byFile, byKey } = await refreshNotebookCitations(notebook, archive === null ? {} : { includeArchive: archive === "1" || archive === "true" });
    return NextResponse.json({ byFile, byKey }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof StorageError) return jsonError(error.message, error.status);
    const storageError = toStorageError(error);
    if (storageError.status === 500) console.error("[references] Could not index citations.", error);
    return jsonError(storageError.status === 500 ? "Could not list the notebook's citations." : storageError.message, storageError.status);
  }
}
