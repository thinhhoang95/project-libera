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
import { remarkCitations } from "./remark-citations";
import { citationRehypeHandlers, remarkBibliography } from "./remark-bibliography";

// Share the exact grammar between the synchronous renderer and preview worker.
// Citations come after the math markers, as in the syntax lane's tests (math
// claims its text first either way: the constructs start on different
// characters), and must follow remark-parse, which every user of this list
// adds first. remarkBibliography runs after the source map, whose positions
// the citation and bibliography elements keep.
export function markdownRemarkPlugins(mathMarkers?: MathMarkerSettings): PluggableList {
  return [remarkGfm, remarkMarkdownBoxes, remarkMarkdownHighlights, remarkMarkdownTextColors,
    remarkMarkdownUnderlines, remarkMarkdownTextStyles, remarkMarkdownSourceMap,
    ...(mathMarkers ? [[remarkMathMarkers, mathMarkers] as [typeof remarkMathMarkers, MathMarkerSettings]] : [remarkMath]),
    remarkCitations, remarkBibliography];
}

/** remark-rehype options for markdownRemarkPlugins: raw HTML kept for the sanitizer, citation and bibliography elements. */
export const markdownRehypeOptions = { allowDangerousHtml: true, handlers: citationRehypeHandlers };
