import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkMathMarkers } from "./remark-math-markers";
import type { MathMarkerSettings } from "./math-markers";
import { remarkMarkdownHighlights } from "./markdown-highlights";
import { remarkMarkdownTextColors } from "./markdown-colors";
import { remarkMarkdownSourceMap } from "./markdown-source-map";
import { remarkMarkdownUnderlines } from "./markdown-underlines";
import { remarkMarkdownTextStyles } from "./markdown-text-styles";
import { remarkMarkdownBoxes } from "./remark-markdown-boxes";

// Share the exact grammar between the synchronous renderer and preview worker.
export function markdownRemarkPlugins(mathMarkers?: MathMarkerSettings): PluggableList {
  return [remarkGfm, remarkMarkdownBoxes, remarkMarkdownHighlights, remarkMarkdownTextColors,
    remarkMarkdownUnderlines, remarkMarkdownTextStyles, remarkMarkdownSourceMap,
    ...(mathMarkers ? [[remarkMathMarkers, mathMarkers] as [typeof remarkMathMarkers, MathMarkerSettings]] : [remarkMath])];
}
