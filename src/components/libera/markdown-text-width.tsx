"use client";

import { memo, useEffect, useRef, type RefObject } from "react";
import { useMarkdownDisplayPreferences } from "./markdown-display-preferences";
import { TEXT_WIDTH_PREFERENCE_KEY, type TextWidthKind } from "@/lib/markdown-display-preferences";

/** Native dragging/keyboard input updates only CSS, never document React state. */
export const MarkdownTextWidth = memo(function MarkdownTextWidth({
  canvasRef,
  kind = "markdown",
}: {
  canvasRef: RefObject<HTMLElement | null>;
  /** The editor family whose own saved width this triangle shows and sets. */
  kind?: TextWidthKind;
}) {
  const { preferences, updatePreferences, flushPreferences } = useMarkdownDisplayPreferences();
  const preferenceKey = TEXT_WIDTH_PREFERENCE_KEY[kind];
  const textWidth = preferences[preferenceKey];
  const inputRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef(textWidth);

  function applyWidth() {
    frameRef.current = null;
    const width = pendingRef.current;
    canvasRef.current?.style.setProperty("--markdown-text-width", String(width / 100));
    inputRef.current?.setAttribute("aria-valuetext", width === 100 ? "Full width" : `${width}% of adjustable width`);
  }

  function commitWidth() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    applyWidth();
    updatePreferences({ [preferenceKey]: pendingRef.current });
    flushPreferences();
  }

  // The canvas is a later sibling: wait until all sibling refs are attached.
  useEffect(() => {
    pendingRef.current = textWidth;
    if (inputRef.current) inputRef.current.value = String(textWidth);
    canvasRef.current?.style.setProperty("--markdown-text-width", String(textWidth / 100));
    inputRef.current?.setAttribute("aria-valuetext", textWidth === 100 ? "Full width" : `${textWidth}% of adjustable width`);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [canvasRef, textWidth]);

  return (
    <div className="libera-text-width-ruler">
      <div className="libera-text-width-track">
        <input
          ref={inputRef}
          className="libera-text-width-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          defaultValue={textWidth}
          aria-label="Page text width"
          title="Drag to adjust page margins. Move all the way right for full width. Arrow keys adjust; Home/End select minimum/full width."
          onInput={(event) => {
            pendingRef.current = event.currentTarget.valueAsNumber;
            if (frameRef.current === null) frameRef.current = requestAnimationFrame(applyWidth);
          }}
          onPointerUp={commitWidth}
          onPointerCancel={commitWidth}
          onKeyUp={commitWidth}
          onBlur={commitWidth}
        />
      </div>
    </div>
  );
});
