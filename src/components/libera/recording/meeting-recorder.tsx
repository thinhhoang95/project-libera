"use client";

import { AudioLines, Loader2, Maximize2, Pause, Play, Square, X } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { recordingTabId } from "@/components/libera/recording/recording-tabs";
import { useMeetingRecorder, type MeetingRecorder } from "@/components/libera/recording/use-meeting-recorder";
import type { FinishedRecording, UnfinishedRecording } from "@/lib/recording/types";
import { formatClock } from "@/lib/transcription/format";

type RecorderLauncher = {
  /** Starts recording into the notebook, or into `parentPath`, and opens its tab. */
  startRecording: (notebook: string, parentPath?: string) => void;
  busy: boolean;
};

type RecorderContextValue = {
  launcher: RecorderLauncher;
  recorder: MeetingRecorder;
  /** Deletes the recording and closes its tab. */
  discard: () => Promise<void>;
  /** For a recording left unfinished: record on into it, save it, or delete it. */
  unfinished: {
    recordOn: (id: string) => Promise<void>;
    save: (id: string, notebook: string) => Promise<void>;
    remove: (id: string) => Promise<boolean>;
    saving: string;
    error: string;
  };
};

const RecorderContext = createContext<RecorderContextValue | null>(null);

/** The "New → Audio recording" entry points; null outside the app shell. */
export function useRecorderLauncher() {
  return useContext(RecorderContext)?.launcher ?? null;
}

/** The window's recorder, for the recording tab. */
export function useRecorderContext() {
  return useContext(RecorderContext);
}

export type RecordingTabActions = {
  open: (recordingId: string, name: string, notebook: string) => void;
  rename: (recordingId: string, name: string) => void;
  /** The recording was saved: show the saved voice memo (and its recap) instead. */
  saved: (recordingId: string, finished: FinishedRecording, notebook: string) => void;
  close: (recordingId: string) => void;
};

/**
 * Holds the one recorder of the window. The recording itself shows in its own
 * tab (see RecordingTabView); the recording goes on while the user works in
 * other tabs, with a small bar to come back to it, and recordings that a crash
 * left unfinished are offered here.
 */
export function MeetingRecorderProvider({ children, tabs, visibleTabIds }: { children: ReactNode; tabs: RecordingTabActions; visibleTabIds: readonly string[] }) {
  const recorder = useMeetingRecorder({ onSaved: (finished, notebook, id) => tabs.saved(id, finished, notebook) });
  const [unfinished, setUnfinished] = useState<UnfinishedRecording[]>([]);
  const [recovering, setRecovering] = useState("");
  const [recoverError, setRecoverError] = useState("");

  useEffect(() => {
    let disposed = false;
    void apiRequest<{ recordings: UnfinishedRecording[] }>("/api/recordings")
      .then(({ recordings }) => {
        // A reply without the list (an older server) must not take the workspace down.
        if (!disposed) setUnfinished(recordings ?? []);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  const { start, state, session, resumeUnfinished } = recorder;
  const busy = state !== "idle" && state !== "error";
  const { open, rename, close } = tabs;

  // The tab's title follows the recording's name.
  const sessionId = session?.id;
  const sessionName = session?.name;
  useEffect(() => {
    if (sessionId && sessionName) rename(sessionId, sessionName);
  }, [rename, sessionId, sessionName]);

  // Rebuilt on each render: the recorder's state changes several times a second while recording anyway.
  const value: RecorderContextValue = {
    launcher: {
      startRecording: (notebook, parentPath) => {
        void start(notebook, parentPath).then((created) => {
          if (created) open(created.id, created.name, created.notebook);
        });
      },
      busy,
    },
    recorder,
    discard: async () => {
      const id = recorder.session?.id;
      await recorder.discard();
      if (id) close(id);
    },
    unfinished: { recordOn, save: saveUnfinished, remove: discardUnfinished, saving: recovering, error: recoverError },
  };

  async function saveUnfinished(id: string, notebook: string) {
    setRecovering(id);
    setRecoverError("");
    try {
      const finished = await apiRequest<FinishedRecording>(`/api/recordings/${id}/finish`, { method: "POST" });
      setUnfinished((current) => current.filter((item) => item.id !== id));
      tabs.saved(id, finished, notebook);
    } catch (failure) {
      setRecoverError(failure instanceof Error ? failure.message : "Could not save the recording.");
    } finally {
      setRecovering("");
    }
  }

  async function recordOn(id: string) {
    setUnfinished((current) => current.filter((item) => item.id !== id));
    const status = await resumeUnfinished(id);
    if (status) open(status.id, status.name, status.notebook);
  }

  /** Asks first; true when it was deleted. */
  async function discardUnfinished(id: string) {
    if (!window.confirm("Delete this unfinished recording? This cannot be undone.")) return false;
    await apiRequest(`/api/recordings/${id}`, { method: "DELETE" }).catch(() => undefined);
    setUnfinished((current) => current.filter((item) => item.id !== id));
    close(id);
    return true;
  }

  const tabVisible = Boolean(session && visibleTabIds.includes(recordingTabId(session.id)));
  const card = "fixed bottom-4 left-16 z-50 w-[360px] max-w-[calc(100vw-5rem)] rounded-xl border border-border bg-card text-sm shadow-xl";

  let overlay: ReactNode = null;
  if (state === "starting") {
    overlay = (
      <div role="status" className={`${card} flex items-center gap-2 p-3`}>
        <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" />
        <span className="min-w-0 flex-1">Starting the microphone…</span>
        <button type="button" className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={recorder.cancelStart}>Cancel</button>
      </div>
    );
  } else if (state === "error") {
    overlay = (
      <div role="alert" className={`${card} flex items-start gap-2 p-3`}>
        <span className="min-w-0 flex-1 text-destructive">{recorder.error}</span>
        <button type="button" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted" aria-label="Close" onClick={recorder.close}><X aria-hidden className="h-3.5 w-3.5" /></button>
      </div>
    );
  } else if (session && !tabVisible) {
    // Recording on while another tab is in front.
    const recording = state === "recording";
    overlay = (
      <div role="region" aria-label="Recording" className="fixed bottom-4 left-16 z-50 flex max-w-[calc(100vw-5rem)] items-center gap-2 rounded-full border border-border bg-card py-1 pl-3 pr-1 text-sm shadow-xl">
        <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${recording ? "animate-pulse bg-destructive" : "bg-muted-foreground"}`} />
        <span className="font-mono tabular-nums">{formatClock(recorder.seconds)}</span>
        <span className="max-w-40 truncate text-muted-foreground">{state === "stopping" ? "Saving…" : session.name}</span>
        {state === "paused" ? (
          <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted" aria-label="Resume recording" title="Resume" onClick={() => void recorder.resume()}><Play aria-hidden className="h-3.5 w-3.5" fill="currentColor" /></button>
        ) : (
          <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted disabled:opacity-40" disabled={!recording} aria-label="Pause recording" title="Pause" onClick={recorder.pause}><Pause aria-hidden className="h-3.5 w-3.5" fill="currentColor" /></button>
        )}
        <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-full text-destructive hover:bg-destructive/10 disabled:opacity-40" disabled={state === "stopping"} aria-label="Stop and save" title="Stop and save" onClick={() => void recorder.stop()}><Square aria-hidden className="h-3 w-3" fill="currentColor" /></button>
        <button type="button" className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium hover:bg-muted" title="Show the recording" onClick={() => open(session.id, session.name, session.notebook)}>
          <Maximize2 aria-hidden className="h-3.5 w-3.5" /> Show
        </button>
      </div>
    );
  } else if (state === "idle" && unfinished.some((recording) => !visibleTabIds.includes(recordingTabId(recording.id)))) {
    overlay = (
      <div role="region" aria-label="Unfinished recordings" className={`${card} p-3`}>
        <div className="mb-2 flex items-center gap-2 font-medium">
          <AudioLines aria-hidden className="h-4 w-4 text-accent" />
          {unfinished.length === 1 ? "A recording was not finished" : `${unfinished.length} recordings were not finished`}
          <button type="button" className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted" aria-label="Later" title="Later" onClick={() => setUnfinished([])}>
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">Libera closed while recording. What was recorded up to then is safe.</p>
        <ul className="flex flex-col gap-2">
          {/* A recording whose tab is in view offers the same choices there. */}
          {unfinished.filter((recording) => !visibleTabIds.includes(recordingTabId(recording.id))).map((recording) => (
            <li key={recording.id} className="rounded-lg border border-border px-2.5 py-2">
              <div className="truncate font-medium">{recording.name}</div>
              <div className="mb-1.5 text-xs text-muted-foreground">{formatClock(recording.savedSeconds)} in {recording.parentPath}</div>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50" disabled={Boolean(recovering)} onClick={() => void saveUnfinished(recording.id, recording.notebook)}>
                  {recovering === recording.id ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : null} Save
                </button>
                <button type="button" className="h-7 rounded-md border border-border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={Boolean(recovering)} onClick={() => void recordOn(recording.id)}>
                  Record on
                </button>
                <button type="button" className="ml-auto h-7 rounded-md px-2 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50" disabled={Boolean(recovering)} onClick={() => void discardUnfinished(recording.id)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
        {recoverError ? <p role="alert" className="mt-2 text-xs text-destructive">{recoverError}</p> : null}
      </div>
    );
  }

  return (
    <RecorderContext.Provider value={value}>
      {children}
      {overlay}
    </RecorderContext.Provider>
  );
}
