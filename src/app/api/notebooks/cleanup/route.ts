import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { applyNotebookCleanup, planNotebookCleanup } from "@/lib/storage/cleanup";

export const runtime = "nodejs";

/**
 * Check Notebook → Acknowledge (storage/cleanup.ts). GET plans (reads only);
 * POST `{ notebook, token }` removes what the plan the token names listed.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await planNotebookCleanup(request.nextUrl.searchParams.get("notebook") ?? ""));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const body = (await request.json().catch(() => ({}))) as { notebook?: unknown; token?: unknown };
    if (typeof body.notebook !== "string" || typeof body.token !== "string") return NextResponse.json({ error: "A notebook and a prepared cleanup are needed." }, { status: 400 });
    return NextResponse.json(await applyNotebookCleanup(body.notebook, body.token));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
