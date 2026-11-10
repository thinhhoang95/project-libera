import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { writeMarkdownDisplayPreferences } from "@/lib/storage/markdown-display-preferences";

export const runtime = "nodejs";

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = await request.json().catch(() => null);
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const optionalFinite = (value: unknown) => value === undefined || finite(value);
  if (!body || !finite(body.textWidth) || !finite(body.textScale) ||
      !optionalFinite(body.outlineExpansionLevel) || !optionalFinite(body.latexTextWidth) ||
      !optionalFinite(body.codeTextWidth) || (body.latexSpellcheck !== undefined && typeof body.latexSpellcheck !== "boolean")) {
    return jsonError("Display settings must be finite numbers.", 400);
  }
  try {
    return NextResponse.json(await writeMarkdownDisplayPreferences(body));
  } catch {
    return jsonError("Unable to save Markdown display settings.", 500);
  }
}
