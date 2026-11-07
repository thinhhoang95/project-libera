import { MAX_MACRO_DEPTH, readGroup, readOptional } from "../../macros/core";
import { macroAt, type LatexDefinitions, type LatexMacro, type XparseArgument } from "./definitions";

/* Expanding the document's macros (docs/latex-visual-editor-plan.md §7.4).
 * In math, uses are substituted into the formula before KaTeX sees it; in
 * text, the expansion is drawn by the fragment renderer. Expansion fails
 * (and the use stays as source) past the depth or size limits. */

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

function skipSpaces(source: string, index: number) {
  while (source[index] === " " || source[index] === "\t" || (source[index] === "\n" && source[index + 1] !== "\n")) index++;
  return index;
}

/** One undelimited argument, as TeX reads it: a `{…}` group, a control sequence, or one character. */
function readUndelimited(source: string, index: number): Argument | null {
  index = skipSpaces(source, index);
  if (index >= source.length) return null;
  if (source[index] === "{") {
    const group = readGroup(source, index);
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

/** Reads a use's arguments after its name; null when they are not all there. */
export function readMacroArguments(source: string, index: number, macro: Pick<LatexMacro, "arity" | "optional" | "spec">): { args: string[]; end: number } | null {
  const args: string[] = [];
  if (macro.spec) {
    for (const argument of macro.spec) {
      const at = skipSpaces(source, index);
      if (argument.type === "s") {
        if (source[at] === "*") { args.push(BOOLEAN_TRUE); index = at + 1; } else args.push(BOOLEAN_FALSE);
      } else if (argument.type === "o" || argument.type === "O") {
        const optional = readOptional(source, at);
        if (optional) { args.push(optional.content); index = optional.end; } else args.push(argument.type === "O" ? (argument as Extract<XparseArgument, { type: "O" }>).default : NO_VALUE);
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
    const optional = readOptional(source, skipSpaces(source, index));
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

/** Puts arguments into a body: `#n` is an argument, `##` a literal `#`. */
export function substituteArguments(body: string, args: string[]) {
  return body.replace(/##|#([1-9])/g, (whole, n: string | undefined) => (n ? args[Number(n) - 1] ?? whole : "#"));
}

/** xparse's tests on arguments: `\IfBooleanTF`, `\IfNoValueTF`, `\IfValueTF` and their one-branch forms. */
function evaluateConditionals(text: string) {
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

/** The use of a macro at `index` (which holds a backslash), expanded, or null when it is not a usable macro. */
function expandUse(source: string, index: number, context: Context, depth: number): { text: string; end: number } | null | false {
  const match = /^\\([A-Za-z@]+)/.exec(source.slice(index, index + 80));
  if (!match) return null;
  const macro = macroAt(context.defs, match[1], context.pos);
  if (!macro) return null;
  if (macro.mathOnly && context.mode === "text") return false;
  if (depth >= MAX_MACRO_DEPTH || --context.budget < 0) return false;
  const read = readMacroArguments(source, index + match[0].length, macro);
  if (!read) return false;
  context.used.add(macro.fingerprint);
  const body = evaluateConditionals(substituteArguments(macro.body, read.args));
  const inner = expandText(body, context, depth + 1);
  if (inner === null) return false;
  // A control word right after the expansion must not run into it (`\x y` → `\alpha y`, not `\alphay`).
  const next = source[read.end] ?? "";
  const glue = /[A-Za-z@]$/.test(inner) && /\\[A-Za-z@]+$/.test(inner) && /[A-Za-z@]/.test(next) ? " " : "";
  return { text: inner + glue, end: read.end };
}

function expandText(source: string, context: Context, depth: number): string | null {
  if (!source.includes("\\")) return source;
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
    if (char !== "\\") continue;
    if (!/[A-Za-z@]/.test(source[i + 1] ?? "")) { i++; continue; }
    const result = expandUse(source, i, context, depth);
    if (result === false) return null;
    if (!result) { i += /^\\[A-Za-z@]+/.exec(source.slice(i, i + 80))![0].length - 1; continue; }
    output += source.slice(copied, i) + result.text;
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
  const result = expandUse(source, 0, context, 0);
  return result ? { text: result.text, length: result.end, used: [...context.used] } : null;
}

/** Commands that only make sense in math, so a text expansion containing them (outside math) cannot be drawn as text. */
const MATH_ONLY = /\\(?:math[a-z]+|frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|infty|partial|nabla|cdot|cdots|ldots(?=[_^])|times|le|ge|leq|geq|neq|approx|equiv|sim|pm|mp|in|notin|subset|subseteq|cup|cap|forall|exists|to|rightarrow|leftarrow|mapsto|left|right|big[lr]?|Big[lr]?|operatorname|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega|hat|bar|vec|tilde|dot|overline|underline(?=\s*\{.*[_^])|boldsymbol|parallel|top|bot)(?![A-Za-z])/;

/** Whether text-mode LaTeX uses math syntax outside `$…$`, `\(…\)` and `\ensuremath{…}`. */
export function needsMathMode(text: string) {
  const stripped = text
    .replace(/\\ensuremath\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, "")
    .replace(/\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\])*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, "");
  return /(^|[^\\])[_^]/.test(stripped) || MATH_ONLY.test(stripped);
}
