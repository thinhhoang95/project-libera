import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getNotebookNode, getTree, toStorageError } from "@/lib/storage";
import { attachSharedFileIds } from "@/lib/collab/tree-file-ids";
import { listSharedEntries } from "@/lib/collab/shared-writes";
import { sharedNotebookMarker } from "@/lib/collab/shared-notebook";

export const runtime = "nodejs";

const isShared = (notebook: string) => Boolean(sharedNotebookMarker(notebook)?.projectId);

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const includeArchive = request.nextUrl.searchParams.get("includeArchive") === "true";
    // One notebook, without the library-wide upkeep: what a shared edit refreshes.
    const notebookName = request.nextUrl.searchParams.get("notebook");
    if (notebookName) {
      const notebook = await getNotebookNode(notebookName, { includeArchive });
      if (notebook) await attachSharedFileIds([notebook], listSharedEntries, isShared);
      return NextResponse.json({ notebook });
    }
    const tree = await getTree({
      includeArchive,
      maintenance: request.nextUrl.searchParams.get("maintenance") === "throttled" ? "throttled" : "always",
    });
    await attachSharedFileIds(tree.notebooks, listSharedEntries, isShared);
    return NextResponse.json(tree);
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
