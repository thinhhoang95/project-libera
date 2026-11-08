import type { MathMarkerSettings } from "@/lib/math-markers";
import { DEFAULT_BLOCK_MATH_MARKERS, DEFAULT_INLINE_MATH_MARKERS } from "../../../../electron/math-markers.cjs";

/* The math markers pasted Markdown is read with (small, so the paste
 * event's detection can use it without loading the Markdown parser). */

/** The conventions other sources write math with: `$…$`, `$$…$$`, `\(…\)` inline; `\[…\]` and `$$` on lines of their own displayed. */
const COMMON_INLINE = ["$ $", "$$ $$", "\\( \\)"];
const COMMON_BLOCK = ["\\[ \\]", "$$ $$"];

function markerLines(text: string) {
  return text.split("\n").map((line) => line.trim().split(/\s+/).join(" ")).filter((line) => /^\S+ \S+$/.test(line));
}

/**
 * The user's own markers (Preferences → Markdown), so Markdown copied from
 * their notes reads as it does there, and then the common conventions their
 * settings do not already claim, since a paste may come from ChatGPT, GitHub
 * or Obsidian. `$$` on lines of its own is a display block even where
 * Libera's defaults make `$$` an inline pair.
 */
export function pasteMathMarkers(settings: MathMarkerSettings = {}): MathMarkerSettings {
  const inline = markerLines(settings.inlineMathMarkers ?? DEFAULT_INLINE_MATH_MARKERS);
  const block = markerLines(settings.blockMathMarkers ?? DEFAULT_BLOCK_MATH_MARKERS);
  const opener = (line: string) => line.split(" ")[0];
  const add = (lines: string[], common: string[]) => {
    for (const pair of common) if (!lines.some((line) => opener(line) === opener(pair))) lines.push(pair);
  };
  add(inline, COMMON_INLINE);
  add(block, COMMON_BLOCK);
  return { inlineMathMarkers: inline.join("\n"), blockMathMarkers: block.join("\n") };
}

/** Every opening and closing marker a paste is read with, longest openers first. */
export function pasteMathPairs(settings: MathMarkerSettings = {}): Array<{ open: string; close: string }> {
  const markers = pasteMathMarkers(settings);
  const pairs = [...markerLines(markers.inlineMathMarkers ?? ""), ...markerLines(markers.blockMathMarkers ?? "")]
    .map((line) => { const [open, close] = line.split(" "); return { open, close }; });
  const unique = new Map(pairs.map((pair) => [`${pair.open} ${pair.close}`, pair]));
  return [...unique.values()].sort((a, b) => b.open.length - a.open.length);
}
