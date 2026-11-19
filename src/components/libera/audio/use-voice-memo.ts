"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { beginAiActivity } from "@/lib/ai-activity";
import { subscribeHostEvents } from "@/lib/collab/ui/bridge";
import type { AudioPeaksPayload, TranscriptionJob, TranscriptionSetupStatus, TranscriptPayload, TranscriptProgressPayload, TranscriptSegment } from "@/lib/transcription/types";

const ACTIVE_STATES = new Set<TranscriptionJob["state"]>(["queued", "decoding", "diarizing", "transcribing", "saving"]);

export function isJobActive(job: TranscriptionJob | null | undefined) {
  return Boolean(job && ACTIVE_STATES.has(job.state));
}

/** `language`: an ISO code, or empty to detect it; left out, Preferences → Speech decides. */
export type StartTranscriptionOptions = { engine?: "local" | "openrouter"; speakers?: number; language?: string };

/** A recording's transcript and transcription, polled while one runs. */
export function useTranscript(path: string) {
  const t = useTranslations("audio.useVoiceMemo");
  const [loaded, setLoaded] = useState<TranscriptPayload | null>(null);
  const [error, setError] = useState("");
  // Another recording opened in this tab: its answers count, a late one for the previous does not.
  const payload = loaded?.path === path ? loaded : null;
  const pathRef = useRef(path);
  useLayoutEffect(() => {
    pathRef.current = path;
  }, [path]);

  // The version of the transcript last shown, sent with corrections so the server refuses to replace a newer one.
  const versionRef = useRef<string | undefined>(undefined);
  const apply = useCallback((next: TranscriptPayload) => {
    if (next.path !== pathRef.current) return;
    versionRef.current = next.version;
    setLoaded(next);
    setError("");
  }, []);
  const fail = useCallback((failure: unknown) => {
    setError(failure instanceof Error ? failure.message : t("loadTranscriptFailed"));
  }, [t]);

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
  // Light the workspace glow for as long as this recording is being transcribed.
  useEffect(() => (active ? beginAiActivity() : undefined), [active]);
  // While a job runs only its status is polled (no transcript, no recording
  // read); the full transcript is fetched once, when the job has finished.
  useEffect(() => {
    if (!active) return;
    let finished = false;
    let polling = false;
    const timer = window.setInterval(() => {
      if (polling || finished) return;
      polling = true;
      apiRequest<TranscriptProgressPayload>(`/api/transcripts/progress?path=${encodeURIComponent(path)}`).then((progress) => {
        if (finished || progress.path !== pathRef.current) return;
        setLoaded((previous) => (previous?.path === progress.path ? { ...previous, job: progress.job } : previous));
        if (!isJobActive(progress.job)) {
          finished = true;
          void refresh();
        }
      }, fail).finally(() => { polling = false; });
    }, 1000);
    return () => {
      finished = true;
      window.clearInterval(timer);
    };
  }, [active, fail, path, refresh]);

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
    /** The reader's corrections, saved once the editing ends; `keepalive` lets the save outlive a closing window. */
    saveSegments: (segments: TranscriptSegment[], { keepalive = false } = {}) => {
      const body = JSON.stringify({ path, segments, baseVersion: versionRef.current });
      // A keepalive request may carry at most 64 KB; a longer transcript is sent as usual.
      return apiRequest<TranscriptPayload>("/api/transcripts", { method: "PATCH", keepalive: keepalive && body.length < 60_000, body }).then(apply, (failure: unknown) => {
        fail(failure);
        throw failure;
      });
    },
  };
}

/** What transcription can use on this computer, polled while models download. */
export function useTranscriptionSetup(enabled: boolean) {
  const t = useTranslations("audio.useVoiceMemo");
  const [status, setStatus] = useState<TranscriptionSetupStatus | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => apiRequest<TranscriptionSetupStatus>("/api/transcripts/setup").then(
    (next) => {
      setStatus(next);
      setError("");
    },
    (failure: unknown) => setError(failure instanceof Error ? failure.message : t("checkSpeechModelsFailed")),
  ), [t]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiRequest<TranscriptionSetupStatus>("/api/transcripts/setup").then(
      (next) => { if (!cancelled) setStatus(next); },
      (failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : t("checkSpeechModelsFailed")); },
    );
    return () => { cancelled = true; };
  }, [enabled, t]);

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
      setError(failure instanceof Error ? failure.message : t("startDownloadFailed"));
    }
  }, [t]);

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
