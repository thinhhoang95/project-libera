import { MAX_MACRO_DEPTH, readGroup, readOptional, TEX_GROUPS } from "../../macros/core";
import { evaluateIfThenElse, evaluateTexConditionals } from "./conditionals";
import { conditionalFacts, macroAt, type LatexDefinitions, type LatexMacro, type XparseArgument } from "./definitions";

/* Expanding the document's macros (docs/latex-visual-editor-plan.md §7.4).
 * In math, uses are substituted into the formula before KaTeX sees it; in
 * text, the expansion is drawn by the fragment renderer. Expansion fails
 * (and the use stays as source) past the depth or size limits. */

/** LaTeX's `\fnsymbol` sequence: the footnote symbols of a title's notes. */
export const FOOTNOTE_SYMBOLS = ["*", "†", "‡", "§", "¶", "‖", "**", "††", "‡‡"];

export const MAX_EXPANSION_LENGTH = 20_000;
/** Most macro expansions one formula or use may take. */
export const MAX_EXPANSIONS = 2_000;

export type ExpansionResult = {
  text: string;
  /** Fingerprints of the definitions used, for knowing when to redraw. */
  used: string[];
  ok: boolean;
};

const NO_VALUE = "\u0000NoValue\u0000";
const BOOLEAN_TRUE = "\u0000True\u0000";
const BOOLEAN_FALSE = "\u0000False\u0000";

type Argument = { value: string; end: number };

/** Skips what TeX skips before an undelimited argument: spaces, one line end, and comments (a blank line is a paragraph, which ends them). */
function skipSpaces(source: string, index: number) {
  for (;;) {
    const char = source[index];
    if (char === " " || char === "\t" || char === "\r") index++;
    else if (char === "\n" && !/^\n[ \t\r]*\n/.test(source.slice(index, index + 40))) index++;
    else if (char === "%") {
      const end = source.indexOf("\n", index);
      if (end < 0) return source.length;
      // The comment takes its line end; a blank line after it still ends the arguments.
      if (/^\n[ \t\r]*\n/.test(source.slice(end, end + 40))) return end;
      index = end + 1;
    } else return index;
  }
}

/** One undelimited argument, as TeX reads it: a `{…}` group, a control sequence, or one character. */
function readUndelimited(source: string, index: number): Argument | null {
  index = skipSpaces(source, index);
  // A paragraph break is not an argument.
  if (index >= source.length || /^\n[ \t\r]*\n/.test(source.slice(index, index + 40))) return null;
  if (source[index] === "{") {
    const group = readGroup(source, index, TEX_GROUPS);
    return group ? { value: group.content, end: group.end } : null;
  }
  if (source[index] === "}" ) return null;
  if (source[index] === "\\") {
    const match = /^\\(?:[A-Za-z@]+|.)/.exec(source.slice(index, index + 64));
    return match ? { value: match[0], end: index + match[0].length } : null;
  }
  const code = source.codePointAt(index)!;
  const length = code > 0xffff ? 2 : 1;
  return { value: source.slice(index, index + length), end: index + length };
}

/** xparse's `r()`/`d()` argument at `index` (its opening delimiter): up to the matching close, outside braces; null when it is not closed. */
function readDelimited(source: string, index: number, open: string, close: string): Argument | null {
  let depth = 0;
  for (let i = index + 1; i < source.length && i < index + 4000; i++) {
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (char === "{") {
      const group = readGroup(source, i, TEX_GROUPS);
      if (!group) return null;
      i = group.end - 1;
      continue;
    }
    if (char === close && depth === 0) return { value: source.slice(index + 1, i), end: i + 1 };
    if (char === open) depth++;
    else if (char === close) depth--;
    // A paragraph ends it unclosed.
    else if (char === "\n" && /^\n[ \t\r]*\n/.test(source.slice(i, i + 40))) return null;
  }
  return null;
}

/**
 * A TeX delimited argument (`\def\set#1:#2{…}`): everything up to `delimiter` outside braces, past the delimiter. A text
 * that is one `{…}` group loses its braces, as TeX strips them; null when the delimiter does not come before a
 * paragraph break or the end of the text.
 */
function readUntil(source: string, index: number, delimiter: string): Argument | null {
  for (let i = index; i < source.length && i < index + 4000; i++) {
    if (source.startsWith(delimiter, i)) {
      const value = source.slice(index, i);
      const group = value.startsWith("{") ? readGroup(value, 0, TEX_GROUPS) : null;
      return { value: group && group.end === value.length ? group.content : value, end: i + delimiter.length };
    }
    const char = source[i];
    if (char === "\\") { i++; continue; }
    if (char === "{") {
      const group = readGroup(source, i, TEX_GROUPS);
      if (!group) return null;
      i = group.end - 1;
    } else if (char === "}" || (char === "\n" && /^\n[ \t\r]*\n/.test(source.slice(i, i + 40)))) return null;
  }
  return null;
}

/** Reads a use's arguments after its name; null when they are not all there. */
export function readMacroArguments(source: string, index: number, macro: Pick<LatexMacro, "arity" | "optional" | "spec">): { args: string[]; end: number } | null {
  const args: string[] = [];
  if (macro.spec) {
    for (let n = 0; n < macro.spec.length; n++) {
      const argument = macro.spec[n];
      const at = skipSpaces(source, index);
      if (argument.type === "s" || argument.type === "t") {
        const token = argument.type === "s" ? "*" : argument.token;
        if (source[at] === token) { args.push(BOOLEAN_TRUE); index = at + 1; } else args.push(BOOLEAN_FALSE);
      } else if (argument.type === "r" || argument.type === "R" || argument.type === "d" || argument.type === "D") {
        const read = source[at] === argument.open ? readDelimited(source, at, argument.open, argument.close) : null;
        if (read) { args.push(read.value); index = read.end; } else if (argument.type === "r") return null;
        else args.push(argument.type === "d" ? NO_VALUE : argument.default);
      } else if (argument.type === "u") {
        // TeX skips the spaces after a control word, not those between later parameters.
        const read = readUntil(source, n === 0 ? skipSpaces(source, index) : index, argument.delimiter);
        if (!read || (argument.prefix && read.value !== "")) return null;
        args.push(read.value);
        index = read.end;
      } else if (argument.type === "e") {
        // The embellishments of one specification, in any order, each once: `^{a}_{b}` or `_{b}^{a}`.
        const tokens = macro.spec.slice(n).filter((other): other is Extract<XparseArgument, { type: "e" }> => other.type === "e" && other.group === argument.group);
        const values = new Map<string, string>();
        for (let next = skipSpaces(source, index); tokens.some((token) => token.token === source[next] && !values.has(source[next]));) {
          const value = readUndelimited(source, next + 1);
          if (!value) return null;
          values.set(source[next], value.value);
          index = value.end;
          next = skipSpaces(source, index);
        }
        for (const token of tokens) args.push(values.get(token.token) ?? token.default ?? NO_VALUE);
        n += tokens.length - 1;
      } else if (argument.type === "o" || argument.type === "O") {
        const optional = readOptional(source, at, TEX_GROUPS);
        if (optional) { args.push(optional.content); index = optional.end; } else args.push(argument.type === "O" ? (argument as Extract<XparseArgument, { type: "O" }>).default : NO_VALUE);
      } else if (argument.type === "g" || argument.type === "G") {
        // An optional argument in braces: present only when a `{` comes next.
        const group = source[at] === "{" ? readGroup(source, at, TEX_GROUPS) : null;
        if (group) { args.push(group.content); index = group.end; } else args.push(argument.type === "G" ? (argument as Extract<XparseArgument, { type: "G" }>).default : NO_VALUE);
      } else {
        const read = readUndelimited(source, index);
        if (!read) return null;
        args.push(read.value);
        index = read.end;
      }
    }
    return { args, end: index };
  }
  let remaining = macro.arity;
  if (macro.optional !== undefined && remaining > 0) {
    const optional = readOptional(source, skipSpaces(source, index), TEX_GROUPS);
    if (optional) { args.push(optional.content); index = optional.end; } else args.push(macro.optional);
    remaining--;
  }
  for (; remaining > 0; remaining--) {
    const read = readUndelimited(source, index);
    if (!read) return null;
    args.push(read.value);
    index = read.end;
  }
  return { args, end: index };
}

/** Whether text ends with a control word (`\alpha`, not the `\\` line break), which a following letter would run into. */
function endsWithControlWord(text: string) {
  return /(?:^|[^\\])(?:\\\\)*\\[A-Za-z@]+$/.test(text.slice(-80));
}

/** Joins two pieces of TeX without merging tokens: `\alpha` and `x` become `\alpha x`, not `\alphax`. */
function joinTokens(left: string, right: string) {
  return /^[A-Za-z@]/.test(right) && endsWithControlWord(left) ? `${left} ${right}` : left + right;
}

/** Puts arguments into a body: `#n` is an argument, `##` a literal `#`. Token boundaries are kept (`\alpha#1` with `x` is `\alpha x`). */
export function substituteArguments(body: string, args: string[]) {
  let out = "";
  let last = 0;
  let joined = false;
  for (const match of body.matchAll(/##|#([1-9])/g)) {
    const text = body.slice(last, match.index);
    out = joined ? joinTokens(out, text) : out + text;
    last = match.index! + match[0].length;
    if (!match[1]) { out += "#"; joined = false; continue; }
    out = joinTokens(out, args[Number(match[1]) - 1] ?? match[0]);
    joined = true;
  }
  const rest = body.slice(last);
  return joined ? joinTokens(out, rest) : out + rest;
}

/**
 * xparse's tests on arguments: `\IfBooleanTF`, `\IfNoValueTF`, `\IfValueTF` and their one-branch forms. A chosen
 * branch may hold another test (`\IfBooleanTF{#1}{…}{\IfNoValueTF{#2}{…}{…}}`, mathtools' paired delimiters):
 * evaluated again, a few levels deep.
 */
function evaluateConditionals(text: string) {
  for (let level = 0; level < 4 && text.includes("\\If"); level++) {
    const next = evaluateConditionalsOnce(text);
    if (next === text) break;
    text = next;
  }
  return text;
}

function evaluateConditionalsOnce(text: string) {
  if (!text.includes("\\If")) return text;
  const pattern = /\\(IfBooleanTF|IfBooleanT|IfBooleanF|IfNoValueTF|IfNoValueT|IfNoValueF|IfValueTF|IfValueT|IfValueF)(?![A-Za-z])/g;
  let output = "";
  let copied = 0;
  for (let match: RegExpExecArray | null; (match = pattern.exec(text));) {
    const name = match[1];
    const test = readUndelimited(text, match.index + match[0].length);
    if (!test) continue;
    const branches = name.endsWith("TF") ? 2 : 1;
    const first = readUndelimited(text, test.end);
    const second = branches === 2 && first ? readUndelimited(text, first.end) : null;
    if (!first || (branches === 2 && !second)) continue;
    const value = test.value.trim();
    const truth = name.startsWith("IfBoolean") ? value === BOOLEAN_TRUE : name.startsWith("IfNoValue") ? value === NO_VALUE : value !== NO_VALUE;
    const chosen = branches === 2 ? (truth ? first.value : second!.value) : name.endsWith("F") === !truth ? first.value : "";
    output += text.slice(copied, match.index) + chosen;
    copied = (second ?? first).end;
    pattern.lastIndex = copied;
  }
  return output + text.slice(copied);
}

type Context = { defs: LatexDefinitions; pos: number; used: Set<string>; mode: "math" | "text"; /** Expansions left: bounds the work, not only the result (a macro chain that ends in nothing). */ budget: number };

/** Environments whose body is a formula. */
const MATH_ENVIRONMENT_NAMES = /^(?:equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math)\*?$/;

/** A definition command and the name it defines (`\renewcommand{\x}`, `\def\x`, `\let\x`): copied as they are. */
const DEFINING = /^\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|xdef|let|DeclareMathOperator)\*?\s*(?:\{\s*\\[A-Za-z@]+\s*\}|\\[A-Za-z@]+)/;

/** The use of a macro at `index` (which holds a backslash), expanded, or null when it is not a usable macro. */
function expandUse(source: string, index: number, context: Context, depth: number): { text: string; end: number } | null | false {
  // A control word, or a control symbol the document defines (GRF's `\newcommand{\1}{\mathbf{1}}`).
  const match = /^\\([A-Za-z@]+|[0-9!*+|<>?()[\]])/.exec(source.slice(index, index + 80));
  if (!match) return null;
  const macro = macroAt(context.defs, match[1], context.pos);
  if (!macro) return null;
  // A definition that cannot be rendered: the use stays source.
  if (macro.unsupported) return false;
  if (macro.mathOnly && context.mode === "text") return false;
  if (depth >= MAX_MACRO_DEPTH || --context.budget < 0) return false;
  const read = readMacroArguments(source, index + match[0].length, macro);
  if (!read) return false;
  context.used.add(macro.fingerprint);
  // A `\let` copy of LaTeX's own command saved before the document redefines it (`\let\oldemph\emph`, then
  // `\renewcommand{\emph}[1]{\textcolor{red}{\oldemph{#1}}}`) stands for the original, not the redefinition.
  if (macro.alias && new RegExp(String.raw`\\${match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z@])`).test(macroAt(context.defs, macro.body.slice(1), context.pos)?.body ?? "")) return { text: macro.body, end: read.end };
  let body = evaluateConditionals(substituteArguments(macro.body, read.args));
  // `\newcommand{\foo}{\@ifstar{\foo@star}{\foo@plain}}`: the starred or plain form, by whether a `*` follows the use.
  let end = read.end;
  const star = !macro.arity && !macro.spec ? /^\s*\\@ifstar(?![A-Za-z@])/.exec(body) : null;
  if (star) {
    const starred = readUndelimited(body, star[0].length);
    const plain = starred && readUndelimited(body, starred.end);
    if (!plain || body.slice(plain.end).trim()) return false;
    const at = skipSpaces(source, end);
    if (source[at] === "*") { body = starred.value; end = at + 1; } else body = plain.value;
  }
  // TeX's conditionals and ifthen's `\ifthenelse` that are decided here (estout's `\sym` takes its `\ifmmode` branch).
  if (body.includes("\\if") || /\\not(?:toggle|bool)/.test(body)) {
    const facts = conditionalFacts(context.defs, context.pos, context.mode === "math");
    body = evaluateTexConditionals(evaluateIfThenElse(body, facts), facts);
  }
  const inner = expandText(body, context, depth + 1);
  if (inner === null) return false;
  // A control word right after the expansion must not run into it (`\x y` → `\alpha y`, not `\alphay`).
  const next = source[end] ?? "";
  const glue = /[A-Za-z@]$/.test(inner) && /\\[A-Za-z@]+$/.test(inner) && /[A-Za-z@]/.test(next) ? " " : "";
  return { text: inner + glue, end };
}

/** Math commands whose next token is their argument (accents, fonts, roots, fractions), and `^`/`_`. */
const ARGUMENT_COMMANDS = "hat|widehat|tilde|widetilde|bar|overline|underline|vec|dot|ddot|dddot|check|breve|acute|grave|mathring|Hat|Tilde|Bar|Vec|Dot|Ddot|Check|Breve|Acute|Grave|overrightarrow|overleftarrow|mathbf|mathrm|mathit|mathsf|mathtt|mathcal|mathbb|mathfrak|mathscr|mathnormal|boldsymbol|bm|pmb|sqrt|frac|dfrac|tfrac|cfrac|binom|dbinom|tbinom|operatorname|text";
/** What ends right before a macro use that is an argument: such a command, `^`, `_`, or a fraction's first argument. */
const ARGUMENT_BEFORE = new RegExp(String.raw`(?:\\(?:${ARGUMENT_COMMANDS})|[\^_]|\\(?:frac|dfrac|tfrac|cfrac|binom|dbinom|tbinom)\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|\\[A-Za-z@]+|[^\s{}\\]))\s*$`);

/** One token, or one group: what TeX would read as one argument. */
function singleToken(text: string) {
  const trimmed = text.trim();
  if (/^(?:\\[A-Za-z@]+|\\.|[^\\{}\s])$/.test(trimmed)) return true;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\") { i++; continue; }
    if (trimmed[i] === "{") depth++;
    else if (trimmed[i] === "}" && --depth === 0 && i < trimmed.length - 1) return false;
  }
  return true;
}

function expandText(source: string, context: Context, depth: number): string | null {
  if (!source.includes("\\")) return source;
  const outer = context.mode;
  // In text, math inside `$…$`, `\(…\)`, `\[…\]` and `\ensuremath{…}` is expanded as math.
  let closer: string | null = null;
  let output = "";
  let copied = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "%") {
      // Comments are dropped from expansions, as TeX does.
      const end = source.indexOf("\n", i);
      output += source.slice(copied, i);
      i = end < 0 ? source.length : end;
      copied = i;
      continue;
    }
    if (char === "$" && outer === "text") {
      const delimiter = source[i + 1] === "$" ? "$$" : "$";
      if (closer === null) closer = delimiter;
      else if (closer === delimiter) closer = null;
      i += delimiter.length - 1;
      continue;
    }
    if (char !== "\\") continue;
    const next = source[i + 1] ?? "";
    // A math environment in text (`\begin{equation*}…\end{equation*}` in an algorithm's statement): its body is math,
    // as between dollars, so math-only macros (`\DeclareMathOperator`) expand in it.
    if (outer === "text" && (next === "b" || next === "e")) {
      const environment = /^\\(begin|end)\s*\{([A-Za-z]+\*?)\}/.exec(source.slice(i, i + 40));
      if (environment && MATH_ENVIRONMENT_NAMES.test(environment[2])) {
        if (environment[1] === "begin" && closer === null) closer = `\\end{${environment[2]}}`;
        else if (environment[1] === "end" && closer === `\\end{${environment[2]}}`) closer = null;
        i += environment[0].length - 1;
        continue;
      }
    }
    // A control symbol, unless the document defines it (`\newcommand{\1}{\mathbf{1}}`): then it is a macro use.
    // SIAM's `\renewcommand{\(}{\left(}`: `\(` and `\)` are the document's delimiters, not math switches.
    if (!/[A-Za-z@]/.test(next) && !(/[0-9!*+|<>?()[\]]/.test(next) && macroAt(context.defs, next, context.pos))) {
      if (outer === "text") {
        if (closer === null && (next === "(" || next === "[")) closer = next === "(" ? "\\)" : "\\]";
        else if (closer !== null && closer === `\\${next}`) closer = null;
      }
      i++;
      continue;
    }
    if (outer === "text" && closer === null && /^\\ensuremath(?![A-Za-z@])/.test(source.slice(i, i + 12)) && !macroAt(context.defs, "ensuremath", context.pos)) {
      const group = readGroup(source, skipSpaces(source, i + 11), TEX_GROUPS);
      if (group) {
        context.mode = "math";
        const inner = expandText(group.content, context, depth);
        context.mode = outer;
        if (inner === null) return null;
        output += `${source.slice(copied, i)}\\ensuremath{${inner}}`;
        copied = group.end;
        i = group.end - 1;
        continue;
      }
    }
    // The name a definition defines is not used there: `\renewcommand{\theoremname}{#1}` in an environment's code
    // stays as written (O'Donnell's `named`), not `\renewcommand{testing}{…}`.
    const defining = DEFINING.exec(source.slice(i, i + 120));
    if (defining) { i += defining[0].length - 1; continue; }
    // LaTeX's `\@fnsymbol{1}` (2611.13390's `\thankssymb`): the footnote symbol of that number, `*` `†` `‡` `§` `¶` `‖` `**` `††` `‡‡`.
    // A number it has no symbol for (or a counter, which is not known here) is not drawn: the use stays source.
    const fnsymbol = /^\\@fnsymbol(?![A-Za-z@])/.exec(source.slice(i, i + 12));
    if (fnsymbol && !macroAt(context.defs, "@fnsymbol", context.pos)) {
      const number = readUndelimited(source, i + fnsymbol[0].length);
      const symbol = number && /^\s*[1-9]\s*$/.test(number.value) ? FOOTNOTE_SYMBOLS[Number(number.value) - 1] : undefined;
      if (!number || symbol === undefined || closer !== null || outer === "math") return null;
      output = joinTokens(output + source.slice(copied, i), symbol);
      copied = number.end;
      i = number.end - 1;
      continue;
    }
    const math = closer !== null || outer === "math";
    context.mode = math ? "math" : outer;
    const result = expandUse(source, i, context, depth);
    context.mode = outer;
    if (result === false) return null;
    if (!result) { i += /^\\(?:[A-Za-z@]+|[\s\S])/.exec(source.slice(i, i + 80))![0].length - 1; continue; }
    const before = output + source.slice(copied, i);
    // `\hat\bx` with `\bx` for `\mathbf{x}`: TeX gives \hat the macro, one token; its expansion, written out, needs braces.
    const text = math && !singleToken(result.text) && ARGUMENT_BEFORE.test(before) ? `{${result.text}}` : result.text;
    output = joinTokens(before, text);
    if (output.length > MAX_EXPANSION_LENGTH) return null;
    copied = result.end;
    i = result.end - 1;
  }
  return output + source.slice(copied);
}

/**
 * Expands every use of the document's macros in `source`. `pos` is where the
 * text is in the open file, so definitions written later in the body do not
 * apply. In text mode, a math-only macro makes the expansion fail.
 */
export function expandLatexMacros(source: string, defs: LatexDefinitions, options: { mode?: "math" | "text"; pos?: number } = {}): ExpansionResult {
  if (!defs.macros.size || !source.includes("\\")) return { text: source, used: [], ok: true };
  const context: Context = { defs, pos: options.pos ?? Number.MAX_SAFE_INTEGER, used: new Set(), mode: options.mode ?? "math", budget: MAX_EXPANSIONS };
  const text = expandText(source, context, 0);
  return text === null ? { text: source, used: [...context.used], ok: false } : { text, used: [...context.used], ok: true };
}

/** Expands one use (`\name` and its arguments) at the start of `source`; null when it is not a usable macro. */
export function expandLatexMacroUse(source: string, defs: LatexDefinitions, options: { mode?: "math" | "text"; pos?: number } = {}) {
  const context: Context = { defs, pos: options.pos ?? Number.MAX_SAFE_INTEGER, used: new Set(), mode: options.mode ?? "text", budget: MAX_EXPANSIONS };
  // `\let\b\textbf`: what follows `\b` would be the arguments of a command whose arguments are unknown here.
  const name = /^\\([A-Za-z@]+)/.exec(source);
  const macro = name ? macroAt(defs, name[1], context.pos) : null;
  if (macro?.alias && /^[{[*]/.test(source.slice(skipSpaces(source, name![0].length)))) return null;
  const result = expandUse(source, 0, context, 0);
  // `\etal{} show`: the empty group after a macro without arguments only keeps the space; it is part of the use.
  const empty = result && macro && !macro.arity && !macro.spec && /^\{\}/.test(source.slice(result.end, result.end + 2)) ? 2 : 0;
  return result ? { text: result.text, length: result.end + empty, used: [...context.used] } : null;
}

/**
 * Where a piece of an expansion comes from: `[from, to)` in the expansion is the call's own text at `source` (offsets
 * from the use's start), copied unchanged from one of its arguments. Text the definition writes has none.
 */
export type ExpansionSegment = { from: number; to: number; source: number };
export type ProvenanceExpansion = { text: string; length: number; segments: ExpansionSegment[] };

/** A macro's arguments at `index` with where each one's text is (a group's content, or the token); null when one is missing. */
function readArgumentSpans(source: string, index: number, macro: Pick<LatexMacro, "arity" | "optional">) {
  const spans: Array<{ value: string; from: number } | { value: string; from: null }> = [];
  let remaining = macro.arity;
  if (macro.optional !== undefined && remaining > 0) {
    const at = skipSpaces(source, index);
    const optional = readOptional(source, at, TEX_GROUPS);
    if (optional) { spans.push({ value: optional.content, from: at + 1 }); index = optional.end; } else spans.push({ value: macro.optional, from: null });
    remaining--;
  }
  for (; remaining > 0; remaining--) {
    const at = skipSpaces(source, index);
    const read = readUndelimited(source, index);
    if (!read) return null;
    spans.push({ value: read.value, from: source[at] === "{" ? at + 1 : at });
    index = read.end;
  }
  return { spans, end: index };
}

/** Private-use characters standing for the arguments while the body is expanded. */
const ARGUMENT_MARK = 0xe000;

/**
 * The use of a macro at the start of `source` expanded as `expandLatexMacroUse` does, with where each piece of the
 * expansion comes from: a call's argument put in unchanged maps back to the call (editing it there edits the drawing;
 * an argument written twice is drawn twice from the same text), and the rest is the definition's. Null when the use
 * is not a usable macro, takes xparse arguments, or its expansion cannot be traced (its arguments are tested or split).
 */
export function expandMacroUseWithProvenance(source: string, defs: LatexDefinitions, options: { mode?: "math" | "text"; pos?: number } = {}): ProvenanceExpansion | null {
  const plain = expandLatexMacroUse(source, defs, options);
  if (!plain) return null;
  const name = /^\\([A-Za-z@]+)/.exec(source);
  const pos = options.pos ?? Number.MAX_SAFE_INTEGER;
  const macro = name ? macroAt(defs, name[1], pos) : null;
  if (!macro || macro.spec || macro.alias || /[-]/.test(source.slice(0, plain.length) + macro.body)) return null;
  const read = readArgumentSpans(source, name![0].length, macro);
  if (!read || read.end > plain.length) return null;
  const context: Context = { defs, pos, used: new Set(), mode: options.mode ?? "text", budget: MAX_EXPANSIONS };
  let body = evaluateConditionals(substituteArguments(macro.body, read.spans.map((_, n) => String.fromCharCode(ARGUMENT_MARK + n))));
  if (body.includes("\\if") || /\\not(?:toggle|bool)/.test(body)) {
    const facts = conditionalFacts(defs, pos, context.mode === "math");
    body = evaluateTexConditionals(evaluateIfThenElse(body, facts), facts);
  }
  const inner = expandText(body, context, 1);
  if (inner === null) return null;
  let text = "";
  const segments: ExpansionSegment[] = [];
  for (let i = 0; i < inner.length; i++) {
    const n = inner.charCodeAt(i) - ARGUMENT_MARK;
    if (n < 0 || n >= read.spans.length) { text += inner[i]; continue; }
    const span = read.spans[n];
    const expanded = expandLatexMacros(span.value, defs, { mode: "text", pos });
    if (!expanded.ok) return null;
    if (expanded.text === span.value && span.from !== null && span.value.length) segments.push({ from: text.length, to: text.length + span.value.length, source: span.from });
    text += expanded.text;
  }
  // Traced only when it is the expansion: an argument the body tests or takes apart is not followed.
  return text === plain.text ? { text, length: plain.length, segments } : null;
}

/** Where `[from, to)` of an expansion is in the call (offsets from the use's start), when it lies in one argument copied unchanged; null otherwise. */
export function provenanceOf(expansion: Pick<ProvenanceExpansion, "segments">, from: number, to: number) {
  const segment = expansion.segments.find((item) => item.from <= from && to <= item.to);
  return segment ? segment.source + (from - segment.from) : null;
}

/** Commands that only make sense in math, so a text expansion containing them (outside math) cannot be drawn as text. */
const MATH_ONLY = /\\(?:math[a-z]+|frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|infty|partial|nabla|cdot|cdots|ldots(?=[_^])|times|le|ge|leq|geq|neq|approx|equiv|sim|pm|mp|in|notin|subset|subseteq|cup|cap|forall|exists|to|rightarrow|leftarrow|mapsto|left|right|big[lr]?|Big[lr]?|operatorname|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega|hat|widehat|bar|vec|tilde|widetilde|check|breve|acute|grave|ddot|dot|Hat|Bar|Vec|Tilde|Check|Breve|Acute|Grave|Ddot|Dot|overline|overbrace|underbrace|underline(?=\s*\{.*[_^])|boldsymbol|bm|mathbb|parallel|top|bot|langle|rangle|lVert|rVert|lvert|rvert)(?![A-Za-z])/;

/** Whether text-mode LaTeX uses math syntax outside `$…$`, `\(…\)` and `\ensuremath{…}`. */
export function needsMathMode(text: string) {
  const stripped = text
    .replace(/\\ensuremath\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, "")
    .replace(/\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\])*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, "");
  return /(^|[^\\])[_^]/.test(stripped) || MATH_ONLY.test(stripped);
}
