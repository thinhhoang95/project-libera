import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getNotebookNode, getTree, toStorageError } from "@/lib/storage";
import { attachSharedFileIds } from "@/lib/collab/tree-file-ids";
import { listSharedEntries } from "@/lib/collab/shared-writes";
import { sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { applyPendingRootTransitions } from "@/lib/storage/root-transitions";
import { drainSharedRecordTransitionsIfPending } from "@/lib/storage/shared-record-follow";

export const runtime = "nodejs";

const isShared = (notebook: string) => Boolean(sharedNotebookMarker(notebook)?.projectId);

/** A shared notebook's tree loaded: apply moves its records have not followed yet. Asks the host only when something may be pending, and never delays the tree. */
const followRecordsInBackground = (names: string[]) => {
  for (const name of names) if (isShared(name)) void drainSharedRecordTransitionsIfPending(name).catch(() => undefined);
};

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
      followRecordsInBackground([notebookName]);
      return NextResponse.json({ notebook });
    }
    // A shared notebook the host rebound to a renamed folder: its records follow before the tree is read.
    await applyPendingRootTransitions().catch(() => undefined);
    const tree = await getTree({
      includeArchive,
      maintenance: request.nextUrl.searchParams.get("maintenance") === "throttled" ? "throttled" : "always",
    });
    await attachSharedFileIds(tree.notebooks, listSharedEntries, isShared);
    followRecordsInBackground(tree.notebooks.map((notebook) => notebook.name));
    return NextResponse.json(tree);
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
