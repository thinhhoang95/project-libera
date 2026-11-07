import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Prec, type Extension, type SelectionRange, type Transaction } from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { wrapSelection } from "../editing";
import { argumentInner } from "./render-fragment";
import { constructAt, forceRevealEffect, structuralField } from "./structural";
import { revealSourceAt, setMathOpener, type MathOpener } from "./widgets";

/* Keyboard behaviour of the Visual mode (docs/latex-visual-editor-plan.md
 * §6.5–6.6). Every command here either moves the selection or writes the
 * smallest change that does what the key means. */

const FORMAT_NODES: Record<string, string> = {
  textbf: "TextBoldCommand", textit: "TextItalicCommand", emph: "EmphasisCommand", underline: "UnderlineCommand",
  texttt: "TextTeletypeCommand", textsc: "TextSmallCapsCommand", textsf: "TextSansSerifCommand", textmd: "TextMediumCommand",
  sout: "StrikeOutCommand", textsuperscript: "TextSuperscriptCommand", textsubscript: "TextSubscriptCommand",
};

/** The `\command{…}` around a selection range, when there is one. */
export function enclosingFormat(state: EditorState, command: string, range: { from: number; to: number }): { node: SyntaxNode; inner: { from: number; to: number } } | null {
  const name = FORMAT_NODES[command];
  if (!name) return null;
  const tree = syntaxTree(state);
  for (let node: SyntaxNode | null = tree.resolveInner(range.from, 1); node; node = node.parent) {
    if (node.name !== name || node.from > range.from || node.to < range.to) continue;
    const ctrl = node.firstChild;
    if (!ctrl || state.sliceDoc(ctrl.from, ctrl.to) !== `\\${command}`) continue;
    const argument = node.getChild("TextArgument") ?? node.getChild("ShortTextArgument");
    const inner = argument && argumentInner(argument);
    if (inner) return { node, inner };
  }
  return null;
}

/**
 * Bold, italic and the other wrappers: inside an existing `\textbf{…}` (with
 * the cursor anywhere in it) the wrapper is removed; otherwise the selection
 * is wrapped.
 */
export function toggleLatexFormat(command: string): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const ranges = view.state.selection.ranges;
    const found = ranges.map((range) => enclosingFormat(view.state, command, range));
    if (found.every((item) => !item)) return wrapSelection(command)(view);
    view.dispatch(view.state.changeByRange((range) => {
      const item = enclosingFormat(view.state, command, range);
      if (!item) return { range };
      const opening = item.inner.from - item.node.from;
      const changes = [{ from: item.node.from, to: item.inner.from }, { from: item.inner.to, to: item.node.to }];
      const map = (pos: number) => (pos <= item.node.from ? pos : pos <= item.inner.from ? item.node.from : pos <= item.inner.to ? pos - opening : item.inner.to - opening);
      return { changes, range: EditorSelection.range(map(range.anchor), map(range.head)) };
    }), { userEvent: "input.visual.format", scrollIntoView: true });
    return true;
  };
}

/** Whether a toolbar button for `command` should show as active at the cursor. */
export function isFormatActive(state: EditorState, command: string) {
  return !!enclosingFormat(state, command, state.selection.main);
}

const SELECT_FIRST = new Set(["math", "cite", "ref", "label", "figure", "table", "macro", "image", "title"]);

/** The construct a replace decoration belongs to. */
function constructOf(state: EditorState, cid: number, pos: number) {
  let found: { kind: string; from: number; to: number } | null = null;
  state.field(structuralField, false)?.extents.between(pos, pos, (from, to, mark) => { if (mark.id === cid) found = { kind: mark.kind, from, to }; });
  return found as { kind: string; from: number; to: number } | null;
}

/** The drawn construct ending at (backward) or starting at (forward) the cursor. */
function adjacentWidget(state: EditorState, pos: number, forward: boolean) {
  const shown = state.field(structuralField, false)?.shown;
  if (!shown) return null;
  let found: { from: number; to: number } | null = null;
  shown.between(pos, pos, (from, to, decoration) => {
    if (!decoration.spec.widget || from === to) return;
    if ((forward ? from === pos : to === pos)) {
      const construct = constructOf(state, decoration.spec.cid, pos);
      if (construct && SELECT_FIRST.has(construct.kind)) found = { from: construct.from, to: construct.to };
    }
  });
  return found as { from: number; to: number } | null;
}

/** Backspace or Delete next to a formula or chip selects it first; the next press deletes it. */
function selectBeforeDelete(forward: boolean): Command {
  return (view) => {
    const range = view.state.selection.main;
    if (!range.empty || view.state.selection.ranges.length > 1) return false;
    const widget = adjacentWidget(view.state, range.head, forward);
    if (!widget) return false;
    view.dispatch({ selection: EditorSelection.range(forward ? widget.from : widget.to, forward ? widget.to : widget.from), userEvent: "select" });
    return true;
  };
}

let mathOpener: MathOpener | null = null;
/** math-edit.ts registers MathLive here and with the widgets. */
export function registerMathOpener(opener: MathOpener | null) {
  mathOpener = opener;
  setMathOpener(opener);
}

/** Enter on a selected formula opens its editor; on another selected widget, shows its source. */
const openSelected: Command = (view) => {
  const range = view.state.selection.main;
  if (range.empty) return false;
  const construct = constructAt(view.state, range.from + 1);
  if (!construct || construct.from !== range.from || construct.to !== range.to || !SELECT_FIRST.has(construct.kind)) return false;
  if (construct.kind === "math" && mathOpener?.(view, construct.from, construct.to)) return true;
  revealSourceAt(view, construct.from, construct.to);
  return true;
};

/** Alt+Enter: the source of the construct at the cursor, until the cursor leaves it. */
const revealHere: Command = (view) => {
  const head = view.state.selection.main.head;
  const construct = constructAt(view.state, head);
  if (!construct) return false;
  view.dispatch({ effects: forceRevealEffect.of(construct.id) });
  return true;
};

/**
 * Cursor positions that would put typing in the wrong place: after a
 * heading's hidden `}` (typing would leave the heading), and before a
 * bullet. The cursor moves to the nearest good position, in the direction it
 * was going.
 */
const cursorFixes = EditorState.transactionFilter.of((tr: Transaction) => {
  if (tr.docChanged || !tr.selection) return tr;
  const value = tr.startState.field(structuralField, false);
  if (!value) return tr;
  const state = tr.startState;
  const previous = state.selection.main.head;
  let changed = false;
  const ranges = tr.selection.ranges.map((range): SelectionRange => {
    if (!range.empty) return range;
    const head = range.head;
    let target = head;
    // All decorations: the construct may be revealed only because of where the cursor was.
    value.decorations.between(head, head, (from, to, decoration) => {
      if (target !== head) return;
      const construct = constructOf(state, decoration.spec.cid, from);
      if (!construct) return;
      if (construct.kind === "heading" && !decoration.spec.widget && to === head && to === construct.to) {
        // From the clamp point, moving on goes to the next line; anything else lands before the `}`.
        const line = state.doc.lineAt(head);
        target = previous === from && head > previous && head === line.to && line.to < state.doc.length ? line.to + 1 : from;
      } else if (construct.kind === "item" && from === head && from === state.doc.lineAt(from).from && to > from) {
        const line = state.doc.lineAt(from);
        target = previous === to && head < previous && line.from > 0 ? line.from - 1 : to;
      }
    });
    if (target === head) return range;
    changed = true;
    return EditorSelection.cursor(target);
  });
  return changed ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }] : tr;
});

/** A letter typed right after a hidden control word (`\ldots`) gets a space first, so the command name stays as it was. */
const spaceAfterControlWord = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || !/^[A-Za-z@]$/.test(text)) return false;
  const shown = view.state.field(structuralField, false)?.shown;
  if (!shown) return false;
  let hidden = false;
  shown.between(from, from, (start, end, decoration) => {
    if (end === from && start < end && decoration.spec.widget && /\\[A-Za-z@]+$/.test(view.state.sliceDoc(start, end))) hidden = true;
  });
  if (!hidden) return false;
  view.dispatch({ changes: { from, insert: ` ${text}` }, selection: { anchor: from + 1 + text.length }, userEvent: "input.type" });
  return true;
});

export function visualKeys(): Extension {
  return [
    Prec.highest(keymap.of([
      { key: "Mod-b", run: toggleLatexFormat("textbf") },
      { key: "Mod-i", run: toggleLatexFormat("textit") },
      { key: "Mod-u", run: toggleLatexFormat("underline") },
      { key: "Mod-Shift-e", run: toggleLatexFormat("emph") },
      { key: "Mod-Shift-t", run: toggleLatexFormat("texttt") },
      { key: "Backspace", run: selectBeforeDelete(false) },
      { key: "Delete", run: selectBeforeDelete(true) },
      { key: "Enter", run: openSelected },
      { key: "Alt-Enter", run: revealHere },
    ])),
    cursorFixes,
    spaceAfterControlWord,
  ];
}
