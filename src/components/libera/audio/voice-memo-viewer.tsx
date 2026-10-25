"use client";

import { AudioLines, Pause, PanelLeft, Play } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useSegmentDraft } from "@/components/libera/audio/editable-lines";
import { speakerColor } from "@/components/libera/audio/speaker-colors";
import { TranscriptControls, TranscriptDocument, TranscriptMenu, type TranscriptNoteActions } from "@/components/libera/audio/transcript-panel";
import { isJobActive, useAudioPeaks, useTranscript } from "@/components/libera/audio/use-voice-memo";
import { PLAYBACK_RATES, SKIP_SECONDS, VoiceMemoControls, type VoiceMemoPlayer } from "@/components/libera/audio/voice-memo-controls";
import { Waveform } from "@/components/libera/audio/waveform";
import { requestRailTab } from "@/components/libera/page-tabs";
import { useRailSlot } from "@/components/libera/rail-slot";
import type { AudioTabViewState } from "@/components/libera/types";
import { findTermRanges } from "@/lib/global-search";
import { formatClock, formatDuration, segmentIndexAt, speakerName } from "@/lib/transcription/format";
import type { Transcript, TranscriptSegment } from "@/lib/transcription/types";
import type { LiberaFileNode } from "@/lib/types";

const NO_SEGMENTS: TranscriptSegment[] = [];

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.isContentEditable || element?.closest("input, textarea, select"));
}

function formatSize(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/**
 * A voice memo: the recording's waveform to scrub, and its transcript as a
 * document to read along and correct. The player's controls, transcribing,
 * speakers and exports are in the Voice Memo rail tab, which this view
 * renders into the left panel while the tab is active.
 */
export function VoiceMemoViewer({
  tabId,
  file,
  src,
  siblings,
  onShowSibling,
  initialViewState,
  onViewStateChange,
  notes,
}: {
  tabId: string;
  file: LiberaFileNode;
  src?: string;
  /** Recordings in the same folder, in order, for previous and next. */
  siblings: LiberaFileNode[];
  onShowSibling: (file: LiberaFileNode) => void;
  initialViewState?: AudioTabViewState;
  onViewStateChange: (patch: AudioTabViewState) => void;
  /** Saving the transcript as a note. */
  notes?: TranscriptNoteActions;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(initialViewState?.currentTime ?? 0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(initialViewState?.playbackRate ?? 1);
  const [volume, setVolume] = useState(initialViewState?.volume ?? 1);
  const [muted, setMuted] = useState(false);
  const [boost, setBoost] = useState(initialViewState?.boost ?? 1);
  const boostGain = useRef<GainNode | null>(null);
  const boostContext = useRef<AudioContext | null>(null);
  const [follow, setFollow] = useState(initialViewState?.followPlayback ?? true);
  const [speakerFilter, setSpeakerFilter] = useState<number | null>(null);
  const [transcribeAgain, setTranscribeAgain] = useState(false);
  const [markers, setMarkers] = useState<number[]>([]);
  const [searchFocusNonce, setSearchFocusNonce] = useState(0);
  const [loadError, setLoadError] = useState("");
  const transcriptState = useTranscript(file.path);
  const transcript = transcriptState.payload?.transcript ?? null;
  const job = transcriptState.payload?.job ?? null;
  const { peaks, failed: peaksFailed } = useAudioPeaks(file.path);
  const railSlot = useRailSlot(tabId);
  const viewStateRef = useRef(onViewStateChange);
  useLayoutEffect(() => {
    viewStateRef.current = onViewStateChange;
  }, [onViewStateChange]);
  const pendingPlay = useRef(false);

  // The transcript as the reader corrects it; saved once the editing ends.
  const { saveSegments } = transcriptState;
  const draft = useSegmentDraft({
    base: transcript?.segments ?? NO_SEGMENTS,
    saved: null,
    save: ({ segments }, closing) => saveSegments(segments, { keepalive: closing }),
  });
  const segments = draft.segments;
  const editedTranscript = useMemo<Transcript | null>(() => (transcript ? { ...transcript, segments } : null), [segments, transcript]);

  const index = siblings.findIndex((sibling) => sibling.path === file.path);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;
  const knownDuration = duration || peaks?.duration || transcript?.audio.duration || 0;

  // Focus the player when it opens, so its shortcuts work at once.
  useEffect(() => {
    if (!isTyping(document.activeElement)) rootRef.current?.focus({ preventScroll: true });
  }, [file.path]);

  // Smooth playhead while playing; the media element's own events are too coarse.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setCurrentTime(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // Remember where playback was, now and then while playing and whenever it stops.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      viewStateRef.current({ currentTime: audioRef.current?.currentTime ?? 0 });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [playing]);

  useEffect(() => () => {
    const audio = audioRef.current;
    if (audio) viewStateRef.current({ currentTime: audio.currentTime });
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = rate;
    audio.volume = volume;
    audio.muted = muted;
  }, [muted, rate, volume]);

  // Audio Boost: route the element through a gain stage above 100%, with a
  // compressor behind it so a boosted peak squashes instead of clipping. The graph
  // is built only once boost is first used; a media element can be wired up just once.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!boostGain.current) {
      if (boost <= 1) return;
      try {
        const context = new AudioContext();
        const gain = context.createGain();
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -12;
        limiter.knee.value = 12;
        limiter.ratio.value = 6;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.25;
        context.createMediaElementSource(audio).connect(gain).connect(limiter).connect(context.destination);
        boostGain.current = gain;
        boostContext.current = context;
      } catch {
        return;
      }
    }
    const gain = boostGain.current;
    gain.gain.value = boost;
    const context = boostContext.current;
    if (context?.state === "suspended") void context.resume();
  }, [boost, playing]);

  useEffect(() => () => {
    void boostContext.current?.close().catch(() => undefined);
    boostGain.current = null;
    boostContext.current = null;
  }, []);

  const changeBoost = useCallback((value: number) => {
    setBoost(value);
    viewStateRef.current({ boost: value });
  }, []);

  const seek = useCallback((time: number, play = false) => {
    const audio = audioRef.current;
    if (!audio) return;
    const target = Math.max(0, Math.min(knownDuration || time, time));
    audio.currentTime = target;
    setCurrentTime(target);
    if (play) void audio.play().catch(() => undefined);
    else if (audio.paused) viewStateRef.current({ currentTime: target });
  }, [knownDuration]);

  // Opened from a Global Search hit: play the line that matched, or the passage from its start.
  const reveal = initialViewState?.reveal;
  const revealNonce = useRef<number | undefined>(undefined);
  const transcriptLoaded = transcriptState.payload !== null;
  useEffect(() => {
    if (!reveal || reveal.nonce === revealNonce.current) return;
    // Wait for the transcript to find the line, unless there is nothing to look for.
    if (reveal.terms?.length && !transcriptLoaded) return;
    revealNonce.current = reveal.nonce;
    const end = reveal.end ?? Number.POSITIVE_INFINITY;
    const matched = reveal.terms?.length
      ? transcript?.segments.find((segment) => segment.start >= reveal.seconds - 0.05 && segment.start < end && findTermRanges(segment.text, reveal.terms!).length)
      : undefined;
    const target = matched?.start ?? reveal.seconds;
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.readyState >= 1) seek(target, true);
    else {
      setCurrentTime(target);
      pendingPlay.current = true;
    }
  }, [reveal, seek, transcript, transcriptLoaded]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "This recording cannot be played."));
    else audio.pause();
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    seek(0);
  }, [seek]);

  const activeIndex = segmentIndexAt(segments, currentTime);
  const activeSegment = activeIndex >= 0 && currentTime <= (segments[activeIndex]?.end ?? 0) + 1.5 ? segments[activeIndex] : null;

  const stepSegment = useCallback((direction: 1 | -1) => {
    if (!segments.length) return seek(currentTime + direction * SKIP_SECONDS);
    // Back goes to the start of the current segment first, like a track.
    const current = segmentIndexAt(segments, currentTime);
    const target = direction < 0
      ? (current >= 0 && currentTime - segments[current].start > 1.5 ? current : current - 1)
      : current + 1;
    const segment = segments[Math.max(0, Math.min(segments.length - 1, target))];
    if (segment) seek(segment.start, !audioRef.current?.paused);
  }, [currentTime, segments, seek]);

  const chooseRate = useCallback((value: number) => {
    setRate(value);
    viewStateRef.current({ playbackRate: value });
  }, []);

  const stepRate = (direction: 1 | -1) => {
    const position = PLAYBACK_RATES.indexOf(rate);
    chooseRate(PLAYBACK_RATES[Math.max(0, Math.min(PLAYBACK_RATES.length - 1, (position < 0 ? 1 : position) + direction))]);
  };

  const changeVolume = useCallback((value: number) => {
    setVolume(value);
    setMuted(value === 0);
    viewStateRef.current({ volume: value });
  }, []);

  const changeFollow = useCallback((value: boolean) => {
    setFollow(value);
    viewStateRef.current({ followPlayback: value });
  }, []);

  const showControls = useCallback(() => requestRailTab("voice-memo"), []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys typed in the rail tab (rendered here through a portal) are the rail's own.
    if (!rootRef.current?.contains(event.target as Node)) return;
    const findShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
    if (findShortcut) {
      event.preventDefault();
      setSearchFocusNonce((value) => value + 1);
      return;
    }
    if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const handled = (() => {
      switch (event.key) {
        case " ":
        case "k":
          togglePlay();
          return true;
        case "ArrowLeft":
        case "j":
          if (event.shiftKey) stepSegment(-1);
          else seek(currentTime - (event.key === "j" ? 10 : 5));
          return true;
        case "ArrowRight":
        case "l":
          if (event.shiftKey) stepSegment(1);
          else seek(currentTime + (event.key === "l" ? 10 : 5));
          return true;
        case "[":
          if (previous) onShowSibling(previous);
          return true;
        case "]":
          if (next) onShowSibling(next);
          return true;
        case "m":
          setMuted((value) => !value);
          return true;
        case "<":
          stepRate(-1);
          return true;
        case ">":
          stepRate(1);
          return true;
        case "/":
          setSearchFocusNonce((value) => value + 1);
          return true;
        case "Home":
          seek(0);
          return true;
        default:
          return false;
      }
    })();
    if (handled) event.preventDefault();
  };

  const title = file.name.replace(/\.[^.]+$/, "");
  const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase();
  const created = new Date(file.createdAt);
  const details = [extension, knownDuration ? formatDuration(knownDuration) : null, formatSize(file.size), Number.isNaN(created.getTime()) ? null : created.toLocaleDateString(undefined, { dateStyle: "medium" })].filter(Boolean).join(" · ");
  const activeName = activeSegment && transcript ? speakerName(transcript, activeSegment.speaker) : "";
  const canPlay = Boolean(src) && !loadError;

  const player: VoiceMemoPlayer = {
    title,
    details,
    playing,
    canPlay,
    currentTime,
    duration: knownDuration,
    rate,
    volume,
    muted,
    boost,
    previous,
    next,
    togglePlay,
    stop,
    seek: (time) => seek(time),
    setRate: chooseRate,
    setVolume: changeVolume,
    toggleMute: () => setMuted((value) => !value),
    setBoost: changeBoost,
    showSibling: onShowSibling,
  };

  return (
    <div
      ref={rootRef}
      className="libera-media-viewer libera-voice-memo flex min-h-0 flex-1 flex-col overflow-hidden outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
          setLoadError("");
          if (currentTime > 0 && currentTime < audio.duration) audio.currentTime = currentTime;
          if (pendingPlay.current) {
            pendingPlay.current = false;
            void audio.play().catch(() => undefined);
          }
        }}
        onDurationChange={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value)) setDuration(value);
        }}
        onPlay={() => setPlaying(true)}
        onPause={(event) => {
          setPlaying(false);
          setCurrentTime(event.currentTarget.currentTime);
          viewStateRef.current({ currentTime: event.currentTarget.currentTime });
        }}
        onEnded={() => setPlaying(false)}
        onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onError={() => setLoadError("This recording cannot be played here. Its format may not be supported.")}
      />

      <div className="libera-viewer-toolbar flex shrink-0 items-center gap-3 border-b border-input bg-card px-4 py-2">
        <AudioLines aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{details}</span>
        {isJobActive(job) ? (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> Transcribing {Math.round((job?.progress ?? 0) * 100)}%
          </span>
        ) : null}
        {!railSlot ? (
          <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-input px-2.5 text-sm font-medium transition hover:bg-muted" title="Show the player and transcript controls in the left panel" onClick={showControls}>
            <PanelLeft aria-hidden className="h-4 w-4" /> Controls
          </button>
        ) : null}
      </div>

      <div className="mx-auto w-full max-w-3xl shrink-0 space-y-3 px-4 pb-3 pt-5 sm:px-8">
        <div className="space-y-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight" title={file.name}>{title}</h1>
          <div className="min-h-[1.5rem]">
            {activeSegment ? (
              <p className="line-clamp-1 text-[14px] leading-relaxed text-foreground/80" aria-live="off">
                {activeName ? <span className="mr-2 font-semibold" style={{ color: speakerColor(activeSegment.speaker) }}>{activeName}</span> : null}
                {activeSegment.text}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {transcript
                  ? transcript.diarization ? `${transcript.speakers.length === 1 ? "1 speaker" : `${transcript.speakers.length} speakers`} · ${segments.length} passages` : `${segments.length} passages`
                  : isJobActive(job) ? "Transcribing…" : "No transcript yet"}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-2xl border border-border bg-card py-3 pl-3 pr-4 shadow-sm">
          <button
            type="button"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-md transition hover:scale-[1.04] active:scale-95 disabled:opacity-40"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (Space)" : "Play (Space)"}
            disabled={!canPlay}
            onClick={togglePlay}
          >
            {playing ? <Pause aria-hidden className="h-5 w-5" fill="currentColor" /> : <Play aria-hidden className="ml-0.5 h-5 w-5" fill="currentColor" />}
          </button>
          <div className="min-w-0 flex-1 pt-3">
            <Waveform
              peaks={peaks?.peaks ?? null}
              duration={knownDuration}
              currentTime={currentTime}
              segments={segments}
              markers={markers}
              loading={!peaks && !peaksFailed}
              onSeek={(time) => seek(time)}
            />
            <div className="mt-1 flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
              <span>{formatClock(currentTime)}</span>
              <span>-{formatClock(Math.max(0, knownDuration - currentTime))}</span>
            </div>
          </div>
        </div>

        {loadError ? <p className="rounded-lg bg-destructive-muted px-3 py-2 text-sm text-destructive">{loadError}</p> : null}
      </div>

      <TranscriptDocument
        path={file.path}
        fileName={file.name}
        state={transcriptState}
        draft={draft}
        speakerFilter={speakerFilter}
        currentTime={currentTime}
        onSeek={seek}
        onSearchMatches={setMarkers}
        searchFocusNonce={searchFocusNonce}
        follow={follow}
        onFollowChange={changeFollow}
        onShowControls={showControls}
      />

      {railSlot ? createPortal(
        <VoiceMemoControls
          player={player}
          menu={<TranscriptMenu fileName={file.name} notes={notes} state={transcriptState} transcript={editedTranscript} onTranscribeAgain={() => setTranscribeAgain(true)} />}
          transcript={(
            <TranscriptControls
              fileName={file.name}
              state={transcriptState}
              transcript={editedTranscript}
              again={transcribeAgain}
              onAgainChange={setTranscribeAgain}
              speakerFilter={speakerFilter}
              onSpeakerFilterChange={setSpeakerFilter}
              follow={follow}
              onFollowChange={changeFollow}
            />
          )}
        />,
        railSlot,
      ) : null}
    </div>
  );
}
