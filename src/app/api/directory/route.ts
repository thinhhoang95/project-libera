import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import {
  clearRecentDirectories,
  closeDirectory,
  getDirectoryModeSummary,
  openDirectory,
  openFileLocation,
} from "@/lib/storage/directory-mode";
import { toStorageError } from "@/lib/storage/errors";

export const runtime = "nodejs";

function failure(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try { return NextResponse.json(getDirectoryModeSummary()); }
  catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const body = await request.json() as { action?: unknown; name?: unknown; path?: unknown };
    switch (body.action) {
      case "open": return NextResponse.json(await openDirectory(body.path));
      case "open-file": return NextResponse.json(await openFileLocation(body.path));
      case "close": return NextResponse.json(closeDirectory(body.name));
      case "clear-recent": return NextResponse.json(clearRecentDirectories());
      default: return NextResponse.json({ error: "Unknown folder action." }, { status: 400 });
    }
  } catch (error) { return failure(error); }
}
