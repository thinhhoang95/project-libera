import { diffText } from "../../../../electron/collab/notebooks/text-diff";

/**
 * Three-way merge of a note's text. `mine` and `theirs` both started from
 * `base`; the result is `theirs` with only my changes applied. Where we
 * changed the same words, theirs stay and mine go after them: losing a few
 * characters of overlap is worse than showing both.
 */
export function mergeText(base: string, mine: string, theirs: string): string {
  if (mine === base) return theirs;
  if (theirs === base || mine === theirs) return mine;
  const remote = diffText(base, theirs);
  const offsetInTheirs = (offset: number) => {
    let shift = 0;
    for (const edit of remote) {
      if (edit.end <= offset) shift += edit.text.length - (edit.end - edit.start);
      // Inside what they replaced: past their text.
      else if (edit.start < offset) return edit.start + shift + edit.text.length;
      else break;
    }
    return offset + shift;
  };
  let merged = theirs;
  // Back to front, so earlier offsets stay valid.
  for (const edit of [...diffText(base, mine)].reverse()) {
    const start = offsetInTheirs(edit.start);
    const end = Math.max(start, offsetInTheirs(edit.end));
    merged = merged.slice(0, start) + edit.text + merged.slice(end);
  }
  return merged;
}
