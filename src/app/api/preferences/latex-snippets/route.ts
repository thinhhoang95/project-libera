import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { createLatexSnippet, deleteLatexSnippet, LatexSnippetError, readLatexSnippets, renameLatexSnippet } from "@/lib/latex/snippet-storage";

export const runtime = "nodejs";

function failure(error: unknown, fallback: string) {
  return error instanceof LatexSnippetError ? jsonError(error.message, error.status) : jsonError(fallback, 500);
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json({ snippets: await readLatexSnippets() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error, "Could not load your LaTeX snippets."); }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Send a snippet name and body.", 400);
  try {
    return NextResponse.json({ snippets: await createLatexSnippet(body) });
  } catch (error) { return failure(error, "Could not save the snippet. Please retry."); }
}

export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = await request.json().catch(() => null);
  if (typeof body?.id !== "string") return jsonError("Snippet id is required.", 400);
  try {
    return NextResponse.json({ snippets: await renameLatexSnippet(body.id, body.name) });
  } catch (error) { return failure(error, "Could not rename the snippet. Please retry."); }
}

export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return jsonError("Snippet id is required.", 400);
  try {
    return NextResponse.json({ snippets: await deleteLatexSnippet(id) });
  } catch (error) { return failure(error, "Could not delete the snippet. Please retry."); }
}
