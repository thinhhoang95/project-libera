"use client";

import { AlertCircle, Loader2, Pause, Play, Square, Volume2, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
  dismissSpeechError,
  getIdleSpeechState,
  getSpeechState,
  stopSpeech,
  subscribeSpeech,
  toggleSpeechPause,
} from "@/lib/tts/player";

/** What is being read aloud in this window; see src/lib/tts/player.ts. */
export function useSpeech() {
  return useSyncExternalStore(subscribeSpeech, getSpeechState, getIdleSpeechState);
}

/**
 * A small bar at the bottom of the window while something is read aloud, from
 * wherever it was started (an editor's menu, a PDF selection, AI Chat), with
 * pause and stop. It also shows why reading failed.
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

  const progress = speech.total > 1 ? ` · ${speech.index + 1} of ${speech.total}` : "";
  const iconButton = "rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";
  return <div role="status" aria-label="Reading aloud" className="libera-read-aloud-bar fixed bottom-4 left-1/2 z-50 flex max-w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card py-1 pl-3 pr-1 text-sm shadow-lg">
    {speech.status === "loading"
      ? <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      : <Volume2 aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />}
    <span className="min-w-0 truncate px-1">
      {speech.status === "loading" && speech.index === 0 ? "Preparing to read" : speech.status === "paused" ? "Paused" : "Reading aloud"}
      {speech.label ? <span className="text-muted-foreground"> · {speech.label}</span> : null}
      <span className="tabular-nums text-muted-foreground">{progress}</span>
    </span>
    <button type="button" className={iconButton} disabled={speech.status === "loading"}
      aria-label={speech.status === "paused" ? "Resume reading" : "Pause reading"} title={speech.status === "paused" ? "Resume" : "Pause"}
      onClick={toggleSpeechPause}>
      {speech.status === "paused" ? <Play aria-hidden className="h-4 w-4" /> : <Pause aria-hidden className="h-4 w-4" />}
    </button>
    <button type="button" className={iconButton} aria-label="Stop reading" title="Stop reading" onClick={stopSpeech}><Square aria-hidden className="h-4 w-4" /></button>
  </div>;
}
