"use client";

import { Download, FolderInput, Loader2, Pause, RefreshCw, Square, Trash2, X } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { RailPanel, RailSection, RailSwitch, railStyles } from "@/components/libera/audio/rail-ui";
import { formatBytesIn } from "@/components/libera/audio/media-format";
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
  const t = useTranslations("recording.recordingControls");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const locale = useLocale();
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
    <RailPanel title={t("recording")}>
      <div className={railStyles.card}>
        <div className="flex items-center justify-center gap-2">
          <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${recording ? "animate-pulse bg-destructive" : "bg-muted-foreground"}`} />
          <span className="font-mono text-2xl font-medium tabular-nums tracking-tight">{formatClock(seconds)}</span>
        </div>
        <p className="mt-0.5 text-center text-[11px] text-muted-foreground">{stopping ? t("savingState") : recording ? t("recordingState") : t("pausedState")}</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {paused ? (
            <button type="button" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-destructive text-sm font-medium text-white transition hover:bg-destructive/90" title={t("resumeTitle")} onClick={() => void recorder.resume()}>
              <span className="h-2.5 w-2.5 rounded-full bg-white" /> {t("resume")}
            </button>
          ) : (
            <button type="button" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-foreground text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40" disabled={!recording} title={t("pauseTitle")} onClick={recorder.pause}>
              <Pause aria-hidden className="h-3.5 w-3.5" fill="currentColor" /> {t("pause")}
            </button>
          )}
          <button type="button" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-card text-sm font-medium transition hover:bg-muted disabled:opacity-50" disabled={stopping} title={t("stopTitle")} onClick={onStop}>
            {stopping ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Square aria-hidden className="h-3 w-3 text-destructive" fill="currentColor" />} {t("stopAndSave")}
          </button>
        </div>
        {session?.parentPath ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground" title={session.parentPath}>
            <FolderInput aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t("savesInto", { path: session.parentPath })}</span>
          </p>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive-muted px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" className="shrink-0" aria-label={tCommon("dismiss")} onClick={recorder.clearError}><X aria-hidden className="h-3.5 w-3.5" /></button>
        </div>
      ) : null}
      {unsavedSeconds > 4 ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t("serverNotAnswering", { duration: formatClock(unsavedSeconds) })}
        </p>
      ) : null}

      <RailSection title={t("whileRecording")}>
        <RailSwitch
          checked={liveTranscribe}
          disabled={!asrReady || stopping}
          label={t("liveTranscribe")}
          hint={asrReady ? t("liveTranscribeHintReady") : t("liveTranscribeHintNeedsModel")}
          onChange={(value) => void recorder.update({ liveTranscribe: value, ...(value ? {} : { liveRecap: false }) })}
        />
        <RailSwitch
          checked={liveRecap}
          disabled={!canRecap || stopping}
          label={t("liveRecap")}
          hint={!setup?.hasApiKey ? t("liveRecapHintNoKey") : !liveTranscribe ? t("liveRecapHintNeedsLive") : t("liveRecapHint")}
          onChange={(value) => void recorder.update({ liveRecap: value })}
        />
        {liveRecap ? (
          <button type="button" className={railStyles.row} disabled={recap?.updating || stopping} title={t("updateRecapTitle")} onClick={() => void recorder.refreshRecap()}>
            {recap?.updating ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw aria-hidden className="h-3.5 w-3.5" />}
            <span>{recap?.updating ? t("updatingRecap") : t("updateRecapNow")}</span>
          </button>
        ) : null}
        {!asrReady ? (
          downloading ? (
            <p className={`${railStyles.note} mt-1 flex items-center gap-1.5`}>
              <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
              {t("downloadingParakeet", { percent: format.number((setup?.models.downloadedBytes ?? 0) / Math.max(1, setup?.models.totalBytes ?? 1), { style: "percent", maximumFractionDigits: 0 }) })}
            </p>
          ) : (
            <button type="button" className={railStyles.row} onClick={() => void recorder.downloadModels()}>
              <Download aria-hidden className="h-3.5 w-3.5" /><span>{t("downloadSpeechModels", { size: formatBytesIn(locale, setup?.models.totalBytes ?? 0) })}</span>
            </button>
          )
        ) : null}
        <p className={`${railStyles.note} mt-1.5 ${session?.transcribeError ? "text-destructive" : ""}`}>
          {session?.transcribeError
            || (pendingChunks > 1 ? t("catchingUp", { count: pendingChunks }) : liveTranscribe ? t("parakeetDescription") : t("notTranscribing"))}
        </p>
      </RailSection>

      <RailSection title={t("correctionsHeading")}>
        <p className={railStyles.note}>
          {t("correctionsNote")}
        </p>
      </RailSection>

      <div className="border-t border-border pt-2">
        <button type="button" className={railStyles.row} data-danger disabled={stopping} onClick={onDiscard}>
          <Trash2 aria-hidden className="h-3.5 w-3.5" /><span>{t("deleteRecording")}</span>
        </button>
      </div>

      <p className={railStyles.note}>{t("spaceNote")}</p>
    </RailPanel>
  );
}
