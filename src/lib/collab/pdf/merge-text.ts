import { diffText } from "../../../../electron/collab/notebooks/text-diff";

/** Applies my edits to surviving base characters, keeping concurrent inserted text. */
export function mergeText(base: string, mine: string, theirs: string): string {
  if (mine === base) return theirs;
  if (theirs === base || mine === theirs) return mine;
  const remote = diffText(base, theirs);
  const position = (offset: number) => {
    let shift = 0;
    for (const edit of remote) {
      if (edit.end <= offset) shift += edit.text.length - (edit.end - edit.start);
      else if (edit.start <= offset) return edit.start + shift + edit.text.length;
      else break;
    }
    return offset + shift;
  };
  const operations: Array<{ start: number; end: number; text: string }> = [];
  for (const local of diffText(base, mine)) {
    // Only unchanged spans still belong to the base; remote replacements and
    // insertions must survive even where both people replaced the same word.
    let cursor = 0;
    let shift = 0;
    for (const edit of [...remote, { start: base.length, end: base.length, text: "" }]) {
      const start = Math.max(local.start, cursor);
      const end = Math.min(local.end, edit.start);
      if (end > start) operations.push({ start: start + shift, end: end + shift, text: "" });
      cursor = edit.end;
      shift += edit.text.length - (edit.end - edit.start);
    }
    if (local.text) operations.push({ start: position(local.start), end: position(local.start), text: local.text });
  }
  let merged = theirs;
  for (const edit of operations.map((edit, order) => ({ ...edit, order })).sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order)) {
    merged = merged.slice(0, edit.start) + edit.text + merged.slice(edit.end);
  }
  return merged;
}
