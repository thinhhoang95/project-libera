import { unified } from "unified";
import remarkParse from "remark-parse";

export type MarkdownLinkOccurrence = {
  href: string;
  /** 1-based source line of the link. */
  line: number;
  /** Plain text of the surrounding paragraph, clipped around the link text. */
  excerpt: { before: string; text: string; after: string };
};

type MdNode = {
  type: string;
  url?: string;
  identifier?: string;
  value?: string;
  alt?: string;
  position?: { start: { line: number } };
  children?: MdNode[];
};

const parser = unified().use(remarkParse);
const EXCERPT_CONTEXT = 90;
// Block nodes whose children are inline text; links only appear inside these.
const PHRASING_BLOCKS = new Set(["paragraph", "heading", "tableCell"]);

function clipBefore(text: string) {
  if (text.length <= EXCERPT_CONTEXT) return text.trimStart();
  const clipped = text.slice(-EXCERPT_CONTEXT);
  const wordStart = clipped.indexOf(" ");
  return `…${wordStart >= 0 ? clipped.slice(wordStart + 1) : clipped}`;
}

function clipAfter(text: string) {
  if (text.length <= EXCERPT_CONTEXT) return text.trimEnd();
  const clipped = text.slice(0, EXCERPT_CONTEXT);
  const wordEnd = clipped.lastIndexOf(" ");
  return `${wordEnd > 0 ? clipped.slice(0, wordEnd) : clipped}…`;
}

/**
 * Every link in Markdown source, in document order, with an excerpt around it.
 * Uses the Markdown AST, so code examples and images are not links, and
 * reference-style links resolve through their definitions.
 */
export function extractMarkdownLinkOccurrences(content: string): MarkdownLinkOccurrence[] {
  const root = parser.parse(content) as MdNode;
  const definitions = new Map<string, string>();
  (function collectDefinitions(node: MdNode) {
    if (node.type === "definition" && node.identifier && node.url) {
      definitions.set(node.identifier.toUpperCase(), node.url);
    }
    node.children?.forEach(collectDefinitions);
  })(root);

  const occurrences: MarkdownLinkOccurrence[] = [];
  function visitBlock(block: MdNode) {
    let text = "";
    const spans: Array<{ href: string; line: number; start: number; end: number }> = [];
    (function flatten(node: MdNode) {
      const href = node.type === "link" ? node.url
        : node.type === "linkReference" && node.identifier ? definitions.get(node.identifier.toUpperCase())
        : undefined;
      const start = text.length;
      if (node.type === "text" || node.type === "inlineCode") text += node.value ?? "";
      else if (node.type === "image") text += node.alt ?? "";
      else if (node.type === "break") text += " ";
      node.children?.forEach(flatten);
      if (href) spans.push({ href, line: node.position?.start.line ?? 1, start, end: text.length });
    })(block);
    const normalized = text.replace(/\s/g, " ");
    for (const span of spans.sort((left, right) => left.start - right.start)) {
      occurrences.push({
        href: span.href,
        line: span.line,
        excerpt: {
          before: clipBefore(normalized.slice(0, span.start)),
          text: normalized.slice(span.start, span.end) || span.href,
          after: clipAfter(normalized.slice(span.end)),
        },
      });
    }
  }
  (function visit(node: MdNode) {
    if (PHRASING_BLOCKS.has(node.type)) visitBlock(node);
    else node.children?.forEach(visit);
  })(root);
  return occurrences;
}
