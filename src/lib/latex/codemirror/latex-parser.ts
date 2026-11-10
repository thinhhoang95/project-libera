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
const specializeEnvironmentName: typeof specializeEnvName = (name, terms) => MORE_MATH_ENVIRONMENTS[name] ?? specializeEnvName(name, terms);

export const latexParser = packageParser.configure({
  tokenizers: [{ from: literalArgTokenizer, to: nestedLiteralArgTokenizer }],
  specializers: [{ from: specializeCtrlSeq, to: specializeControlSequence }, { from: specializeEnvName, to: specializeEnvironmentName }],
});
