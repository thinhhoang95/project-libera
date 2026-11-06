import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { readNotebookLatexAutoCompile, toStorageError, writeNotebookLatexAutoCompile } from "@/lib/storage";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = toStorageError(error);
  return jsonError(storageError.message, storageError.status);
}

/** Whether edits in this notebook's LaTeX files recompile on their own. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const enabled = await readNotebookLatexAutoCompile(request.nextUrl.searchParams.get("notebook") ?? "");
    return NextResponse.json({ enabled });
  } catch (error) {
    return handleError(error);
  }
}

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const { notebook, enabled } = (await request.json()) as { notebook?: string; enabled?: unknown };
    if (typeof enabled !== "boolean") return jsonError("Say whether Auto Compile is on.", 400);
    await writeNotebookLatexAutoCompile(notebook ?? "", enabled);
    return NextResponse.json({ enabled });
  } catch (error) {
    return handleError(error);
  }
}
