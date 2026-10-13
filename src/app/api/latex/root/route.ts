import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { findLatexRoot } from "@/lib/latex/root";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

/** The main .tex file that typesets the given chapter file, if any. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const filePath = request.nextUrl.searchParams.get("path") ?? "";
  if (!/\.tex$/i.test(filePath)) return jsonError("Choose a .tex file.", 400);
  try {
    return NextResponse.json({ rootPath: await findLatexRoot(filePath) });
  } catch (error) {
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }
}
