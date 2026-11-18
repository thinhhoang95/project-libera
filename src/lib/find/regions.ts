import type { FindFlavor, TextRange } from "./types";

/* Math, comment and code regions of a text, for the Where scopes and the
 * `math` hole type (docs/find-replace-patterns-plan.md §7). A light scanner,
 * not a parser: it knows the delimiters people actually write. */

export type MathSpan = { start: number; end: number; contentStart: number; contentEnd: number };

export type TextRegions = {
  math: MathSpan[];
  /** Comments and code (LaTeX `%` comments, verbatim; Markdown code spans, fences, HTML comments). */
  skipped: TextRange[];
};

const MATH_ENVIRONMENTS = new Set([
  "equation", "align", "gather", "multline", "flalign", "alignat", "eqnarray", "displaymath", "math",
].flatMap((name) => [name, `${name}*`]));
const VERBATIM_ENVIRONMENTS = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment"]);

export function isEscaped(text: string, at: number) {
  let count = 0;
  for (let i = at - 1; i >= 0 && text.charCodeAt(i) === 92; i--) count++;
  return count % 2 === 1;
}

const BEGIN = /\\begin\{([^{}\n]+)\}/y;

function environmentAt(text: string, at: number) {
  BEGIN.lastIndex = at;
  const match = BEGIN.exec(text);
  return match ? { name: match[1], contentStart: BEGIN.lastIndex } : null;
}

function findEnvironmentEnd(text: string, name: string, from: number) {
  const end = `\\end{${name}}`;
  const at = text.indexOf(end, from);
  return at < 0 ? null : { contentEnd: at, end: at + end.length };
}

/** The next unescaped `$` (or `$$`) at or after `from`, or -1. */
function findDollar(text: string, from: number, double: boolean, limit = text.length) {
  for (let i = text.indexOf("$", from); i >= 0 && i < limit; i = text.indexOf("$", i + 1)) {
    if (isEscaped(text, i)) continue;
    if (double) { if (text[i + 1] === "$") return i; continue; }
    if (text[i + 1] === "$") { i++; continue; }
    return i;
  }
  return -1;
}

/** The first blank line (a `\n` followed by only spaces and another `\n`) at or after `from`. */
export function nextParagraphBreak(text: string, from: number) {
  for (let i = text.indexOf("\n", from); i >= 0; i = text.indexOf("\n", i + 1)) {
    let j = i + 1;
    while (text[j] === " " || text[j] === "\t" || text[j] === "\r") j++;
    if (text[j] === "\n") return i;
  }
  return text.length;
}

/** The math span opening exactly at `at`, or null. */
export function mathSpanAt(text: string, at: number): MathSpan | null {
  const char = text[at];
  if (char === "$") {
    if (isEscaped(text, at)) return null;
    if (text[at + 1] === "$") {
      const close = findDollar(text, at + 2, true);
      return close < 0 ? null : { start: at, end: close + 2, contentStart: at + 2, contentEnd: close };
    }
    const next = text[at + 1];
    if (next === undefined || /\s/.test(next)) return null;
    const close = findDollar(text, at + 1, false, nextParagraphBreak(text, at));
    if (close < 0 || /\s/.test(text[close - 1])) return null;
    return { start: at, end: close + 1, contentStart: at + 1, contentEnd: close };
  }
  if (char === "\\" && !isEscaped(text, at)) {
    const next = text[at + 1];
    if (next === "(" || next === "[") {
      const closer = next === "(" ? "\\)" : "\\]";
      for (let i = text.indexOf(closer, at + 2); i >= 0; i = text.indexOf(closer, i + 1)) {
        if (!isEscaped(text, i)) return { start: at, end: i + 2, contentStart: at + 2, contentEnd: i };
      }
      return null;
    }
    if (next === "b") {
      const environment = environmentAt(text, at);
      if (!environment || !MATH_ENVIRONMENTS.has(environment.name)) return null;
      const end = findEnvironmentEnd(text, environment.name, environment.contentStart);
      return end ? { start: at, end: end.end, contentStart: environment.contentStart, contentEnd: end.contentEnd } : null;
    }
  }
  return null;
}

function lineEnd(text: string, from: number) {
  const at = text.indexOf("\n", from);
  return at < 0 ? text.length : at;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function scanRegions(text: string, flavor: FindFlavor): TextRegions {
  const math: MathSpan[] = [];
  const skipped: TextRange[] = [];
  if (flavor === "text") return { math, skipped };
  const latex = flavor === "latex";
  let lineStart = true;
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === "\n") { lineStart = true; i++; continue; }
    if (!latex && lineStart) {
      const fence = FENCE.exec(text.slice(i, lineEnd(text, i)));
      if (fence) {
        const marker = fence[1];
        let at = lineEnd(text, i);
        let end = text.length;
        while (at < text.length) {
          const next = lineEnd(text, at + 1);
          const line = text.slice(at + 1, next);
          if (new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(line)) { end = next; break; }
          at = next;
        }
        skipped.push({ start: i, end });
        i = end;
        continue;
      }
    }
    lineStart = false;
    if (char === "\\") {
      if (isEscaped(text, i)) { i++; continue; }
      const span = mathSpanAt(text, i);
      if (span) { math.push(span); i = span.end; continue; }
      if (latex && text.startsWith("\\verb", i) && !/[A-Za-z]/.test(text[i + 5] ?? "")) {
        let at = i + 5;
        if (text[at] === "*") at++;
        const delimiter = text[at];
        const close = delimiter ? text.indexOf(delimiter, at + 1) : -1;
        if (close >= 0 && close < lineEnd(text, at)) { skipped.push({ start: i, end: close + 1 }); i = close + 1; continue; }
      }
      if (latex && text.startsWith("\\begin{", i)) {
        const environment = environmentAt(text, i);
        if (environment && VERBATIM_ENVIRONMENTS.has(environment.name)) {
          const end = findEnvironmentEnd(text, environment.name, environment.contentStart);
          const stop = end?.end ?? text.length;
          skipped.push({ start: i, end: stop });
          i = stop;
          continue;
        }
      }
      // Skip the escaped character with its backslash (`\$`, `\%`, `` \` ``).
      i += 2;
      continue;
    }
    if (char === "$") {
      const span = mathSpanAt(text, i);
      if (span) { math.push(span); i = span.end; continue; }
      i += text[i + 1] === "$" ? 2 : 1;
      continue;
    }
    if (latex && char === "%") {
      const end = lineEnd(text, i);
      skipped.push({ start: i, end });
      i = end;
      continue;
    }
    if (!latex && char === "`") {
      let run = i;
      while (text[run] === "`") run++;
      const ticks = text.slice(i, run);
      let close = text.indexOf(ticks, run);
      while (close >= 0 && (text[close - 1] === "`" || text[close + ticks.length] === "`")) close = text.indexOf(ticks, close + 1);
      if (close >= 0) { skipped.push({ start: i, end: close + ticks.length }); i = close + ticks.length; continue; }
      i = run;
      continue;
    }
    if (!latex && text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      const end = close < 0 ? text.length : close + 3;
      skipped.push({ start: i, end });
      i = end;
      continue;
    }
    i++;
  }
  return { math, skipped };
}

/** Binary search: the last range starting at or before `at`. */
function lastStartingBefore<T extends { start: number }>(ranges: T[], at: number) {
  let low = 0, high = ranges.length;
  while (low < high) { const mid = (low + high) >> 1; if (ranges[mid].start <= at) low = mid + 1; else high = mid; }
  return low - 1;
}

/** Inside math: the match lies within the content of one math span. */
export function insideMath(regions: TextRegions, start: number, end: number) {
  const index = lastStartingBefore(regions.math, start);
  const span = regions.math[index];
  return !!span && start >= span.contentStart && end <= span.contentEnd;
}

/** Outside math: the match neither starts nor ends inside math content (it may contain whole spans). */
export function outsideMath(regions: TextRegions, start: number, end: number) {
  const startSpan = regions.math[lastStartingBefore(regions.math, start)];
  if (startSpan && start >= startSpan.contentStart && start < startSpan.contentEnd) return false;
  const endSpan = regions.math[lastStartingBefore(regions.math, end - 1)];
  if (endSpan && end > endSpan.contentStart && end <= endSpan.contentEnd) return false;
  return true;
}

/** True when the match overlaps no comment or code range. */
export function clearOfSkipped(skipped: TextRange[], start: number, end: number) {
  const index = lastStartingBefore(skipped, Math.max(start, end - 1));
  for (let i = index; i >= 0; i--) {
    const range = skipped[i];
    if (range.end <= start) return true;
    if (range.start < end && range.end > start) return false;
  }
  return true;
}
