"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { speakerColor } from "@/components/libera/audio/speaker-colors";
import { formatClock } from "@/lib/transcription/format";
import type { TranscriptSegment } from "@/lib/transcription/types";

const BAR_WIDTH = 2;
const BAR_GAP = 1.5;
const LANE_HEIGHT = 5;
const LANE_GAP = 8;

function cssColor(element: Element, name: string, fallback: string) {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

/**
 * The recording at a glance: loudness bars, played in the accent color, with
 * who speaks when as a colored lane beneath and search matches as ticks.
 * Click or drag to seek; arrow keys step five seconds.
 */
export function Waveform({
  peaks,
  duration,
  currentTime,
  segments,
  markers,
  onSeek,
  loading,
}: {
  peaks: number[] | null;
  duration: number;
  currentTime: number;
  segments?: TranscriptSegment[];
  /** Times (seconds) to mark, such as transcript search matches. */
  markers?: number[];
  onSeek: (time: number) => void;
  loading?: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [theme, setTheme] = useState(0);
  const height = 96;
  const lane = segments?.some((segment) => segment.speaker !== null) ?? false;
  const waveHeight = lane ? height - LANE_HEIGHT - LANE_GAP : height;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Colors come from the theme's variables; redraw when it switches.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme((value) => value + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const played = cssColor(canvas, "--accent", "#0d9488");
    const rest = cssColor(canvas, "--muted-foreground", "#71717a");
    const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
    const hoverFraction = hover !== null && duration > 0 ? hover / duration : null;
    const middle = waveHeight / 2;

    if (peaks?.length) {
      const bars = Math.max(1, Math.floor(width / (BAR_WIDTH + BAR_GAP)));
      const loudest = Math.max(0.05, ...peaks);
      for (let bar = 0; bar < bars; bar += 1) {
        const from = Math.floor((bar / bars) * peaks.length);
        const to = Math.max(from + 1, Math.floor(((bar + 1) / bars) * peaks.length));
        let peak = 0;
        for (let index = from; index < to; index += 1) peak = Math.max(peak, peaks[index] ?? 0);
        // A gentle curve, so quiet speech still shows next to loud passages.
        const level = Math.sqrt(peak / loudest);
        const barHeight = Math.max(2, level * (waveHeight - 4));
        const x = bar * (BAR_WIDTH + BAR_GAP);
        const fraction = (bar + 0.5) / bars;
        const isPlayed = fraction <= progress;
        const isHovered = hoverFraction !== null && fraction <= hoverFraction && !isPlayed;
        context.globalAlpha = isPlayed ? 1 : isHovered ? 0.6 : 0.3;
        context.fillStyle = isPlayed ? played : rest;
        context.beginPath();
        context.roundRect(x, middle - barHeight / 2, BAR_WIDTH, barHeight, 1);
        context.fill();
      }
    } else {
      // No overview (yet): a simple track that still seeks.
      context.globalAlpha = 0.25;
      context.fillStyle = rest;
      context.beginPath();
      context.roundRect(0, middle - 2, width, 4, 2);
      context.fill();
      context.globalAlpha = 1;
      context.fillStyle = played;
      context.beginPath();
      context.roundRect(0, middle - 2, width * progress, 4, 2);
      context.fill();
    }

    if (lane && segments && duration > 0) {
      const top = waveHeight + LANE_GAP;
      for (const segment of segments) {
        if (segment.speaker === null) continue;
        const x = (segment.start / duration) * width;
        const w = Math.max(1.5, ((segment.end - segment.start) / duration) * width - 1);
        const color = speakerColor(segment.speaker);
        context.globalAlpha = segment.start <= currentTime ? 0.95 : 0.5;
        context.fillStyle = color.startsWith("var(") ? rest : color;
        context.beginPath();
        context.roundRect(x, top, w, LANE_HEIGHT, 2);
        context.fill();
      }
    }

    if (markers?.length && duration > 0) {
      context.globalAlpha = 0.9;
      context.fillStyle = cssColor(canvas, "--markdown-editor-find-match-active", "#f97316");
      for (const time of markers) {
        const x = (time / duration) * width;
        context.fillRect(Math.round(x) - 1, 0, 2, 6);
      }
    }

    // The playhead.
    context.globalAlpha = 1;
    context.fillStyle = played;
    context.fillRect(Math.round(progress * width) - 1, 0, 2, waveHeight);
  }, [currentTime, duration, height, hover, lane, markers, peaks, segments, theme, waveHeight, width]);

  const timeAt = useCallback((clientX: number) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect || !duration) return 0;
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
  }, [duration]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setHover(timeAt(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => setHover(timeAt(event.clientX));
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    onSeek(timeAt(event.clientX));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      onSeek(Math.max(0, Math.min(duration, currentTime + (event.key === "ArrowLeft" ? -5 : 5))));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onSeek(event.key === "Home" ? 0 : duration);
    }
  };

  const hoverLeft = hover !== null && duration ? `${(hover / duration) * 100}%` : null;

  return (
    <div
      ref={wrapperRef}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(currentTime)}
      aria-valuetext={`${formatClock(currentTime)} of ${formatClock(duration)}`}
      className={`relative w-full cursor-pointer touch-none select-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring ${loading ? "animate-pulse" : ""}`}
      style={{ height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { if (!dragging) setHover(null); }}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvasRef} className="block h-full w-full" style={{ height }} />
      {hoverLeft ? (
        <span
          className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded-md bg-foreground px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-background shadow"
          style={{ left: hoverLeft }}
        >
          {formatClock(hover!)}
        </span>
      ) : null}
    </div>
  );
}
