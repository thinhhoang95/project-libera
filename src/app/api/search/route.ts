import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import type { SearchRequest } from "@/lib/global-search";
import { runSearch } from "@/lib/search/query";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  let body: SearchRequest;
  try {
    body = (await request.json()) as SearchRequest;
  } catch {
    return jsonError("The search request is invalid.");
  }

  try {
    return NextResponse.json(await runSearch(body));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
