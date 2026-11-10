import { readGroup, TEX_GROUPS } from "../../macros/core";

/* TeX's conditionals, decided where what they test is known: `\ifnum\llncs=0` with
 * `\def\llncs{0}` (a paper's mode switch), `\if0` (a way to comment text out), a `\newif`
 * switch set by `\drafttrue`, `\ifmmode` in a macro used in text. Anything else is left
 * undecided, and stays what it was (both branches source, a definition under it unknown). */

/** What a conditional's test may read. Every function answers undefined when it does not know. */
export type ConditionalFacts = {
  /** What a macro without arguments stands for when it is a plain constant (`\def\llncs{0}`: "0"). */
  constant: (name: string) => string | undefined;
  /** True for one of the document's macros (never undefined or `\relax`), false for one known to be undefined; undefined when not known. */
  defined?: (name: string) => boolean | undefined;
  /** A `\newif` switch's state (`ifdraft` after `\drafttrue`): null for a switch whose state is not known, undefined for no switch. */
  switchState?: (name: string) => boolean | null | undefined;
  /** Whether the text is read in a formula (`\ifmmode`); undefined when not known. */
  math?: boolean;
};

/** TeX's own conditionals (and engine tests): each is closed by a `\fi`. */
const PRIMITIVE_CONDITIONALS = new Set([
  "if", "ifx", "ifcat", "ifnum", "ifdim", "ifodd", "ifvmode", "ifhmode", "ifmmode", "ifinner", "ifvoid", "ifhbox", "ifvbox", "ifeof", "ifcase",
  "iftrue", "iffalse", "ifdefined", "ifcsname", "iffontchar", "ifincsname", "ifpdfprimitive", "ifabsnum", "ifabsdim", "ifpdf", "ifxetex", "ifluatex",
]);
/** etoolbox's tests of a command (`\ifdef\foo{yes}{no}`): macros with arguments, not conditionals. */
const COMMAND_TESTS = /^if(?:def|undef|cs)[a-z]*$/;

/** Whether `\name` (its name ending at `at`) opens a conditional that a `\fi` closes; `\ifbool{x}{…}{…}` and `\ifthenelse` are macros, `\iff` an arrow. */
export function opensConditional(name: string, text: string, at: number, facts?: Pick<ConditionalFacts, "switchState">) {
  if (!name.startsWith("if") || name === "ifthenelse" || name === "iff") return false;
  if (PRIMITIVE_CONDITIONALS.has(name) || facts?.switchState?.(name) !== undefined) return true;
  if (COMMAND_TESTS.test(name)) return false;
  return !/^\s*\{/.test(text.slice(at, at + 40));
}

/** Past the spaces TeX's reader drops after a control word, and one line end (not a blank line). */
export function skipAfterWord(text: string, at: number) {
  let i = at;
  while (text[i] === " " || text[i] === "\t") i++;
  if ((text[i] === "\n" || text[i] === "\r") && !/^\r?\n[ \t\r]*\n/.test(text.slice(i, i + 40))) {
    i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
    while (text[i] === " " || text[i] === "\t") i++;
  }
  return i;
}

/** Past the spaces, line ends (not a blank line) and comments TeX skips before a number or a relation. */
function skipBlanks(text: string, at: number) {
  let i = at;
  for (;;) {
    while (text[i] === " " || text[i] === "\t" || text[i] === "\r") i++;
    if (text[i] === "\n" && !/^\n[ \t\r]*\n/.test(text.slice(i, i + 40))) { i++; continue; }
    if (text[i] === "%") { const end = text.indexOf("\n", i); if (end < 0) return text.length; i = end + 1; continue; }
    return i;
  }
}

/** Whether a number written at `at` would go on (TeX reads digits on through the expansion of what follows). */
function continuesNumber(text: string, at: number, facts: ConditionalFacts) {
  if (/[0-9]/.test(text[at] ?? "")) return true;
  const command = /^\\([A-Za-z@]+)/.exec(text.slice(at, at + 80));
  return !!command && /^\s*[0-9]/.test(facts.constant(command[1]) ?? "");
}

/** An integer: digits, or a constant macro (`\llncs` for `\def\llncs{0}`); null when it is anything else (a counter, `\value{…}`). */
function readInteger(text: string, at: number, facts: ConditionalFacts): { value: number; end: number } | null {
  let i = skipBlanks(text, at);
  let sign = 1;
  while (text[i] === "-" || text[i] === "+") { if (text[i] === "-") sign = -sign; i = skipBlanks(text, i + 1); }
  const digits = /^[0-9]+/.exec(text.slice(i, i + 24));
  if (digits) {
    const end = i + digits[0].length;
    if (continuesNumber(text, end, facts)) return null;
    // One space after a number ends it and is dropped.
    return { value: sign * Number(digits[0]), end: text[end] === " " ? end + 1 : end };
  }
  const command = /^\\([A-Za-z@]+)/.exec(text.slice(i, i + 80));
  const body = command ? facts.constant(command[1]) : undefined;
  const value = body !== undefined ? /^\s*([+-]?[0-9]+)(\s*)$/.exec(body) : null;
  if (!command || !value) return null;
  const end = skipAfterWord(text, i + command[0].length);
  // `\def\x{1}` then `\x0` is 10: only a body ending in a space ends the number.
  if (!value[2] && continuesNumber(text, end, facts)) return null;
  return { value: sign * Number(value[1]), end };
}

/** Points per unit, for comparing dimensions written in different units (`em` and `ex` depend on the font: not read). */
const UNITS: Record<string, number> = { pt: 1, in: 72.27, cm: 72.27 / 2.54, mm: 72.27 / 25.4, bp: 72.27 / 72, pc: 12, dd: 1238 / 1157, cc: (12 * 1238) / 1157, sp: 1 / 65536 };
const DIMEN = /^\s*([+-]?)\s*([0-9]+(?:[.,][0-9]*)?|[.,][0-9]+)\s*(pt|in|cm|mm|bp|pc|dd|cc|sp)(?![A-Za-z])/;

/** A dimension in scaled points: written out (`2.5pt`), or a constant macro for one; null for anything else (`\linewidth`). */
function readDimen(text: string, at: number, facts: ConditionalFacts): { value: number; end: number } | null {
  const i = skipBlanks(text, at);
  const toSp = (match: RegExpExecArray) => Math.round((match[1] === "-" ? -1 : 1) * Number(match[2].replace(",", ".")) * UNITS[match[3]] * 65536);
  const written = DIMEN.exec(text.slice(i, i + 40));
  if (written) {
    const end = i + written[0].length;
    return { value: toSp(written), end: text[end] === " " ? end + 1 : end };
  }
  const command = /^\\([A-Za-z@]+)/.exec(text.slice(i, i + 80));
  const body = command ? facts.constant(command[1]) : undefined;
  const value = body !== undefined ? DIMEN.exec(body) : null;
  if (!command || !value || body!.slice(value[0].length).trim()) return null;
  return { value: toSp(value), end: skipAfterWord(text, i + command[0].length) };
}

/** A relation of `\ifnum` and `\ifdim` between two values read by `read`. */
function decideRelation(text: string, at: number, facts: ConditionalFacts, read: typeof readInteger) {
  const left = read(text, at, facts);
  if (!left) return null;
  const i = skipBlanks(text, left.end);
  const relation = text[i];
  if (relation !== "<" && relation !== "=" && relation !== ">") return null;
  const right = read(text, i + 1, facts);
  if (!right) return null;
  return { value: relation === "<" ? left.value < right.value : relation === ">" ? left.value > right.value : left.value === right.value, end: right.end };
}

/** One token of `\if` and `\ifx`'s test, at `at`: a character or a command's name. */
function testToken(text: string, at: number): { char?: string; command?: string; end: number } | null {
  const char = text[at];
  if (char === undefined || char === "%" || /\s/.test(char)) return null;
  if (char !== "\\") return { char, end: at + 1 };
  const command = /^\\([A-Za-z@]+|[^A-Za-z@])/.exec(text.slice(at, at + 80));
  // Spaces after a control word are not tokens: the branch starts after them.
  return command ? { command: command[1], end: /^[A-Za-z@]/.test(command[1]) ? skipAfterWord(text, at + command[0].length) : at + command[0].length } : null;
}

/**
 * LaTeX's commands that never stand for a character: what `\if0` compares with when an author comments out a part
 * of the text (`\if0\begin{lemma}…\fi`, `\if0\paragraph{…}`). Anything else might (a package's macro), and is not read.
 */
const NOT_CHARACTERS = /^(?:begin|end|par|relax|noindent|indent|item|label|section|subsection|subsubsection|paragraph|subparagraph|chapter|part|textbf|textit|emph|footnote|cite|ref|vspace|hspace|medskip|smallskip|bigskip|newpage|clearpage|centering|small|footnotesize|large|Large|bf|it|em)$/;
/** Names that stand for no command at all, which `\ifx\x\undefined` compares with. */
const UNDEFINED = /^(?:undefined|@undefined|relax)$/;

/** `\if` and `\ifx`: two characters, or two of the document's constant macros (`\ifx\mode\draftmode`). */
function decideTokens(text: string, at: number, name: "if" | "ifx", facts: ConditionalFacts): { value: boolean; end: number } | null {
  const first = testToken(text, skipAfterWord(text, at));
  if (!first) return null;
  if (first.command !== undefined) {
    // `\if\a…` expands `\a`, whose characters are not read here.
    if (name === "if") return null;
    const second = testToken(text, skipAfterWord(text, first.end));
    if (!second || second.command === undefined) return null;
    const [a, b] = [first.command, second.command];
    if (a === b) return { value: true, end: second.end };
    // One of the document's macros is neither undefined nor `\relax` (`\ifx\llncs\undefined`).
    if ((UNDEFINED.test(b) && facts.defined?.(a)) || (UNDEFINED.test(a) && facts.defined?.(b))) return { value: false, end: second.end };
    // One known to be undefined (its only definition commented out: `% \def\conference`) is `\undefined`.
    if ((UNDEFINED.test(b) && facts.defined?.(a) === false) || (UNDEFINED.test(a) && facts.defined?.(b) === false)) return { value: true, end: second.end };
    // Two constants that differ (the same text may still differ in TeX: `\long` or not).
    const [x, y] = [facts.constant(a), facts.constant(b)];
    return x !== undefined && y !== undefined && x !== y ? { value: false, end: second.end } : null;
  }
  let i = first.end;
  if (text[i] === "%") {
    // A comment ends the line without a space: the test goes on at the next line's first token.
    const end = text.indexOf("\n", i);
    if (end < 0) return null;
    i = end + 1;
    while (text[i] === " " || text[i] === "\t") i++;
  } else if (/\s/.test(text[i] ?? "")) {
    // A space (a line end too) is the second token, which no character equals: `\if0` on its own line is false.
    // Written `\ifx 1 1`, the author may mean the two characters: not decided.
    const next = testToken(text, skipBlanks(text, i));
    return next?.char === first.char ? null : { value: false, end: i + 1 };
  }
  const second = testToken(text, i);
  if (!second) return null;
  if (second.char !== undefined) return { value: second.char === first.char, end: second.end };
  const constant = facts.constant(second.command!);
  // `\if1\flag` with `\def\flag{1}` (one character: a longer one leaves the rest in a branch).
  if (name === "if" && constant !== undefined) return constant.length === 1 ? { value: constant === first.char, end: second.end } : null;
  // A macro is never a character for `\ifx`; LaTeX's own commands are none for `\if` either.
  if ((name === "ifx" && facts.defined?.(second.command!)) || NOT_CHARACTERS.test(second.command!)) return { value: false, end: second.end };
  return null;
}

/**
 * Decides the conditional `\name` whose test starts at `at` (just after its name): its value and where its first
 * branch starts, or null when what it tests is not known.
 */
export function decideConditional(text: string, at: number, name: string, facts: ConditionalFacts): { value: boolean; end: number } | null {
  if (name === "iftrue" || name === "iffalse") return { value: name === "iftrue", end: skipAfterWord(text, at) };
  if (name === "ifmmode") return facts.math === undefined ? null : { value: facts.math, end: skipAfterWord(text, at) };
  if (name === "ifnum") return decideRelation(text, at, facts, readInteger);
  if (name === "ifdim") return decideRelation(text, at, facts, readDimen);
  if (name === "ifodd") {
    const number = readInteger(text, at, facts);
    return number && { value: Math.abs(number.value) % 2 === 1, end: number.end };
  }
  if (name === "if" || name === "ifx") return decideTokens(text, at, name, facts);
  if (name === "ifdefined") {
    const command = testToken(text, skipAfterWord(text, at));
    if (command?.command === undefined) return null;
    // `\ifdefined\undefined` (a way to comment text out) is false, as for a name known to be undefined.
    if (/^@?undefined$/.test(command.command) || facts.defined?.(command.command) === false) return { value: false, end: command.end };
    return facts.defined?.(command.command) ? { value: true, end: command.end } : null;
  }
  if (name === "ifcsname") {
    // `\ifcsname name\endcsname`: whether the command of that name (letters) is defined.
    const named = /^\s*([A-Za-z@]+)\s*\\endcsname(?![A-Za-z@])/.exec(text.slice(at, at + 120));
    const state = named ? facts.defined?.(named[1]) : undefined;
    return named && state !== undefined ? { value: state, end: skipAfterWord(text, at + named[0].length) } : null;
  }
  const state = facts.switchState?.(name);
  return state === undefined || state === null ? null : { value: state, end: skipAfterWord(text, at) };
}

/** Where the conditional whose test starts at `from` ends: the `\else` at its level (-1 when none) and its `\fi`; null when it is not closed. */
function conditionalExtent(text: string, from: number, facts: ConditionalFacts) {
  // Escaped characters (`\%`, `\\`) first: they are no comment and no command.
  const token = /\\[^A-Za-z@]|%[^\n]*|\\(if[A-Za-z@]*|fi|else|or)(?![A-Za-z@])/g;
  token.lastIndex = from;
  let depth = 0;
  let elseAt = -1;
  let elseEnd = -1;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    const name = match[1];
    if (!name) continue;
    if (name === "fi") {
      if (depth === 0) return { elseAt, elseEnd, fiAt: match.index, fiEnd: match.index + match[0].length };
      depth--;
    } else if (name === "else" || name === "or") {
      // `\ifcase`'s `\or`s: not read.
      if (depth === 0 && name === "or") return null;
      if (depth === 0 && elseAt < 0) { elseAt = match.index; elseEnd = match.index + match[0].length; }
    } else if (opensConditional(name, text, match.index + match[0].length, facts)) depth++;
  }
  return null;
}

/**
 * The conditionals in a macro's expansion replaced by the branch they take, where it is known (estout's
 * `\def\sym#1{\ifmmode^{#1}\else\(^{#1}\)\fi}` in text is `\(^{#1}\)`). One that is not decided stays whole, so
 * the expansion still shows it is TeX programming.
 */
export function evaluateTexConditionals(text: string, facts: ConditionalFacts, depth = 0): string {
  if (!text.includes("\\if") || depth > 8) return text;
  const token = /\\[^A-Za-z@]|%[^\n]*|\\(?:(unless)\s*\\)?(if[A-Za-z@]*)(?![A-Za-z@])/g;
  let output = "";
  let copied = 0;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    const name = match[2];
    if (!name) continue;
    const after = match.index + match[0].length;
    if (!opensConditional(name, text, after, facts)) continue;
    const extent = conditionalExtent(text, after, facts);
    if (!extent) break;
    const decided = decideConditional(text, after, name, facts);
    const firstEnd = extent.elseAt >= 0 ? extent.elseAt : extent.fiAt;
    if (decided && decided.end <= firstEnd) {
      const value = decided.value !== !!match[1];
      const chosen = value ? text.slice(decided.end, firstEnd) : extent.elseAt >= 0 ? text.slice(skipAfterWord(text, extent.elseEnd), extent.fiAt) : "";
      output += text.slice(copied, match.index) + evaluateTexConditionals(chosen, facts, depth + 1);
      // TeX's reader drops the spaces after `\fi`.
      copied = skipAfterWord(text, extent.fiEnd);
    }
    token.lastIndex = extent.fiEnd;
  }
  return output + text.slice(copied);
}

/** One `{…}` argument of an ifthen test, after spaces. */
function testGroup(text: string, at: number) {
  let i = at;
  while (/\s/.test(text[i] ?? "")) i++;
  return readGroup(text, i, TEX_GROUPS);
}

/** What an `\equal` argument is: its text, or a constant macro's; undefined when it holds commands. */
function plainText(text: string, facts: ConditionalFacts) {
  const command = /^\s*\\([A-Za-z@]+)\s*$/.exec(text);
  if (command) return facts.constant(command[1]);
  return text.includes("\\") ? undefined : text;
}

/** ifthen's test: `\boolean{x}`, `\equal{a}{b}`, `\isodd{n}`, a relation of numbers, with `\not`, `\and` and `\or` (left to right). */
function decideIfThenTest(test: string, facts: ConditionalFacts): boolean | null {
  let i = 0;
  let result: boolean | null = null;
  let join: "and" | "or" | null = null;
  for (;;) {
    let negate = false;
    for (let not = /^\s*\\(?:not|NOT)(?![A-Za-z@])/.exec(test.slice(i)); not; not = /^\s*\\(?:not|NOT)(?![A-Za-z@])/.exec(test.slice(i))) { negate = !negate; i += not[0].length; }
    const command = /^\s*\\(boolean|equal|isodd)(?![A-Za-z@])/.exec(test.slice(i));
    let value: boolean | null = null;
    if (command) {
      i += command[0].length;
      const first = testGroup(test, i);
      if (!first) return null;
      i = first.end;
      if (command[1] === "boolean") {
        const state = /^\s*[A-Za-z@]+\s*$/.test(first.content) ? facts.switchState?.(`if${first.content.trim()}`) : undefined;
        value = state === undefined ? null : state;
      } else if (command[1] === "isodd") {
        const number = readInteger(`${first.content} `, 0, facts);
        value = number && !`${first.content} `.slice(number.end).trim() ? Math.abs(number.value) % 2 === 1 : null;
      } else {
        const second = testGroup(test, i);
        if (!second) return null;
        i = second.end;
        const [a, b] = [plainText(first.content, facts), plainText(second.content, facts)];
        value = a === undefined || b === undefined ? null : a === b;
      }
    } else {
      const relation = decideRelation(test, i, facts, readInteger);
      if (!relation) return null;
      value = relation.value;
      i = relation.end;
    }
    if (value === null) return null;
    if (negate) value = !value;
    result = join === null ? value : join === "and" ? result! && value : result! || value;
    const next = /^\s*\\(and|AND|or|OR)(?![A-Za-z@])/.exec(test.slice(i));
    if (!next) return test.slice(i).trim() ? null : result;
    join = next[1].toLowerCase() as "and" | "or";
    i += next[0].length;
  }
}

/**
 * Tests that take their branches as arguments (etoolbox's and ifthen's), not closed by `\fi`: `\iftoggle{t}{yes}{no}`,
 * `\nottoggle`, `\ifbool{b}`, `\notbool`, `\ifdef{\cmd}`, `\ifndef`, `\ifundef`, `\ifcsdef{name}`, `\ifcsundef`,
 * `\ifdefempty{\cmd}`, and `\ifthenelse{test}`.
 */
export const BRACED_CONDITIONAL = /^(?:(?:if|not)(?:toggle|bool)|if(?:def|ndef|undef|csdef|csundef|defempty)|ifthenelse)$/;

/** etoolbox's toggles share the switches' table (definitions.ts), under this prefix: `\newtoggle{long}` is `toggle:long`. */
export const TOGGLE_PREFIX = "toggle:";

export type BracedConditional = {
  /** The branch it takes; null when what it tests is not known. */
  value: boolean | null;
  /** The `{yes}` and `{no}` groups: where each opens (its `{`) and ends (after its `}`). */
  yes: { from: number; to: number };
  no: { from: number; to: number };
};

/** One `{…}` group or one command after spaces: a braced test's argument. */
function bracedArgument(text: string, at: number) {
  let i = at;
  while (/\s/.test(text[i] ?? "")) i++;
  if (text[i] === "{") {
    const group = readGroup(text, i, TEX_GROUPS);
    return group ? { content: group.content, from: i, end: group.end } : null;
  }
  const command = /^\\[A-Za-z@]+/.exec(text.slice(i, i + 80));
  return command ? { content: command[0], from: i, end: i + command[0].length } : null;
}

/**
 * The braced test `\name` whose arguments start at `at` (just after its name): its value and its two branches; null
 * when it is not written as one (a branch is not a group: an unfinished one being typed).
 */
export function decideBracedConditional(text: string, at: number, name: string, facts: ConditionalFacts): BracedConditional | null {
  if (!BRACED_CONDITIONAL.test(name)) return null;
  const test = bracedArgument(text, at);
  const yes = test && bracedArgument(text, test.end);
  const no = yes && bracedArgument(text, yes.end);
  if (!test || !yes || !no || text[yes.from] !== "{" || text[no.from] !== "{") return null;
  const argument = test.content.trim();
  const command = /^\\?([A-Za-z@]+)$/.exec(argument)?.[1];
  let value: boolean | null = null;
  if (name === "ifthenelse") value = decideIfThenTest(test.content, facts);
  else if (/toggle$/.test(name)) value = command ? facts.switchState?.(`${TOGGLE_PREFIX}${command}`) ?? null : null;
  else if (/bool$/.test(name)) value = command ? facts.switchState?.(`if${command}`) ?? null : null;
  else if (name === "ifdefempty") {
    // Empty: a macro without arguments whose body is nothing; one whose body holds anything is not.
    const constant = command && argument.startsWith("\\") ? facts.constant(command) : undefined;
    value = constant !== undefined ? constant === "" : command && facts.defined?.(command) === false ? false : null;
  } else {
    // `\ifcsdef{name}` names the command by its letters; `\ifdef{\name}` writes it.
    const byName = name === "ifcsdef" || name === "ifcsundef";
    const defined = command && byName === !argument.startsWith("\\") ? facts.defined?.(command) : undefined;
    value = defined === undefined ? null : name === "ifdef" || name === "ifcsdef" ? defined : !defined;
  }
  if (value !== null && name.startsWith("not")) value = !value;
  return { value, yes: { from: yes.from, to: yes.end }, no: { from: no.from, to: no.end } };
}

/** ifthen's `\ifthenelse{test}{yes}{no}` replaced by the branch it takes, where the test is known; others stay. */
export function evaluateIfThenElse(text: string, facts: ConditionalFacts, depth = 0): string {
  // (And etoolbox's braced tests: `\iftoggle{long}{L}{S}` in a macro's body.)
  if (!/\\(?:if|not)/.test(text) || depth > 8) return text;
  const pattern = /\\((?:if|not)[A-Za-z@]*)(?![A-Za-z@])/g;
  let output = "";
  let copied = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (!BRACED_CONDITIONAL.test(match[1])) continue;
    const decided = decideBracedConditional(text, match.index + match[0].length, match[1], facts);
    if (!decided || decided.value === null) continue;
    const chosen = decided.value ? decided.yes : decided.no;
    output += text.slice(copied, match.index) + evaluateIfThenElse(text.slice(chosen.from + 1, chosen.to - 1), facts, depth + 1);
    copied = decided.no.to;
    pattern.lastIndex = decided.no.to;
  }
  return output + text.slice(copied);
}
