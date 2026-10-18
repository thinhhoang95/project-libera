import { getCodeMirrorTextareaAdapter } from "./markdown-codemirror/textarea-adapter";

type UndoableTextareaEdit = {
  nextSelectionEnd: number;
  nextSelectionStart: number;
  replacement: string;
  scrollLeft?: number;
  scrollTop?: number;
  selectionEnd: number;
  selectionStart: number;
};

export function replaceTextareaSelectionWithUndo(
  textarea: HTMLTextAreaElement,
  {
    nextSelectionEnd,
    nextSelectionStart,
    replacement,
    scrollLeft,
    scrollTop,
    selectionEnd,
    selectionStart,
  }: UndoableTextareaEdit,
) {
  // The CodeMirror Source editor stands behind the same ref; it applies the
  // edit as one CodeMirror undo step instead of a native textarea insertion.
  const codeMirror = getCodeMirrorTextareaAdapter(textarea);
  if (codeMirror) {
    return codeMirror.replaceSelectionWithUndo({ nextSelectionEnd, nextSelectionStart, replacement, scrollLeft, scrollTop, selectionEnd, selectionStart });
  }

  if (typeof document.execCommand !== "function") {
    return false;
  }

  let inputFired = false;
  const markInputFired = () => {
    inputFired = true;
  };

  textarea.focus();
  textarea.setSelectionRange(selectionStart, selectionEnd);
  textarea.addEventListener("input", markInputFired, { once: true });

  if (!document.execCommand("insertText", false, replacement)) {
    textarea.removeEventListener("input", markInputFired);
    return false;
  }

  textarea.removeEventListener("input", markInputFired);

  textarea.setSelectionRange(nextSelectionStart, nextSelectionEnd);

  if (typeof scrollTop === "number") {
    textarea.scrollTop = scrollTop;
  }

  if (typeof scrollLeft === "number") {
    textarea.scrollLeft = scrollLeft;
  }

  if (!inputFired) {
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  return true;
}
