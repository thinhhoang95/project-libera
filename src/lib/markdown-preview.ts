import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import type { Root } from "hast";
import type { MathMarkerSettings } from "./math-markers";
import { markdownRemarkPlugins } from "./markdown-rendering";
import { normalizeMarkdownHighlightDelimiters } from "./markdown-highlights";

export type MarkdownPreviewRequest = { id: number; markdown: string; mathMarkers?: MathMarkerSettings };
export type MarkdownPreviewResponse = { id: number; children: Array<Root["children"][number] | number>; error?: never } | { id: number; error: string; children?: never };

// Compare on the worker, including source positions and resolved references.
// Unchanged blocks cross the thread boundary as indexes, preserving React props.
export function createMarkdownPreviewPatch(tree: Root, previous: string[]) {
  const signatures = tree.children.map((node) => JSON.stringify(node));
  const children = tree.children.map((node, index) => signatures[index] === previous[index] ? index : node);
  return { children, signatures };
}

export function prepareMarkdownPreview(markdown: string, mathMarkers?: MathMarkerSettings): Root {
  const processor = unified().use(remarkParse).use(markdownRemarkPlugins(mathMarkers))
    .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeKatex);
  const source = normalizeMarkdownHighlightDelimiters(markdown);
  return processor.runSync(processor.parse(source)) as Root;
}
