import { readGroup, readOptional } from "../../../macros/core";
import { macroAt, type LatexDefinitions } from "../../macros/definitions";
import { expandLatexMacroUse } from "../../macros/expand";

/* The body of an `algorithmic` environment, for the Visual mode: the
 * statements of the algorithmic package (\STATE, \IF, \FOR …) and of
 * algpseudocode (\State, \If, \For …), as numbered, indented lines; and the
 * body of algorithm2e's `algorithm` (\KwIn, \For{…}{…}, statements ending
 * with \;). Each line keeps where its LaTeX is, so a statement can be edited
 * on its own. What a reader does not know is a line of source inside the
 * drawn algorithm (`raw`); only unbalanced braces or formulas, or a body with
 * nothing it knows, make the reading null: left as source. */

export type SourceRange = { from: number; to: number };
/** Where a line's LaTeX is in the body; `exact` false when it comes from a macro's expansion (shown, not edited). */
export type LineSource = SourceRange & { exact: boolean };

export type AlgorithmLine = {
  /** Nesting level, for the indentation. */
  depth: number;
  /** A keyword before the text ("for", "if", "Require:") and one after it ("do", "then"). */
  lead?: string;
  text: string;
  trail?: string;
  /** `\Comment{…}` at the end of the line. */
  comment?: string;
  /** Lines the package numbers (not \Require, \Ensure, \Statex). */
  numbered: boolean;
  /** A rule across the algorithm (`\\\hrulefill` between statements, GaLore's), dotted for `\dotfill`; the line has no text. */
  rule?: "solid" | "dotted";
  /** The line's own LaTeX (offsets from the body's start): a block's first line without the lines inside it. */
  source?: LineSource;
  /** A block's first line ("open"), its middle (`\Else`) and last lines ("close"): the block is deleted only whole. */
  role?: "open" | "middle" | "close";
  /** A block's first line: the whole block, to its last line. */
  block?: SourceRange;
  /** Where a statement inserted below this line goes (inside the block, for a block's first line). */
  after?: number;
  /** Source the reader does not know, drawn as its LaTeX (`text`) in the algorithm. */
  raw?: boolean;
  /** The numbers of the lines after this one cannot be known (a definition, or an unknown block, changes them). */
  uncertain?: boolean;
  /** `\label` (and algorithm2e's `\nllabel`, `\lnl`) on the line: the key, and where the command is in the body. */
  labels?: Array<{ key: string; at: number }>;
};

export type AlgorithmSpec = {
  lines: AlgorithmLine[];
  numberEvery: number;
  /** Which package's statements the lines are written with. */
  package?: "algorithmic" | "algorithm2e";
  /** Where the body starts: in the document when read, then (walk.ts) from the widget's start. */
  offset?: number;
};

/** The document's macro used at the start of `source` (its name and arguments), expanded; null when it is none. */
export type AlgorithmMacroExpander = (source: string) => { text: string; length: number } | null;

type Kind = { lead?: string; trail?: string; args: number; open?: boolean; close?: boolean; middle?: boolean; numbered?: boolean; name?: boolean; block?: boolean };

/* ---- where each character read comes from ------------------------------------------ */

/**
 * For each character of a text being read: its offset in the body, -1 for none (declarations read before it), or
 * -2-k for the k-th macro use (`uses`) it was expanded from.
 */
type Origin = number[];

const identity = (length: number, start = 0): Origin => Array.from({ length }, (_, i) => start + i);

/** Where [a, b) of a text read is in the body (spaces at its ends left out), or null when it is from nowhere there. */
function located(text: string, origin: Origin, uses: SourceRange[], a: number, b: number): LineSource | null {
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  if (a >= b) return null;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  let exact = true;
  for (let k = a; k < b; k++) {
    const at = origin[k];
    if (at >= 0) { from = Math.min(from, at); to = Math.max(to, at + 1); continue; }
    exact = false;
    const use = at <= -2 ? uses[-2 - at] : undefined;
    if (use) { from = Math.min(from, use.from); to = Math.max(to, use.to); }
  }
  if (!(from < to)) return null;
  return { from, to, exact: exact && to - from === b - a };
}

/** The body offset of position `k` of a text read (the end of the character before it at its end), or null. */
function offsetOf(origin: Origin, k: number) {
  if (k < origin.length && origin[k] >= 0) return origin[k];
  if (k > 0 && k - 1 < origin.length && origin[k - 1] >= 0) return origin[k - 1] + 1;
  return null;
}

/** `text` with [at, at + length) replaced by `insert` (a macro's expansion), its characters marked as from that use. */
function splice(text: string, origin: Origin, uses: SourceRange[], at: number, length: number, insert: string) {
  const use = located(text, origin, uses, at, at + length);
  const mark = use ? -2 - (uses.push({ from: use.from, to: use.to }) - 1) : -1;
  origin.splice(at, length, ...new Array<number>(insert.length).fill(mark));
  return text.slice(0, at) + insert + text.slice(at + length);
}

/** Spaces as long as `text`: what is not read keeps its place. */
const blank = (text: string) => " ".repeat(text.length);

/* ---- algorithmic / algpseudocode -------------------------------------------------------- */

/**
 * The statements algorithmicx's `\algdef{SE}`, `\algblockdefx` and `\algblock` define (macros/packages.ts writes their
 * commands as these markers): a block's first line, with its text, and its last line (none when its text is empty).
 */
const BLOCK_STATEMENTS: Record<string, Kind> = {
  "algorithmic@begin": { args: 1, open: true, block: true },
  "algorithmic@end": { args: 1, close: true, block: true },
};

/** The statement `name` is, written as algorithmic (`\FORALL`) or algpseudocode (`\ForAll`) write it: never `\forall` or `\repeat`. */
function statementKind(name: string): Kind | undefined {
  return BLOCK_STATEMENTS[name] ?? (/^[A-Z]/.test(name) ? STATEMENTS[name.toLowerCase()] : undefined);
}

/** The blocks a block's last line closes, by its lower-cased name. */
const CLOSES: Record<string, string[]> = {
  endif: ["if"], endfor: ["for", "forall"], endwhile: ["while"], until: ["repeat"], endloop: ["loop"], endfunction: ["function"],
  endprocedure: ["procedure"], "algorithmic@end": ["algorithmic@begin"],
};

/** Capitalised commands in a statement's text, not statements of their own. */
const ALGORITHMIC_TEXT = /^(?:Call|TRUE|FALSE|AND|OR|XOR|NOT|TO|Comment|COMMENT|LaTeX|TeX|Cref|Autoref|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|Huge|LARGE|Big|Bigg|Bigl|Bigr|Biggl|Biggr|Bigm|Rightarrow|Leftarrow|Leftrightarrow|Longrightarrow|Longleftarrow|Re|Im)$/;

/** Where the formula starting at `at` (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) ends, or -1. */
function formulaEnd(text: string, at: number) {
  if (!text.startsWith("\\[", at)) return mathEnd(text, at);
  const close = text.indexOf("\\]", at + 2);
  return close < 0 ? -1 : close + 2;
}

/** algorithmic's and algpseudocode's words in a statement: `\Call{Name}{args}` as Name(args) in small capitals, `\TRUE`, `\AND`. */
const ALGORITHMIC_WORDS: Record<string, string> = { AND: "and", OR: "or", XOR: "xor", NOT: "not", TO: "to", TRUE: "true", FALSE: "false" };

function algorithmicWords(text: string) {
  if (!text.includes("\\")) return text;
  let out = "";
  let at = 0;
  for (const match of text.matchAll(/\\(Call|textproc|AND|OR|XOR|NOT|TO|TRUE|FALSE|algorithmic(?:end|do|while|for|forall|loop|repeat|until|procedure|function|if|then|else|return))(?![A-Za-z@])\s*/g)) {
    if (match.index! < at) continue;
    const name = match[1];
    let end = match.index! + match[0].length;
    let drawn: string;
    if (name === "Call") {
      const procedure = text[end] === "{" ? readGroup(text, end) : null;
      let space = procedure ? procedure.end : end;
      while (/\s/.test(text[space] ?? "")) space++;
      const args = procedure && text[space] === "{" ? readGroup(text, space) : null;
      if (!procedure || !args) continue;
      drawn = `\\textsc{${procedure.content}}${args.content.trim() ? `(${args.content})` : ""}`;
      end = args.end;
    } else if (name === "textproc") drawn = "\\textsc";
    else drawn = `\\textbf{${ALGORITHMIC_WORDS[name] ?? (name === "algorithmicforall" ? "for all" : name.slice("algorithmic".length))}} `;
    out += text.slice(at, match.index) + drawn;
    at = end;
  }
  return out + text.slice(at);
}

/** Statements and comments: what a macro of the document must write for its use to be read as part of the algorithm. */
function writesStatements(text: string) {
  for (const match of text.matchAll(/\\([A-Za-z@]+)/g)) if (statementKind(match[1]) || match[1] === "Comment" || match[1] === "COMMENT") return true;
  return false;
}

/**
 * The document's macros that write statements, expanded where they are used between statements: algpseudocode's
 * `\algnewcommand{\LineComment}[1]{\State \(\triangleright\) #1}`, a comment macro (`\Cmnt{…}`, 1610.05820), and the
 * blocks `\algdef` defines. Other macros are left for the text they are in.
 */
function expandStatementMacros(source: string, origin: Origin, uses: SourceRange[], expand: AlgorithmMacroExpander) {
  let out = source;
  let braces = 0;
  for (let i = 0, expansions = 0; i < out.length; i++) {
    const char = out[i];
    if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "$" || out.startsWith("\\(", i) || out.startsWith("\\[", i)) { const close = formulaEnd(out, i); if (close < 0) return out; i = close - 1; }
    else if (char === "\\" && braces === 0) {
      const name = /^\\([A-Za-z@]+)/.exec(out.slice(i, i + 80));
      if (!name) { i++; continue; }
      const use = statementKind(name[1]) || expansions >= 200 ? null : expand(out.slice(i));
      if (use && writesStatements(use.text)) {
        out = splice(out, origin, uses, i, use.length, use.text);
        expansions++;
        i--;
        continue;
      }
      i += name[0].length - 1;
    }
  }
  return out;
}

/** A plain label from a keyword's definition (`\renewcommand{\algorithmicrequire}{\textbf{Input:}}`), or null. */
function plainLabel(text: string) {
  const label = text.replace(/\\(?:textbf|bfseries|textnormal|textrm)(?![A-Za-z@])\s*/g, "").replace(/[{}]/g, "").replace(/\\ /g, " ").trim();
  return label && !/[\\$#^_&%]/.test(label) ? label : null;
}

/** `\\` and a fill after a statement (`\\\hrulefill`), or a statement that is only a fill: a rule. */
const RULE_AFTER = /(?:\\\\|\\newline)\s*\\(hrulefill|dotfill)\s*$/;
const ONLY_RULE = /^\s*\\(hrulefill|dotfill)\s*$/;

/** Statements by lower-cased name (algorithmic writes them in capitals, algpseudocode in title case). */
const STATEMENTS: Record<string, Kind> = {
  state: { args: 0 },
  statex: { args: 0, numbered: false },
  require: { lead: "Require:", args: 0, numbered: false },
  ensure: { lead: "Ensure:", args: 0, numbered: false },
  input: { lead: "Input:", args: 0, numbered: false },
  output: { lead: "Output:", args: 0, numbered: false },
  return: { lead: "return", args: 0 },
  print: { lead: "print", args: 0 },
  if: { lead: "if", trail: "then", args: 1, open: true },
  elsif: { lead: "else if", trail: "then", args: 1, middle: true },
  elseif: { lead: "else if", trail: "then", args: 1, middle: true },
  else: { lead: "else", args: 0, middle: true },
  endif: { lead: "end if", args: 0, close: true },
  for: { lead: "for", trail: "do", args: 1, open: true },
  forall: { lead: "for all", trail: "do", args: 1, open: true },
  endfor: { lead: "end for", args: 0, close: true },
  while: { lead: "while", trail: "do", args: 1, open: true },
  endwhile: { lead: "end while", args: 0, close: true },
  repeat: { lead: "repeat", args: 0, open: true },
  until: { lead: "until", args: 1, close: true },
  loop: { lead: "loop", args: 0, open: true },
  endloop: { lead: "end loop", args: 0, close: true },
  function: { lead: "function", args: 2, open: true, name: true },
  endfunction: { lead: "end function", args: 0, close: true },
  procedure: { lead: "procedure", args: 2, open: true, name: true },
  endprocedure: { lead: "end procedure", args: 0, close: true },
};

/**
 * The lines of an algorithmic body, and how often lines are numbered
 * (`\begin{algorithmic}[1]`: every line; none: 0). Text before the first
 * statement, a statement it does not know (a capitalised command starting a
 * line: `\ForEach{…}` no package here defines), a statement without its
 * argument, a block's last line that closes no open block, and a block left
 * open (being typed), are drawn as their source. Null when braces or a
 * formula do not close, or no statement is known.
 */
export function parseAlgorithmic(body: string, options: string | null, expand?: AlgorithmMacroExpander): AlgorithmSpec | null {
  const numberEvery = options && /^\s*\d+\s*$/.test(options) ? Number(options) : 0;
  const origin = identity(body.length);
  const uses: SourceRange[] = [];
  // Comments are not read (they keep their place, as spaces).
  let source = body.replace(/(^|[^\\])(%[^\n]*)/g, (_whole, before: string, comment: string) => before + blank(comment));
  if (expand) source = expandStatementMacros(source, origin, uses, expand);
  // Labels, vertical space and size switches are not lines of the algorithm; a label is its line's.
  const labels: Array<{ key: string; at: number }> = [];
  source = source.replace(/\\label\s*\{([^{}]*)\}/g, (whole, key: string, at: number) => { labels.push({ key: key.trim(), at }); return blank(whole); });
  source = source.replace(/\\(?:vspace\*?|addvspace)\s*\{[^{}]*\}|\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large)(?![A-Za-z@])/g, blank);
  // `\renewcommand{\algorithmicrequire}{\textbf{Input:}}`: the label the document gives \Require and \Ensure.
  const keywordLabels: Record<string, string> = {};
  for (const key of expand ? ["require", "ensure"] : []) {
    const use = expand!(`\\algorithmic${key}`);
    const label = use && plainLabel(use.text);
    if (label) keywordLabels[key] = label;
  }
  const where = (a: number, b: number) => located(source, origin, uses, a, b);
  const lines: AlgorithmLine[] = [];
  const statement = /\\([A-Za-z@]+)(?![A-Za-z@])/g;
  /** Whether `at` starts a line of the source (only spaces before it on its line). */
  const startsLine = (at: number) => !source.slice(source.lastIndexOf("\n", at - 1) + 1, at).trim();
  // Find each statement command at brace depth zero, outside formulas (`\STATE $\forall i$` is no \FORALL); the text up
  // to the next one is its line. A capitalised command it does not know, starting a line, is a statement of its own
  // (shown as source); algorithmicx's `\algstore` and `\algrestore` too.
  const starts: Array<{ at: number; name: string; kind?: Kind; end: number }> = [];
  let braces = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (braces === 0 && (char === "$" || source.startsWith("\\(", i) || source.startsWith("\\[", i))) {
      const close = formulaEnd(source, i);
      if (close < 0) return null;
      i = close - 1;
    } else if (char === "\\" && braces === 0) {
      statement.lastIndex = i;
      const match = statement.exec(source);
      if (match && match.index === i) {
        const name = match[1];
        const kind = statementKind(name);
        if (kind) starts.push({ at: i, name, kind, end: i + match[0].length });
        else if (/^algrestore|^algstore/.test(name)
          || (/^[A-Z]/.test(name) && !ALGORITHMIC_TEXT.test(name) && startsLine(i) && !expand?.(source.slice(i, i + 2000)))) {
          starts.push({ at: i, name, end: i + match[0].length });
        }
        i += match[0].length - 1;
      } else i++;
    }
  }
  if (braces !== 0 || !starts.some((start) => start.kind)) return null;
  const raw = (depth: number, at: LineSource | null, numbered: boolean, uncertain = false): AlgorithmLine | null => (at ? {
    depth, text: body.slice(at.from, at.to), raw: true, numbered, source: at, after: at.to, ...(uncertain ? { uncertain } : {}),
  } : null);
  const add = (line: AlgorithmLine | null) => { if (line) lines.push(line); return line; };
  // Text before the first statement: source, at the top.
  add(raw(0, where(0, starts[0].at), false));
  let depth = 0;
  /** The blocks open: their first line (none for an `\algdef` block whose text is empty), name and where they start. */
  const open: Array<{ line: AlgorithmLine | null; name: string; at: number; from: number }> = [];
  /** A `\State` drawn as nothing (`\State \Return x`): written before the statement after it, which it is part of. */
  let carried = -1;
  for (let index = 0; index < starts.length; index++) {
    const { kind, end, name, at: startAt } = starts[index];
    const lineEnd = index + 1 < starts.length ? starts[index + 1].at : source.length;
    const from = carried >= 0 ? carried : startAt;
    carried = -1;
    const own = where(from, lineEnd);
    const ownLabels = labels.filter((label) => label.at >= from && label.at < lineEnd && origin[label.at] >= 0).map((label) => ({ key: label.key, at: origin[label.at] }));
    const withLabels = (line: AlgorithmLine | null) => { if (line && ownLabels.length) line.labels = ownLabels; return line; };
    // A statement it does not know: one line of source, numbered as algorithmicx numbers its statements.
    if (!kind) { withLabels(add(raw(depth, own, !/^alg/.test(name), name.startsWith("algrestore")))); continue; }
    let at = end;
    const skip = () => { while (/\s/.test(source[at] ?? "")) at++; };
    const args: string[] = [];
    for (let n = 0; n < kind.args; n++) {
      skip();
      const group = readGroup(source, at);
      if (!group || group.end > lineEnd) break;
      args.push(group.content.trim());
      at = group.end;
    }
    const lower = name.toLowerCase();
    const top = open[open.length - 1];
    // Without its argument (being typed), or a middle or last line of no open block: source.
    if (args.length < kind.args || ((kind.close || kind.middle) && (!top || !(kind.middle ? top.name === "if" : CLOSES[lower]?.includes(top.name))))) {
      withLabels(add(raw(depth, own, false)));
      continue;
    }
    // `\ENDIF` after \ELSE is still one level in: close before drawing, open after.
    if (kind.close || kind.middle) depth = Math.max(0, depth - 1);
    let rest = source.slice(at, lineEnd);
    let comment: string | undefined;
    const commentAt = /\\(?:Comment|COMMENT)\s*\{/.exec(rest);
    if (commentAt) {
      const group = readGroup(rest, commentAt.index + commentAt[0].length - 1);
      if (group) { comment = group.content.trim(); rest = rest.slice(0, commentAt.index) + rest.slice(group.end); }
    } else {
      // `\COMMENT Training BN network`, without braces: the rest of the statement (not one inside a tabular there).
      const bare = /\\(?:Comment|COMMENT)(?![A-Za-z@])\s*/.exec(rest);
      const before = bare ? rest.slice(0, bare.index) : "";
      if (bare && (before.match(/\\begin\s*\{/g) ?? []).length === (before.match(/\\end\s*\{/g) ?? []).length) {
        comment = rest.slice(bare.index + bare[0].length).trim();
        rest = before;
      }
    }
    // algorithmic takes `\IF{c}` and `\STATE text`; an optional argument (`\STATE[label]`) is dropped.
    const optional = readOptional(rest.trimStart(), 0);
    if (optional && kind.args === 0) rest = rest.trimStart().slice(optional.end);
    // GaLore's `\STATE … \COMMENT{…} \\\hrulefill`: a rule after the line. A fill inside a line only fills space.
    const after = RULE_AFTER.exec(rest);
    if (after) rest = rest.slice(0, after.index);
    const only = ONLY_RULE.exec(rest);
    if (!only) rest = rest.replace(/\\(?:hrulefill|dotfill)(?![A-Za-z@])/g, " ");
    const text = algorithmicWords(kind.name ? `\\textsc{${args[0]}}(${args[1] ?? ""})` : [...args, rest.trim()].filter(Boolean).join(" ")).trim();
    if (comment !== undefined) comment = algorithmicWords(comment);
    const rule = (match: RegExpExecArray | null): AlgorithmLine["rule"] => (match ? (match[1] === "dotfill" ? "dotted" : "solid") : undefined);
    let line: AlgorithmLine | null = null;
    if (only && comment === undefined && !kind.lead && !args.length) lines.push({ depth, text: "", numbered: false, rule: rule(only) });
    // `\State \Return x`: the statement is the return. An `\algdef` block's line whose text is empty is not drawn.
    else if (!text && !kind.lead && comment === undefined && (kind.block || index + 1 < starts.length)) { if (!kind.block && !kind.close && !kind.open) carried = from; }
    else line = add({ depth, lead: keywordLabels[lower] ?? kind.lead, text, trail: kind.trail, comment, numbered: kind.numbered !== false });
    if (line && own) { line.source = own; line.after = own.to; }
    withLabels(line);
    if (after) lines.push({ depth, text: "", numbered: false, rule: rule(after) });
    if (kind.open) { if (line) line.role = "open"; open.push({ line, name: lower, at: from, from: own?.from ?? 0 }); }
    else if (kind.middle) { if (line) line.role = "middle"; }
    else if (kind.close) {
      const opener = open.pop()!;
      if (line) line.role = "close";
      if (opener.line && own) opener.line.block = { from: opener.from, to: own.to };
    }
    if (kind.open || kind.middle) depth++;
  }
  // A block still open (its last line not written yet): from its first line on, the algorithm is its source.
  if (open.length) {
    const first = open[0];
    const index = first.line ? lines.indexOf(first.line) : lines.findIndex((line) => (line.source?.from ?? -1) >= first.from);
    const depthThere = first.line?.depth ?? (index >= 0 ? lines[index].depth : 0);
    lines.splice(index < 0 ? lines.length : index);
    const rest = raw(depthThere, where(first.at, source.length), false, true);
    if (rest) rest.labels = undefined;
    add(rest);
  }
  if (!lines.some((line) => !line.raw && !line.rule)) return null;
  return { lines, numberEvery, package: "algorithmic" };
}

/* ---- algorithm2e ---------------------------------------------------------------- */

/** Settings and float markup in an algorithm2e body, with how many arguments they take: not lines. */
const IGNORED_2E: Record<string, number> = {
  SetAlgoLined: 0, SetAlgoVlined: 0, SetAlgoNoLine: 0, SetAlgoNoEnd: 0, SetAlgoShortEnd: 0, SetAlgoLongEnd: 0,
  DontPrintSemicolon: 0, PrintSemicolon: 0, LinesNumbered: 0, LinesNotNumbered: 0, LinesNumberedHidden: 0,
  BlankLine: 0, centering: 0, SetSideCommentLeft: 0, SetSideCommentRight: 0, SetNoFillComment: 0, SetFillComment: 0,
  tiny: 0, scriptsize: 0, footnotesize: 0, small: 0, normalsize: 0, large: 0,
  caption: 1, vspace: 1, IncMargin: 1, DecMargin: 1, SetAlFnt: 1, SetAlCapFnt: 1, SetAlCapNameFnt: 1, SetAlCapSty: 1, SetAlCapSkip: 1,
  SetArgSty: 1, SetFuncSty: 1, SetKwSty: 1, SetCommentSty: 1, SetDataSty: 1, SetProgSty: 1, SetVlineSkip: 1, TitleOfAlgo: 1, RestyleAlgo: 1,
  SetInd: 2, SetNlSty: 3, SetAlgorithmName: 3,
  // The font and margins set at the algorithm's start (cs.DS 2611.09172's `\fontsize{9pt}{9.5pt}\selectfont`,
  // `\setlength{\algomargin}{0em}`): layout.
  fontsize: 2, selectfont: 0, setlength: 2, SetAlgoNlRelativeSize: 1, SetNlSkip: 1,
};
const INPUTS_2E: Record<string, string> = { KwIn: "Input:", KwOut: "Output:", KwData: "Data:", KwResult: "Result:" };
/** algorithm2e's own loops (`\For`, and `\lFor` on one line). */
const LOOPS_2E: Record<string, { lead: string; trail: string; end: string }> = {
  For: { lead: "for", trail: "do", end: "end" }, ForEach: { lead: "foreach", trail: "do", end: "end" },
  ForAll: { lead: "forall", trail: "do", end: "end" }, While: { lead: "while", trail: "do", end: "end" },
};
/** Capitalised commands that are text, not unknown algorithm2e statements. */
const TEXT_CAPITALS = /^(?:LaTeX|TeX|Cref|Autoref|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)$/;
/** Definitions in an algorithm: they change how it prints in ways not read here (cs.DS 2611.09172's `\let\oldnl\nl`). */
const DEFINITIONS = /^(?:let|g?def|edef|xdef|newcommand|renewcommand|providecommand|csname)$/;

/** Where the formula starting at `at` (`$…$`, `$$…$$`, `\(…\)`) ends, or -1. */
function mathEnd(text: string, at: number) {
  const close = text.startsWith("$$", at) ? "$$" : text.startsWith("\\(", at) ? "\\)" : "$";
  for (let i = at + close.length; i < text.length; i++) {
    if (text[i] === "\\" && !text.startsWith(close, i)) { i++; continue; }
    if (text.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

/** The end of a definition's use starting after its command at `k` (`\let\a\b`, `\def\a#1{…}`, `\newcommand{\a}[1]{…}`), or -1. */
function definitionEnd(text: string, k: number, command: string) {
  const skip = () => { while (/\s/.test(text[k] ?? "")) k++; };
  const token = () => {
    skip();
    const name = /^\\(?:[A-Za-z@]+|.)/.exec(text.slice(k, k + 64));
    if (name) k += name[0].length;
    else if (text[k] === "{") { const group = readGroup(text, k); k = group ? group.end : k + 1; }
    else k++;
  };
  if (command === "let") { token(); skip(); if (text[k] === "=") k++; token(); return k; }
  if (/def$/.test(command)) {
    token();
    while (k < text.length && text[k] !== "{") k++;
    const group = readGroup(text, k);
    return group ? group.end : -1;
  }
  skip();
  if (text[k] === "\\") token();
  for (;;) {
    let at = k;
    while (/[ \t]/.test(text[at] ?? "")) at++;
    const group = text[at] === "{" ? readGroup(text, at) : text[at] === "[" ? readOptional(text, at) : null;
    if (!group) return k;
    k = group.end;
  }
}

/**
 * The lines of algorithm2e's `algorithm` body: statements end with `\;`, blocks
 * take their bodies as arguments (`\For{c}{…}`, `\eIf{c}{…}{…}`, `\Repeat{c}{…}`),
 * and the document names its own keywords (`\SetKwFunction`, `\SetKwProg`,
 * `\SetKwInOut`, `\SetKw`, `\SetKwIF`, `\SetKwComment`). `numbered`: the
 * `linesnumbered` option; `ends`: whether blocks print "end" (not with `vlined`
 * or `noend`). `declarations` (the keywords declared before the algorithm) are
 * read first. A statement it does not know, and a definition, are lines of
 * source; null when braces or a formula do not close, or nothing is known.
 */
export function parseAlgorithm2e(body: string, options: { numbered: boolean; ends: boolean }, expand?: AlgorithmMacroExpander, declarations = ""): AlgorithmSpec | null {
  const stripComments = (text: string) => text.replace(/(^|[^\\])(%[^\n]*)/g, (_whole, before: string, comment: string) => before + blank(comment));
  const source = stripComments(declarations) + stripComments(body);
  const origin: Origin = [...new Array<number>(declarations.length).fill(-1), ...identity(body.length)];
  const uses: SourceRange[] = [];
  const ends = options.ends && !/\\SetAlgo(?:NoEnd|Vlined)(?![A-Za-z@])/.test(source);
  const numberedMode = options.numbered || /\\LinesNumbered(?![A-Za-z@])/.test(source);
  /** `\nl` numbers the lines it starts when lines are not all numbered. */
  const usesNl = !numberedMode && /\\(?:nl|lnl)(?![A-Za-z@])/.test(source);
  const numberEvery = numberedMode || usesNl ? 1 : 0;
  const lines: AlgorithmLine[] = [];
  /** The document's keywords: `\SetKwFunction{FMain}{Main}`, `\SetKwProg{Fn}{Function}{:}{end}`, `\SetKwInOut{Input}{input}`, `\SetKw{Break}{break}`, `\SetKwBlock`. */
  const functions = new Map<string, string>();
  const programs = new Map<string, { lead: string; separator: string; end: string }>();
  const inputs = new Map<string, string>();
  const keywords = new Map<string, string>();
  const blocks = new Map<string, { begin: string; end: string }>([["Begin", { begin: "begin", end: "end" }]]);
  /** Loops (`\SetKwFor{parFor}{parallel-for}{do}{endfor}` adds the document's own), written as `\For`, `\lFor`. */
  const loops = new Map(Object.entries(LOOPS_2E));
  /** `\SetKwRepeat{Repeat}{repeat}{until}`. */
  const repeats = new Map<string, { begin: string; end: string }>([["Repeat", { begin: "repeat", end: "until" }]]);
  /** Comment commands (`\tcp`, `\tcc`, `\SetKwComment{Comment}{…}{…}`'s `\Comment`). */
  const comments = new Set(["tcp", "tcc"]);
  type IfWords = { if: string; then: string; elseif: string; else: string; end: string };
  /** The if-commands (`\SetKwIF{If}{ElseIf}{Else}{if}{then}{else if}{else}{endif}` names the document's own). */
  const ifs = new Map<string, { role: "if" | "elseif" | "else"; words: IfWords }>();
  const defineIf = (names: string[], words: IfWords) => {
    ifs.set(names[0], { role: "if", words });
    ifs.set(names[1], { role: "elseif", words });
    ifs.set(names[2], { role: "else", words });
  };
  defineIf(["If", "ElseIf", "Else"], { if: "if", then: "then", elseif: "else if", else: "else", end: "end" });
  /** An if-command and its form: `\If`, `\uIf` (no end), `\lIf` (one line), `\eIf` (with else). */
  const ifCommand = (command: string) => {
    const own = ifs.get(command);
    if (own) return { ...own, form: "" };
    const found = /^[ule]/.test(command) ? ifs.get(command.slice(1)) : undefined;
    return found && (command[0] !== "e" || found.role === "if") ? { ...found, form: command[0] } : null;
  };
  const loopCommand = (command: string) => {
    const own = loops.get(command);
    if (own) return { ...own, line: false };
    const found = command.startsWith("l") ? loops.get(command.slice(1)) : undefined;
    return found ? { ...found, line: true } : null;
  };
  /** Commands that start a statement of their own: an unknown statement's text ends before them. */
  const structural = (command: string) => !!(INPUTS_2E[command] || inputs.has(command) || loopCommand(command) || ifCommand(command) || repeats.has(command)
    || blocks.has(command) || programs.has(command) || comments.has(command) || command in IGNORED_2E || /^(?:SetKw|nl$|lnl$|nllabel$|Ind[pm])/.test(command));
  let failed = false;
  /** `\Indp` and `\Indm` (GaLore's code box): levels added to the lines after them, in the group they are in. */
  let shift = 0;
  let expansions = 0;
  /** `\nl` / `\lnl` before the next line; the labels it takes (`\nllabel`, `\lnl`, a `\label` in it). */
  let numberNext = false;
  let pendingLabels: Array<{ key: string; at: number }> = [];
  /** A `\caption` was read and no line after it: a `\label` then is the algorithm's. */
  let afterCaption = false;
  const name = (text: string) => text.trim().replace(/^\\/, "");
  /** The document's function names and keywords in an argument (`\Fn{\FMain{$x$}}`), as they are drawn. */
  const words = (text: string) => !text.includes("\\") ? text : text.replace(/\\([A-Za-z@]+)(?![A-Za-z@])(\s*\{((?:[^{}]|\{[^{}]*\})*)\})?/g, (whole, command: string, group: string | undefined, args: string | undefined) => {
    // algorithm2e's own words in a loop's or condition's header (`\For{$i \leftarrow 1$ \KwTo $B$}`).
    if (command === "KwTo" || command === "KwDownTo") return `\\textbf{${command === "KwTo" ? "to" : "downto"}}${group ?? ""}`;
    if ((command === "KwRet" || command === "Return") && group) return `\\textbf{return} ${args!.trim()}`;
    const fn = functions.get(command);
    if (fn !== undefined) return group ? `\\textsc{${fn}}(${args!.trim()})` : `\\textsc{${fn}}`;
    const keyword = keywords.get(command);
    return keyword !== undefined ? `${keyword}${group ?? ""}` : whole;
  });

  type Placed = { source?: LineSource | null; after?: number | null; block?: LineSource | null; role?: AlgorithmLine["role"] };
  const read = (text: string, at: Origin, depth: number) => {
    const shiftBefore = shift;
    let pending = "";
    /** Where the statement being read starts in `text` (-1: none yet). */
    let statementAt = -1;
    let i = 0;
    const where = (a: number, b: number) => located(text, at, uses, a, b);
    const offset = (k: number) => offsetOf(at, k);
    const push = (line: Omit<AlgorithmLine, "depth" | "numbered"> & { numbered?: boolean }, placed: Placed = {}) => {
      // A document keyword written with LaTeX (`\SetKwFor{hnode}{A \heavynode{} maintains}{}{}`) is drawn as LaTeX, in bold.
      if (line.lead && /[\\${]/.test(line.lead)) line = { ...line, lead: undefined, text: `\\textbf{${line.lead}} ${line.text}`.trim() };
      const numbered = line.numbered === false ? false : usesNl ? numberNext : true;
      const added: AlgorithmLine = { depth: depth + shift, ...line, numbered, text: line.raw ? line.text : words(line.text) };
      if (placed.source) added.source = placed.source;
      if (placed.after !== null && placed.after !== undefined) added.after = placed.after;
      if (placed.block?.exact) added.block = { from: placed.block.from, to: placed.block.to };
      if (placed.role) added.role = placed.role;
      if (pendingLabels.length) { added.labels = pendingLabels; pendingLabels = []; }
      numberNext = false;
      afterCaption = false;
      lines.push(added);
      return added;
    };
    /** The statement read so far, ending at `end` (its `\;` at `end`, the next statement at `next`). */
    const flush = (end = i, next = end, comment?: string) => {
      const text = pending.replace(/\s+/g, " ").trim();
      const from = statementAt;
      pending = "";
      statementAt = -1;
      if (text || comment !== undefined) push({ text, comment }, { source: from >= 0 ? where(from, end) : null, after: offset(next) });
    };
    const end = (word: string, blockEnd: number) => { if (ends && word) push({ lead: word, text: "" }, { after: offset(blockEnd), role: "close" }); };
    /** Text of the statement being read. */
    const append = (text: string, from: number) => { if (statementAt < 0 && text.trim()) statementAt = from; pending += text; };
    /** Source the reader does not know, from `from` to `to`, as one line. */
    const rawLine = (from: number, to: number, next: number, numbered: boolean, uncertain: boolean) => {
      const placed = where(from, to);
      pending = "";
      statementAt = -1;
      if (placed) push({ text: body.slice(placed.from, placed.to), raw: true, numbered, ...(uncertain ? { uncertain } : {}) }, { source: placed, after: offset(next) });
    };
    /**
     * The statements of a one-line form (`\lIf{$E$ is empty}{\Return $T$ \tcp*[f]{Unchanged}}`), read as statements
     * are, on one line: their text, comment and labels; null when they hold a block (the form is then source).
     */
    const inline = (part: Arg): { text: string; comment?: string } | null => {
      const mark = lines.length;
      const labelsBefore = pendingLabels;
      pendingLabels = [];
      const numberBefore = numberNext;
      read(part.text, part.at, depth);
      const added = lines.splice(mark);
      numberNext = numberBefore;
      pendingLabels = [...labelsBefore, ...added.flatMap((line) => line.labels ?? [])];
      if (failed || added.some((line) => line.lead || line.rule || line.raw || line.depth !== depth + shift)) return null;
      const comment = [...added].reverse().find((line) => line.comment !== undefined)?.comment;
      return { text: added.map((line) => line.text).filter(Boolean).join("; "), ...(comment !== undefined ? { comment } : {}) };
    };
    /**
     * algorithm2e's side comment before a block's arguments: `\For(\tcp*[f]{Re-set sparsifiers}){c}{…}`,
     * `\ForEach(\label{l:x}){c}{…}`. Its comment text (its labels are the line's), "" when there is none, or null when
     * the parentheses do not close.
     */
    const sideComment = (): string | null => {
      let k = i;
      while (/\s/.test(text[k] ?? "")) k++;
      if (text[k] !== "(") return "";
      let level = 0;
      for (let close = k + 1; close < text.length; close++) {
        const c = text[close];
        if (c === "\\") { close++; continue; }
        if (c === "{") level++;
        else if (c === "}") level--;
        else if (c === ")" && level === 0) {
          i = close + 1;
          const inside = text.slice(k + 1, close);
          for (const label of inside.matchAll(/\\label\s*\{([^{}]*)\}/g)) {
            const place = offset(k + 1 + label.index!);
            if (place !== null) pendingLabels.push({ key: label[1].trim(), at: place });
          }
          return inside.replace(/\\label\s*\{[^{}]*\}/g, "").replace(/\\(?:tc[pc]|[A-Za-z]+)\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, "$1").trim();
        }
      }
      return null;
    };
    type Arg = { content: string; text: string; at: Origin; from: number; to: number };
    /** The next `count` groups after `i`, past spaces and an optional `[…]` first. */
    const args = (count: number, optional = false): Arg[] | null => {
      const out: Arg[] = [];
      const skip = () => { while (/\s/.test(text[i] ?? "")) i++; };
      if (optional) { skip(); const group = readOptional(text, i); if (group) i = group.end; }
      for (let n = 0; n < count; n++) {
        skip();
        const group = readGroup(text, i);
        if (!group) { failed = true; return null; }
        out.push({ content: group.content.trim(), text: group.content, at: at.slice(i + 1, group.end - 1), from: i + 1, to: group.end - 1 });
        i = group.end;
      }
      return out;
    };
    while (i < text.length && !failed) {
      const char = text[i];
      if (char === "$" || text.startsWith("\\(", i)) {
        const close = mathEnd(text, i);
        if (close < 0) { failed = true; break; }
        append(text.slice(i, close), i);
        i = close;
        continue;
      }
      if (char === "{") {
        const group = readGroup(text, i);
        if (!group) { failed = true; break; }
        append(text.slice(i, group.end), i);
        i = group.end;
        continue;
      }
      if (char === "}") { failed = true; break; }
      if (char !== "\\") { append(char, i); i++; continue; }
      const match = /^\\(?:([A-Za-z@]+)(\*?)|([^A-Za-z@]))/.exec(text.slice(i, i + 64));
      if (!match) { append(char, i); i++; continue; }
      const commandAt = i;
      i += match[0].length;
      const command = match[1];
      if (!command) {
        // `\;` ends a statement, as does a line break; other symbols are text.
        if (match[3] === ";" || match[3] === "\\") flush(commandAt, i);
        else append(match[0], commandAt);
        continue;
      }
      if (command === "caption") afterCaption = true;
      if (command in IGNORED_2E) { args(IGNORED_2E[command], command === "caption"); continue; }
      // `\nl` numbers the line it starts; `\lnl{key}` also labels it, `\nllabel{key}` labels the line.
      if (command === "nl") { numberNext = true; continue; }
      if (command === "lnl" || command === "nllabel" || command === "label") {
        const [key] = args(1) ?? [];
        if (!key) break;
        if (command === "lnl") numberNext = true;
        const place = offset(commandAt);
        if (place === null || (command === "label" && afterCaption)) continue;
        // A `\label` after a statement's `\;` is that statement's; at the algorithm's start, the algorithm's.
        if (command === "label" && !pending.trim()) {
          const last = lines.at(-1);
          if (last && !last.raw) (last.labels ??= []).push({ key: key.content, at: place });
          continue;
        }
        pendingLabels.push({ key: key.content, at: place });
        continue;
      }
      const input = INPUTS_2E[command] ?? inputs.get(command);
      if (input) {
        flush(commandAt);
        const [value] = args(1) ?? [];
        if (value !== undefined) push({ lead: input, text: value.content, numbered: false }, { source: where(commandAt, i), after: offset(i) });
        continue;
      }
      const loop = loopCommand(command);
      if (loop && !loop.line) {
        flush(commandAt);
        const side = sideComment();
        if (side === null) { failed = true; break; }
        const parts = args(2);
        if (!parts) break;
        push({ lead: loop.lead, text: parts[0].content, trail: loop.trail, ...(side ? { comment: side } : {}) }, { source: where(commandAt, parts[0].to + 1), after: offset(parts[1].from), block: where(commandAt, i), role: "open" });
        read(parts[1].text, parts[1].at, depth + 1);
        end(loop.end, i);
        continue;
      }
      const repeat = repeats.get(command);
      if (repeat) {
        flush(commandAt);
        const parts = args(2);
        if (!parts) break;
        push({ lead: repeat.begin, text: "" }, { source: where(commandAt, parts[0].to + 1), after: offset(parts[1].from), block: where(commandAt, i), role: "open" });
        read(parts[1].text, parts[1].at, depth + 1);
        push({ lead: repeat.end, text: parts[0].content }, { after: offset(i), role: "close" });
        continue;
      }
      const condition = ifCommand(command);
      if (condition && (condition.form === "" || condition.form === "u") && condition.role !== "else") {
        flush(commandAt);
        const side = sideComment();
        if (side === null) { failed = true; break; }
        const parts = args(2);
        if (!parts) break;
        const kw = condition.words;
        push({ lead: condition.role === "elseif" ? kw.elseif : kw.if, text: parts[0].content, trail: kw.then, ...(side ? { comment: side } : {}) },
          { source: where(commandAt, parts[0].to + 1), after: offset(parts[1].from), block: where(commandAt, i), role: condition.role === "elseif" ? "middle" : "open" });
        read(parts[1].text, parts[1].at, depth + 1);
        if (condition.form === "") end(kw.end, i);
        continue;
      }
      if (condition && (condition.form === "" || condition.form === "u") && condition.role === "else") {
        flush(commandAt);
        const parts = args(1);
        if (!parts) break;
        push({ lead: condition.words.else, text: "" }, { source: where(commandAt, parts[0].from - 1), after: offset(parts[0].from), block: where(commandAt, i), role: "middle" });
        read(parts[0].text, parts[0].at, depth + 1);
        if (condition.form === "") end(condition.words.end, i);
        continue;
      }
      if (condition && condition.form === "e") {
        flush(commandAt);
        if (sideComment() === null) { failed = true; break; }
        const parts = args(3);
        if (!parts) break;
        const kw = condition.words;
        push({ lead: kw.if, text: parts[0].content, trail: kw.then }, { source: where(commandAt, parts[0].to + 1), after: offset(parts[1].from), block: where(commandAt, i), role: "open" });
        read(parts[1].text, parts[1].at, depth + 1);
        push({ lead: kw.else, text: "" }, { after: offset(parts[2].from), role: "middle" });
        read(parts[2].text, parts[2].at, depth + 1);
        end(kw.end, i);
        continue;
      }
      // One-line forms: `\lIf{c}{s}`, `\lFor{c}{s}`, `\lElse{s}`; with a block inside, the form is source.
      if ((condition && condition.form === "l") || (loop && loop.line)) {
        flush(commandAt);
        const parts = args(condition?.role === "else" ? 1 : 2);
        if (!parts) break;
        const statement = inline(parts.at(-1)!);
        if (failed) break;
        if (!statement) { rawLine(commandAt, i, i, true, true); continue; }
        const lead = loop ? loop.lead : condition!.role === "if" ? condition!.words.if : condition!.role === "elseif" ? condition!.words.elseif : condition!.words.else;
        const text = condition?.role === "else" ? statement.text : `${parts[0].content} \\textbf{${loop ? loop.trail || "do" : condition!.words.then}} ${statement.text}`;
        push({ lead, text, ...(statement.comment !== undefined ? { comment: statement.comment } : {}) }, { source: where(commandAt, i), after: offset(i) });
        continue;
      }
      const block = blocks.get(command);
      if (block) {
        flush(commandAt);
        const parts = args(1);
        if (!parts) break;
        push({ lead: block.begin, text: "" }, { source: where(commandAt, parts[0].from - 1), after: offset(parts[0].from), block: where(commandAt, i), role: "open" });
        read(parts[0].text, parts[0].at, depth + 1);
        if (block.end) push({ lead: block.end, text: "" }, { after: offset(i), role: "close" });
        continue;
      }
      const program = programs.get(command);
      if (program) {
        flush(commandAt);
        const parts = args(2);
        if (!parts) break;
        push({ lead: program.lead, text: `${parts[0].content}${program.separator}` }, { source: where(commandAt, parts[0].to + 1), after: offset(parts[1].from), block: where(commandAt, i), role: "open" });
        read(parts[1].text, parts[1].at, depth + 1);
        if (program.end) push({ lead: program.end, text: "" }, { after: offset(i), role: "close" });
        continue;
      }
      if (command === "KwRet" || command === "Return") {
        // A keyword: `\Return{x}` and `\Return $x$` both print "return x".
        let k = i;
        while (/\s/.test(text[k] ?? "")) k++;
        const [value] = text[k] === "{" ? args(1) ?? [] : [];
        append(`\\textbf{return} ${value?.content ?? ""}`, commandAt);
        continue;
      }
      if (command === "KwTo") { append("\\textbf{to} ", commandAt); continue; }
      if (comments.has(command)) {
        // A comment: on the statement it follows (`x\; \tcp*{c}`), or on a line of its own.
        const [comment] = args(1, true) ?? [];
        if (comment === undefined) break;
        if (pending.trim()) flush(i, i, comment.content);
        else if (match[2] && lines.length && lines[lines.length - 1].comment === undefined && !lines[lines.length - 1].raw) lines[lines.length - 1].comment = comment.content;
        else { statementAt = commandAt; flush(i, i, comment.content); }
        continue;
      }
      if (command === "SetKwFunction") { const parts = args(2); if (parts) functions.set(name(parts[0].content), parts[1].content); continue; }
      if (command === "SetKwProg") { const parts = args(4); if (parts) programs.set(name(parts[0].content), { lead: parts[1].content, separator: parts[2].content, end: parts[3].content }); continue; }
      if (command === "SetKwInOut" || command === "SetKwInput") { const parts = args(2); if (parts) inputs.set(name(parts[0].content), `${parts[1].content}:`); continue; }
      if (command === "SetKw" || command === "SetKwData") { const parts = args(2); if (parts) keywords.set(name(parts[0].content), command === "SetKw" ? `\\textbf{${parts[1].content}}` : parts[1].content); continue; }
      if (command === "SetKwBlock") { const parts = args(3); if (parts) blocks.set(name(parts[0].content), { begin: parts[1].content, end: parts[2].content }); continue; }
      if (command === "SetKwFor") { const parts = args(4); if (parts) loops.set(name(parts[0].content), { lead: parts[1].content, trail: parts[2].content, end: parts[3].content }); continue; }
      if (command === "SetKwRepeat") { const parts = args(3); if (parts) repeats.set(name(parts[0].content), { begin: parts[1].content, end: parts[2].content }); continue; }
      if (command === "SetKwComment") { const parts = args(3); if (parts) comments.add(name(parts[0].content)); continue; }
      if (command === "SetKwIF") {
        const parts = args(8);
        if (parts) defineIf(parts.slice(0, 3).map((part) => name(part.content)), { if: parts[3].content, then: parts[4].content, elseif: parts[5].content, else: parts[6].content, end: parts[7].content });
        continue;
      }
      const fn = functions.get(command);
      if (fn !== undefined) {
        let k = i;
        while (/\s/.test(text[k] ?? "")) k++;
        const group = text[k] === "{" ? readGroup(text, k) : null;
        if (group) i = group.end;
        append(group ? `\\textsc{${fn}}(${group.content.trim()})` : `\\textsc{${fn}}`, commandAt);
        continue;
      }
      const keyword = keywords.get(command);
      if (keyword !== undefined) { append(`${keyword} `, commandAt); continue; }
      // `\Indp` / `\Indm` indent the lines after them (`\Indpp` / `\Indmm` by half), until the end of their group.
      if (/^Ind(?:p|m|pp|mm)$/.test(command)) { flush(commandAt); shift = Math.max(0, shift + (command[3] === "p" ? 1 : -1) * (command.length === 6 ? 0.5 : 1)); continue; }
      // A definition in the algorithm (cs.DS 2611.09172's `\let\oldnl\nl \newcommand{\nlnonumber}{…}`): source, and the
      // numbers after it are not known.
      if (DEFINITIONS.test(command)) {
        const stop = definitionEnd(text, i, command);
        if (stop < 0) { failed = true; break; }
        flush(commandAt);
        rawLine(commandAt, stop, stop, false, true);
        i = stop;
        continue;
      }
      if (/^[A-Z]/.test(command) && !TEXT_CAPITALS.test(command)) {
        // The document's own statement macro (GaLore's `\PyCode{…}`): its expansion, read in its place.
        const use = expand && expansions < 200 ? expand(text.slice(commandAt)) : null;
        if (use && use.length) {
          const expandedAt = at.slice();
          const expanded = splice(text, expandedAt, uses, commandAt, use.length, use.text);
          at.length = 0;
          at.push(...expandedAt);
          text = expanded;
          i = commandAt;
          expansions++;
          continue;
        }
        // A statement it does not know (another package's): its source, to the end of its statement (`\;`). It is one
        // numbered line when it ends with `\;` and holds no statements; otherwise the numbers after it are not known.
        const from = statementAt >= 0 ? statementAt : commandAt;
        let k = i;
        let inner = false;
        let stop = -1;
        let next = -1;
        while (k < text.length) {
          const c = text[k];
          if (c === "{") { const group = readGroup(text, k); if (!group) { failed = true; break; } if (/\\;/.test(group.content)) inner = true; k = group.end; continue; }
          if (c === "}") break;
          if (c === "$" || text.startsWith("\\(", k)) { const close = mathEnd(text, k); if (close < 0) { failed = true; break; } k = close; continue; }
          if (c === "\\") {
            if (text.startsWith("\\;", k) || text.startsWith("\\\\", k)) { stop = k; next = k + 2; break; }
            const other = /^\\([A-Za-z@]+)/.exec(text.slice(k, k + 64));
            if (other && structural(other[1])) break;
            k += other ? other[0].length : 2;
            continue;
          }
          k++;
        }
        if (failed) break;
        const ended = stop >= 0;
        rawLine(from, ended ? stop : k, ended ? next : k, ended && !inner, !ended || inner);
        i = ended ? next : k;
        continue;
      }
      append(match[0], commandAt);
    }
    flush(i);
    shift = shiftBefore;
  };

  read(source, origin, 0);
  if (failed || !lines.some((line) => !line.raw && !line.rule)) return null;
  return { lines, numberEvery, package: "algorithm2e" };
}

/* ---- for the walk and numbering ----------------------------------------------------- */

/** An `algorithmic` body's lines, with the document's macros (`defs`, as at `pos`) that may write statements. */
export function readAlgorithmicBody(body: string, options: string | null, defs: LatexDefinitions | undefined, pos: number) {
  const expand = defs?.macros.size ? (source: string) => expandLatexMacroUse(source, defs, { mode: "text", pos }) : undefined;
  return parseAlgorithmic(body, options, expand);
}

/**
 * algorithm2e's `algorithm` body (the document loads algorithm2e, and the body holds no `algorithmic`): its lines, read
 * after the keywords declared before `pos`, and whether its caption is on top (the `ruled` styles); null when they
 * cannot be read.
 */
export function readAlgorithm2eBody(body: string, defs: LatexDefinitions, pos: number) {
  if (!defs.packages.includes("algorithm2e") || /\\begin\s*\{algorithmic\}/.test(body)) return null;
  const options = defs.packageOptions.get("algorithm2e") ?? [];
  // Keywords declared before it (`\SetKwInOut{Input}{Input}` in the preamble) are read first; the document's statement
  // macros (`\PyCode{…}`) are read as what they write.
  let declarations = "";
  for (const name of defs.macros.keys()) { const macro = macroAt(defs, name, pos); if (macro?.package === "algorithm2e") declarations += macro.body; }
  const expand = (source: string) => expandLatexMacroUse(source, defs, { mode: "text", pos });
  const algorithm = parseAlgorithm2e(body, { numbered: options.includes("linesnumbered"), ends: !options.some((option) => option === "vlined" || option === "noend") }, expand, declarations);
  return algorithm && { algorithm, ruled: options.some((option) => option === "ruled" || option === "algoruled") };
}

/**
 * Each line's number as the package counts it (null for lines it does not count, and for every line after one whose
 * effect on the count is not known).
 */
export function algorithmLineNumbers(spec: AlgorithmSpec) {
  let count = 0;
  let lost = false;
  return spec.lines.map((line) => {
    if (line.rule || lost) return null;
    if (line.uncertain) lost = true;
    if (!line.numbered) return null;
    return ++count;
  });
}

/**
 * The labels on an algorithm's lines with the line numbers `\ref` prints (algorithmic counts its lines whether it
 * shows them or not; algorithm2e only numbers lines when they are numbered). `at`: where the label is in the body.
 */
export function algorithmLineLabels(spec: AlgorithmSpec) {
  const out: Array<{ key: string; number: string; at: number }> = [];
  if (spec.package === "algorithm2e" && !spec.numberEvery) return out;
  const numbers = algorithmLineNumbers(spec);
  spec.lines.forEach((line, index) => {
    const number = numbers[index];
    for (const label of line.labels ?? []) if (label.key && number !== null) out.push({ key: label.key, number: String(number), at: label.at });
  });
  return out;
}
