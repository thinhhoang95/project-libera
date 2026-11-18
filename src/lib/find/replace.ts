import type { FindError, FindMatch, FindMessage, FindMode, ReplacePiece, ReplacementPart } from "./types";

/* The replacement language, the same in Pattern and Regex mode
 * (docs/find-replace-patterns-plan.md §5). Only `@` is special:
 *
 *   @1 … @9    numbered capture (one digit; @(12) for more), @0 the whole match
 *   @name      named capture (longest identifier; @(x)y to follow it with letters)
 *   @#         the match counter, 1-based
 *   @( … )     an expression: @(n+1), @(p/100), @(#+9), @(1.upper), @(x.title)
 *   \@         a literal @
 *
 * Plain mode replacements are entirely literal. */

export type ReplacementGroup = { index: number; name?: string };

type Ref = { kind: "ref"; group: number } | { kind: "counter" } | { kind: "number"; value: number };
type Expression =
  | Ref
  | { kind: "method"; target: Expression; method: Method }
  | { kind: "negate"; operand: Expression }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/"; left: Expression; right: Expression };
type Method = "upper" | "lower" | "title" | "trim";
const METHODS: readonly Method[] = ["upper", "lower", "title", "trim"];

type Segment = { kind: "text"; text: string } | { kind: "expression"; expression: Expression };

export type ReplaceRenderError = { error: FindMessage };

export interface Replacer {
  /** The replacement text for one match, or the reason it cannot be computed. */
  render(text: string, match: FindMatch, counter: number): string | ReplaceRenderError;
  /** The same as pieces: literal text, captured ranges of the source and computed text. */
  pieces(text: string, match: FindMatch, counter: number): ReplacePiece[] | ReplaceRenderError;
}

export type CompiledReplacement =
  | { ok: true; replacer: Replacer; parts: ReplacementPart[]; warnings: FindError[] }
  | { ok: false; error: FindError; parts: ReplacementPart[]; warnings: FindError[] };

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;
function readIdentifier(source: string, at: number) {
  IDENTIFIER.lastIndex = at;
  return IDENTIFIER.exec(source)?.[0] ?? "";
}

class ExpressionError extends Error {
  constructor(readonly finding: FindError) { super("expression"); }
}

function parseExpression(source: string, offset: number, resolve: (name: string, from: number, to: number) => number): { expression: Expression; groups: number[] } {
  let at = 0;
  const groups: number[] = [];
  const skip = () => { while (source[at] === " ") at++; };
  const fail = (): never => { throw new ExpressionError({ message: { id: "invalidExpression" }, from: offset, to: offset + source.length }); };

  function factor(): Expression {
    skip();
    if (source[at] === "-") { at++; return { kind: "negate", operand: factor() }; }
    let value: Expression;
    if (source[at] === "(") {
      at++;
      value = sum();
      skip();
      if (source[at] !== ")") fail();
      at++;
    } else if (source[at] === "#") {
      at++;
      value = { kind: "counter" };
    } else if (source[at] === "@") {
      // `@(@1*2)`: inside arithmetic a bare 1 is the number one, `@1` the capture.
      const name = /[0-9]/.test(source[at + 1] ?? "") ? source[at + 1] : readIdentifier(source, at + 1);
      if (!name) fail();
      const group = resolve(name, offset + at, offset + at + 1 + name.length);
      groups.push(group);
      at += 1 + name.length;
      value = { kind: "ref", group };
    } else if (/[0-9.]/.test(source[at] ?? "")) {
      const number = /\d*\.?\d+|\d+\.?/y;
      number.lastIndex = at;
      const found = number.exec(source);
      if (!found) fail();
      at += found![0].length;
      // A bare number is a capture reference when it stands alone with a method or as the whole expression.
      value = { kind: "number", value: Number(found![0]) };
    } else {
      const name = readIdentifier(source, at);
      if (!name) fail();
      const group = resolve(name, offset + at, offset + at + name.length);
      groups.push(group);
      at += name.length;
      value = { kind: "ref", group };
    }
    skip();
    while (source[at] === ".") {
      const method = readIdentifier(source, at + 1);
      if (!METHODS.includes(method as Method)) fail();
      // `@(1.upper)`: a number before a method is the capture with that number.
      if (value.kind === "number" && Number.isInteger(value.value)) {
        const group = resolve(String(value.value), offset + at - 1, offset + at);
        groups.push(group);
        value = { kind: "ref", group };
      }
      value = { kind: "method", target: value, method: method as Method };
      at += 1 + method.length;
      skip();
    }
    return value;
  }
  function product(): Expression {
    let left = factor();
    for (skip(); source[at] === "*" || source[at] === "/"; skip()) {
      const operator = source[at++] as "*" | "/";
      left = { kind: "binary", operator, left, right: factor() };
    }
    return left;
  }
  function sum(): Expression {
    let left = product();
    for (skip(); source[at] === "+" || source[at] === "-"; skip()) {
      const operator = source[at++] as "+" | "-";
      left = { kind: "binary", operator, left, right: product() };
    }
    return left;
  }

  let expression = sum();
  skip();
  if (at !== source.length) fail();
  // `@(12)`: a lone integer is capture 12, not the number 12.
  if (expression.kind === "number" && Number.isInteger(expression.value)) {
    const group = resolve(String(expression.value), offset, offset + source.length);
    groups.push(group);
    expression = { kind: "ref", group };
  }
  return { expression, groups };
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
}

function titleCase(value: string) {
  return value.replace(/\p{L}[\p{L}\p{M}'’]*/gu, (word) => word[0].toLocaleUpperCase() + word.slice(1));
}

/** Preserve case: the replacement's literal text follows an all-caps or capitalised match. */
export function caseStyle(matched: string): "upper" | "capitalized" | null {
  const letters = matched.replace(/[^\p{L}]/gu, "");
  if (!letters) return null;
  if (letters.length > 1 && letters === letters.toLocaleUpperCase() && letters !== letters.toLocaleLowerCase()) return "upper";
  const first = letters[0];
  if (first === first.toLocaleUpperCase() && first !== first.toLocaleLowerCase()) return "capitalized";
  return null;
}

export function compileReplacement(source: string, {
  mode,
  groups,
  preserveCase = false,
}: { mode: FindMode; groups: ReplacementGroup[]; preserveCase?: boolean }): CompiledReplacement {
  const parts: ReplacementPart[] = [];
  const warnings: FindError[] = [];
  const segments: Segment[] = [];
  let error: FindError | undefined;
  let literal = "";
  const pushText = (from: number, to: number, text: string, kind: "text" | "escape" = "text") => {
    literal += text;
    const last = parts.at(-1);
    if (kind === "text" && last?.kind === "text" && last.to === from) last.to = to;
    else parts.push({ kind, from, to });
  };
  const flush = () => {
    if (literal) segments.push({ kind: "text", text: literal });
    literal = "";
  };
  const byName = new Map(groups.filter((group) => group.name).map((group) => [group.name!, group.index]));
  const resolve = (name: string, from: number, to: number) => {
    if (/^\d+$/.test(name)) {
      const index = Number(name);
      if (index === 0 || groups.some((group) => group.index === index)) return index;
    } else if (byName.has(name)) {
      return byName.get(name)!;
    }
    throw new ExpressionError({ message: { id: "unknownCapture", name }, from, to });
  };

  if (mode === "plain") {
    if (source) { parts.push({ kind: "text", from: 0, to: source.length }); segments.push({ kind: "text", text: source }); }
  } else {
    for (let i = 0; i < source.length;) {
      const char = source[i], next = source[i + 1];
      if (char === "\\" && next === "@") { pushText(i, i + 2, "@", "escape"); i += 2; continue; }
      if (char !== "@" || next === undefined) { pushText(i, i + 1, char); i++; continue; }
      try {
        if (/[0-9]/.test(next)) {
          const group = resolve(next, i, i + 2);
          flush();
          segments.push({ kind: "expression", expression: { kind: "ref", group } });
          parts.push({ kind: "ref", from: i, to: i + 2, group });
          i += 2;
        } else if (next === "#") {
          flush();
          segments.push({ kind: "expression", expression: { kind: "counter" } });
          parts.push({ kind: "counter", from: i, to: i + 2 });
          i += 2;
        } else if (next === "(") {
          let depth = 0, close = -1;
          for (let j = i + 1; j < source.length; j++) {
            if (source[j] === "(") depth++;
            else if (source[j] === ")" && --depth === 0) { close = j; break; }
          }
          if (close < 0) throw new ExpressionError({ message: { id: "unterminatedExpression" }, from: i, to: source.length });
          const parsed = parseExpression(source.slice(i + 2, close), i + 2, resolve);
          flush();
          segments.push({ kind: "expression", expression: parsed.expression });
          parts.push({ kind: "expression", from: i, to: close + 1, groups: parsed.groups });
          i = close + 1;
        } else {
          const name = readIdentifier(source, i + 1);
          if (!name) { pushText(i, i + 1, "@"); i++; continue; }
          const group = resolve(name, i, i + 1 + name.length);
          flush();
          segments.push({ kind: "expression", expression: { kind: "ref", group } });
          parts.push({ kind: "ref", from: i, to: i + 1 + name.length, group });
          i += 1 + name.length;
        }
      } catch (cause) {
        if (!(cause instanceof ExpressionError)) throw cause;
        error ??= cause.finding;
        parts.push({ kind: "error", from: cause.finding.from, to: cause.finding.to });
        const skipTo = Math.max(cause.finding.to, i + 1);
        i = skipTo;
      }
    }
    flush();
    if (mode === "regex") {
      for (const found of source.matchAll(/\$(\d+|&|<([A-Za-z_]\w*)>)/g)) {
        const written = found[0];
        const suggestion = found[1] === "&" ? "@0" : found[2] ? `@${found[2]}` : `@${found[1].length > 1 ? `(${found[1]})` : found[1]}`;
        warnings.push({ message: { id: "dollarReference", written, suggestion }, from: found.index, to: found.index + written.length });
      }
    }
  }
  if (error) return { ok: false, error, parts, warnings };

  const evaluate = (expression: Expression, text: string, match: FindMatch, counter: number): string | number => {
    switch (expression.kind) {
      case "number": return expression.value;
      case "counter": return counter;
      case "ref": {
        if (expression.group === 0) return text.slice(match.start, match.end);
        const capture = match.captures.find((candidate) => candidate.index === expression.group);
        return capture && capture.start >= 0 ? text.slice(capture.start, capture.end) : "";
      }
      case "method": {
        const value = String(evaluate(expression.target, text, match, counter));
        if (expression.method === "upper") return value.toLocaleUpperCase();
        if (expression.method === "lower") return value.toLocaleLowerCase();
        if (expression.method === "trim") return value.trim();
        return titleCase(value);
      }
      case "negate": return -numeric(evaluate(expression.operand, text, match, counter));
      case "binary": {
        const left = numeric(evaluate(expression.left, text, match, counter));
        const right = numeric(evaluate(expression.right, text, match, counter));
        if (expression.operator === "+") return left + right;
        if (expression.operator === "-") return left - right;
        if (expression.operator === "*") return left * right;
        return left / right;
      }
    }
  };
  const numeric = (value: string | number) => {
    if (typeof value === "number") return value;
    const trimmed = value.trim();
    const number = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(number)) throw new ValueError(value);
    return number;
  };

  const pieces = (text: string, match: FindMatch, counter: number): ReplacePiece[] | ReplaceRenderError => {
    const style = preserveCase ? caseStyle(text.slice(match.start, match.end)) : null;
    const result: ReplacePiece[] = [];
    try {
      segments.forEach((segment, index) => {
        if (segment.kind === "text") {
          let value = segment.text;
          if (style === "upper") value = value.toLocaleUpperCase();
          else if (style === "capitalized" && index === 0) value = value[0].toLocaleUpperCase() + value.slice(1);
          result.push({ kind: "text", text: value });
          return;
        }
        const expression = segment.expression;
        if (expression.kind === "ref") {
          const capture = expression.group === 0
            ? { start: match.start, end: match.end }
            : match.captures.find((candidate) => candidate.index === expression.group);
          if (capture && capture.start >= 0 && capture.end > capture.start) result.push({ kind: "capture", start: capture.start, end: capture.end });
          return;
        }
        const value = evaluate(expression, text, match, counter);
        result.push({ kind: "text", text: typeof value === "number" ? formatNumber(value) : value });
      });
    } catch (cause) {
      if (cause instanceof ValueError) return { error: { id: "notANumber", value: cause.value } };
      throw cause;
    }
    return result.filter((piece) => piece.kind === "capture" || piece.text !== "");
  };

  const replacer: Replacer = {
    pieces,
    render(text, match, counter) {
      const list = pieces(text, match, counter);
      if (!Array.isArray(list)) return list;
      return list.map((piece) => piece.kind === "text" ? piece.text : text.slice(piece.start, piece.end)).join("");
    },
  };
  return { ok: true, replacer, parts, warnings };
}

class ValueError extends Error {
  constructor(readonly value: string) { super("not a number"); }
}
