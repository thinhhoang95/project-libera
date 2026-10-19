// Changed ranges between two texts, on line or word boundaries. Pure: no
// CodeMirror or DOM imports, so the collab host and the suggestion model can
// use it (moved from src/lib/latex/codemirror/review.ts).

const MAX_DIFF_CELLS = 2_000_000;

function tokenize(text: string, mode: "line" | "word") {
  if (mode === "line") return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return text.match(/\s+|[A-Za-z0-9\u00C0-\uFFFF]+|\\[A-Za-z@]+|[\s\S]/g) ?? [];
}

export type TextHunk = { fromA: number; toA: number; fromB: number; toB: number };
type Hunk = TextHunk;

/** Changed ranges between `a` and `b`, on line or word boundaries. */
export function diffTexts(a: string, b: string): Hunk[] {
  const mode = a.includes("\n") || b.includes("\n") ? "line" : "word";
  if (mode === "line" && (!a.endsWith("\n") || !b.endsWith("\n"))) {
    // Compare complete lines, so a last line without its newline still
    // matches the same line followed by more text.
    const clip = (hunk: Hunk): Hunk => ({
      fromA: Math.min(hunk.fromA, a.length), toA: Math.min(hunk.toA, a.length),
      fromB: Math.min(hunk.fromB, b.length), toB: Math.min(hunk.toB, b.length),
    });
    return diffTexts(a.endsWith("\n") ? a : `${a}\n`, b.endsWith("\n") ? b : `${b}\n`)
      .map(clip)
      .filter((hunk) => hunk.fromA !== hunk.toA || hunk.fromB !== hunk.toB);
  }
  const tokensA = tokenize(a, mode);
  const tokensB = tokenize(b, mode);
  let start = 0;
  while (start < tokensA.length && start < tokensB.length && tokensA[start] === tokensB[start]) start++;
  let endA = tokensA.length;
  let endB = tokensB.length;
  while (endA > start && endB > start && tokensA[endA - 1] === tokensB[endB - 1]) { endA--; endB--; }
  const offsetsA = [0];
  for (const token of tokensA) offsetsA.push(offsetsA.at(-1)! + token.length);
  const offsetsB = [0];
  for (const token of tokensB) offsetsB.push(offsetsB.at(-1)! + token.length);

  const n = endA - start;
  const m = endB - start;
  if (!n && !m) return [];
  if (n * m > MAX_DIFF_CELLS || !n || !m) return [{ fromA: offsetsA[start], toA: offsetsA[endA], fromB: offsetsB[start], toB: offsetsB[endB] }];

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = tokensA[start + i] === tokensB[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: { i: number; j: number } | null = null;
  const close = () => {
    if (!open) return;
    hunks.push({ fromA: offsetsA[start + open.i], toA: offsetsA[start + i], fromB: offsetsB[start + open.j], toB: offsetsB[start + j] });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && tokensA[start + i] === tokensB[start + j]) {
      close();
      i++; j++;
    } else {
      open ??= { i, j };
      if (j < m && (i >= n || table[i * width + j + 1] >= table[(i + 1) * width + j])) j++;
      else i++;
    }
  }
  close();

  // In word mode, merge hunks separated only by whitespace, which read better as one.
  if (mode === "word") {
    const merged: Hunk[] = [];
    for (const hunk of hunks) {
      const last = merged.at(-1);
      if (last && /^\s{0,2}$/.test(a.slice(last.toA, hunk.fromA)) && a.slice(last.toA, hunk.fromA) === b.slice(last.toB, hunk.fromB)) {
        last.toA = hunk.toA;
        last.toB = hunk.toB;
      } else merged.push({ ...hunk });
    }
    return merged;
  }
  return hunks;
}
