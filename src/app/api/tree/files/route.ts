import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getFileMetadata, toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

/** Metadata for a few files, so a shared edit need not read the whole library. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as { paths?: unknown };
    const paths = Array.isArray(body.paths) ? body.paths.filter((entry): entry is string => typeof entry === "string") : [];
    return NextResponse.json({ files: await getFileMetadata(paths) });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
