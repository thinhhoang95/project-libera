import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getOpenRouterApiKey } from "@/lib/openrouter";
import { cancelSpeechModelsDownload, getSpeechModelsStatus, startSpeechModelsDownload } from "@/lib/transcription/models";
import { findAudioDecoder, getTranscriptionPreferences } from "@/lib/transcription/settings";
import type { TranscriptionSetupStatus } from "@/lib/transcription/types";

export const runtime = "nodejs";

async function status() {
  const preferences = getTranscriptionPreferences();
  const decoder = await findAudioDecoder(preferences);
  const payload: TranscriptionSetupStatus = {
    engine: preferences.engine,
    openRouterModel: preferences.openRouterModel,
    diarization: preferences.diarization,
    models: await getSpeechModelsStatus(),
    decoder: { available: decoder.kind !== "wav-only", kind: decoder.kind, path: decoder.path },
    hasApiKey: Boolean(getOpenRouterApiKey()),
  };
  return NextResponse.json(payload);
}

/** What transcription needs and has: the engine, local models, an audio decoder and an API key. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  return status();
}

/** Download the speech models (`{ only: "diarization" }` for just the speaker models); poll GET for progress. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const body = (await request.json().catch(() => ({}))) as { only?: unknown };
    startSpeechModelsDownload({ only: body.only === "diarization" ? "diarization" : undefined });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not start the download.", 409);
  }
  return status();
}

/** Cancel a running download. The files so far are kept so it can resume. */
export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  cancelSpeechModelsDownload();
  return status();
}
