import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { AddMarkStep, AttrStep, DocAttrStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { LEAD_IN_CLASS } from "./markdown-lead-in";

/** The lead-in decoration of one paragraph: its leading run of bold text. */
function paragraphLeadIn(node: ProseMirrorNode, pos: number) {
  let end = pos + 1;
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child.isText || !child.marks.some((mark) => mark.type.name === "bold")) break;
    end += child.nodeSize;
  }
  return end > pos + 1 ? Decoration.inline(pos + 1, end, { class: LEAD_IN_CLASS }) : null;
}

export function leadInDecorations(doc: ProseMirrorNode) {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph") return true;
    const decoration = paragraphLeadIn(node, pos);
    if (decoration) decorations.push(decoration);
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * The decorations after `tr`: the old set mapped through the edit, with only
 * the paragraphs the edit touched computed again. Null when a step is not one
 * whose reach is known, so the caller computes the whole document.
 */
export function updateLeadInDecorations(decorations: DecorationSet, tr: Transaction) {
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < tr.steps.length; index++) {
    const step = tr.steps[index];
    const after = tr.mapping.slice(index + 1);
    const add = (from: number, to: number) => ranges.push([after.map(from, -1), after.map(to, 1)]);
    if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
      // The inserted text of the step, in the document right after it.
      step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => add(newStart, newEnd));
    } else if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      add(step.from, step.to);
    } else if (!(step instanceof AttrStep || step instanceof DocAttrStep)) return null;
  }
  const doc = tr.doc;
  const mapped = decorations.map(tr.mapping, doc);
  const stale: Decoration[] = [];
  const fresh: Decoration[] = [];
  const seen = new Set<number>();
  for (const [from, to] of ranges) {
    doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, pos) => {
      if (!node.isTextblock) return true;
      if (seen.has(pos)) return false;
      seen.add(pos);
      // A paragraph turned into another block, or the reverse, is a textblock here too; a decoration that spills over from a joined one is stale.
      for (const decoration of mapped.find(pos, pos + node.nodeSize)) if (decoration.from < pos + node.nodeSize && decoration.to > pos) stale.push(decoration);
      const decoration = node.type.name === "paragraph" ? paragraphLeadIn(node, pos) : null;
      if (decoration) fresh.push(decoration);
      return false;
    });
  }
  return mapped.remove(stale).add(doc, fresh);
}

export const leadInKey = new PluginKey<DecorationSet>("liberaBoldLeadIns");

/** The Visual editor's lead-ins, kept as decorations so the Markdown is untouched. */
export const TiptapBoldLeadIns = Extension.create({
  name: "liberaBoldLeadIns",
  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: leadInKey,
      state: {
        init: (_config, state) => leadInDecorations(state.doc),
        apply: (tr, decorations) => tr.docChanged ? (updateLeadInDecorations(decorations, tr) ?? leadInDecorations(tr.doc)) : decorations,
      },
      props: { decorations: (state) => leadInKey.getState(state) },
    })];
  },
});
