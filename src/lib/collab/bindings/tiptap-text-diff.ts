// Character-level text operations for the Visual-editor block bridge.
//
// The bridge never replaces a block's source wholesale: it diffs the old and
// new source of the blocks a transaction touched and sends only the changed
// characters to Y.Text. Small, precise operations keep concurrent edits by
// other participants inside the same block (Yjs merges them by character).

/** Replace `from..to` of the old text with `insert`. Positions are UTF-16 offsets. */
export interface TextOp {
  from: number;
  to: number;
  insert: string;
}

/** A Y.Text delta entry (see `Y.YTextEvent.delta`). Embeds are not used for source text. */
export type TextDelta = { retain?: number; insert?: string | object; delete?: number }[];

/** Above this edit distance the middle of the diff is sent as one replacement. */
const MAX_EDIT_DISTANCE = 256;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Minimal operations turning `a` into `b`: common prefix and suffix are
 * trimmed, then a Myers diff (bounded by MAX_EDIT_DISTANCE) splits the middle
 * into separate hunks. Hunk boundaries never split a surrogate pair: Yjs
 * encodes strings as UTF-8, so a lone surrogate would arrive as U+FFFD.
 */
export function diffText(a: string, b: string): TextOp[] {
  if (a === b) return [];
  let start = 0;
  const minLength = Math.min(a.length, b.length);
  while (start < minLength && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
  const hunks = myers(a, b, start, endA, start, endB);
  return mergeHunks(alignSurrogates(a, b, hunks)).map(([fromA, toA, fromB, toB]) => ({ from: fromA, to: toA, insert: b.slice(fromB, toB) }));
}

type Hunk = [fromA: number, toA: number, fromB: number, toB: number];

// O(ND) Myers diff over the trimmed middle. Returns changed hunks in order.
function myers(a: string, b: string, a0: number, a1: number, b0: number, b1: number): Hunk[] {
  const n = a1 - a0, m = b1 - b0;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [[a0, a1, b0, b1]];
  // Huge blocks (a pasted 1 MB code block) only get a few hunks: the cost is O((n + m) · D).
  const max = Math.min(n + m, n + m > 100_000 ? 8 : MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a.charCodeAt(a0 + x) === b.charCodeAt(b0 + y)) { x++; y++; }
      next[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    v = next;
  }
  if (found < 0) return [[a0, a1, b0, b1]];
  // Walk the trace backwards to recover the edit path.
  const edits: ("=" | "-" | "+")[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { edits.push("="); x--; y--; }
    if (x === prevX) { edits.push("+"); y--; } else { edits.push("-"); x--; }
  }
  while (x > 0 && y > 0) { edits.push("="); x--; y--; }
  edits.reverse();
  const hunks: Hunk[] = [];
  let ia = a0, ib = b0;
  for (const edit of edits) {
    if (edit === "=") { ia++; ib++; continue; }
    const last = hunks.at(-1);
    if (last && last[1] === ia && last[3] === ib) {
      if (edit === "-") last[1]++; else last[3]++;
    } else hunks.push(edit === "-" ? [ia, ia + 1, ib, ib] : [ia, ia, ib, ib + 1]);
    if (edit === "-") ia++; else ib++;
  }
  return hunks;
}

function alignSurrogates(a: string, b: string, hunks: Hunk[]): Hunk[] {
  const splits = (text: string, index: number) => index > 0 && index < text.length && isHigh(text.charCodeAt(index - 1)) && isLow(text.charCodeAt(index));
  for (const hunk of hunks) {
    // Text outside a hunk is equal in a and b, so both sides grow together.
    while (hunk[0] > 0 && hunk[2] > 0 && (splits(a, hunk[0]) || splits(b, hunk[2]))) { hunk[0]--; hunk[2]--; }
    while (hunk[1] < a.length && hunk[3] < b.length && (splits(a, hunk[1]) || splits(b, hunk[3]))) { hunk[1]++; hunk[3]++; }
  }
  return hunks;
}

function mergeHunks(hunks: Hunk[]): Hunk[] {
  const merged: Hunk[] = [];
  for (const hunk of hunks) {
    const last = merged.at(-1);
    if (last && hunk[0] <= last[1]) {
      last[1] = Math.max(last[1], hunk[1]);
      last[3] = Math.max(last[3], hunk[3]);
    } else merged.push([...hunk]);
  }
  return merged;
}

/** Applies sorted, non-overlapping operations given in `text`'s coordinates. */
export function applyTextOps(text: string, ops: readonly TextOp[]): string {
  let result = "";
  let cursor = 0;
  for (const op of ops) {
    result += text.slice(cursor, op.from) + op.insert;
    cursor = op.to;
  }
  return result + text.slice(cursor);
}

/**
 * Maps an offset in the old text through simultaneous operations. With
 * `assoc > 0` the offset moves after text inserted exactly at it.
 */
export function mapOffset(ops: readonly TextOp[], pos: number, assoc = -1): number {
  let shift = 0;
  for (const op of ops) {
    if (pos < op.from || (pos === op.from && op.from === op.to && assoc <= 0)) break;
    if (pos === op.from && op.from < op.to) return op.from + shift + (assoc > 0 ? op.insert.length : 0);
    if (pos < op.to) return op.from + shift + (assoc > 0 ? op.insert.length : 0);
    shift += op.insert.length - (op.to - op.from);
  }
  return pos + shift;
}

/**
 * Rebases `local` (base → ours) over `remote` (base → theirs) so that it applies
 * to theirs. Local deletions only remove base characters that survived the
 * remote change, so text inserted remotely is never deleted by a stale local
 * diff. A local insertion at the same place as a remote one lands after it.
 */
export function rebaseOps(local: readonly TextOp[], remote: readonly TextOp[]): TextOp[] {
  const result: TextOp[] = [];
  for (const op of local) {
    const pieces: [number, number][] = [];
    let cursor = op.from;
    for (const r of remote) {
      // A remote deletion ending at the cursor no longer matters; a remote
      // insertion inside the range splits it so the inserted text survives.
      if (r.to < cursor || (r.to === cursor && r.from < r.to)) continue;
      if (r.from >= op.to) break;
      // Base characters before this remote operation survive.
      if (r.from > cursor) pieces.push([cursor, r.from]);
      cursor = Math.max(cursor, r.to);
    }
    if (cursor < op.to) pieces.push([cursor, op.to]);
    const mapped: TextOp[] = pieces.map(([from, to]) => ({ from: mapOffset(remote, from, 1), to: mapOffset(remote, to, -1), insert: "" })).filter((piece) => piece.to > piece.from);
    if (op.insert) {
      const at = mapOffset(remote, op.from, 1);
      const first = mapped[0];
      // Fold the insertion into the first deletion when they start together.
      if (first && first.from === at) first.insert = op.insert;
      else mapped.push({ from: at, to: at, insert: op.insert });
    }
    result.push(...mapped);
  }
  return result.sort((x, y) => x.from - y.from || x.to - y.to);
}

/** Converts a Y.Text delta into simultaneous operations in the old text's coordinates. */
export function deltaToOps(delta: TextDelta): TextOp[] {
  const ops: TextOp[] = [];
  let pos = 0;
  for (const part of delta) {
    if (part.retain !== undefined) pos += part.retain;
    else if (part.insert !== undefined) {
      const insert = typeof part.insert === "string" ? part.insert : "";
      const last = ops.at(-1);
      if (last && last.to === pos) last.insert += insert;
      else ops.push({ from: pos, to: pos, insert });
    } else if (part.delete !== undefined) {
      const last = ops.at(-1);
      if (last && last.to === pos) last.to += part.delete;
      else ops.push({ from: pos, to: pos + part.delete, insert: "" });
      pos += part.delete;
    }
  }
  return ops;
}
