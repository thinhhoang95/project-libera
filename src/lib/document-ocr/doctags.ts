import { preferredMathMarkerPair, type MathMarkerSettings } from "@/lib/math-markers";

/**
 * Converts DocTags, the page markup that IBM's granite-docling model writes,
 * into Markdown blocks.
 *
 * DocTags look like `<text><loc_12><loc_40><loc_480><loc_60>Some text</text>`.
 * Each block starts with four location tokens on a 0–500 grid over the page
 * image. Tables use OTSL: cell tokens (`<fcel>`, `<ecel>`, `<ched>`, …) and
 * `<nl>` for each row end. The model sometimes stops mid-element, so the parser
 * accepts unclosed tags.
 */

export type DocumentBox = { x: number; y: number; width: number; height: number };

export type DocumentBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "formula"
  | "code"
  | "picture"
  | "caption"
  | "footnote";

export type DocumentBlock = {
  kind: DocumentBlockKind;
  markdown: string;
  /** The block's area as fractions of the page image, when the model gave one. */
  box?: DocumentBox;
  /** For pictures: the index used in the placeholder link. */
  pictureIndex?: number;
};

export type DocumentPicture = { index: number; box: DocumentBox; caption: string };

export type DocTagsConversion = {
  blocks: DocumentBlock[];
  pictures: DocumentPicture[];
  markdown: string;
};

/** Pictures come back as `![caption](libera-ocr-picture:N)` for the caller to crop and upload. */
export const PICTURE_PLACEHOLDER_PREFIX = "libera-ocr-picture:";

const LOCATION_GRID = 500;
const TAG_PATTERN = /<(\/?)([A-Za-z_][\w]*)>/g;
// Special tokens the decoder can leave around the DocTags.
const SPECIAL_TOKEN_PATTERN = /<\|[^|>]*\|>|<end_of_utterance>/g;
const TABLE_CELL_TAGS = new Set(["fcel", "ecel", "ched", "rhed", "srow", "lcel", "ucel", "xcel"]);
const MERGED_CELL_TAGS = new Set(["lcel", "ucel", "xcel"]);
const DROPPED_BLOCKS = new Set(["page_header", "page_footer", "page_break"]);
const CONTAINER_BLOCKS = new Set(["doctag", "document", "group", "key_value_region", "form", "chart", "document_index"]);

type Node = { name: string; children: Array<Node | string> };

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": "\"", "&#39;": "'", "&apos;": "'" };

function decodeEntities(text: string) {
  return text.replace(/&(?:lt|gt|amp|quot|apos|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** Build a tree; a tag counts as a container only if a closing tag for it appears somewhere. */
export function parseDocTags(source: string): Node {
  const cleaned = source.replace(SPECIAL_TOKEN_PATTERN, "");
  const closed = new Set<string>();
  for (const match of cleaned.matchAll(TAG_PATTERN)) {
    if (match[1]) closed.add(match[2]);
  }

  const root: Node = { name: "root", children: [] };
  const stack: Node[] = [root];
  let last = 0;

  const pushText = (text: string) => {
    if (text) stack[stack.length - 1].children.push(decodeEntities(text));
  };

  for (const match of cleaned.matchAll(TAG_PATTERN)) {
    pushText(cleaned.slice(last, match.index));
    last = match.index + match[0].length;
    const [, slash, name] = match;

    if (slash) {
      const index = stack.map((node) => node.name).lastIndexOf(name);
      if (index > 0) stack.length = index;
      continue;
    }

    const node: Node = { name, children: [] };
    stack[stack.length - 1].children.push(node);
    if (closed.has(name) && !TABLE_CELL_TAGS.has(name) && !isLocation(name)) stack.push(node);
  }

  pushText(cleaned.slice(last));
  return root;
}

function isLocation(name: string) {
  return /^loc_\d+$/.test(name);
}

function isLanguageTag(name: string) {
  return /^_[^_].*_$/.test(name);
}

function locationBox(node: Node): DocumentBox | undefined {
  const values = node.children
    .filter((child): child is Node => typeof child !== "string" && isLocation(child.name))
    .slice(0, 4)
    .map((child) => Math.min(LOCATION_GRID, Math.max(0, Number(child.name.slice(4)))));

  if (values.length < 4) return undefined;
  // Subtract on the integer grid, then scale, so sizes come out exact.
  const [left, top, right, bottom] = values;
  const width = Math.abs(right - left);
  const height = Math.abs(bottom - top);
  if (!width || !height) return undefined;
  return {
    x: Math.min(left, right) / LOCATION_GRID,
    y: Math.min(top, bottom) / LOCATION_GRID,
    width: width / LOCATION_GRID,
    height: height / LOCATION_GRID,
  };
}

function collapse(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/** Text with inline formatting, as one Markdown line. */
function inlineText(node: Node, math: InlineMath): string {
  let result = "";

  for (const child of node.children) {
    if (typeof child === "string") {
      result += child;
      continue;
    }

    const { name } = child;
    if (isLocation(name) || isLanguageTag(name) || TABLE_CELL_TAGS.has(name) || name === "nl") continue;

    const inner = collapse(inlineText(child, math));
    if (!inner) continue;

    if (name === "bold") result += ` **${inner}** `;
    else if (name === "italic") result += ` *${inner}* `;
    else if (name === "strikethrough") result += ` ~~${inner}~~ `;
    else if (name === "formula") result += ` ${math.open}${inner}${math.close} `;
    else if (name === "code") result += ` \`${inner.replaceAll("`", "")}\` `;
    else result += ` ${inner} `;
  }

  // Formatting markers gain spaces above; drop the ones before punctuation.
  return collapse(result).replace(/ ([,.;:!?)\]])/g, "$1").replace(/([([]) /g, "$1");
}

/** Raw text for code: keeps line breaks, drops tags. */
function rawText(node: Node): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : isLocation(child.name) || isLanguageTag(child.name) ? "" : rawText(child)))
    .join("");
}

function codeLanguage(node: Node) {
  const tag = node.children.find((child): child is Node => typeof child !== "string" && isLanguageTag(child.name));
  const language = tag?.name.slice(1, -1).toLowerCase() ?? "";
  return language === "unknown" ? "" : language.replace(/[^a-z0-9+#-]/g, "");
}

/** Escape what would turn a paragraph into a heading, quote or list by accident. */
function escapeParagraphStart(text: string) {
  return text.replace(/^(#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s)/, (prefix) => `\\${prefix}`);
}

function escapeCell(text: string) {
  return text.replace(/\|/g, "\\|");
}

type InlineMath = { open: string; close: string };

function tableMarkdown(node: Node, math: InlineMath): { table: string; caption: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell: string | null = null;
  let caption = "";

  const finishCell = () => {
    if (cell !== null) row.push(escapeCell(collapse(cell)));
    cell = null;
  };
  const finishRow = () => {
    finishCell();
    if (row.length) rows.push(row);
    row = [];
  };

  for (const child of node.children) {
    if (typeof child === "string") {
      cell = (cell ?? "") + child;
      continue;
    }
    if (isLocation(child.name)) continue;
    if (child.name === "nl") {
      finishRow();
    } else if (TABLE_CELL_TAGS.has(child.name)) {
      finishCell();
      cell = "";
      if (MERGED_CELL_TAGS.has(child.name) || child.name === "ecel") finishCell();
    } else if (child.name === "caption") {
      caption = inlineText(child, math);
    } else {
      cell = `${cell ?? ""} ${inlineText(child, math)}`;
    }
  }
  finishRow();

  if (!rows.length) return { table: "", caption };

  const width = Math.max(...rows.map((cells) => cells.length));
  const padded = rows.map((cells) => [...cells, ...Array<string>(width - cells.length).fill("")]);
  const line = (cells: string[]) => `| ${cells.map((value) => value || " ").join(" | ")} |`;
  const table = [line(padded[0]), `| ${Array<string>(width).fill("---").join(" | ")} |`, ...padded.slice(1).map(line)].join("\n");
  return { table, caption };
}

function listMarkdown(node: Node, ordered: boolean, math: InlineMath, depth = 0): string {
  const indent = "   ".repeat(depth);
  const lines: string[] = [];
  let number = 1;

  for (const child of node.children) {
    if (typeof child === "string" || child.name !== "list_item") continue;
    const nested = child.children.filter(
      (item): item is Node => typeof item !== "string" && (item.name === "ordered_list" || item.name === "unordered_list"),
    );
    const own: Node = { name: child.name, children: child.children.filter((item) => !nested.includes(item as Node)) };
    // The model often keeps the printed bullet or number in the text.
    const text = inlineText(own, math).replace(ordered ? /^\(?\d+[.)]\s+/ : /^[•●▪◦‣∙·*-]\s*/, "");
    lines.push(`${indent}${ordered ? `${number}.` : "-"} ${text}`);
    number += 1;
    for (const list of nested) lines.push(listMarkdown(list, list.name === "ordered_list", math, depth + 1));
  }

  return lines.join("\n");
}

export function docTagsToMarkdown(source: string, mathMarkers: MathMarkerSettings = {}): DocTagsConversion {
  const inline = preferredMathMarkerPair(mathMarkers, false) ?? { open: "$", close: "$" };
  const display = preferredMathMarkerPair(mathMarkers, true) ?? { open: "$$", close: "$$" };
  const math: InlineMath = { open: inline.open, close: inline.close };
  const blocks: DocumentBlock[] = [];
  const pictures: DocumentPicture[] = [];

  const add = (kind: DocumentBlockKind, markdown: string, node?: Node, extra: Partial<DocumentBlock> = {}) => {
    if (!markdown.trim()) return;
    const box = node ? locationBox(node) : undefined;
    blocks.push({ kind, markdown, ...(box ? { box } : {}), ...extra });
  };

  const visit = (node: Node) => {
    for (const child of node.children) {
      if (typeof child === "string") {
        const text = collapse(child);
        if (text) add("paragraph", escapeParagraphStart(text));
        continue;
      }

      const { name } = child;
      if (DROPPED_BLOCKS.has(name) || isLocation(name)) continue;

      if (CONTAINER_BLOCKS.has(name)) {
        visit(child);
      } else if (name === "title") {
        add("heading", `# ${inlineText(child, math)}`, child);
      } else if (name.startsWith("section_header_level_")) {
        const level = Math.min(6, Math.max(2, Number(name.slice("section_header_level_".length)) + 1 || 2));
        add("heading", `${"#".repeat(level)} ${inlineText(child, math)}`, child);
      } else if (name === "formula") {
        const latex = collapse(rawText(child));
        if (latex) add("formula", `${display.open}\n${latex}\n${display.close}`, child);
      } else if (name === "code") {
        const code = rawText(child).replace(/^\n+|\s+$/g, "");
        const fence = code.includes("```") ? "~~~" : "```";
        if (code) add("code", `${fence}${codeLanguage(child)}\n${code}\n${fence}`, child);
      } else if (name === "ordered_list" || name === "unordered_list") {
        add("list", listMarkdown(child, name === "ordered_list", math), child);
      } else if (name === "list_item") {
        add("list", `- ${inlineText(child, math).replace(/^[•●▪◦‣∙·*-]\s*/, "")}`, child);
      } else if (name === "checkbox_selected" || name === "checkbox_unselected") {
        add("list", `- [${name === "checkbox_selected" ? "x" : " "}] ${inlineText(child, math)}`, child);
      } else if (name === "otsl") {
        const { table, caption } = tableMarkdown(child, math);
        add("table", table, child);
        if (caption) add("caption", escapeParagraphStart(caption));
      } else if (name === "picture") {
        const box = locationBox(child);
        const captionNode = child.children.find((item): item is Node => typeof item !== "string" && item.name === "caption");
        const caption = captionNode ? inlineText(captionNode, math) : "";
        if (box) {
          const index = pictures.length;
          pictures.push({ index, box, caption });
          const alt = (caption || "Figure").replace(/[[\]]/g, "").slice(0, 120);
          add("picture", `![${alt}](${PICTURE_PLACEHOLDER_PREFIX}${index})`, child, { pictureIndex: index });
        }
        // Charts can carry their data as a table.
        for (const item of child.children) {
          if (typeof item !== "string" && item.name === "otsl") add("table", tableMarkdown(item, math).table, item);
        }
        if (caption) add("caption", escapeParagraphStart(caption));
      } else if (name === "caption") {
        add("caption", escapeParagraphStart(inlineText(child, math)), child);
      } else if (name === "footnote") {
        add("footnote", escapeParagraphStart(inlineText(child, math)), child);
      } else {
        // text, inline, reference and anything newer than this converter.
        const text = inlineText(child, math);
        if (text) add("paragraph", escapeParagraphStart(text), child);
      }
    }
  };

  visit(parseDocTags(source));
  return { blocks, pictures, markdown: blocks.map((block) => block.markdown).join("\n\n") };
}

const SENTENCE_END = /[.!?:;。！？]["'”’»)\]]*$/;

/**
 * Join converted pages into one document. A paragraph that runs over a page
 * break is merged back together, including a word hyphenated across it.
 */
export function joinDocumentPages(pages: DocumentBlock[][]): string {
  const output: DocumentBlock[] = [];

  for (const page of pages) {
    const blocks = page.map((block) => ({ ...block }));
    const first = blocks[0];

    if (first?.kind === "paragraph") {
      // The body text ends before any footnotes at the bottom of the last page.
      let index = output.length - 1;
      while (index >= 0 && output[index].kind === "footnote") index -= 1;
      const previous = output[index];

      if (previous?.kind === "paragraph" && continuesParagraph(previous.markdown, first.markdown)) {
        previous.markdown = mergeParagraphs(previous.markdown, first.markdown);
        blocks.shift();
      }
    }

    output.push(...blocks);
  }

  return output.map((block) => block.markdown).join("\n\n");
}

function continuesParagraph(previous: string, next: string) {
  if (/^\p{Ll}/u.test(next)) return true;
  return !SENTENCE_END.test(previous.trimEnd()) && !/^\\?[#>]/.test(next);
}

function mergeParagraphs(previous: string, next: string) {
  const text = previous.trimEnd();
  if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(next)) return `${text.slice(0, -1)}${next}`;
  return `${text} ${next.replace(/^\\(?=[#>\-+*\d])/, "")}`;
}
