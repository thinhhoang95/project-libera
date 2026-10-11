import { ChangeSet, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/* Line numbers in the PDF (SyncTeX) and in the compile log refer to the text
 * that was compiled. The editor keeps that text and the edits made since, so
 * jumps and diagnostics land on the right line while the user keeps typing. */

export const markCompileStarted = StateEffect.define<null>();
export const markCompileShown = StateEffect.define<null>();

type CompileMapping = {
  pendingDoc: Text | null;
  pending: ChangeDesc | null;
  shownDoc: Text | null;
  shown: ChangeDesc | null;
};

export const compileMappingField = StateField.define<CompileMapping>({
  create: () => ({ pendingDoc: null, pending: null, shownDoc: null, shown: null }),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && (value.pending || value.shown)) {
      next = {
        ...next,
        pending: next.pending ? next.pending.composeDesc(tr.changes.desc) : null,
        shown: next.shown ? next.shown.composeDesc(tr.changes.desc) : null,
      };
    }
    for (const effect of tr.effects) {
      if (effect.is(markCompileStarted)) next = { ...next, pendingDoc: tr.state.doc, pending: ChangeSet.empty(tr.state.doc.length).desc };
      if (effect.is(markCompileShown) && next.pendingDoc) next = { ...next, shownDoc: next.pendingDoc, shown: next.pending };
    }
    return next;
  },
});

/** The compiled line and column for a position in the current text. */
export function compiledLocationForPosition(state: EditorState, pos: number) {
  const mapping = state.field(compileMappingField, false);
  if (mapping?.shown && mapping.shownDoc) {
    const compiledPos = Math.min(mapping.shownDoc.length, mapping.shown.invertedDesc.mapPos(pos));
    const line = mapping.shownDoc.lineAt(compiledPos);
    return { line: line.number, column: compiledPos - line.from };
  }
  const line = state.doc.lineAt(pos);
  return { line: line.number, column: pos - line.from };
}

/** The current position of a compiled line (and optional column). */
export function positionForCompiledLine(state: EditorState, lineNumber: number, column = 0) {
  const mapping = state.field(compileMappingField, false);
  if (mapping?.shown && mapping.shownDoc) {
    const line = mapping.shownDoc.line(Math.max(1, Math.min(mapping.shownDoc.lines, lineNumber)));
    return mapping.shown.mapPos(Math.min(line.to, line.from + Math.max(0, column)), 1);
  }
  const line = state.doc.line(Math.max(1, Math.min(state.doc.lines, lineNumber)));
  return Math.min(line.to, line.from + Math.max(0, column));
}

/* ---- A brief highlight on the line a jump landed on ------------------------ */

export const flashLine = StateEffect.define<number | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(flashLine)) continue;
      value = effect.value === null ? Decoration.none : Decoration.set([Decoration.line({ class: "cm-latex-sync-flash" }).range(tr.state.doc.lineAt(effect.value).from)]);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function revealPosition(view: EditorView, pos: number, options: { select?: boolean } = {}) {
  view.dispatch({
    selection: options.select === false ? undefined : { anchor: pos },
    effects: [EditorView.scrollIntoView(pos, { y: "center" }), flashLine.of(pos)],
  });
  window.setTimeout(() => {
    if (view.dom.isConnected) view.dispatch({ effects: flashLine.of(null) });
  }, 1400);
}

export function latexSyncExtension(): Extension {
  return [compileMappingField, flashField];
}
