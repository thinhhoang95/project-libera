import { EditorState } from "@codemirror/state";
import { provenanceOf, type ProvenanceExpansion } from "../../macros/expand";
import { visualConfig } from "./model";
import type { FigureContent, FigureSpec } from "./widgets";

/* Structure a macro writes, edited at its call (docs/features/latex-visual-editor.md, "Macros that write structure").
 * `\newcommand{\tbl}[2]{\begin{table}\caption{#1}#2\end{table}}` and `\tbl{My caption}{\begin{tabular}…}` is drawn as
 * the table its expansion is. Where a part of the drawing (the caption, a tabular) is one of the call's arguments put in
 * unchanged, it is placed at that argument's text in the document (expand.ts `expandMacroUseWithProvenance`): the table's
 * cells are edited there, through the same cell editor as any table, and a click on the caption puts the cursor in the
 * argument. What the definition writes stays read-only: a click shows the call's source, and its definition is named. */

/** A throwaway state holding an expansion, read by the walk's float reader as if it were a document (same settings). */
export function expansionState(state: EditorState, text: string) {
  return EditorState.create({ doc: text, extensions: [visualConfig.of(state.facet(visualConfig))] });
}

/**
 * A float spec read from a macro's expansion, placed at the call `[from, to)` drawn over `range`: numbers are at the
 * call (numbering.ts numbers an expansion there); a tabular or caption copied from an argument is placed at that
 * argument's text, editable; anything else is read-only. `spec` positions are offsets in the expansion.
 */
export function placeAtCall(spec: FigureSpec, expansion: ProvenanceExpansion, from: number, range: { from: number; to: number }): FigureSpec {
  const place = (content: FigureContent): FigureContent => {
    const caption = content.caption;
    const captionAt = caption ? provenanceOf(expansion, content.captionPos, content.captionPos + caption.length) : null;
    return {
      ...content,
      numberOffset: from - range.from,
      captionPos: captionAt === null ? from : from + captionAt,
      ...(captionAt !== null && caption ? { captionSource: { from: from + captionAt - range.from, to: from + captionAt + caption.length - range.from } } : {}),
      tabulars: content.tabulars?.map((tabular) => {
        const at = tabular.readOnly ? null : provenanceOf(expansion, tabular.offset, tabular.offset + tabular.source.length);
        return at === null ? { ...tabular, offset: from - range.from, readOnly: true } : { ...tabular, offset: from + at - range.from };
      }),
    };
  };
  return {
    ...spec,
    ...place(spec),
    panels: spec.panels?.map(place),
    start: from,
    length: range.to - range.from,
  };
}
