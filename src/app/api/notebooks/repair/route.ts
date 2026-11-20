import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { applyNotebookRepair, planNotebookRepair } from "@/lib/storage/repair";
import { settleSharedRecordsBeforeCheck } from "@/lib/storage/shared-record-follow";

export const runtime = "nodejs";

/**
 * Check Notebook → Try to fix (storage/repair.ts). GET plans (reads only);
 * POST `{ notebook, token }` applies the plan the token names.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const notebook = request.nextUrl.searchParams.get("notebook") ?? "";
    // A shared notebook's pending record moves are applied before the plan (the apply re-plans and compares).
    await settleSharedRecordsBeforeCheck(notebook);
    return NextResponse.json(await planNotebookRepair(notebook));
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
    if (typeof body.notebook !== "string" || typeof body.token !== "string") return NextResponse.json({ error: "A notebook and a prepared fix are needed." }, { status: 400 });
    return NextResponse.json(await applyNotebookRepair(body.notebook, body.token));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
