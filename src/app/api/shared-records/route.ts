import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { listProjects } from "@/lib/collab/host-client";
import { sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { nudgeSharedRecordTransitions } from "@/lib/storage/shared-record-follow";

export const runtime = "nodejs";

/**
 * The collab host reported a tree change in a shared notebook (a collaborator
 * moved or removed files), or a window opened. The windows forward that here as
 * a nudge: Next drains the host's durable log of manifest moves for the notebook
 * and applies it to the records kept on this computer (stars, tags, reviews,
 * attachments, sidecars, PDF and recording notes, search). The nudge carries no
 * data, so a lost one costs nothing: the log still holds the moves.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = (await request.json().catch(() => null)) as { notebook?: unknown; all?: unknown } | null;
  if (body?.all === true) {
    // A window opened: moves may have happened while none was (the log keeps them).
    const names = await listProjects().then((projects) => projects.filter((project) => project.kind !== "album" && !project.revoked).map((project) => project.notebook), () => [] as string[]);
    const results = await Promise.all(names.filter((name) => sharedNotebookMarker(name)?.projectId).map((name) => nudgeSharedRecordTransitions(name)));
    return NextResponse.json({ notebooks: results.length, applied: results.reduce((sum, result) => sum + result.applied, 0) });
  }
  const notebook = typeof body?.notebook === "string" ? body.notebook : "";
  if (!notebook || notebook.length > 256 || /[\\/]/.test(notebook) || !sharedNotebookMarker(notebook)?.projectId) {
    return NextResponse.json({ error: "Not a shared notebook." }, { status: 400 });
  }
  const result = await nudgeSharedRecordTransitions(notebook);
  return NextResponse.json({ reachable: result.reachable, applied: result.applied, held: result.held, unfinished: result.unfinished, waiting: result.waiting });
}
