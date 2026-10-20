"use client";

import {
  AudioLines,
  Gauge,
  Pause,
  PanelRight,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Square,
  Zap,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { speakerColor } from "@/components/libera/audio/speaker-colors";
import { TranscriptPanel, type TranscriptNoteActions } from "@/components/libera/audio/transcript-panel";
import { isJobActive, useAudioPeaks, useTranscript } from "@/components/libera/audio/use-voice-memo";
import { Waveform } from "@/components/libera/audio/waveform";
import type { AudioTabViewState } from "@/components/libera/types";
import { findTermRanges } from "@/lib/global-search";
import { formatClock, formatDuration, segmentIndexAt, speakerName } from "@/lib/transcription/format";
import type { LiberaFileNode } from "@/lib/types";

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SKIP_SECONDS = 15;
const BOOST_MAX = 4;
const BOOST_DEFAULT = 2;
const PANEL_MIN = 300;
const PANEL_MAX = 720;
const PANEL_DEFAULT = 400;

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable=true]"));
}

function formatSize(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

const controlButton = "inline-flex items-center justify-center rounded-full text-foreground/80 transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35";

/**
 * A voice memo: a player with the recording's waveform and transport
 * controls, and its transcript in a panel beside it, where reading and
 * listening stay in step.
 */
export function VoiceMemoViewer({
  file,
  src,
  siblings,
  onShowSibling,
  initialViewState,
  onViewStateChange,
  notes,
}: {
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
  const [panelOpen, setPanelOpen] = useState(initialViewState?.transcriptOpen ?? true);
  const [panelWidth, setPanelWidth] = useState(initialViewState?.transcriptWidth ?? PANEL_DEFAULT);
  const [follow, setFollow] = useState(initialViewState?.followPlayback ?? true);
  const [markers, setMarkers] = useState<number[]>([]);
  const [searchFocusNonce, setSearchFocusNonce] = useState(0);
  const [loadError, setLoadError] = useState("");
  const transcriptState = useTranscript(file.path);
  const transcript = transcriptState.payload?.transcript ?? null;
  const job = transcriptState.payload?.job ?? null;
  const { peaks, failed: peaksFailed } = useAudioPeaks(file.path);
  const viewStateRef = useRef(onViewStateChange);
  useLayoutEffect(() => {
    viewStateRef.current = onViewStateChange;
  }, [onViewStateChange]);
  const pendingPlay = useRef(false);

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

  const segments = useMemo(() => transcript?.segments ?? [], [transcript]);
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

  const changeRate = useCallback((direction: 1 | -1 | 0) => {
    setRate((value) => {
      const position = RATES.indexOf(value);
      const nextRate = direction === 0
        ? RATES[(position + 1) % RATES.length]
        : RATES[Math.max(0, Math.min(RATES.length - 1, (position < 0 ? 1 : position) + direction))];
      viewStateRef.current({ playbackRate: nextRate });
      return nextRate;
    });
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      viewStateRef.current({ transcriptOpen: !open });
      return !open;
    });
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const findShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
    if (findShortcut) {
      event.preventDefault();
      if (!panelOpen) togglePanel();
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
        case "t":
          togglePanel();
          return true;
        case "m":
          setMuted((value) => !value);
          return true;
        case "<":
          changeRate(-1);
          return true;
        case ">":
          changeRate(1);
          return true;
        case "/":
          if (!panelOpen) togglePanel();
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

  // Drag the panel's edge to resize it.
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeFrom.current = { x: event.clientX, width: panelWidth };
  };
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const available = (rootRef.current?.clientWidth ?? 1200) - 360;
    setPanelWidth(Math.max(PANEL_MIN, Math.min(PANEL_MAX, available, resizeFrom.current.width + resizeFrom.current.x - event.clientX)));
  };
  const onResizeEnd = () => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    viewStateRef.current({ transcriptWidth: panelWidth });
  };

  const title = file.name.replace(/\.[^.]+$/, "");
  const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase();
  const created = new Date(file.createdAt);
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const activeName = activeSegment && transcript ? speakerName(transcript, activeSegment.speaker) : "";

  return (
    <div
      ref={rootRef}
      className="libera-media-viewer libera-voice-memo flex min-h-0 flex-1 overflow-hidden outline-none"
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

      <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="libera-viewer-toolbar flex items-center gap-3 border-b border-input bg-card px-4 py-2">
          <AudioLines aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {[extension, knownDuration ? formatDuration(knownDuration) : null, formatSize(file.size), Number.isNaN(created.getTime()) ? null : created.toLocaleDateString(undefined, { dateStyle: "medium" })].filter(Boolean).join(" · ")}
          </span>
          {isJobActive(job) && !panelOpen ? (
            <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs text-muted-foreground" onClick={togglePanel}>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> Transcribing {Math.round((job?.progress ?? 0) * 100)}%
            </button>
          ) : null}
          <button
            type="button"
            aria-pressed={panelOpen}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition ${panelOpen ? "border-transparent bg-foreground text-background" : "border-input hover:bg-muted"}`}
            title="Transcript (T)"
            onClick={togglePanel}
          >
            <PanelRight aria-hidden className="h-4 w-4" /> Transcript
          </button>
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-6 py-8 sm:px-10">
          <div className="space-y-1.5">
            <h1 className="truncate text-2xl font-semibold tracking-tight" title={file.name}>{title}</h1>
            <div className="min-h-[3.25rem]">
              {activeSegment ? (
                <p className="line-clamp-2 text-[15px] leading-relaxed text-foreground/80" aria-live="off">
                  {activeName ? <span className="mr-2 font-semibold" style={{ color: speakerColor(activeSegment.speaker) }}>{activeName}</span> : null}
                  {activeSegment.text}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {transcript
                    ? transcript.diarization ? `${transcript.speakers.length === 1 ? "1 speaker" : `${transcript.speakers.length} speakers`} · ${transcript.segments.length} passages` : `${transcript.segments.length} passages`
                    : isJobActive(job) ? "Transcribing…" : "No transcript yet"}
                </p>
              )}
            </div>
          </div>

          <div className="@container rounded-2xl border border-border bg-card px-5 pb-4 pt-8 shadow-sm">
            <Waveform
              peaks={peaks?.peaks ?? null}
              duration={knownDuration}
              currentTime={currentTime}
              segments={segments}
              markers={markers}
              loading={!peaks && !peaksFailed}
              onSeek={(time) => seek(time)}
            />
            <div className="mt-2 flex justify-between font-mono text-xs tabular-nums text-muted-foreground">
              <span>{formatClock(currentTime)}</span>
              <span>-{formatClock(Math.max(0, knownDuration - currentTime))}</span>
            </div>

            {/* Narrow: the transport on its own row, speed and volume beneath. Wide: one row. */}
            <div className="mt-3 grid grid-cols-2 items-center gap-x-2 gap-y-1 @lg:grid-cols-[1fr_auto_1fr]">
              <div className="col-start-1 row-start-2 flex items-center gap-1 @lg:row-start-1">
                <button type="button" className={`${controlButton} h-8 px-2 text-xs font-semibold tabular-nums`} title="Playback speed (< and >)" aria-label={`Playback speed ${rate}×`} onClick={() => changeRate(0)}>
                  <Gauge aria-hidden className="mr-1 h-3.5 w-3.5" />{rate}×
                </button>
              </div>

              <div className="col-span-2 row-start-1 flex items-center justify-self-center gap-1 @sm:gap-2 @lg:col-span-1 @lg:col-start-2">
                <button type="button" className={`${controlButton} h-9 w-9`} aria-label="Previous recording" title={previous ? `Previous: ${previous.name} ([)` : "No previous recording"} disabled={!previous} onClick={() => previous && onShowSibling(previous)}>
                  <SkipBack aria-hidden className="h-4 w-4" />
                </button>
                <button type="button" className={`${controlButton} h-9 w-9`} aria-label={`Back ${SKIP_SECONDS} seconds`} title={`Back ${SKIP_SECONDS} s (←)`} onClick={() => seek(currentTime - SKIP_SECONDS)}>
                  <span className="relative inline-flex"><RotateCcw aria-hidden className="h-[18px] w-[18px]" /><span className="absolute inset-0 flex items-center justify-center pt-px text-[7px] font-bold">{SKIP_SECONDS}</span></span>
                </button>
                <button
                  type="button"
                  className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-foreground text-background shadow-md transition hover:scale-[1.04] active:scale-95 disabled:opacity-40"
                  aria-label={playing ? "Pause" : "Play"}
                  title={playing ? "Pause (Space)" : "Play (Space)"}
                  disabled={!src || Boolean(loadError)}
                  onClick={togglePlay}
                >
                  {playing ? <Pause aria-hidden className="h-6 w-6" fill="currentColor" /> : <Play aria-hidden className="ml-0.5 h-6 w-6" fill="currentColor" />}
                </button>
                <button type="button" className={`${controlButton} h-9 w-9`} aria-label={`Forward ${SKIP_SECONDS} seconds`} title={`Forward ${SKIP_SECONDS} s (→)`} onClick={() => seek(currentTime + SKIP_SECONDS)}>
                  <span className="relative inline-flex"><RotateCw aria-hidden className="h-[18px] w-[18px]" /><span className="absolute inset-0 flex items-center justify-center pt-px text-[7px] font-bold">{SKIP_SECONDS}</span></span>
                </button>
                <button type="button" className={`${controlButton} h-9 w-9`} aria-label="Next recording" title={next ? `Next: ${next.name} (])` : "No next recording"} disabled={!next} onClick={() => next && onShowSibling(next)}>
                  <SkipForward aria-hidden className="h-4 w-4" />
                </button>
              </div>

              <div className="col-start-2 row-start-2 flex items-center justify-end gap-1 @lg:col-start-3 @lg:row-start-1">
                <button type="button" className={`${controlButton} h-8 w-8`} aria-label="Stop" title="Stop" disabled={!playing && currentTime === 0} onClick={stop}>
                  <Square aria-hidden className="h-3.5 w-3.5" fill="currentColor" />
                </button>
                <div className="group flex items-center">
                  <input
                    type="range"
                    aria-label="Audio Boost"
                    min={1}
                    max={BOOST_MAX}
                    step={0.25}
                    value={boost}
                    className="h-1 w-0 cursor-pointer opacity-0 transition-all duration-200 accent-[var(--foreground)] group-focus-within:w-20 group-focus-within:opacity-100 group-hover:w-20 group-hover:opacity-100"
                    onChange={(event) => changeBoost(Number(event.target.value))}
                  />
                  <button
                    type="button"
                    aria-pressed={boost > 1}
                    className={`${controlButton} h-8 gap-0.5 px-2 text-xs font-semibold tabular-nums ${boost > 1 ? "bg-foreground text-background hover:bg-foreground/90 hover:text-background" : ""}`}
                    aria-label={boost > 1 ? `Audio Boost ${Math.round(boost * 100)}%` : "Audio Boost off"}
                    title="Audio Boost: play louder than 100%, for quiet recordings"
                    onClick={() => changeBoost(boost > 1 ? 1 : BOOST_DEFAULT)}
                  >
                    <Zap aria-hidden className="h-3.5 w-3.5" />{boost > 1 ? `${Math.round(boost * 100)}%` : null}
                  </button>
                </div>
                <div className="group flex items-center">
                  <button type="button" className={`${controlButton} h-8 w-8`} aria-label={muted ? "Unmute" : "Mute"} title="Mute (M)" onClick={() => setMuted((value) => !value)}>
                    <VolumeIcon aria-hidden className="h-4 w-4" />
                  </button>
                  <input
                    type="range"
                    aria-label="Volume"
                    min={0}
                    max={1}
                    step={0.05}
                    value={muted ? 0 : volume}
                    className="h-1 w-0 cursor-pointer opacity-0 transition-all duration-200 accent-[var(--foreground)] group-focus-within:w-20 group-focus-within:opacity-100 group-hover:w-20 group-hover:opacity-100"
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setVolume(value);
                      setMuted(value === 0);
                      viewStateRef.current({ volume: value });
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          {loadError ? <p className="rounded-lg bg-destructive-muted px-3 py-2 text-sm text-destructive">{loadError}</p> : null}

          <p className="text-center text-[11px] text-muted-foreground/80">
            Space play · ← → 5 s · Shift+← → passage · [ ] recording · T transcript · ⌘F find
          </p>
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
          <div className="flex min-h-0 shrink-0" style={{ width: panelWidth }}>
            <TranscriptPanel
              path={file.path}
              fileName={file.name}
              notes={notes}
              state={transcriptState}
              currentTime={currentTime}
              onSeek={seek}
              onSearchMatches={setMarkers}
              searchFocusNonce={searchFocusNonce}
              onClose={togglePanel}
              follow={follow}
              onFollowChange={(value) => {
                setFollow(value);
                viewStateRef.current({ followPlayback: value });
              }}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
