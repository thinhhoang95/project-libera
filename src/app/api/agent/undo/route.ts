import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { pruneReviews } from "@/lib/agent/review-store";
import { isRunId, undoRun } from "@/lib/agent/snapshots";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  let body: { runId?: unknown; paths?: unknown } | null;
  try { body = await request.json(); } catch { return jsonError("Invalid undo request.", 400); }
  if (!isRunId(body?.runId)) return jsonError("Invalid run.", 400);
  const paths = body.paths;
  if (paths !== undefined && !(Array.isArray(paths) && paths.length <= 500 && paths.every((item) => typeof item === "string" && item.length <= 4_096))) {
    return jsonError("Invalid paths.", 400);
  }
  try {
    const results = await undoRun(body.runId, paths as string[] | undefined);
    // Files the undo put back to their review baseline need no review any more.
    await pruneReviews(results.filter((result) => result.status === "restored" || result.status === "deleted").map((result) => result.path));
    return NextResponse.json({ results });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not undo the agent's changes.", 404);
  }
}
