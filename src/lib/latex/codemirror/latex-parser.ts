import { Parser, TreeFragment, type Input, type PartialParse, type Tree } from "@lezer/common";
import { ExternalTokenizer, LRParser } from "@lezer/lr";
import { parser as packageParser } from "codemirror-lang-latex/src/latex.mjs";
import { literalArgTokenizer, specializeCtrlSeq, specializeEnvName } from "codemirror-lang-latex/src/tokens.mjs";

/* The LaTeX parser every part of Libera uses: codemirror-lang-latex's, with
 * one tokenizer and one specializer replaced. Its literal arguments (file
 * paths, URLs) end at the first `}`, so `\includegraphics{\iftoggle{hq}{a.pdf}{b.pdf}}`
 * left braces that broke the rest of the figure; here they count nested
 * groups. And it knows more text commands inside math (below). */

/** The grammar's `LiteralArgContent` token (latex.terms.mjs). */
const LITERAL_ARG_CONTENT = 3;
const OPEN = 123; // {
const CLOSE = 125; // }
const NEWLINE = 10;
const BACKSLASH = 92;

/**
 * A literal argument's content, up to the `}` that closes its group. A group
 * still open at a blank line or the end (a path being typed) falls back to the
 * first `}`, as the package's tokenizer does, so it never swallows the file.
 */
const nestedLiteralArgTokenizer = new ExternalTokenizer((input) => {
  let depth = 0;
  let firstClose = -1;
  for (let offset = 0; ; offset++) {
    const next = input.peek(offset);
    if (next === -1 || (next === NEWLINE && input.peek(offset + 1) === NEWLINE)) {
      return input.acceptToken(LITERAL_ARG_CONTENT, firstClose >= 0 ? firstClose : offset);
    }
    if (next === BACKSLASH) { offset++; continue; }
    if (next === OPEN) depth++;
    else if (next === CLOSE) {
      if (firstClose < 0) firstClose = offset;
      if (depth === 0) return input.acceptToken(LITERAL_ARG_CONTENT, offset);
      depth--;
    }
  }
}, { contextual: false });

/** The grammar's `MathTextCtrlSeq` token (latex.terms.mjs): a command whose argument is text inside math. */
const MATH_TEXT_CTRL_SEQ = 16;

/**
 * Text commands the package does not know as such (it knows `\text`, `\textrm`,
 * `\tag`, `\intertext`). Inside math their argument is text, so `$` there opens
 * math again: `\textnormal{(around $x$)}` in an `align` no longer ends the align.
 */
const MATH_TEXT_COMMANDS = new Set(["\\textnormal", "\\textup", "\\textsl", "\\mbox"]);
const specializeControlSequence: typeof specializeCtrlSeq = (name, stack) => (MATH_TEXT_COMMANDS.has(name) ? MATH_TEXT_CTRL_SEQ : specializeCtrlSeq(name, stack));

/** The grammar's `EquationEnvName` and `EquationArrayEnvName` tokens (latex.terms.mjs). */
const EQUATION_ENV_NAME = 82;
const EQUATION_ARRAY_ENV_NAME = 83;

/**
 * Display environments the package does not know as math: breqn's `dmath` and `dseries` (one equation) and empheq's
 * `empheq` (rows, its inner environment named in its argument). Their body is a formula, numbered as one.
 */
const MORE_MATH_ENVIRONMENTS: Record<string, number> = {
  dmath: EQUATION_ENV_NAME, "dmath*": EQUATION_ENV_NAME, dseries: EQUATION_ENV_NAME, "dseries*": EQUATION_ENV_NAME, empheq: EQUATION_ARRAY_ENV_NAME,
};
/** The grammar's `VerbatimEnvName` token (latex.terms.mjs). */
const VERBATIM_ENV_NAME = 84;

/**
 * Drawing environments whose body is TikZ, not LaTeX: `\foreach \start/\end/\label in {…}` and `$(60:\C)!0.5!(120:\C)$`
 * are coordinates, not an environment's end, a label or a formula. Their content is read as opaque text up to the
 * matching `\end{…}`, as a verbatim body is, so nothing inside is taken for math or commands.
 */
export const OPAQUE_DRAWING_ENVIRONMENTS = new Set(["tikzpicture", "pgfpicture", "circuitikz"]);

const specializeEnvironmentName: typeof specializeEnvName = (name, terms) => (OPAQUE_DRAWING_ENVIRONMENTS.has(name) ? VERBATIM_ENV_NAME : MORE_MATH_ENVIRONMENTS[name] ?? specializeEnvName(name, terms));

export const latexParser = packageParser.configure({
  tokenizers: [{ from: literalArgTokenizer, to: nestedLiteralArgTokenizer }],
  specializers: [{ from: specializeCtrlSeq, to: specializeControlSequence }, { from: specializeEnvName, to: specializeEnvironmentName }],
});

/** How far a document's start is read for its `\begin{document}`: a preamble is shorter. */
const PREAMBLE_LIMIT = 32_000;
const BEGIN_DOCUMENT = /^\\begin\s*\{document\}/;
/** `\def\name` (and `\gdef`, `\edef`, `\xdef`): what comes before the parameter text. */
const DEFINITION_HEAD = /^\\[gex]?def(?![A-Za-z@])\s*\\(?:[A-Za-z@]+|[^A-Za-z@])/;

/**
 * The `{`s still open where the preamble ends (`\newcommand{\bad}[1]{\textbf{#1}` being typed, its `}` not yet
 * written), and where the body starts; null for a preamble whose groups all close, or a file without one.
 */
export function unclosedPreambleBraces(input: Pick<Input, "length" | "read">): PreambleBraces | null {
  const head = input.read(0, Math.min(input.length, PREAMBLE_LIMIT));
  // Parses start on every edit and the preamble rarely changes: comparing equal heads is far cheaper than scanning them (the result is only read).
  if (lastHead !== null && head === lastHead) return lastBraces;
  const braces = scanPreambleBraces(head);
  lastHead = head;
  lastBraces = braces;
  return braces;
}

type PreambleBraces = { positions: number[]; edits: Map<number, string>; end: number };
let lastHead: string | null = null;
let lastBraces: PreambleBraces | null = null;

function scanPreambleBraces(head: string): PreambleBraces | null {
  if (!head.includes("\\begin")) return null;
  const open: number[] = [];
  /**
   * A `\def` whose parameter text has several delimiters, or `&` or `\\` in it (`\def\textmatrix#1&#2\\#3&#4\\{…}`), is
   * more than the grammar reads: it ends the definition at the first one and the rest of the file is its body. The
   * parameter text is read as `#1#2#3#4` and spaces (same length), which the grammar takes.
   */
  const edits = new Map<number, string>();
  for (let i = 0; i < head.length; i++) {
    const char = head.charCodeAt(i);
    if (char === BACKSLASH) {
      if (head.startsWith("\\begin", i) && BEGIN_DOCUMENT.test(head.slice(i, i + 24))) {
        return open.length || edits.size ? { positions: open, edits, end: i } : null;
      }
      const def = DEFINITION_HEAD.exec(head.slice(i, i + 80));
      if (def) {
        const from = i + def[0].length;
        let to = from;
        while (to < head.length && to < from + 300 && !"{%\n".includes(head[to])) to++;
        const text = head.slice(from, to);
        const rest = text.split(/#[1-9]/).filter((part) => part !== "");
        if (head[to] === "{" && text.startsWith("#") && (rest.length >= 2 || rest.some((part) => /&|\\\\/.test(part)))) {
          const kept = (text.match(/#[1-9]/g) ?? []).join("");
          const patched = kept.padEnd(text.length, " ");
          for (let n = 0; n < text.length; n++) if (patched[n] !== text[n]) edits.set(from + n, patched[n]);
        }
      }
      i++;
    } else if (char === 37 /* % */) {
      const end = head.indexOf("\n", i);
      if (end < 0) return null;
      i = end;
    } else if (char === OPEN) open.push(i);
    else if (char === CLOSE) open.pop();
  }
  return null;
}

/** The input with the preamble's unclosed `{`s read as spaces: the same length, so every position stays where it is. */
class PatchedInput implements Input {
  constructor(readonly inner: Input, readonly positions: readonly number[], readonly edits: ReadonlyMap<number, string>) {}
  get length() { return this.inner.length; }
  get lineChunks() { return this.inner.lineChunks; }
  private patch(text: string, from: number) {
    let out = text;
    for (const at of this.positions) if (at >= from && at < from + out.length) out = `${out.slice(0, at - from)} ${out.slice(at - from + 1)}`;
    for (const [at, fill] of this.edits) if (at >= from && at < from + out.length) out = `${out.slice(0, at - from)}${fill}${out.slice(at - from + 1)}`;
    return out;
  }
  chunk(from: number) { return this.patch(this.inner.chunk(from), from); }
  read(from: number, to: number) { return this.patch(this.inner.read(from, to), from); }
}

/** Trees parsed with text-box macros (`textBoxMacros`), by the names. */
const textBoxTrees = new WeakMap<Tree, string>();

const TEXT_BOX_DEFINITION = /\\(?:g?def)\s*\\([A-Za-z@]+)\s*#1\s*(\{)|\\(?:new|renew|provide)command\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*\[1\]\s*(\{)/g;
const TEXT_BOX = /\\(?:hbox|mbox|text|textnormal|textrm|textup|textsl)\s*\{[^{}]*\}/g;
const EQUATION_ALIAS = /\\(?:new|renew)environment\*?\s*\{\s*([A-Za-z@]+)\s*\}\s*\{\s*\\begin\s*\{equation\}\s*\}\s*\{\s*\\end\s*\{equation\}\s*\}/g;
const MHEQU = /^[^%\n]*\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\bmhequ\b[^}]*\}/m;
let lastBoxHead: string | null = null;
let lastBoxes: string[] = [];

/**
 * The one-argument macros the document defines whose argument only goes into a text box (`\def\inon#1{\hbox{\ \ }\hbox{#1}}`,
 * 2611.14954's `\inon{on $\partial\Omega$,}` in an `equation`): the grammar cannot know that, and reads the `$` as the end of
 * the display. Their argument is read as text, as `\textnormal`'s. Only the start of the file is read, as for the preamble.
 */
function textBoxMacros(input: Pick<Input, "length" | "read">) {
  const head = input.read(0, Math.min(input.length, PREAMBLE_LIMIT));
  if (head === lastBoxHead) return lastBoxes;
  const names = new Set<string>();
  if (head.includes("#1")) {
    for (const match of head.matchAll(TEXT_BOX_DEFINITION)) {
      const name = match[1] ?? match[3];
      const open = match.index! + match[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let at = open; at < head.length && at < open + 400; at++) {
        const char = head[at];
        if (char === "\\") at++;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) { end = at; break; }
      }
      if (end < 0) continue;
      const body = head.slice(open + 1, end);
      if (body.includes("#1") && !body.replace(TEXT_BOX, "").includes("#1")) names.add(`c:${name}`);
    }
  }
  // An environment that is `equation` under another name (`\newenvironment{equ}{\begin{equation}}{\end{equation}}`, or
  // mhequ's `equ`, which the package makes): an equation to the grammar too (macros/definitions.ts's equationAlias agrees).
  if (head.includes("environment") || head.includes("mhequ")) {
    for (const match of head.matchAll(EQUATION_ALIAS)) names.add(`e:${match[1]}`);
    if (MHEQU.test(head) && !/\\(?:new|renew)environment\*?\s*\{equ\}/.test(head)) names.add("e:equ");
  }
  lastBoxHead = head;
  lastBoxes = [...names].sort();
  return lastBoxes;
}

/** Trees parsed with `$` read as spaces inside text boxes in math (`mathBoxDollars`), by the positions. */
const dollarTrees = new WeakMap<Tree, string>();

const MATH_ENVIRONMENT_NAMES = /^(?:equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math|dmath|dseries|empheq|split|aligned|alignedat|gathered|IEEEeqnarray|xalignat|xxalignat)\*?$/;
const RAW_ENVIRONMENT_NAMES = /^(?:verbatim\*?|lstlisting|minted|Verbatim|tikzpicture|pgfpicture|circuitikz|comment)$/;
const COLOR_BOX = /^\\(f?)colorbox\s*(?:\[[^\]]*\]\s*)?/;
let lastDollarText: string | null = null;
let lastDollars: number[] = [];

/** The `}` closing the `{` at `from` (backslash escapes and nested groups counted), or -1. */
function groupEnd(text: string, from: number) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") i++;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The `$` inside `\colorbox{c}{$0$}` and `\fcolorbox{f}{c}{$0$}` where the box is inside a formula (`$(\colorbox{red!40}{$0$},\ldots)$`,
 * an `align*`, 2611.10842): the box is a text box, so its `$` opens math again in TeX, but the grammar reads its content as
 * math and ends the formula at that `$`, splitting it. Those `$` are read as spaces (the text stays as written, and so does
 * the formula's source, which holds them): the formula is one piece. A box in text is left to the grammar, which reads it right.
 */
export function mathBoxDollars(text: string): number[] {
  if (!/\\f?colorbox/.test(text) || !text.includes("$")) return [];
  if (text === lastDollarText) return lastDollars;
  const found: number[] = [];
  let mode: "" | "$" | "$$" | "paren" | "bracket" | "env" = "";
  let envs = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "%") { const end = text.indexOf("\n", i); if (end < 0) break; i = end; continue; }
    if (char === "$") {
      if (mode === "env" || mode === "paren" || mode === "bracket") continue;
      if (text[i + 1] === "$") { mode = mode === "$$" ? "" : mode === "" ? "$$" : mode; i++; } else mode = mode === "$" ? "" : mode === "" ? "$" : mode;
      continue;
    }
    if (char !== "\\") continue;
    const rest = text.slice(i, i + 60);
    const name = /^\\(?:[A-Za-z@]+\*?|.)/.exec(rest)?.[0] ?? "\\";
    if (name === "\\(" && mode === "") mode = "paren";
    else if (name === "\\)" && mode === "paren") mode = "";
    else if (name === "\\[" && mode === "") mode = "bracket";
    else if (name === "\\]" && mode === "bracket") mode = "";
    else if (name === "\\begin" || name === "\\end") {
      const env = /^\\(?:begin|end)\s*\{([^{}]*)\}/.exec(rest);
      if (env && name === "\\begin" && RAW_ENVIRONMENT_NAMES.test(env[1])) {
        const close = text.indexOf(`\\end{${env[1]}}`, i);
        if (close < 0) break;
        i = close + env[1].length + 4;
        continue;
      }
      if (env && MATH_ENVIRONMENT_NAMES.test(env[1])) {
        if (name === "\\begin") { if (mode === "" || mode === "env") { mode = "env"; envs++; } } else if (mode === "env" && --envs <= 0) { mode = ""; envs = 0; }
      }
    } else if (name === "\\verb") {
      const delimiter = text[i + 5] === "*" ? text[i + 6] : text[i + 5];
      const close = delimiter ? text.indexOf(delimiter, i + 7) : -1;
      if (close > 0) i = close;
      continue;
    } else if (name === "\\colorbox" || name === "\\fcolorbox") {
      const head = COLOR_BOX.exec(text.slice(i, i + 200));
      if (head) {
        let at = i + head[0].length;
        const argument = () => {
          while (/\s/.test(text[at] ?? "")) at++;
          if (text[at] !== "{") return null;
          const end = groupEnd(text, at);
          if (end < 0) return null;
          const group: [number, number] = [at, end];
          at = end + 1;
          return group;
        };
        const colours = name === "\\fcolorbox" ? [argument(), argument()] : [argument()];
        const box = colours.every(Boolean) ? argument() : null;
        if (box) {
          const inner = text.slice(box[0], box[1]);
          if (mode !== "" && inner.includes("$") && !inner.includes("\\$") && !inner.includes("%")) {
            for (let k = box[0]; k < box[1]; k++) if (text[k] === "$") found.push(k);
          }
          i = box[1];
          continue;
        }
      }
    }
    i += Math.max(0, name.length - 1);
  }
  lastDollarText = text;
  lastDollars = found;
  return found;
}

/** Trees parsed with a patched preamble, by where the body started. */
const patchedTrees = new WeakMap<Tree, number>();

/**
 * A preamble group left open (a definition whose `}` is not typed yet) makes the grammar read the whole document as
 * that definition's body, and nothing after `\begin{document}` is drawn. TeX stops at such a file; here the open `{`s
 * are read as spaces, so the unfinished definition stays source (the definition reader lists it as a problem) and the
 * body is parsed as a body. Preambles whose groups close are parsed as they are.
 */
export class PreambleSafeParser extends Parser {
  constructor(readonly inner: Parser) { super(); }
  private readonly textBoxParsers = new Map<string, Parser>();
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    const patch = ranges.length === 1 && ranges[0].from === 0 ? unclosedPreambleBraces(input) : null;
    const before = fragments.length ? patchedTrees.get(fragments[0].tree) : undefined;
    // The document's macros whose argument is a text box (`\def\inon#1{\hbox{#1}}`): their argument may hold `$…$`.
    const boxes = textBoxMacros(input);
    const boxKey = boxes.join(",");
    const boxBefore = fragments.length ? textBoxTrees.get(fragments[0].tree) ?? "" : "";
    // Reading the same text another way invalidates what was parsed: all of it when the reading changes, the preamble while it is patched.
    if ((before === undefined) !== !patch || (fragments.length && boxBefore !== boxKey)) fragments = [];
    else if (patch && fragments.length) {
      const end = Math.min(input.length, Math.max(patch.end, before ?? 0) + 256);
      fragments = TreeFragment.applyChanges(fragments, [{ fromA: 0, toA: end, fromB: 0, toB: end }]);
    }
    // `$` in a colour box inside a formula, read as spaces (mathBoxDollars); the tree differs when they do.
    const dollars = input.length > 0 ? mathBoxDollars(input.read(0, input.length)) : [];
    const dollarKey = dollars.join(",");
    if (fragments.length && (dollarTrees.get(fragments[0].tree) ?? "") !== dollarKey) fragments = [];
    let parser = this.inner;
    if (boxKey) {
      let configured = this.textBoxParsers.get(boxKey);
      if (!configured) {
        if (this.textBoxParsers.size > 8) this.textBoxParsers.clear();
        const names = new Set(boxes.filter((entry) => entry.startsWith("c:")).map((entry) => `\\${entry.slice(2)}`));
        const equations = new Set(boxes.filter((entry) => entry.startsWith("e:")).map((entry) => entry.slice(2)));
        const base = this.inner instanceof LRParser ? this.inner : packageParser;
        this.textBoxParsers.set(boxKey, configured = base.configure({ specializers: [
          { from: specializeControlSequence, to: (name, stack) => (names.has(name) ? MATH_TEXT_CTRL_SEQ : specializeControlSequence(name, stack)) },
          { from: specializeEnvironmentName, to: (name, terms) => (equations.has(name) ? EQUATION_ENV_NAME : specializeEnvironmentName(name, terms)) },
        ] }));
      }
      parser = configured;
    }
    let source: Input = input;
    if (patch || dollars.length) {
      const edits = new Map(patch?.edits);
      for (const at of dollars) edits.set(at, " ");
      source = new PatchedInput(input, patch?.positions ?? [], edits);
    }
    const parse = parser.createParse(source, fragments, ranges);
    if (!patch && !boxKey && !dollars.length) return parse;
    return {
      advance() {
        const tree = parse.advance();
        if (tree) {
          if (patch) patchedTrees.set(tree, patch.end);
          if (boxKey) textBoxTrees.set(tree, boxKey);
          if (dollars.length) dollarTrees.set(tree, dollarKey);
        }
        return tree;
      },
      get parsedPos() { return parse.parsedPos; },
      stopAt(pos: number) { parse.stopAt(pos); },
      get stoppedAt() { return parse.stoppedAt; },
    };
  }
}

/** The parser for whole documents (the editor's, and chapters parsed for numbering). */
export const latexDocumentParser = new PreambleSafeParser(latexParser);
