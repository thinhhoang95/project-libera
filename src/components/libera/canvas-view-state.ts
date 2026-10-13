"use client";

import { useLayoutEffect, useRef } from "react";

const readers = new Set<() => void>();

/** Snapshot mounted canvases before a layout change moves them to new parents. */
export function captureCanvasViewState() {
  for (const read of readers) read();
}

export function useCanvasViewStateCapture(read: () => void) {
  const latest = useRef(read);
  useLayoutEffect(() => { latest.current = read; });
  useLayoutEffect(() => {
    const capture = () => latest.current();
    readers.add(capture);
    return () => { readers.delete(capture); };
  }, []);
}
