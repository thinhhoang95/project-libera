import { Parser, TreeFragment, type Input, type PartialParse, type Tree } from "@lezer/common";
import { ExternalTokenizer } from "@lezer/lr";
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
export function unclosedPreambleBraces(input: Pick<Input, "length" | "read">): { positions: number[]; edits: Map<number, string>; end: number } | null {
  const head = input.read(0, Math.min(input.length, PREAMBLE_LIMIT));
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
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    const patch = ranges.length === 1 && ranges[0].from === 0 ? unclosedPreambleBraces(input) : null;
    const before = fragments.length ? patchedTrees.get(fragments[0].tree) : undefined;
    // Reading the same text another way invalidates what was parsed: all of it when the reading changes, the preamble while it is patched.
    if ((before === undefined) !== !patch) fragments = [];
    else if (patch && fragments.length) {
      const end = Math.min(input.length, Math.max(patch.end, before ?? 0) + 256);
      fragments = TreeFragment.applyChanges(fragments, [{ fromA: 0, toA: end, fromB: 0, toB: end }]);
    }
    const parse = this.inner.createParse(patch ? new PatchedInput(input, patch.positions, patch.edits) : input, fragments, ranges);
    if (!patch) return parse;
    return {
      advance() {
        const tree = parse.advance();
        if (tree) patchedTrees.set(tree, patch.end);
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
