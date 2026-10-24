"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { encodeWav } from "@/components/libera/audio/dictation";
import type { RecapEdit } from "@/lib/recording/recap";
import { RECORDING_SAMPLE_RATE, type FinishedRecording, type RecordingRecap, type RecordingStatus } from "@/lib/recording/types";
import type { SegmentEdits } from "@/lib/transcription/edits";
import type { TranscriptSegment, TranscriptionSetupStatus } from "@/lib/transcription/types";

// Copies the microphone's samples to the window; a worklet keeps recording
// smooth while the app is busy.
const WORKLET = `
class LiberaMeetingRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("libera-meeting-recorder", LiberaMeetingRecorder);
`;

/**
 * Chunks end at a pause in speech once they are this long, so a crash loses
 * little and Parakeet hears whole phrases; one that runs on is cut at its
 * quietest moment near the end.
 */
const MIN_CHUNK_SECONDS = 5;
const MAX_CHUNK_SECONDS = 18;
const QUIET_FRAMES = 30; // About a quarter of a second of 128-sample frames.
const POLL_MS = 2_000;
const PREFERENCES_KEY = "libera.recorder.live";
/** Loudness readings kept for the level meter, one per 120 ms of audio: about 20 seconds. */
const LEVEL_HISTORY = 160;
const LEVEL_STEP_SAMPLES = Math.round(RECORDING_SAMPLE_RATE * 0.12);

export type RecorderState = "idle" | "starting" | "recording" | "paused" | "stopping" | "error";

type Capture = { context: AudioContext; stream: MediaStream; node: AudioWorkletNode };

type Pending = { frames: Float32Array[]; rms: number[]; samples: number; threshold: number; thresholdAt: number };

type Upload = { index: number; start: number; wav: Uint8Array };

function readLivePreferences() {
  try {
    const value = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? "null") as { transcribe?: boolean; recap?: boolean } | null;
    return { transcribe: value?.transcribe !== false, recap: value?.recap !== false };
  } catch {
    return { transcribe: true, recap: true };
  }
}

function writeLivePreferences(value: { transcribe: boolean; recap: boolean }) {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value));
  } catch {
    // Remembering the switches is a convenience.
  }
}

const emptyPending = (): Pending => ({ frames: [], rms: [], samples: 0, threshold: 0.004, thresholdAt: 0 });

/** Below which a frame counts as a pause: a little above this chunk's quieter frames. */
function quietThreshold(rms: number[]) {
  const sorted = rms.slice(-1200).sort((a, b) => a - b);
  return Math.max(0.004, (sorted[Math.floor(sorted.length * 0.2)] ?? 0) * 1.6);
}

/**
 * Records a meeting into a notebook. The audio goes to the server in chunks
 * of a few seconds while recording (the server keeps them on disk until the
 * recording is saved), so a crash loses at most the chunk being recorded. The
 * server transcribes the chunks with Parakeet and amends the recap; the
 * recorder polls for both. The reader's corrections to either are sent when
 * their editing ends, in order, and saving the recording waits for them.
 */
export function useMeetingRecorder({ onSaved }: { onSaved: (finished: FinishedRecording, notebook: string, recordingId: string) => void }) {
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState("");
  const [session, setSession] = useState<RecordingStatus | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [transcriptEdits, setTranscriptEdits] = useState<SegmentEdits | null>(null);
  const [recap, setRecap] = useState<RecordingRecap | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  /** Seconds of audio not yet on disk, when the server cannot be reached. */
  const [unsavedSeconds, setUnsavedSeconds] = useState(0);
  const [setup, setSetup] = useState<TranscriptionSetupStatus | null>(null);
  const [saving, setSaving] = useState(false);

  const capture = useRef<Capture | null>(null);
  const pending = useRef<Pending>(emptyPending());
  const paused = useRef(false);
  const sessionId = useRef<string | null>(null);
  /** Samples handed to the upload queue, and the next chunk's number. */
  const sentSamples = useRef(0);
  const nextIndex = useRef(0);
  const uploads = useRef<Upload[]>([]);
  const uploading = useRef<Promise<void> | null>(null);
  /** The loudest frame of the current level step, and the steps so far (newest last). */
  const loudness = useRef({ peak: 0, samples: 0 });
  const levelHistory = useRef<number[]>([]);
  const segmentCount = useRef(0);
  /** Bumped by each start and by cancelling one, so a start that was given up on stops. */
  const starts = useRef(0);
  const recapVersion = useRef(-1);
  const newestRecap = useRef(-1);
  /** The reader's edits being sent, one after another. */
  const editSaves = useRef<Promise<unknown>>(Promise.resolve());
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const refreshSetup = useCallback(async () => {
    const status = await apiRequest<TranscriptionSetupStatus>("/api/transcripts/setup").catch(() => null);
    if (status) setSetup(status);
    return status;
  }, []);

  // Download progress for the speech models, while they come in.
  useEffect(() => {
    if (setup?.models.state !== "downloading") return;
    const timer = window.setInterval(() => void refreshSetup(), 1500);
    return () => window.clearInterval(timer);
  }, [setup?.models.state, refreshSetup]);

  const updateUnsaved = useCallback(() => {
    setUnsavedSeconds(uploads.current.reduce((total, upload) => total + (upload.wav.byteLength - 44) / 2, 0) / RECORDING_SAMPLE_RATE);
  }, []);

  /** Sends the queued chunks in order, retrying until the server has each one. */
  const drainUploads = useCallback(() => {
    if (uploading.current) return uploading.current;
    const run = (async () => {
      let delay = 1000;
      while (uploads.current.length && sessionId.current) {
        const upload = uploads.current[0];
        try {
          const response = await fetch(`/api/recordings/${sessionId.current}/chunks/${upload.index}?start=${upload.start}`, {
            method: "PUT",
            headers: { "Content-Type": "audio/wav" },
            body: upload.wav as BodyInit,
          });
          if (!response.ok && response.status < 500) {
            // Refused for good (malformed, or the recording is gone); keep the rest moving.
            console.warn(`A recording chunk was refused: ${response.status}`);
          } else if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          uploads.current.shift();
          delay = 1000;
          updateUnsaved();
        } catch {
          updateUnsaved();
          await new Promise((resolve) => window.setTimeout(resolve, delay));
          delay = Math.min(10_000, delay * 2);
        }
      }
    })().finally(() => {
      uploading.current = null;
    });
    uploading.current = run;
    return run;
  }, [updateUnsaved]);

  /** Ends the chunk being recorded after `frameCount` frames (all of it by default) and queues it. */
  const cut = useCallback((frameCount?: number) => {
    const current = pending.current;
    const count = Math.min(current.frames.length, frameCount ?? current.frames.length);
    if (!count) return;
    const frames = current.frames.splice(0, count);
    current.rms.splice(0, count);
    const length = frames.reduce((total, frame) => total + frame.length, 0);
    current.samples -= length;
    const samples = new Float32Array(length);
    let offset = 0;
    for (const frame of frames) {
      samples.set(frame, offset);
      offset += frame.length;
    }
    uploads.current.push({ index: nextIndex.current, start: sentSamples.current, wav: encodeWav(samples, RECORDING_SAMPLE_RATE) });
    nextIndex.current += 1;
    sentSamples.current += length;
    void drainUploads();
  }, [drainUploads]);

  const onFrame = useCallback((frame: Float32Array) => {
    if (paused.current) return;
    let sum = 0;
    for (const sample of frame) sum += sample * sample;
    const rms = Math.sqrt(sum / frame.length);
    // One level per step of recorded audio, so the meter follows the audio even when timers are throttled.
    const level = loudness.current;
    level.peak = Math.max(level.peak, Math.min(1, rms * 6));
    level.samples += frame.length;
    if (level.samples >= LEVEL_STEP_SAMPLES) {
      levelHistory.current = [...levelHistory.current.slice(-(LEVEL_HISTORY - 1)), level.peak];
      level.peak = 0;
      level.samples = 0;
    }
    const current = pending.current;
    current.frames.push(frame);
    current.rms.push(rms);
    current.samples += frame.length;
    const length = current.samples / RECORDING_SAMPLE_RATE;
    if (length < MIN_CHUNK_SECONDS) return;
    if (current.rms.length - current.thresholdAt > 60) {
      current.threshold = quietThreshold(current.rms);
      current.thresholdAt = current.rms.length;
    }
    const tail = current.rms.slice(-QUIET_FRAMES);
    if (tail.reduce((total, value) => total + value, 0) / tail.length < current.threshold) {
      cut();
      return;
    }
    if (length >= MAX_CHUNK_SECONDS) {
      // The quietest quarter second in the last four seconds.
      const from = Math.max(0, current.rms.length - Math.round((4 * RECORDING_SAMPLE_RATE) / frame.length));
      let best = current.rms.length;
      let bestValue = Number.POSITIVE_INFINITY;
      for (let index = from; index + QUIET_FRAMES <= current.rms.length; index += 4) {
        let total = 0;
        for (let offset = 0; offset < QUIET_FRAMES; offset += 1) total += current.rms[index + offset];
        if (total < bestValue) {
          bestValue = total;
          best = index + Math.floor(QUIET_FRAMES / 2);
        }
      }
      cut(best);
    }
  }, [cut]);

  const releaseCapture = useCallback(() => {
    const current = capture.current;
    capture.current = null;
    if (!current) return;
    current.node.port.onmessage = null;
    current.node.disconnect();
    current.stream.getTracks().forEach((track) => track.stop());
    void current.context.close().catch(() => undefined);
  }, []);

  const openMicrophone = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    try {
      const context = new AudioContext({ sampleRate: RECORDING_SAMPLE_RATE });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(context, "libera-meeting-recorder");
      node.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data);
      context.createMediaStreamSource(stream).connect(node);
      // A context made after an await can start suspended; the click allows it to run.
      await context.resume().catch(() => undefined);
      // A lost device (unplugged headset) ends the track: keep what was recorded and pause.
      stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => {
        if (capture.current?.stream !== stream || paused.current) return;
        paused.current = true;
        cut();
        setState("paused");
        setError("The microphone was disconnected. Resume to record on.");
      }));
      capture.current = { context, stream, node };
    } catch (failure) {
      stream.getTracks().forEach((track) => track.stop());
      throw failure;
    }
  }, [cut, onFrame]);

  const reset = useCallback(() => {
    releaseCapture();
    sessionId.current = null;
    pending.current = emptyPending();
    uploads.current = [];
    sentSamples.current = 0;
    nextIndex.current = 0;
    segmentCount.current = 0;
    recapVersion.current = -1;
    newestRecap.current = -1;
    paused.current = false;
    setSession(null);
    setSegments([]);
    setTranscriptEdits(null);
    setRecap(null);
    setSeconds(0);
    levelHistory.current = [];
    setLevels([]);
    setUnsavedSeconds(0);
    setSaving(false);
  }, [releaseCapture]);

  const applyStatus = useCallback((status: RecordingStatus) => {
    setSession(status);
    setSegments((previous) => [...previous.slice(0, Math.max(0, Math.min(previous.length, status.segmentsFrom))), ...status.segments]);
    segmentCount.current = status.segmentCount;
    if (status.transcriptEdits !== undefined) setTranscriptEdits(status.transcriptEdits);
    // A poll answered before the reader's edits were saved must not bring back the recap without them.
    if (status.recap && status.recap.version >= newestRecap.current) {
      newestRecap.current = status.recap.version;
      setRecap(status.recap);
      recapVersion.current = status.recap.updating ? -1 : status.recapVersion;
    }
  }, []);

  const micError = (failure: unknown) => failure instanceof DOMException && failure.name === "NotAllowedError"
    ? "Libera may not use the microphone. Allow it in your system's privacy settings."
    : failure instanceof Error ? failure.message : "Could not start the microphone.";

  /** Starts a new recording into `parentPath` (a folder) or the notebook; returns it once recording. */
  const start = useCallback(async (notebook: string, parentPath?: string): Promise<RecordingStatus | null> => {
    if (sessionId.current || capture.current) return null;
    const attempt = ++starts.current;
    setError("");
    setState("starting");
    try {
      const status = await refreshSetup();
      const preferences = readLivePreferences();
      const liveTranscribe = Boolean(status?.models.asr) && preferences.transcribe;
      await openMicrophone();
      if (attempt !== starts.current) {
        releaseCapture();
        return null;
      }
      const created = await apiRequest<RecordingStatus>("/api/recordings", {
        method: "POST",
        body: JSON.stringify({ notebook, parentPath, liveTranscribe, liveRecap: liveTranscribe && Boolean(status?.hasApiKey) && preferences.recap }),
      });
      sessionId.current = created.id;
      applyStatus(created);
      setState("recording");
      return created;
    } catch (failure) {
      if (attempt !== starts.current) return null;
      reset();
      setState("error");
      setError(micError(failure));
      return null;
    }
  }, [applyStatus, openMicrophone, refreshSetup, releaseCapture, reset]);

  /** Gives up on a start still waiting for the microphone (for example on a permission prompt). */
  const cancelStart = useCallback(() => {
    starts.current += 1;
    reset();
    setState("idle");
  }, [reset]);

  /** Records on into a recording left unfinished, after the audio it already has. */
  const resumeUnfinished = useCallback(async (id: string): Promise<RecordingStatus | null> => {
    if (sessionId.current || capture.current) return null;
    setError("");
    setState("starting");
    try {
      const status = await apiRequest<RecordingStatus>(`/api/recordings/${id}`);
      await refreshSetup();
      sessionId.current = status.id;
      sentSamples.current = status.savedSamples;
      nextIndex.current = status.nextIndex;
      applyStatus(status);
      setSeconds(status.savedSeconds);
      // Paused, so nothing is recorded until the user is ready.
      paused.current = true;
      setState("paused");
      return status;
    } catch (failure) {
      reset();
      setState("error");
      setError(failure instanceof Error ? failure.message : "Could not open the recording.");
      return null;
    }
  }, [applyStatus, refreshSetup, reset]);

  const pause = useCallback(() => {
    if (state !== "recording") return;
    paused.current = true;
    cut();
    capture.current?.stream.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    setState("paused");
  }, [cut, state]);

  const resume = useCallback(async () => {
    if (state !== "paused") return;
    setError("");
    try {
      const track = capture.current?.stream.getAudioTracks()[0];
      if (!capture.current || !track || track.readyState === "ended") {
        releaseCapture();
        await openMicrophone();
      } else {
        track.enabled = true;
      }
      paused.current = false;
      setState("recording");
    } catch (failure) {
      setError(micError(failure));
    }
  }, [openMicrophone, releaseCapture, state]);

  /** Stops, sends what is left and saves the recording, its transcript and its recap. */
  const stop = useCallback(async () => {
    const id = sessionId.current;
    if (!id || (state !== "recording" && state !== "paused")) return;
    paused.current = true;
    cut();
    releaseCapture();
    setState("stopping");
    setSaving(true);
    setError("");
    try {
      await editSaves.current;
      await drainUploads();
      const finished = await apiRequest<FinishedRecording>(`/api/recordings/${id}/finish`, { method: "POST" });
      const notebook = session?.notebook ?? "";
      reset();
      setState("idle");
      onSavedRef.current(finished, notebook, id);
    } catch (failure) {
      // The chunks stay on disk; saving can be tried again.
      setSaving(false);
      setState("paused");
      setError(failure instanceof Error ? failure.message : "Could not save the recording.");
    }
  }, [cut, drainUploads, releaseCapture, reset, session, state]);

  const discard = useCallback(async () => {
    const id = sessionId.current;
    reset();
    setState("idle");
    setError("");
    if (id) await apiRequest(`/api/recordings/${id}`, { method: "DELETE" }).catch(() => undefined);
  }, [reset]);

  const update = useCallback(async (changes: { name?: string; liveTranscribe?: boolean; liveRecap?: boolean }) => {
    const id = sessionId.current;
    if (!id) return;
    if (changes.liveTranscribe !== undefined || changes.liveRecap !== undefined) {
      const current = readLivePreferences();
      writeLivePreferences({ transcribe: changes.liveTranscribe ?? current.transcribe, recap: changes.liveRecap ?? current.recap });
    }
    try {
      applyStatus(await apiRequest<RecordingStatus>(`/api/recordings/${id}`, { method: "PATCH", body: JSON.stringify(changes) }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not change the recording.");
    }
  }, [applyStatus]);

  /** Sends the reader's edits after any still on their way; rejects when they could not be kept. */
  const sendEdits = useCallback((changes: { transcriptEdits?: SegmentEdits; recapEdits?: RecapEdit[] }, closing: boolean) => {
    const id = sessionId.current;
    if (!id) return Promise.reject(new Error("The recording is not open."));
    const body = JSON.stringify(changes);
    const send = editSaves.current.catch(() => undefined).then(async () => {
      try {
        // A keepalive request may carry at most 64 KB; more is sent as usual.
        const status = await apiRequest<RecordingStatus>(`/api/recordings/${id}`, { method: "PATCH", keepalive: closing && body.length < 60_000, body });
        if (sessionId.current === id) {
          applyStatus(status);
          // An earlier failure is mended: the edits it kept are saved now.
          setError((current) => (current.startsWith("Your edits could not be saved") ? "" : current));
        }
      } catch (failure) {
        if (sessionId.current === id) setError(failure instanceof Error ? `Your edits could not be saved: ${failure.message}` : "Your edits could not be saved.");
        throw failure;
      }
    });
    editSaves.current = send.catch(() => undefined);
    return send;
  }, [applyStatus]);

  const saveTranscriptEdits = useCallback((edits: SegmentEdits, closing = false) => sendEdits({ transcriptEdits: edits }, closing), [sendEdits]);
  const saveRecapEdits = useCallback((edits: RecapEdit[], closing = false) => sendEdits({ recapEdits: edits }, closing), [sendEdits]);

  const refreshRecap = useCallback(async () => {
    const id = sessionId.current;
    if (!id) return;
    recapVersion.current = -1;
    try {
      applyStatus(await apiRequest<RecordingStatus>(`/api/recordings/${id}/recap`, { method: "POST" }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update the recap.");
    }
  }, [applyStatus]);

  const downloadModels = useCallback(async () => {
    try {
      setSetup(await apiRequest<TranscriptionSetupStatus>("/api/transcripts/setup", { method: "POST", body: JSON.stringify({}) }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the download.");
    }
  }, []);

  // The clock and the level meter. The clock counts recorded audio, so pauses do not add to it.
  const active = state === "recording" || state === "paused" || state === "stopping";
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setSeconds((sentSamples.current + pending.current.samples) / RECORDING_SAMPLE_RATE);
      setLevels(levelHistory.current);
    }, 120);
    return () => window.clearInterval(timer);
  }, [active]);

  // The live transcript and recap.
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      const id = sessionId.current;
      if (id) {
        try {
          const status = await apiRequest<RecordingStatus>(`/api/recordings/${id}?after=${segmentCount.current}&recap=${recapVersion.current}`);
          if (!disposed && sessionId.current === id) applyStatus(status);
        } catch {
          // The next poll tries again.
        }
      }
      if (!disposed) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [active, applyStatus]);

  useEffect(() => () => releaseCapture(), [releaseCapture]);

  return {
    state,
    error,
    clearError: () => setError(""),
    session,
    segments,
    transcriptEdits,
    recap,
    seconds,
    levels,
    unsavedSeconds,
    saving,
    setup,
    start,
    resumeUnfinished,
    cancelStart,
    pause,
    resume,
    stop,
    discard,
    update,
    saveTranscriptEdits,
    saveRecapEdits,
    refreshRecap,
    downloadModels,
    close: () => {
      if (!sessionId.current) {
        setState("idle");
        setError("");
      }
    },
  };
}

export type MeetingRecorder = ReturnType<typeof useMeetingRecorder>;
