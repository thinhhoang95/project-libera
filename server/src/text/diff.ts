// Minimal forward edits between two strings (Myers' O(ND) diff on UTF-16 code
// units). Restore, suggestion decisions and revert apply their changes as
// these edits instead of replacing whole ranges: unchanged characters keep
// their Yjs identity, so comment anchors, suggestion anchors and other
// clients' concurrent edits next to them survive.

export interface TextEdit {
  /** Offset in the old text. */
  start: number;
  /** Code units of the old text removed at `start`. */
  deleteCount: number;
  /** Text inserted at `start`. */
  insert: string;
}

/**
 * Past this many differences the middle part is replaced as one edit. The
 * trace costs O(D²) memory; a diff this large is a rewrite anyway, and the
 * common prefix and suffix are still kept.
 */
const MAX_EDIT_DISTANCE = 4000;

/** Edits that turn `before` into `after`, sorted by start and non-overlapping. */
export function diffText(before: string, after: string): TextEdit[] {
  if (before === after) return [];
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const edits = myers(a, b).map((edit) => ({ ...edit, start: edit.start + prefix }));
  return keepSurrogatePairs(before, edits);
}

function myers(a: string, b: string): TextEdit[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [{ start: 0, deleteCount: n, insert: b }];
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  // v[k + offset] is the furthest x reached on diagonal k. trace[d] is a copy
  // of v for k in [-d, d] after step d, used to walk the path back.
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? v[k + 1 + offset] : v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < n && y < m && a.charCodeAt(x) === b.charCodeAt(y)) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (found < 0) return [{ start: 0, deleteCount: n, insert: b }];

  // Walk back from (n, m); each step is one insertion or deletion preceded by a snake.
  const ops: Array<{ insert: boolean; x: number; y: number }> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d - 1];
    const at = (k: number) => previous[k + d - 1];
    const k = x - y;
    const insertion = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = insertion ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    ops.push({ insert: insertion, x: prevX, y: prevY });
    x = prevX;
    y = prevY;
  }
  ops.reverse();

  const edits: TextEdit[] = [];
  for (const op of ops) {
    const last = edits.at(-1);
    const touches = last !== undefined && last.start + last.deleteCount === op.x;
    if (op.insert) {
      if (touches) last.insert += b[op.y];
      else edits.push({ start: op.x, deleteCount: 0, insert: b[op.y] });
    } else if (touches) {
      last.deleteCount += 1;
    } else {
      edits.push({ start: op.x, deleteCount: 1, insert: "" });
    }
  }
  return edits;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Widens edits that would split a surrogate pair, so a Y.Text never holds
 * half a character. The widened part is equal in both texts; edits that
 * touch after widening are merged and their insert recomputed from the
 * original edits.
 */
function keepSurrogatePairs(before: string, edits: TextEdit[]): TextEdit[] {
  const splitsAt = (index: number) =>
    index > 0 && index < before.length && isHigh(before.charCodeAt(index - 1)) && isLow(before.charCodeAt(index));
  const widened = edits.map((edit) => {
    let start = edit.start;
    let end = edit.start + edit.deleteCount;
    if (splitsAt(start) || (start > 0 && isHigh(before.charCodeAt(start - 1)) && isLow(edit.insert.charCodeAt(0)))) start -= 1;
    if (splitsAt(end) || (end < before.length && isLow(before.charCodeAt(end)) && isHigh(edit.insert.charCodeAt(edit.insert.length - 1)))) end += 1;
    return { start, end, edit };
  });
  if (widened.every(({ start, end, edit }) => start === edit.start && end === edit.start + edit.deleteCount)) return edits;

  const result: TextEdit[] = [];
  let group: typeof widened = [];
  const flush = () => {
    if (group.length === 0) return;
    const start = group[0].start;
    const end = Math.max(...group.map((entry) => entry.end));
    const local = group.map(({ edit }) => ({ ...edit, start: edit.start - start }));
    result.push({ start, deleteCount: end - start, insert: applyEdits(before.slice(start, end), local) });
    group = [];
  };
  for (const entry of widened) {
    const groupEnd = group.length > 0 ? Math.max(...group.map((item) => item.end)) : -1;
    if (group.length > 0 && entry.start > groupEnd) flush();
    group.push(entry);
  }
  flush();
  return result;
}

/** Applies sorted, non-overlapping edits to a string. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let result = "";
  let cursor = 0;
  for (const edit of edits) {
    result += text.slice(cursor, edit.start) + edit.insert;
    cursor = edit.start + edit.deleteCount;
  }
  return result + text.slice(cursor);
}
