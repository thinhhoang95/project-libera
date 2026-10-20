import { Annotation, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { ySyncAnnotation } from "y-codemirror.next";
import {
  getMarkdownHeadingNumberingChanges,
  mapOffsetThroughTextChanges,
  type HeadingNumberingSettings,
} from "@/lib/markdown-heading-numbering";

/** Marks the renumbering the editor makes when numbering is switched on. */
export const headingNumberingAnnotation = Annotation.define<boolean>();

/**
 * Structural heading numbering in the CodeMirror Source editor: while the
 * document is numbered, every local edit renumbers the headings in the same
 * transaction (one undo step), so typing `## ` becomes `## 2.1 `. Remote
 * (collaboration) changes and undo/redo are left as they are.
 */
export function headingNumberingExtension(read: () => HeadingNumberingSettings): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    const settings = read();
    if (
      !settings.enabled ||
      tr.annotation(ySyncAnnotation) !== undefined ||
      tr.annotation(headingNumberingAnnotation) ||
      tr.isUserEvent("undo") ||
      tr.isUserEvent("redo")
    ) return tr;
    const shrunk = tr.newDoc.length < tr.startState.doc.length;
    const main = tr.newSelection.main;
    const changes = getMarkdownHeadingNumberingChanges(
      tr.newDoc.toString(),
      settings,
      shrunk && main.empty ? main.head : undefined,
    );
    if (!changes.length) return tr;
    const map = (offset: number) => mapOffsetThroughTextChanges(offset, changes);
    const selection = EditorSelection.create(
      tr.newSelection.ranges.map((range) => EditorSelection.range(map(range.anchor), map(range.head))),
      tr.newSelection.mainIndex,
    );
    return [tr, { changes, selection, sequential: true }];
  });
}

/** The renumbering to dispatch when numbering is switched on (or its title
 * setting changes), or null when the headings are already in order. */
export function headingNumberingSpec(state: EditorState, settings: HeadingNumberingSettings) {
  const changes = getMarkdownHeadingNumberingChanges(state.doc.toString(), settings);
  if (!changes.length) return null;
  const map = (offset: number) => mapOffsetThroughTextChanges(offset, changes);
  return {
    annotations: headingNumberingAnnotation.of(true),
    changes,
    selection: EditorSelection.create(
      state.selection.ranges.map((range) => EditorSelection.range(map(range.anchor), map(range.head))),
      state.selection.mainIndex,
    ),
  };
}
