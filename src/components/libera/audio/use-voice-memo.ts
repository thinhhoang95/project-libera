"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { subscribeHostEvents } from "@/lib/collab/ui/bridge";
import type { AudioPeaksPayload, TranscriptionJob, TranscriptionSetupStatus, TranscriptPayload } from "@/lib/transcription/types";

const ACTIVE_STATES = new Set<TranscriptionJob["state"]>(["queued", "decoding", "diarizing", "transcribing", "saving"]);

export function isJobActive(job: TranscriptionJob | null | undefined) {
  return Boolean(job && ACTIVE_STATES.has(job.state));
}

export type StartTranscriptionOptions = { engine?: "local" | "openrouter"; speakers?: number };

/** A recording's transcript and transcription, polled while one runs. */
export function useTranscript(path: string) {
  const [loaded, setLoaded] = useState<TranscriptPayload | null>(null);
  const [error, setError] = useState("");
  // Another recording opened in this tab: its answers count, a late one for the previous does not.
  const payload = loaded?.path === path ? loaded : null;
  const pathRef = useRef(path);
  useLayoutEffect(() => {
    pathRef.current = path;
  }, [path]);

  const apply = useCallback((next: TranscriptPayload) => {
    if (next.path !== pathRef.current) return;
    setLoaded(next);
    setError("");
  }, []);
  const fail = useCallback((failure: unknown) => {
    setError(failure instanceof Error ? failure.message : "Could not load the transcript.");
  }, []);

  const refresh = useCallback(
    () => apiRequest<TranscriptPayload>(`/api/transcripts?path=${encodeURIComponent(path)}`).then(apply, fail),
    [apply, fail, path],
  );

  useEffect(() => {
    apiRequest<TranscriptPayload>(`/api/transcripts?path=${encodeURIComponent(path)}`).then(apply, fail);
  }, [apply, fail, path]);

  // In a shared notebook a collaborator may transcribe or rename speakers; their companion file arrives through the host.
  useEffect(() => subscribeHostEvents((event) => {
    if (event.t === "files-changed" && event.paths.includes(`${path}.transcript`)) void refresh();
  }), [path, refresh]);

  const active = isJobActive(payload?.job);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const send = useCallback(
    (init: RequestInit, query = "") => apiRequest<TranscriptPayload>(`/api/transcripts${query}`, init).then(apply, fail),
    [apply, fail],
  );

  return {
    payload,
    error,
    refresh,
    start: (options: StartTranscriptionOptions = {}) => send({ method: "POST", body: JSON.stringify({ path, ...options }) }),
    cancel: () => send({ method: "DELETE" }, `?path=${encodeURIComponent(path)}`),
    remove: () => send({ method: "DELETE" }, `?path=${encodeURIComponent(path)}&transcript=1`),
    renameSpeaker: (index: number, name: string) => send({ method: "PATCH", body: JSON.stringify({ path, speakers: { [index]: name } }) }),
  };
}

/** What transcription can use on this computer, polled while models download. */
export function useTranscriptionSetup(enabled: boolean) {
  const [status, setStatus] = useState<TranscriptionSetupStatus | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => apiRequest<TranscriptionSetupStatus>("/api/transcripts/setup").then(
    (next) => {
      setStatus(next);
      setError("");
    },
    (failure: unknown) => setError(failure instanceof Error ? failure.message : "Could not check the speech models."),
  ), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiRequest<TranscriptionSetupStatus>("/api/transcripts/setup").then(
      (next) => { if (!cancelled) setStatus(next); },
      (failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not check the speech models."); },
    );
    return () => { cancelled = true; };
  }, [enabled]);

  // Preferences may change while the viewer is open; check again when the window regains focus.
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refresh]);

  const downloading = status?.models.state === "downloading";
  useEffect(() => {
    if (!downloading) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [downloading, refresh]);

  const download = useCallback(async (only?: "diarization") => {
    try {
      setStatus(await apiRequest<TranscriptionSetupStatus>("/api/transcripts/setup", { method: "POST", body: JSON.stringify({ only }) }));
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the download.");
    }
  }, []);

  const cancelDownload = useCallback(async () => {
    setStatus(await apiRequest<TranscriptionSetupStatus>("/api/transcripts/setup", { method: "DELETE" }).catch(() => null));
  }, []);

  return { status, error, refresh, download, cancelDownload };
}

/** The waveform overview; null while it is drawn, or when the recording cannot be decoded here. */
export function useAudioPeaks(path: string) {
  const [result, setResult] = useState<{ path: string; peaks: AudioPeaksPayload | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiRequest<AudioPeaksPayload>(`/api/audio/peaks?path=${encodeURIComponent(path)}`)
      .then((peaks) => { if (!cancelled) setResult({ path, peaks }); })
      .catch(() => { if (!cancelled) setResult({ path, peaks: null }); });
    return () => { cancelled = true; };
  }, [path]);
  const current = result?.path === path ? result : null;
  return { peaks: current?.peaks ?? null, failed: Boolean(current && !current.peaks) };
}
