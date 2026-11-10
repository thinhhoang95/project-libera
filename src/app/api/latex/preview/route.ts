import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { compileDrawingPreview, MAX_PREVIEW_PICTURE_CHARACTERS, MAX_PREVIEW_PREAMBLE_CHARACTERS } from "@/lib/latex/preview-build";
import { isLatexEngine } from "@/lib/latex/project";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

/** One drawing of the Visual mode compiled on its own: its PDF, or why not (preview-build.ts). */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const body = (await request.json().catch(() => null)) as { rootPath?: unknown; engine?: unknown; preamble?: unknown; picture?: unknown } | null;
  if (typeof body?.rootPath !== "string" || !body.rootPath) return jsonError("Choose a LaTeX file.", 400);
  const engine = body.engine === undefined || body.engine === "auto" ? "auto" : isLatexEngine(body.engine) ? body.engine : null;
  if (!engine) return jsonError("Unknown LaTeX engine.", 400);
  if (typeof body.preamble !== "string" || typeof body.picture !== "string" || !body.picture.trim()) return jsonError("Nothing to preview.", 400);
  if (body.preamble.length > MAX_PREVIEW_PREAMBLE_CHARACTERS || body.picture.length > MAX_PREVIEW_PICTURE_CHARACTERS) return jsonError("The picture is too large to preview.", 413);

  try {
    const result = await compileDrawingPreview({ rootPath: body.rootPath, engine, preamble: body.preamble, picture: body.picture }, request.signal);
    if (result.status === "success") {
      return new NextResponse(new Uint8Array(result.pdf), { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } });
    }
    return jsonError(result.message, result.status === "unavailable" ? 503 : 422);
  } catch (error) {
    if (request.signal.aborted) return jsonError("Preview canceled.", 499);
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }
}
