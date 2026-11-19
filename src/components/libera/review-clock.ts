"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

// One timer for every relative time on screen ("5 min ago" on each comment
// card): it runs only while something listens and the window is visible.
const MINUTE = 60_000;
const listeners = new Set<(now: number) => void>();
let timer: number | null = null;
let watching = false;
function tick() { const now = Date.now(); for (const listener of [...listeners]) listener(now); }
function visible() { return typeof document === "undefined" || document.visibilityState !== "hidden"; }
function startTimer() { if (timer === null && listeners.size && visible()) timer = window.setInterval(tick, MINUTE); }
function stopTimer() { if (timer !== null) { window.clearInterval(timer); timer = null; } }
function onVisibility() {
  if (!visible()) { stopTimer(); return; }
  if (listeners.size) { tick(); startTimer(); }
}
function subscribe(listener: (now: number) => void) {
  listeners.add(listener);
  if (!watching) { watching = true; document.addEventListener("visibilitychange", onVisibility); }
  startTimer();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    stopTimer();
    watching = false;
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** What a relative-time label says, as a number that changes when the label does. */
function label(time: number, now: number) {
  const diff = Math.max(0, now - time);
  if (diff < 3_600_000) return Math.floor(diff / MINUTE);
  if (diff < 86_400_000) return 1_000 + Math.floor(diff / 3_600_000);
  return 100_000 + Math.floor(diff / 86_400_000);
}

/**
 * The current time, refreshed by the shared minute clock. With `times`, the
 * component re-renders only when one of their relative labels changes.
 */
export function useClockNow(times?: readonly number[]) {
  const [now, setNow] = useState(() => Date.now());
  const watched = useRef(times);
  useLayoutEffect(() => { watched.current = times; });
  useEffect(() => subscribe((next) => setNow((previous) => {
    const list = watched.current;
    return list && list.every((time) => label(time, previous) === label(time, next)) ? previous : next;
  })), []);
  return now;
}
