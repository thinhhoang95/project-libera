import { generateHTML, type AnyExtension, type JSONContent } from "@tiptap/core";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import katex, { type KatexOptions } from "katex";
import { Marked, type marked } from "marked";
import type { MathMarkerSettings } from "@/lib/math-markers";
import { createMathExtensions } from "@/lib/tiptap-math";
import { createMarkdownExtensions } from "@/lib/tiptap-markdown";

const INLINE_KATEX_OPTIONS: KatexOptions = { displayMode: false, throwOnError: false, trust: false };
// KaTeX requires display mode for equation tags.
const BLOCK_KATEX_OPTIONS: KatexOptions = { displayMode: true, throwOnError: false, trust: false };

// Notes behave like a notepad: a single newline is a line break. Each consumer
// gets its own Marked instance because TipTap registers tokenizers on (and
// applies options to) whichever instance it is given, and the global one is
// shared with the main Markdown editor.
function createNoteMarked() {
  // TipTap types this as the global `marked` function but only uses what a
  // Marked instance also has (lexer, Lexer, defaults, use, setOptions).
  return new Marked({ gfm: true, breaks: true }) as unknown as typeof marked;
}

export function createAnnotationMarkdownExtensions(
  documentPath: string,
  mathMarkers?: MathMarkerSettings,
): AnyExtension[] {
  const [InlineMath, BlockMath] = createMathExtensions(mathMarkers);

  return [
    ...createMarkdownExtensions(documentPath).filter((extension) => extension.name !== Markdown.name),
    InlineMath.configure({ katexOptions: INLINE_KATEX_OPTIONS }),
    BlockMath.configure({ katexOptions: BLOCK_KATEX_OPTIONS }),
    Markdown.configure({ marked: createNoteMarked() }),
  ];
}

// One parser per math-marker configuration (in practice there is only one).
const renderers = new Map<string, { extensions: AnyExtension[]; manager: MarkdownManager }>();
const HTML_CACHE_LIMIT = 500;
const htmlCache = new Map<string, string>();

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function plainTextHtml(markdown: string) {
  return markdown
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

type NoteMath = { display: boolean; latex: string };

// The schema only emits empty math placeholders (KaTeX runs in the editor's
// node views), so resting notes typeset them here, in document order.
const MATH_PLACEHOLDER = /<(span|div)\b[^>]*\bdata-type="(?:inline|block)-math"[^>]*><\/\1>/g;

function collectMath(node: JSONContent, found: NoteMath[]) {
  if (node.type === "inlineMath" || node.type === "blockMath") {
    found.push({ display: node.type === "blockMath", latex: String(node.attrs?.latex ?? "") });
  }

  node.content?.forEach((child) => collectMath(child, found));
}

function renderMath({ display, latex }: NoteMath) {
  let body: string;

  try {
    body = katex.renderToString(latex, display ? BLOCK_KATEX_OPTIONS : INLINE_KATEX_OPTIONS);
  } catch {
    body = escapeHtml(latex);
  }

  // Same markup as the editor's node views, so resting and editing notes
  // share layout (the editor maps the clicked point onto the same text).
  return display
    ? `<div class="tiptap-mathematics-render" data-type="block-math"><div class="block-math-inner">${body}</div></div>`
    : `<span class="tiptap-mathematics-render" data-type="inline-math">${body}</span>`;
}

function typesetMath(html: string, doc: JSONContent) {
  const math: NoteMath[] = [];
  collectMath(doc, math);

  if (!math.length) {
    return html;
  }

  let index = 0;

  return html.replace(MATH_PLACEHOLDER, (placeholder) => {
    const next = math[index++];
    return next ? renderMath(next) : placeholder;
  });
}

function mathMarkersKey(mathMarkers: MathMarkerSettings = {}) {
  return `${mathMarkers.inlineMathMarkers ?? ""}\u0000${mathMarkers.blockMathMarkers ?? ""}`;
}

/**
 * Markdown → HTML for resting (not edited) notes, through the same TipTap
 * schema the editor uses, so only schema-known markup can come out. Results
 * are memoized by source: pages mount and unmount constantly while scrolling
 * and must not re-parse unchanged notes.
 */
export function renderAnnotationMarkdown(markdown: string, mathMarkers?: MathMarkerSettings): string {
  const markersKey = mathMarkersKey(mathMarkers);
  const cacheKey = `${markersKey}\u0000${markdown}`;
  const cached = htmlCache.get(cacheKey);

  if (cached !== undefined) {
    // Refresh recency for the LRU.
    htmlCache.delete(cacheKey);
    htmlCache.set(cacheKey, cached);
    return cached;
  }

  let html: string;

  try {
    let renderer = renderers.get(markersKey);

    if (!renderer) {
      const extensions = createAnnotationMarkdownExtensions("", mathMarkers);
      renderer = {
        extensions,
        manager: new MarkdownManager({ marked: createNoteMarked(), extensions }),
      };
      renderers.set(markersKey, renderer);
    }

    const doc = renderer.manager.parse(markdown);
    html = typesetMath(generateHTML(doc, renderer.extensions), doc);
  } catch {
    html = plainTextHtml(markdown);
  }

  htmlCache.set(cacheKey, html);

  if (htmlCache.size > HTML_CACHE_LIMIT) {
    htmlCache.delete(htmlCache.keys().next().value as string);
  }

  return html;
}
