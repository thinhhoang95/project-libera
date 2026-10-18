import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { applyCitationRewrite, previewCitationRewrite, undoCitationRewrite } from "@/lib/references/rewrite";
import { MAX_TEXT_FILE_BYTES } from "@/lib/storage/constants";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment } from "@/lib/storage/paths";

export const runtime = "nodejs";

// Citation key rewrite after a key change (docs/references/plan.md §1.4;
// src/lib/references/rewrite.ts). POST with:
//
// - { notebook, map: { oldKey: newKey }, dryRun: true, drafts?: { path: text } }
//   → { files: [{ path, count, excerpts: [{ line, before, after }] }], expected: { path: sha256 } }
//   Every Markdown file in the notebook citing an old key; a supplied draft
//   replaces the saved text of its file. Writes nothing.
// - { notebook, map, dryRun: false, expected, drafts? }
//   → { rewriteId, changed: [path], skipped: [{ path, reason }], draftEdits: { path: newText } }
//   Rewrites each saved file whose SHA-256 still equals `expected[path]` from
//   the dry run; others are skipped with a reason. `draftEdits` holds the
//   rewritten drafts, for the client to apply to its open tabs.
// - { notebook, undo: rewriteId } → { restored: [path], skipped: [{ path, reason }] }
//   Restores the files of one rewrite that were not edited since.
//
// New keys must be keys or aliases in the notebook's library.

const MAX_BODY_BYTES = MAX_TEXT_FILE_BYTES * 8 + 1_000_000;

function handleError(error: unknown) {
  if (error instanceof StorageError) return jsonError(error.message, error.status);
  const storageError = toStorageError(error);
  if (storageError.status === 500) console.error("[references] Could not rewrite citations.", error);
  return jsonError(storageError.status === 500 ? "Could not update the citations." : storageError.message, storageError.status);
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonError("The drafts are too large to rewrite at once.", 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { notebook, map, dryRun, drafts, expected, undo } = body as Record<string, unknown>;
    if (typeof notebook !== "string") return jsonError("Notebook name is required.");
    const safeNotebook = assertSafeSegment(notebook, "Notebook name");

    if (undo !== undefined) {
      return NextResponse.json(await undoCitationRewrite(safeNotebook, undo), { headers: { "Cache-Control": "no-store" } });
    }
    if (typeof dryRun !== "boolean") return jsonError("dryRun must be true or false.");
    const result = dryRun
      ? await previewCitationRewrite(safeNotebook, map, drafts)
      : await applyCitationRewrite(safeNotebook, map, { expected, drafts });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
