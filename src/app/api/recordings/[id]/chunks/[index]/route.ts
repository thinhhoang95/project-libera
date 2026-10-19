import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { saveRecordingChunk } from "@/lib/recording/sessions";
import { toStorageError } from "@/lib/storage/errors";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; index: string }> };

/** A chunk of the recording (16 kHz mono WAV in the body) that starts `?start=` samples in. */
export async function PUT(request: NextRequest, context: Context) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const { id, index } = await context.params;
    const start = Number(request.nextUrl.searchParams.get("start"));
    return NextResponse.json(await saveRecordingChunk(id, Number(index), start, new Uint8Array(await request.arrayBuffer())));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
