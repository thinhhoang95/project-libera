"use client";

import { Download, FolderInput, Loader2, Pause, RefreshCw, Square, Trash2, X } from "lucide-react";
import { RailPanel, RailSection, RailSwitch, railStyles } from "@/components/libera/audio/rail-ui";
import type { MeetingRecorder } from "@/components/libera/recording/use-meeting-recorder";
import { formatClock } from "@/lib/transcription/format";

/**
 * The Recording rail tab: pause, resume, stop and save or delete the
 * recording in progress, and what Libera does while it records.
 */
export function RecordingControls({ recorder, onStop, onDiscard }: {
  recorder: MeetingRecorder;
  /** Saves the edits being made, then stops and saves the recording. */
  onStop: () => void;
  onDiscard: () => void;
}) {
  const { state, error, session, setup, seconds, unsavedSeconds, recap } = recorder;
  const recording = state === "recording";
  const paused = state === "paused";
  const stopping = state === "stopping";
  const asrReady = Boolean(setup?.models.asr);
  const downloading = setup?.models.state === "downloading";
  const liveTranscribe = Boolean(session?.liveTranscribe);
  const liveRecap = Boolean(session?.liveRecap);
  const canRecap = asrReady && liveTranscribe && Boolean(setup?.hasApiKey);
  const pendingChunks = session?.pendingChunks ?? 0;

  return (
    <RailPanel title="Recording">
      <div className={railStyles.card}>
        <div className="flex items-center justify-center gap-2">
          <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${recording ? "animate-pulse bg-destructive" : "bg-muted-foreground"}`} />
          <span className="font-mono text-2xl font-medium tabular-nums tracking-tight">{formatClock(seconds)}</span>
        </div>
        <p className="mt-0.5 text-center text-[11px] text-muted-foreground">{stopping ? "Saving…" : recording ? "Recording" : "Paused"}</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {paused ? (
            <button type="button" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-destructive text-sm font-medium text-white transition hover:bg-destructive/90" title="Resume (Space)" onClick={() => void recorder.resume()}>
              <span className="h-2.5 w-2.5 rounded-full bg-white" /> Resume
            </button>
          ) : (
            <button type="button" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-foreground text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40" disabled={!recording} title="Pause (Space)" onClick={recorder.pause}>
              <Pause aria-hidden className="h-3.5 w-3.5" fill="currentColor" /> Pause
            </button>
          )}
          <button type="button" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-card text-sm font-medium transition hover:bg-muted disabled:opacity-50" disabled={stopping} title="Stop, and save the recording, its transcript and recap into the notebook" onClick={onStop}>
            {stopping ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Square aria-hidden className="h-3 w-3 text-destructive" fill="currentColor" />} Stop &amp; save
          </button>
        </div>
        {session?.parentPath ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground" title={session.parentPath}>
            <FolderInput aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Saves into {session.parentPath}</span>
          </p>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive-muted px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" className="shrink-0" aria-label="Dismiss" onClick={recorder.clearError}><X aria-hidden className="h-3.5 w-3.5" /></button>
        </div>
      ) : null}
      {unsavedSeconds > 4 ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          Libera’s server is not answering; {formatClock(unsavedSeconds)} of audio is kept in this window until it can be saved.
        </p>
      ) : null}

      <RailSection title="While recording">
        <RailSwitch
          checked={liveTranscribe}
          disabled={!asrReady || stopping}
          label="Live transcribe"
          hint={asrReady ? "Transcribes as you record, with Parakeet on this computer" : "Needs the Parakeet speech model"}
          onChange={(value) => void recorder.update({ liveTranscribe: value, ...(value ? {} : { liveRecap: false }) })}
        />
        <RailSwitch
          checked={liveRecap}
          disabled={!canRecap || stopping}
          label="Live recap"
          hint={!setup?.hasApiKey ? "Needs an OpenRouter API key (Preferences → AI)" : !liveTranscribe ? "Needs live transcription" : "Keeps a bullet-point recap with the AI model"}
          onChange={(value) => void recorder.update({ liveRecap: value })}
        />
        {liveRecap ? (
          <button type="button" className={railStyles.row} disabled={recap?.updating || stopping} title="Bring the recap up to date now" onClick={() => void recorder.refreshRecap()}>
            {recap?.updating ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw aria-hidden className="h-3.5 w-3.5" />}
            <span>{recap?.updating ? "Updating the recap…" : "Update the recap now"}</span>
          </button>
        ) : null}
        {!asrReady ? (
          downloading ? (
            <p className={`${railStyles.note} mt-1 flex items-center gap-1.5`}>
              <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
              Downloading Parakeet… {Math.round(((setup?.models.downloadedBytes ?? 0) / Math.max(1, setup?.models.totalBytes ?? 1)) * 100)}%
            </p>
          ) : (
            <button type="button" className={railStyles.row} onClick={() => void recorder.downloadModels()}>
              <Download aria-hidden className="h-3.5 w-3.5" /><span>Download speech models ({Math.round((setup?.models.totalBytes ?? 0) / 1e6)} MB)</span>
            </button>
          )
        ) : null}
        <p className={`${railStyles.note} mt-1.5 ${session?.transcribeError ? "text-destructive" : ""}`}>
          {session?.transcribeError
            || (pendingChunks > 1 ? `Catching up: ${pendingChunks} pieces to transcribe…` : liveTranscribe ? "Parakeet TDT v3, on this computer, about a phrase behind." : "Not transcribing. The recording can be transcribed once saved.")}
        </p>
      </RailSection>

      <RailSection title="Your corrections">
        <p className={railStyles.note}>
          Click into the recap or the transcript to correct it while you record; Enter starts a new line. Your changes are kept when you click away, and the saved recording has them. The recap leaves points you wrote or changed as they are.
        </p>
      </RailSection>

      <div className="border-t border-border pt-2">
        <button type="button" className={railStyles.row} data-danger disabled={stopping} onClick={onDiscard}>
          <Trash2 aria-hidden className="h-3.5 w-3.5" /><span>Delete the recording</span>
        </button>
      </div>

      <p className={railStyles.note}>Space pause/resume · Recording goes on in other tabs.</p>
    </RailPanel>
  );
}
