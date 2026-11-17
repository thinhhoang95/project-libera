import { Extension, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { AddMarkStep, AttrStep, DocAttrStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep } from "@tiptap/pm/transform";
import { TIPTAP_BRIDGE_META } from "./collab/bindings/tiptap-ytext";
import type { HeadingNumberingSettings } from "./markdown-heading-numbering";
import { applyTiptapStructuralNumbers } from "./tiptap-editor-actions";

export const tiptapHeadingNumberingKey = new PluginKey<HeadingNumberingSettings>("liberaHeadingNumbering");

const DISABLED: HeadingNumberingSettings = { enabled: false, skipTitle: true };

function hasHeadingBetween(doc: ProseMirrorNode, from: number, to: number) {
  let found = false;
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node) => {
    if (node.type.name === "heading") found = true;
    return !found;
  });
  return found;
}

// Documents a full numbering pass left unchanged, under the settings it used;
// the next edit need only run that pass again if it touches a heading.
const numbered = new WeakMap<ProseMirrorNode, HeadingNumberingSettings>();

/**
 * Whether an edit may change the numbers: a heading lies in a range it
 * changed, in the document before the step or after it. Anything else leaves
 * the headings, their order and their text as they were. A step whose reach is
 * not known counts as touching.
 */
export function transactionsMayAffectHeadings(transactions: readonly Transaction[]) {
  for (const tr of transactions) {
    for (let index = 0; index < tr.steps.length; index++) {
      const step = tr.steps[index];
      const before = tr.docs[index];
      const after = index + 1 < tr.docs.length ? tr.docs[index + 1] : tr.doc;
      if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
        let touched = false;
        step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
          touched ||= hasHeadingBetween(before, oldStart, oldEnd) || hasHeadingBetween(after, newStart, newEnd);
        });
        if (touched) return true;
      } else if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        if (hasHeadingBetween(before, step.from, step.to)) return true;
      } else if (step instanceof AttrStep) {
        // Changes a node's attribute in place (a heading's level), which no step map shows.
        if (before.nodeAt(step.pos)?.type.name === "heading") return true;
      } else if (!(step instanceof DocAttrStep)) return true;
    }
  }
  return false;
}

/**
 * Structural heading numbering in the Visual editor: while the document is
 * numbered, every local edit renumbers the headings in the same undo step, so
 * typing `## ` turns into `## 2.1 `. Remote edits and undo/redo are left as
 * they are; renumbering them would fight the collaborator or the undo. The
 * settings live in the plugin's state (see setTiptapHeadingNumbering).
 */
export const TiptapHeadingNumbering = Extension.create({
  name: "liberaHeadingNumbering",
  addProseMirrorPlugins() {
    return [new Plugin<HeadingNumberingSettings>({
      key: tiptapHeadingNumberingKey,
      state: {
        init: () => DISABLED,
        apply: (tr, settings) => (tr.getMeta(tiptapHeadingNumberingKey) as HeadingNumberingSettings | undefined) ?? settings,
      },
      appendTransaction(transactions, oldState, newState) {
        const settings = tiptapHeadingNumberingKey.getState(newState) ?? DISABLED;
        if (!settings.enabled || !transactions.some((tr) => tr.docChanged)) return null;
        if (transactions.some((tr) =>
          tr.getMeta(TIPTAP_BRIDGE_META) || tr.getMeta("history$") || tr.getMeta(tiptapHeadingNumberingKey))) return null;
        // A document known to be fully numbered stays so through an edit that leaves the headings alone.
        if (numbered.get(oldState.doc) === settings && !transactionsMayAffectHeadings(transactions)) {
          numbered.set(newState.doc, settings);
          return null;
        }
        const shrunk = newState.doc.content.size < oldState.doc.content.size;
        const protectPos = shrunk && newState.selection.empty ? newState.selection.from : undefined;
        const tr = applyTiptapStructuralNumbers(newState.tr, settings, protectPos);
        // Only a pass that found nothing to change proves the document numbered: one that edited may need another round
        // (a number's own style feeds the next numbers), and with a caret protected in a number a heading may be left as typed.
        if (protectPos === undefined && !tr.docChanged) numbered.set(newState.doc, settings);
        return tr.docChanged ? tr.setMeta(tiptapHeadingNumberingKey, settings) : null;
      },
    })];
  },
});

/** Give the editor its numbering settings. `renumber` (numbering was just
 * switched on, or its title setting changed) also renumbers now, as one undo
 * step; otherwise the document is left as it is. */
export function setTiptapHeadingNumbering(editor: Editor, settings: HeadingNumberingSettings, renumber: boolean) {
  const tr = editor.state.tr.setMeta(tiptapHeadingNumberingKey, settings);
  if (renumber && settings.enabled) applyTiptapStructuralNumbers(closeHistory(tr), settings);
  if (!tr.docChanged) tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}
