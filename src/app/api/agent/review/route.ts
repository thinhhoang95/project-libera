import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { StorageError } from "@/lib/storage/errors";
import { keepReviews, listPendingReviews, revertReviews, setReviewBaseline, type ReviewExpectation } from "@/lib/agent/review-store";

export const runtime = "nodejs";

// Manual review of the agent's changes (src/lib/agent/review-store.ts).
// GET lists the files with changes to review. POST actions:
// - "baseline" {path, baseline, revision}: an editor moved the file's baseline;
// - "keep" {paths, expected}: accept every change in these files;
// - "revert" {paths, baselines?, expected}: restore each baseline.
// Versions and disk text in `expected` refuse decisions made on stale files.

const MAX_PATHS = 500;
const MAX_TEXT_CHARS = 20_000_000;

function isPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function isPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PATHS && value.every(isPath);
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try { return NextResponse.json({ files: await listPendingReviews() }); }
  catch (error) { return jsonError(error instanceof Error ? error.message : "Could not load the review.", 500); }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  let body: { action?: unknown; path?: unknown; paths?: unknown; baseline?: unknown; baselines?: unknown; revision?: unknown; expected?: unknown } | null;
  try { body = await request.json(); } catch { return jsonError("Invalid review request.", 400); }
  if (!body) return jsonError("Invalid review request.", 400);
  try {
    if (body.action === "baseline") {
      if (!isPath(body.path) || typeof body.baseline !== "string" || body.baseline.length > MAX_TEXT_CHARS || typeof body.revision !== "string") return jsonError("Invalid review baseline.", 400);
      return NextResponse.json(await setReviewBaseline(body.path, body.baseline, body.revision));
    }
    if (!isPathList(body.paths)) return jsonError("Invalid paths.", 400);
    const expected = body.expected;
    if (!expected || typeof expected !== "object" || Array.isArray(expected) || body.paths.some((path) => {
      const value = (expected as Record<string, Partial<ReviewExpectation>>)[path];
      return !value || typeof value.revision !== "string" || typeof value.current !== "string" || value.current.length > MAX_TEXT_CHARS;
    })) return jsonError("Invalid review versions.", 400);
    if (body.action === "keep") {
      await keepReviews(body.paths, expected as Record<string, ReviewExpectation>);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "revert") {
      const baselines = body.baselines ?? {};
      if (typeof baselines !== "object" || Array.isArray(baselines) || Object.entries(baselines).some(([key, value]) => !isPath(key) || typeof value !== "string" || value.length > MAX_TEXT_CHARS)) {
        return jsonError("Invalid review baselines.", 400);
      }
      return NextResponse.json({ results: await revertReviews(body.paths, baselines as Record<string, string>, expected as Record<string, ReviewExpectation>) });
    }
    return jsonError("Unknown review action.", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not update the review.", error instanceof StorageError ? error.status : 500);
  }
}
