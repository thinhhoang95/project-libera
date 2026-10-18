import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getReferenceJobRunner } from "@/lib/references/jobs";
import { REFERENCE_JOB_ACTIONS, type ReferenceJobAction } from "@/lib/references/jobs-types";
import { isSafeLibraryPath } from "@/lib/references/library-ops";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment, notebookPath } from "@/lib/storage/paths";
import { pathExists } from "@/lib/storage/fs-utils";

// Background reference jobs (docs/references/lanes.md "Resolution"):
// POST { notebook, action: "resolve-pdfs" | "resolve-paths" | "cancel",
// paths?, jobId?, webSearch? } → { job }; GET ?notebook= → { jobs }.

export const runtime = "nodejs";

const MAX_PATHS = 10_000;

function handleError(error: unknown, fallback: string) {
  if (error instanceof StorageError) return jsonError(error.message, error.status);
  const storageError = toStorageError(error);
  if (storageError.status === 500) console.error(`[references] ${fallback}`, error);
  return jsonError(storageError.status === 500 ? fallback : storageError.message, storageError.status);
}

async function existingNotebook(value: unknown) {
  if (typeof value !== "string") throw new StorageError("Notebook name is required.", 400);
  const notebook = assertSafeSegment(value, "Notebook name");
  if (!(await pathExists(notebookPath(notebook)))) throw new StorageError("Notebook was not found.", 404);
  return notebook;
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const notebook = await existingNotebook(request.nextUrl.searchParams.get("notebook") ?? "");
    return NextResponse.json({ jobs: await getReferenceJobRunner().list(notebook) });
  } catch (error) {
    return handleError(error, "Could not read the reference jobs.");
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    let body: unknown;
    try { body = await request.json(); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { notebook: notebookValue, action, paths, jobId, webSearch } = body as Record<string, unknown>;
    const notebook = await existingNotebook(notebookValue);
    if (!REFERENCE_JOB_ACTIONS.includes(action as ReferenceJobAction)) return jsonError(`action must be one of: ${REFERENCE_JOB_ACTIONS.join(", ")}.`);
    if (webSearch !== undefined && typeof webSearch !== "boolean") return jsonError("webSearch must be true or false.");
    const runner = getReferenceJobRunner();

    if (action === "cancel") {
      if (typeof jobId !== "string" || !jobId) return jsonError("jobId is required.");
      const job = await runner.cancel(notebook, jobId);
      return job ? NextResponse.json({ job }) : jsonError("That job was not found.", 404);
    }
    if (action === "resolve-paths") {
      if (!Array.isArray(paths) || !paths.length) return jsonError("paths must list at least one file.");
      if (paths.length > MAX_PATHS) return jsonError(`At most ${MAX_PATHS} files can be resolved at once.`, 413);
      for (const item of paths) {
        if (typeof item !== "string" || !isSafeLibraryPath(item) || item.split("/")[0] !== notebook) return jsonError("Every path must be a file in this notebook.");
        if (!/\.(pdf|md|markdown)$/i.test(item)) return jsonError("Only PDF and Markdown files can be resolved.");
      }
      const job = await runner.enqueue(notebook, "resolve-paths", { paths: paths as string[], ...(webSearch !== undefined ? { webSearch } : {}) });
      return NextResponse.json({ job });
    }
    if (paths !== undefined) return jsonError("resolve-pdfs takes no paths.");
    const job = await runner.enqueue(notebook, "resolve-pdfs", webSearch !== undefined ? { webSearch } : {});
    return NextResponse.json({ job });
  } catch (error) {
    return handleError(error, "Could not start the reference job.");
  }
}
