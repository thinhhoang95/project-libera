import { HOLE_TYPES, type FindError, type HoleType, type QueryPart } from "./types";

/* The Pattern mode language (docs/find-replace-patterns-plan.md §4).
 *
 *   *            a hole: shortest balanced text, captured as @1, @2, …
 *   ?            exactly one character, also numbered
 *   @name        a named hole; the same name again must match the same text
 *   @name:type   a typed hole (@:type when anonymous)
 *   @name/re/    a hole that must match a regular expression (@/re/ when anonymous)
 *   \* \? \@     literal * ? @
 *   \\           always the two-character pair (LaTeX's line break)
 *
 * Every other character, backslashes included, is literal. */

export type PatternHole = {
  kind: "hole";
  group: number;
  name?: string;
  type: HoleType;
  /** A regex hole; sticky, so it only matches at the position it is tried. */
  regex?: RegExp;
  /** `?`: one character. */
  single?: boolean;
  /** Set on an untyped `any` hole at the start or end of the pattern (§4.1 rule 4). */
  edge?: "leading" | "trailing";
};

export type PatternToken =
  | { kind: "literal"; text: string }
  | { kind: "space" }
  | PatternHole
  | { kind: "backref"; name: string; group: number };

export type PatternGroup = { index: number; name?: string };

export type ParsedPattern = {
  tokens: PatternToken[];
  parts: QueryPart[];
  groups: PatternGroup[];
  error?: FindError;
  warnings: FindError[];
};

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;

function readIdentifier(source: string, at: number) {
  IDENTIFIER.lastIndex = at;
  return IDENTIFIER.exec(source)?.[0] ?? "";
}

/** The index after the closing `/` of a regex starting after `at`'s `/`, or -1. */
function regexEnd(source: string, at: number) {
  let inClass = false;
  for (let i = at; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return i;
  }
  return -1;
}

export function parsePattern(source: string, { flexibleSpacing = false, matchCase = false } = {}): ParsedPattern {
  const tokens: PatternToken[] = [];
  const parts: QueryPart[] = [];
  const groups: PatternGroup[] = [];
  const warnings: FindError[] = [];
  const names = new Map<string, number>();
  let error: FindError | undefined;
  let literal = "";

  const flushLiteral = () => {
    if (literal) tokens.push({ kind: "literal", text: literal });
    literal = "";
  };
  const addText = (from: number, to: number, kind: "text" | "escape" = "text") => {
    const last = parts.at(-1);
    if (kind === "text" && last?.kind === "text" && last.to === from) last.to = to;
    else parts.push({ kind, from, to });
  };
  const fail = (message: FindError["message"], from: number, to: number) => {
    error ??= { message, from, to };
    parts.push({ kind: "error", from, to });
  };
  const addHole = (hole: Omit<PatternHole, "kind" | "group">, from: number, to: number) => {
    flushLiteral();
    // A name used again is a back-reference, whatever type it is written with.
    if (hole.name !== undefined && names.has(hole.name)) {
      const group = names.get(hole.name)!;
      tokens.push({ kind: "backref", name: hole.name, group });
      parts.push({ kind: "hole", from, to, group, name: hole.name, backref: true });
      return;
    }
    const group = groups.length + 1;
    groups.push({ index: group, name: hole.name });
    if (hole.name !== undefined && !names.has(hole.name)) names.set(hole.name, group);
    tokens.push({ kind: "hole", group, ...hole });
    parts.push({ kind: "hole", from, to, group, name: hole.name, type: hole.single ? undefined : hole.type, regex: hole.regex?.source, single: hole.single });
  };

  for (let i = 0; i < source.length;) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "\\" && next === "\\") {
      literal += "\\\\";
      addText(i, i + 2);
      i += 2;
    } else if (char === "\\" && (next === "*" || next === "?" || next === "@")) {
      literal += next;
      addText(i, i + 2, "escape");
      i += 2;
    } else if (char === "*") {
      addHole({ type: "any" }, i, i + 1);
      i++;
    } else if (char === "?") {
      addHole({ type: "any", single: true }, i, i + 1);
      i++;
    } else if (char === "@" && next !== undefined && /[A-Za-z_:/0-9]/.test(next)) {
      const start = i;
      if (/[0-9]/.test(next)) {
        let end = i + 1;
        while (/[0-9]/.test(source[end] ?? "")) end++;
        fail({ id: "numberedHoleName" }, start, end);
        i = end;
        continue;
      }
      const name = readIdentifier(source, i + 1);
      let at = i + 1 + name.length;
      let type: HoleType = "any";
      let regex: RegExp | undefined;
      if (source[at] === ":") {
        const typeName = readIdentifier(source, at + 1);
        if (!typeName) { fail({ id: "typeExpected" }, start, at + 1); i = at + 1; continue; }
        at += 1 + typeName.length;
        if (!HOLE_TYPES.includes(typeName as HoleType)) { fail({ id: "unknownType", type: typeName }, start, at); i = at; continue; }
        type = typeName as HoleType;
      } else if (source[at] === "/") {
        const close = regexEnd(source, at + 1);
        if (close < 0) { fail({ id: "unterminatedRegex" }, start, source.length); i = source.length; continue; }
        const body = source.slice(at + 1, close);
        try {
          regex = new RegExp(body, matchCase ? "uy" : "iuy");
        } catch (cause) {
          fail({ id: "invalidRegex", detail: cause instanceof Error ? cause.message : String(cause) }, start, close + 1);
          i = close + 1;
          continue;
        }
        at = close + 1;
      } else if (!name) {
        // `@` before something that is no hole: a literal at-sign.
        literal += "@";
        addText(i, i + 1);
        i++;
        continue;
      }
      addHole({ name: name || undefined, type, regex }, start, at);
      i = at;
    } else if (flexibleSpacing && (char === " " || char === "\t")) {
      let end = i;
      while (source[end] === " " || source[end] === "\t") end++;
      flushLiteral();
      if (tokens.at(-1)?.kind !== "space") tokens.push({ kind: "space" });
      parts.push({ kind: "space", from: i, to: end });
      i = end;
    } else {
      const width = char.codePointAt(0)! > 0xffff ? 2 : 1;
      literal += source.slice(i, i + width);
      addText(i, i + width);
      i += width;
    }
  }
  flushLiteral();

  // `@1`, `@2` count the anonymous holes only (`\left@o:arg*\right` → `@1` is the `*`);
  // named holes are numbered after them and referred to by name.
  const anonymous = groups.filter((group) => group.name === undefined);
  const renumber = new Map<number, number>();
  [...anonymous, ...groups.filter((group) => group.name !== undefined)].forEach((group, index) => renumber.set(group.index, index + 1));
  for (const group of groups) group.index = renumber.get(group.index)!;
  groups.sort((a, b) => a.index - b.index);
  for (const token of tokens) if (token.kind === "hole" || token.kind === "backref") token.group = renumber.get(token.group)!;
  for (const part of parts) if (part.kind === "hole") part.group = renumber.get(part.group)!;

  const isLazy = (token: PatternToken | undefined) => token?.kind === "hole" && token.type === "any" && !token.single && !token.regex;
  if (!error && source) {
    const anchored = tokens.some((token) => token.kind === "literal" || token.kind === "space" || (token.kind === "hole" && !isLazy(token)));
    if (!anchored) fail({ id: "needsLiteral" }, 0, source.length);
  }
  if (!error) {
    if (tokens.length > 1 && isLazy(tokens[0])) (tokens[0] as PatternHole).edge = "leading";
    if (tokens.length > 1 && isLazy(tokens.at(-1))) (tokens.at(-1) as PatternHole).edge = "trailing";
    const holeParts = parts.filter((part) => part.kind === "hole");
    for (let index = 1; index < tokens.length; index++) {
      const previous = tokens[index - 1], token = tokens[index];
      if (isLazy(previous) && (isLazy(token) || (previous.kind === "hole" && token.kind === "hole" && token.type === "block"))) {
        const part = holeParts.find((candidate) => candidate.kind === "hole" && candidate.group === (previous as PatternHole).group && !candidate.backref);
        if (part) warnings.push({ message: { id: "adjacentHoles" }, from: part.from, to: part.to });
      }
    }
  }
  return { tokens, parts, groups, error, warnings };
}
