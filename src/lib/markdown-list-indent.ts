/* Indent / outdent Markdown list items in the Source editor, the way the
 * visual editor's sinkListItem / liftListItem move them: the item under the
 * caret (or every selected item) moves with its nested lines, an ordered item
 * is renumbered to fit its new list, and an item with no previous sibling
 * cannot be indented. Tab is taken by heading levels, so this runs from the
 * toolbar. */

export type ListIndentDirection = "indent" | "outdent";

export type ListIndentResult = {
  nextValue: string;
  nextStart: number;
  nextEnd: number;
  /** The changed span of `value`, for a minimal textarea/CodeMirror edit. */
  changed: { selectionStart: number; selectionEnd: number; replacement: string };
};

const LIST_ITEM = /^([ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+|$)/;

type Line = { text: string; indent: number; item: RegExpExecArray | null; blank: boolean };

function readLine(text: string): Line {
  const blank = !text.trim();
  return { text, indent: blank ? 0 : text.length - text.trimStart().length, item: LIST_ITEM.exec(text), blank };
}

/** The nearest earlier list item at `indent`, searching up from `from` and
 * stopping at anything shallower (the end of that list). */
function findSibling(lines: Line[], from: number, indent: number) {
  for (let index = from; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.blank || line.indent > indent) continue;
    if (line.indent === indent && line.item) return line;
    return null;
  }
  return null;
}

function findParent(lines: Line[], from: number, indent: number) {
  for (let index = from; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.blank || line.indent >= indent) continue;
    return line.item ? line : null;
  }
  return null;
}

export function shiftMarkdownListItems(
  value: string,
  start: number,
  end: number,
  direction: ListIndentDirection,
): ListIndentResult | null {
  const from = Math.max(0, Math.min(start, end, value.length));
  const to = Math.max(0, Math.min(Math.max(start, end), value.length));
  const texts = value.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const text of texts) {
    lineStarts.push(offset);
    offset += text.length + 1;
  }
  const lineAt = (pos: number) => {
    let index = 0;
    while (index + 1 < lineStarts.length && lineStarts[index + 1] <= pos) index += 1;
    return index;
  };
  const lines = texts.map(readLine);
  const first = lineAt(from);
  // A selection ending at the start of a line does not include that line.
  const last = Math.max(first, to > from && lineStarts[lineAt(to)] === to ? lineAt(to) - 1 : lineAt(to));

  let anchor = -1;
  let minIndent = Infinity;
  for (let index = first; index <= last; index += 1) {
    if (!lines[index].item) continue;
    if (anchor < 0) anchor = index;
    minIndent = Math.min(minIndent, lines[index].indent);
  }
  if (anchor < 0) return null;
  const anchorIndent = lines[anchor].indent;

  let delta: number;
  if (direction === "indent") {
    const sibling = findSibling(lines, anchor - 1, anchorIndent);
    if (!sibling?.item) return null;
    // Nest under the sibling's text: two spaces under "- ", three under "1. ".
    delta = sibling.item[1].length + sibling.item[2].length + Math.max(1, sibling.item[5].length) - anchorIndent;
  } else {
    if (anchorIndent === 0) return null;
    delta = (findParent(lines, anchor - 1, anchorIndent)?.indent ?? 0) - anchorIndent;
  }
  if (!delta) return null;

  // Nested lines below the last selected item move with it.
  let blockEnd = last;
  for (let index = last + 1; index < lines.length; index += 1) {
    if (!lines[index].blank && lines[index].indent <= minIndent) break;
    if (!lines[index].blank) blockEnd = index;
  }

  // Each changed line replaces its first `oldPrefix` characters with `newPrefix` ones.
  const edits = new Map<number, { oldPrefix: number; newPrefix: number }>();
  for (let index = anchor; index <= blockEnd; index += 1) {
    const line = lines[index];
    if (line.blank) continue;
    const removed = Math.min(line.indent, Math.max(0, -delta));
    const next = delta > 0 ? " ".repeat(delta) + line.text : line.text.slice(removed);
    if (next === line.text) continue;
    edits.set(index, { oldPrefix: line.indent, newPrefix: line.indent + (delta > 0 ? delta : -removed) });
    lines[index] = readLine(next);
  }

  // Renumber the moved ordered item to follow its new previous sibling, or
  // to start a new nested list at 1.
  const moved = lines[anchor];
  if (moved.item?.[3]) {
    const sibling = findSibling(lines, anchor - 1, moved.indent);
    const number = sibling?.item?.[3] ? Number(sibling.item[3]) + 1 : direction === "indent" ? 1 : null;
    if (number !== null && String(number) !== moved.item[3]) {
      const markerStart = moved.item[1].length;
      const text = `${moved.text.slice(0, markerStart)}${number}${moved.text.slice(markerStart + moved.item[3].length)}`;
      const edit = edits.get(anchor) ?? { oldPrefix: moved.indent, newPrefix: moved.indent };
      edits.set(anchor, {
        oldPrefix: edit.oldPrefix + moved.item[2].length,
        newPrefix: edit.newPrefix + String(number).length + moved.item[4].length,
      });
      lines[anchor] = readLine(text);
    }
  }

  const nextValue = lines.map((line) => line.text).join("\n");
  const nextLineStarts: number[] = [];
  offset = 0;
  for (const line of lines) {
    nextLineStarts.push(offset);
    offset += line.text.length + 1;
  }
  const mapPosition = (pos: number) => {
    const index = lineAt(pos);
    const column = pos - lineStarts[index];
    const edit = edits.get(index);
    if (!edit) return nextLineStarts[index] + column;
    const shift = edit.newPrefix - edit.oldPrefix;
    const nextColumn = column >= edit.oldPrefix ? column + shift : Math.max(0, Math.min(column + shift, edit.newPrefix));
    return nextLineStarts[index] + nextColumn;
  };
  let prefix = 0;
  while (prefix < value.length && prefix < nextValue.length && value[prefix] === nextValue[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < value.length - prefix && suffix < nextValue.length - prefix && value[value.length - 1 - suffix] === nextValue[nextValue.length - 1 - suffix]) suffix += 1;
  return {
    nextValue,
    nextStart: mapPosition(from),
    nextEnd: mapPosition(to),
    changed: { selectionStart: prefix, selectionEnd: value.length - suffix, replacement: nextValue.slice(prefix, nextValue.length - suffix) },
  };
}
