import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage/errors";
import { readWorkspaces, writeWorkspaces } from "@/lib/storage/workspaces";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try { return NextResponse.json(await readWorkspaces()); }
  catch (error) {
    const failure = toStorageError(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    await writeWorkspaces(await request.json());
    return NextResponse.json({ saved: true });
  } catch (error) {
    const failure = toStorageError(error);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}
