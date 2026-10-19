/** Shared by the recording server code and the recorder. Nothing here may touch the server. */

import type { TranscriptSegment } from "@/lib/transcription/types";

/** The recorder's microphone rate; Parakeet listens at 16 kHz too. */
export const RECORDING_SAMPLE_RATE = 16_000;

/** One point of the live recap. Ids are stable, so the model amends a bullet rather than rewriting the list. */
export type RecapBullet = {
  id: number;
  text: string;
  /** Recording seconds when the bullet was added and last changed. */
  addedAt: number;
  changedAt: number;
};

export type RecordingRecap = {
  /** Bumped on every change, so the recorder fetches the bullets only when they move. */
  version: number;
  bullets: RecapBullet[];
  /** Words of the transcript the recap has taken in. */
  wordsRead: number;
  /** Ids added or changed by the latest update, for the recorder to highlight. */
  lastChanged: number[];
  error: string;
  updating: boolean;
};

export type RecordingState = "recording" | "finishing" | "finished";

/** GET /api/recordings/:id */
export type RecordingStatus = {
  id: string;
  name: string;
  notebook: string;
  parentPath: string;
  createdAt: string;
  state: RecordingState;
  /** Seconds of audio saved on disk, and as samples: where the next chunk starts. */
  savedSeconds: number;
  savedSamples: number;
  chunks: number;
  /** The number for the next chunk, when recording on after a crash. */
  nextIndex: number;
  liveTranscribe: boolean;
  liveRecap: boolean;
  /** Chunks still waiting for Parakeet. */
  pendingChunks: number;
  transcribeError: string;
  /** Live transcript segments from `after` on; `segmentCount` is the total. */
  segments: TranscriptSegment[];
  segmentCount: number;
  /** Present when the recap changed since the version the recorder has. */
  recap: RecordingRecap | null;
  recapVersion: number;
};

/** GET /api/recordings: recordings left unfinished (for example by a crash). */
export type UnfinishedRecording = Pick<RecordingStatus, "id" | "name" | "notebook" | "parentPath" | "createdAt" | "savedSeconds" | "chunks">;

/** POST /api/recordings/:id/finish */
export type FinishedRecording = { path: string; recapPath: string | null };
