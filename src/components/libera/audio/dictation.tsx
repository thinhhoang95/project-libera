"use client";

import { Loader2, Mic, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatClock } from "@/lib/transcription/format";

const SAMPLE_RATE = 16_000;
/** Dictation is for prompts: a few minutes at most. */
const MAX_SECONDS = 5 * 60;

// Copies the microphone's samples to the window; a worklet keeps recording
// smooth while the app is busy, unlike the old ScriptProcessorNode.
const WORKLET = `
class LiberaRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("libera-recorder", LiberaRecorder);
`;

/** 16-bit PCM WAV, mono. */
export function encodeWav(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true));
  return new Uint8Array(buffer);
}

type Recording = { context: AudioContext; stream: MediaStream; node: AudioWorkletNode; chunks: Float32Array[]; started: number; timer: number };

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

/**
 * Speaks a prompt: records the microphone at 16 kHz, then sends the WAV to be
 * transcribed with the engine chosen in Preferences → Speech → Dictation.
 */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>("idle");
  const [seconds, setSeconds] = useState(0);
  /** Loudness over the last moments, 0–1, newest last, for the meter. */
  const [levels, setLevels] = useState<number[]>([]);
  const loudness = useRef(0);
  const [error, setError] = useState("");
  const recording = useRef<Recording | null>(null);
  const request = useRef<AbortController | null>(null);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  const release = useCallback(() => {
    const current = recording.current;
    recording.current = null;
    if (!current) return null;
    window.clearInterval(current.timer);
    current.node.port.onmessage = null;
    current.node.disconnect();
    current.stream.getTracks().forEach((track) => track.stop());
    void current.context.close().catch(() => undefined);
    return current;
  }, []);

  const finish = useCallback(async () => {
    const current = release();
    if (!current) return;
    const length = current.chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (length < SAMPLE_RATE * 0.3) {
      setState("idle");
      return;
    }
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of current.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    setState("transcribing");
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch("/api/transcripts/dictate", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: encodeWav(samples, current.context.sampleRate) as BodyInit,
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not transcribe the recording.");
      if (payload.text?.trim()) onTextRef.current(payload.text.trim());
      else setError("No speech was heard.");
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not transcribe the recording.");
    } finally {
      if (request.current === controller) request.current = null;
      setState("idle");
    }
  }, [release]);

  const start = useCallback(async () => {
    if (recording.current || state !== "idle") return;
    setError("");
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(context, "libera-recorder");
      const chunks: Float32Array[] = [];
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        chunks.push(event.data);
        let sum = 0;
        for (const sample of event.data) sum += sample * sample;
        loudness.current = Math.max(loudness.current, Math.min(1, Math.sqrt(sum / event.data.length) * 6));
      };
      context.createMediaStreamSource(stream).connect(node);
      const started = Date.now();
      const timer = window.setInterval(() => {
        const elapsed = (Date.now() - started) / 1000;
        setSeconds(elapsed);
        setLevels((previous) => [...previous.slice(-15), loudness.current]);
        loudness.current = 0;
        if (elapsed >= MAX_SECONDS) void finish();
      }, 100);
      recording.current = { context, stream, node, chunks, started, timer };
      setSeconds(0);
      setLevels([]);
      setState("recording");
    } catch (failure) {
      release();
      setState("idle");
      setError(failure instanceof DOMException && failure.name === "NotAllowedError"
        ? "Libera may not use the microphone. Allow it in your system's privacy settings."
        : failure instanceof Error ? failure.message : "Could not start the microphone.");
    }
  }, [finish, release, state]);

  const cancel = useCallback(() => {
    release();
    request.current?.abort();
    request.current = null;
    setState("idle");
  }, [release]);

  useEffect(() => () => {
    release();
    request.current?.abort();
  }, [release]);

  return { state, seconds, levels, error, clearError: () => setError(""), start, stop: finish, cancel };
}

/**
 * The microphone button of a prompt box, and while recording, a strip with the
 * time, a level meter, Stop and Cancel. The text goes in at the caret.
 */
export function DictationButton({ dictation, disabled }: { dictation: ReturnType<typeof useDictation>; disabled?: boolean }) {
  const { state, start, stop } = dictation;
  const recording = state === "recording";
  return (
    <button
      type="button"
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition ${recording ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:bg-card hover:text-foreground"} disabled:opacity-40`}
      aria-label={recording ? "Stop dictating" : "Dictate"}
      title={recording ? "Stop and transcribe" : "Dictate: speak your prompt"}
      disabled={disabled || state === "starting" || state === "transcribing"}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => (recording ? void stop() : void start())}
    >
      {state === "transcribing" || state === "starting" ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : recording ? <Square aria-hidden className="h-3 w-3" fill="currentColor" /> : <Mic aria-hidden className="h-3.5 w-3.5" />}
    </button>
  );
}

export function DictationStatus({ dictation }: { dictation: ReturnType<typeof useDictation> }) {
  const { state, seconds, levels, error, clearError, stop, cancel } = dictation;
  if (state === "recording") {
    return (
      <div role="status" className="mb-1 flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs">
        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
        <span className="font-mono tabular-nums">{formatClock(seconds)}</span>
        <span aria-hidden className="flex h-4 flex-1 items-center gap-[3px]">
          {Array.from({ length: 16 }, (_, index) => {
            const value = levels[levels.length - 16 + index] ?? 0;
            return <span key={index} className="w-[3px] rounded-full bg-foreground/60 transition-[height] duration-100" style={{ height: `${Math.max(12, Math.min(100, value * 100))}%` }} />;
          })}
        </span>
        <button type="button" className="rounded-md px-2 py-0.5 font-medium hover:bg-muted" onMouseDown={(event) => event.preventDefault()} onClick={() => void stop()}>Done</button>
        <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label="Cancel dictation" onMouseDown={(event) => event.preventDefault()} onClick={cancel}><X aria-hidden className="h-3 w-3" /></button>
      </div>
    );
  }
  if (state === "transcribing") {
    return (
      <div role="status" className="mb-1 flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
        <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> Transcribing…
        <button type="button" className="ml-auto font-medium hover:text-foreground" onClick={cancel}>Cancel</button>
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="mb-1 flex items-start gap-2 rounded-lg bg-destructive-muted px-2.5 py-1.5 text-xs text-destructive">
        <span className="min-w-0 flex-1">{error}</span>
        <button type="button" className="shrink-0" aria-label="Dismiss" onClick={clearError}><X aria-hidden className="h-3 w-3" /></button>
      </div>
    );
  }
  return null;
}
