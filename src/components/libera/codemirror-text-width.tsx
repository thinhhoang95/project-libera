"use client";

import { useEffect, type RefObject } from "react";
import { MarkdownTextWidth } from "./markdown-text-width";
import type { TextWidthKind } from "@/lib/markdown-display-preferences";

/** The class a CodeMirror editor's wrapper takes while its text column follows the width ruler. */
export const CODEMIRROR_TEXT_WIDTH_CLASS = "libera-cm-text-width";

/**
 * The page-width triangle of the Markdown editors, for a CodeMirror editor
 * whose lines wrap. Each editor family (`kind`) keeps its own saved width. The wrapper must carry
 * `CODEMIRROR_TEXT_WIDTH_CLASS` while `enabled`, so the column is measured the
 * same way as the ruler.
 */
export function CodeMirrorTextWidth({ wrapperRef, enabled, kind }: {
  wrapperRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  kind: TextWidthKind;
}) {
  useEffect(() => {
    // The column centres beside the gutters (line numbers, folds, lint), so the
    // ruler needs their width to line up with the text's right edge. The editor's view is
    // created in its layout effect, so its DOM is in the wrapper by now. (No `view` prop:
    // React's development build walks changed props, and a view leads it to `window`.)
    const wrapper = wrapperRef.current;
    if (!enabled || !wrapper) return;
    const gutters = wrapper.querySelector<HTMLElement>(".cm-editor .cm-gutters");
    const apply = () => wrapper.style.setProperty("--cm-text-width-gutter", `${gutters?.offsetWidth ?? 0}px`);
    apply();
    if (!gutters || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    // The border box: Visual mode drops the gutters' border without changing their content.
    observer.observe(gutters, { box: "border-box" });
    return () => observer.disconnect();
  }, [enabled, wrapperRef]);

  return enabled ? <MarkdownTextWidth canvasRef={wrapperRef} kind={kind} /> : null;
}
