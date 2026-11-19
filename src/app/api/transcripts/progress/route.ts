import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getTranscriptionJobs } from "@/lib/transcription/jobs";
import type { TranscriptProgressPayload } from "@/lib/transcription/types";

export const runtime = "nodejs";

/**
 * The state of a recording's transcription job and nothing else: no
 * transcript, no recording read, no hashing. The viewer polls this while a job
 * runs and fetches the full transcript once when it has finished.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const path = request.nextUrl.searchParams.get("path") ?? "";
  const payload: TranscriptProgressPayload = { path, job: getTranscriptionJobs().get(path) };
  return NextResponse.json(payload);
}
