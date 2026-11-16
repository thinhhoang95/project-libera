import { Node } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/* GFM footnotes in the Visual editor. A reference `[^id]` is an inline atom and
 * a definition `[^id]: text` is a block of inline content, so neither is
 * escaped to `\[^id\]` on save (tiptap-markdown.ts escapes every bracket in
 * text). Lines indented under a definition (a second paragraph, a list) are
 * kept verbatim in `continuation`: shown nowhere, written back as read. */

export const FOOTNOTE_REFERENCE_NODE_NAME = "footnoteReference";
export const FOOTNOTE_DEFINITION_NODE_NAME = "footnoteDefinition";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: { insertFootnote: () => ReturnType };
  }
}

const LABEL = "[^\\]\\s^]+";

/** The next unused footnote number: one past the largest numeric id in the document. */
export function nextFootnoteId(doc: ProseMirrorNode) {
  let max = 0;
  doc.descendants((node) => {
    if (node.type.name === FOOTNOTE_REFERENCE_NODE_NAME || node.type.name === FOOTNOTE_DEFINITION_NODE_NAME) {
      const id = String(node.attrs.id ?? "");
      if (/^\d+$/.test(id)) max = Math.max(max, Number(id));
    }
  });
  return String(max + 1);
}

export const FootnoteReference = Node.create({
  name: FOOTNOTE_REFERENCE_NODE_NAME,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { id: { default: "", parseHTML: (element: HTMLElement) => element.getAttribute("data-footnote-ref") ?? "" } };
  },
  // Above the superscript mark's plain `sup` rule.
  parseHTML() {
    return [{ tag: "sup[data-footnote-ref]", priority: 60 }];
  },
  renderHTML({ node }) {
    return ["sup", { class: "libera-footnote-ref", "data-footnote-ref": node.attrs.id, contenteditable: "false" }, String(node.attrs.id)];
  },
  renderMarkdown: (node) => `[^${node.attrs?.id ?? ""}]`,
  parseMarkdown: (token) => ({ type: FOOTNOTE_REFERENCE_NODE_NAME, attrs: { id: token.id } }),
  markdownTokenizer: {
    name: FOOTNOTE_REFERENCE_NODE_NAME,
    level: "inline",
    start: (src) => src.indexOf("[^"),
    tokenize(src) {
      // `[^1]:` at a line start is a definition, never a reference.
      const match = new RegExp(`^\\[\\^(${LABEL})\\](?!:)`).exec(src);
      if (match) return { type: FOOTNOTE_REFERENCE_NODE_NAME, raw: match[0], id: match[1] };
    },
  },
  addCommands() {
    return {
      insertFootnote: () => ({ state, tr, dispatch }) => {
        const definition = state.schema.nodes[FOOTNOTE_DEFINITION_NODE_NAME];
        if (!definition) return false;
        if (dispatch) {
          const id = nextFootnoteId(state.doc);
          tr.replaceSelectionWith(this.type.create({ id }), false);
          const at = tr.doc.content.size;
          tr.insert(at, definition.create({ id }));
          tr.setSelection(TextSelection.near(tr.doc.resolve(tr.doc.content.size - 1), -1)).scrollIntoView();
        }
        return true;
      },
    };
  },
});

export const FootnoteDefinition = Node.create({
  name: FOOTNOTE_DEFINITION_NODE_NAME,
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes() {
    return {
      id: { default: "", parseHTML: (element: HTMLElement) => element.getAttribute("data-footnote-id") ?? "" },
      continuation: { default: "", rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "p[data-footnote-id]", priority: 60 }];
  },
  renderHTML({ node }) {
    return ["p", { class: "libera-footnote-definition", "data-footnote-id": node.attrs.id }, 0];
  },
  renderMarkdown(node, h) {
    const text = h.renderChildren(node.content ?? []).replace(/\n/g, "\n    ").trimEnd();
    const continuation = node.attrs?.continuation ? `\n${node.attrs.continuation}` : "";
    return `[^${node.attrs?.id ?? ""}]:${text ? ` ${text}` : ""}${continuation}`;
  },
  parseMarkdown: (token, h) => ({
    type: FOOTNOTE_DEFINITION_NODE_NAME,
    attrs: { id: token.id, continuation: token.continuation ?? "" },
    content: h.parseInline(token.tokens ?? []),
  }),
  markdownTokenizer: {
    name: FOOTNOTE_DEFINITION_NODE_NAME,
    level: "block",
    // Only at a line start; a paragraph above is cut there.
    start(src) {
      const at = src.search(new RegExp(`(?:^|\\n)\\[\\^${LABEL}\\]:`));
      return at < 0 ? -1 : src[at] === "\n" ? at + 1 : at;
    },
    tokenize(src, _, h) {
      const match = new RegExp(`^\\[\\^(${LABEL})\\]:[ \\t]*([^\\n]*)((?:\\n(?:[ \\t]*\\n)*(?: {4}|\\t)[^\\n]*)*)`).exec(src);
      if (!match) return;
      return {
        type: FOOTNOTE_DEFINITION_NODE_NAME, raw: match[0], id: match[1],
        continuation: match[3].replace(/^\n/, ""), tokens: h.inlineTokens(match[2].trimEnd()),
      };
    },
  },
});
