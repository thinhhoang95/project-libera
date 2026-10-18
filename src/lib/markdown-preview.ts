import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { cachedPreviewMath } from "./markdown-preview-math";
import type { Root } from "hast";
import type { PreviewCitation, PreviewSourcePosition } from "./markdown-preview-patch";
import type { MathMarkerSettings } from "./math-markers";
import { markdownRehypeOptions, markdownRemarkPlugins } from "./markdown-rendering";
import { normalizeMarkdownHighlightDelimiters } from "./markdown-highlights";
import { rehypeLiberaSanitize } from "./markdown-sanitize";

export type MarkdownPreviewRequest = { id: number; markdown: string; mathMarkers?: MathMarkerSettings };
export type MarkdownPreviewResponse = { id: number; children: Array<Root["children"][number] | number>; sources?: PreviewSourcePosition[]; citations?: PreviewCitation[]; error?: never } | { id: number; error: string; children?: never; sources?: never; citations?: never };

// Compare on the worker, including source positions and resolved references.
// Unchanged blocks cross the thread boundary as indexes, preserving React props.
export function createMarkdownPreviewPatch(tree: Root, previous: string[]) {
  const signatures = tree.children.map((node) => JSON.stringify(node));
  const children = tree.children.map((node, index) => signatures[index] === previous[index] ? index : node);
  return { children, signatures };
}

function previewProcessor(mathMarkers?: MathMarkerSettings) {
  return unified().use(remarkParse).use(markdownRemarkPlugins(mathMarkers))
    .use(remarkRehype, markdownRehypeOptions).use(cachedPreviewMath)
    // Collaborator content is untrusted: the worker's tree is allowlisted
    // before it reaches the page (the renderer adds the shared image policy).
    .use(rehypeLiberaSanitize);
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
