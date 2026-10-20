"use client";

import { AlertCircle, Check, Loader2, Mic, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatClock } from "@/lib/transcription/format";

const SAMPLE_RATE = 16_000;
/** Dictation is for prompts: a few minutes at most. */
const MAX_SECONDS = 5 * 60;
/** Bars in the level meter, one per 100 ms. */
const METER_BARS = 36;

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
        setLevels((previous) => [...previous.slice(-(METER_BARS - 1)), loudness.current]);
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
  const busy = state === "transcribing" || state === "starting";
  return (
    <button
      type="button"
      className={`relative inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${recording ? "bg-destructive text-destructive-foreground shadow-sm shadow-destructive/40 hover:bg-destructive/90" : busy ? "text-accent" : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"} disabled:cursor-default disabled:opacity-40`}
      aria-label={recording ? "Stop dictating" : "Dictate"}
      title={recording ? "Stop and transcribe" : "Dictate: speak your prompt"}
      disabled={disabled || busy}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => (recording ? void stop() : void start())}
    >
      {recording && <span aria-hidden className="pointer-events-none absolute inset-0 animate-ping rounded-full bg-destructive/40 [animation-duration:1.6s]" />}
      {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : recording ? <Square aria-hidden className="relative h-2.5 w-2.5 rounded-[2px]" fill="currentColor" /> : <Mic aria-hidden className="h-3.5 w-3.5" />}
    </button>
  );
}

/** A centred waveform of the recent loudness, newest on the right, older bars fading out. */
function LevelMeter({ levels, frozen }: { levels: number[]; frozen?: boolean }) {
  return (
    <span aria-hidden className="relative flex h-6 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden">
      {Array.from({ length: METER_BARS }, (_, index) => {
        const value = levels[levels.length - METER_BARS + index] ?? 0;
        const height = Math.max(10, Math.min(100, Math.sqrt(value) * 100));
        return (
          <span
            key={index}
            className={`w-[3px] shrink-0 rounded-full transition-[height] duration-100 ease-out ${frozen ? "animate-pulse bg-accent/70" : "bg-destructive/80"}`}
            style={{ height: `${height}%`, opacity: 0.25 + 0.75 * ((index + 1) / METER_BARS), animationDelay: frozen ? `${(index % 6) * 120}ms` : undefined }}
          />
        );
      })}
    </span>
  );
}

const stripButton = "inline-flex h-6 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

export function DictationStatus({ dictation }: { dictation: ReturnType<typeof useDictation> }) {
  const { state, seconds, levels, error, clearError, stop, cancel } = dictation;
  if (state === "recording") {
    const remaining = MAX_SECONDS - seconds;
    return (
      <div role="status" aria-label="Dictating" className="mb-1.5 flex items-center gap-2.5 rounded-xl border border-destructive/25 bg-destructive/5 py-1 pl-3 pr-1 text-xs shadow-sm">
        <span aria-hidden className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inset-0 animate-ping rounded-full bg-destructive/60" />
          <span className="relative h-2 w-2 rounded-full bg-destructive" />
        </span>
        <span className="flex shrink-0 flex-col leading-tight">
          <span className="font-medium text-foreground">Listening</span>
          <span className={`font-mono text-[10px] tabular-nums ${remaining <= 30 ? "text-destructive" : "text-muted-foreground"}`}>
            {formatClock(seconds)}{remaining <= 30 ? ` · ${Math.ceil(remaining)}s left` : ""}
          </span>
        </span>
        <LevelMeter levels={levels} />
        <button type="button" className={`${stripButton} w-6 text-muted-foreground hover:bg-foreground/10 hover:text-foreground`} aria-label="Cancel dictation" title="Discard" onMouseDown={(event) => event.preventDefault()} onClick={cancel}>
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={`${stripButton} gap-1 bg-primary px-2.5 font-medium text-primary-foreground hover:bg-primary/85`} title="Stop and transcribe" onMouseDown={(event) => event.preventDefault()} onClick={() => void stop()}>
          <Check aria-hidden className="h-3 w-3" /> Done
        </button>
      </div>
    );
  }
  if (state === "transcribing") {
    return (
      <div role="status" className="mb-1.5 flex items-center gap-2.5 rounded-xl border border-border bg-card py-1 pl-3 pr-1 text-xs shadow-sm">
        <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        <span className="shrink-0 font-medium text-foreground">Transcribing…</span>
        <LevelMeter levels={levels} frozen />
        <button type="button" className={`${stripButton} px-2.5 font-medium text-muted-foreground hover:bg-foreground/10 hover:text-foreground`} onMouseDown={(event) => event.preventDefault()} onClick={cancel}>Cancel</button>
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="mb-1.5 flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive-muted py-1.5 pl-3 pr-1.5 text-xs text-destructive">
        <AlertCircle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 leading-relaxed">{error}</span>
        <button type="button" className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-destructive/10" aria-label="Dismiss" onClick={clearError}><X aria-hidden className="h-3 w-3" /></button>
      </div>
    );
  }
  return null;
}
