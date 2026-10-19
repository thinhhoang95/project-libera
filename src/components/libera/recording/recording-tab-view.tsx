"use client";

import {
  ArrowDown,
  Download,
  ListChecks,
  Loader2,
  Mic,
  PanelRight,
  Pause,
  RefreshCw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { useRecorderContext } from "@/components/libera/recording/meeting-recorder";
import type { MeetingRecorder } from "@/components/libera/recording/use-meeting-recorder";
import type { RecordingStatus } from "@/lib/recording/types";
import { formatClock } from "@/lib/transcription/format";

const PANEL_DEFAULT = 380;
const PANEL_MIN = 260;
const PANEL_MAX = 680;

function Switch({ checked, disabled, label, hint, onChange }: { checked: boolean; disabled?: boolean; label: string; hint?: string; onChange: (value: boolean) => void }) {
  return (
    <label className={`flex min-w-0 items-center gap-2 text-xs ${disabled ? "opacity-50" : "cursor-pointer"}`} title={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition ${checked ? "bg-primary" : "bg-muted-foreground/30"}`}
        onClick={() => onChange(!checked)}
      >
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left] ${checked ? "left-[14px]" : "left-0.5"}`} />
      </button>
      <span className="truncate font-medium">{label}</span>
    </label>
  );
}

/** The last twenty seconds or so of loudness, newest on the right, scrolling as the meeting goes on. */
function LiveWaveform({ levels, active }: { levels: number[]; active: boolean }) {
  const bars = 96;
  return (
    <div aria-hidden className="flex h-20 items-center gap-[3px] overflow-hidden">
      {Array.from({ length: bars }, (_, index) => {
        const value = levels[levels.length - bars + index] ?? 0;
        const height = Math.max(4, Math.min(100, Math.sqrt(value) * 100));
        return (
          <span
            key={index}
            className={`min-w-[2px] flex-1 rounded-full transition-[height] duration-100 ${active ? "bg-foreground/70" : "bg-muted-foreground/40"}`}
            style={{ height: `${height}%` }}
          />
        );
      })}
    </div>
  );
}

/** Keeps a scrolled list at its newest line unless the reader scrolled up. */
function useStickToBottom(ref: RefObject<HTMLDivElement | null>, dependency: unknown) {
  const [atBottom, setAtBottom] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && atBottom) element.scrollTop = element.scrollHeight;
  }, [ref, dependency, atBottom]);
  const onScroll = useCallback(() => {
    const element = ref.current;
    if (element) setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
  }, [ref]);
  const jump = useCallback(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
    setAtBottom(true);
  }, [ref]);
  return { atBottom, onScroll, jump };
}

function LatestButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs shadow-lg hover:bg-muted"
      onClick={onClick}
    >
      <ArrowDown aria-hidden className="h-3 w-3" /> Latest
    </button>
  );
}

/**
 * A recording in progress, in a tab of its own, laid out like the voice memo
 * player: the recording, its controls and the Live Recap in the middle, and
 * the live transcript in a panel at the side.
 */
export function RecordingTabView({ recordingId }: { recordingId: string }) {
  const context = useRecorderContext();
  const recorder = context?.recorder;
  if (!context || !recorder) return null;
  if (recorder.session?.id === recordingId) return <RecordingTab recorder={recorder} onDiscard={context.discard} />;
  return <DetachedRecording key={recordingId} recordingId={recordingId} />;
}

/**
 * The tab of a recording the recorder does not hold: left unfinished by a
 * crash or a reload (record on, save or delete it), or already saved.
 */
function DetachedRecording({ recordingId }: { recordingId: string }) {
  const context = useRecorderContext()!;
  const { recorder, unfinished } = context;
  const [status, setStatus] = useState<RecordingStatus | null | "loading">("loading");
  useEffect(() => {
    let disposed = false;
    apiRequest<RecordingStatus>(`/api/recordings/${recordingId}`)
      .then((value) => !disposed && setStatus(value))
      .catch(() => !disposed && setStatus(null));
    return () => {
      disposed = true;
    };
  }, [recordingId]);

  if (recorder.state === "stopping" || status === "loading") {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground"><Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> {recorder.state === "stopping" ? "Saving the recording…" : "Opening the recording…"}</div>;
  }
  if (!status) {
    return <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">This recording was saved or deleted.</div>;
  }
  const busy = Boolean(unfinished.saving) || (recorder.state !== "idle" && recorder.state !== "error");
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-sm shadow-sm">
        <div className="mb-1 flex items-center gap-2 text-muted-foreground"><Mic aria-hidden className="h-4 w-4" /> Not finished</div>
        <h1 className="mb-1 truncate text-xl font-semibold tracking-tight">{status.name}</h1>
        <p className="mb-4 text-muted-foreground">
          {formatClock(status.savedSeconds)} recorded into {status.parentPath}. The recording stopped before it was saved; everything up to then is safe{status.segmentCount ? `, with ${status.segmentCount} transcript passages` : ""}{status.recap?.bullets.length ? ` and ${status.recap.bullets.length} recap points` : ""}.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-destructive px-4 font-medium text-white hover:bg-destructive/90 disabled:opacity-50" disabled={busy} onClick={() => void unfinished.recordOn(recordingId)}>
            <span className="h-2.5 w-2.5 rounded-full bg-white" /> Record on
          </button>
          <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 font-medium hover:bg-muted disabled:opacity-50" disabled={busy} onClick={() => void unfinished.save(recordingId, status.notebook)}>
            {unfinished.saving === recordingId ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : null} Save
          </button>
          <button type="button" className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-destructive hover:bg-destructive/10 disabled:opacity-50" disabled={busy} onClick={() => void unfinished.remove(recordingId)}>
            <Trash2 aria-hidden className="h-4 w-4" /> Delete
          </button>
        </div>
        {recorder.state !== "idle" && recorder.state !== "error" ? <p className="mt-3 text-xs text-muted-foreground">Another recording is in progress; stop it to record on into this one.</p> : null}
        {unfinished.error ? <p role="alert" className="mt-3 text-xs text-destructive">{unfinished.error}</p> : null}
      </div>
    </div>
  );
}

function RecordingTab({ recorder, onDiscard }: { recorder: MeetingRecorder; onDiscard: () => Promise<void> }) {
  const { state, error, session, segments, recap, seconds, levels, unsavedSeconds, saving, setup } = recorder;
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  /** The name being typed; null shows the recording's name. */
  const [editedName, setEditedName] = useState<string | null>(null);
  const sessionName = session?.name ?? "";
  const name = editedName ?? sessionName;

  // Bullets the latest recap update added or changed glow for a few seconds.
  const recapVersion = recap?.version ?? 0;
  const [fadedVersion, setFadedVersion] = useState(0);
  const highlighted = recap && recapVersion !== fadedVersion ? recap.lastChanged : [];
  useEffect(() => {
    const timer = window.setTimeout(() => setFadedVersion(recapVersion), 6000);
    return () => window.clearTimeout(timer);
  }, [recapVersion]);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const recapRef = useRef<HTMLDivElement>(null);
  const transcriptScroll = useStickToBottom(transcriptRef, segments);
  const recapScroll = useStickToBottom(recapRef, recap?.bullets.length);

  const recording = state === "recording";
  const paused = state === "paused";
  const stopping = state === "stopping";
  const asrReady = Boolean(setup?.models.asr);
  const downloading = setup?.models.state === "downloading";
  const liveTranscribe = Boolean(session?.liveTranscribe);
  const liveRecap = Boolean(session?.liveRecap);
  const canRecap = asrReady && liveTranscribe && Boolean(setup?.hasApiKey);
  const pendingChunks = session?.pendingChunks ?? 0;
  const lastLine = segments.at(-1)?.text;

  function commitName() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== sessionName) void recorder.update({ name: trimmed });
    setEditedName(null);
  }

  function confirmDiscard() {
    if (window.confirm(`Delete this recording (${formatClock(seconds)})? This cannot be undone.`)) void onDiscard();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true']") || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === " " && !target.closest("button")) {
      event.preventDefault();
      if (recording) recorder.pause();
      else if (paused) void recorder.resume();
    } else if (event.key.toLowerCase() === "t") {
      event.preventDefault();
      setPanelOpen((value) => !value);
    }
  }

  function onResizeStart(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeFrom.current = { x: event.clientX, width: panelWidth };
  }
  function onResizeMove(event: PointerEvent<HTMLDivElement>) {
    if (!resizeFrom.current) return;
    setPanelWidth(Math.max(PANEL_MIN, Math.min(PANEL_MAX, resizeFrom.current.width + resizeFrom.current.x - event.clientX)));
  }
  function onResizeEnd() {
    resizeFrom.current = null;
  }

  const statusLabel = stopping ? "Saving" : recording ? "Recording" : "Paused";
  const subtitle = stopping
    ? liveTranscribe ? "Saving: finishing the transcript and recap…" : "Saving the recording…"
    : lastLine ?? (paused ? "Paused. Resume to record on." : liveTranscribe ? "Listening… The transcript appears a few seconds after each phrase." : "Recording. Turn on Live transcribe to see what is said.");

  return (
    <div className="libera-media-viewer libera-recording flex min-h-0 flex-1 overflow-hidden outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
      <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="libera-viewer-toolbar flex items-center gap-3 border-b border-input bg-card px-4 py-2">
          <Mic aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {[statusLabel, session?.parentPath ? `into ${session.parentPath}` : null, "16 kHz mono"].filter(Boolean).join(" · ")}
          </span>
          <button
            type="button"
            aria-pressed={panelOpen}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition ${panelOpen ? "border-transparent bg-foreground text-background" : "border-input hover:bg-muted"}`}
            title="Transcript (T)"
            onClick={() => setPanelOpen((value) => !value)}
          >
            <PanelRight aria-hidden className="h-4 w-4" /> Transcript
          </button>
        </div>

        <div className="mx-auto flex h-full min-h-[38rem] w-full max-w-3xl flex-col gap-5 px-6 py-6 sm:px-10">
          <div className="space-y-1.5">
            <input
              className="-mx-1.5 w-[calc(100%+0.75rem)] truncate rounded-md bg-transparent px-1.5 text-2xl font-semibold tracking-tight outline-none hover:bg-muted focus:bg-muted"
              value={name}
              aria-label="Recording name"
              disabled={stopping}
              onChange={(event) => setEditedName(event.target.value)}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setEditedName(sessionName);
                  event.currentTarget.blur();
                }
              }}
            />
            <p className="line-clamp-2 min-h-[2.75rem] text-[15px] leading-relaxed text-foreground/80" aria-live="off">{subtitle}</p>
          </div>

          <div className="@container rounded-2xl border border-border bg-card px-5 pb-4 pt-5 shadow-sm">
            <LiveWaveform levels={levels} active={recording} />
            <div className="mt-3 flex items-center justify-center gap-2">
              <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${recording ? "animate-pulse bg-destructive" : "bg-muted-foreground"}`} />
              <span className="font-mono text-3xl font-medium tabular-nums tracking-tight">{formatClock(seconds)}</span>
            </div>

            <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <div className="justify-self-start">
                <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-35" disabled={stopping} aria-label="Delete the recording" title="Delete the recording" onClick={confirmDiscard}>
                  <Trash2 aria-hidden className="h-4 w-4" />
                </button>
              </div>
              {paused ? (
                <button type="button" className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-destructive text-white shadow-md transition hover:scale-[1.04] active:scale-95" aria-label="Resume recording" title="Resume (Space)" onClick={() => void recorder.resume()}>
                  <span className="h-5 w-5 rounded-full bg-white" />
                </button>
              ) : (
                <button type="button" className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-foreground text-background shadow-md transition hover:scale-[1.04] active:scale-95 disabled:opacity-40" disabled={!recording} aria-label="Pause recording" title="Pause (Space)" onClick={recorder.pause}>
                  <Pause aria-hidden className="h-6 w-6" fill="currentColor" />
                </button>
              )}
              <div className="justify-self-end">
                <button type="button" className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-3.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50" disabled={stopping} title="Stop and save the recording into the notebook" onClick={() => void recorder.stop()}>
                  {stopping ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Square aria-hidden className="h-3 w-3 text-destructive" fill="currentColor" />} Stop &amp; save
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3">
              <Switch
                checked={liveTranscribe}
                disabled={!asrReady || stopping}
                label="Live transcribe"
                hint={asrReady ? "Transcribes as you record, with Parakeet on this computer" : "Needs the Parakeet speech model"}
                onChange={(value) => void recorder.update({ liveTranscribe: value, ...(value ? {} : { liveRecap: false }) })}
              />
              <Switch
                checked={liveRecap}
                disabled={!canRecap || stopping}
                label="Live recap"
                hint={!setup?.hasApiKey ? "Needs an OpenRouter API key (Preferences → AI)" : !liveTranscribe ? "Needs live transcription" : "Keeps a bullet-point recap with the AI model"}
                onChange={(value) => void recorder.update({ liveRecap: value })}
              />
              {!asrReady ? (
                downloading ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
                    Downloading Parakeet… {Math.round(((setup?.models.downloadedBytes ?? 0) / Math.max(1, setup?.models.totalBytes ?? 1)) * 100)}%
                  </span>
                ) : (
                  <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline" onClick={() => void recorder.downloadModels()}>
                    <Download aria-hidden className="h-3 w-3" /> Download speech models ({Math.round((setup?.models.totalBytes ?? 0) / 1e6)} MB)
                  </button>
                )
              ) : null}
            </div>
          </div>

          {error ? (
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive-muted px-3 py-2 text-sm text-destructive">
              <span className="min-w-0 flex-1">{error}</span>
              <button type="button" className="shrink-0" aria-label="Dismiss" onClick={recorder.clearError}><X aria-hidden className="h-3.5 w-3.5" /></button>
            </div>
          ) : null}
          {unsavedSeconds > 4 ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              Libera’s server is not answering; {formatClock(unsavedSeconds)} of audio is kept in this window until it can be saved.
            </p>
          ) : null}

          <div className="flex min-h-[14rem] flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <ListChecks aria-hidden className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Live recap</h2>
              {recap?.bullets.length ? <span className="text-xs text-muted-foreground">{recap.bullets.length}</span> : null}
              <span className="flex-1" />
              {liveRecap && recap?.updating ? <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 aria-hidden className="h-3 w-3 animate-spin" /> Updating…</span> : null}
              {liveRecap ? (
                <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50" disabled={recap?.updating || stopping} title="Bring the recap up to date now" onClick={() => void recorder.refreshRecap()}>
                  <RefreshCw aria-hidden className="h-3 w-3" /> Update
                </button>
              ) : null}
            </div>
            <div className="relative min-h-0 flex-1">
              <div ref={recapRef} onScroll={recapScroll.onScroll} className="absolute inset-0 overflow-y-auto px-4 py-3">
                {!liveRecap ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {canRecap ? "Turn on Live recap to keep a bullet-point summary as the meeting goes on." : !asrReady ? "The live recap reads the live transcript, which needs the Parakeet speech model." : !setup?.hasApiKey ? "The live recap needs an OpenRouter API key, set in Preferences → AI." : "Turn on Live transcribe for the recap."}
                  </p>
                ) : recap?.bullets.length ? (
                  <ul className="flex flex-col gap-1">
                    {recap.bullets.map((bullet) => (
                      <li key={bullet.id} className={`flex gap-2.5 rounded-lg px-2 py-1.5 text-[15px] leading-relaxed transition-colors duration-1000 ${highlighted.includes(bullet.id) ? "bg-accent/15" : ""}`}>
                        <span aria-hidden className="mt-[0.6rem] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/50" />
                        <span className="min-w-0 flex-1">{bullet.text}</span>
                        <span className="shrink-0 pt-1 font-mono text-[11px] text-muted-foreground">{formatClock(bullet.addedAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">Bullets appear after a minute or so of speech.</p>
                )}
                {liveRecap && recap?.error ? <p className="px-2 py-1 text-xs text-destructive">{recap.error}</p> : null}
              </div>
              {!recapScroll.atBottom ? <LatestButton onClick={recapScroll.jump} /> : null}
            </div>
          </div>

          <p className="text-center text-[11px] text-muted-foreground/80">Space pause/resume · T transcript · Recording goes on in other tabs</p>
        </div>
      </section>

      {panelOpen ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize transcript"
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent/60 active:bg-accent"
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
          />
          <aside className="flex min-h-0 shrink-0 flex-col bg-card" style={{ width: panelWidth }} aria-label="Live transcript">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold">Transcript</h2>
              {liveTranscribe && !stopping ? <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-destructive"><span className="h-1.5 w-1.5 rounded-full bg-destructive" /> Live</span> : null}
              <span className="flex-1" />
              <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted" aria-label="Hide the transcript" title="Hide (T)" onClick={() => setPanelOpen(false)}>
                <X aria-hidden className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="relative min-h-0 flex-1">
              <div ref={transcriptRef} onScroll={transcriptScroll.onScroll} className="absolute inset-0 overflow-y-auto px-4 py-3">
                {segments.length ? (
                  <div className="flex flex-col gap-2.5">
                    {segments.map((segment, index) => (
                      <p key={`${segment.start}-${index}`} className="flex gap-3 text-sm leading-relaxed">
                        <span className="w-10 shrink-0 pt-0.5 text-right font-mono text-[11px] text-muted-foreground">{formatClock(segment.start)}</span>
                        <span className="min-w-0 flex-1">{segment.text}</span>
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {liveTranscribe ? "The transcript appears a few seconds after each phrase." : asrReady ? "Live transcription is off." : "Live transcription needs the Parakeet speech model."}
                  </p>
                )}
              </div>
              {!transcriptScroll.atBottom ? <LatestButton onClick={transcriptScroll.jump} /> : null}
            </div>
            <div className={`border-t border-border px-4 py-2 text-[11px] ${session?.transcribeError ? "text-destructive" : "text-muted-foreground"}`}>
              {session?.transcribeError
                || (pendingChunks > 1 ? `Catching up: ${pendingChunks} pieces to transcribe…` : liveTranscribe ? `Parakeet TDT v3, on this computer · ${segments.length} passages` : "Not transcribing")}
            </div>
          </aside>
        </>
      ) : null}
      {saving ? <span className="sr-only" role="status">Saving the recording</span> : null}
    </div>
  );
}
