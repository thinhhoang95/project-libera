/**
 * Rebuilds clean Markdown from a PDF text selection using page geometry.
 *
 * Browsers flatten a PDF selection into text in content-stream order, which
 * keeps every hard line break, splits hyphenated words, mixes in running
 * headers and page numbers, and can interleave columns. Here the selected
 * runs are put back into reading order from their positions on the page and
 * reassembled into paragraphs, headings, lists and code blocks.
 */

export type PdfLayoutRun = {
  /** Index into the page's pdf.js text items, which equals the TextLayer textDivs index. */
  index: number;
  text: string;
  /** Left edge and baseline in unscaled page units, with y growing downward. */
  x: number;
  y: number;
  width: number;
  /** Font height in page units. */
  size: number;
  bold?: boolean;
  italic?: boolean;
  monospace?: boolean;
  /** Tagged PDFs: the structure element (paragraph, heading, list item) holding this run. */
  block?: number;
  role?: string;
  /** Tagged PDFs: marked as a pagination artifact such as a running header. */
  artifact?: boolean;
};

export type PdfLayoutPage = {
  pageNumber: number;
  width: number;
  height: number;
  runs: PdfLayoutRun[];
};

/** Selected characters [start, end) of one text run. */
export type PdfTextSelection = { pageNumber: number; index: number; start: number; end: number };

type Frame = { id: number; left: number; right: number };

type Line = {
  page: PageLayout;
  runs: PdfLayoutRun[];
  y: number;
  size: number;
  left: number;
  right: number;
  frame: Frame;
};

type PageLayout = {
  source: PdfLayoutPage;
  lines: Line[];
  bodySize: number;
  leading: Map<number, number>;
  pageLeading: number | undefined;
  monospaceBody: boolean;
  tagged: boolean;
};

type Piece = { text: string; bold: boolean; italic: boolean };

type SelectedLine = {
  line: Line;
  pieces: Piece[];
  text: string;
  code: boolean;
  codeText: string;
  /** The whole line is selected, not just part of it. */
  complete: boolean;
};

type BlockKind = "paragraph" | "heading" | "list" | "code";

type Block = {
  lines: SelectedLine[];
  pieces: Piece[];
  kind: BlockKind;
  level: number;
  marker: string;
};

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
};
const SOFT_HYPHEN = "­";
const BULLET = /^([•◦▪▫‣⁃●○■□∙➢➤►▸✓✔])\s*|^([-–—*·])\s+/u;
const ORDERED = /^(\d{1,3})([.)])\s+(?=\S)/u;
const PAGE_NUMBER = /^[-–—\s]*(?:page\s+)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?[-–—\s]*$/iu;
// Prefixes that are kept hyphenated when a compound word breaks at its hyphen.
const HYPHEN_PREFIXES = new Set(["self", "well", "half", "cross", "non"]);
const TAGGED_HEADING = /^H([1-6])$/;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;

export function pdfSelectionToMarkdown(
  pages: ReadonlyMap<number, PdfLayoutPage>,
  selection: readonly PdfTextSelection[],
): string {
  const markdown = selectionMarkdown(pages, selection, false);
  // A selection of only a running header or page number still copies it.
  return markdown || selectionMarkdown(pages, selection, true);
}

function selectionMarkdown(
  pages: ReadonlyMap<number, PdfLayoutPage>,
  selection: readonly PdfTextSelection[],
  keepArtifacts: boolean,
): string {
  const byPage = new Map<number, Map<number, [number, number]>>();

  for (const item of selection) {
    if (item.end <= item.start) continue;
    let ranges = byPage.get(item.pageNumber);
    if (!ranges) byPage.set(item.pageNumber, ranges = new Map());
    const existing = ranges.get(item.index);
    ranges.set(item.index, existing
      ? [Math.min(existing[0], item.start), Math.max(existing[1], item.end)]
      : [item.start, item.end]);
  }

  const lines: SelectedLine[] = [];
  const rowCache = new Map<PdfLayoutPage, Row[]>();

  for (const pageNumber of [...byPage.keys()].sort((a, b) => a - b)) {
    const page = pages.get(pageNumber);
    if (!page) continue;
    const layout = layoutPage(page, pages, keepArtifacts, rowCache);
    const ranges = byPage.get(pageNumber)!;

    for (const line of layout.lines) {
      const selected = selectLine(line, ranges);
      if (selected) lines.push(selected);
    }
  }

  if (!lines.length) return "";

  if (lines.length === 1 && !lines[0].complete) {
    // A phrase from inside one line is copied as inline text, not as a block.
    const only = lines[0];
    return only.code ? inlineCode(only.codeText.trim()) : renderInline(only.pieces, true).trim();
  }

  return renderBlocks(buildBlocks(lines));
}

// ---------------------------------------------------------------------------
// Page layout

function layoutPage(
  page: PdfLayoutPage,
  pages: ReadonlyMap<number, PdfLayoutPage>,
  keepArtifacts: boolean,
  rowCache: Map<PdfLayoutPage, Row[]>,
): PageLayout {
  let runs = page.runs.filter((run) =>
    run.text.trim() &&
    run.size > 0 &&
    Number.isFinite(run.x) &&
    Number.isFinite(run.y) &&
    Number.isFinite(run.width),
  );
  const taggedChars = runs.reduce((sum, run) => sum + (run.block === undefined ? 0 : run.text.length), 0);
  const totalChars = runs.reduce((sum, run) => sum + run.text.length, 0);

  if (!keepArtifacts) {
    const artifacts = detectArtifacts(page, pages, rowCache);
    runs = runs.filter((run) => !run.artifact && !artifacts.has(run));
  }

  const bodySize = weightedMode(runs.map((run) => [Math.round(run.size * 4) / 4, run.text.length])) || 10;
  const monoChars = runs.reduce((sum, run) => sum + (run.monospace ? run.text.length : 0), 0);
  const layout: PageLayout = {
    source: page,
    lines: [],
    bodySize,
    leading: new Map(),
    pageLeading: undefined,
    monospaceBody: monoChars > totalChars / 2,
    tagged: totalChars > 0 && taggedChars / totalChars >= 0.75,
  };

  if (!runs.length) return layout;

  const boxes = runs.map(toBox);
  let frameId = 0;
  const frameOf = (items: Box[]): Frame => ({
    id: frameId++,
    left: Math.min(...items.map((box) => box.left)),
    right: Math.max(...items.map((box) => box.right)),
  });
  const leaves: { boxes: Box[]; frame: Frame }[] = [];
  xyCut(boxes, frameOf(boxes), bodySize, frameOf, leaves);

  for (const leaf of leaves) {
    for (const runsInLine of groupLines(leaf.boxes.map((box) => box.run))) {
      layout.lines.push(makeLine(layout, runsInLine, leaf.frame));
    }
  }

  measureLeading(layout);
  return layout;
}

type Box = { run: PdfLayoutRun; left: number; right: number; top: number; bottom: number };

function toBox(run: PdfLayoutRun): Box {
  // Slightly inside the glyph box, so ordinary leading still reads as a gap.
  return { run, left: run.x, right: run.x + Math.max(run.width, 0), top: run.y - run.size * 0.7, bottom: run.y + run.size * 0.15 };
}

/**
 * Recursive XY-cut. Column gutters are cut first so a two-column region is
 * read column by column; otherwise the region is split at its widest
 * horizontal gap, which separates a full-width title from the columns below.
 */
function xyCut(
  boxes: Box[],
  frame: Frame,
  bodySize: number,
  frameOf: (boxes: Box[]) => Frame,
  leaves: { boxes: Box[]; frame: Frame }[],
) {
  if (boxes.length > 1) {
    const columns = verticalCut(boxes, bodySize);
    if (columns) {
      for (const column of columns) xyCut(column, frameOf(column), bodySize, frameOf, leaves);
      return;
    }

    const bands = horizontalCut(boxes);
    if (bands) {
      for (const band of bands) xyCut(band, frame, bodySize, frameOf, leaves);
      return;
    }
  }

  leaves.push({ boxes, frame });
}

function verticalCut(boxes: Box[], bodySize: number): [Box[], Box[]] | null {
  const top = Math.min(...boxes.map((box) => box.top));
  const bottom = Math.max(...boxes.map((box) => box.bottom));

  if (bottom - top < bodySize * 2.2) return null;

  const sorted = [...boxes].sort((a, b) => a.left - b.left);
  const left = sorted[0].left;
  const right = Math.max(...sorted.map((box) => box.right));
  // Narrow strips such as bullet glyphs or reference labels are not columns.
  const minSide = Math.max(bodySize * 4, (right - left) * 0.15);
  let reach = sorted[0].right;
  let best: { at: number; gap: number } | null = null;

  for (let index = 1; index < sorted.length; index++) {
    const box = sorted[index];
    const gap = box.left - reach;

    if (gap >= bodySize * 0.8 && gap > (best?.gap ?? 0) && reach - left >= minSide && right - box.left >= minSide) {
      best = { at: index, gap };
    }

    reach = Math.max(reach, box.right);
  }

  return best ? [sorted.slice(0, best.at), sorted.slice(best.at)] : null;
}

function horizontalCut(boxes: Box[]): [Box[], Box[]] | null {
  const sorted = [...boxes].sort((a, b) => a.top - b.top);
  let reach = sorted[0].bottom;
  let best: { at: number; gap: number } | null = null;

  for (let index = 1; index < sorted.length; index++) {
    const gap = sorted[index].top - reach;
    if (gap > 0 && gap > (best?.gap ?? 0)) best = { at: index, gap };
    reach = Math.max(reach, sorted[index].bottom);
  }

  return best ? [sorted.slice(0, best.at), sorted.slice(best.at)] : null;
}

/** Groups runs into baseline rows; superscripts and subscripts join their line. */
function groupLines(runs: PdfLayoutRun[]): PdfLayoutRun[][] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { y: number; size: number; runs: PdfLayoutRun[] }[] = [];

  for (const run of sorted) {
    const line = lines.at(-1);

    if (line && Math.abs(run.y - line.y) <= Math.max(run.size, line.size) * 0.45) {
      line.runs.push(run);
      if (run.size > line.size) {
        line.y = run.y;
        line.size = run.size;
      }
    } else {
      lines.push({ y: run.y, size: run.size, runs: [run] });
    }
  }

  return lines.map((line) => line.runs.sort((a, b) => a.x - b.x));
}

function makeLine(page: PageLayout, runs: PdfLayoutRun[], frame: Frame): Line {
  const size = weightedMode(runs.map((run) => [Math.round(run.size * 4) / 4, run.text.length])) || runs[0].size;
  const main = runs.find((run) => Math.abs(run.size - size) < 0.3) ?? runs[0];

  return {
    page,
    runs,
    y: main.y,
    size,
    left: Math.min(...runs.map((run) => run.x)),
    right: Math.max(...runs.map((run) => run.x + run.width)),
    frame,
  };
}

function measureLeading(layout: PageLayout) {
  const byFrame = new Map<number, number[]>();
  const all: number[] = [];

  for (let index = 1; index < layout.lines.length; index++) {
    const previous = layout.lines[index - 1];
    const line = layout.lines[index];
    const delta = line.y - previous.y;

    if (
      line.frame !== previous.frame ||
      !nearlyEqual(line.size, layout.bodySize, 0.1) ||
      !nearlyEqual(previous.size, layout.bodySize, 0.1) ||
      delta < layout.bodySize * 0.5 ||
      delta > layout.bodySize * 2.5
    ) {
      continue;
    }

    let deltas = byFrame.get(line.frame.id);
    if (!deltas) byFrame.set(line.frame.id, deltas = []);
    deltas.push(delta);
    all.push(delta);
  }

  // The lower quartile tracks normal line spacing even when paragraph gaps are common.
  for (const [id, deltas] of byFrame) {
    if (deltas.length >= 2) layout.leading.set(id, quantile(deltas, 0.25));
  }
  layout.pageLeading = all.length ? quantile(all, 0.25) : undefined;
}

function leadingFor(line: Line) {
  const { page } = line;
  if (!nearlyEqual(line.size, page.bodySize, 0.1)) return line.size * 1.25;
  return page.leading.get(line.frame.id) ?? page.pageLeading ?? line.size * 1.25;
}

// ---------------------------------------------------------------------------
// Running headers, footers and page numbers

type Row = { y: number; size: number; text: string; signature: string; runs: PdfLayoutRun[] };

function pageRows(page: PdfLayoutPage, cache: Map<PdfLayoutPage, Row[]>): Row[] {
  const cached = cache.get(page);
  if (cached) return cached;

  const runs = page.runs.filter((run) => run.text.trim() && run.size > 0);
  const rows = groupLines(runs).map((rowRuns) => {
    const text = rowRuns.map((run) => cleanText(run.text).trim()).filter(Boolean).join(" ");
    return {
      y: Math.max(...rowRuns.map((run) => run.y)),
      size: Math.max(...rowRuns.map((run) => run.size)),
      text,
      signature: text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim(),
      runs: rowRuns,
    };
  }).sort((a, b) => a.y - b.y);

  cache.set(page, rows);
  return rows;
}

/**
 * The first and last rows of a page that sit in its outer quarter, either
 * close to the paper edge or set apart from the body by a clear gap.
 */
function marginRows(page: PdfLayoutPage, rows: Row[]) {
  if (rows.length < 3) return [];
  const result: Row[] = [];

  for (const [index, inner] of [[0, 1], [1, 2], [rows.length - 1, rows.length - 2], [rows.length - 2, rows.length - 3]]) {
    const row = rows[index];
    const neighbor = rows[inner];
    if (!row || !neighbor || result.includes(row)) continue;
    const top = index < inner;
    const position = row.y / page.height;
    const edge = top ? row.y - row.size < page.height * 0.12 : position > 0.86;
    const isolated = Math.abs(neighbor.y - row.y) >= Math.max(row.size, neighbor.size) * 1.8;
    if ((top ? position < 0.25 : position > 0.75) && (edge || isolated)) result.push(row);
  }

  return result;
}

/** Rows in the top or bottom margin that are page numbers or repeat on nearby pages. */
function detectArtifacts(
  page: PdfLayoutPage,
  pages: ReadonlyMap<number, PdfLayoutPage>,
  cache: Map<PdfLayoutPage, Row[]>,
): Set<PdfLayoutRun> {
  const artifacts = new Set<PdfLayoutRun>();
  const candidates = marginRows(page, pageRows(page, cache));
  if (!candidates.length) return artifacts;

  const others = [...pages.values()]
    .filter((other) => other !== page)
    .sort((a, b) => Math.abs(a.pageNumber - page.pageNumber) - Math.abs(b.pageNumber - page.pageNumber))
    .slice(0, 8)
    .map((other) => ({ page: other, rows: marginRows(other, pageRows(other, cache)) }));

  for (const row of candidates) {
    const repeated = PAGE_NUMBER.test(row.text) || others.some((other) => other.rows.some((otherRow) =>
      otherRow.signature === row.signature &&
      Math.abs(otherRow.y / other.page.height - row.y / page.height) <= 0.02,
    ));

    if (repeated) {
      for (const run of row.runs) artifacts.add(run);
    }
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// Selected text of one line

function selectLine(line: Line, ranges: Map<number, [number, number]>): SelectedLine | null {
  const pieces: Piece[] = [];
  let codeText = "";
  let previous: PdfLayoutRun | null = null;
  let firstSelected = -1;
  let lastSelected = -1;
  let complete = true;
  const charWidth = averageCharWidth(line.runs) || line.size * 0.6;

  line.runs.forEach((run, position) => {
    const range = ranges.get(run.index);
    if (!range) return;

    const start = Math.max(0, range[0]);
    const end = Math.min(run.text.length, range[1]);
    if (end <= start) return;

    if (firstSelected < 0) firstSelected = position;
    lastSelected = position;
    if (start > 0 && run.text.slice(0, start).trim()) complete = false;
    if (end < run.text.length && run.text.slice(end).trim()) complete = false;

    const text = cleanText(run.text.slice(start, end));

    if (previous) {
      const gap = run.x - (previous.x + previous.width);
      const last = pieces.at(-1)?.text ?? "";
      if (gap > line.size * 0.12 && !/\s$/.test(last) && !/^\s/.test(text)) {
        pieces.push({ text: " ", bold: false, italic: false });
      }
      codeText += " ".repeat(gap > charWidth * 0.5 ? Math.max(1, Math.round(gap / charWidth)) : 0);
    }

    pieces.push({ text, bold: Boolean(run.bold), italic: Boolean(run.italic) });
    codeText += run.text.slice(start, end);
    previous = run;
  });

  if (firstSelected < 0) return null;
  if (firstSelected > 0 || lastSelected < line.runs.length - 1) complete = false;

  const text = pieces.map((piece) => piece.text).join("").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const code = !line.page.monospaceBody && line.runs.every((run) => run.monospace);
  return { line, pieces, text, code, codeText: codeText.replace(/\s+$/, ""), complete };
}

// ---------------------------------------------------------------------------
// Paragraph reconstruction

function buildBlocks(lines: SelectedLine[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const line of lines) {
    if (current && continues(current, current.lines.at(-1)!, line)) {
      if (!current.lines.at(-1)!.code) joinPieces(current.pieces, line.pieces);
      current.lines.push(line);
    } else {
      current = { lines: [line], pieces: [...line.pieces], kind: "paragraph", level: 0, marker: "" };
      blocks.push(current);
    }
  }

  for (const block of blocks) classify(block);
  return blocks;
}

function continues(block: Block, a: SelectedLine, b: SelectedLine): boolean {
  const samePage = a.line.page === b.line.page;
  const sameFlow = samePage && a.line.frame === b.line.frame;
  const size = Math.max(a.line.size, b.line.size);

  if (a.code || b.code) {
    return a.code && b.code && sameFlow && b.line.y - a.line.y > 0 && b.line.y - a.line.y <= leadingFor(a.line) * 2.2;
  }

  // Tagged PDFs know their paragraphs; structure elements are per page in pdf.js.
  if (samePage && a.line.page.tagged) {
    const aBlock = a.line.runs.at(-1)!.block;
    const bBlock = b.line.runs[0].block;
    if (aBlock !== undefined && bBlock !== undefined) return aBlock === bBlock;
  }

  if (!nearlyEqual(a.line.size, b.line.size, 0.12)) return false;
  if (startsListItem(b.text)) return false;

  if (!sameFlow) {
    // Next column or next page: carry on mid-sentence only.
    if (isHeadingSize(a.line) || endsSentence(a.text)) return false;
    return !isShort(a.line) || startsLowercase(b.text);
  }

  const delta = b.line.y - a.line.y;
  if (delta <= size * 0.3 || delta > leadingFor(a.line) * 1.35 + size * 0.1) return false;
  if (isHeadingSize(a.line)) return true;

  const first = block.lines[0];
  if (startsHangingItem(first.text)) {
    // Hanging indent: list items and references continue under their text.
    if (b.line.left > first.line.left + size * 0.3) return true;
    return !isShort(a.line) && !startsBlockish(b.text);
  }

  if (isShort(a.line) && (endsSentence(a.text) || startsBlockish(b.text))) return false;

  // First-line indent starts a new paragraph.
  const indent = b.line.left - a.line.left;
  if (indent > size * 0.8 && b.line.left - b.line.frame.left > size * 0.8 && !isShort(a.line)) return false;

  return true;
}

function isShort(line: Line) {
  const width = line.frame.right - line.frame.left;
  return line.right < line.frame.right - Math.max(line.size * 2.5, width * 0.1);
}

function isHeadingSize(line: Line) {
  return line.size >= line.page.bodySize * 1.12;
}

function endsSentence(text: string) {
  return /[.!?:]["'”’»)\]]*$/u.test(text);
}

function startsLowercase(text: string) {
  return /^\p{Ll}/u.test(text);
}

function startsBlockish(text: string) {
  return /^[\p{Lu}\d"“'‘(\[]/u.test(text) || startsListItem(text);
}

function startsListItem(text: string) {
  return BULLET.test(text) || ORDERED.test(text);
}

/** List items and reference entries such as "[12]" wrap with a hanging indent. */
function startsHangingItem(text: string) {
  return startsListItem(text) || /^(?:\[[\w.,\- ]{1,16}\]|\(\d{1,3}\))\s/u.test(text);
}

/** Appends a line to a paragraph, repairing the break between them. */
function joinPieces(pieces: Piece[], next: Piece[]) {
  trimPieces(pieces, "end");
  const following = [...next];
  trimPieces(following, "start");
  const last = pieces.at(-1);
  const first = following[0];

  if (!last || !first) {
    pieces.push(...following);
    return;
  }

  // The hyphen is sometimes a text run of its own, so look at the joined tail.
  const before = pieces.slice(-4).map((piece) => piece.text).join("");
  const after = first.text;
  const lastWord = before.slice(before.lastIndexOf(" ") + 1);
  let separator = " ";

  if (before.endsWith(SOFT_HYPHEN)) {
    last.text = last.text.slice(0, -1);
    separator = "";
  } else if (/\p{L}[-‐]$/u.test(before)) {
    const stem = lastWord.slice(0, -1);
    separator = "";
    const keepHyphen =
      !/^\p{Ll}/u.test(after) ||
      /[-‐]/u.test(stem) ||
      HYPHEN_PREFIXES.has(stem.toLowerCase()) ||
      isUrlLike(lastWord);
    if (!keepHyphen) last.text = last.text.slice(0, -1);
  } else if (isUrlLike(lastWord) && /[/\-_.=&?#~]$/.test(lastWord) && !/^\s/.test(after)) {
    separator = "";
  } else if (CJK.test(before.at(-1) ?? "") && CJK.test(after[0])) {
    separator = "";
  }

  if (separator) pieces.push({ text: separator, bold: false, italic: false });
  pieces.push(...following);
}

function trimPieces(pieces: Piece[], side: "start" | "end") {
  while (pieces.length) {
    const index = side === "start" ? 0 : pieces.length - 1;
    const text = side === "start" ? pieces[index].text.replace(/^\s+/, "") : pieces[index].text.replace(/\s+$/, "");
    if (text) {
      pieces[index] = { ...pieces[index], text };
      return;
    }
    pieces.splice(index, 1);
  }
}

function isUrlLike(word: string) {
  return /^(?:https?:\/\/|www\.)\S+/i.test(word) || /^\S+@\S+\.\S+/.test(word);
}

function classify(block: Block) {
  const first = block.lines[0];
  const page = first.line.page;
  const text = block.lines.map((line) => line.text).join(" ");
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const role = page.tagged ? first.line.runs[0].role : undefined;
  const tagLevel = role ? TAGGED_HEADING.exec(role) : null;

  if (block.lines.every((line) => line.code)) {
    block.kind = "code";
    return;
  }

  if (letters >= 2 && text.length <= 300 && (tagLevel || role === "Title" || role === "H")) {
    block.kind = "heading";
    block.level = tagLevel ? Number(tagLevel[1]) : role === "Title" ? 1 : 2;
    return;
  }

  const ratio = first.line.size / page.bodySize;
  if (ratio >= 1.12 && block.lines.length <= 3 && letters >= 2 && text.length <= 200) {
    block.kind = "heading";
    block.level = ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : 3;
    return;
  }

  const allBold = block.lines.every((line) => line.line.runs.every((run) => run.bold || !/\p{L}/u.test(run.text)));
  if (
    block.lines.length === 1 &&
    allBold &&
    first.complete &&
    ratio >= 0.95 &&
    letters >= 2 &&
    text.split(/\s+/).length <= 12 &&
    !/[.,;]$/.test(text) &&
    isShort(first.line)
  ) {
    block.kind = "heading";
    block.level = 4;
    return;
  }

  const bullet = BULLET.exec(text);
  const ordered = ORDERED.exec(text);
  if (bullet || ordered || (page.tagged && role === "LI")) {
    block.kind = "list";
    block.marker = ordered ? `${ordered[1]}${ordered[2]}` : "-";
    if (bullet || ordered) stripPrefix(block.pieces, (bullet ?? ordered)![0].length);
  }
}

/** Removes the first `length` visible characters (a list marker) from the pieces. */
function stripPrefix(pieces: Piece[], length: number) {
  trimPieces(pieces, "start");
  let remaining = length;

  while (remaining > 0 && pieces.length) {
    const text = pieces[0].text;
    if (text.length <= remaining) {
      remaining -= text.length;
      pieces.shift();
    } else {
      pieces[0] = { ...pieces[0], text: text.slice(remaining) };
      remaining = 0;
    }
  }

  trimPieces(pieces, "start");
}

// ---------------------------------------------------------------------------
// Markdown output

function renderBlocks(blocks: Block[]): string {
  let output = "";
  let previous: Block | null = null;

  for (const block of blocks) {
    const markdown = renderBlock(block);
    if (!markdown) continue;
    if (previous) {
      const tight = previous.kind === "list" && block.kind === "list" &&
        (previous.marker === "-") === (block.marker === "-");
      output += tight ? "\n" : "\n\n";
    }
    output += markdown;
    previous = block;
  }

  return output.trim();
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case "code": {
      const charWidth = averageCharWidth(block.lines.flatMap((line) => line.line.runs)) || block.lines[0].line.size * 0.6;
      const left = Math.min(...block.lines.map((line) => line.line.left));
      const body = block.lines
        .map((line) => " ".repeat(Math.max(0, Math.round((line.line.left - left) / charWidth))) + line.codeText)
        .join("\n");
      const fence = body.includes("```") ? "~~~" : "```";
      return `${fence}\n${body}\n${fence}`;
    }
    case "heading": {
      const text = escapeInline(plainText(block.pieces));
      return text ? `${"#".repeat(block.level)} ${text}` : "";
    }
    case "list": {
      const text = renderInline(block.pieces, false);
      return text ? `${block.marker} ${text}` : "";
    }
    default:
      return renderInline(block.pieces, true);
  }
}

function plainText(pieces: Piece[]) {
  return pieces.map((piece) => piece.text).join("").replace(/\s+/g, " ").trim();
}

/** Renders text with bold and italic runs, escaping Markdown syntax. */
function renderInline(input: Piece[], escapeStart: boolean): string {
  const pieces = mergePieces(input);
  const letters = (piece: Piece) => (piece.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const total = pieces.reduce((sum, piece) => sum + letters(piece), 0);
  const boldShare = pieces.reduce((sum, piece) => sum + (piece.bold ? letters(piece) : 0), 0) / (total || 1);
  const italicShare = pieces.reduce((sum, piece) => sum + (piece.italic ? letters(piece) : 0), 0) / (total || 1);
  // A uniformly styled paragraph is its base style, not emphasis.
  const useBold = boldShare < 0.85;
  const useItalic = italicShare < 0.85;
  let output = "";
  let endedWithMarker = false;

  pieces.forEach((piece, index) => {
    const escaped = escapeInline(piece.text);
    const marker = piece.bold && useBold ? "**" : piece.italic && useItalic ? "*" : "";
    const leading = /^\s*/.exec(escaped)![0];
    const trailing = /\s*$/.exec(escaped)![0];
    const core = escaped.slice(leading.length, escaped.length - trailing.length);
    const before = output.at(-1) ?? (leading ? " " : "");
    const after = trailing ? " " : pieces[index + 1]?.text[0] ?? "";

    if (marker && core && /[\p{L}\p{N}]/u.test(core) && canEmphasize(core, leading ? " " : before, after) && !(endedWithMarker && !leading)) {
      output += `${leading}${marker}${core}${marker}${trailing}`;
      endedWithMarker = !trailing;
    } else {
      output += escaped;
      endedWithMarker = false;
    }
  });

  output = output.replace(/\s+/g, " ").trim();
  return escapeStart ? escapeBlockStart(output) : output;
}

function mergePieces(pieces: Piece[]): Piece[] {
  const merged: Piece[] = [];

  pieces.forEach((piece, index) => {
    let style = piece;
    if (!piece.text.trim()) {
      // Spaces take the style of the text around them when it matches.
      const previous = merged.at(-1);
      const next = pieces.slice(index + 1).find((candidate) => candidate.text.trim());
      style = previous && next && previous.bold === next.bold && previous.italic === next.italic
        ? { ...piece, bold: previous.bold, italic: previous.italic }
        : { ...piece, bold: false, italic: false };
    }

    const last = merged.at(-1);
    if (last && last.bold === style.bold && last.italic === style.italic) {
      last.text += style.text;
    } else {
      merged.push({ ...style });
    }
  });

  return merged;
}

/** CommonMark only treats `*` as emphasis when it is left- and right-flanking. */
function canEmphasize(core: string, before: string, after: string) {
  const punctuation = /[\p{P}\p{S}]/u;
  const loose = (char: string) => !char || /\s/.test(char) || punctuation.test(char);
  if (punctuation.test(core[0]) && !loose(before)) return false;
  if (punctuation.test(core.at(-1)!) && !loose(after)) return false;
  return true;
}

function escapeInline(text: string): string {
  return text
    .replace(/[\\`*$]/g, "\\$&")
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (match) => match.replace("_", "\\_"))
    .replace(/<(?=[A-Za-z/!?])/g, "\\<")
    .replace(/\[(?=[^\]]*\][([:])/g, "\\[")
    .replace(/~~/g, "\\~\\~")
    .replace(/==/g, "\\=\\=");
}

function escapeBlockStart(text: string) {
  return text
    .replace(/^(#{1,6})(?=\s|$)/, "\\$1")
    .replace(/^([>+-])(?=\s|$)/, "\\$1")
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
}

function inlineCode(text: string) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((ticks) => ticks.length));
  const fence = "`".repeat(longest + 1);
  return text.startsWith("`") || text.endsWith("`") ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

// ---------------------------------------------------------------------------
// Helpers

function cleanText(text: string) {
  return text
    .replace(/[ﬀ-ﬆ]/g, (char) => LIGATURES[char] ?? char)
    .replace(/[​-‍﻿]/g, "")
    .replace(/­(?=.)/g, "")
    .replace(/[\s ]+/g, " ");
}

function averageCharWidth(runs: PdfLayoutRun[]) {
  let width = 0;
  let chars = 0;
  for (const run of runs) {
    if (run.text.length && run.width > 0) {
      width += run.width;
      chars += run.text.length;
    }
  }
  return chars ? width / chars : 0;
}

function weightedMode(values: [number, number][]) {
  const weights = new Map<number, number>();
  for (const [value, weight] of values) weights.set(value, (weights.get(value) ?? 0) + weight);
  let best = 0;
  let bestWeight = -1;
  for (const [value, weight] of weights) {
    if (weight > bestWeight) {
      best = value;
      bestWeight = weight;
    }
  }
  return best;
}

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

function nearlyEqual(a: number, b: number, tolerance: number) {
  return Math.abs(a - b) <= Math.max(a, b) * tolerance;
}
