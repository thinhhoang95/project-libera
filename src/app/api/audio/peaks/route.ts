import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { readAudioPeaks } from "@/lib/transcription/peaks";

export const runtime = "nodejs";

/** A recording's waveform overview for the voice memo player. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const peaks = await readAudioPeaks(request.nextUrl.searchParams.get("path") ?? "");
    return NextResponse.json(peaks, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (error) {
    if (error instanceof StorageError || (error as { code?: string })?.code) {
      const storageError = toStorageError(error);
      return jsonError(storageError.message, storageError.status);
    }
    return jsonError(error instanceof Error ? error.message : "Could not draw the waveform.", 500);
  }
}
