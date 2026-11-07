/* TeX tokens of a formula, and the smallest change that turns one formula
 * into another (docs/latex-visual-editor-plan.md §6.2). MathLive rewrites
 * formulas in its own style (`x^{2}` for `x^2`, its own spacing); comparing
 * in a canonical form keeps those rewrites out of the file, and only the
 * tokens that really changed are written. */

export type TexToken = { text: string; from: number; to: number };

/** Control words, control symbols, braces, other characters; spaces as one token. */
export function tokenizeTex(source: string): TexToken[] {
  const tokens: TexToken[] = [];
  for (let i = 0; i < source.length;) {
    const char = source[i];
    let end = i + 1;
    if (char === "\\") {
      const word = /^\\[A-Za-z@]+\*?/.exec(source.slice(i, i + 64));
      end = word ? i + word[0].length : Math.min(source.length, i + 2);
    } else if (/\s/.test(char)) {
      while (end < source.length && /\s/.test(source[end])) end++;
    } else {
      const code = source.codePointAt(i)!;
      end = i + (code > 0xffff ? 2 : 1);
    }
    tokens.push({ text: source.slice(i, end), from: i, to: end });
    i = end;
  }
  return tokens;
}

/** A canonical token; `outerFrom`/`outerTo` include the braces of a one-token group it was unwrapped from. */
type Canonical = { text: string; from: number; to: number; outerFrom: number; outerTo: number };

/**
 * The formula's tokens without spaces, and without braces around a single
 * token (`^{2}` reads as `^2`, `\frac{1}{2}` as `\frac12`): spellings TeX
 * typesets the same.
 */
export function canonicalTokens(source: string): Canonical[] {
  const tokens = tokenizeTex(source).filter((token) => !/^\s+$/.test(token.text) && token.text !== "\\ " );
  const out: Canonical[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.text === "{" && tokens[i + 2]?.text === "}" && tokens[i + 1] && tokens[i + 1].text !== "{" && tokens[i + 1].text !== "}") {
      // A group of one token: the token alone.
      const inner = tokens[i + 1];
      out.push({ text: inner.text, from: inner.from, to: inner.to, outerFrom: token.from, outerTo: tokens[i + 2].to });
      i += 2;
      continue;
    }
    out.push({ text: token.text, from: token.from, to: token.to, outerFrom: token.from, outerTo: token.to });
  }
  // Spellings of the same command.
  return out.map((token) => ({ ...token, text: ALIASES[token.text] ?? token.text }));
}

const ALIASES: Record<string, string> = {
  "\\le": "\\leq", "\\ge": "\\geq", "\\ne": "\\neq", "\\to": "\\rightarrow", "\\gets": "\\leftarrow", "\\lbrace": "\\{", "\\rbrace": "\\}",
  "\\vert": "|", "\\lvert": "|", "\\rvert": "|", "\\dfrac": "\\dfrac", "\\cdotp": "\\cdot",
};

export type TexChange = { from: number; to: number; insert: string };

/** Longest common subsequence of two token lists, as matched index pairs. */
function lcs(a: Canonical[], b: Canonical[]) {
  const n = a.length;
  const m = b.length;
  // Formulas are short; past this size a whole replacement is fine.
  if (n * m > 4_000_000) return null;
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = a[i].text === b[j].text ? table[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i].text === b[j].text) { pairs.push([i, j]); i++; j++; }
    else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * The smallest changes to `original` (at document offset `offset`) that make
 * it typeset as `edited`. Equal canonical tokens keep their original bytes;
 * each run that differs is replaced with the edited text of that run.
 */
export function texDiff(original: string, edited: string, offset = 0): TexChange[] {
  const a = canonicalTokens(original);
  const b = canonicalTokens(edited);
  if (a.length === b.length && a.every((token, index) => token.text === b[index].text)) return [];
  const pairs = lcs(a, b);
  if (!pairs) return [{ from: offset, to: offset + original.length, insert: edited }];
  const changes: TexChange[] = [];
  let ai = 0;
  let bi = 0;
  const flush = (aEnd: number, bEnd: number) => {
    if (ai === aEnd && bi === bEnd) return;
    // The original range between the matched neighbours, and the edited text between them.
    // Replaced tokens take their one-token braces with them; insertions go after the previous token's braces.
    const from = ai < aEnd ? a[ai].outerFrom : ai > 0 ? a[ai - 1].outerTo : 0;
    const to = ai < aEnd ? a[aEnd - 1].outerTo : from;
    // With the braces of one-token groups at the edges, so no brace is left open.
    let insert = bi < bEnd ? edited.slice(b[bi].outerFrom, b[bEnd - 1].outerTo) : "";
    // A control word must not run into the letters after it (`\beta` before `y` is `\beta y`, not `\betay`).
    const left = original.slice(0, from);
    const right = original.slice(to);
    if (/\\[A-Za-z@]+$/.test(left) && /^[A-Za-z@]/.test(insert || right)) insert = ` ${insert}`;
    if (/\\[A-Za-z@]+$/.test(insert) && /^[A-Za-z@]/.test(right)) insert = `${insert} `;
    changes.push({ from: offset + from, to: offset + to, insert });
  };
  for (const [i, j] of pairs) {
    flush(i, j);
    ai = i + 1;
    bi = j + 1;
  }
  flush(a.length, b.length);
  return mergeAdjacent(changes);
}

function mergeAdjacent(changes: TexChange[]) {
  const out: TexChange[] = [];
  for (const change of changes) {
    const last = out[out.length - 1];
    if (last && last.to === change.from) { last.to = change.to; last.insert += change.insert; }
    else out.push({ ...change });
  }
  return out;
}

/** Applies changes (sorted, non-overlapping, in `source` coordinates at `offset`) to a string. */
export function applyTexChanges(source: string, changes: TexChange[], offset = 0) {
  let out = "";
  let at = 0;
  for (const change of changes) {
    out += source.slice(at, change.from - offset) + change.insert;
    at = change.to - offset;
  }
  return out + source.slice(at);
}
