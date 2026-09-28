import { Extension, isActive } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { MARKDOWN_DEFAULT_HIGHLIGHT_COLOR } from "./markdown-colors";

type HighlightToolState = { active: boolean; color: string };
export const highlightToolKey = new PluginKey<HighlightToolState>("liberaHighlightTool");
export const defaultHighlightToolState: HighlightToolState = {
  active: false, color: MARKDOWN_DEFAULT_HIGHLIGHT_COLOR.value,
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    highlightTool: {
      setHighlightToolColor: (color: string) => ReturnType;
      setHighlightToolActive: (active: boolean) => ReturnType;
      toggleHighlightTool: () => ReturnType;
      applyHighlightTool: () => ReturnType;
    };
  }
}

export const HighlightTool = Extension.create({
  name: "highlightTool",
  // Override the highlight mark's shortcut with the persistent tool toggle.
  priority: 1100,
  addCommands() {
    return {
      toggleHighlightTool: () => ({ state, chain }) => {
        const tool = highlightToolKey.getState(state) ?? defaultHighlightToolState;
        // A selected highlight can be removed even when paint mode is off.
        if (tool.active || isActive(state, "highlight")) {
          return chain().setHighlightToolActive(false).unsetHighlight().run();
        }
        return chain().setHighlightToolActive(true).run();
      },
      setHighlightToolColor: (color) => ({ tr, dispatch }) => {
        if (dispatch) tr.setMeta(highlightToolKey, { color });
        return true;
      },
      setHighlightToolActive: (active) => ({ state, tr, dispatch }) => {
        if (dispatch) {
          const tool = highlightToolKey.getState(state) ?? defaultHighlightToolState;
          tr.setMeta(highlightToolKey, { active });
          if (active && tr.selection instanceof TextSelection && !tr.selection.empty) {
            tr.addMark(tr.selection.from, tr.selection.to, state.schema.marks.highlight.create({ color: tool.color }));
          }
          // Turning off must not erase highlights from the selected text.
          if (!active) tr.removeStoredMark(state.schema.marks.highlight);
        }
        return true;
      },
      applyHighlightTool: () => ({ state, tr, dispatch }) => {
        const tool = highlightToolKey.getState(state) ?? defaultHighlightToolState;
        if (!tool.active || !(tr.selection instanceof TextSelection) || tr.selection.empty) return false;
        if (dispatch) tr.addMark(tr.selection.from, tr.selection.to, state.schema.marks.highlight.create({ color: tool.color }));
        return true;
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-h": () => this.editor.commands.toggleHighlightTool(),
      Escape: () => highlightToolKey.getState(this.editor.state)?.active
        ? this.editor.commands.setHighlightToolActive(false) : false,
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin<HighlightToolState>({
      key: highlightToolKey,
      state: {
        init: () => defaultHighlightToolState,
        apply: (tr, tool) => {
          const update = tr.getMeta(highlightToolKey) as Partial<HighlightToolState> | undefined;
          return update ? { ...tool, ...update } : tool;
        },
      },
      appendTransaction(_transactions, _oldState, state) {
        const tool = highlightToolKey.getState(state)!;
        if (!(state.selection instanceof TextSelection) || !state.selection.empty) return;
        const type = state.schema.marks.highlight;
        const marks = state.storedMarks ?? state.selection.$from.marks();
        const current = type.isInSet(marks);
        if (tool.active && state.selection.$from.parent.type.allowsMarkType(type)) {
          if (current?.attrs.color !== tool.color) return state.tr.addStoredMark(type.create({ color: tool.color }));
        } else if (current) {
          return state.tr.removeStoredMark(type);
        }
      },
      view(view) {
        let frame: number | undefined;
        // Paint the final selection after the browser/ProseMirror finish it,
        // rather than painting every intermediate range during a drag.
        const applySelection = (event: Event) => {
          if (event instanceof KeyboardEvent && !["Shift", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "a", "A"].includes(event.key)) return;
          if (!view.hasFocus() || !highlightToolKey.getState(view.state)?.active) return;
          if (frame !== undefined) cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            frame = undefined;
            if (!editor.isDestroyed && view.hasFocus()) editor.commands.applyHighlightTool();
          });
        };
        const document = view.dom.ownerDocument;
        document.addEventListener("pointerup", applySelection);
        document.addEventListener("keyup", applySelection);
        return { destroy() {
          if (frame !== undefined) cancelAnimationFrame(frame);
          document.removeEventListener("pointerup", applySelection);
          document.removeEventListener("keyup", applySelection);
        } };
      },
    })];
  },
});
