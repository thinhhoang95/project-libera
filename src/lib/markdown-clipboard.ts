import { generateJSON } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import type { MathMarkerSettings } from "./math-markers";
import { createMathExtensions } from "./tiptap-math";
import { createMarkdownExtensions } from "./tiptap-markdown";

const serializers = new Map<string, MarkdownManager>();
const extensions = (mathMarkers: MathMarkerSettings = {}) => [
  ...createMarkdownExtensions(""),
  ...createMathExtensions(mathMarkers),
];

function serializerFor(mathMarkers: MathMarkerSettings) {
  const key = JSON.stringify([
    mathMarkers.inlineMathMarkers,
    mathMarkers.blockMathMarkers,
  ]);
  let serializer = serializers.get(key);
  if (!serializer) {
    serializer = new MarkdownManager({ extensions: extensions(mathMarkers) });
    serializers.set(key, serializer);
  }
  return serializer;
}

/** Convert rich clipboard HTML through the same schema used by the visual
 * editor, retaining supported structure and formatting while discarding DOM
 * that cannot be represented in a Markdown document. */
export function convertClipboardHtmlToMarkdown(
  html: string,
  mathMarkers: MathMarkerSettings = {},
): string {
  if (!html.trim()) return "";
  const configured = extensions(mathMarkers);
  return serializerFor(mathMarkers).serialize(generateJSON(html, configured));
}

/** Rendered citations, copied back as their source tokens. The Markdown
 * serializer would escape a token's brackets, so the clone carries a
 * placeholder of letters and digits that `restoreCitations` swaps back. */
type CitationTokens = { marker: string; raw: string[] };

function citationTokens(): CitationTokens {
  return { marker: `liberacite${Math.random().toString(36).slice(2, 10)}n`, raw: [] };
}

function restoreCitations(markdown: string, tokens: CitationTokens) {
  if (!tokens.raw.length) return markdown;
  return markdown.replace(new RegExp(`${tokens.marker}(\\d+)x`, "g"), (_, index: string) => tokens.raw[Number(index)] ?? "");
}

/** Clone only selected content, retaining its formatting ancestors. Math is an
 * atomic selection: copying any part copies the underlying LaTeX expression.
 * Citations are atomic too, and the generated bibliography is not source. */
function cloneSelected(node: Node, range: Range, citations: CitationTokens): Node | null {
  if (!range.intersectsNode(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const start = range.startContainer === node ? range.startOffset : 0;
    let end = range.endContainer === node ? range.endOffset : node.textContent!.length;
    // Markdown rendering adds a final newline inside <pre><code>; Tiptap's
    // serializer supplies that newline itself.
    if (node.parentElement?.matches("pre > code") && end === node.textContent!.length && node.textContent!.endsWith("\n")) end--;
    return end > start ? node.ownerDocument!.createTextNode(node.textContent!.slice(start, end)) : null;
  }
  if (!(node instanceof HTMLElement)) return null;
  if (node.matches("[data-libera-bibliography]")) return null;
  if (node.matches("[data-libera-citation]")) {
    // getAttribute returns the token with the attribute's HTML escaping undone.
    citations.raw.push(node.getAttribute("data-libera-citation") ?? "");
    return node.ownerDocument.createTextNode(`${citations.marker}${citations.raw.length - 1}x`);
  }
  if (node.matches(".katex-display, .katex")) {
    const latex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (latex == null) return null;
    const math = node.ownerDocument.createElement(node.matches(".katex-display") ? "div" : "span");
    math.setAttribute("data-type", node.matches(".katex-display") ? "block-math" : "inline-math");
    math.setAttribute("data-latex", latex);
    return math;
  }
  const clone = node.cloneNode(false) as HTMLElement;
  for (const child of node.childNodes) {
    const selected = cloneSelected(child, range, citations);
    if (selected) clone.append(selected);
  }
  if (!clone.hasChildNodes() && !node.matches("br, hr, img, input")) return null;
  // ReactMarkdown's task-list markup differs from Tiptap's HTML schema.
  if (node.matches("li.task-list-item")) {
    clone.dataset.type = "taskItem";
    clone.dataset.checked = String(node.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false);
    clone.querySelector('input[type="checkbox"]')?.remove();
  }
  if (node.matches("ul.contains-task-list")) clone.dataset.type = "taskList";
  // Preserve numbering when a selection starts midway through an ordered list.
  if (node.matches("ol")) {
    const first = Array.from(node.children).findIndex((child) => range.intersectsNode(child) && cloneSelected(child, range, citationTokens()));
    clone.setAttribute("start", String(Number(node.getAttribute("start") ?? 1) + Math.max(0, first)));
  }
  if (node.matches("mark[data-markdown-highlight-color]")) clone.dataset.color = node.getAttribute("data-markdown-highlight-color")!;
  return clone;
}

export function getRenderedSelectionMarkdown(
  container: HTMLElement,
  range: Range,
  mathMarkers: MathMarkerSettings = {},
): string {
  const citations = citationTokens();
  const clone = cloneSelected(container, range, citations) as HTMLElement | null;
  if (!clone) return "";
  return restoreCitations(convertClipboardHtmlToMarkdown(clone.innerHTML, mathMarkers), citations);
}

type CopyEvent = Pick<ClipboardEvent, "clipboardData" | "preventDefault">;

export function writeMarkdownClipboard(event: CopyEvent, markdown: string): boolean {
  if (!event.clipboardData || !markdown) return false;
  event.clipboardData.clearData();
  event.clipboardData.setData("text/plain", markdown);
  event.preventDefault();
  return true;
}

/** Called on the chat log so a selection can span multiple responses. */
export function copyRenderedMarkdownSelection(
  container: HTMLElement,
  event: CopyEvent,
  mathMarkers: MathMarkerSettings = {},
): boolean {
  const selection = container.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return false;
  const markdown = Array.from(container.querySelectorAll<HTMLElement>("[data-copy-markdown]"))
    .filter((message) => range.intersectsNode(message))
    .map((message) => getRenderedSelectionMarkdown(message, range, mathMarkers))
    .filter(Boolean)
    .join("\n\n");
  return writeMarkdownClipboard(event, markdown);
}
