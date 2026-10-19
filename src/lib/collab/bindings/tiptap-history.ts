// Undo routing for Visual editors bound to a shared Y.Text.
//
// On a shared tab, undo must go through the bridge's Y.UndoManager, which only
// tracks this user's own changes. ProseMirror's history would also revert the
// local view of remote edits it never recorded, and then push that "undo" to
// everyone as a new edit. The extension below is always safe to install: while
// no bridge is bound it falls back to Tiptap's own history.

import { Extension, type Editor } from "@tiptap/core";
import { redo as historyRedo, undo as historyUndo } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export interface CollabHistoryTarget {
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
}

const targets = new WeakMap<Editor, CollabHistoryTarget>();

/** Routes the editor's undo/redo to `target` (a bridge), or back to Tiptap history with null. */
export function setCollabHistoryTarget(editor: Editor, target: CollabHistoryTarget | null) {
  if (target) targets.set(editor, target);
  else targets.delete(editor);
}

export function collabHistoryTarget(editor: Editor): CollabHistoryTarget | undefined {
  return targets.get(editor);
}

export const collabHistoryPluginKey = new PluginKey("liberaCollabHistory");
export const collabHistoryKeymapKey = new PluginKey("liberaCollabHistoryKeymap");

// Keep ProseMirror history empty while bound, so nothing can undo a remote edit.
function historyFilterPlugin(editor: Editor, key = collabHistoryPluginKey) {
  return new Plugin({
    key,
    filterTransaction(tr) {
      if (targets.has(editor)) tr.setMeta("addToHistory", false);
      return true;
    },
  });
}

function shortcut(editor: Editor, redo: boolean) {
  return () => {
    const target = targets.get(editor);
    if (!target) return false;
    if (redo) target.redo();
    else target.undo();
    // Even with nothing to undo, do not fall through to ProseMirror history.
    return true;
  };
}

/**
 * Install in the Visual editor's extensions. While a bridge is bound it maps
 * Mod-z / Mod-Shift-z / Mod-y and the `undo`/`redo` commands (used by the
 * toolbar and by Tiptap's own history keymap) to the bridge's UndoManager, and
 * stops ProseMirror history from recording. The priority is below the default
 * so these commands override Tiptap's `undoRedo` commands of the same name.
 */
export const TiptapCollabHistory = Extension.create({
  name: "liberaCollabHistory",
  priority: 90,
  addCommands() {
    return {
      undo: () => ({ state, dispatch, tr }) => {
        const target = targets.get(this.editor);
        if (!target) return historyUndo(state, dispatch);
        if (!dispatch) return target.canUndo();
        // The bridge dispatches its own transaction; the command's would be stale.
        tr.setMeta("preventDispatch", true);
        return target.undo();
      },
      redo: () => ({ state, dispatch, tr }) => {
        const target = targets.get(this.editor);
        if (!target) return historyRedo(state, dispatch);
        if (!dispatch) return target.canRedo();
        tr.setMeta("preventDispatch", true);
        return target.redo();
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-z": shortcut(this.editor, false),
      "Shift-Mod-z": shortcut(this.editor, true),
      "Mod-y": shortcut(this.editor, true),
    };
  },
  addProseMirrorPlugins() {
    return [historyFilterPlugin(this.editor)];
  },
});

/** Equivalent plugins for editors created without the extension (registered by the bridge). */
export function collabHistoryFallbackPlugins(editor: Editor): Plugin[] {
  const keys = keymap({ "Mod-z": shortcut(editor, false), "Shift-Mod-z": shortcut(editor, true), "Mod-y": shortcut(editor, true) });
  // keymap() cannot take a key; wrap it so the bridge can unregister it again.
  const keyed = new Plugin({ key: collabHistoryKeymapKey, props: keys.props });
  return [keyed, historyFilterPlugin(editor, new PluginKey("liberaCollabHistoryFallback"))];
}
