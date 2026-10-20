import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { recordingForCompanion } from "@/lib/storage/transcripts";

export const runtime = "nodejs";

const MAX_PATHS = 500;

/**
 * Tells the search index that files of shared notebooks changed on disk. The
 * collab host writes those working copies itself (from collaborators' edits),
 * outside Libera's storage layer, so the windows forward its `files-changed`
 * events here. Only paths inside shared notebooks are accepted: everything
 * else already reaches the index through storage writes.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const body = (await request.json().catch(() => null)) as { paths?: unknown } | null;
  if (!body || !Array.isArray(body.paths) || body.paths.length > MAX_PATHS) {
    return jsonError(`Expected { paths: string[] } with at most ${MAX_PATHS} paths.`);
  }
  const paths = body.paths.filter(
    (entry): entry is string => typeof entry === "string" && entry.length <= 1024 && !entry.split("/").includes("..") && isSharedNotebookPath(entry),
  );
  // A collaborator's transcript reaches the index through its recording.
  if (paths.length > 0) notifySearchChanges([...new Set(paths.map((entry) => recordingForCompanion(entry) ?? entry))]);
  return NextResponse.json({ accepted: paths.length });
}
