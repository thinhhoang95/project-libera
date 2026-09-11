import { generateJSON } from "@tiptap/core";
import { Mathematics } from "@tiptap/extension-mathematics";
import { MarkdownManager } from "@tiptap/markdown";
import { createMarkdownExtensions } from "./tiptap-markdown";

let serializer: MarkdownManager | undefined;
const extensions = () => [...createMarkdownExtensions(""), Mathematics];

/** Clone only selected content, retaining its formatting ancestors. Math is an
 * atomic selection: copying any part copies the underlying LaTeX expression. */
function cloneSelected(node: Node, range: Range): Node | null {
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
    const selected = cloneSelected(child, range);
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
    const first = Array.from(node.children).findIndex((child) => range.intersectsNode(child) && cloneSelected(child, range));
    clone.setAttribute("start", String(Number(node.getAttribute("start") ?? 1) + Math.max(0, first)));
  }
  if (node.matches("mark[data-markdown-highlight-color]")) clone.dataset.color = node.getAttribute("data-markdown-highlight-color")!;
  return clone;
}

export function getRenderedSelectionMarkdown(container: HTMLElement, range: Range): string {
  const clone = cloneSelected(container, range) as HTMLElement | null;
  if (!clone) return "";
  const configured = extensions();
  serializer ??= new MarkdownManager({ extensions: configured });
  return serializer.serialize(generateJSON(clone.innerHTML, configured));
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
export function copyRenderedMarkdownSelection(container: HTMLElement, event: CopyEvent): boolean {
  const selection = container.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return false;
  const markdown = Array.from(container.querySelectorAll<HTMLElement>("[data-copy-markdown]"))
    .filter((message) => range.intersectsNode(message))
    .map((message) => getRenderedSelectionMarkdown(message, range))
    .filter(Boolean)
    .join("\n\n");
  return writeMarkdownClipboard(event, markdown);
}
