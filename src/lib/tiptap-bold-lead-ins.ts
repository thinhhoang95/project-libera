import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { LEAD_IN_CLASS } from "./markdown-lead-in";

function leadInDecorations(doc: ProseMirrorNode) {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph") return true;
    let end = pos + 1;
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      if (!child.isText || !child.marks.some((mark) => mark.type.name === "bold")) break;
      end += child.nodeSize;
    }
    if (end > pos + 1) decorations.push(Decoration.inline(pos + 1, end, { class: LEAD_IN_CLASS }));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

const leadInKey = new PluginKey<DecorationSet>("liberaBoldLeadIns");

/** The Visual editor's lead-ins, kept as decorations so the Markdown is untouched. */
export const TiptapBoldLeadIns = Extension.create({
  name: "liberaBoldLeadIns",
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: leadInKey,
      state: {
        init: (_config, state) => leadInDecorations(state.doc),
        apply: (tr, decorations) => tr.docChanged ? leadInDecorations(tr.doc) : decorations,
      },
      props: { decorations: (state) => leadInKey.getState(state) },
    })];
  },
});
