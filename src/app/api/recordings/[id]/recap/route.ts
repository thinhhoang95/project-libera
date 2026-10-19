import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { refreshRecordingRecap } from "@/lib/recording/sessions";
import { toStorageError } from "@/lib/storage/errors";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** Bring the live recap up to date now; poll GET /api/recordings/:id for the bullets. */
export async function POST(request: NextRequest, context: Context) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const { id } = await context.params;
    return NextResponse.json(await refreshRecordingRecap(id));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
