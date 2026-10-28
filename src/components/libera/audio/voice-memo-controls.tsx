"use client";

import { Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward, Square, Volume1, Volume2, VolumeX, type LucideIcon } from "lucide-react";
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
  const { playing, currentTime, duration, previous, next } = player;
  const VolumeIcon = player.muted || player.volume === 0 ? VolumeX : player.volume < 0.5 ? Volume1 : Volume2;

  return (
    <RailPanel title="Voice Memo" actions={menu}>
      <div className={railStyles.card}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold" title={player.title}>{player.title}</p>
            <p className="truncate text-[11px] text-muted-foreground">{player.details}</p>
          </div>
          <button type="button" className={`${transportButton} h-7 w-7 shrink-0`} aria-label="Stop" title="Stop: back to the start" disabled={!playing && currentTime === 0} onClick={player.stop}>
            <Square aria-hidden className="h-3 w-3" fill="currentColor" />
          </button>
        </div>
        <input
          type="range"
          aria-label="Position"
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
          <button type="button" className={`${transportButton} h-8 w-8`} aria-label="Previous recording" title={previous ? `Previous: ${previous.name} ([)` : "No previous recording"} disabled={!previous} onClick={() => previous && player.showSibling(previous)}>
            <SkipBack aria-hidden className="h-4 w-4" />
          </button>
          <button type="button" className={`${transportButton} h-9 w-9`} aria-label={`Back ${SKIP_SECONDS} seconds`} title={`Back ${SKIP_SECONDS} s`} onClick={() => player.seek(currentTime - SKIP_SECONDS)}>
            <SkipIcon icon={RotateCcw} />
          </button>
          <button
            type="button"
            className="mx-1 inline-flex h-12 w-12 items-center justify-center rounded-full bg-foreground text-background shadow-md transition hover:scale-[1.04] active:scale-95 disabled:opacity-40"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (Space)" : "Play (Space)"}
            disabled={!player.canPlay}
            onClick={player.togglePlay}
          >
            {playing ? <Pause aria-hidden className="h-5 w-5" fill="currentColor" /> : <Play aria-hidden className="ml-0.5 h-5 w-5" fill="currentColor" />}
          </button>
          <button type="button" className={`${transportButton} h-9 w-9`} aria-label={`Forward ${SKIP_SECONDS} seconds`} title={`Forward ${SKIP_SECONDS} s`} onClick={() => player.seek(currentTime + SKIP_SECONDS)}>
            <SkipIcon icon={RotateCw} />
          </button>
          <button type="button" className={`${transportButton} h-8 w-8`} aria-label="Next recording" title={next ? `Next: ${next.name} (])` : "No next recording"} disabled={!next} onClick={() => next && player.showSibling(next)}>
            <SkipForward aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>

      <RailSection title="Playback">
        <div className={railStyles.segmented} role="radiogroup" aria-label="Playback speed" title="Playback speed (< and >)">
          {PLAYBACK_RATES.map((rate) => (
            <button key={rate} type="button" role="radio" aria-checked={player.rate === rate} aria-label={`${rate}× speed`} onClick={() => player.setRate(rate)}>
              {rate}×
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex items-center gap-2 px-1">
          <button type="button" className={`${transportButton} h-7 w-7 shrink-0`} aria-label={player.muted ? "Unmute" : "Mute"} title="Mute (M)" onClick={player.toggleMute}>
            <VolumeIcon aria-hidden className="h-4 w-4" />
          </button>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={player.muted ? 0 : player.volume}
            className={railStyles.slider}
            onChange={(event) => player.setVolume(Number(event.target.value))}
          />
          <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{Math.round((player.muted ? 0 : player.volume) * 100)}%</span>
        </div>
        <div className="mt-1.5">
          <RailSwitch checked={player.boost > 1} label="Audio Boost" hint="Play louder than 100%, for quiet recordings" onChange={(on) => player.setBoost(on ? BOOST_DEFAULT : 1)} />
          {player.boost > 1 ? (
            <div className="flex items-center gap-2 px-2.5 pb-1">
              <input
                type="range"
                aria-label="Audio Boost"
                min={1.25}
                max={BOOST_MAX}
                step={0.25}
                value={player.boost}
                className={railStyles.slider}
                onChange={(event) => player.setBoost(Number(event.target.value))}
              />
              <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{Math.round(player.boost * 100)}%</span>
            </div>
          ) : null}
        </div>
      </RailSection>

      {transcript}

      <p className={railStyles.note}>Space play · ← → 5 s · Shift+← → passage · [ ] recording · &lt; &gt; speed · ⌘F find. Click any line of the transcript to correct it; Enter starts a new line.</p>
    </RailPanel>
  );
}
