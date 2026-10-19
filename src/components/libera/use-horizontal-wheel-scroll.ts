"use client";

import { useEffect, type RefObject } from "react";

// A toolbar that overflows sideways has its scrollbar hidden
// (`libera-horizontal-toolbar`), so a plain mouse wheel must scroll it
// instead: vertical wheel movement becomes horizontal scrolling. Trackpads and
// Shift+wheel already scroll horizontally and are left alone.
//
// The listener is registered directly because React's wheel handlers are
// passive and cannot prevent the page from scrolling. It only prevents the
// default when the toolbar actually moved, so at either end the wheel still
// reaches whatever is behind the toolbar.

const LINE_HEIGHT_PX = 16;

export function horizontalWheelDelta(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey">, pageWidth: number): number {
  if (event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return 0;
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT_PX;
  if (event.deltaMode === 2) return event.deltaY * pageWidth;
  return event.deltaY;
}

export function useHorizontalWheelScroll(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth) return;
      const delta = horizontalWheelDelta(event, element.clientWidth);
      if (delta === 0) return;
      const before = element.scrollLeft;
      element.scrollLeft = before + delta;
      if (element.scrollLeft !== before) event.preventDefault();
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [ref]);
}
