"use client";

import {
  ArrowDown,
  AudioLines,
  ListChecks,
  Loader2,
  Mic,
  PanelLeft,
  Pause,
  Pencil,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { apiRequest } from "@/components/libera/api-client";
import { EditableLine, useFlushWhenEditingEnds, useRecapDraft, useSegmentDraft } from "@/components/libera/audio/editable-lines";
import { requestRailTab } from "@/components/libera/page-tabs";
import { useRailSlot } from "@/components/libera/rail-slot";
import { useRecorderContext } from "@/components/libera/recording/meeting-recorder";
import { RecordingControls } from "@/components/libera/recording/recording-controls";
import type { MeetingRecorder } from "@/components/libera/recording/use-meeting-recorder";
import type { RecapBullet, RecordingStatus } from "@/lib/recording/types";
import { formatClock } from "@/lib/transcription/format";

/**
 * The last twenty seconds or so of loudness, newest on the right, scrolling
 * as the meeting goes on; older sound fades out to the left.
 */
function LiveWaveform({ levels, active }: { levels: number[]; active: boolean }) {
  const bars = 120;
  return (
    <div aria-hidden className="flex h-14 items-center gap-[2px] overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_22%)]">
      {Array.from({ length: bars }, (_, index) => {
        const value = levels[levels.length - bars + index] ?? 0;
        const height = Math.max(6, Math.min(100, Math.sqrt(value) * 110));
        return (
          <span
            key={index}
            className={`min-w-[2px] flex-1 rounded-full transition-[height] duration-100 ${active ? "bg-foreground/70" : "bg-muted-foreground/30"}`}
            style={{ height: `${height}%` }}
          />
        );
      })}
    </div>
  );
}

/** Keeps a scrolled list at its newest line unless the reader scrolled up, or is typing in it. */
function useStickToBottom(ref: RefObject<HTMLDivElement | null>, dependency: unknown) {
  const [atBottom, setAtBottom] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && atBottom && !element.contains(document.activeElement)) element.scrollTop = element.scrollHeight;
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
 * A recording in progress, in a tab of its own, laid out like the voice memo:
 * the page shows what is being recorded (its level, the live recap and the
 * live transcript, both of which the reader can correct as it goes), and the
 * Recording rail tab holds the recorder's controls.
 */
export function RecordingTabView({ tabId, recordingId }: { tabId: string; recordingId: string }) {
  const context = useRecorderContext();
  const recorder = context?.recorder;
  if (!context || !recorder) return null;
  if (recorder.session?.id === recordingId) return <RecordingTab tabId={tabId} recorder={recorder} onDiscard={context.discard} />;
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

function RecordingTab({ tabId, recorder, onDiscard }: { tabId: string; recorder: MeetingRecorder; onDiscard: () => Promise<void> }) {
  const { state, error, session, segments, transcriptEdits, recap, seconds, levels, saving, setup } = recorder;
  const rootRef = useRef<HTMLDivElement>(null);
  const railSlot = useRailSlot(tabId);
  /** The name being typed; null shows the recording's name. */
  const [editedName, setEditedName] = useState<string | null>(null);
  const sessionName = session?.name ?? "";
  const name = editedName ?? sessionName;

  // The reader's corrections, kept in memory while they type and sent when the editing ends.
  const { saveTranscriptEdits, saveRecapEdits } = recorder;
  const transcript = useSegmentDraft({ base: segments, saved: transcriptEdits, save: ({ edits }, closing) => saveTranscriptEdits(edits, closing) });
  const secondsRef = useRef(seconds);
  useLayoutEffect(() => {
    secondsRef.current = seconds;
  }, [seconds]);
  const recapDraft = useRecapDraft({ base: recap?.bullets ?? NO_BULLETS, save: saveRecapEdits, now: () => secondsRef.current });
  const onLeaveTranscript = useFlushWhenEditingEnds(transcript.flush);
  const onLeaveRecap = useFlushWhenEditingEnds(recapDraft.flush);

  // Bullets the latest recap update added or changed glow for a few seconds.
  const recapVersion = recap?.version ?? 0;
  const [fadedVersion, setFadedVersion] = useState(0);
  const highlighted = recap && recapVersion !== fadedVersion ? recap.lastChanged : NO_IDS;
  useEffect(() => {
    const timer = window.setTimeout(() => setFadedVersion(recapVersion), 6000);
    return () => window.clearTimeout(timer);
  }, [recapVersion]);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const recapRef = useRef<HTMLDivElement>(null);
  const transcriptScroll = useStickToBottom(transcriptRef, transcript.segments.length);
  const recapScroll = useStickToBottom(recapRef, recapDraft.bullets.length);

  const recording = state === "recording";
  const paused = state === "paused";
  const stopping = state === "stopping";
  const asrReady = Boolean(setup?.models.asr);
  const liveTranscribe = Boolean(session?.liveTranscribe);
  const liveRecap = Boolean(session?.liveRecap);
  const canRecap = asrReady && liveTranscribe && Boolean(setup?.hasApiKey);
  const lines = transcript.segments;
  /** Where a narrow page shows one section at a time. */
  const [view, setView] = useState<"recap" | "transcript">("transcript");

  function commitName() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== sessionName) void recorder.update({ name: trimmed });
    setEditedName(null);
  }

  function stopAndSave() {
    // Edits still in memory go first; the recorder saves the recording after them.
    transcript.flush(false);
    recapDraft.flush(false);
    void recorder.stop();
  }

  function confirmDiscard() {
    if (window.confirm(`Delete this recording (${formatClock(seconds)})? This cannot be undone.`)) void onDiscard();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    // Keys typed in the rail tab (rendered here through a portal) are the rail's own.
    if (!rootRef.current?.contains(target)) return;
    if (target.isContentEditable || target.closest("input, textarea") || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === " " && !target.closest("button")) {
      event.preventDefault();
      if (recording) recorder.pause();
      else if (paused) void recorder.resume();
    }
  }

  const startedAt = session?.createdAt ? new Date(session.createdAt) : null;
  const meta = [
    startedAt && !Number.isNaN(startedAt.getTime()) ? `Started ${startedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : null,
    session?.parentPath ? `into ${session.parentPath}` : null,
    liveTranscribe ? "transcribing on this computer" : null,
  ].filter(Boolean).join(" · ");
  const listening = recording && liveTranscribe;
  const recapStatus = liveRecap && recap?.updating ? <><Loader2 aria-hidden className="h-3 w-3 animate-spin" /> Updating</> : liveRecap ? "Written live" : null;
  const transcriptStatus = liveTranscribe && !stopping ? <><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-destructive" /> Live</> : null;
  const recapEmpty = liveRecap
    ? "Points appear after a minute or so of speech. You can add your own meanwhile."
    : canRecap ? "Turn on Live recap in the Recording panel, or write the points yourself."
      : !asrReady ? "The live recap reads the live transcript, which needs the Parakeet speech model. You can still write points yourself."
        : !setup?.hasApiKey ? "The live recap needs an OpenRouter API key (Preferences → AI). You can still write points yourself."
          : "Turn on Live transcribe for the recap, or write the points yourself.";

  return (
    <div ref={rootRef} className="libera-media-viewer libera-recording flex min-h-0 flex-1 flex-col overflow-hidden outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="libera-viewer-toolbar flex shrink-0 items-center gap-3 border-b border-input bg-card px-4 py-2">
        <Mic aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{[name || "Recording", "16 kHz mono"].join(" · ")}</span>
        {!railSlot ? (
          <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-input px-2.5 text-sm font-medium transition hover:bg-muted" title="Show the recorder's controls in the left panel" onClick={() => requestRailTab("recording")}>
            <PanelLeft aria-hidden className="h-4 w-4" /> Controls
          </button>
        ) : null}
      </div>

      <header className="mx-auto w-full max-w-5xl shrink-0 px-6 pb-6 pt-7 sm:px-10">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusPill state={stopping ? "saving" : recording ? "recording" : "paused"} />
          <span className="min-w-0 truncate text-xs text-muted-foreground">{meta}</span>
        </div>
        <input
          className="-mx-2 mt-2.5 w-[calc(100%+1rem)] truncate rounded-lg bg-transparent! px-2 py-0.5 text-[28px] font-semibold leading-tight tracking-tight outline-none transition-colors placeholder:text-muted-foreground hover:bg-muted/60! focus:bg-muted/60!"
          value={name}
          aria-label="Recording name"
          placeholder="Untitled recording"
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

        <div className="mt-6 flex items-center gap-5">
          <span className={`shrink-0 font-mono text-[34px] font-medium leading-none tabular-nums tracking-tight ${paused ? "text-muted-foreground" : ""}`} aria-label={`Recorded ${formatClock(seconds)}`}>
            {formatClock(seconds)}
          </span>
          <div className="min-w-0 flex-1">
            <LiveWaveform levels={levels} active={recording} />
          </div>
          {paused ? (
            <button type="button" className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-destructive text-white shadow-[0_6px_20px_-6px] shadow-destructive/60 transition hover:scale-[1.04] active:scale-95" aria-label="Resume recording" title="Resume (Space)" onClick={() => void recorder.resume()}>
              <span className="h-4 w-4 rounded-full bg-white" />
            </button>
          ) : (
            <button type="button" className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm transition hover:scale-[1.04] hover:bg-muted active:scale-95 disabled:opacity-40" disabled={!recording} aria-label="Pause recording" title="Pause (Space)" onClick={recorder.pause}>
              <Pause aria-hidden className="h-5 w-5" fill="currentColor" />
            </button>
          )}
        </div>

        {error && !railSlot ? <p role="alert" className="mt-4 rounded-lg bg-destructive-muted px-3 py-2 text-sm text-destructive">{error}</p> : null}
      </header>

      <div className="@container mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-6 sm:px-10">
        <div className="border-t border-border" />
        {/* Narrow: one at a time. Wide: side by side. */}
        <div className="mt-4 flex items-center justify-between gap-3 @3xl:hidden">
        <div className="grid grid-cols-2 gap-0.5 rounded-[10px] bg-muted p-0.5" role="tablist" aria-label="Show">
          {(["recap", "transcript"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              className={`h-7 rounded-lg px-3 text-xs font-medium transition ${view === option ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setView(option)}
            >
              {option === "recap" ? `Recap${recapDraft.bullets.length ? ` · ${recapDraft.bullets.length}` : ""}` : `Transcript${lines.length ? ` · ${lines.length}` : ""}`}
            </button>
          ))}
        </div>
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">{view === "recap" ? recapStatus : transcriptStatus}</span>
        </div>

        <div className="grid min-h-0 flex-1 @3xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <section className={`${view === "recap" ? "flex" : "hidden"} min-h-0 flex-col @3xl:flex @3xl:pr-10`} aria-label="Live recap">
            <SectionHeading
              title="Recap"
              count={recapDraft.bullets.length}
              status={recapStatus}
            />
            <div className="relative min-h-0 flex-1">
              <div ref={recapRef} onScroll={recapScroll.onScroll} className={scrollArea}>
                {recapDraft.bullets.length ? (
                  <ul className="flex flex-col" onBlur={onLeaveRecap}>
                    {recapDraft.bullets.map((bullet, index) => (
                      <li key={bullet.id} className={`group -mx-2 flex gap-3 rounded-lg px-2 py-1.5 transition-colors duration-1000 ${highlighted.includes(bullet.id) ? "bg-accent/10" : ""}`}>
                        <span aria-hidden className="mt-[0.68rem] h-[5px] w-[5px] shrink-0 rounded-full bg-foreground/45" />
                        <EditableLine
                          text={bullet.text}
                          label={`Recap point ${index + 1}`}
                          placeholder="A point to remember…"
                          readOnly={stopping}
                          className="flex-1 text-[15px] leading-[1.6]"
                          focus={recapDraft.focus?.id === bullet.id ? recapDraft.focus : null}
                          onType={(text) => recapDraft.type(bullet.id, text)}
                          onCommit={(text) => recapDraft.commit(bullet.id, text)}
                          onSplit={(text, offset) => recapDraft.split(bullet.id, text, offset)}
                          onJoinPrevious={(text) => recapDraft.joinPrevious(bullet.id, text)}
                          onJoinNext={(text) => recapDraft.joinNext(bullet.id, text)}
                          onMove={(direction) => recapDraft.move(bullet.id, direction)}
                        />
                        <span className="flex shrink-0 items-center gap-1 self-start pt-[5px] font-mono text-[11px] tabular-nums text-muted-foreground/80">
                          {bullet.edited ? <Pencil aria-label="Written or corrected by you" className="h-2.5 w-2.5" /> : null}
                          {formatClock(bullet.addedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyNote icon={ListChecks} text={recapEmpty} />
                )}
                {!stopping ? (
                  <button type="button" className="mt-1 inline-flex h-8 items-center gap-2 rounded-lg pr-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground" onClick={recapDraft.add}>
                    <Plus aria-hidden className="h-3.5 w-3.5" /> Add a point
                  </button>
                ) : null}
                {liveRecap && recap?.error ? <p className="mt-2 text-xs leading-5 text-destructive">{recap.error}</p> : null}
              </div>
              {!recapScroll.atBottom ? <LatestButton onClick={recapScroll.jump} /> : null}
            </div>
          </section>

          <section className={`${view === "transcript" ? "flex" : "hidden"} min-h-0 flex-col @3xl:flex @3xl:border-l @3xl:border-border @3xl:pl-10`} aria-label="Live transcript">
            <SectionHeading
              title="Transcript"
              count={lines.length}
              status={transcriptStatus}
            />
            <div className="relative min-h-0 flex-1">
              <div ref={transcriptRef} onScroll={transcriptScroll.onScroll} className={scrollArea}>
                {lines.length ? (
                  <div className="flex flex-col" onBlur={onLeaveTranscript}>
                    {lines.map((segment, index) => (
                      <div key={index} className="flex gap-4 py-1">
                        <span className="w-10 shrink-0 pt-[5px] text-right font-mono text-[11px] tabular-nums text-muted-foreground/80">{formatClock(segment.start)}</span>
                        <EditableLine
                          text={segment.text}
                          label={`Passage at ${formatClock(segment.start)}`}
                          placeholder="Type here…"
                          readOnly={stopping}
                          className="flex-1 text-[15px] leading-[1.65] text-foreground/90"
                          focus={transcript.focus?.index === index ? transcript.focus : null}
                          onType={(text) => transcript.type(index, text)}
                          onCommit={(text) => transcript.commit(index, text)}
                          onSplit={(text, offset) => transcript.split(index, text, offset)}
                          onJoinPrevious={index ? (text) => transcript.joinPrevious(index, text) : undefined}
                          onJoinNext={(text) => transcript.joinNext(index, text)}
                          onMove={(direction) => transcript.move(index, direction)}
                        />
                      </div>
                    ))}
                    {listening ? <ListeningDots /> : null}
                  </div>
                ) : listening ? (
                  <>
                    <EmptyNote icon={AudioLines} text="Listening. Each phrase appears here a few seconds after it is said." />
                    <ListeningDots />
                  </>
                ) : (
                  <EmptyNote icon={AudioLines} text={stopping ? "Finishing the transcript…" : liveTranscribe ? "The transcript appears a few seconds after each phrase." : asrReady ? "Live transcription is off. Turn it on in the Recording panel, or transcribe the memo once it is saved." : "Live transcription needs the Parakeet speech model, which the Recording panel can download."} />
                )}
              </div>
              {!transcriptScroll.atBottom ? <LatestButton onClick={transcriptScroll.jump} /> : null}
            </div>
          </section>
        </div>
      </div>

      {railSlot ? createPortal(<RecordingControls recorder={recorder} onStop={stopAndSave} onDiscard={confirmDiscard} />, railSlot) : null}
      {saving ? <span className="sr-only" role="status">Saving the recording</span> : null}
    </div>
  );
}

/** Lists scroll under soft edges, so lines fade in and out rather than being cut. */
const scrollArea = "absolute inset-y-0 -inset-x-2 overflow-x-hidden overflow-y-auto px-2 pb-12 pt-3 @3xl:pt-1 [mask-image:linear-gradient(to_bottom,transparent,black_10px,black_calc(100%-32px),transparent)]";

function StatusPill({ state }: { state: "recording" | "paused" | "saving" }) {
  const tone = state === "recording"
    ? "bg-destructive/10 text-destructive"
    : state === "paused" ? "bg-amber-500/12 text-amber-700 dark:text-amber-400" : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[3px] text-[10.5px] font-semibold uppercase tracking-[0.08em] ${tone}`}>
      {state === "saving" ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : (
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${state === "recording" ? "animate-pulse bg-destructive" : "bg-current"}`} />
      )}
      {state === "recording" ? "Recording" : state === "paused" ? "Paused" : "Saving"}
    </span>
  );
}

function SectionHeading({ title, count, status }: { title: string; count: number; status: ReactNode }) {
  return (
    <div className="hidden shrink-0 items-baseline gap-2 pb-2 pt-5 @3xl:flex">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      {count ? <span className="text-xs tabular-nums text-muted-foreground">{count}</span> : null}
      <span className="flex-1" />
      {status ? <span className="inline-flex items-center gap-1.5 self-center text-[11px] font-medium text-muted-foreground">{status}</span> : null}
    </div>
  );
}

function EmptyNote({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex items-start gap-3 py-2 pr-4">
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon aria-hidden className="h-3.5 w-3.5" /></span>
      <p className="pt-1 text-[13px] leading-5 text-muted-foreground">{text}</p>
    </div>
  );
}

/** The transcript keeps up a few seconds behind; three dots say it is still listening. */
function ListeningDots() {
  return (
    <div aria-hidden className="flex gap-4 py-2">
      <span className="w-10 shrink-0" />
      <span className="inline-flex items-center gap-1">
        {[0, 1, 2].map((dot) => (
          <span key={dot} className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" style={{ animationDelay: `${dot * 200}ms` }} />
        ))}
      </span>
    </div>
  );
}

const NO_BULLETS: RecapBullet[] = [];
const NO_IDS: number[] = [];
