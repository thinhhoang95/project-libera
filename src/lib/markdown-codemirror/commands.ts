import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, type EditorState, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { Direction, type Command, type EditorView } from "@codemirror/view";
import {
  changeSelectedHeadingLevels,
  getChangedTextRange,
  type HeadingLevelChangeDirection,
  type MarkdownFormat,
  sourceFormatEdit,
} from "@/lib/markdown-source";
import { createMarkdownBoxInsertion, MARKDOWN_BOX_SHORTCUTS } from "@/lib/markdown-boxes";
import type { TextareaLikeEdit } from "./textarea-adapter";

/* Source editing commands for the CodeMirror Markdown editor. Each one computes
 * exactly the text and selection the textarea editor produces (the helpers it
 * uses are shared with markdown-editor.tsx and the workspace), then applies it
 * as a single CodeMirror transaction. */

const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));

/** A textarea-style edit (replace a range, then select a range) as one
 * CodeMirror transaction and one undo step, like one native `insertText`. */
export function textareaEditSpec(state: EditorState, edit: TextareaLikeEdit): TransactionSpec {
  const length = state.doc.length;
  const from = clamp(Math.min(edit.selectionStart, edit.selectionEnd), length);
  const to = clamp(Math.max(edit.selectionStart, edit.selectionEnd), length);
  const nextLength = length - (to - from) + state.toText(edit.replacement).length;
  return {
    changes: { from, to, insert: edit.replacement },
    selection: EditorSelection.single(clamp(edit.nextSelectionStart, nextLength), clamp(edit.nextSelectionEnd, nextLength)),
    annotations: isolateHistory.of("full"),
    userEvent: "input.libera",
  };
}

export function applyTextareaEdit(view: EditorView, edit: TextareaLikeEdit) {
  view.dispatch(textareaEditSpec(view.state, edit));
}

/** Native Home (Cmd+Left on macOS) goes to the visual line boundary,
 * including its leading whitespace; CodeMirror's standard command toggles
 * between indentation, wrap points and the logical line start. */
export function sourceLineStart(extend = false, visualLeft = false): Command {
  return (view) => {
    const selection = EditorSelection.create(view.state.selection.ranges.map((range) => {
      const forward = visualLeft && view.textDirectionAt(range.head) === Direction.RTL;
      const moved = view.moveToLineBoundary(range, forward);
      return extend ? EditorSelection.range(range.anchor, moved.head, moved.goalColumn, moved.bidiLevel ?? undefined, moved.assoc) : moved;
    }), view.state.selection.mainIndex);
    if (selection.eq(view.state.selection)) return false;
    view.dispatch({ selection, userEvent: "select", scrollIntoView: true });
    return true;
  };
}

/** The toolbar's insertion (`onInsert(before, after, placeholder)`): wraps the
 * selection, or the placeholder when nothing is selected. A box prefix such as
 * `y> ` with no closing marker boxes the current or selected lines instead.
 * This is the computation `insertMarkdown` in use-libera-workspace.ts makes. */
export function markdownInsertEdit(
  draft: string,
  selection: { start: number; end: number },
  before: string,
  after = "",
  placeholder = "text",
): TextareaLikeEdit {
  let start = selection.start;
  let end = selection.end;
  const selectedText = draft.slice(start, end) || placeholder;
  let replacement = `${before}${selectedText}${after}`;
  let nextSelectionStart = start + before.length;
  let nextSelectionEnd = nextSelectionStart + selectedText.length;
  const boxMarker = new RegExp(`^([${MARKDOWN_BOX_SHORTCUTS}]?)> $`, "i").exec(before);
  if (boxMarker && !after) {
    const box = createMarkdownBoxInsertion(draft, start, end, boxMarker[1], placeholder);
    start = box.selectionStart;
    end = box.selectionEnd;
    replacement = box.replacement;
    nextSelectionStart = box.nextSelectionStart;
    nextSelectionEnd = box.nextSelectionEnd;
  }
  return { selectionStart: start, selectionEnd: end, replacement, nextSelectionStart, nextSelectionEnd };
}

export function markdownInsertCommand(before: string, after = "", placeholder = "text"): StateCommand {
  return ({ state, dispatch }) => {
    const { from, to } = state.selection.main;
    dispatch(state.update(textareaEditSpec(state, markdownInsertEdit(state.doc.toString(), { start: from, end: to }, before, after, placeholder))));
    return true;
  };
}

/** Cmd/Ctrl+B, I and U: the textarea editor's `applyMarkdownFormat`. */
export function markdownFormatCommand({ before, after, placeholder = "text" }: MarkdownFormat): StateCommand {
  return ({ state, dispatch }) => {
    const { from, to } = state.selection.main;
    dispatch(state.update(textareaEditSpec(state, sourceFormatEdit(state.doc.toString(), from, to, { before, after, placeholder }))));
    return true;
  };
}

/** Tab / Shift+Tab and the context menu's Indent/Unindent Headings. Returns
 * false when the selection holds no heading, so Tab keeps its usual meaning. */
export function changeHeadingLevels(
  view: EditorView,
  direction: HeadingLevelChangeDirection,
  range?: { start: number; end: number },
) {
  const { state } = view;
  const current = state.doc.toString();
  const start = range?.start ?? state.selection.main.from;
  const end = range?.end ?? state.selection.main.to;
  const result = changeSelectedHeadingLevels(current, start, end, direction);
  if (!result.hasHeading) return false;
  if (result.changed) {
    view.dispatch(textareaEditSpec(state, {
      ...getChangedTextRange(current, result.nextValue),
      nextSelectionStart: result.nextStart,
      nextSelectionEnd: result.nextEnd,
    }));
  }
  return true;
}

export { sourcePasteEdit, fileLinkDestinationAt } from "@/lib/markdown-source";
export type { SourceClipboard } from "@/lib/markdown-source";
