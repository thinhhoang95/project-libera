import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root } from "mdast";
import { markdownRemarkPlugins } from "@/lib/markdown-rendering";
import { normalizeMarkdownHighlightDelimiters } from "@/lib/markdown-highlights";
import type { MathMarkerSettings } from "@/lib/math-markers";
import { pasteMathMarkers } from "./markers";

/* The pasted Markdown is read with the preview's own grammar
 * (markdownRemarkPlugins), so Libera's syntax (math markers, citations,
 * highlights, colors, boxes, macros) means the same here as in a note. Math
 * markers are the user's own plus the common conventions (markers.ts). */

export { pasteMathMarkers };

function processorFor(mathMarkers?: MathMarkerSettings) {
  return unified().use(remarkParse).use(markdownRemarkPlugins(pasteMathMarkers(mathMarkers)));
}

const processors = new Map<string, ReturnType<typeof processorFor>>();

export type ParsedMarkdown = {
  tree: Root;
  /** The text the tree's positions refer to (line endings normalised). */
  source: string;
  /** The user's math markers it was read with (captions typed in the dialog are read with them too). */
  mathMarkers?: MathMarkerSettings;
};

export function normalizePastedMarkdown(markdown: string) {
  return markdown.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
}

export function parseMarkdown(markdown: string, mathMarkers?: MathMarkerSettings): ParsedMarkdown {
  const key = JSON.stringify(mathMarkers ? [mathMarkers.inlineMathMarkers, mathMarkers.blockMathMarkers] : null);
  let processor = processors.get(key);
  if (!processor) {
    processor = processorFor(mathMarkers);
    processors.set(key, processor);
    if (processors.size > 4) processors.delete(processors.keys().next().value!);
  }
  const source = normalizeMarkdownHighlightDelimiters(normalizePastedMarkdown(markdown));
  return { tree: processor.runSync(processor.parse(source)) as Root, source, mathMarkers };
}
