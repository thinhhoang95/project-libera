import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getSearchIndexer } from "@/lib/search/indexer";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

/** Index and model status. `?scan=1` also starts a pass when the last one is not recent. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const indexer = getSearchIndexer();
    if (request.nextUrl.searchParams.get("scan") === "1") indexer.requestScan();
    return NextResponse.json(indexer.status());
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
