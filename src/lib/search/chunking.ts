/**
 * Splits documents into passages for Global Search.
 *
 * A passage follows natural boundaries (sections, then paragraphs, then
 * sentences) and stays near CHUNK_TARGET_CHARS, a few hundred tokens. Its
 * offsets and lines point back into the source so a hit can open the file at
 * the passage. Passages do not overlap; instead each one carries the tail of
 * the previous passage as `context`, which is embedded with it so ideas cut at
 * a boundary keep their meaning without duplicating keyword hits.
 */

import { scanCitations } from "../references/citation-syntax";

export const CHUNK_TARGET_CHARS = 1100;
export const CHUNK_MAX_CHARS = 1800;
export const CHUNK_CONTEXT_CHARS = 200;
export const MAX_CHUNKS_PER_FILE = 4000;
const SMALL_SECTION_CHARS = 120;

export type SourceChunk = {
  /** Section path, outermost first, joined with " › "; empty when there is none. */
  title: string;
  text: string;
  start: number;
  end: number;
  /** 1-based lines of `start` and of the last character. */
  line: number;
  endLine: number;
  page?: number;
  /** The end of the previous passage, embedded with this one. */
  context: string;
};

type Range = { start: number; end: number };
/** `headed` is false for text before the first heading, which has no heading of its own. */
type Section = Range & { title: string; headed?: boolean };

export function lineStarts(source: string) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** 1-based line containing `offset`. */
export function lineAt(starts: number[], offset: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function trimRange(source: string, start: number, end: number): Range {
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  return { start, end };
}

/** The last boundary at or before `limit` (and after `floor`) that `pattern` matches. */
function lastBoundary(source: string, floor: number, limit: number, pattern: RegExp) {
  const slice = source.slice(floor, limit);
  let found = -1;
  for (const match of slice.matchAll(pattern)) found = floor + match.index + match[0].length;
  return found > floor ? found : -1;
}

/** Cut a long block into pieces no longer than the target, preferring sentence and line ends. */
function splitLongBlock(source: string, block: Range): Range[] {
  const pieces: Range[] = [];
  let start = block.start;

  while (block.end - start > CHUNK_MAX_CHARS) {
    const limit = start + CHUNK_TARGET_CHARS;
    const floor = start + Math.floor(CHUNK_TARGET_CHARS / 3);
    const cut =
      [/\n/g, /[.!?。！？]["')\]]*\s+/gu, /[;:,]\s+/g, /\s+/g]
        .map((pattern) => lastBoundary(source, floor, limit, pattern))
        .find((offset) => offset > 0) ?? limit;
    const piece = trimRange(source, start, cut);
    if (piece.end > piece.start) pieces.push(piece);
    start = cut;
  }

  const rest = trimRange(source, start, block.end);
  if (rest.end > rest.start) pieces.push(rest);
  return pieces;
}

/** Paragraph-sized blocks of a range: runs of text between blank lines. */
function blocksOf(source: string, range: Range): Range[] {
  const blocks: Range[] = [];
  const pattern = /\n[ \t]*\n/g;
  pattern.lastIndex = range.start;
  let start = range.start;

  for (;;) {
    const match = pattern.exec(source);
    const end = match && match.index < range.end ? match.index : range.end;
    const block = trimRange(source, start, end);
    if (block.end > block.start) {
      blocks.push(...(block.end - block.start > CHUNK_MAX_CHARS ? splitLongBlock(source, block) : [block]));
    }
    if (!match || match.index >= range.end) break;
    start = match.index + match[0].length;
  }

  return blocks;
}

/** Pack blocks into passages near the target size. */
export function packRange(source: string, range: Range): Range[] {
  const passages: Range[] = [];
  let current: Range | null = null;

  for (const block of blocksOf(source, range)) {
    if (current && block.end - current.start > CHUNK_TARGET_CHARS) {
      passages.push(current);
      current = null;
    }
    current = current ? { start: current.start, end: block.end } : { ...block };
  }

  if (current) passages.push(current);
  return passages;
}

function contextBefore(source: string, start: number, floor: number) {
  if (start <= floor) return "";
  const from = Math.max(floor, start - CHUNK_CONTEXT_CHARS);
  // Begin at a word so the context does not start with a fragment.
  const slice = source.slice(from, start);
  const firstSpace = from > floor ? slice.search(/\s/) : -1;
  return (firstSpace >= 0 ? slice.slice(firstSpace) : slice).replace(/\s+/g, " ").trim();
}

function chunksFromSections(source: string, sections: Section[], page?: number): SourceChunk[] {
  const starts = lineStarts(source);
  const chunks: SourceChunk[] = [];

  for (const section of sections) {
    for (const passage of packRange(source, section)) {
      if (chunks.length >= MAX_CHUNKS_PER_FILE) return chunks;
      chunks.push({
        title: section.title,
        text: source.slice(passage.start, passage.end),
        start: passage.start,
        end: passage.end,
        line: lineAt(starts, passage.start),
        endLine: lineAt(starts, Math.max(passage.start, passage.end - 1)),
        page,
        context: contextBefore(source, passage.start, 0),
      });
    }
  }

  return chunks;
}

/** The headings two section paths share, so a merged passage is never labeled too specifically. */
function sharedTitle(first: string, second: string) {
  const left = first.split(" › ");
  const right = second.split(" › ");
  const shared: string[] = [];
  for (let index = 0; index < Math.min(left.length, right.length) && left[index] === right[index]; index += 1) {
    shared.push(left[index]);
  }
  return shared.join(" › ");
}

/**
 * Fold a near-empty section (a heading with a line or two) into the next one,
 * so a list of tiny headings does not make tiny passages. The merged passage
 * is labeled with the headings both share.
 */
function mergeSmallSections(sections: Section[]) {
  const merged: Section[] = [];
  let carry: Section | null = null;

  for (const section of sections) {
    const current: Section = carry
      ? { ...section, start: carry.start, title: carry.headed ? sharedTitle(carry.title, section.title) : section.title }
      : { ...section };
    carry = null;
    if (current.end - current.start < SMALL_SECTION_CHARS && section !== sections.at(-1)) {
      carry = current;
      continue;
    }
    merged.push(current);
  }

  if (carry) merged.push(carry);
  return merged;
}

function sectionsFromHeadings(
  source: string,
  headings: Array<{ offset: number; level: number; title: string }>,
  leadingTitle = "",
): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let start = 0;
  let title = leadingTitle;

  let headed = false;

  for (const heading of headings) {
    if (heading.offset > start) sections.push({ start, end: heading.offset, title, headed });
    while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop();
    stack.push({ level: heading.level, title: heading.title });
    start = heading.offset;
    title = stack.map((item) => item.title).filter(Boolean).join(" › ");
    headed = Boolean(heading.title);
  }

  sections.push({ start, end: source.length, title, headed });
  return mergeSmallSections(sections.filter((section) => source.slice(section.start, section.end).trim()));
}

function cleanHeadingTitle(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** ATX and setext headings outside fenced code, and front matter. */
export function markdownHeadings(source: string) {
  const headings: Array<{ offset: number; level: number; title: string }> = [];
  const lines = source.split("\n");
  let offset = 0;
  let fence: string | null = null;
  let previous: { offset: number; text: string } | null = null;
  let frontMatterEnd = -1;

  if (lines[0]?.trim() === "---") {
    const closing = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (closing > 0) frontMatterEnd = closing;
  }

  lines.forEach((line, index) => {
    const lineOffset = offset;
    offset += line.length + 1;

    if (index <= frontMatterEnd) {
      previous = null;
      return;
    }

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0].repeat(fenceMatch[1].length);
      else if (line.trim().startsWith(fence)) fence = null;
      previous = null;
      return;
    }
    if (fence) return;

    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      headings.push({ offset: lineOffset, level: atx[1].length, title: cleanHeadingTitle(atx[2]) });
      previous = null;
      return;
    }

    const setext = /^\s{0,3}(=+|-+)\s*$/.exec(line);
    if (setext && previous && previous.text.trim() && !/^\s*([-*+]|\d+[.)]|>)\s/.test(previous.text)) {
      headings.push({ offset: previous.offset, level: setext[1][0] === "=" ? 1 : 2, title: cleanHeadingTitle(previous.text) });
      previous = null;
      return;
    }

    previous = { offset: lineOffset, text: line };
  });

  return headings;
}

export function chunkMarkdown(source: string): SourceChunk[] {
  return chunksFromSections(source, sectionsFromHeadings(source, markdownHeadings(source)));
}

const LATEX_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
};

/** The text between a `{` at `open` and its matching `}`. */
function bracedText(source: string, open: number) {
  let depth = 0;
  for (let index = open; index < source.length && index < open + 2000; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return "";
}

function isCommentedOut(source: string, offset: number) {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return /(^|[^\\])%/.test(source.slice(lineStart, offset));
}

function latexTitle(value: string) {
  return value
    .replace(/\\[a-zA-Z]+\*?\s*(\[[^\]]*\])?/g, " ")
    .replace(/[{}$]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function latexHeadings(source: string) {
  const headings: Array<{ offset: number; level: number; title: string }> = [];
  const pattern = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g;

  for (const match of source.matchAll(pattern)) {
    if (isCommentedOut(source, match.index)) continue;
    const lineStart = source.lastIndexOf("\n", match.index - 1) + 1;
    const open = match.index + match[0].length - 1;
    headings.push({ offset: lineStart, level: LATEX_LEVELS[match[1]], title: latexTitle(bracedText(source, open)) });
  }

  // Two commands on one line would make an empty section; keep the first.
  return headings.filter((heading, index) => index === 0 || heading.offset !== headings[index - 1].offset);
}

function bibtexEntries(source: string): Section[] {
  const starts = Array.from(source.matchAll(/^[ \t]*@([a-zA-Z]+)\s*[{(]\s*([^,\s]*)/gm));
  return starts.flatMap((match, index) => {
    if (/^(comment|preamble|string)$/i.test(match[1])) return [];
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
    const title = /\btitle\s*=\s*[{"]+([^}"]+)/i.exec(source.slice(match.index, end))?.[1];
    return [{ start: match.index, end, title: latexTitle(title ?? match[2] ?? "") }];
  });
}

export function chunkLatex(source: string, fileName = ""): SourceChunk[] {
  if (/\.bib$/i.test(fileName)) {
    const entries = bibtexEntries(source);
    if (entries.length) return chunksFromSections(source, entries);
  }

  const headings = latexHeadings(source);
  const documentStart = /\\begin\s*\{document\}/.exec(source);
  if (documentStart && !headings.some((heading) => heading.offset <= documentStart.index)) {
    // The preamble has no headings of its own.
    const lineStart = source.lastIndexOf("\n", documentStart.index - 1) + 1;
    if (lineStart > 0) headings.unshift({ offset: lineStart, level: 1, title: "" });
    return chunksFromSections(source, sectionsFromHeadings(source, headings, "Preamble"));
  }

  return chunksFromSections(source, sectionsFromHeadings(source, headings));
}

export function chunkPlainText(source: string): SourceChunk[] {
  return chunksFromSections(source, [{ start: 0, end: source.length, title: "" }]);
}

/** One section per page; the passage before each one carries over across pages. */
export function chunkPdfPages(pages: Array<{ pageNumber: number; text: string }>): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  let previousTail = "";

  for (const page of pages) {
    if (!page.text.trim()) continue;
    for (const chunk of chunksFromSections(page.text, [{ start: 0, end: page.text.length, title: "" }], page.pageNumber)) {
      if (chunks.length >= MAX_CHUNKS_PER_FILE) return chunks;
      chunks.push({ ...chunk, context: chunk.context || previousTail });
      previousTail = contextBefore(chunk.text, chunk.text.length, 0);
    }
  }

  return chunks;
}

/**
 * A citation token becomes its keys separated by spaces, so a search for
 * "smith2020sparse" finds it and brackets and locators are not embedded.
 */
function citationKeysText(markdown: string) {
  if (!markdown.includes("@")) return markdown;
  let text = "";
  let last = 0;
  for (const { citation, start, end } of scanCitations(markdown)) {
    text += `${markdown.slice(last, start)}${citation.items.map((item) => item.key).join(" ")}`;
    last = end;
  }
  return last ? text + markdown.slice(last) : markdown;
}

/**
 * Strip markup that carries no meaning for the embedding model.
 *
 * The stored vectors are keyed by a hash of this text (see `promptHash` in
 * database.ts) and files are re-chunked only when their signature changes,
 * so a change here reaches an existing index file by file: an edited file
 * re-embeds only the passages whose text changed (for citations, those that
 * contain one), and unchanged files keep their vectors until edited.
 */
export function embeddingText(kind: string, text: string) {
  let value = text.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, " ");

  if (kind === "markdown") {
    value = citationKeysText(value)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[\/?color(=[^\]]*)?\]/g, "")
      .replace(/(?:^|(?<=\s))[a-z]?>>>|<<</g, "")
      .replace(/^[ \t]*[a-z]?>[ \t]?/gm, "")
      .replace(/^#{1,6}[ \t]+/gm, "")
      .replace(/<\/?[a-z][^>]*>/gi, " ");
  } else if (kind === "latex") {
    value = value
      .replace(/(^|[^\\])%.*$/gm, "$1")
      .replace(/\\(label|ref|eqref|cref|Cref)\{[^}]*\}/g, " ");
  } else if (kind === "pdf") {
    value = value.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2");
  }

  return value.replace(/[ \t]+/g, " ").replace(/ \n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The file title used in both the stored vector identity and the model input. */
export function documentFileTitle(name: string) {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).replace(/[_-]+/g, " ").trim() || name;
}

/** The document side of EmbeddingGemma 2's retrieval prompt. */
export function documentPrompt(kind: string, fileTitle: string, chunk: Pick<SourceChunk, "title" | "text" | "context">) {
  const title = [fileTitle, chunk.title].map((value) => value.replace(/[|\n]+/g, " ").trim()).filter(Boolean).join(" — ") || "none";
  const context = chunk.context ? `${embeddingText(kind, chunk.context)} ` : "";
  return `title: ${title} | text: ${context}${embeddingText(kind, chunk.text)}`.slice(0, 8000);
}
