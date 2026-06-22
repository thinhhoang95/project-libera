import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import {
  getTree,
  setNotebookPanelExpandedPaths,
  toStorageError,
} from "@/lib/storage";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as { expandedPaths?: unknown };
    const expandedPaths = Array.isArray(body.expandedPaths)
      ? body.expandedPaths.filter((path): path is string => typeof path === "string")
      : [];

    await setNotebookPanelExpandedPaths(expandedPaths);
    const tree = await getTree();

    if (tree.notebookPanelExpandedPaths) {
      await setNotebookPanelExpandedPaths(tree.notebookPanelExpandedPaths);
    }

    return NextResponse.json(tree);
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
