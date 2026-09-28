import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { writeMarkdownDisplayPreferences } from "@/lib/storage/markdown-display-preferences";

export const runtime = "nodejs";

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.textWidth !== "number" || !Number.isFinite(body.textWidth) ||
      typeof body.textScale !== "number" || !Number.isFinite(body.textScale) ||
      (body.outlineExpansionLevel !== undefined &&
        (typeof body.outlineExpansionLevel !== "number" || !Number.isFinite(body.outlineExpansionLevel)))) {
    return jsonError("Display settings must be finite numbers.", 400);
  }
  try {
    return NextResponse.json(await writeMarkdownDisplayPreferences(body));
  } catch {
    return jsonError("Unable to save Markdown display settings.", 500);
  }
}
