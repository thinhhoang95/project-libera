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
 * Past this many character differences a hunk is replaced as one edit.
 * The Myers trace costs O(D²) Int32s: 512 keeps peak allocation around ~1 MB
 * (instead of 64 MB at 4000) and finishes in ~1 ms. Larger multi-line changes
 * are split by line-level Myers first so untouched lines keep their Yjs IDs.
 */
const MAX_CHAR_EDIT_DISTANCE = 512;
const MAX_LINE_EDIT_DISTANCE = 512;

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
  const raw = diffRegion(a, b, prefix);
  return keepSurrogatePairs(before, raw);
}

function diffRegion(a: string, b: string, baseOffset: number): TextEdit[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [{ start: baseOffset, deleteCount: n, insert: b }];
  if (n + m > MAX_CHAR_EDIT_DISTANCE && (a.includes("\n") || b.includes("\n"))) {
    const lineEdits = diffByLines(a, b, baseOffset);
    if (lineEdits) return lineEdits;
  }
  return myersChars(a, b).map((edit) => ({ ...edit, start: edit.start + baseOffset }));
}

function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function matchingLines(a: number[], b: number[], maxSteps: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > maxSteps) return null;
  const max = Math.min(n + m, maxSteps);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? v[k + 1 + offset] : v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
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
  if (found < 0) return null;

  const matches: Array<[number, number]> = [];
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
    // The snake after step (prevX, prevY) -> (midX, midY) holds equal lines.
    const midX = insertion ? prevX : prevX + 1;
    const midY = insertion ? prevY + 1 : prevY;
    while (x > midX && y > midY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    matches.push([x, y]);
  }
  return matches.reverse();
}

function diffByLines(a: string, b: string, baseOffset: number): TextEdit[] | null {
  const oldLines = splitLines(a);
  const newLines = splitLines(b);
  if (oldLines.length <= 1 || newLines.length <= 1) return null;
  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const matches = matchingLines(oldLines.map(intern), newLines.map(intern), MAX_LINE_EDIT_DISTANCE);
  if (!matches || matches.length === 0) return null;

  const oldOffsets = [0];
  for (const line of oldLines) oldOffsets.push(oldOffsets[oldOffsets.length - 1] + line.length);
  const newOffsets = [0];
  for (const line of newLines) newOffsets.push(newOffsets[newOffsets.length - 1] + line.length);

  const edits: TextEdit[] = [];
  let previousA = 0;
  let previousB = 0;
  const flush = (untilA: number, untilB: number) => {
    if (untilA === previousA && untilB === previousB) return;
    const oldSlice = a.slice(oldOffsets[previousA], oldOffsets[untilA]);
    const newSlice = b.slice(newOffsets[previousB], newOffsets[untilB]);
    if (oldSlice === newSlice) return;
    let prefix = 0;
    const limit = Math.min(oldSlice.length, newSlice.length);
    while (prefix < limit && oldSlice.charCodeAt(prefix) === newSlice.charCodeAt(prefix)) prefix += 1;
    let suffix = 0;
    while (
      suffix < limit - prefix &&
      oldSlice.charCodeAt(oldSlice.length - 1 - suffix) === newSlice.charCodeAt(newSlice.length - 1 - suffix)
    ) {
      suffix += 1;
    }
    const innerA = oldSlice.slice(prefix, oldSlice.length - suffix);
    const innerB = newSlice.slice(prefix, newSlice.length - suffix);
    const hunkOffset = baseOffset + oldOffsets[previousA] + prefix;
    for (const edit of myersChars(innerA, innerB)) {
      edits.push({ ...edit, start: edit.start + hunkOffset });
    }
  };
  for (const [lineA, lineB] of matches) {
    flush(lineA, lineB);
    previousA = lineA + 1;
    previousB = lineB + 1;
  }
  flush(oldLines.length, newLines.length);
  return edits;
}

function myersChars(a: string, b: string): TextEdit[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [{ start: 0, deleteCount: n, insert: b }];
  if (Math.abs(n - m) > MAX_CHAR_EDIT_DISTANCE) return [{ start: 0, deleteCount: n, insert: b }];
  const max = Math.min(n + m, MAX_CHAR_EDIT_DISTANCE);
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
