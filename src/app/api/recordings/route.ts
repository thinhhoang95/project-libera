import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { createRecording, listUnfinishedRecordings } from "@/lib/recording/sessions";
import { toStorageError } from "@/lib/storage/errors";

export const runtime = "nodejs";

/** Recordings left unfinished, for example by a crash, to save or record on. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  return NextResponse.json({ recordings: await listUnfinishedRecordings() });
}

/** Start a recording: `{ notebook, parentPath?, name?, liveTranscribe?, liveRecap? }`. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await createRecording({
      notebook: typeof body.notebook === "string" ? body.notebook : undefined,
      parentPath: typeof body.parentPath === "string" ? body.parentPath : undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      liveTranscribe: body.liveTranscribe === true,
      liveRecap: body.liveRecap === true,
    }));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
