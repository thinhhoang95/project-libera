import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getFileMetadata, toStorageError } from "@/lib/storage";
import { markFileIdsUnknown } from "@/lib/storage/tree";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";

export const runtime = "nodejs";

/** Metadata for a few files, so a shared edit need not read the whole library. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as { paths?: unknown };
    const paths = Array.isArray(body.paths) ? body.paths.filter((entry): entry is string => typeof entry === "string") : [];
    const files = await getFileMetadata(paths);
    // A shared file's identity is not checked here (no listing, no read): the row is "unknown" and the shown row keeps
    // the id it had. A reused path is a structural change, which reads the whole notebook and checks it against the listing.
    markFileIdsUnknown(files.flatMap(({ metadata }) => metadata && isSharedNotebookPath(metadata.node.path) ? [metadata.node] : []));
    return NextResponse.json({ files });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
