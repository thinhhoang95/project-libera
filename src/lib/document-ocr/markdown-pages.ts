import { continuesParagraph, mergeParagraphs, PICTURE_PLACEHOLDER_PREFIX, type DocumentPicture } from "@/lib/document-ocr/doctags";

/**
 * Markdown read page by page by an OpenRouter model, put back together.
 * Shared by the browser, which joins the pages as they arrive, and the server,
 * which turns the model's figure boxes into the same placeholders the local
 * model's pages use.
 */

const FENCE = /^\s{0,3}(```|~~~)/;
const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]:/;
// Blocks that are not running text: headings, quotes, lists, tables, code, math, images, footnotes, HTML.
const NOT_PARAGRAPH = /^(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||```|~~~|!\[|\[\^|<|\$\$|\\\[)/;

/** Blocks separated by blank lines, keeping fenced code (which may hold blank lines) whole. */
export function splitMarkdownBlocks(markdown: string) {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence = "";

  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (marker && (!fence || marker === fence)) fence = fence ? "" : marker;
    if (!fence && !marker && !line.trim()) {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function isParagraph(block: string) {
  return !NOT_PARAGRAPH.test(block.trimStart()) && !block.includes("\n|");
}

function tableRows(block: string) {
  const lines = block.split("\n");
  return lines.every((line) => line.trimStart().startsWith("|")) ? lines : null;
}

function isSeparator(line: string) {
  return /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

function cells(line: string) {
  return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/**
 * A table that runs onto the next page: the model is asked to write the
 * continuation without a header, and pages that repeat the header lose the copy.
 */
function continueTable(previous: string, next: string) {
  const before = tableRows(previous);
  const after = tableRows(next);
  if (!before || !after || before.length < 2 || !isSeparator(before[1])) return null;
  const width = cells(before[0]).length;
  if (cells(after[0]).length !== width) return null;
  if (after.length >= 2 && isSeparator(after[1])) {
    if (cells(after[0]).join("|").toLowerCase() !== cells(before[0]).join("|").toLowerCase()) return null;
    return [...before, ...after.slice(2)].join("\n");
  }
  return [...before, ...after].join("\n");
}

/** A table left without a header row (a continuation with nothing to join) gets its first row as header. */
function completeTable(block: string) {
  const rows = tableRows(block);
  if (!rows || (rows.length >= 2 && isSeparator(rows[1]))) return block;
  return [rows[0], `|${cells(rows[0]).map(() => " --- ").join("|")}|`, ...rows.slice(1)].join("\n");
}

/**
 * Join pages into one document. A paragraph or table cut by a page break is
 * merged back, past the footnotes at the bottom of the earlier page, and a
 * word hyphenated across the break is joined.
 */
export function joinMarkdownPages(pages: string[]) {
  const output: string[] = [];

  for (const page of pages) {
    const blocks = splitMarkdownBlocks(page.trim());
    const first = blocks[0];
    let index = output.length - 1;
    while (index >= 0 && FOOTNOTE_DEFINITION.test(output[index])) index -= 1;
    const previous = output[index];

    if (first !== undefined && previous !== undefined) {
      if (isParagraph(previous) && isParagraph(first) && continuesParagraph(previous, first)) {
        output[index] = mergeParagraphs(previous, first);
        blocks.shift();
      } else {
        const table = continueTable(previous, first);
        if (table) {
          output[index] = table;
          blocks.shift();
        }
      }
    }

    output.push(...blocks);
  }

  return output.map(completeTable).join("\n\n");
}

export type MarkdownHeading = { level: number; text: string; page: number };

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

function eachHeadingLine(markdown: string, visit: (line: string, index: number, match: RegExpExecArray) => void) {
  const lines = markdown.split("\n");
  let fence = "";
  lines.forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker && (!fence || marker === fence)) {
      fence = fence ? "" : marker;
      return;
    }
    const match = fence ? null : HEADING.exec(line);
    if (match) visit(line, index, match);
  });
  return lines;
}

export function extractMarkdownHeadings(markdown: string, page: number): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  eachHeadingLine(markdown, (_line, _index, match) => headings.push({ level: match[1].length, text: match[2], page }));
  return headings;
}

/**
 * Give the document's headings new levels, in order. Level 0 turns a heading
 * that is not one (a running title the model kept) into plain text.
 */
export function applyHeadingLevels(markdown: string, levels: number[]) {
  let position = 0;
  const changes = new Map<number, string>();
  const lines = eachHeadingLine(markdown, (_line, index, match) => {
    const level = levels[position++];
    if (level === undefined || !Number.isInteger(level) || level < 0 || level > 6) return;
    changes.set(index, level ? `${"#".repeat(level)} ${match[2]}` : match[2]);
  });
  return lines.map((line, index) => changes.get(index) ?? line).join("\n");
}

/**
 * The model marks figures as `![caption](figure:x,y,width,height)`, as
 * fractions of the page. They become the placeholders the app crops and
 * uploads; a figure without a usable box keeps only its caption.
 */
export function extractFigurePlaceholders(markdown: string): { markdown: string; pictures: DocumentPicture[] } {
  const pictures: DocumentPicture[] = [];
  const result = markdown.replace(/!\[([^\]]*)\]\(figure:([^)]*)\)/g, (_match, caption: string, box: string) => {
    const [x, y, width, height] = box.split(",").map((value) => Number(value.trim()));
    const valid = [x, y, width, height].every(Number.isFinite)
      && x >= 0 && y >= 0 && width > 0.02 && height > 0.02 && x + width <= 1.02 && y + height <= 1.02;
    if (!valid) return caption.trim() ? `*${caption.trim()}*` : "";
    const index = pictures.length;
    pictures.push({ index, caption: caption.trim(), box: { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) } });
    return `![${caption.trim()}](${PICTURE_PLACEHOLDER_PREFIX}${index})`;
  });
  return { markdown: result.replace(/\n{3,}/g, "\n\n").trim(), pictures };
}
