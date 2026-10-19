import { Extension, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { TIPTAP_BRIDGE_META } from "./collab/bindings/tiptap-ytext";
import type { HeadingNumberingSettings } from "./markdown-heading-numbering";
import { applyTiptapStructuralNumbers } from "./tiptap-editor-actions";

export const tiptapHeadingNumberingKey = new PluginKey<HeadingNumberingSettings>("liberaHeadingNumbering");

const DISABLED: HeadingNumberingSettings = { enabled: false, skipTitle: true };

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
        const shrunk = newState.doc.content.size < oldState.doc.content.size;
        const protectPos = shrunk && newState.selection.empty ? newState.selection.from : undefined;
        const tr = applyTiptapStructuralNumbers(newState.tr, settings, protectPos);
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
