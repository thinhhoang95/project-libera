import type {
  PDFPageProxy,
  StructTreeNode,
  TextContent,
  TextItem,
} from "pdfjs-dist/types/src/display/api";
import type { PdfLayoutPage, PdfLayoutRun } from "@/lib/pdf-markdown";

/** Per text item structure from a tagged PDF, indexed like TextLayer textDivs. */
export type PdfPageStructure = {
  itemCount: number;
  blocks: (number | undefined)[];
  roles: (string | undefined)[];
  artifacts: boolean[];
};

type PdfLayoutSourcePage = Pick<PDFPageProxy, "pageNumber" | "getViewport"> & {
  commonObjs?: Pick<PDFPageProxy["commonObjs"], "has" | "get">;
};

// Structure roles that hold a paragraph-like run of text.
const BLOCK_ROLES = new Set([
  "P", "H", "H1", "H2", "H3", "H4", "H5", "H6", "Title", "LI", "Caption", "BlockQuote",
  "Note", "FENote", "TOCI", "Code", "TD", "TH", "Formula", "BibEntry", "Aside",
]);
const MATH_FONT = /cmmi|cmsy|cmex|msam|msbm|rsfs|eufm|math|symbol/i;
const BOLD_FONT = /bold|black|heavy|semibold|demi|cmbx|cmb\d|sfbx|-medi/i;
const ITALIC_FONT = /italic|ital\b|oblique|cmti|cmsl|cmbxti|sfti|sfsl|-it\b/i;
const MONO_FONT = /mono|courier|consol|menlo|cmtt|sftt|typewriter|inconsolata|cousine/i;

/**
 * Converts pdf.js text content into page geometry for Markdown reconstruction.
 * Font weights are read from the page's loaded fonts, so they are only known
 * after the page has been rendered once.
 */
export function pdfLayoutPage(
  page: PdfLayoutSourcePage,
  content: TextContent,
  structure?: PdfPageStructure | null,
): PdfLayoutPage {
  const viewport = page.getViewport({ scale: 1 });
  const runs: PdfLayoutRun[] = [];
  const itemCount = content.items.filter((item) => "str" in item).length;
  const tags = structure && structure.itemCount === itemCount ? structure : null;
  const fonts = new Map<string, Pick<PdfLayoutRun, "bold" | "italic" | "monospace">>();
  let index = -1;

  for (const entry of content.items) {
    if (!("str" in entry)) continue;
    const item = entry as TextItem;
    index++;
    if (!item.str) continue;

    const transform = multiply(viewport.transform, item.transform);
    const style = content.styles[item.fontName];
    // Rotated text, such as an arXiv identifier in the margin, is not body text.
    if (style?.vertical || Math.abs(Math.atan2(transform[1], transform[0])) > 0.02) continue;

    let font = fonts.get(item.fontName);
    if (!font) fonts.set(item.fontName, font = fontStyle(page, item.fontName, style?.fontFamily));

    runs.push({
      index,
      text: item.str,
      x: transform[4],
      y: transform[5],
      width: item.width,
      size: Math.hypot(transform[2], transform[3]),
      ...font,
      ...(tags?.blocks[index] === undefined ? {} : { block: tags.blocks[index], role: tags.roles[index] }),
      ...(tags?.artifacts[index] ? { artifact: true } : {}),
    });
  }

  return { pageNumber: page.pageNumber, width: viewport.width, height: viewport.height, runs };
}

function fontStyle(page: PdfLayoutSourcePage, fontName: string, family = "") {
  let name = "";
  let bold = false;
  let italic = false;

  try {
    if (page.commonObjs?.has(fontName)) {
      const font = page.commonObjs.get(fontName) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean } | null;
      name = font?.name ?? "";
      bold = Boolean(font?.bold || font?.black);
      italic = Boolean(font?.italic);
    }
  } catch {
    // Fonts that are still loading are treated as regular.
  }

  const monospace = family === "monospace" || MONO_FONT.test(name);
  bold ||= BOLD_FONT.test(name);
  // Italic math variables are not emphasis.
  italic = !MATH_FONT.test(name) && (italic || ITALIC_FONT.test(name));
  return { bold, italic, monospace };
}

/** Reads the structure tree of a tagged PDF page, or null for untagged pages. */
export async function readPdfPageStructure(
  page: Pick<PDFPageProxy, "getStructTree" | "getTextContent">,
): Promise<PdfPageStructure | null> {
  const [tree, marked] = await Promise.all([
    page.getStructTree(),
    page.getTextContent({ includeMarkedContent: true }),
  ]);
  if (!tree) return null;

  const owners = new Map<string, { block: number; role: string }>();
  let nextBlock = 0;

  function walk(node: StructTreeNode, owner: { block: number; role: string } | undefined, depth: number) {
    if (depth > 64) return;
    let current = owner;
    // A list item stays one block even when it wraps its text in paragraphs.
    if (node.role === "LI" || (BLOCK_ROLES.has(node.role) && owner?.role !== "LI")) {
      current = { block: nextBlock++, role: node.role };
    }

    for (const child of node.children ?? []) {
      if ("role" in child) {
        walk(child, current, depth + 1);
      } else if (child.type === "content" && current) {
        owners.set(child.id, current);
      }
    }
  }

  walk(tree, undefined, 0);

  const structure: PdfPageStructure = { itemCount: 0, blocks: [], roles: [], artifacts: [] };
  const stack: { id?: string; tag?: string }[] = [];

  for (const entry of marked.items) {
    if ("str" in entry) {
      const owner = [...stack].reverse().find((marker) => marker.id && owners.has(marker.id));
      const info = owner?.id ? owners.get(owner.id) : undefined;
      structure.blocks.push(info?.block);
      structure.roles.push(info?.role);
      structure.artifacts.push(stack.some((marker) => marker.tag === "Artifact"));
      structure.itemCount++;
      continue;
    }

    const marker = entry as { type: string; id?: string | null; tag?: string | null };
    if (marker.type === "endMarkedContent") {
      stack.pop();
    } else if (marker.type === "beginMarkedContent" || marker.type === "beginMarkedContentProps") {
      stack.push({ id: marker.id ?? undefined, tag: marker.tag ?? undefined });
    }
  }

  return owners.size ? structure : null;
}

function multiply(m1: number[], m2: number[]) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}
