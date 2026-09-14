import Blockquote from "@tiptap/extension-blockquote";
import { wrappingInputRule } from "@tiptap/core";
import { MARKDOWN_BOX_PREFIX, MARKDOWN_BOX_SHORTCUTS, markdownBoxStyle } from "./markdown-boxes";
import { getMarkdownHighlightColorByShortcut } from "./markdown-colors";

export const LiberaBlockquote = Blockquote.extend({
  addAttributes() {
    return { color: {
      default: null,
      parseHTML: (element: HTMLElement) => getMarkdownHighlightColorByShortcut(element.getAttribute("data-box-color") ?? "")?.shortcut ?? null,
      renderHTML: (attrs: Record<string, string>) => {
        const style = markdownBoxStyle(attrs.color ?? "");
        return style ? { "data-box-color": attrs.color, style: `background-color: ${style.backgroundColor}; color: ${style.color}; border-color: ${style.borderColor}` } : {};
      },
    } };
  },
  parseMarkdown(token, h) {
    return h.createNode("blockquote", { color: token.color ?? null }, (h.parseBlockChildren ?? h.parseChildren)(token.tokens ?? []));
  },
  renderMarkdown(node, h) {
    const prefix = `${getMarkdownHighlightColorByShortcut(node.attrs?.color ?? "")?.shortcut ?? ""}>`;
    return (node.content ?? []).map((child, index) => {
      const content = h.renderChild?.(child, index) ?? h.renderChildren([child]);
      return content.split("\n").map((line) => line ? `${prefix} ${line}` : prefix).join("\n");
    }).join(`\n${prefix}\n`);
  },
  markdownTokenizer: {
    name: "blockquote", level: "block",
    // Marked passes paragraph source with its first character removed. Only
    // interrupt at a real newline, never at the start of an inline code span.
    start: (src) => {
      const index = src.search(new RegExp(`\\n {0,3}[${MARKDOWN_BOX_SHORTCUTS}]>(?!>)`, "i"));
      return index < 0 ? -1 : index + 1;
    },
    tokenize(src, _, h) {
      const first = MARKDOWN_BOX_PREFIX.exec(src);
      if (!first) return;
      const color = first[1].toLowerCase();
      let normalized = "";
      const removedAt: number[] = [];
      for (const line of src.split("\n")) {
        const match = MARKDOWN_BOX_PREFIX.exec(line);
        if (match && match[1].toLowerCase() !== color) break;
        if (!match && (!line.trim() || /^ {0,3}>/.test(line))) break;
        // Delegate paragraph continuation, nested blocks and code handling to
        // Marked's ordinary quote parser, retaining a map back to source bytes.
        let converted = line;
        if (match) {
          const letter = line.indexOf(match[1]);
          removedAt.push(normalized.length + letter);
          converted = line.slice(0, letter) + line.slice(letter + 1);
        }
        normalized += converted + (normalized.length + removedAt.length + converted.length < src.length ? "\n" : "");
      }
      const quote = h.blockTokens(normalized)[0];
      if (quote?.type !== "blockquote" || typeof quote.raw !== "string") return;
      const length = quote.raw.length;
      const raw = src.slice(0, length + removedAt.filter((offset) => offset < length).length);
      return { type: "blockquote", raw, color, tokens: quote.tokens };
    },
  },
  addInputRules() {
    return [...(this.parent?.() ?? []), wrappingInputRule({
      find: new RegExp(`^\\s*([${MARKDOWN_BOX_SHORTCUTS}])>\\s$`, "i"), type: this.type,
      getAttributes: (match) => ({ color: match[1].toLowerCase() }),
      joinPredicate: (match, node) => node.attrs.color === match[1].toLowerCase(),
    })];
  },
});
