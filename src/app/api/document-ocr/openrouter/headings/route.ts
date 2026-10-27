import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import type { MarkdownHeading } from "@/lib/document-ocr/markdown-pages";
import { tidyHeadingLevels } from "@/lib/document-ocr/openrouter-pages";

export const runtime = "nodejs";

const MAX_HEADINGS = 3000;

/** Consistent levels for the headings of a PDF read page by page: `{ levels }`, or `{ levels: null }` to keep them. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const body = (await request.json()) as { headings?: unknown };
    const input = Array.isArray(body.headings) ? body.headings : [];
    const headings = input.flatMap((heading): MarkdownHeading[] => {
      const { level, text, page } = (heading ?? {}) as Partial<MarkdownHeading>;
      return typeof level === "number" && typeof text === "string" && typeof page === "number" ? [{ level, text, page }] : [];
    });
    // Levels must line up with the client's headings, one for one.
    if (headings.length !== input.length || headings.length > MAX_HEADINGS) return NextResponse.json({ levels: null });
    return NextResponse.json({ levels: await tidyHeadingLevels(headings, request.signal) });
  } catch (error) {
    if (request.signal.aborted) return jsonError("Cancelled.", 499);
    return jsonError(error instanceof Error ? error.message : "Could not tidy the headings.", 502);
  }
}
