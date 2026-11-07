import { Compartment, EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { visualKeys } from "./keys";
import { mathSessionTracker } from "./math-edit";
import { pasteHtmlAsLatex } from "./paste";
import { installTableEditor } from "./table-edit";
import { visualConfig, visualStateFields, type VisualConfig } from "./model";
import { linkClicks, numberingPlugin, pendingFiller, remoteOutlines } from "./plugins";
import { structuralField } from "./structural";
import { visualStylePlugin } from "./style";

/* The LaTeX Visual mode: a layer of decorations over the same editor and the
 * same document (docs/latex-visual-editor-plan.md). Switching it on or off
 * reconfigures a compartment; the document and the undo history are not
 * touched. */

export { visualStateFields };
export { setAuxData, setMacroSources, setNumberingStart, type MacroSource } from "./model";
export { visualRevealRanges } from "./structural";
export { toggleLatexFormat, isFormatActive } from "./keys";

/** State the Visual mode reads (definitions, numbering, `.aux` labels): installed in both modes, so switching keeps it. */
export function latexVisualState(): Extension {
  return visualStateFields;
}

export function latexVisualMode(config: Partial<VisualConfig>): Extension {
  return [
    visualConfig.of(config),
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

/** Where the cursor goes when Visual mode starts: out of the folded preamble. */
export function visualEntrySelection(state: EditorState) {
  const head = state.selection.main.head;
  const begin = /\\begin\s*\{document\}/.exec(state.doc.sliceString(0, Math.min(state.doc.length, 400_000)));
  if (!begin) return null;
  const line = state.doc.lineAt(begin.index + begin[0].length);
  if (head > line.to) return null;
  return EditorSelection.cursor(Math.min(state.doc.length, line.to + 1));
}
