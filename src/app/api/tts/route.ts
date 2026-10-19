import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getOpenRouterApiKey } from "@/lib/openrouter";
import { resolveKokoroModel } from "@/lib/tts/kokoro";
import { speakWithOpenRouter } from "@/lib/tts/openrouter-tts";
import { getTtsPreferences } from "@/lib/tts/settings";
import { MAX_TTS_REQUEST_CHARS } from "@/lib/tts/text";
import { getTtsWorker } from "@/lib/tts/worker-client";

export const runtime = "nodejs";

/** Which engine reads aloud, and whether it is ready: the local folder resolves, or there is an API key. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const preferences = getTtsPreferences();
  let ready = true;
  let problem = "";
  if (preferences.engine === "local") {
    try {
      await resolveKokoroModel(preferences.modelDirectory, preferences.localVoice);
    } catch (error) {
      ready = false;
      problem = error instanceof Error ? error.message : String(error);
    }
  } else if (!getOpenRouterApiKey()) {
    ready = false;
    problem = "Add an OpenRouter API key in Preferences to read aloud with OpenRouter.";
  }
  return NextResponse.json({ engine: preferences.engine, ready, problem });
}

/**
 * Speak one passage (`{ text }`, up to MAX_TTS_REQUEST_CHARS) with the engine
 * chosen in Preferences → Read Aloud. The browser splits longer text and
 * asks for each passage in turn. Returns WAV (Kokoro on this computer) or MP3
 * (OpenRouter).
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  let text: string;
  try {
    const body = (await request.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return jsonError("Send the text to read aloud.", 400);
  }
  if (!text) return jsonError("There is no text to read aloud.", 400);
  if (text.length > MAX_TTS_REQUEST_CHARS) return jsonError("This passage is too long to read aloud in one request.", 413);

  const preferences = getTtsPreferences();
  try {
    if (preferences.engine === "local") {
      const model = await resolveKokoroModel(preferences.modelDirectory, preferences.localVoice);
      const wav = await getTtsWorker().synthesize(model.files, text, model.sid, preferences.speed, request.signal);
      return new NextResponse(new Uint8Array(wav), {
        headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
      });
    }
    const { audio, contentType } = await speakWithOpenRouter({
      model: preferences.openRouterModel,
      voice: preferences.openRouterVoice,
      text,
      speed: preferences.speed,
      signal: request.signal,
    });
    return new NextResponse(new Uint8Array(audio), {
      headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (request.signal.aborted) return new NextResponse(null, { status: 499 });
    return jsonError(error instanceof Error ? error.message : "Could not read the text aloud.", 502);
  }
}
