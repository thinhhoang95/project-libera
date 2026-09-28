import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { cachedPreviewMath } from "./markdown-preview-math";
import type { Root } from "hast";
import type { PreviewSourcePosition } from "./markdown-preview-patch";
import type { MathMarkerSettings } from "./math-markers";
import { markdownRemarkPlugins } from "./markdown-rendering";
import { normalizeMarkdownHighlightDelimiters } from "./markdown-highlights";

export type MarkdownPreviewRequest = { id: number; markdown: string; mathMarkers?: MathMarkerSettings };
export type MarkdownPreviewResponse = { id: number; children: Array<Root["children"][number] | number>; sources?: PreviewSourcePosition[]; error?: never } | { id: number; error: string; children?: never; sources?: never };

// Compare on the worker, including source positions and resolved references.
// Unchanged blocks cross the thread boundary as indexes, preserving React props.
export function createMarkdownPreviewPatch(tree: Root, previous: string[]) {
  const signatures = tree.children.map((node) => JSON.stringify(node));
  const children = tree.children.map((node, index) => signatures[index] === previous[index] ? index : node);
  return { children, signatures };
}

function previewProcessor(mathMarkers?: MathMarkerSettings) {
  return unified().use(remarkParse).use(markdownRemarkPlugins(mathMarkers))
    .use(remarkRehype, { allowDangerousHtml: true }).use(cachedPreviewMath);
}
const processors = new Map<string, ReturnType<typeof previewProcessor>>();
export function prepareMarkdownPreview(markdown: string, mathMarkers?: MathMarkerSettings): Root {
  const key = JSON.stringify(mathMarkers === undefined ? null : [mathMarkers.inlineMathMarkers, mathMarkers.blockMathMarkers]);
  let processor = processors.get(key);
  if (!processor) {
    processor = previewProcessor(mathMarkers);
    processors.set(key, processor);
    if (processors.size > 4) processors.delete(processors.keys().next().value!);
  }
  const source = normalizeMarkdownHighlightDelimiters(markdown);
  return processor.runSync(processor.parse(source)) as Root;
}
