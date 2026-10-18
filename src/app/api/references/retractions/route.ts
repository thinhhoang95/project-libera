import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getReferenceJobRunner } from "@/lib/references/jobs";
import type { RetractionCheckResponse } from "@/lib/references/jobs-types";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { pathExists } from "@/lib/storage/fs-utils";
import { assertSafeSegment, notebookPath } from "@/lib/storage/paths";

// Retraction and correction checks (retraction.ts):
// POST { notebook, force? } → { job, lastCheckedAt? }. Without `force` a
// check starts only when the last one is more than 7 days old; `job` is null
// when none was due or no entry has a DOI. Progress and cancelling go through
// the jobs API like any other job. Online lookups turned off → 409.

export const runtime = "nodejs";

function handleError(error: unknown, fallback: string) {
  if (error instanceof StorageError) return jsonError(error.message, error.status);
  const storageError = toStorageError(error);
  if (storageError.status === 500) console.error(`[references] ${fallback}`, error);
  return jsonError(storageError.status === 500 ? fallback : storageError.message, storageError.status);
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    let body: unknown;
    try { body = await request.json(); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { notebook: notebookValue, force } = body as Record<string, unknown>;
    if (typeof notebookValue !== "string") return jsonError("Notebook name is required.");
    const notebook = assertSafeSegment(notebookValue, "Notebook name");
    if (!(await pathExists(notebookPath(notebook)))) return jsonError("Notebook was not found.", 404);
    if (force !== undefined && typeof force !== "boolean") return jsonError("force must be true or false.");
    const runner = getReferenceJobRunner();
    const result: RetractionCheckResponse = await runner.scheduleRetractionCheck(notebook, { force: force === true });
    if (result.skipped === "lookups-off") {
      return NextResponse.json({ ...result, error: "Online lookups are turned off in Preferences (AI → References), so retractions cannot be checked." }, { status: 409 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return handleError(error, "Could not start the retraction check.");
  }
}
