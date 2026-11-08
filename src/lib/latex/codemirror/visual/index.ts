import { Compartment, EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { visualKeys } from "./keys";
import { closeMathSessions, mathSessionTracker } from "./math-edit";
import { pasteHtmlAsLatex } from "./paste";
import { closeTableSessions, installTableEditor } from "./table-edit";
import { visualConfig, visualStateFields, type VisualConfig } from "./model";
import { linkClicks, numberingPlugin, pendingFiller, remoteOutlines } from "./plugins";
import { structuralField } from "./structural";
import { visualStylePlugin } from "./style";

/* The LaTeX Visual mode: a layer of decorations over the same editor and the
 * same document (docs/latex-visual-editor-plan.md). Switching it on or off
 * reconfigures a compartment; the document and the undo history are not
 * touched. */

export { visualStateFields };
export { setAuxData, setMacroSources, setNumberingIncludes, setNumberingStart, type MacroSource } from "./model";
export { rebuildVisualEffect } from "./structural";
export { visualRevealRanges } from "./structural";
export { toggleLatexFormat, isFormatActive } from "./keys";

/** State the Visual mode reads (definitions, numbering, `.aux` labels): installed in both modes, so switching keeps it. */
export function latexVisualState(): Extension {
  return visualStateFields;
}

/** Formula and table editors and menus belong to the view in the Visual mode: they close with it (tab closed, mode switched off). */
const widgetEditorLifecycle = ViewPlugin.define((view) => ({
  destroy() {
    closeMathSessions(view);
    closeTableSessions(view);
  },
}));

export function latexVisualMode(config: Partial<VisualConfig>): Extension {
  return [
    visualConfig.of(config),
    widgetEditorLifecycle,
    structuralField,
    visualStylePlugin,
    numberingPlugin,
    pendingFiller,
    linkClicks,
    remoteOutlines,
    visualKeys(),
    mathSessionTracker,
    pasteHtmlAsLatex,
    installTableEditor(),
    EditorView.editorAttributes.of({ class: "cm-latex-visual" }),
    EditorView.contentAttributes.of({ "aria-roledescription": "LaTeX visual editor" }),
  ];
}

export const visualCompartment = new Compartment();

/** Whether the Visual mode is switched on in this state. */
export function isVisualModeOn(state: EditorState) {
  const current = visualCompartment.get(state);
  return Array.isArray(current) ? current.length > 0 : !!current;
}

/** Where the cursor goes when Visual mode starts: out of the folded preamble. */
export function visualEntrySelection(state: EditorState) {
  const head = state.selection.main.head;
  const begin = /\\begin\s*\{document\}/.exec(state.doc.sliceString(0, Math.min(state.doc.length, 400_000)));
  if (!begin) return null;
  const bodyStart = begin.index + begin[0].length;
  const line = state.doc.lineAt(bodyStart);
  // Body text on the `\begin{document}` line is not folded: the cursor goes before it.
  const rest = state.doc.sliceString(bodyStart, line.to).trim() ? bodyStart : null;
  if (head > line.to || (rest !== null && head >= rest)) return null;
  return EditorSelection.cursor(rest ?? Math.min(state.doc.length, line.to + 1));
}
