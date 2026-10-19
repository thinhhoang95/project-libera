/** Shared by the transcription server code and the voice memo viewer. Nothing here may touch the server. */

export const TRANSCRIPT_VERSION = 1;

/** One stretch of speech by one speaker. Times are seconds from the start of the recording. */
export type TranscriptSegment = {
  start: number;
  end: number;
  /** Index into `Transcript.speakers`; null when no speaker could be told apart. */
  speaker: number | null;
  text: string;
};

export type TranscriptSpeaker = {
  /** "Speaker 1" until renamed. */
  name: string;
  /** Seconds this speaker talks, from diarization (overlapping speech counts for each speaker). */
  talkSeconds: number;
  /** Share of all speech, 0–1. */
  share: number;
  /** Number of transcript segments attributed to this speaker. */
  segments: number;
};

/** What pyannote found, kept with the transcript. */
export type TranscriptDiarization = {
  segmentationModel: string;
  embeddingModel: string;
  /** Speakers found (or the number asked for in Preferences). */
  speakerCount: number;
  /** 0 when the count was detected. */
  requestedSpeakers: number;
  /** Speaker turns pyannote returned. */
  turns: number;
  /** Seconds of speech, and of speech where two or more people talk at once. */
  speechSeconds: number;
  overlapSeconds: number;
};

export type Transcript = {
  version: typeof TRANSCRIPT_VERSION;
  createdAt: string;
  /** Size and modification time of the audio it was made from, to tell when the audio changed. */
  audio: { size: number; modifiedAt: string; duration: number };
  engine: { kind: "local" | "openrouter"; model: string };
  /** The language asked for or detected; empty when unknown. */
  language: string;
  diarization: TranscriptDiarization | null;
  speakers: TranscriptSpeaker[];
  segments: TranscriptSegment[];
  stats: { words: number; chunks: number; elapsedMs: number };
};

export type TranscriptionJobState = "queued" | "decoding" | "diarizing" | "transcribing" | "saving" | "done" | "error" | "cancelled";

export type TranscriptionJob = {
  path: string;
  state: TranscriptionJobState;
  engine: "local" | "openrouter";
  /** 0–1 across the whole job. */
  progress: number;
  /** Chunks transcribed and to transcribe, once known. */
  done: number;
  total: number;
  /** Seconds of audio, once decoded. */
  duration?: number;
  startedAt: string;
  error?: string;
};

/** Whether the local models and an audio decoder are in place, for the viewer and Preferences. */
export type TranscriptionSetupStatus = {
  engine: "local" | "openrouter";
  openRouterModel: string;
  diarization: boolean;
  models: SpeechModelsStatus;
  decoder: { available: boolean; kind: "ffmpeg" | "afconvert" | "wav-only"; path: string };
  hasApiKey: boolean;
};

export type SpeechModelsStatus = {
  /** "unconfigured": no folder chosen; "missing": the folder lacks a model. */
  state: "unconfigured" | "missing" | "downloading" | "ready" | "error";
  directory: string;
  /** Which parts are in the folder. */
  asr: boolean;
  segmentation: boolean;
  embedding: boolean;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
};

/** GET /api/transcripts?path=… */
export type TranscriptPayload = {
  path: string;
  transcript: Transcript | null;
  /** The audio changed after the transcript was made. */
  stale: boolean;
  /** In a shared notebook: the members see this transcript too. */
  shared?: boolean;
  job: TranscriptionJob | null;
};

/** GET /api/audio/peaks?path=… : a waveform overview, each value the loudest sample in its bucket (0–1). */
export type AudioPeaksPayload = {
  duration: number;
  peaks: number[];
};
