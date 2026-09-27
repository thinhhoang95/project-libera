import { generateHTML, type AnyExtension } from "@tiptap/core";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { Marked, type marked } from "marked";
import { createMarkdownExtensions } from "@/lib/tiptap-markdown";

// Notes behave like a notepad: a single newline is a line break. Each consumer
// gets its own Marked instance because TipTap registers tokenizers on (and
// applies options to) whichever instance it is given, and the global one is
// shared with the main Markdown editor.
function createNoteMarked() {
  // TipTap types this as the global `marked` function but only uses what a
  // Marked instance also has (lexer, Lexer, defaults, use, setOptions).
  return new Marked({ gfm: true, breaks: true }) as unknown as typeof marked;
}

export function createAnnotationMarkdownExtensions(documentPath: string): AnyExtension[] {
  return [
    ...createMarkdownExtensions(documentPath).filter((extension) => extension.name !== Markdown.name),
    Markdown.configure({ marked: createNoteMarked() }),
  ];
}

let renderer: { extensions: AnyExtension[]; manager: MarkdownManager } | null = null;
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

/**
 * Markdown → HTML for resting (not edited) notes, through the same TipTap
 * schema the editor uses, so only schema-known markup can come out. Results
 * are memoized by source: pages mount and unmount constantly while scrolling
 * and must not re-parse unchanged notes.
 */
export function renderAnnotationMarkdown(markdown: string): string {
  const cached = htmlCache.get(markdown);

  if (cached !== undefined) {
    // Refresh recency for the LRU.
    htmlCache.delete(markdown);
    htmlCache.set(markdown, cached);
    return cached;
  }

  let html: string;

  try {
    if (!renderer) {
      const extensions = createAnnotationMarkdownExtensions("");
      renderer = {
        extensions,
        manager: new MarkdownManager({ marked: createNoteMarked(), extensions }),
      };
    }

    html = generateHTML(renderer.manager.parse(markdown), renderer.extensions);
  } catch {
    html = plainTextHtml(markdown);
  }

  htmlCache.set(markdown, html);

  if (htmlCache.size > HTML_CACHE_LIMIT) {
    htmlCache.delete(htmlCache.keys().next().value as string);
  }

  return html;
}
