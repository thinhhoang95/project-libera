"use client";

import { useTranslations } from "next-intl";
import { memo, useEffect, useRef, type RefObject } from "react";
import { useMarkdownDisplayPreference, useMarkdownDisplayPreferenceActions } from "./markdown-display-preferences";
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
  const t = useTranslations("markdownTextWidth");
  const { updatePreferences, flushPreferences } = useMarkdownDisplayPreferenceActions();
  const preferenceKey = TEXT_WIDTH_PREFERENCE_KEY[kind];
  const textWidth = useMarkdownDisplayPreference(preferenceKey);
  const inputRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef(textWidth);

  function applyWidth() {
    frameRef.current = null;
    const width = pendingRef.current;
    canvasRef.current?.style.setProperty("--markdown-text-width", String(width / 100));
    inputRef.current?.setAttribute("aria-valuetext", width === 100 ? t("fullWidth") : t("widthPercent", { width: width / 100 }));
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
    inputRef.current?.setAttribute("aria-valuetext", textWidth === 100 ? t("fullWidth") : t("widthPercent", { width: textWidth / 100 }));
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [canvasRef, t, textWidth]);

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
          aria-label={t("pageTextWidthLabel")}
          title={t("sliderTitle")}
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
