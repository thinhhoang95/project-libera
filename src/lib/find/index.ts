import { matchPattern, onWordBoundaries, withinRanges } from "./match";
import { parsePattern, type PatternGroup } from "./pattern";
import { clearOfSkipped, insideMath, outsideMath, scanRegions, type TextRegions } from "./regions";
import { compileReplacement, type CompiledReplacement } from "./replace";
import type { FindCapture, FindError, FindMatch, FindOptions, FindResult, QueryPart, TextRange } from "./types";

/* The find & replace engine shared by every editor
 * (docs/find-replace-patterns-plan.md). Plain and Regex mode run on native
 * regular expressions; Pattern mode on the matcher in match.ts. */

export * from "./types";
export { compileReplacement, caseStyle, type Replacer, type CompiledReplacement, type ReplaceRenderError } from "./replace";
export { scanRegions, type TextRegions, type MathSpan } from "./regions";

export type FindLimits = {
  /** Only matches inside one of these ranges (In selection). */
  within?: TextRange[];
  /** Extra ranges that count as code for Skip comments & code (TipTap's code marks). */
  skipped?: TextRange[];
  /** Precomputed regions of the text, when the caller already has them. */
  regions?: TextRegions;
};

export interface Finder {
  /** Identifies the compiled query and options; equal keys find the same matches. */
  readonly key: string;
  readonly options: FindOptions;
  readonly groups: PatternGroup[];
  /** The query in pieces, for drawing holes as chips. */
  readonly parts: QueryPart[];
  readonly warnings: FindError[];
  /** False when no match can contain a blank line, so paragraphs can be searched (and cached) one by one. */
  readonly crossesParagraphs: boolean;
  find(text: string, limits?: FindLimits): FindResult;
}

export type CompiledFind = { ok: true; finder: Finder } | { ok: false; error: FindError; parts: QueryPart[]; warnings: FindError[] };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FLEXIBLE_SPACE_SOURCE = "[ \\t]*(?:\\r?\\n[ \\t]*)?";

/** Capture group names of a regex source, by group number. */
function regexGroups(source: string): PatternGroup[] {
  const groups: PatternGroup[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (inClass) { if (char === "]") inClass = false; continue; }
    if (char === "[") { inClass = true; continue; }
    if (char !== "(") continue;
    if (source[i + 1] !== "?") { groups.push({ index: groups.length + 1 }); continue; }
    const named = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(source.slice(i));
    if (named) groups.push({ index: groups.length + 1, name: named[1] });
  }
  return groups;
}

function makeAccept(text: string, options: FindOptions, limits: FindLimits | undefined) {
  const checks: ((start: number, end: number) => boolean)[] = [];
  if (options.wholeWord) checks.push((start, end) => onWordBoundaries(text, start, end));
  if (limits?.within) {
    const within = limits.within;
    checks.push((start, end) => withinRanges(within, start, end));
  }
  if (options.scope !== "anywhere") {
    const regions = limits?.regions ?? scanRegions(text, options.flavor);
    if (options.scope === "insideMath") checks.push((start, end) => insideMath(regions, start, end));
    else if (options.scope === "outsideMath") checks.push((start, end) => outsideMath(regions, start, end));
    else {
      const skipped = limits?.skipped ? [...regions.skipped, ...limits.skipped].sort((a, b) => a.start - b.start) : regions.skipped;
      checks.push((start, end) => clearOfSkipped(skipped, start, end));
    }
  }
  return checks.length ? (start: number, end: number) => checks.every((check) => check(start, end)) : undefined;
}

/** Runs a native global regex over the text, skipping empty matches. */
function runRegex(text: string, regex: RegExp, groups: PatternGroup[], accept: ((start: number, end: number) => boolean) | undefined): FindResult {
  const matches: FindMatch[] = [];
  regex.lastIndex = 0;
  for (let found = regex.exec(text); found; found = regex.exec(text)) {
    const start = found.index, end = start + found[0].length;
    if (end === start || (accept && !accept(start, end))) {
      // Move on by one code point; a rejected match may hide a shorter one starting later.
      regex.lastIndex = start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
      continue;
    }
    const indices = (found as RegExpExecArray & { indices?: ([number, number] | undefined)[] }).indices;
    const captures: FindCapture[] = groups.map((group) => {
      const range = indices?.[group.index];
      return { index: group.index, ...(group.name ? { name: group.name } : {}), start: range ? range[0] : -1, end: range ? range[1] : -1 };
    });
    matches.push({ start, end, captures });
  }
  return { matches, incomplete: false };
}

export function compileFind(query: string, options: FindOptions): CompiledFind {
  const key = JSON.stringify([query, options.mode, options.matchCase, options.wholeWord, options.flexibleSpacing, options.scope, options.flavor]);
  const base = { key, options, warnings: [] as FindError[] };
  if (!query) {
    return { ok: true, finder: { ...base, groups: [], parts: [], crossesParagraphs: false, find: () => ({ matches: [], incomplete: false }) } };
  }

  if (options.mode === "plain") {
    const source = options.flexibleSpacing
      ? query.split(/[ \t]+/).map(escapeRegExp).join(FLEXIBLE_SPACE_SOURCE)
      : escapeRegExp(query);
    const flags = options.matchCase ? "gu" : "giu";
    return {
      ok: true,
      finder: {
        ...base,
        groups: [],
        parts: [{ kind: "text", from: 0, to: query.length }],
        crossesParagraphs: /\n\s*\n/.test(query),
        find: (text, limits) => runRegex(text, new RegExp(source, flags), [], makeAccept(text, options, limits)),
      },
    };
  }

  if (options.mode === "regex") {
    let regex: RegExp;
    try {
      regex = new RegExp(query, options.matchCase ? "gmud" : "gimud");
    } catch (cause) {
      const error: FindError = { message: { id: "invalidRegex", detail: cause instanceof Error ? cause.message : String(cause) }, from: 0, to: query.length };
      return { ok: false, error, parts: [{ kind: "error", from: 0, to: query.length }], warnings: [] };
    }
    const groups = regexGroups(query);
    return {
      ok: true,
      finder: {
        ...base,
        groups,
        parts: [{ kind: "text", from: 0, to: query.length }],
        // A regex can match anything, so it is never cut into paragraphs.
        crossesParagraphs: true,
        find: (text, limits) => runRegex(text, new RegExp(regex.source, regex.flags), groups, makeAccept(text, options, limits)),
      },
    };
  }

  const parsed = parsePattern(query, { flexibleSpacing: options.flexibleSpacing, matchCase: options.matchCase });
  if (parsed.error) return { ok: false, error: parsed.error, parts: parsed.parts, warnings: parsed.warnings };
  const crossesParagraphs = parsed.tokens.some((token) =>
    (token.kind === "hole" && (token.type === "block" || !!token.regex)) || (token.kind === "literal" && /\n\s*\n/.test(token.text)));
  return {
    ok: true,
    finder: {
      ...base,
      warnings: parsed.warnings,
      groups: parsed.groups,
      parts: parsed.parts,
      crossesParagraphs,
      find: (text, limits) => matchPattern(text, parsed.tokens, parsed.groups.length, {
        matchCase: options.matchCase,
        accept: makeAccept(text, options, limits),
      }),
    },
  };
}

/** Compiles the replacement against a compiled query's captures. */
export function compileFindReplacement(finder: Finder, replacement: string, preserveCase: boolean): CompiledReplacement {
  return compileReplacement(replacement, {
    mode: finder.options.mode,
    groups: finder.groups,
    preserveCase: preserveCase && !finder.options.matchCase,
  });
}

/**
 * Replaces matches in a string. Matches whose replacement cannot be computed
 * (a non-numeric capture in arithmetic) are left as they are and counted.
 */
export function replaceAllInText(text: string, matches: FindMatch[], replacer: import("./replace").Replacer, firstCounter = 1) {
  const out: string[] = [];
  let offset = 0, skipped = 0, replaced = 0;
  matches.forEach((match, index) => {
    const value = replacer.render(text, match, firstCounter + index);
    if (typeof value !== "string") { skipped++; return; }
    out.push(text.slice(offset, match.start), value);
    offset = match.end;
    replaced++;
  });
  out.push(text.slice(offset));
  return { text: out.join(""), replaced, skipped };
}
