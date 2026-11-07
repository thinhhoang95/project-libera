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

/** Commands whose argument is text, where spaces count: compared exactly, as written. */
const TEXT_ARGUMENT = /^\\(?:text|textrm|textit|textbf|textsf|texttt|textup|textnormal|mbox|hbox|intertext|shortintertext|operatorname\*?)$/;

/**
 * The formula's tokens in a form where spellings TeX typesets the same are
 * equal: spaces between math tokens are dropped (math ignores them), and
 * braces around a single token are dropped only where they delimit an
 * argument (`^{2}` and `^2`, `\frac{1}{2}` and `\frac12`). Elsewhere braces
 * change spacing (`a{+}b` is not `a+b`), control spaces (`\ `) are kept, and
 * text arguments (`\text{a b}`) are compared exactly.
 */
export function canonicalTokens(source: string): Canonical[] {
  const tokens = tokenizeTex(source);
  const out: Canonical[] = [];
  /** Whether the next group is an argument: after `^`, `_`, a control word, or another argument group. */
  let argument: null | "script" | "command" = null;
  const push = (text: string, from: number, to: number, outerFrom = from, outerTo = to) => out.push({ text: ALIASES[text] ?? text, from, to, outerFrom, outerTo });
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\s+$/.test(token.text)) continue;
    // A text argument: one token holding the whole group as written.
    if (TEXT_ARGUMENT.test(token.text)) {
      push(token.text, token.from, token.to);
      let j = i + 1;
      while (tokens[j] && /^\s+$/.test(tokens[j].text)) j++;
      if (tokens[j]?.text === "{") {
        let depth = 0;
        let k = j;
        for (; k < tokens.length; k++) {
          if (tokens[k].text === "{") depth++;
          else if (tokens[k].text === "}" && --depth === 0) break;
        }
        if (k < tokens.length) {
          push(source.slice(tokens[j].from, tokens[k].to), tokens[j].from, tokens[k].to);
          i = k;
          argument = null;
          continue;
        }
      }
      argument = "command";
      continue;
    }
    if (argument && token.text === "{") {
      let j = i + 1;
      while (tokens[j] && /^\s+$/.test(tokens[j].text)) j++;
      let k = j + 1;
      while (tokens[k] && /^\s+$/.test(tokens[k].text)) k++;
      const inner = tokens[j];
      if (inner && inner.text !== "{" && inner.text !== "}" && tokens[k]?.text === "}") {
        // A one-token argument: the token alone.
        push(inner.text, inner.from, inner.to, token.from, tokens[k].to);
        i = k;
        // A command's second argument may follow (`\frac{1}{2}`); nothing follows a script's.
        if (argument === "script") argument = null;
        continue;
      }
    }
    push(token.text, token.from, token.to);
    argument = token.text === "^" || token.text === "_" ? "script" : /^\\[A-Za-z@]+\*?$/.test(token.text) || (token.text === "}" && argument === "command") ? "command" : null;
  }
  return out;
}

/** Spellings of the same command (KaTeX and TeX define them as each other). */
const ALIASES: Record<string, string> = {
  "\\le": "\\leq", "\\ge": "\\geq", "\\ne": "\\neq", "\\to": "\\rightarrow", "\\gets": "\\leftarrow", "\\lbrace": "\\{", "\\rbrace": "\\}",
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
  const merged = mergeAdjacent(changes);
  // Removing tokens can change what the ones kept mean (deleting `\frac{1}` leaves `{2}`, now a group).
  // When the small change would not typeset as the edit, replace the formula whole.
  const result = applyTexChanges(original, merged, offset);
  const same = (x: Canonical[], y: Canonical[]) => x.length === y.length && x.every((token, index) => token.text === y[index].text);
  return same(canonicalTokens(result), b) ? merged : [{ from: offset, to: offset + original.length, insert: edited }];
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
