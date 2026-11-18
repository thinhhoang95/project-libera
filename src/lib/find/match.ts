import type { PatternHole, PatternToken } from "./pattern";
import { isEscaped, mathSpanAt, nextParagraphBreak } from "./regions";
import type { FindCapture, FindMatch, TextRange } from "./types";

/* The Pattern mode matcher (docs/find-replace-patterns-plan.md §4.1, §9).
 *
 * A backtracking search over the pattern's tokens, bounded by:
 * - candidate starts found with a native search for the first literal;
 * - a bracket table, so a hole jumps over a `{…}` group in one step and only
 *   ends where its brackets are balanced;
 * - memoised failures of (token, position) while no back-reference exists;
 * - a step budget, past which the search reports itself incomplete. */

export const PATTERN_STEP_BUDGET = 2_000_000;

class BudgetExceeded extends Error {}

const NO_PARTNERS = new Int32Array(0);
const OPEN = new Map([[123, 125], [40, 41], [91, 93]]); // { ( [
const CLOSE = new Map([[125, 123], [41, 40], [93, 91]]);

/** The matching partner of every bracket, or -1. `strict` pairs `{}`, `()` and `[]`; otherwise only `{}`. */
function bracketPartners(text: string, strict: boolean) {
  const partners = new Int32Array(text.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 123 && code !== 125 && (!strict || (code !== 40 && code !== 41 && code !== 91 && code !== 93))) continue;
    if (isEscaped(text, i)) continue;
    if (OPEN.has(code)) { stack.push(i); continue; }
    // A closer pairs with the nearest opener of its kind; openers above it stay unmatched.
    const opener = CLOSE.get(code)!;
    for (let depth = stack.length - 1; depth >= 0; depth--) {
      if (text.charCodeAt(stack[depth]) !== opener) continue;
      partners[i] = stack[depth];
      partners[stack[depth]] = i;
      stack.length = depth;
      break;
    }
  }
  return partners;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const OPERAND_STOP = new Set([..." \t\r\n\f\v$&,;=+-<>|"]);
const TYPE_PATTERNS: Partial<Record<PatternHole["type"], RegExp>> = {
  word: /[\p{L}\p{N}_]+/uy,
  int: /[+-]?\d+/y,
  num: /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y,
  space: /[ \t]+/y,
  cmd: /\\(?:[A-Za-z@]+|[^A-Za-z@\s])/y,
};
const COMMAND = TYPE_PATTERNS.cmd!;
const FLEXIBLE_SPACE = /[ \t]*(?:\r?\n[ \t]*)?/y;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codePointWidth(text: string, at: number) {
  const code = text.charCodeAt(at);
  return code >= 0xd800 && code <= 0xdbff && at + 1 < text.length ? 2 : 1;
}

function isWordAt(text: string, at: number) {
  if (at < 0 || at >= text.length) return false;
  const code = text.codePointAt(at)!;
  // A low surrogate: read the whole code point it ends.
  if (code >= 0xdc00 && code <= 0xdfff && at > 0) return WORD_CHAR.test(String.fromCodePoint(text.codePointAt(at - 1)!));
  return WORD_CHAR.test(String.fromCodePoint(code));
}

/** Whole word: the match does not continue a word on either side. */
export function onWordBoundaries(text: string, start: number, end: number) {
  if (start > 0 && isWordAt(text, start) && isWordAt(text, start - 1)) return false;
  if (end < text.length && end > start && isWordAt(text, end - 1) && isWordAt(text, end)) return false;
  return true;
}

export type PatternMatchOptions = {
  matchCase: boolean;
  /** Called for every match found; false rejects it (Whole word, Where, In selection) and the search moves on by one character. */
  accept?: (start: number, end: number) => boolean;
  budget?: number;
};

type CompiledToken =
  | { kind: "literal"; text: string; sticky: RegExp }
  | { kind: "space" }
  | (PatternHole & { sticky?: RegExp; whole?: RegExp })
  | { kind: "backref"; name: string; group: number };

export function compileTokens(tokens: PatternToken[], matchCase: boolean): CompiledToken[] {
  return tokens.map((token) => {
    if (token.kind === "literal") return { ...token, sticky: new RegExp(escapeRegExp(token.text), matchCase ? "uy" : "iuy") };
    if (token.kind === "hole" && TYPE_PATTERNS[token.type]) {
      const source = TYPE_PATTERNS[token.type]!;
      return { ...token, sticky: new RegExp(source.source, source.flags) };
    }
    return token;
  });
}

export function matchPattern(text: string, patternTokens: PatternToken[], groupCount: number, options: PatternMatchOptions): { matches: FindMatch[]; incomplete: boolean } {
  const { matchCase, accept, budget = PATTERN_STEP_BUDGET } = options;
  const tokens = compileTokens(patternTokens, matchCase);
  const matches: FindMatch[] = [];
  if (!tokens.length) return { matches, incomplete: false };

  const length = text.length;
  const leading = tokens[0].kind === "hole" && tokens[0].edge === "leading";
  const first = tokens[leading ? 1 : 0];
  const balanced = tokens.some((token) => token.kind === "hole" && (token.type === "any" || token.type === "block") && !token.single && !token.regex);
  const hasBackref = tokens.some((token) => token.kind === "backref");
  const captures = new Int32Array((groupCount + 1) * 2).fill(-1);
  const groupNames = new Map<number, string>();
  for (const token of tokens) if (token.kind === "hole" && token.name) groupNames.set(token.group, token.name);

  let strictPartners: Int32Array | null = null;
  let bracePartners: Int32Array | null = null;
  const partnersFor = (strict: boolean) => strict
    ? (strictPartners ??= bracketPartners(text, true))
    : (bracePartners ??= bracketPartners(text, false));

  // Paragraph breaks, found once and searched by binary search.
  let breaks: number[] | null = null;
  const nextBreak = (from: number) => {
    if (!breaks) {
      breaks = [];
      for (let at = nextParagraphBreak(text, 0); at < length; at = nextParagraphBreak(text, at + 1)) breaks.push(at);
    }
    let low = 0, high = breaks.length;
    while (low < high) { const mid = (low + high) >> 1; if (breaks[mid] < from) low = mid + 1; else high = mid; }
    return low < breaks.length ? breaks[low] : length;
  };

  let steps = 0;
  let partners: Int32Array = new Int32Array(0);
  let strict = true;
  let failures: Set<number> | null = null;
  const tick = () => { if (++steps > budget) throw new BudgetExceeded(); };
  const isOpener = (at: number) => {
    const code = text.charCodeAt(at);
    return (code === 123 || (strict && (code === 40 || code === 91))) && !isEscaped(text, at);
  };
  const isCloser = (at: number) => {
    const code = text.charCodeAt(at);
    return (code === 125 || (strict && (code === 41 || code === 93))) && !isEscaped(text, at);
  };
  const setCapture = (group: number, start: number, end: number) => { captures[group * 2] = start; captures[group * 2 + 1] = end; };

  /** The end of a trailing edge hole: an operand of balanced, non-space text. */
  const operandEnd = (from: number) => {
    const limit = nextBreak(from);
    let at = from;
    while (at < limit) {
      const char = text[at];
      if (OPERAND_STOP.has(char)) break;
      if (char === "\\") {
        const next = text[at + 1];
        if (next === "\\" || next === "(" || next === ")" || next === "[" || next === "]") break;
        const command = (COMMAND.lastIndex = at, COMMAND.exec(text));
        at += command ? command[0].length : 1;
        continue;
      }
      if (isOpener(at)) {
        const partner = partners[at];
        if (partner < 0 || partner >= limit) break;
        at = partner + 1;
        continue;
      }
      if (isCloser(at)) break;
      at += codePointWidth(text, at);
    }
    while (at > from && ".:!?".includes(text[at - 1])) at--;
    return at;
  };

  /** The start of a leading edge hole ending at `to`, never before `floor`. */
  const operandStart = (to: number, floor: number) => {
    let at = to;
    while (at > floor) {
      const char = text[at - 1];
      if (OPERAND_STOP.has(char)) break;
      if (isCloser(at - 1)) {
        const partner = partners[at - 1];
        if (partner < floor || partner < 0 || nextBreak(partner) < at - 1) break;
        at = partner;
        continue;
      }
      if (isOpener(at - 1)) break;
      // The bracket of `\(`, `\[`, `\{`: a delimiter, not part of the operand.
      if ("()[]{}".includes(char) && isEscaped(text, at - 1)) break;
      if (char === "\\") {
        let run = 0;
        while (at - 1 - run >= floor && text[at - 1 - run] === "\\") run++;
        if (run % 2 === 0) break; // `\\` pairs: a line break, not part of the operand.
        at--;
        if (run > 1) break;
        continue;
      }
      const code = text.charCodeAt(at - 1);
      at -= code >= 0xdc00 && code <= 0xdfff && at - 2 >= floor ? 2 : 1;
    }
    return at;
  };

  const sameText = (start: number, end: number, at: number) => {
    const captured = text.slice(start, end);
    const candidate = text.slice(at, at + captured.length);
    return matchCase ? candidate === captured : candidate.toLowerCase() === captured.toLowerCase();
  };

  function matchFrom(index: number, at: number): number {
    if (index === tokens.length) return at;
    tick();
    const key = failures ? index * (length + 1) + at : 0;
    if (failures?.has(key)) return -1;
    const result = matchToken(index, at);
    if (result < 0 && failures) failures.add(key);
    return result;
  }

  function matchToken(index: number, at: number): number {
    const token = tokens[index];
    if (token.kind === "literal") {
      if (matchCase) return text.startsWith(token.text, at) ? matchFrom(index + 1, at + token.text.length) : -1;
      token.sticky.lastIndex = at;
      return token.sticky.test(text) ? matchFrom(index + 1, token.sticky.lastIndex) : -1;
    }
    if (token.kind === "space") {
      FLEXIBLE_SPACE.lastIndex = at;
      FLEXIBLE_SPACE.exec(text);
      return matchFrom(index + 1, FLEXIBLE_SPACE.lastIndex);
    }
    if (token.kind === "backref") {
      const start = captures[token.group * 2], end = captures[token.group * 2 + 1];
      if (start < 0) return matchFrom(index + 1, at);
      return sameText(start, end, at) ? matchFrom(index + 1, at + (end - start)) : -1;
    }
    const group = token.group;
    const finish = (captureStart: number, captureEnd: number, end: number) => {
      setCapture(group, captureStart, captureEnd);
      return matchFrom(index + 1, end);
    };
    if (token.single) {
      if (at >= length || text[at] === "\n" || text[at] === "\r") return -1;
      return finish(at, at + codePointWidth(text, at), at + codePointWidth(text, at));
    }
    if (token.regex) {
      token.regex.lastIndex = at;
      const found = token.regex.exec(text);
      if (!found) return -1;
      const longest = at + found[0].length;
      const result = finish(at, longest, longest);
      if (result >= 0) return result;
      // Shorter ends the expression also matches in full, longest first:
      // `\(@x/[^,]+/\)` must give back the `\)` its greedy match took.
      const whole = (token.whole ??= new RegExp(`^(?:${token.regex.source})$`, token.regex.flags.replace("y", "")));
      for (let end = longest - 1; end >= at; end--) {
        tick();
        if (!whole.test(text.slice(at, end))) continue;
        const shorter = finish(at, end, end);
        if (shorter >= 0) return shorter;
      }
      return -1;
    }
    if (token.sticky) {
      token.sticky.lastIndex = at;
      const found = token.sticky.exec(text);
      return found ? finish(at, at + found[0].length, at + found[0].length) : -1;
    }
    switch (token.type) {
      case "any":
      case "block": {
        if (token.edge === "trailing") { const end = operandEnd(at); return finish(at, end, end); }
        const limit = token.type === "block" ? length : nextBreak(at);
        let end = at;
        for (;;) {
          tick();
          setCapture(group, at, end);
          const result = matchFrom(index + 1, end);
          if (result >= 0) return result;
          if (end >= limit) return -1;
          if (isOpener(end)) {
            const partner = partners[end];
            if (partner < 0 || partner >= limit) return -1;
            end = partner + 1;
          } else if (isCloser(end)) {
            return -1;
          } else {
            end += codePointWidth(text, end);
          }
        }
      }
      case "line": {
        let end = text.indexOf("\n", at);
        if (end < 0) end = length;
        if (end > at && text[end - 1] === "\r") end--;
        for (; end >= at; end--) {
          tick();
          const result = finish(at, end, end);
          if (result >= 0) return result;
        }
        return -1;
      }
      case "arg": {
        let start = at;
        while (text[start] === " " || text[start] === "\t") start++;
        if (text[start] === "\n") { start++; while (text[start] === " " || text[start] === "\t") start++; }
        if (start >= length) return -1;
        const char = text[start];
        if (char === "{" && !isEscaped(text, start)) {
          const close = partnersFor(false)[start];
          return close < 0 ? -1 : finish(start + 1, close, close + 1);
        }
        if (char === "\\") {
          COMMAND.lastIndex = start;
          const command = COMMAND.exec(text);
          return command ? finish(start, start + command[0].length, start + command[0].length) : -1;
        }
        if (/\s/.test(char) || char === "}" || char === "{") return -1;
        const width = codePointWidth(text, start);
        return finish(start, start + width, start + width);
      }
      case "opt": {
        if (text[at] !== "[") return finish(at, at, at);
        const braces = partnersFor(false);
        const limit = nextBreak(at);
        for (let end = at + 1; end < limit; end++) {
          if (text[end] === "{" && braces[end] > end) { end = braces[end]; continue; }
          if (text[end] === "]" && !isEscaped(text, end)) return finish(at + 1, end, end + 1);
        }
        return finish(at, at, at);
      }
      case "math": {
        const span = mathSpanAt(text, at);
        return span ? finish(span.start, span.end, span.end) : -1;
      }
      default:
        return -1;
    }
  }

  // Candidate starts: a native search for the first literal when the pattern has one.
  const firstSearch = first?.kind === "literal" ? new RegExp(escapeRegExp(first.text), matchCase ? "gu" : "giu") : null;
  const nextCandidate = (from: number) => {
    if (!firstSearch) return from <= length ? from : -1;
    firstSearch.lastIndex = from;
    const found = firstSearch.exec(text);
    return found ? found.index : -1;
  };

  const attempt = (at: number, floor: number) => {
    for (const mode of balanced ? [true, false] : [true]) {
      strict = mode;
      partners = balanced ? partnersFor(mode) : NO_PARTNERS;
      failures = hasBackref ? null : (mode ? strictFailures : braceFailures);
      captures.fill(-1);
      // A leading edge hole is fixed by what precedes `at`, so it is known before
      // the rest is matched (a back-reference to it may follow).
      let start = at;
      if (leading) {
        start = operandStart(at, floor);
        setCapture((tokens[0] as PatternHole).group, start, at);
      }
      const end = matchFrom(leading ? 1 : 0, at);
      if (end >= 0) return { start, end };
    }
    return null;
  };
  const strictFailures = new Set<number>();
  const braceFailures = new Set<number>();

  let incomplete = false;
  try {
    let floor = 0;
    for (let at = nextCandidate(0); at >= 0 && at <= length; at = nextCandidate(at)) {
      const found = attempt(at, floor);
      if (!found || found.end === found.start || (accept && !accept(found.start, found.end))) {
        at += at < length ? codePointWidth(text, at) : 1;
        continue;
      }
      const list: FindCapture[] = [];
      for (let group = 1; group <= groupCount; group++) {
        const name = groupNames.get(group);
        list.push({ index: group, ...(name ? { name } : {}), start: captures[group * 2], end: captures[group * 2 + 1] });
      }
      matches.push({ start: found.start, end: found.end, captures: list });
      floor = found.end;
      at = Math.max(found.end, at + (found.end > at ? 0 : 1));
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    incomplete = true;
  }
  return { matches, incomplete };
}

/** True when `range` lies inside one of `ranges`. */
export function withinRanges(ranges: TextRange[], start: number, end: number) {
  return ranges.some((range) => start >= range.start && end <= range.end);
}
