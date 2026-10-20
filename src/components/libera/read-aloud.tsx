"use client";

import { AlertCircle, Loader2, Pause, Play, SkipBack, SkipForward, Square, Volume2, X } from "lucide-react";
import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import {
  dismissSpeechError,
  getIdleSpeechState,
  getSpeechPassage,
  getSpeechProgress,
  getSpeechState,
  seekSpeech,
  skipSpeechPassage,
  stopSpeech,
  subscribeSpeech,
  subscribeSpeechProgress,
  toggleSpeechPause,
} from "@/lib/tts/player";

/** What is being read aloud in this window; see src/lib/tts/player.ts. */
export function useSpeech() {
  return useSyncExternalStore(subscribeSpeech, getSpeechState, getIdleSpeechState);
}

/**
 * A small bar at the bottom of the window while something is read aloud, from
 * wherever it was started (an editor's menu, a PDF selection, AI Chat), with
 * pause, stop, previous/next passage and a slider to jump anywhere in the
 * reading. It also shows why reading failed.
 */
export function ReadAloudBar() {
  const speech = useSpeech();
  if (speech.status === "idle" && !speech.error) return null;

  if (speech.status === "idle") {
    return <div role="alert" className="fixed bottom-4 left-1/2 z-50 flex max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-xl border border-destructive/30 bg-card px-3 py-2 text-sm shadow-lg">
      <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">{speech.error}</span>
      {window.liberaPreferences?.open && /Preferences/.test(speech.error) ? <button type="button" className="-my-1 shrink-0 rounded-md px-2 py-1 text-xs font-medium text-foreground hover:bg-muted" onClick={() => { dismissSpeechError(); void window.liberaPreferences?.open("read-aloud"); }}>Read Aloud settings</button> : null}
      <button type="button" className="-my-1 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Dismiss" title="Dismiss" onClick={dismissSpeechError}><X aria-hidden className="h-4 w-4" /></button>
    </div>;
  }

  const preparing = speech.status === "loading" && speech.index === 0 && getSpeechProgress() === 0;
  const progress = speech.total > 1 ? ` · ${speech.index + 1} of ${speech.total}` : "";
  const iconButton = "rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";
  return <div role="status" aria-label="Reading aloud" className="libera-read-aloud-bar fixed bottom-4 left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-2xl border border-border bg-card px-3 pb-2 pt-1 text-sm shadow-lg">
    <div className="flex items-center gap-1">
      {speech.status === "loading"
        ? <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        : <Volume2 aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate px-1">
        {preparing ? "Preparing to read" : speech.status === "paused" ? "Paused" : "Reading aloud"}
        {speech.label ? <span className="text-muted-foreground"> · {speech.label}</span> : null}
        <span className="tabular-nums text-muted-foreground">{progress}</span>
      </span>
      <button type="button" className={iconButton} disabled={preparing}
        aria-label="Previous passage" title="Previous passage (or back to the start of this one)"
        onClick={() => skipSpeechPassage(-1)}>
        <SkipBack aria-hidden className="h-4 w-4" />
      </button>
      <button type="button" className={iconButton} disabled={speech.status === "loading"}
        aria-label={speech.status === "paused" ? "Resume reading" : "Pause reading"} title={speech.status === "paused" ? "Resume" : "Pause"}
        onClick={toggleSpeechPause}>
        {speech.status === "paused" ? <Play aria-hidden className="h-4 w-4" /> : <Pause aria-hidden className="h-4 w-4" />}
      </button>
      <button type="button" className={iconButton} disabled={preparing || speech.index >= speech.total - 1}
        aria-label="Next passage" title="Next passage"
        onClick={() => skipSpeechPassage(1)}>
        <SkipForward aria-hidden className="h-4 w-4" />
      </button>
      <button type="button" className={iconButton} aria-label="Stop reading" title="Stop reading" onClick={stopSpeech}><Square aria-hidden className="h-4 w-4" /></button>
    </div>
    <SpeechScrubber total={speech.total} disabled={preparing} />
  </div>;
}

/**
 * The slider across everything being read. Dragging previews the passage it
 * would land on and jumps only on release, so passages are not synthesized
 * for every position dragged past.
 */
function SpeechScrubber({ total, disabled }: { total: number; disabled: boolean }) {
  const position = useSyncExternalStore(subscribeSpeechProgress, getSpeechProgress, () => 0);
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const pointerDown = useRef(false);
  const shown = drag ?? position;
  const previewIndex = drag === null ? -1 : Math.min(Math.floor(drag), total - 1);

  const commit = () => {
    pointerDown.current = false;
    if (dragRef.current !== null) seekSpeech(dragRef.current);
    dragRef.current = null;
    setDrag(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => skipSpeechPassage(-1),
      ArrowDown: () => skipSpeechPassage(-1),
      ArrowRight: () => skipSpeechPassage(1),
      ArrowUp: () => skipSpeechPassage(1),
      Home: () => seekSpeech(0),
      End: () => seekSpeech(total - 1),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return <div className="relative">
    {previewIndex >= 0 ? <div aria-hidden className="absolute bottom-full left-0 right-0 mb-3 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      <div className="mb-0.5 font-medium tabular-nums text-muted-foreground">Passage {previewIndex + 1} of {total}</div>
      <div className="line-clamp-3">{getSpeechPassage(previewIndex)}</div>
    </div> : null}
    <input type="range" min={0} max={total} step="any" value={shown} disabled={disabled}
      aria-label="Position in reading" aria-valuetext={`Passage ${Math.min(Math.floor(shown), total - 1) + 1} of ${total}`}
      className="block h-4 w-full cursor-pointer accent-primary disabled:cursor-default disabled:opacity-40"
      onPointerDown={() => { pointerDown.current = true; }}
      onPointerUp={commit}
      onLostPointerCapture={() => { if (pointerDown.current) commit(); }}
      onKeyDown={onKeyDown}
      onChange={(event) => {
        const value = Number(event.target.value);
        if (!pointerDown.current) {
          seekSpeech(value);
          return;
        }
        dragRef.current = value;
        setDrag(value);
      }} />
  </div>;
}
