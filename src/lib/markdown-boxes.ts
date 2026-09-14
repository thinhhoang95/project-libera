import { getMarkdownHighlightColorByShortcut, MARKDOWN_HIGHLIGHT_COLORS } from "./markdown-colors";

export const MARKDOWN_BOX_SHORTCUTS = MARKDOWN_HIGHLIGHT_COLORS.map((color) => color.shortcut).join("");
export const MARKDOWN_BOX_PREFIX = new RegExp(`^ {0,3}([${MARKDOWN_BOX_SHORTCUTS}])>(?!>) ?`, "i");

export function markdownBoxStyle(shortcut: string) {
  const color = getMarkdownHighlightColorByShortcut(shortcut);
  return color ? { backgroundColor: color.value, color: color.foreground, borderColor: color.value } : undefined;
}

/** Apply a box to whole source lines, replacing an existing outer box marker. */
export function createMarkdownBoxInsertion(source: string, start: number, end: number, shortcut: string, placeholder = "Box text") {
  const selectionStart = start === 0 ? 0 : source.lastIndexOf("\n", start - 1) + 1;
  // A selection ending at the start of a line does not include that line.
  const lastSelected = end > start && source[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = source.indexOf("\n", lastSelected);
  const selectionEnd = lineEnd < 0 ? source.length : lineEnd;
  const prefix = `${getMarkdownHighlightColorByShortcut(shortcut)?.shortcut ?? ""}>`;
  const oldPrefix = new RegExp(`^( {0,3})(?:[${MARKDOWN_BOX_SHORTCUTS}])?>(?!>) ?`, "i");
  const text = source.slice(selectionStart, selectionEnd) || placeholder;
  const boxed = text.split("\n").map((line) => `${prefix} ${line.replace(oldPrefix, "$1")}`).join("\n");
  // Separate the box from adjacent paragraphs so CommonMark's lazy quote
  // continuation cannot pull an unselected following line into it.
  const leading = selectionStart > 0 && source[selectionStart - 2] !== "\n" ? "\n" : "";
  const trailing = selectionEnd < source.length && source[selectionEnd + 1] !== "\n" ? "\n" : "";
  const replacement = leading + boxed + trailing;
  return { selectionStart, selectionEnd, replacement,
    nextSelectionStart: selectionStart + leading.length + prefix.length + 1,
    nextSelectionEnd: selectionStart + leading.length + boxed.length };
}
