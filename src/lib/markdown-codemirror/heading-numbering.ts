import { isolateHistory } from "@codemirror/commands";
import { Annotation, EditorSelection, type EditorState, type Transaction } from "@codemirror/state";
import { ySyncAnnotation } from "y-codemirror.next";
import {
  getMarkdownHeadingNumberingChanges,
  mapOffsetThroughTextChanges,
  type HeadingNumberingSettings,
} from "@/lib/markdown-heading-numbering";
import { markdownValueSync } from "./value-sync";

/** Marks the editor's own renumbering. */
export const headingNumberingAnnotation = Annotation.define<boolean>();

/** Outside values, collaboration changes and history must keep their text. */
export function isHeadingNumberingEdit(tr: Transaction) {
  return tr.docChanged &&
    tr.annotation(markdownValueSync) === undefined &&
    tr.annotation(ySyncAnnotation) === undefined &&
    !tr.annotation(headingNumberingAnnotation) &&
    !tr.isUserEvent("undo") && !tr.isUserEvent("redo");
}

/** Append renumbering as its own undo step, in the same view update. A
 * transaction filter would merge both edits into a single history event. */
export function headingNumberingTransactions(transactions: readonly Transaction[], settings: HeadingNumberingSettings): readonly Transaction[] {
  const last = transactions.at(-1);
  const edit = transactions.filter((tr) => tr.docChanged).at(-1);
  if (!last || !edit || !isHeadingNumberingEdit(edit)) return transactions;
  const main = last.newSelection.main;
  const shrunk = edit.newDoc.length < edit.startState.doc.length;
  const spec = headingNumberingSpec(last.state, settings, shrunk && main.empty ? main.head : undefined);
  return spec ? [...transactions, last.state.update(spec)] : transactions;
}

/** The renumbering after an edit or settings change, or null when numbering
 * is disabled or the headings are already in order. */
export function headingNumberingSpec(state: EditorState, settings: HeadingNumberingSettings, deletionCaret?: number) {
  if (!settings.enabled) return null;
  const changes = getMarkdownHeadingNumberingChanges(state.doc.toString(), settings, deletionCaret);
  if (!changes.length) return null;
  const map = (offset: number) => mapOffsetThroughTextChanges(offset, changes);
  return {
    annotations: [headingNumberingAnnotation.of(true), isolateHistory.of("full")],
    userEvent: "input.numbering",
    changes,
    selection: EditorSelection.create(
      state.selection.ranges.map((range) => EditorSelection.range(map(range.anchor), map(range.head))),
      state.selection.mainIndex,
    ),
  };
}
