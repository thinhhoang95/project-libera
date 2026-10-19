import { isolateHistory } from "@codemirror/commands";
import { EditorSelection, type EditorState, type StateCommand, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  changeSelectedHeadingLevels,
  getChangedTextRange,
  type HeadingLevelChangeDirection,
  type MarkdownFormat,
} from "@/components/libera/markdown-editor";
import { createMarkdownBoxInsertion, MARKDOWN_BOX_SHORTCUTS } from "@/lib/markdown-boxes";
import { convertClipboardHtmlToMarkdown } from "@/lib/markdown-clipboard";
import { smartPasteMarkdown, type SmartPasteMode } from "@/lib/markdown-smart-paste";
import type { MathMarkerSettings } from "@/lib/math-markers";
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
  const nextLength = length - (to - from) + edit.replacement.length;
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
    const selectedText = state.sliceDoc(from, to) || placeholder;
    const nextSelectionStart = from + before.length;
    dispatch(state.update(textareaEditSpec(state, {
      selectionStart: from,
      selectionEnd: to,
      replacement: `${before}${selectedText}${after}`,
      nextSelectionStart,
      nextSelectionEnd: nextSelectionStart + selectedText.length,
    })));
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

export type SourceClipboard = { html: string; markdown: string; plain: string };

/** What a text paste does in the Source editor: rich HTML becomes Libera
 * Markdown, `text/markdown` is used as is, and Smart Paste places pasted
 * headings under ("child", Ctrl+V) or beside ("peer") the heading before them.
 * Null means "let the editor paste the plain text itself", the same cases in
 * which the textarea leaves the paste to the browser; `insertPlain` (a paste
 * from the right-click menu, with no browser paste behind it) inserts the
 * plain text instead. */
export function sourcePasteEdit(
  current: string,
  selection: { start: number; end: number },
  clipboard: SourceClipboard,
  options: { insertPlain?: boolean; mathMarkers?: MathMarkerSettings; smartPaste?: SmartPasteMode | false } = {},
): TextareaLikeEdit | null {
  let replacement = clipboard.markdown;
  if (!replacement && clipboard.html) {
    try {
      replacement = convertClipboardHtmlToMarkdown(clipboard.html, options.mathMarkers);
    } catch {
      // Preserve the plain-text fallback for malformed clipboard HTML.
      if (!options.smartPaste && !options.insertPlain) return null;
    }
  }
  const { start, end } = selection;
  const smartPasted = options.smartPaste
    ? smartPasteMarkdown(current, { end, start }, replacement || clipboard.plain, options.smartPaste)
    : null;
  if (!replacement && !smartPasted) {
    if (!options.insertPlain || !clipboard.plain) return null;
    replacement = clipboard.plain;
  }
  const nextSelection = smartPasted?.selection.start ?? start + replacement.length;
  const edit = smartPasted
    ? getChangedTextRange(current, smartPasted.value)
    : { replacement, selectionEnd: end, selectionStart: start };
  return { ...edit, nextSelectionStart: nextSelection, nextSelectionEnd: nextSelection };
}

/** The file-link picker opens while the caret sits in a link destination,
 * `[label](here`, on one line. This is the textarea editor's test. */
export function fileLinkDestinationAt(text: string, cursor: number) {
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const beforeCursor = text.slice(lineStart, cursor);
  const linkOpenIndex = beforeCursor.lastIndexOf("](");
  if (linkOpenIndex < 0) return null;
  if (beforeCursor.lastIndexOf("[", linkOpenIndex) < 0) return null;
  const destinationStart = lineStart + linkOpenIndex + 2;
  const destination = text.slice(destinationStart, cursor);
  if (destination.includes("\n") || destination.includes(")")) return null;
  return { destinationStart, destinationEnd: cursor, query: destination.replace(/^</, "") };
}
