import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { MAX_DICTATION_BYTES, transcribeDictation } from "@/lib/transcription/dictation";

export const runtime = "nodejs";

/** A spoken prompt (16 kHz mono WAV in the body) as text: `{ text }`. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_DICTATION_BYTES) return jsonError("The recording is too long to dictate. Keep it under ten minutes.", 413);
  try {
    const wav = new Uint8Array(await request.arrayBuffer());
    if (wav.byteLength > MAX_DICTATION_BYTES) return jsonError("The recording is too long to dictate. Keep it under ten minutes.", 413);
    return NextResponse.json(await transcribeDictation(wav, { signal: request.signal }));
  } catch (error) {
    if (request.signal.aborted) return jsonError("Cancelled.", 499);
    return jsonError(error instanceof Error ? error.message : "Could not transcribe the recording.", 500);
  }
}
