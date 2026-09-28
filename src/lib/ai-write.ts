/** Where a new Markdown block goes for a caret at `offset`: the caret's line when
 * it is blank, otherwise the end of the paragraph (or list) containing it, so the
 * new text never splits an existing block. */
export function findMarkdownBlockInsertionOffset(value: string, offset: number) {
  let position = offset === 0 ? 0 : value.lastIndexOf("\n", offset - 1) + 1;
  while (position < value.length) {
    const newline = value.indexOf("\n", position);
    const lineEnd = newline < 0 ? value.length : newline;
    if (!value.slice(position, lineEnd).trim()) break;
    position = newline < 0 ? value.length : newline + 1;
  }
  return position;
}

/** Insert `markdown` as its own block, separated by blank lines from its neighbours. */
export function insertMarkdownBlock(value: string, position: number, markdown: string) {
  const text = markdown.trim();
  const before = value.slice(0, position);
  const after = value.slice(position);
  const leading = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trailing = after ? "\n" : "";
  const start = position + leading.length;
  return {
    value: `${before}${leading}${text}${trailing}${after}`,
    start,
    end: start + text.length,
  };
}
