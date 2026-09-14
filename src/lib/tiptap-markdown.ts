import { Extension, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Highlight from "@tiptap/extension-highlight";
import Underline from "@tiptap/extension-underline";
import Image from "@tiptap/extension-image";
import { TextStyle, FontSize, LineHeight, Color } from "@tiptap/extension-text-style";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { MARKDOWN_HIGHLIGHT_COLORS } from "./markdown-colors";
import { markdownTextStyleAttributes } from "./markdown-text-styles";
import { LiberaBlockquote } from "./tiptap-boxes";

const LiberaHighlight = Highlight.extend({
  renderHTML({ HTMLAttributes }) {
    const color = MARKDOWN_HIGHLIGHT_COLORS.find((item) => item.value === HTMLAttributes["data-color"]);
    return ["mark", mergeAttributes(HTMLAttributes, { style: `color: ${color?.foreground ?? "inherit"}` }), 0];
  },
  renderMarkdown(node, h) {
    const color = MARKDOWN_HIGHLIGHT_COLORS.find((item) => item.value === node.attrs?.color);
    return `${color?.shortcut ?? "y"}>>>${h.renderChildren(node)}<<<`;
  },
  parseMarkdown(token, h) {
    const color = MARKDOWN_HIGHLIGHT_COLORS.find((item) => item.shortcut === token.color);
    return h.applyMark("highlight", h.parseInline(token.tokens ?? []), { color: color?.value ?? "#fef08a" });
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

export function createMarkdownExtensions(documentPath: string) {
  return [
    StarterKit.configure({ link: { openOnClick: false }, trailingNode: false, underline: false, blockquote: false }),
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
    Markdown, LiberaHighlight, LiberaTextStyle, LiberaFontSize, LiberaLineHeight, Color,
    TableKit, TaskList, TaskItem.configure({ nested: true }),
    Image.extend({
      addNodeView() {
        return ({ node }) => {
          const image = document.createElement("img");
          const src = String(node.attrs.src ?? "");
          image.src = src && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(src)
            ? `/api/markdown-assets/raw?document=${encodeURIComponent(documentPath)}&asset=${encodeURIComponent(src)}`
            : src;
          image.alt = node.attrs.alt ?? "";
          if (node.attrs.title) image.title = node.attrs.title;
          return { dom: image };
        };
      },
    }).configure({ allowBase64: true }),
  ];
}
