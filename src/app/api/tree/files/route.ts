import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getFileMetadata, toStorageError } from "@/lib/storage";
import { attachSharedFileIdsTo } from "@/lib/collab/tree-file-ids";
import { listSharedEntries } from "@/lib/collab/shared-writes";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";

import type { LiberaFileNode } from "@/lib/types";

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
    // A shared file's row keeps an id only when its bytes are verified against the manifest again.
    const shared = new Map<string, LiberaFileNode[]>();
    for (const { metadata } of files) {
      if (!metadata || !isSharedNotebookPath(metadata.node.path)) continue;
      shared.set(metadata.node.notebook, [...(shared.get(metadata.node.notebook) ?? []), metadata.node]);
    }
    await Promise.all([...shared].map(([notebook, nodes]) => attachSharedFileIdsTo(notebook, nodes, listSharedEntries)));
    return NextResponse.json({ files });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
