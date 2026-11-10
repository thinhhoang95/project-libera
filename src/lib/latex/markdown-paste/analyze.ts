import type { Citation } from "@/lib/references/types";
import type { ParsedMarkdown } from "./parse";

/* What a pasted Markdown tree holds, for the dialog (which groups to show,
 * which heading levels, how many tables) and for the converter (heading
 * ranks, caption paragraphs, footnotes, link definitions). */

/** An mdast node, including Libera's own types (liberaCitation, liberaHighlight…). */
export type MdNode = {
  type: string;
  children?: MdNode[];
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  spread?: boolean | null;
  align?: Array<"left" | "right" | "center" | null> | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
  lang?: string | null;
  meta?: string | null;
  identifier?: string;
  label?: string | null;
  referenceType?: string;
  citation?: Citation;
  data?: { hProperties?: Record<string, unknown> };
  position?: { start: { offset?: number }; end: { offset?: number } };
};

export function nodeChildren(node: MdNode): MdNode[] {
  return node.children ?? [];
}

/** The node's text as shown: values of text, code and math, citations as written. */
export function plainText(node: MdNode): string {
  if (node.type === "image") return node.alt ?? "";
  if (node.type === "break") return " ";
  if (typeof node.value === "string" && !node.children) return node.type === "html" ? "" : node.value;
  return nodeChildren(node).map(plainText).join("");
}

export function sourceOf(node: MdNode, source: string) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? plainText(node) : source.slice(start, end);
}

/** Heading numbers LaTeX writes itself: `1.`, `2)`, `1.2`, `1.2.`, and with every heading numbered, `A.` or `IV.`. */
const HEADING_NUMBER = /^(?:\d+(?:\.\d+)+\.?|\d+[.)]|[IVXLC]+[.)]|[A-Z][.)])\s+/;

/** "Table 2: …", "**Table:** …", "*Table 3. …*": a paragraph that captions the table next to it. */
const CAPTION_LEAD = /^Table\s*(?:\d+|[IVXLC]+)?\s*[:.–—-]\s*/i;

export type HeadingInfo = { node: MdNode; depth: number; nested: boolean; text: string };
export type TableInfo = {
  node: MdNode;
  columns: number;
  rows: number;
  header: string[];
  /** The caption paragraph's Markdown without its "Table 2:" lead, or "". */
  caption: string;
  captionNode: MdNode | null;
  /** Inside a footnote: written without a float, so without a caption. */
  inFootnote: boolean;
  /** The block quote it is in, if any (a callout written as a tcolorbox holds no float). */
  quote: MdNode | null;
};

export type MarkdownStructure = {
  headings: HeadingInfo[];
  /** Distinct depths of the headings that become sectioning commands, shallowest first. */
  depths: number[];
  /** Every sectioning heading starts with a number LaTeX would write itself. */
  numberedHeadings: boolean;
  tables: TableInfo[];
  definitions: Map<string, { url: string; title: string | null }>;
  footnotes: Map<string, MdNode>;
  footnoteReferences: Map<string, number>;
  internalLinks: boolean;
  images: number;
  citations: number;
  codeBlocks: number;
  math: number;
  /** Anything beyond paragraphs of plain text and math. */
  markdown: boolean;
};

const PLAIN_TYPES = new Set(["root", "paragraph", "text", "inlineMath", "math", "liberaBibliography"]);

/** A caption paragraph: its Markdown with the "Table 2:" lead (and the emphasis around it) removed, or null. */
export function captionFromParagraph(markdown: string) {
  let text = markdown.trim();
  const marker = /^(\*\*|__|\*|_)/.exec(text)?.[1] ?? "";
  if (marker) text = text.slice(marker.length);
  const lead = CAPTION_LEAD.exec(text);
  if (!lead) return null;
  text = text.slice(lead[0].length);
  if (marker) {
    // `**Table 1:** Text`: the bold closes right after the lead.
    if (text.startsWith(marker)) text = text.slice(marker.length).trimStart();
    // `*Table 1: Text*`: the emphasis wraps the whole caption.
    else if (text.endsWith(marker)) text = text.slice(0, -marker.length).trimEnd();
  }
  return text.replace(/\s+/g, " ").trim();
}

export function collectStructure({ tree, source }: ParsedMarkdown): MarkdownStructure {
  const structure: MarkdownStructure = {
    headings: [], depths: [], numberedHeadings: false, tables: [], definitions: new Map(), footnotes: new Map(),
    footnoteReferences: new Map(), internalLinks: false, images: 0, citations: 0, codeBlocks: 0, math: 0, markdown: false,
  };
  const captionNodes = new Set<MdNode>();
  const linkReferences: string[] = [];
  const visit = (node: MdNode, nested: boolean, inFootnote = false, quote: MdNode | null = null) => {
    if (!PLAIN_TYPES.has(node.type)) structure.markdown = true;
    switch (node.type) {
      case "heading": structure.headings.push({ node, depth: node.depth ?? 1, nested, text: plainText(node).trim() }); break;
      case "definition": if (node.identifier && node.url !== undefined) structure.definitions.set(node.identifier, { url: node.url, title: node.title ?? null }); break;
      case "footnoteDefinition": if (node.identifier) structure.footnotes.set(node.identifier, node); break;
      case "footnoteReference": if (node.identifier) structure.footnoteReferences.set(node.identifier, (structure.footnoteReferences.get(node.identifier) ?? 0) + 1); break;
      case "link": if (node.url?.startsWith("#")) structure.internalLinks = true; break;
      // `[text][ref]` with `[ref]: #anchor`: resolved once the definitions are all known.
      case "linkReference": if (node.identifier) linkReferences.push(node.identifier); break;
      case "image": case "imageReference": structure.images++; break;
      case "liberaCitation": structure.citations++; break;
      case "code": structure.codeBlocks++; break;
      case "math": case "inlineMath": structure.math++; break;
    }
    const children = nodeChildren(node);
    children.forEach((child, index) => {
      if (child.type === "table") {
        const rows = nodeChildren(child);
        const header = nodeChildren(rows[0] ?? { type: "tableRow" }).map((cell) => plainText(cell).trim());
        let caption = "";
        let captionNode: MdNode | null = null;
        for (const candidate of [children[index - 1], children[index + 1]]) {
          if (candidate?.type !== "paragraph" || captionNodes.has(candidate)) continue;
          const text = captionFromParagraph(sourceOf(candidate, source));
          if (text === null) continue;
          caption = text;
          captionNode = candidate;
          captionNodes.add(candidate);
          break;
        }
        structure.tables.push({ node: child, columns: Math.max(1, child.align?.length ?? header.length), rows: rows.length, header, caption, captionNode, inFootnote, quote });
      }
      visit(child, nested || node.type === "listItem" || node.type === "blockquote" || node.type === "footnoteDefinition" || node.type === "tableCell", inFootnote || node.type === "footnoteDefinition", node.type === "blockquote" ? node : quote);
    });
  };
  visit(tree as unknown as MdNode, false);
  if (linkReferences.some((id) => structure.definitions.get(id)?.url.startsWith("#"))) structure.internalLinks = true;
  const sectioning = structure.headings.filter((heading) => !heading.nested);
  structure.depths = [...new Set(sectioning.map((heading) => heading.depth))].sort((a, b) => a - b);
  structure.numberedHeadings = sectioning.length > 0 && sectioning.every((heading) => HEADING_NUMBER.test(heading.text))
    // Letters and Roman numerals count only alongside a digit, so "A. Smith" alone is a name.
    && sectioning.some((heading) => /^\d/.test(heading.text));
  return structure;
}

export function stripHeadingNumber(text: string) {
  return text.replace(HEADING_NUMBER, "");
}

/** What the dialog shows: the heading levels, the tables, and counts. */
export type MarkdownPasteAnalysis = {
  headingDepths: number[];
  /** The first heading's text at each depth, for the dialog's rows. */
  headingSamples: string[];
  numberedHeadings: boolean;
  internalLinks: boolean;
  tables: Array<{ columns: number; rows: number; header: string[]; caption: string }>;
  images: number;
  citations: number;
  footnotes: number;
  codeBlocks: number;
  math: number;
  /** Headings or tables: something the dialog asks about. */
  structural: boolean;
  /** Anything to convert at all (otherwise the text pastes as it is). */
  markdown: boolean;
};

export function summarizeStructure(structure: MarkdownStructure): MarkdownPasteAnalysis {
  return {
    headingDepths: structure.depths,
    headingSamples: structure.depths.map((depth) => structure.headings.find((heading) => !heading.nested && heading.depth === depth)?.text ?? ""),
    numberedHeadings: structure.numberedHeadings,
    internalLinks: structure.internalLinks,
    tables: structure.tables.map(({ columns, rows, header, caption }) => ({ columns, rows, header, caption })),
    images: structure.images,
    citations: structure.citations,
    footnotes: structure.footnotes.size,
    codeBlocks: structure.codeBlocks,
    math: structure.math,
    structural: structure.depths.length > 0 || structure.tables.length > 0,
    markdown: structure.markdown,
  };
}
