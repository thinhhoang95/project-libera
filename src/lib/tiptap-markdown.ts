import { Extension, mergeAttributes, textblockTypeInputRule, type JSONContent, type NodeViewRenderer } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Marked, type marked } from "marked";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Highlight from "@tiptap/extension-highlight";
import Underline from "@tiptap/extension-underline";
import Image from "@tiptap/extension-image";
import { TextStyle, FontSize, LineHeight, Color } from "@tiptap/extension-text-style";
import { TableKit, Table, TableView, renderTableToMarkdown } from "@tiptap/extension-table";
import { DOMSerializer, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { ListItem, OrderedList, TaskList, TaskItem } from "@tiptap/extension-list";
import Link from "@tiptap/extension-link";
import { MARKDOWN_HIGHLIGHT_COLORS } from "./markdown-colors";
import { markdownTextStyleAttributes } from "./markdown-text-styles";
import { LiberaBlockquote } from "./tiptap-boxes";
import { CitationNode, CITATION_NODE_NAME } from "./tiptap-citation";
import { FrontMatterNode } from "./tiptap-front-matter";
import { applyTableWidthsToJson, readTableWidths } from "./table-widths";
import { TiptapTableWidths, tableColumnWidths } from "./tiptap-table-widths";
import { FootnoteDefinition, FootnoteReference } from "./tiptap-footnotes";
import { Superscript, Subscript } from "./tiptap-scripts";
import { mathMarkerPairs, matchMath, type MathMarkerPair } from "./math-markers";

/** The `y>>>` … `<<<` delimiters of a highlight in the given color. */
export function highlightMarkdownOpening(color: unknown) {
  return `${MARKDOWN_HIGHLIGHT_COLORS.find((item) => item.value === color)?.shortcut ?? "y"}>>>`;
}

/**
 * Tiptap's serializer closes every mark around an inline atom, so highlighted
 * math is written as its own run (see tiptap-math.ts). Joins the seams it
 * leaves between runs of one color: `y>>>a <<<y>>>$x$<<<y>>> b<<<` becomes
 * `y>>>a $x$ b<<<`.
 */
export function mergeHighlightSeams(markdown: string) {
  if (!markdown.includes("<<<")) return markdown;
  let previous;
  do {
    previous = markdown;
    markdown = markdown.replace(/([yroagtbvps])>>>((?:(?!<<<)[\s\S])*?)<<<\1>>>/g, "$1>>>$2");
  } while (markdown !== previous);
  return markdown;
}

// Inline math takes the highlight too, so a highlighted formula has no hole.
function applyHighlight(content: JSONContent[], color: string): JSONContent[] {
  return content.map((node) => node.type === "text" || node.type === "inlineMath"
    ? { ...node, marks: [...(node.marks ?? []), { type: "highlight", attrs: { color } }] }
    : node.content ? { ...node, content: applyHighlight(node.content, color) } : node);
}

const LiberaHighlight = Highlight.extend({
  renderHTML({ HTMLAttributes }) {
    const color = MARKDOWN_HIGHLIGHT_COLORS.find((item) => item.value === HTMLAttributes["data-color"]);
    return ["mark", mergeAttributes(HTMLAttributes, { style: `color: ${color?.foreground ?? "inherit"}` }), 0];
  },
  renderMarkdown(node, h) {
    return `${highlightMarkdownOpening(node.attrs?.color)}${h.renderChildren(node)}<<<`;
  },
  parseMarkdown(token, h) {
    const color = MARKDOWN_HIGHLIGHT_COLORS.find((item) => item.shortcut === token.color);
    return applyHighlight(h.parseInline(token.tokens ?? []), color?.value ?? "#fef08a");
  },
  markdownTokenizer: {
    name: "highlight",
    level: "inline",
    start: (src) => src.search(/(?:[yroagtbvps])?>>>|==/),
    tokenize(src, _, h) {
      const match = /^(?:([yroagtbvps])?>>>([\s\S]+?)<<<|==([^=]+)==)/.exec(src);
      if (!match) return;
      return { type: "highlight", raw: match[0], color: match[1] ?? "y", tokens: h.inlineTokens(match[2] ?? match[3]) };
    },
  },
}).configure({ multicolor: true });

// Tiptap writes a literal `[` as `\[`, which with `\]` is Libera's display-math
// marker (a configured marker may start the same way): a paragraph `[TODO]`
// came back as math. Text brackets are written as this stand-in first; once the
// document is written, each one that would open math there becomes `&#91;`.
const BRACKET = "";
// What may precede a block's first character on its line: quote and list markers.
const LINE_START = /^[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]+|>)*(?:\[[ xX]\][ \t]+)?$/;

export function guardLiteralBrackets(markdown: string, pairs: MathMarkerPair[]) {
  if (!markdown.includes(BRACKET)) return markdown;
  const full = markdown.replaceAll(BRACKET, "\\[");
  let out = "";
  let from = 0;
  let shift = 0;
  for (let at = markdown.indexOf(BRACKET); at >= 0; at = markdown.indexOf(BRACKET, at + 1)) {
    const index = at + shift++;
    const rest = full.slice(index);
    const lineStart = full.lastIndexOf("\n", index - 1) + 1;
    const opens = matchMath(rest, pairs, false) ?? (LINE_START.test(full.slice(lineStart, index)) ? matchMath(rest, pairs, true) : undefined);
    out += markdown.slice(from, at) + (opens ? "&#91;" : "\\[");
    from = at + 1;
  }
  return out + markdown.slice(from);
}

/** A parsed document with the column widths its macro block names (table-widths.ts). */
function withStatedTableWidths(json: JSONContent, markdown: string) {
  return applyTableWidthsToJson(json, readTableWidths(markdown));
}

const LiberaMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    const initial = this.editor.options.content;
    this.parent?.(event);
    const manager = this.storage.manager;
    // Tables take their widths from the macro block wherever a whole document
    // is read: the initial content (already parsed above) and setContent.
    if (typeof initial === "string" && this.editor.options.content !== initial && typeof this.editor.options.content === "object" && this.editor.options.content) {
      this.editor.options.content = withStatedTableWidths(this.editor.options.content as JSONContent, initial);
    }
    const parse = manager.parse.bind(manager);
    manager.parse = (markdown) => withStatedTableWidths(parse(markdown), markdown);
    const serialize = manager.serialize.bind(manager);
    // The math extensions publish the configured markers (tiptap-math.ts).
    const pairs = () => ((this.editor?.storage as unknown as Record<string, { markerPairs?: MathMarkerPair[] } | undefined> | undefined)?.inlineMath?.markerPairs) ?? mathMarkerPairs();
    manager.serialize = (content) => {
      serializingSchema = this.editor?.schema ?? null;
      try {
        return guardLiteralBrackets(mergeHighlightSeams(serialize(content)), pairs());
      } finally {
        serializingSchema = null;
      }
    };
    // A backslash only escapes punctuation, so `\fset` or `\theorem{…}` (Markdown
    // macros, markdown-macros.ts) is written as typed instead of as `\\fset`.
    const escaping = manager as unknown as { escapeMarkdownSyntax(text: string): string };
    const escape = escaping.escapeMarkdownSyntax.bind(manager);
    escaping.escapeMarkdownSyntax = (text) => escape(text.replaceAll("[", BRACKET)).replace(/\\\\(?=[A-Za-z])/g, "\\");
  },
});

/** The `#hex` a `[color=…]` tag can hold: `rgb()`/`rgba()` (pasted HTML) is converted, any other color (names, hsl) has no tag and is dropped. */
export function markdownColor(value: unknown) {
  const color = String(value ?? "").trim();
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) return color;
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(color);
  if (!rgb) return null;
  const channel = (part: string) => Math.min(255, Math.round(part.endsWith("%") ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part)));
  return `#${rgb.slice(1, 4).map((part) => channel(part).toString(16).padStart(2, "0")).join("")}`;
}

const LiberaTextStyle = TextStyle.extend({
  renderMarkdown(node, h) {
    let content = h.renderChildren(node);
    const attrs = node.attrs ?? {};
    const color = markdownColor(attrs.color);
    if (color) content = `[color=${color}]${content}[/color]`;
    const size = Number.parseFloat(attrs.fontSize);
    const line = Number.parseFloat(attrs.lineHeight);
    const htmlAttrs = [
      size >= 8 && size <= 96 ? `data-font-size="${size}"` : "",
      line >= 1 && line <= 3 ? `data-line-height="${line}"` : "",
    ].filter(Boolean).join(" ");
    return htmlAttrs ? `<span ${htmlAttrs}>${content}</span>` : content;
  },
  parseHTML() {
    return [{ tag: "span[data-font-size]" }, { tag: "span[data-line-height]" }, ...(this.parent?.() ?? [])];
  },
  parseMarkdown(token, h) {
    // Merge nested text-style marks, otherwise ProseMirror keeps only one of
    // the color/size/spacing attributes when reading styled Markdown.
    const attrs = token.attributes ?? { color: token.color };
    return h.parseInline(token.tokens ?? []).map((node) => ({
      ...node,
      marks: [
        ...(node.marks ?? []).filter((mark) => mark.type !== "textStyle"),
        { type: "textStyle", attrs: { ...attrs, ...node.marks?.find((mark) => mark.type === "textStyle")?.attrs } },
      ],
    }));
  },
  markdownTokenizer: {
    name: "textStyle",
    level: "inline",
    start: (src) => src.search(/\[color=|<span\s+data-(?:font-size|line-height)=/),
    tokenize(src, _, h) {
      const span = /^(<span\s+data-(?:font-size|line-height)="[^">]+"[^>]*>)([\s\S]*?)<\/span>/.exec(src);
      if (span) return { type: "textStyle", raw: span[0], attributes: markdownTextStyleAttributes(span[1]), tokens: h.inlineTokens(span[2]) };
      const match = /^\[color=(#[\da-fA-F]{3,8})\]([\s\S]*?)\[\/color\]/.exec(src);
      if (!match) return;
      return { type: "textStyle", raw: match[0], color: match[1], tokens: h.inlineTokens(match[2]) };
    },
  },
});

type TableJson = JSONContent;
const isCell = (node: JSONContent) => node.type === "tableCell" || node.type === "tableHeader";

/** A cell's `\|` is a plain `|` in GFM (the cell writer escapes every `|`), so a
 * norm bar is written `\Vert` (spaced before a letter) and the remaining `\|` always means `|`. */
function withoutNormBars(node: TableJson): TableJson {
  if (node.type === "inlineMath" && typeof node.attrs?.latex === "string") {
    return { ...node, attrs: { ...node.attrs, latex: node.attrs.latex.replace(/\\\\|\\\|(?=([A-Za-z])?)/g, (bars, letter) => bars === "\\\\" ? bars : letter ? "\\Vert " : "\\Vert") } };
  }
  return node.content ? { ...node, content: node.content.map(withoutNormBars) } : node;
}

const hasMergedCells = (table: TableJson) => table.content?.some((row) => row.content?.some((cell) =>
  isCell(cell) && (Number(cell.attrs?.colspan) > 1 || Number(cell.attrs?.rowspan) > 1))) ?? false;

/** A pipe table has one cell per column, so a merged cell is followed by empty
 * cells for the slots it covers (the fallback when no schema can write HTML). */
function padMergedCells(table: TableJson): TableJson {
  const covered: number[] = [];
  const empty = (cell?: JSONContent): JSONContent => ({ type: cell?.type ?? "tableCell", content: [{ type: "paragraph" }] });
  const rows = (table.content ?? []).map((row) => {
    const cells: JSONContent[] = [];
    const place = (cell: JSONContent) => { cells.push(cell); };
    for (const cell of row.content ?? []) {
      while (covered[cells.length] > 0) { covered[cells.length]--; place(empty()); }
      const span = Math.max(1, Number(cell.attrs?.colspan) || 1);
      const down = Math.max(1, Number(cell.attrs?.rowspan) || 1);
      const start = cells.length;
      place({ ...cell, attrs: { ...cell.attrs, colspan: 1, rowspan: 1 } });
      for (let i = 1; i < span; i++) place(empty(cell));
      if (down > 1) for (let i = 0; i < span; i++) covered[start + i] = down - 1;
    }
    while (covered[cells.length] > 0) { covered[cells.length]--; place(empty()); }
    return { ...row, content: cells };
  });
  return { ...table, content: rows };
}

/** The table as one line of HTML: merged cells have no pipe-table form, and the
 * preview's sanitizer and a LaTeX paste both read `<table>`. Cells are written
 * from the schema (so marks, links and citations read back as they were); math,
 * which has no HTML the preview knows, shows its `$…$` source as the span's text. */
function tableHtml(table: TableJson, schema: Schema) {
  try {
    const node = schema.nodeFromJSON(table);
    node.check();
    const dom = DOMSerializer.fromSchema(schema).serializeNode(node) as HTMLElement;
    dom.querySelector("colgroup")?.remove();
    dom.removeAttribute("style");
    // Column widths live in the front matter (table-widths.ts), as for pipe tables.
    dom.querySelectorAll("[colwidth]").forEach((cell) => cell.removeAttribute("colwidth"));
    dom.querySelectorAll("span[data-type='inline-math']").forEach((span) => { span.textContent = `$${span.getAttribute("data-latex") ?? ""}$`; });
    return dom.outerHTML.replace(/\n/g, "&#10;");
  } catch {
    return null;
  }
}

// The schema of the editor being serialized: renderMarkdown has no editor in its
// context. A bare MarkdownManager (the clipboard's, markdown-clipboard.ts) sets
// none, and a merged table is then padded instead of written as HTML.
let serializingSchema: Schema | null = null;

/** TipTap's table view sets a column's width but never clears it, so a column
 * that lost its width (an undo, a reload) kept showing the old one. */
class LiberaTableView extends TableView {
  update(node: ProseMirrorNode) {
    if (!super.update(node)) return false;
    const widths = tableColumnWidths(node);
    Array.from(this.colgroup.children).forEach((col, index) => {
      if (!widths[index]) (col as HTMLElement).style.removeProperty("width");
    });
    return true;
  }
}

const LiberaTable = Table.extend({
  renderMarkdown(node, h) {
    const merged = hasMergedCells(node);
    const html = merged && serializingSchema ? tableHtml(node, serializingSchema) : null;
    if (html) return `\n${html}\n`;
    return renderTableToMarkdown(withoutNormBars(merged ? padMergedCells(node) : node), h);
  },
});

const LiberaFontSize = FontSize.extend({
  addGlobalAttributes() {
    return [{ types: ["textStyle"], attributes: { fontSize: {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const size = Number.parseFloat(element.getAttribute("data-font-size") ?? element.style.fontSize);
        return size >= 8 && size <= 96 ? `${size}px` : null;
      },
      renderHTML: (attrs: Record<string, string>) => attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
    } } }];
  },
});

const LiberaLineHeight = LineHeight.extend({
  addGlobalAttributes() {
    return [{ types: ["textStyle"], attributes: { lineHeight: {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const line = Number(element.getAttribute("data-line-height") ?? element.style.lineHeight);
        return line >= 1 && line <= 3 ? String(line) : null;
      },
      renderHTML: (attrs: Record<string, string>) => attrs.lineHeight ? { "data-line-height": attrs.lineHeight, style: `line-height: ${attrs.lineHeight}` } : {},
    } } }];
  },
});

// Link text is never a citation (the shared grammar, citation-syntax.ts): a
// citation token parsed inside `[…](url)` stays the text it was written as.
const LiberaLink = Link.extend({
  parseMarkdown(token, helpers) {
    const content = helpers.parseInline(token.tokens ?? []).map((node: JSONContent): JSONContent =>
      node.type === CITATION_NODE_NAME ? { type: "text", text: String(node.attrs?.raw ?? ""), ...(node.marks ? { marks: node.marks } : {}) } : node);
    return helpers.applyMark("link", content, { href: token.href, title: token.title || null });
  },
});

// In a tight list, text that continues an item after display math (`- a:\n
// \[x\]\n  b`) is a second text token. Tiptap reads only the first as the
// item's paragraph and leaves the rest as bare text, which ProseMirror rejects
// (a paste of it fell back to literal Markdown). Read every one as a paragraph.
const LiberaListItem = ListItem.extend({
  parseMarkdown(token, helpers) {
    const children = token.tokens ?? [];
    if (children.slice(1).some((child) => child.type === "text")) {
      token = { ...token, tokens: children.map((child) => child.type === "text" ? { ...child, type: "paragraph", tokens: child.tokens ?? [{ type: "text", raw: child.raw, text: child.text }] } : child) };
    }
    return ListItem.config.parseMarkdown?.call(this, token, helpers) ?? [];
  },
});

type ListToken = { type: string; raw?: string; items?: ListToken[]; tokens?: ListToken[] };
type BlockLexer = { blockTokens(src: string, tokens?: unknown[]): ListToken[] };

/** Re-reads each item's opening paragraph as blocks when it holds display math.
 * Tiptap's ordered-list tokenizer gathers an item's lines up to the first blank
 * line into one inline paragraph, breaking it only for blocks it knows (`$$`,
 * fences, headings, lists), so `1. Text:\n   \[\n   x\n   \]` lost its math to
 * Markdown escapes and emphasis. Bullet lists use marked's own list tokenizer,
 * which lets block extensions such as Libera's math interrupt a paragraph. */
function splitItemDisplayMath(items: ListToken[], lexer: BlockLexer) {
  for (const item of items) {
    if (item.type !== "list_item" || !item.tokens) continue;
    item.tokens = item.tokens.flatMap((token) => {
      if (token.type === "list" && token.items) splitItemDisplayMath(token.items, lexer);
      if (token.type !== "paragraph" || !token.raw) return [token];
      // The paragraph has no blank lines, so its lines' indentation means nothing
      // (no indented code); Tiptap also leaves one space too many under `1. `.
      const blocks = lexer.blockTokens(token.raw.replace(/\n[ \t]+/g, "\n"), []);
      return blocks.some((block) => block.type === "blockMath") ? blocks : [token];
    });
  }
}

const orderedListTokenizer = OrderedList.config.markdownTokenizer!;
const LiberaOrderedList = OrderedList.extend({
  markdownTokenizer: {
    ...orderedListTokenizer,
    tokenize(src, tokens, lexer) {
      const token = orderedListTokenizer.tokenize(src, tokens, lexer) as ListToken | undefined;
      if (token?.items) splitItemDisplayMath(token.items, lexer as unknown as BlockLexer);
      return token as ReturnType<typeof orderedListTokenizer.tokenize>;
    },
  },
});

type TaskToken = ListToken & { mainContent?: string; text?: string; nestedTokens?: TaskToken[] };
type TaskLexer = BlockLexer & { inlineTokens(src: string): ListToken[] };

/** The same repair for task items. Since Tiptap 3.33 an item's continuation
 * lines join its opening paragraph unless they start a block on their own, and
 * a lone `\[` line does not, so `- [ ] Text:\n  \[\n  x\n  \]` lost its math. */
function splitTaskDisplayMath(tokens: TaskToken[], lexer: TaskLexer) {
  for (const token of tokens) {
    if (token.type === "taskList" && token.items) splitTaskDisplayMath(token.items, lexer);
    if (token.type !== "taskItem") continue;
    if (token.nestedTokens) splitTaskDisplayMath(token.nestedTokens, lexer);
    if (!token.mainContent?.includes("\n")) continue;
    const blocks = lexer.blockTokens(token.mainContent, []);
    if (!blocks.some((block) => block.type === "blockMath")) continue;
    const lead = blocks[0]?.type === "paragraph" ? blocks.shift()!.raw!.trim() : "";
    token.mainContent = token.text = lead;
    token.tokens = lexer.inlineTokens(lead);
    token.nestedTokens = [...blocks.filter((block) => block.type !== "space"), ...(token.nestedTokens ?? [])];
  }
}

const taskListTokenizer = TaskList.config.markdownTokenizer!;
const LiberaTaskList = TaskList.extend({
  markdownTokenizer: {
    ...taskListTokenizer,
    tokenize(src, tokens, lexer) {
      const token = taskListTokenizer.tokenize(src, tokens, lexer) as TaskToken | undefined;
      if (token?.items) splitTaskDisplayMath(token.items, lexer as unknown as TaskLexer);
      return token as ReturnType<typeof taskListTokenizer.tokenize>;
    },
  },
});

// Typing ```libera-macro (or any language with a hyphen or digit) starts a code block.
const LiberaCodeBlock = CodeBlock.extend({
  addInputRules() {
    return (["`", "~"] as const).map((fence) => textblockTypeInputRule({
      find: new RegExp(`^${fence.repeat(3)}([a-z][\\w-]*)?[\\s\\n]$`),
      type: this.type,
      getAttributes: (match) => ({ language: match[1] }),
    }));
  },
});

export type MarkdownExtensionOptions = {
  /** The Visual editor's citation node view (references/tiptap-citation-view.tsx). */
  citationNodeView?: NodeViewRenderer;
  /** The Visual editor's code block view, which draws ```chart, ```mermaid and ```html live blocks (tiptap-live-code-block-view.tsx). */
  codeBlockNodeView?: NodeViewRenderer;
  /** The Visual editor's image view, which adds Re-run and Code to figures made by a note's Python (tiptap-python-figure-view.ts). */
  imageNodeView?: NodeViewRenderer;
  /** The front matter block's tooltip, in the interface language (lib.tiptapFrontMatter.frontMatterTitle). */
  frontMatterTitle?: string;
  /** Columns can be resized by dragging their borders; the widths are kept in the macro block (tiptap-table-widths.ts). Not for slide decks, whose slides each count their tables from the first. */
  resizableTables?: boolean;
};

export function createMarkdownExtensions(documentPath: string, options: MarkdownExtensionOptions = {}) {
  return [
    StarterKit.configure({ link: false, trailingNode: false, underline: false, blockquote: false, code: false, codeBlock: false, listItem: false, orderedList: false }),
    // Markdown nests inline code in bold, italics, links and strikethrough, and loading a
    // note keeps those marks; Tiptap's code mark excludes all others, so pasting the same
    // Markdown failed the schema check and fell back to the browser's plain-text paste.
    Code.extend({ excludes: "" }),
    LiberaListItem,
    LiberaOrderedList,
    // The language attribute keeps the whole info string (`html live`), so it round-trips.
    LiberaCodeBlock.extend(options.codeBlockNodeView ? { addNodeView: () => options.codeBlockNodeView! } : {}),
    LiberaLink.configure({ openOnClick: false }),
    // Before the citation node so `[^1]` is a footnote, not a bracket run.
    FootnoteReference, FootnoteDefinition, Superscript, Subscript,
    CitationNode.configure({ nodeView: options.citationNodeView ?? null }),
    FrontMatterNode.configure({ documentPath, title: options.frontMatterTitle }),
    LiberaBlockquote,
    Underline.extend({
      renderMarkdown: (node, h) => `<u>${h.renderChildren(node)}</u>`,
      markdownTokenizer: {
        name: "underline", level: "inline", start: (src) => src.search(/<u>|\+\+/),
        tokenize(src, _, h) {
          const match = /^(?:<u>([\s\S]*?)<\/u>|\+\+([\s\S]*?)\+\+)/.exec(src);
          if (match) return { type: "underline", raw: match[0], tokens: h.inlineTokens(match[1] ?? match[2]) };
        },
      },
    }),
    // Libera's uncolored highlight delimiter at the beginning of a paragraph
    // would otherwise be consumed by Markdown's blockquote parser.
    Extension.create({
      name: "liberaHighlightParagraph",
      markdownTokenizer: {
        name: "liberaHighlightParagraph", level: "block",
        // Do not interrupt an existing paragraph (or an inline code span).
        // Marked calls tokenize at each new block even without a start hint.
        start: () => -1,
        tokenize(src, _, h) {
          if (!/^>>>/.test(src)) return;
          const paragraph = src.split(/\n\s*\n/)[0];
          if (!paragraph.includes("<<<")) return;
          return { type: "liberaHighlightParagraph", raw: paragraph, tokens: h.inlineTokens(paragraph) };
        },
      },
      parseMarkdown: (token, h) => ({ type: "paragraph", content: h.parseInline(token.tokens ?? []) }),
    }),
    // TipTap registers its tokenizers on the marked instance, so each editor gets its own;
    // the global one would grow by every tokenizer of every editor and slow every parse.
    LiberaMarkdown.configure({ marked: new Marked() as unknown as typeof marked }), LiberaHighlight, LiberaTextStyle, LiberaFontSize, LiberaLineHeight, Color,
    TableKit.configure({ table: false }), LiberaTable.configure({ resizable: options.resizableTables ?? false, View: LiberaTableView }),
    ...(options.resizableTables ? [TiptapTableWidths] : []), LiberaTaskList, TaskItem.configure({ nested: true }),
    Image.extend({
      addNodeView() {
        if (options.imageNodeView) return options.imageNodeView;
        return ({ node }) => {
          const image = document.createElement("img");
          image.src = markdownAssetSource(documentPath, String(node.attrs.src ?? ""));
          image.alt = node.attrs.alt ?? "";
          if (node.attrs.title) image.title = node.attrs.title;
          return { dom: image };
        };
      },
    }).configure({ allowBase64: true }),
  ];
}

/** Resolves a Markdown image source relative to its document's assets. */
export function markdownAssetSource(documentPath: string, src: string) {
  return src && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(src)
    ? `/api/markdown-assets/raw?document=${encodeURIComponent(documentPath)}&asset=${encodeURIComponent(src)}`
    : src;
}
