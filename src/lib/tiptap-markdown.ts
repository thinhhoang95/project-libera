import { Extension, mergeAttributes, type JSONContent, type NodeViewRenderer } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import CodeBlock from "@tiptap/extension-code-block";
import Highlight from "@tiptap/extension-highlight";
import Underline from "@tiptap/extension-underline";
import Image from "@tiptap/extension-image";
import { TextStyle, FontSize, LineHeight, Color } from "@tiptap/extension-text-style";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import Link from "@tiptap/extension-link";
import { MARKDOWN_HIGHLIGHT_COLORS } from "./markdown-colors";
import { markdownTextStyleAttributes } from "./markdown-text-styles";
import { LiberaBlockquote } from "./tiptap-boxes";
import { CitationNode, CITATION_NODE_NAME } from "./tiptap-citation";
import { FrontMatterNode } from "./tiptap-front-matter";

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

const LiberaMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    const manager = this.storage.manager;
    const serialize = manager.serialize.bind(manager);
    manager.serialize = (content) => mergeHighlightSeams(serialize(content));
  },
});

const LiberaTextStyle = TextStyle.extend({
  renderMarkdown(node, h) {
    let content = h.renderChildren(node);
    const attrs = node.attrs ?? {};
    if (attrs.color) content = `[color=${attrs.color}]${content}[/color]`;
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

export type MarkdownExtensionOptions = {
  /** The Visual editor's citation node view (references/tiptap-citation-view.tsx). */
  citationNodeView?: NodeViewRenderer;
  /** The Visual editor's code block view, which draws ```chart, ```mermaid and ```html live blocks (tiptap-live-code-block-view.tsx). */
  codeBlockNodeView?: NodeViewRenderer;
  /** The Visual editor's image view, which adds Re-run and Code to figures made by a note's Python (tiptap-python-figure-view.ts). */
  imageNodeView?: NodeViewRenderer;
};

export function createMarkdownExtensions(documentPath: string, options: MarkdownExtensionOptions = {}) {
  return [
    StarterKit.configure({ link: false, trailingNode: false, underline: false, blockquote: false, codeBlock: false }),
    // The language attribute keeps the whole info string (`html live`), so it round-trips.
    options.codeBlockNodeView ? CodeBlock.extend({ addNodeView: () => options.codeBlockNodeView! }) : CodeBlock,
    LiberaLink.configure({ openOnClick: false }),
    CitationNode.configure({ nodeView: options.citationNodeView ?? null }),
    FrontMatterNode.configure({ documentPath }),
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
    LiberaMarkdown, LiberaHighlight, LiberaTextStyle, LiberaFontSize, LiberaLineHeight, Color,
    TableKit, TaskList, TaskItem.configure({ nested: true }),
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
