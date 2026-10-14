import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getSearchIndexer } from "@/lib/search/indexer";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

const ACTIONS = new Set(["build", "scan", "background", "rebuild", "reembed", "pause", "resume"]);

/**
 * Control indexing. `build` creates the index (the first one is never built
 * unasked) and updates it; `scan` updates an existing index now; `background`
 * does the same unless background indexing is off or a pass ran moments ago;
 * `reembed` replaces vectors made with other settings.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { action } = (await request.json().catch(() => ({}))) as { action?: string };
  if (!action || !ACTIONS.has(action)) return jsonError("Unknown indexing action.");

  try {
    const indexer = getSearchIndexer();
    if (action === "build") indexer.requestScan({ force: true, build: true });
    else if (action === "scan") indexer.requestScan({ force: true, manual: true });
    else if (action === "reembed") indexer.reembed();
    else if (action === "background") indexer.requestScan();
    else if (action === "rebuild") await indexer.rebuild();
    else if (action === "pause") indexer.pause();
    else if (action === "resume") indexer.resume();
    return NextResponse.json(indexer.status());
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
