import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { writeLastNotebookName } from "@/lib/storage/last-notebook";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = await request.json().catch(() => null);
  if (typeof body?.notebook !== "string" || !body.notebook.trim()) return jsonError("Notebook is required.", 400);
  try {
    await writeLastNotebookName(body.notebook);
    return NextResponse.json({ notebook: body.notebook });
  } catch (error) {
    const failure = toStorageError(error);
    return jsonError(failure.message, failure.status);
  }
}
