import { syntaxTree } from "@codemirror/language";
import { Facet, RangeSetBuilder, type EditorState, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { MARKDOWN_BOX_PREFIX } from "@/lib/markdown-boxes";
import { getMarkdownHighlightColorByShortcut, MARKDOWN_DEFAULT_HIGHLIGHT_COLOR } from "@/lib/markdown-colors";
import { escapedAt, mathMarkerPairs, type MathMarkerPair, type MathMarkerSettings } from "@/lib/math-markers";
import { scanCitations } from "@/lib/references/citation-syntax";
import type { CitationOccurrence } from "@/lib/references/types";

/* Libera's own Markdown syntax, decorated in the CodeMirror Source editor.
 *
 * CommonMark/GFM structure comes from @codemirror/lang-markdown. On top of it,
 * Libera adds text colours, colour-prefixed highlights, coloured boxes, math
 * with configurable markers, underlines and numeric text-style spans. The
 * scanner below is pure (it works on strings), so it is tested without a view;
 * the view plugin feeds it the visible blocks and skips code. */

export type LiberaSyntaxKind =
  | "box"
  | "citation"
  | "color"
  | "highlight"
  | "math"
  | "text-style"
  | "underline";

export type LiberaSyntaxMatch = {
  kind: LiberaSyntaxKind;
  /** The whole construct, markers included. */
  from: number;
  to: number;
  /** The text between the markers. */
  contentFrom: number;
  contentTo: number;
  /** Text colour (`color`), box/highlight colour, or none. */
  color?: string;
  /** Readable foreground for a highlight colour. */
  foreground?: string;
  /** Font size / line height of a text-style span, for its tooltip. */
  title?: string;
};

const COLOR_PATTERN = /\[color=(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))\]([\s\S]*?)\[\/color\]/g;
const HIGHLIGHT_PATTERN = /([yroagtbvps])?>>>([\s\S]+?)<<<|==([^=\n]+)==/gi;
const UNDERLINE_PATTERN = /<u>([\s\S]*?)<\/u>/g;
const TEXT_STYLE_PATTERN = /<span\s+(data-(?:font-size|line-height)="[^"]*"(?:\s+data-(?:font-size|line-height)="[^"]*")?)\s*>([\s\S]*?)<\/span>/g;
// Constructs never cross a blank line: that ends the paragraph in Markdown.
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

type Span = { from: number; to: number };

const overlaps = (spans: Span[], from: number, to: number) => spans.some((span) => from < span.to && to > span.from);

/** Math delimited by any configured marker pair, starting at `index`. Single-
 * character markers (`$`) stay on one line; longer ones (`$$`, `\[`) may span
 * lines, as the preview's block math does. */
function matchMathAt(text: string, index: number, pairs: MathMarkerPair[]) {
  if (escapedAt(text, index)) return null;
  for (const pair of pairs) {
    if (!text.startsWith(pair.open, index)) continue;
    let close = index + pair.open.length;
    while ((close = text.indexOf(pair.close, close)) >= 0) {
      if (escapedAt(text, close)) {
        close += pair.close.length;
        continue;
      }
      const inner = text.slice(index + pair.open.length, close);
      if (!inner.trim()) break;
      if (inner.includes("\n") && pair.open.length === 1 && !pair.display) break;
      if (PARAGRAPH_BREAK.test(inner)) break;
      return { open: pair.open, close: pair.close, end: close + pair.close.length };
    }
  }
  return null;
}

function scanMath(text: string, offset: number, pairs: MathMarkerPair[], skip: Span[]) {
  const matches: LiberaSyntaxMatch[] = [];
  const openers = new Set(pairs.map((pair) => pair.open[0]));
  for (let index = 0; index < text.length; index++) {
    if (!openers.has(text[index]) || overlaps(skip, offset + index, offset + index + 1)) continue;
    const match = matchMathAt(text, index, pairs);
    if (!match || overlaps(skip, offset + index, offset + match.end)) continue;
    matches.push({
      kind: "math",
      from: offset + index,
      to: offset + match.end,
      contentFrom: offset + index + match.open.length,
      contentTo: offset + match.end - match.close.length,
    });
    index = match.end - 1;
  }
  return matches;
}

/** Libera's inline constructs in `text`, which starts at document offset
 * `offset`. `skip` lists code ranges (inline code, fences) to leave alone. */
export function scanLiberaInline(
  text: string,
  offset = 0,
  options: { mathMarkers?: MathMarkerSettings; mathPairs?: MathMarkerPair[]; skip?: Span[] } = {},
): LiberaSyntaxMatch[] {
  const skip = options.skip ?? [];
  const math = scanMath(text, offset, options.mathPairs ?? mathMarkerPairs(options.mathMarkers), skip);
  // Math content is LaTeX: colour or highlight markers inside it are not Libera syntax.
  const blocked = [...skip, ...math];
  const matches: LiberaSyntaxMatch[] = [...math];
  const collect = (pattern: RegExp, build: (match: RegExpExecArray, from: number, to: number) => LiberaSyntaxMatch | null) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const from = offset + match.index;
      const to = from + match[0].length;
      if (PARAGRAPH_BREAK.test(match[0]) || overlaps(blocked, from, to)) {
        pattern.lastIndex = match.index + 1;
        continue;
      }
      const built = build(match, from, to);
      if (built) matches.push(built);
    }
  };
  collect(COLOR_PATTERN, (match, from, to) => {
    const contentFrom = from + match[0].indexOf("]") + 1;
    return { kind: "color", from, to, contentFrom, contentTo: to - "[/color]".length, color: match[1] };
  });
  collect(HIGHLIGHT_PATTERN, (match, from, to) => {
    const shortcut = match[1];
    const color = (shortcut ? getMarkdownHighlightColorByShortcut(shortcut) : undefined) ?? MARKDOWN_DEFAULT_HIGHLIGHT_COLOR;
    if (match[3] !== undefined) return { kind: "highlight", from, to, contentFrom: from + 2, contentTo: to - 2, color: MARKDOWN_DEFAULT_HIGHLIGHT_COLOR.value, foreground: MARKDOWN_DEFAULT_HIGHLIGHT_COLOR.foreground };
    const open = (shortcut ?? "").length + 3;
    return { kind: "highlight", from, to, contentFrom: from + open, contentTo: to - 3, color: color.value, foreground: color.foreground };
  });
  collect(UNDERLINE_PATTERN, (_match, from, to) => ({ kind: "underline", from, to, contentFrom: from + 3, contentTo: to - 4 }));
  collect(TEXT_STYLE_PATTERN, (match, from, to) => {
    const fontSize = /data-font-size="(\d+(?:\.\d+)?)"/.exec(match[1])?.[1];
    const lineHeight = /data-line-height="(\d+(?:\.\d+)?)"/.exec(match[1])?.[1];
    const title = [fontSize ? `Font size ${fontSize}px` : "", lineHeight ? `Line spacing ${lineHeight}` : ""].filter(Boolean).join(", ");
    const contentFrom = from + match[0].indexOf(">") + 1;
    return { kind: "text-style", from, to, contentFrom, contentTo: to - "</span>".length, title: title || undefined };
  });
  return matches.sort((a, b) => a.from - b.from || b.to - a.to);
}

/** A coloured box line (`y> text`), as the renderer and the textarea overlay
 * recognise it. Plain `>` quotes are left to the Markdown grammar. */
export function scanLiberaBoxLine(lineText: string, lineFrom = 0): LiberaSyntaxMatch | null {
  const match = MARKDOWN_BOX_PREFIX.exec(lineText);
  if (!match) return null;
  const color = getMarkdownHighlightColorByShortcut(match[1]);
  if (!color) return null;
  return {
    kind: "box",
    from: lineFrom,
    to: lineFrom + lineText.length,
    contentFrom: lineFrom + match[0].length,
    contentTo: lineFrom + lineText.length,
    color: color.value,
  };
}

// Decorations ----------------------------------------------------------------

/** The math markers used to recognise equations (Preferences → Markdown). */
export const liberaMathMarkers = Facet.define<MathMarkerSettings, MathMarkerSettings>({
  combine: (values) => values.at(-1) ?? {},
});

// Citations ------------------------------------------------------------------

/** Documents larger than this are scanned for citations after a pause in typing (see citations.ts). */
export const CITATION_SYNC_SCAN_LIMIT = 100_000;

let citationScans = 0;
const citationCache = new WeakMap<Text, { markers: MathMarkerSettings; citations: CitationOccurrence[] }>();

/** How many times a document version was scanned for citations (tests). */
export function liberaCitationScanCount() {
  return citationScans;
}

/** The document's citations, from the shared scanner (citation-syntax.ts), scanned once per
 * document version and math-marker setting. With `compute: false`, only an earlier scan of
 * this exact version is returned (null when there is none). */
export function liberaCitations(state: EditorState, { compute = true }: { compute?: boolean } = {}): CitationOccurrence[] | null {
  const markers = state.facet(liberaMathMarkers);
  const cached = citationCache.get(state.doc);
  if (cached && cached.markers === markers) return cached.citations;
  if (!compute) return null;
  citationScans += 1;
  const text = state.doc.toString();
  const citations = text.includes("@") ? scanCitations(text, { mathMarkers: markers }) : [];
  citationCache.set(state.doc, { markers, citations });
  return citations;
}

/** The citation containing `pos` (`start <= pos < end`), or null. */
export function liberaCitationAt(state: EditorState, pos: number) {
  const citations = liberaCitations(state) ?? [];
  let low = 0;
  let high = citations.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (citations[mid].end <= pos) low = mid + 1; else high = mid;
  }
  const found = citations[low];
  return found && found.start <= pos ? found : null;
}

const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode", "CommentBlock", "ProcessingInstructionBlock", "HTMLBlock"]);
const HEADING_NODE = /^(?:ATX|Setext)Heading([1-6])$/;
const marker = Decoration.mark({ class: "cm-libera-marker" });
const underline = Decoration.mark({ class: "cm-libera-underline" });
const math = Decoration.mark({ class: "cm-libera-math" });
const quoteLine = Decoration.line({ class: "cm-md-quote" });
const headingLines = [1, 2, 3, 4].map((level) => Decoration.line({ class: `cm-md-heading cm-md-heading-${level}` }));

export type LiberaLineTone = "heading-1" | "heading-2" | "heading-3" | "heading-4" | "quote" | "box";

/** Line tones and Libera constructs for one stretch of the document, as plain
 * data, so tests can check what the decorations recognise. */
export function analyzeLiberaSyntax(state: EditorState, from = 0, to = state.doc.length) {
  const tree = syntaxTree(state);
  const doc = state.doc;
  const start = doc.lineAt(Math.max(0, Math.min(from, doc.length))).from;
  const end = doc.lineAt(Math.max(0, Math.min(to, doc.length))).to;
  const code: Span[] = [];
  const headings = new Map<number, number>();
  const quotes = new Set<number>();
  tree.iterate({
    from: start,
    to: end,
    enter(node) {
      if (CODE_NODES.has(node.name)) {
        code.push({ from: node.from, to: node.to });
        return false;
      }
      const heading = HEADING_NODE.exec(node.name);
      if (heading) {
        for (let pos = node.from; pos <= node.to;) {
          const line = doc.lineAt(pos);
          headings.set(line.from, Math.min(4, Number(heading[1])));
          pos = line.to + 1;
        }
      }
      if (node.name === "QuoteMark") quotes.add(doc.lineAt(node.from).from);
      return undefined;
    },
  });
  const lines: { from: number; tone: LiberaLineTone; color?: string }[] = [];
  const boxes: LiberaSyntaxMatch[] = [];
  for (let pos = start; pos <= end;) {
    const line = doc.lineAt(pos);
    const inCode = overlaps(code, line.from, Math.max(line.to, line.from + 1));
    const box = inCode ? null : scanLiberaBoxLine(line.text, line.from);
    const level = headings.get(line.from);
    if (box) {
      boxes.push(box);
      lines.push({ from: line.from, tone: "box", color: box.color });
    } else if (level) lines.push({ from: line.from, tone: `heading-${level}` as LiberaLineTone });
    else if (quotes.has(line.from)) lines.push({ from: line.from, tone: "quote" });
    pos = line.to + 1;
  }
  const inline: LiberaSyntaxMatch[] = [];
  const pairs = mathMarkerPairs(state.facet(liberaMathMarkers));
  for (const block of topLevelBlocks(tree, start, end, doc.length)) {
    if (code.some((span) => span.from <= block.from && span.to >= block.to)) continue;
    inline.push(...scanLiberaInline(doc.sliceString(block.from, block.to), block.from, { mathPairs: pairs, skip: code }));
  }
  // Citations are drawn by citations.ts; a large document waits for its scan there.
  const citations = liberaCitations(state, { compute: doc.length <= CITATION_SYNC_SCAN_LIMIT }) ?? [];
  for (const citation of citations) {
    if (citation.end < start) continue;
    if (citation.start > end) break;
    inline.push({ kind: "citation", from: citation.start, to: citation.end, contentFrom: citation.start, contentTo: citation.end });
  }
  inline.sort((a, b) => a.from - b.from || b.to - a.to);
  return { boxes, code, inline, lines };
}

/** Whole top-level Markdown blocks overlapping [from, to], so a construct that
 * starts above the viewport (a long equation) is still seen whole. Text the
 * parser has not reached yet is scanned as one block. */
function topLevelBlocks(tree: Tree, from: number, to: number, length: number): Span[] {
  const blocks: Span[] = [];
  let child: SyntaxNode | null = tree.topNode.firstChild;
  while (child) {
    if (child.to >= from && child.from <= to) blocks.push({ from: child.from, to: child.to });
    if (child.from > to) break;
    child = child.nextSibling;
  }
  if (tree.length < to) blocks.push({ from: Math.max(from, tree.length), to: Math.min(length, to) });
  return blocks.length ? blocks : [{ from, to }];
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const visible of view.visibleRanges) {
    const { boxes, inline, lines } = analyzeLiberaSyntax(view.state, visible.from, visible.to);
    for (const line of lines) {
      if (line.tone === "box") {
        ranges.push(Decoration.line({ class: "cm-libera-box", attributes: { style: `--libera-box-color: ${line.color}` } }).range(line.from));
      } else if (line.tone === "quote") {
        ranges.push(quoteLine.range(line.from));
      } else {
        ranges.push(headingLines[Number(line.tone.slice(-1)) - 1].range(line.from));
      }
    }
    for (const box of boxes) if (box.contentFrom > box.from) ranges.push(marker.range(box.from, box.contentFrom));
    for (const match of inline) {
      if (match.contentFrom > match.from) ranges.push(marker.range(match.from, match.contentFrom));
      if (match.to > match.contentTo) ranges.push(marker.range(match.contentTo, match.to));
      if (match.contentTo <= match.contentFrom) continue;
      const content = (() => {
        switch (match.kind) {
          case "color": return Decoration.mark({ class: "cm-libera-color", attributes: { style: `color: ${match.color}` } });
          case "highlight": return Decoration.mark({ class: "cm-libera-highlight", attributes: { style: `--libera-highlight-color: ${match.color}` } });
          case "underline": return underline;
          case "math": return math;
          case "text-style": return Decoration.mark({ class: "cm-libera-text-style", attributes: match.title ? { title: match.title } : {} });
          default: return null;
        }
      })();
      if (content) ranges.push(content.range(match.contentFrom, match.contentTo));
    }
  }
  // Ranges from two visible stretches can repeat a block; dedupe while sorting.
  const builder = new RangeSetBuilder<Decoration>();
  const seen = new Set<string>();
  ranges
    .sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide || a.to - b.to)
    .forEach((range) => {
      const key = `${range.from}:${range.to}:${(range.value.spec as { class?: string }).class}:${JSON.stringify((range.value.spec as { attributes?: unknown }).attributes ?? null)}`;
      if (seen.has(key)) return;
      seen.add(key);
      builder.add(range.from, range.to, range.value);
    });
  return builder.finish();
}

const liberaSyntaxPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }
  update(update: ViewUpdate) {
    if (
      update.docChanged || update.viewportChanged ||
      syntaxTree(update.startState) !== syntaxTree(update.state) ||
      update.startState.facet(liberaMathMarkers) !== update.state.facet(liberaMathMarkers)
    ) this.decorations = buildDecorations(update.view);
  }
}, { decorations: (plugin) => plugin.decorations });

/** Colours drawn from the app's theme variables, so light and dark follow the
 * same tokens as the textarea overlay and the LaTeX editor. */
const liberaSyntaxTheme = EditorView.baseTheme({
  ".cm-md-heading": { fontWeight: "600" },
  ".cm-md-heading-1": { color: "var(--markdown-editor-heading-1)" },
  ".cm-md-heading-2": { color: "var(--markdown-editor-heading-2)" },
  ".cm-md-heading-3": { color: "var(--markdown-editor-heading-3)" },
  ".cm-md-heading-4": { color: "var(--markdown-editor-heading-4)" },
  ".cm-md-quote": {
    color: "var(--markdown-editor-blockquote)",
    boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--muted-foreground) 45%, transparent)",
  },
  ".cm-libera-box": {
    color: "var(--markdown-editor-blockquote)",
    background: "color-mix(in srgb, var(--libera-box-color) 12%, transparent)",
    boxShadow: "inset 3px 0 0 var(--libera-box-color)",
  },
  ".cm-libera-marker": { opacity: "0.55" },
  ".cm-libera-highlight": {
    background: "color-mix(in srgb, var(--libera-highlight-color) 38%, transparent)",
    borderRadius: "2px",
  },
  ".cm-libera-underline": { textDecoration: "underline", textUnderlineOffset: "3px" },
  ".cm-libera-math": { color: "var(--latex-math, #0e7490)" },
  ".cm-libera-text-style": { textDecoration: "underline dotted", textUnderlineOffset: "3px" },
});

/** Decorations for Libera's Markdown extensions, with the configured math markers. */
export function liberaSyntax(mathMarkers: MathMarkerSettings = {}): Extension {
  return [liberaMathMarkers.of(mathMarkers), liberaSyntaxPlugin, liberaSyntaxTheme];
}
