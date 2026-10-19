import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage/errors";
import { changePdfComments, readPdfComments, type PdfCommentAction } from "@/lib/storage/pdf-comments";

export const runtime = "nodejs";

// Review comments on a PDF (src/lib/storage/pdf-comments.ts). GET lists the
// threads; POST applies one Comments-panel action and returns them all.

function handleError(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await readPdfComments(request.nextUrl.searchParams.get("path") ?? ""));
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const raw = await request.text();
    if (raw.length > 1_000_000) return NextResponse.json({ error: "Comment request is too large." }, { status: 413 });
    const body = JSON.parse(raw) as PdfCommentAction & { path?: unknown };
    return NextResponse.json(await changePdfComments(typeof body.path === "string" ? body.path : "", body));
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid comment request." }, { status: 400 });
    return handleError(error);
  }
}
