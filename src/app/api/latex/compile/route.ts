import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { compileLatexDocument } from "@/lib/latex/build";
import { isLatexEngine } from "@/lib/latex/project";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_DRAFTS = 64;
const MAX_DRAFT_CHARACTERS = 4_000_000;
const MAX_TOTAL_CHARACTERS = 16_000_000;

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const body = (await request.json().catch(() => null)) as { rootPath?: unknown; engine?: unknown; drafts?: unknown } | null;
  if (typeof body?.rootPath !== "string" || !body.rootPath) return jsonError("Choose a LaTeX file to compile.", 400);
  const engine = body.engine === undefined || body.engine === "auto" ? "auto" : isLatexEngine(body.engine) ? body.engine : null;
  if (!engine) return jsonError("Unknown LaTeX engine.", 400);

  const drafts: Record<string, string> = {};
  if (body.drafts !== undefined) {
    if (!body.drafts || typeof body.drafts !== "object" || Array.isArray(body.drafts)) return jsonError("Invalid drafts.", 400);
    const entries = Object.entries(body.drafts as Record<string, unknown>);
    if (entries.length > MAX_DRAFTS) return jsonError("Too many open documents to compile at once.", 413);
    let total = 0;
    for (const [path, content] of entries) {
      if (typeof content !== "string" || content.length > MAX_DRAFT_CHARACTERS) return jsonError("A document is too large to compile.", 413);
      total += content.length;
      drafts[path] = content;
    }
    if (total > MAX_TOTAL_CHARACTERS) return jsonError("The documents are too large to compile.", 413);
  }

  try {
    return NextResponse.json(await compileLatexDocument({ rootPath: body.rootPath, engine, drafts }, request.signal));
  } catch (error) {
    if (request.signal.aborted) return jsonError("Compile canceled.", 499);
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }
}
