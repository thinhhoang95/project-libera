// Minimal text edits between two strings, for turning an edit made on disk
// (or a reconciled text) into CRDT operations.
//
// Replacing the whole text would be "correct" but would destroy concurrent
// remote edits, comment anchors and suggestion overlays in the untouched
// parts. So the diff runs on lines (Myers), and each changed hunk is then
// narrowed to the characters that actually differ. The host bundle stays free
// of CodeMirror: @codemirror/merge would pull @codemirror/view into the
// utility process just for its diff.

export interface TextReplacement {
  /** UTF-16 offsets in the old text. */
  start: number;
  end: number;
  text: string;
}

/** Past this many edit steps the line diff gives up and replaces the changed middle. */
const MAX_EDIT_STEPS = 2000;

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

/**
 * Pairs of equal line indexes (a, b) on a shortest edit script, in order, or
 * null when the edit distance exceeds maxSteps. Classic Myers with one saved
 * frontier per step, trimmed to the diagonals that step can reach.
 */
function matchingLines(a: number[], b: number[], maxSteps: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxSteps); d += 1) {
    trace.push(frontier.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])) x = frontier[offset + k + 1];
      else x = frontier[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const saved = trace[d];
    const at = (k: number) => saved[k + d + 1];
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    matches.push([x, y]);
  }
  return matches.reverse();
}

/** Narrows one replacement to the characters that differ. */
function narrow(oldText: string, newText: string, start: number): TextReplacement | null {
  let prefix = 0;
  const limit = Math.min(oldText.length, newText.length);
  while (prefix < limit && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  // Never split a surrogate pair: Y.Text positions are UTF-16 units, and half
  // a pair on each side of an edit would corrupt the character.
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix -= 1;
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix -= 1;
  if (prefix === oldText.length && prefix === newText.length) return null;
  return {
    start: start + prefix,
    end: start + oldText.length - suffix,
    text: newText.slice(prefix, newText.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Replacements that turn `before` into `after`, sorted by position and not
 * overlapping. Apply them from last to first so earlier offsets stay valid.
 */
export function diffText(before: string, after: string): TextReplacement[] {
  if (before === after) return [];
  const whole = narrow(before, after, 0);
  if (!whole) return [];
  // Diff only the region that differs; equal head and tail never need lines.
  const oldMiddle = before.slice(whole.start, whole.end);
  const newMiddle = whole.text;
  const oldLines = splitLines(oldMiddle);
  const newLines = splitLines(newMiddle);
  if (oldLines.length <= 1 || newLines.length <= 1) return [whole];

  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const a = oldLines.map(intern);
  const b = newLines.map(intern);
  const matches = matchingLines(a, b, MAX_EDIT_STEPS);
  if (!matches) return [whole];

  const oldOffsets = [0];
  for (const line of oldLines) oldOffsets.push(oldOffsets[oldOffsets.length - 1] + line.length);
  const newOffsets = [0];
  for (const line of newLines) newOffsets.push(newOffsets[newOffsets.length - 1] + line.length);

  const edits: TextReplacement[] = [];
  let previousA = 0;
  let previousB = 0;
  const flush = (untilA: number, untilB: number) => {
    if (untilA === previousA && untilB === previousB) return;
    const oldText = oldMiddle.slice(oldOffsets[previousA], oldOffsets[untilA]);
    const newText = newMiddle.slice(newOffsets[previousB], newOffsets[untilB]);
    const edit = narrow(oldText, newText, whole.start + oldOffsets[previousA]);
    if (edit) edits.push(edit);
  };
  for (const [lineA, lineB] of matches) {
    flush(lineA, lineB);
    previousA = lineA + 1;
    previousB = lineB + 1;
  }
  flush(oldLines.length, newLines.length);
  return edits;
}

/** Applies replacements produced by diffText (tests and the reconciliation preview). */
export function applyReplacements(text: string, edits: readonly TextReplacement[]): string {
  let result = text;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}
