import { Node, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { citationFrontMatterEnd } from "./references/citation-syntax";
import {
  DOCUMENT_STYLE_REQUEST_EVENT, documentStyleOverride, readDocumentStyle, writeDocumentStyle, type DocumentStyleRequestDetail,
} from "./references/document-style";

/* YAML front matter in the Visual (TipTap) editor.
 *
 * Front matter (`---` … `---` or `...` at the very start of a document) is
 * metadata, such as a per-document `citation-style:` (references/document-style.ts).
 * Markdown would read it as a thematic break and a setext heading, and saving
 * would turn it into `---` and `## key: value`. This block atom keeps it as
 * it is written: `raw` is the source from the opening `---` to the closing
 * line, written back byte for byte. It is shown, not edited, in the Visual
 * editor; the Source editor and the Document style control change it (the
 * node listens for DOCUMENT_STYLE_REQUEST_EVENT for its `documentPath`). */

export const FRONT_MATTER_NODE_NAME = "frontMatter";

export type FrontMatterOptions = {
  /** The document's library path: style requests for it are applied here. */
  documentPath: string | null;
};

/** The document's front matter node, if it has one (always the first block). */
function frontMatterNode(doc: ProseMirrorNode) {
  const first = doc.firstChild;
  return first?.type.name === FRONT_MATTER_NODE_NAME ? first : null;
}

/** The style the document's front matter names (`citation-style`), as written; null without one. */
export function tiptapDocumentStyleValue(doc: ProseMirrorNode) {
  const node = frontMatterNode(doc);
  return node ? readDocumentStyle(String(node.attrs.raw ?? "")) : null;
}

/** The document's own valid style setting, or null (the notebook's style applies). */
export function tiptapDocumentStyle(doc: ProseMirrorNode) {
  const node = frontMatterNode(doc);
  return node ? documentStyleOverride(String(node.attrs.raw ?? "")) : null;
}

/**
 * Set (or with null, remove) the document's `citation-style`, as one edit:
 * the front matter node is updated, added at the start, or removed when the
 * style was all it held. False when nothing changed.
 */
export function setTiptapDocumentStyle(editor: Editor, style: string | null) {
  const { state } = editor;
  const node = frontMatterNode(state.doc);
  const type = state.schema.nodes[FRONT_MATTER_NODE_NAME];
  if (!type) return false;
  const raw = node ? String(node.attrs.raw ?? "") : "";
  const next = writeDocumentStyle(raw, style).replace(/(?:\r\n|\r|\n)+$/, "");
  if (next === raw) return false;
  const tr = state.tr;
  if (!node) tr.insert(0, type.create({ raw: next }));
  else if (!next) tr.delete(0, node.nodeSize);
  else tr.setNodeMarkup(0, undefined, { ...node.attrs, raw: next });
  editor.view.dispatch(tr);
  return true;
}

export const FrontMatterNode = Node.create<FrontMatterOptions, { listener: ((event: Event) => void) | null }>({
  name: FRONT_MATTER_NODE_NAME,
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { documentPath: null };
  },

  addStorage() {
    return { listener: null };
  },

  onCreate() {
    const documentPath = this.options.documentPath;
    if (!documentPath || typeof window === "undefined") return;
    const editor = this.editor;
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<DocumentStyleRequestDetail>).detail;
      if (detail.path !== documentPath || detail.handled || editor.isDestroyed || !editor.isEditable) return;
      detail.handled = true;
      setTiptapDocumentStyle(editor, detail.style);
    };
    this.storage.listener = listener;
    window.addEventListener(DOCUMENT_STYLE_REQUEST_EVENT, listener);
  },

  onDestroy() {
    if (this.storage.listener) window.removeEventListener(DOCUMENT_STYLE_REQUEST_EVENT, this.storage.listener);
    this.storage.listener = null;
  },

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
    return ["pre", {
      "data-front-matter": "", class: "libera-front-matter", title: "Front matter (edit it in the Source editor)",
      // The editor's prose styles would otherwise fold its lines together.
      style: "white-space: pre-wrap",
    }, String(node.attrs.raw ?? "")];
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
