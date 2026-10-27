"use client";

import type { InkSample } from "@/lib/ink/types";

/*
 * Pointer routing for an ink surface (docs/ink-plan.md, "Input"):
 *
 * - a pen draws with the current tool; its eraser end or barrel button
 *   (`buttons & 32`) erases while held;
 * - a finger scrolls the page, unless "Draw with finger" is on. The surface
 *   has `touch-action: none` (a pen on a pannable element scrolls instead of
 *   drawing), so this controller scrolls the nearest scroller itself, with
 *   inertia;
 * - a touch while a pen is near (in range or within PEN_GRACE_MS) is a palm
 *   and is ignored, and a pen landing cancels a stroke a finger started;
 * - a mouse draws only while the host says so (`mouseDraws`).
 *
 * Samples are reported in CSS px relative to the surface, with coalesced
 * events for fast strokes and predicted events for a provisional tail.
 * Nothing runs between strokes except the brief inertia after a finger flick.
 * The lowest-latency mode (opt-in) listens to `pointerrawupdate`, during a
 * stroke only.
 *
 * Tuning values are provisional until stylus hardware is tried.
 */

export type InkGestureKind = "draw" | "erase" | "select";

export type InkInputHandlers = {
  /** False while the surface takes no input at all. */
  enabled: () => boolean;
  /** Whether a pointer of this type may start a stroke now. */
  mouseDraws: () => boolean;
  fingerDraws: () => boolean;
  /** The current tool: drawing, erasing or selecting. A pen's eraser end erases whatever it is. */
  tool: () => InkGestureKind;
  /** Samples from `pointerrawupdate` as they arrive, instead of once a frame. */
  lowLatency?: () => boolean;
  /**
   * Moves the content under a finger by (dx, dy) CSS px, for hosts that pan by
   * transform (photos); returns false to have the nearest scroller scroll instead.
   */
  onPan?: (dx: number, dy: number) => boolean;
  onStart: (kind: InkGestureKind, sample: InkSample, pointerType: string) => void;
  onMove: (samples: InkSample[], predicted: InkSample[]) => void;
  onEnd: (cancelled: boolean) => void;
  /** A hovering pen, or null when it leaves. */
  onHover?: (point: { x: number; y: number } | null) => void;
};

/** After a pen lifts or leaves range, touches are palms for this long. */
const PEN_GRACE_MS = 500;
/** Finger flicks slower than this (px/ms) stop at once. */
const INERTIA_MIN_VELOCITY = 0.05;
const INERTIA_FRICTION = 0.95;
const ERASER_BUTTONS = 32;

function scrollerOf(element: Element): Element | null {
  for (let current = element.parentElement; current; current = current.parentElement) {
    const { overflowY } = getComputedStyle(current);
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) return current;
  }
  return document.scrollingElement;
}

/** Pointer capture is best-effort: a pointer that lifted in the meantime cannot be captured. */
function capture(element: Element, pointerId: number) {
  try { element.setPointerCapture(pointerId); } catch { /* already gone */ }
}

export function attachInkInput(surface: HTMLElement, handlers: InkInputHandlers) {
  let active: { pointerId: number; pointerType: string; start: number } | null = null;
  let pan: { pointerId: number; lastY: number; lastX: number; lastTime: number; velocityX: number; velocityY: number; scroller: Element | null } | null = null;
  let raw = false;
  let penSeenAt = -Infinity;
  let penInRange = false;
  let inertia = 0;

  const toSample = (event: PointerEvent, start: number): InkSample => {
    const bounds = surface.getBoundingClientRect();
    // In the surface's own CSS px, even when an ancestor scales it (a zoomed photo).
    const zoomX = bounds.width ? surface.clientWidth / bounds.width : 1;
    const zoomY = bounds.height ? surface.clientHeight / bounds.height : 1;
    const sample: InkSample = {
      x: (event.clientX - bounds.left) * zoomX,
      y: (event.clientY - bounds.top) * zoomY,
      // A mouse reports 0.5 while pressed; geometry simulates pressure for it.
      pressure: event.pointerType === "mouse" ? 0.5 : event.pressure,
      t: Math.max(0, event.timeStamp - start),
    };
    if (event.pointerType === "pen") {
      sample.tiltX = event.tiltX;
      sample.tiltY = event.tiltY;
    }
    return sample;
  };

  const penNear = (now: number) => penInRange || now - penSeenAt < PEN_GRACE_MS;

  function stopInertia() {
    cancelAnimationFrame(inertia);
    inertia = 0;
  }

  function panBy(scroller: Element | null, dx: number, dy: number) {
    if (!handlers.onPan?.(dx, dy)) scroller?.scrollBy(-dx, -dy);
  }

  function coast(scroller: Element | null, velocityX: number, velocityY: number) {
    let last = performance.now();
    let vx = velocityX;
    let vy = velocityY;
    const step = (now: number) => {
      const elapsed = now - last;
      last = now;
      panBy(scroller, vx * elapsed, vy * elapsed);
      vx *= INERTIA_FRICTION ** (elapsed / 16);
      vy *= INERTIA_FRICTION ** (elapsed / 16);
      inertia = Math.hypot(vx, vy) > INERTIA_MIN_VELOCITY ? requestAnimationFrame(step) : 0;
    };
    inertia = requestAnimationFrame(step);
  }

  function finish(event: PointerEvent, cancelled: boolean) {
    if (active?.pointerId !== event.pointerId) return;
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    if (active.pointerType === "pen") penSeenAt = event.timeStamp;
    active = null;
    raw = false;
    surface.removeEventListener("pointerrawupdate", onRawUpdate);
    handlers.onEnd(cancelled);
  }

  function onPointerDown(event: PointerEvent) {
    const now = event.timeStamp;
    if (event.pointerType === "pen") {
      penSeenAt = now;
      // A pen landing wins over a finger stroke (a palm) already in progress.
      if (active && active.pointerType === "touch") {
        active = null;
        handlers.onEnd(true);
      }
    }
    if (active || (event.pointerType === "mouse" && event.button !== 0)) return;

    if (event.pointerType === "touch") {
      if (penNear(now)) return;
      // Fingers still scroll over a read-only surface.
      if (!handlers.enabled() || !handlers.fingerDraws()) {
        if (pan) return;
        stopInertia();
        pan = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, lastTime: now, velocityX: 0, velocityY: 0, scroller: scrollerOf(surface) };
        capture(surface, event.pointerId);
        return;
      }
    } else if (!handlers.enabled() || (event.pointerType === "mouse" && !handlers.mouseDraws())) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    stopInertia();
    capture(surface, event.pointerId);
    active = { pointerId: event.pointerId, pointerType: event.pointerType, start: now };
    raw = Boolean(handlers.lowLatency?.()) && "onpointerrawupdate" in window;
    // Only while a stroke is down: a pointerrawupdate listener makes the browser send them all the time.
    if (raw) surface.addEventListener("pointerrawupdate", onRawUpdate);
    const kind: InkGestureKind = event.pointerType === "pen" && (event.buttons & ERASER_BUTTONS) ? "erase" : handlers.tool();
    handlers.onStart(kind, toSample(event, now), event.pointerType);
  }

  function onPointerMove(event: PointerEvent) {
    if (event.pointerType === "pen") {
      penSeenAt = event.timeStamp;
      if (!event.buttons) {
        penInRange = true;
        handlers.onHover?.({ x: event.clientX - surface.getBoundingClientRect().left, y: event.clientY - surface.getBoundingClientRect().top });
      }
    }

    if (pan && pan.pointerId === event.pointerId) {
      const elapsed = Math.max(1, event.timeStamp - pan.lastTime);
      const dx = event.clientX - pan.lastX;
      const dy = event.clientY - pan.lastY;
      panBy(pan.scroller, dx, dy);
      pan.velocityX = dx / elapsed;
      pan.velocityY = dy / elapsed;
      pan.lastX = event.clientX;
      pan.lastY = event.clientY;
      pan.lastTime = event.timeStamp;
      return;
    }

    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const predicted = typeof event.getPredictedEvents === "function" ? event.getPredictedEvents() : [];
    // In the lowest-latency mode the samples came from pointerrawupdate; only the prediction is new.
    const coalesced = raw ? [] : typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    handlers.onMove(
      raw ? [] : (coalesced.length ? coalesced : [event]).map((item) => toSample(item, active!.start)),
      predicted.map((item) => toSample(item, active!.start)),
    );
  }

  function onRawUpdate(event: Event) {
    const pointer = event as PointerEvent;
    if (!raw || !active || active.pointerId !== pointer.pointerId) return;
    const coalesced = typeof pointer.getCoalescedEvents === "function" ? pointer.getCoalescedEvents() : [];
    handlers.onMove((coalesced.length ? coalesced : [pointer]).map((item) => toSample(item, active!.start)), []);
  }

  function onPointerUp(event: PointerEvent) {
    if (pan && pan.pointerId === event.pointerId) {
      const { scroller, velocityX, velocityY, lastTime } = pan;
      pan = null;
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      // A finger that stopped before lifting does not coast.
      if (event.timeStamp - lastTime < 80 && Math.hypot(velocityX, velocityY) > INERTIA_MIN_VELOCITY) coast(scroller, velocityX, velocityY);
      return;
    }
    finish(event, false);
  }

  function onPointerCancel(event: PointerEvent) {
    if (pan && pan.pointerId === event.pointerId) {
      pan = null;
      return;
    }
    finish(event, true);
  }

  function onPointerLeave(event: PointerEvent) {
    if (event.pointerType !== "pen") return;
    penInRange = false;
    penSeenAt = event.timeStamp;
    handlers.onHover?.(null);
  }

  const options = { passive: false } as const;
  surface.addEventListener("pointerdown", onPointerDown, options);
  surface.addEventListener("pointermove", onPointerMove, options);
  surface.addEventListener("pointerup", onPointerUp);
  surface.addEventListener("pointercancel", onPointerCancel);
  surface.addEventListener("pointerleave", onPointerLeave);

  return () => {
    stopInertia();
    surface.removeEventListener("pointerdown", onPointerDown);
    surface.removeEventListener("pointermove", onPointerMove);
    surface.removeEventListener("pointerup", onPointerUp);
    surface.removeEventListener("pointercancel", onPointerCancel);
    surface.removeEventListener("pointerleave", onPointerLeave);
    surface.removeEventListener("pointerrawupdate", onRawUpdate);
  };
}
