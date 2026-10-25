import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { discardRecording, getRecordingStatus, updateRecording } from "@/lib/recording/sessions";
import { toStorageError } from "@/lib/storage/errors";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function failure(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

/** The recording so far: `?after=` live transcript segments the recorder has, `?recap=` the recap version it has. */
export async function GET(request: NextRequest, context: Context) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const { id } = await context.params;
    const after = Number(request.nextUrl.searchParams.get("after") ?? 0);
    const recap = Number(request.nextUrl.searchParams.get("recap") ?? -1);
    return NextResponse.json(await getRecordingStatus(id, Number.isFinite(after) ? after : 0, Number.isFinite(recap) ? recap : -1));
  } catch (error) {
    return failure(error);
  }
}

/**
 * Rename, turn live transcription or the live recap on or off, or keep the
 * reader's edits: `{ name?, liveTranscribe?, liveRecap?, transcriptEdits?, recapEdits? }`.
 */
export async function PATCH(request: NextRequest, context: Context) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const { id } = await context.params;
    return NextResponse.json(await updateRecording(id, (await request.json().catch(() => ({}))) as Record<string, unknown>));
  } catch (error) {
    return failure(error);
  }
}

/** Throw the recording away. */
export async function DELETE(request: NextRequest, context: Context) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const { id } = await context.params;
    await discardRecording(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
