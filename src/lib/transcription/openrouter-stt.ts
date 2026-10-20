import { getOpenRouterApiKey } from "@/lib/openrouter";
import { wordsFromSegments, type TimedWord } from "@/lib/transcription/plan";

const OPENROUTER_TRANSCRIPTIONS_URL = "https://openrouter.ai/api/v1/audio/transcriptions";

/**
 * How much timing a model returns. Not every provider supports verbose JSON or
 * word timestamps; the first refusal is remembered per model, so the rest of a
 * recording (and later ones) ask for what works.
 */
type Detail = "words" | "segments" | "text";
const supportedDetail = new Map<string, Detail>();
const DETAILS: Detail[] = ["words", "segments", "text"];

type SttSegment = { start?: number; end?: number; text?: string };
type SttWord = { start?: number; end?: number; word?: string; type?: string };
type SttResponse = { text?: string; language?: string; segments?: SttSegment[]; words?: SttWord[]; error?: { message?: string } };

export type RemotePiece = { words: TimedWord[]; language: string };

function requestBody(model: string, base64: string, language: string, detail: Detail) {
  return {
    model,
    input_audio: { data: base64, format: "wav" },
    temperature: 0,
    ...(language ? { language } : {}),
    ...(detail === "text" ? {} : {
      response_format: "verbose_json",
      timestamp_granularities: detail === "words" ? ["word", "segment"] : ["segment"],
    }),
  };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Timed words from whatever the service returned, placed at `offset` seconds into the recording. */
export function wordsFromResponse(response: SttResponse, offset: number, pieceSeconds: number): TimedWord[] {
  const words = (response.words ?? [])
    .filter((word) => word.type !== "audio_event" && typeof word.word === "string" && word.word.trim() && finite(word.start) && finite(word.end))
    .map((word) => ({ start: offset + word.start!, end: offset + word.end!, text: word.word!.trim() }));
  if (words.length) return words;
  const segments = (response.segments ?? [])
    .filter((segment) => typeof segment.text === "string" && finite(segment.start) && finite(segment.end))
    .map((segment) => ({ start: segment.start!, end: segment.end!, text: segment.text! }));
  if (segments.length) return wordsFromSegments(segments, offset);
  // Text only: spread it over the piece, so speakers can still be attributed roughly.
  const text = response.text?.trim();
  return text ? wordsFromSegments([{ start: 0, end: pieceSeconds, text }], offset) : [];
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Cancelled."));
    }, { once: true });
  });
}

/**
 * Transcribe one WAV piece with an OpenRouter speech-to-text model. Busy or
 * failing providers are retried with backoff; a request refused for asking for
 * timestamps is repeated asking for less.
 */
export async function transcribeWithOpenRouter(wav: Uint8Array, { model, language, offset, pieceSeconds, signal }: {
  model: string;
  language: string;
  offset: number;
  pieceSeconds: number;
  signal?: AbortSignal;
}): Promise<RemotePiece> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) throw new Error("Add an OpenRouter API key in Preferences to transcribe with OpenRouter.");
  const base64 = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength).toString("base64");

  let detail = supportedDetail.get(model) ?? "words";
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    const response = await fetch(OPENROUTER_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
        "X-Title": process.env.OPENROUTER_APP_NAME ?? "Libera",
      },
      body: JSON.stringify(requestBody(model, base64, language, detail)),
      signal,
    });
    const payload = await response.json().catch(() => ({})) as SttResponse;

    if (response.ok) {
      supportedDetail.set(model, detail);
      return { words: wordsFromResponse(payload, offset, pieceSeconds), language: typeof payload.language === "string" ? payload.language : "" };
    }

    const message = payload.error?.message || `OpenRouter returned ${response.status}.`;
    const next = DETAILS[DETAILS.indexOf(detail) + 1];
    if (response.status === 400 && next && /verbose|timestamp|granularit|response_format|format/i.test(message)) {
      detail = next;
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await wait(1500 * 2 ** attempt, signal);
      continue;
    }
    if (response.status === 401) throw new Error("OpenRouter did not accept the API key. Check it in Preferences.");
    if (response.status === 402) throw new Error("OpenRouter needs more credits to transcribe this recording.");
    if (response.status === 413) throw new Error("OpenRouter refused a piece of the recording as too large.");
    throw new Error(`${model}: ${message}`);
  }
}
