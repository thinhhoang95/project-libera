import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { isSafeLibraryPath } from "@/lib/references/library-ops";
import { isAbortError } from "@/lib/references/resolve/http";
import { resolveInput, resolveMarkdown, resolvePdf, type ResolveResult } from "@/lib/references/resolve/pipeline";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment } from "@/lib/storage/paths";
import { readReferenceLibrary } from "@/lib/storage/references";

// POST /api/references/resolve (docs/references/lanes.md "Resolution"):
// { notebook, input, webSearch?, enrich? } or { notebook, path, webSearch? }
// → { candidates, duplicates, updates, warnings }. Nothing is written; the
// client adds the candidates it confirms. Closing the request cancels every
// upstream lookup and model call.

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2_000_000;
const MAX_INPUT_CHARS = 500_000;

function handleError(error: unknown) {
  if (isAbortError(error)) return jsonError("The lookup was cancelled.", 499);
  if (error instanceof StorageError) return jsonError(error.message, error.status);
  const storageError = toStorageError(error);
  if (storageError.status === 500) console.error("[references] Could not resolve the reference.", error);
  return jsonError(storageError.status === 500 ? "Could not resolve the reference." : storageError.message, storageError.status);
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonError("The text is too large to resolve at once.", 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { notebook, input, path, webSearch, enrich } = body as Record<string, unknown>;
    if (typeof notebook !== "string") return jsonError("Notebook name is required.");
    const safeNotebook = assertSafeSegment(notebook, "Notebook name");
    if (webSearch !== undefined && typeof webSearch !== "boolean") return jsonError("webSearch must be true or false.");
    if (enrich !== undefined && typeof enrich !== "boolean") return jsonError("enrich must be true or false.");
    if ((input === undefined) === (path === undefined)) return jsonError("Send either input or path.");

    const library = await readReferenceLibrary(safeNotebook);
    const options = { library, signal: request.signal, ...(webSearch !== undefined ? { webSearch } : {}), ...(enrich !== undefined ? { enrich } : {}) };
    let result: ResolveResult;
    if (typeof input === "string") {
      if (!input.trim()) return jsonError("Paste an identifier, a link or a reference to resolve.");
      if (input.length > MAX_INPUT_CHARS) return jsonError("The text is too large to resolve at once.", 413);
      result = await resolveInput(input, options);
    } else if (typeof path === "string") {
      if (!isSafeLibraryPath(path) || path.split("/")[0] !== safeNotebook) return jsonError("The file must be in this notebook.");
      if (/\.pdf$/i.test(path)) result = await resolvePdf(path, options);
      else if (/\.(md|markdown)$/i.test(path)) result = await resolveMarkdown(path, options);
      else return jsonError("Only PDF and Markdown files can be resolved.");
    } else {
      return jsonError(input !== undefined ? "input must be text." : "path must be text.");
    }
    return NextResponse.json(result);
  } catch (error) {
    return handleError(error);
  }
}
