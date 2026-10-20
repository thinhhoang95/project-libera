export type TtsPreferences = {
  /** "local" runs Kokoro 82M on this computer; "openrouter" sends the text to an OpenRouter speech model. */
  engine: "local" | "openrouter";
  /** An OpenRouter text-to-speech model, such as hexgrad/kokoro-82m. */
  openRouterModel: string;
  /** The OpenRouter voice; empty uses the provider's default. */
  openRouterVoice: string;
  /** The extracted sherpa-onnx Kokoro folder; empty when not chosen. */
  modelDirectory: string;
  /** A Kokoro voice name such as af_heart, or a speaker number. */
  localVoice: string;
  /** Speaking rate, 0.5–2. */
  speed: number;
};

export const DEFAULT_TTS_PREFERENCES: Readonly<TtsPreferences>;
export const MIN_SPEED: number;
export const MAX_SPEED: number;
export const TTS_ENGINES: TtsPreferences["engine"][];
export type KokoroFolderReport = {
  ok: boolean;
  exists: boolean;
  /** Required files and folders that are not there. */
  missing: string[];
  /** Voices in voices.bin: 53 for v1.0, 11 for v0.19, 103 for v1.1. */
  voices: number;
  /** model.int8.onnx is present (preferred over model.onnx). */
  quantized: boolean;
};

export function inspectKokoroFolder(directory: unknown): KokoroFolderReport;
export function normalizeTtsPreferences(input: unknown): TtsPreferences;
export function ttsPreferencesFromEnvironment(env?: NodeJS.ProcessEnv): TtsPreferences;
