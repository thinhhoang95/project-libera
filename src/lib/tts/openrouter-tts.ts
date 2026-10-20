import { getOpenRouterApiKey } from "@/lib/openrouter";

const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";

type SpeechError = { error?: { message?: string } | string };

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Cancelled."));
    }, { once: true });
  });
}

/** The request OpenRouter's OpenAI-compatible speech endpoint takes. */
export function speechRequestBody({ model, voice, text, speed }: { model: string; voice: string; text: string; speed: number }) {
  return {
    model,
    input: text,
    ...(voice ? { voice } : {}),
    // MP3 plays everywhere and is a tenth of the size of the PCM default.
    response_format: "mp3",
    ...(speed !== 1 ? { speed } : {}),
  };
}

/**
 * Speak one passage with an OpenRouter text-to-speech model. Busy or failing
 * providers are retried with backoff. The audio comes back as MP3.
 */
export async function speakWithOpenRouter({ model, voice, text, speed, signal }: {
  model: string;
  voice: string;
  text: string;
  speed: number;
  signal?: AbortSignal;
}): Promise<{ audio: Uint8Array; contentType: string }> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) throw new Error("Add an OpenRouter API key in Preferences to read aloud with OpenRouter.");

  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    const response = await fetch(OPENROUTER_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
        "X-Title": process.env.OPENROUTER_APP_NAME ?? "Libera",
      },
      body: JSON.stringify(speechRequestBody({ model, voice, text, speed })),
      signal,
    });

    if (response.ok) {
      const audio = new Uint8Array(await response.arrayBuffer());
      if (!audio.byteLength) throw new Error(`${model} returned no audio.`);
      return { audio, contentType: response.headers.get("content-type")?.split(";")[0] || "audio/mpeg" };
    }

    const payload = await response.json().catch(() => ({})) as SpeechError;
    const message = (typeof payload.error === "string" ? payload.error : payload.error?.message) || `OpenRouter returned ${response.status}.`;
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await wait(1000 * 2 ** attempt, signal);
      continue;
    }
    if (response.status === 401) throw new Error("OpenRouter did not accept the API key. Check it in Preferences.");
    if (response.status === 402) throw new Error("OpenRouter needs more credits to read aloud.");
    throw new Error(`${model}: ${message}`);
  }
}
