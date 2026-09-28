"use client";

import { useCallback } from "react";

export function attachHorizontalToolbarScroll(element: HTMLElement) {
  function onWheel(event: WheelEvent) {
    // Preserve browser zoom and native horizontal/diagonal trackpad gestures.
    if (event.defaultPrevented || event.ctrlKey || event.metaKey ||
        !event.deltaY || event.deltaX !== 0) return;
    const maximum = element.scrollWidth - element.clientWidth;
    if (maximum <= 0) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
    const next = Math.max(0, Math.min(maximum, element.scrollLeft + event.deltaY * unit));
    if (next === element.scrollLeft) return;
    event.preventDefault();
    element.scrollLeft = next;
  }

  // React's delegated wheel listener is passive. A local listener lets us stop
  // vertical page scrolling only when the toolbar actually consumes the wheel.
  element.addEventListener("wheel", onWheel, { passive: false });
  return () => element.removeEventListener("wheel", onWheel);
}

export function useHorizontalToolbarScroll() {
  // A callback ref also handles TipTap's deferred mount and React ref cleanup.
  return useCallback((element: HTMLDivElement | null) => {
    if (element) return attachHorizontalToolbarScroll(element);
  }, []);
}
