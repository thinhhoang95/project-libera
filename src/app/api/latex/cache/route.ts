import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { clearLatexBuildCache, listLatexBuildCache } from "@/lib/latex/build";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_FILES = 2000;

/** Build files cached for a main .tex file. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const rootPath = request.nextUrl.searchParams.get("path") ?? "";
  if (!rootPath) return jsonError("Choose a LaTeX file.", 400);
  try {
    return NextResponse.json({ files: await listLatexBuildCache(rootPath) });
  } catch (error) {
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }
}

/** Delete the chosen build files so the next compile starts clean. */
export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = (await request.json().catch(() => null)) as { rootPath?: unknown; files?: unknown } | null;
  if (typeof body?.rootPath !== "string" || !body.rootPath) return jsonError("Choose a LaTeX file.", 400);
  if (!Array.isArray(body.files) || body.files.length > MAX_FILES || !body.files.every((file) => typeof file === "string")) return jsonError("Invalid file list.", 400);
  try {
    return NextResponse.json(await clearLatexBuildCache(body.rootPath, body.files as string[]));
  } catch (error) {
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }
}
