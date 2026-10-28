import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { followSharedPdfChanges } from "@/lib/storage/pdf-sidecars";

export const runtime = "nodejs";

const MAX_PATHS = 500;

const libraryPath = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 1024 && !value.split("/").includes("..") && isSharedNotebookPath(value);

/**
 * The collab host moved or removed PDFs of a shared notebook (a collaborator
 * renamed or deleted one, or this user did through the host). The windows
 * forward its tree-changed events here, so the PDFs' side-cars on this
 * computer (annotations, outline, definitions, text cache) follow them; a
 * removed PDF's side-cars are set aside until it comes back.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = (await request.json().catch(() => null)) as { moves?: unknown; removed?: unknown } | null;
  const moves = Array.isArray(body?.moves) ? body.moves : [];
  const removed = Array.isArray(body?.removed) ? body.removed : [];
  if (moves.length + removed.length > MAX_PATHS) return jsonError(`At most ${MAX_PATHS} changes at a time.`);
  const changed = await followSharedPdfChanges(
    moves.filter((move): move is { from: string; to: string } => Boolean(move) && libraryPath(move.from) && libraryPath(move.to)),
    removed.filter(libraryPath),
  );
  return NextResponse.json({ changed });
}
