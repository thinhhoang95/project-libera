export type TranscriptionPreferences = {
  /** "local" runs Parakeet TDT on this computer; "openrouter" sends audio chunks to OpenRouter. */
  engine: "local" | "openrouter";
  /** An OpenRouter speech-to-text model, such as openai/whisper-large-v3. */
  openRouterModel: string;
  /** ISO-639-1 code; empty detects the language. */
  language: string;
  /** The folder holding the local speech models; empty when not chosen. */
  modelDirectory: string;
  /** Label who speaks when, with pyannote on this computer. */
  diarization: boolean;
  /** How many people speak; 0 detects it. */
  speakers: number;
  /** An ffmpeg executable; empty looks for one. */
  ffmpegPath: string;
  /** Speaking prompts into AI Chat, the Agent, Agentic Review, Write with AI and AI Rewrite. */
  dictation: DictationPreferences;
};

export type DictationPreferences = {
  /** "same" follows the voice memo engine. */
  engine: "same" | "local" | "openrouter";
  /** Empty uses the voice memo model. */
  openRouterModel: string;
  /** Empty uses the voice memo language. */
  language: string;
};

export const DEFAULT_TRANSCRIPTION_PREFERENCES: Readonly<TranscriptionPreferences>;
export const MAX_SPEAKERS: number;
export const DICTATION_ENGINES: DictationPreferences["engine"][];
export function resolveDictationSettings(preferences: TranscriptionPreferences): { engine: "local" | "openrouter"; openRouterModel: string; language: string };
export const TRANSCRIPTION_ENGINES: TranscriptionPreferences["engine"][];
export function normalizeTranscriptionPreferences(input: unknown): TranscriptionPreferences;
export function transcriptionPreferencesFromEnvironment(env?: NodeJS.ProcessEnv): TranscriptionPreferences;
