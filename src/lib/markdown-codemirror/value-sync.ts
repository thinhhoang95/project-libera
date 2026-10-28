import { Annotation, type ChangeDesc, type EditorState, type TransactionSpec } from "@codemirror/state";

/* Applying a new draft from the workspace to a CodeMirror document.
 *
 * The workspace hands the Source editor whole strings (`tab.draft`). Replacing
 * the whole document on every outside change would reset the caret, scroll
 * anchors and undo history, and on a shared tab it would clobber concurrent
 * edits. Every outside value is therefore applied as the smallest replacement
 * that turns the current text into the new one. */

export type TextChange = { from: number; to: number; insert: string };

/** Marks transactions that mirror an outside value (or a review result) rather
 * than a keystroke, so the editor does not publish them back as a new draft. */
export const markdownValueSync = Annotation.define<"value" | "review">();

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The common-prefix/common-suffix difference between two strings, or null when
 * they are equal. The boundaries never split a UTF-16 surrogate pair, so an
 * emoji is replaced whole rather than leaving half a character in the change. */
export function minimalTextChange(current: string, next: string): TextChange | null {
  if (current === next) return null;
  let prefix = 0;
  const maxPrefix = Math.min(current.length, next.length);
  while (prefix < maxPrefix && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && isHighSurrogate(current.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  const maxSuffix = Math.min(current.length, next.length) - prefix;
  while (
    suffix < maxSuffix &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) suffix++;
  if (suffix > 0 && isLowSurrogate(current.charCodeAt(current.length - suffix))) suffix--;
  return {
    from: prefix,
    to: current.length - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

/** Moves a change computed against an older text onto the current document,
 * through the changes made since then. An insertion lands after text inserted
 * concurrently at the same spot; a replaced range shrinks to what still exists. */
export function rebaseTextChange(change: TextChange, since: ChangeDesc | null): TextChange {
  if (!since || since.empty) return change;
  if (change.from === change.to) {
    const at = since.mapPos(change.from, 1);
    return { from: at, to: at, insert: change.insert };
  }
  const from = since.mapPos(change.from, 1);
  const to = Math.max(from, since.mapPos(change.to, -1));
  return { from, to, insert: change.insert };
}

/** True when a change would rewrite every character of a non-empty document. */
export function replacesWholeDocument(change: TextChange, length: number) {
  return length > 0 && change.from === 0 && change.to === length;
}

/** The transaction that turns `state`'s document into `next` with a minimal
 * change. Selection and history are kept: CodeMirror maps the selection
 * through the change, and the change stays undoable like any other edit. */
export function valueChangeSpec(state: EditorState, next: string, source: "value" | "review" = "value"): TransactionSpec | null {
  const change = minimalTextChange(state.doc.toString(), state.toText(next).toString());
  if (!change) return null;
  return { changes: change, annotations: markdownValueSync.of(source) };
}
