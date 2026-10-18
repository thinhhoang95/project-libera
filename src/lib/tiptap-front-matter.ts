import { Node } from "@tiptap/core";
import { citationFrontMatterEnd } from "./references/citation-syntax";

/* YAML front matter in the Visual (TipTap) editor.
 *
 * Front matter (`---` … `---` or `...` at the very start of a document) is
 * metadata, such as a per-document `citation-style:` (references/document-style.ts).
 * Markdown would read it as a thematic break and a setext heading, and saving
 * would turn it into `---` and `## key: value`. This block atom keeps it as
 * it is written: `raw` is the source from the opening `---` to the closing
 * line, written back byte for byte. It is shown, not edited, in the Visual
 * editor; the Source editor and the Document style control change it. */

export const FRONT_MATTER_NODE_NAME = "frontMatter";

export const FrontMatterNode = Node.create({
  name: FRONT_MATTER_NODE_NAME,
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      raw: {
        default: "",
        parseHTML: (element) => element.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "pre[data-front-matter]", priority: 100 }];
  },

  renderHTML({ node }) {
    return ["pre", { "data-front-matter": "", class: "libera-front-matter", title: "Front matter (edit it in the Source editor)" }, String(node.attrs.raw ?? "")];
  },

  markdownTokenName: FRONT_MATTER_NODE_NAME,
  markdownTokenizer: {
    name: FRONT_MATTER_NODE_NAME,
    level: "block",
    // Only at the start of the document: never interrupt other blocks.
    start: () => -1,
    tokenize(src: string, tokens: unknown[]) {
      if (tokens.length || !src.startsWith("---")) return undefined;
      const end = citationFrontMatterEnd(src);
      return end ? { type: FRONT_MATTER_NODE_NAME, raw: src.slice(0, end), tokens: [] } : undefined;
    },
  },
  parseMarkdown(token) {
    return { type: FRONT_MATTER_NODE_NAME, attrs: { raw: token.raw } };
  },
  renderMarkdown(node) {
    return String(node.attrs?.raw ?? "");
  },
});
