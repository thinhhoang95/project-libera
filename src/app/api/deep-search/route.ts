import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { deepSearch, toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const query = request.nextUrl.searchParams.get("q") ?? "";
    return NextResponse.json(await deepSearch(query));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
