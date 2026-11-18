"use client";

import { Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward, Square, Volume1, Volume2, VolumeX, type LucideIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { RailPanel, RailSection, RailSwitch, railStyles } from "@/components/libera/audio/rail-ui";
import { formatClock } from "@/lib/transcription/format";
import type { LiberaFileNode } from "@/lib/types";

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
export const SKIP_SECONDS = 15;
export const BOOST_MAX = 4;
export const BOOST_DEFAULT = 2;

/** The player as the rail tab drives it; the viewer owns the audio. */
export type VoiceMemoPlayer = {
  title: string;
  /** Format, length, size and date. */
  details: string;
  playing: boolean;
  canPlay: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  volume: number;
  muted: boolean;
  boost: number;
  previous?: LiberaFileNode;
  next?: LiberaFileNode;
  togglePlay: () => void;
  stop: () => void;
  seek: (time: number) => void;
  /** Seeks relative to where playback really is (currentTime is updated a few times a second only). */
  skip: (seconds: number) => void;
  setRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  setBoost: (boost: number) => void;
  showSibling: (file: LiberaFileNode) => void;
};

const transportButton = "inline-flex items-center justify-center rounded-full text-foreground/80 transition hover:bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] hover:text-foreground disabled:pointer-events-none disabled:opacity-35";

function SkipIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="relative inline-flex">
      <Icon aria-hidden className="h-[18px] w-[18px]" />
      <span className="absolute inset-0 flex items-center justify-center pt-px text-[7px] font-bold">{SKIP_SECONDS}</span>
    </span>
  );
}

/**
 * The Voice Memo rail tab: the player's transport and sound, then the
 * transcript's controls (`transcript`, from TranscriptControls), with the
 * copy, export and transcription menu (`menu`) beside the title.
 */
export function VoiceMemoControls({ player, transcript, menu }: { player: VoiceMemoPlayer; transcript: ReactNode; menu: ReactNode }) {
  const t = useTranslations("audio.voiceMemoControls");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const { playing, currentTime, duration, previous, next } = player;
  const VolumeIcon = player.muted || player.volume === 0 ? VolumeX : player.volume < 0.5 ? Volume1 : Volume2;

  return (
    <RailPanel title={t("title")} actions={menu}>
      <div className={railStyles.card}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold" title={player.title}>{player.title}</p>
            <p className="truncate text-[11px] text-muted-foreground">{player.details}</p>
          </div>
          <button type="button" className={`${transportButton} h-7 w-7 shrink-0`} aria-label={tCommon("stop")} title={t("stopTitle")} disabled={!playing && currentTime === 0} onClick={player.stop}>
            <Square aria-hidden className="h-3 w-3" fill="currentColor" />
          </button>
        </div>
        <input
          type="range"
          aria-label={t("position")}
          min={0}
          max={Math.max(duration, 0.01)}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          disabled={!duration}
          className={`${railStyles.slider} mt-3`}
          onChange={(event) => player.seek(Number(event.target.value))}
        />
        <div className="mt-1 flex justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
          <span>{formatClock(currentTime)}</span>
          <span>-{formatClock(Math.max(0, duration - currentTime))}</span>
        </div>
        <div className="mt-2 flex items-center justify-center gap-1">
          <button type="button" className={`${transportButton} h-8 w-8`} aria-label={t("previousRecording")} title={previous ? t("previousTitle", { name: previous.name }) : t("noPrevious")} disabled={!previous} onClick={() => previous && player.showSibling(previous)}>
            <SkipBack aria-hidden className="h-4 w-4" />
          </button>
          <button type="button" className={`${transportButton} h-9 w-9`} aria-label={t("backAria", { seconds: SKIP_SECONDS })} title={t("backTitle", { seconds: SKIP_SECONDS })} onClick={() => player.skip(-SKIP_SECONDS)}>
            <SkipIcon icon={RotateCcw} />
          </button>
          <button
            type="button"
            className="mx-1 inline-flex h-12 w-12 items-center justify-center rounded-full bg-foreground text-background shadow-md transition hover:scale-[1.04] active:scale-95 disabled:opacity-40"
            aria-label={playing ? t("pause") : t("play")}
            title={playing ? t("pauseSpace") : t("playSpace")}
            disabled={!player.canPlay}
            onClick={player.togglePlay}
          >
            {playing ? <Pause aria-hidden className="h-5 w-5" fill="currentColor" /> : <Play aria-hidden className="ml-0.5 h-5 w-5" fill="currentColor" />}
          </button>
          <button type="button" className={`${transportButton} h-9 w-9`} aria-label={t("forwardAria", { seconds: SKIP_SECONDS })} title={t("forwardTitle", { seconds: SKIP_SECONDS })} onClick={() => player.skip(SKIP_SECONDS)}>
            <SkipIcon icon={RotateCw} />
          </button>
          <button type="button" className={`${transportButton} h-8 w-8`} aria-label={t("nextRecording")} title={next ? t("nextTitle", { name: next.name }) : t("noNext")} disabled={!next} onClick={() => next && player.showSibling(next)}>
            <SkipForward aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>

      <RailSection title={t("playback")}>
        <div className={railStyles.segmented} role="radiogroup" aria-label={t("playbackSpeed")} title={t("playbackSpeedTitle")}>
          {PLAYBACK_RATES.map((rate) => (
            <button key={rate} type="button" role="radio" aria-checked={player.rate === rate} aria-label={t("speedAria", { rate: format.number(rate) })} onClick={() => player.setRate(rate)}>
              {format.number(rate)}×
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex items-center gap-2 px-1">
          <button type="button" className={`${transportButton} h-7 w-7 shrink-0`} aria-label={player.muted ? t("unmute") : t("mute")} title={t("muteTitle")} onClick={player.toggleMute}>
            <VolumeIcon aria-hidden className="h-4 w-4" />
          </button>
          <input
            type="range"
            aria-label={t("volume")}
            min={0}
            max={1}
            step={0.05}
            value={player.muted ? 0 : player.volume}
            className={railStyles.slider}
            onChange={(event) => player.setVolume(Number(event.target.value))}
          />
          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{format.number(Math.round((player.muted ? 0 : player.volume) * 100) / 100, { style: "percent" })}</span>
        </div>
        <div className="mt-1.5">
          <RailSwitch checked={player.boost > 1} label={t("audioBoost")} hint={t("audioBoostHint")} onChange={(on) => player.setBoost(on ? BOOST_DEFAULT : 1)} />
          {player.boost > 1 ? (
            <div className="flex items-center gap-2 px-2.5 pb-1">
              <input
                type="range"
                aria-label={t("audioBoost")}
                min={1.25}
                max={BOOST_MAX}
                step={0.25}
                value={player.boost}
                className={railStyles.slider}
                onChange={(event) => player.setBoost(Number(event.target.value))}
              />
              <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{format.number(Math.round(player.boost * 100) / 100, { style: "percent" })}</span>
            </div>
          ) : null}
        </div>
      </RailSection>

      {transcript}

      <p className={railStyles.note}>{t("shortcutsNote")}</p>
    </RailPanel>
  );
}
