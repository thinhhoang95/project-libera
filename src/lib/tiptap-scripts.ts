import { Mark } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    superscript: { toggleSuperscript: () => ReturnType };
    subscript: { toggleSubscript: () => ReturnType };
  }
}

// Superscript and subscript are written as `<sup>…</sup>` / `<sub>…</sub>`, the
// HTML the preview's sanitizer keeps, and read like Underline's `<u>` (so the
// text between the tags is still Markdown).
function scriptMark(name: "superscript" | "subscript", tag: "sup" | "sub", other: string, shortcut: string) {
  const pattern = new RegExp(`^<${tag}>([\\s\\S]*?)</${tag}>`);
  const toggle = name === "superscript" ? "toggleSuperscript" : "toggleSubscript";
  return Mark.create({
    name,
    excludes: other,
    parseHTML() {
      return [{ tag }, { style: "vertical-align", getAttrs: (value) => (value === (tag === "sup" ? "super" : "sub") ? null : false) }];
    },
    renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0],
    addCommands() {
      return { [toggle]: () => ({ commands }: { commands: { toggleMark: (name: string) => boolean } }) => commands.toggleMark(name) } as never;
    },
    addKeyboardShortcuts() {
      return { [shortcut]: () => this.editor.commands.toggleMark(name) };
    },
    renderMarkdown: (node, h) => `<${tag}>${h.renderChildren(node)}</${tag}>`,
    parseMarkdown: (token, h) => h.applyMark(name, h.parseInline(token.tokens ?? [])),
    markdownTokenizer: {
      name, level: "inline", start: (src) => src.indexOf(`<${tag}>`),
      tokenize(src, _, h) {
        const match = pattern.exec(src);
        if (match) return { type: name, raw: match[0], tokens: h.inlineTokens(match[1]) };
      },
    },
  });
}

export const Superscript = scriptMark("superscript", "sup", "subscript", "Mod-.");
export const Subscript = scriptMark("subscript", "sub", "superscript", "Mod-,");
