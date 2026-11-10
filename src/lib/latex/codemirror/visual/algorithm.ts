import { readGroup, readOptional } from "../../../macros/core";

/* The body of an `algorithmic` environment, for the Visual mode: the
 * statements of the algorithmic package (\STATE, \IF, \FOR …) and of
 * algpseudocode (\State, \If, \For …), as numbered, indented lines; and the
 * body of algorithm2e's `algorithm` (\KwIn, \For{…}{…}, statements ending
 * with \;). What a reader does not know makes it null: left as source. */

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
};

export type AlgorithmSpec = { lines: AlgorithmLine[]; numberEvery: number };

/** The document's macro used at the start of `source` (its name and arguments), expanded; null when it is none. */
export type AlgorithmMacroExpander = (source: string) => { text: string; length: number } | null;

type Kind = { lead?: string; trail?: string; args: number; open?: boolean; close?: boolean; middle?: boolean; numbered?: boolean; name?: boolean; block?: boolean };

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
function expandStatementMacros(source: string, expand: AlgorithmMacroExpander) {
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
        out = out.slice(0, i) + use.text + out.slice(i + use.length);
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
 * (`\begin{algorithmic}[1]`: every line; none: 0). Null when the body holds
 * text before its first statement or a statement it does not know.
 */
export function parseAlgorithmic(body: string, options: string | null, expand?: AlgorithmMacroExpander): AlgorithmSpec | null {
  const numberEvery = options && /^\s*\d+\s*$/.test(options) ? Number(options) : 0;
  // Comments, labels, vertical space and size switches are not lines of the algorithm.
  const cleaned = body.replace(/(^|[^\\])%[^\n]*/g, "$1")
    .replace(/\\(?:label|vspace\*?|addvspace)\s*\{[^{}]*\}/g, "")
    .replace(/\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large)(?![A-Za-z@])/g, "");
  const source = expand ? expandStatementMacros(cleaned, expand) : cleaned;
  // `\renewcommand{\algorithmicrequire}{\textbf{Input:}}`: the label the document gives \Require and \Ensure.
  const labels: Record<string, string> = {};
  for (const key of expand ? ["require", "ensure"] : []) {
    const use = expand!(`\\algorithmic${key}`);
    const label = use && plainLabel(use.text);
    if (label) labels[key] = label;
  }
  const lines: AlgorithmLine[] = [];
  let depth = 0;
  let i = 0;
  const statement = /\\([A-Za-z@]+)(?![A-Za-z@])/g;
  // Find each statement command at brace depth zero, outside formulas (`\STATE $\forall i$` is no \FORALL); the text up
  // to the next one is its line.
  const starts: Array<{ at: number; name: string; kind: Kind; end: number }> = [];
  let braces = 0;
  for (; i < source.length; i++) {
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
        const kind = statementKind(match[1]);
        if (kind) starts.push({ at: i, name: match[1], kind, end: i + match[0].length });
        i += match[0].length - 1;
      } else i++;
    }
  }
  if (braces !== 0) return null;
  if (!starts.length || source.slice(0, starts[0].at).trim()) return null;
  for (let index = 0; index < starts.length; index++) {
    const { kind, end, name } = starts[index];
    const lineEnd = index + 1 < starts.length ? starts[index + 1].at : source.length;
    let at = end;
    const skip = () => { while (/\s/.test(source[at] ?? "")) at++; };
    const args: string[] = [];
    for (let n = 0; n < kind.args; n++) {
      skip();
      const group = readGroup(source, at);
      if (!group || group.end > lineEnd) return null;
      args.push(group.content.trim());
      at = group.end;
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
    if (only && comment === undefined && !kind.lead && !args.length) lines.push({ depth, text: "", numbered: false, rule: rule(only) });
    // `\State \Return x`: the statement is the return. An `\algdef` block's line whose text is empty is not drawn.
    else if (!text && !kind.lead && comment === undefined && (kind.block || index + 1 < starts.length)) { /* no line */ }
    else lines.push({ depth, lead: labels[name.toLowerCase()] ?? kind.lead, text, trail: kind.trail, comment, numbered: kind.numbered !== false });
    if (after) lines.push({ depth, text: "", numbered: false, rule: rule(after) });
    if (kind.open || kind.middle) depth++;
  }
  return { lines, numberEvery };
}

/* ---- algorithm2e ---------------------------------------------------------------- */

/** Settings and float markup in an algorithm2e body, with how many arguments they take: not lines. */
const IGNORED_2E: Record<string, number> = {
  SetAlgoLined: 0, SetAlgoVlined: 0, SetAlgoNoLine: 0, SetAlgoNoEnd: 0, SetAlgoShortEnd: 0, SetAlgoLongEnd: 0,
  DontPrintSemicolon: 0, PrintSemicolon: 0, LinesNumbered: 0, LinesNotNumbered: 0, LinesNumberedHidden: 0, nl: 0,
  BlankLine: 0, centering: 0, SetSideCommentLeft: 0, SetSideCommentRight: 0, SetNoFillComment: 0, SetFillComment: 0,
  tiny: 0, scriptsize: 0, footnotesize: 0, small: 0, normalsize: 0, large: 0,
  caption: 1, label: 1, vspace: 1, IncMargin: 1, DecMargin: 1, SetAlFnt: 1, SetAlCapFnt: 1, SetAlCapNameFnt: 1, SetAlCapSty: 1, SetAlCapSkip: 1,
  SetArgSty: 1, SetFuncSty: 1, SetKwSty: 1, SetCommentSty: 1, SetDataSty: 1, SetProgSty: 1, SetVlineSkip: 1, TitleOfAlgo: 1, RestyleAlgo: 1,
  SetInd: 2, SetNlSty: 3, SetAlgorithmName: 3,
  // The font and margins set at the algorithm's start (cs.DS 2611.09172's `\fontsize{9pt}{9.5pt}\selectfont`,
  // `\setlength{\algomargin}{0em}`): layout.
  fontsize: 2, selectfont: 0, setlength: 2, SetAlgoNlRelativeSize: 1, SetNlSkip: 1,
};
const INPUTS_2E: Record<string, string> = { KwIn: "Input:", KwOut: "Output:", KwData: "Data:", KwResult: "Result:" };
const LOOPS_2E: Record<string, string> = { For: "for", ForEach: "foreach", ForAll: "forall", While: "while" };
const LINE_LOOPS_2E: Record<string, string> = { lFor: "for", lForEach: "foreach", lForAll: "forall", lWhile: "while" };
/** Capitalised commands that are text, not unknown algorithm2e statements. */
const TEXT_CAPITALS = /^(?:LaTeX|TeX|Cref|Autoref|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)$/;

/** Where the formula starting at `at` (`$…$`, `$$…$$`, `\(…\)`) ends, or -1. */
function mathEnd(text: string, at: number) {
  const close = text.startsWith("$$", at) ? "$$" : text.startsWith("\\(", at) ? "\\)" : "$";
  for (let i = at + close.length; i < text.length; i++) {
    if (text[i] === "\\" && !text.startsWith(close, i)) { i++; continue; }
    if (text.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

/**
 * The lines of algorithm2e's `algorithm` body: statements end with `\;`, blocks
 * take their bodies as arguments (`\For{c}{…}`, `\eIf{c}{…}{…}`, `\Repeat{c}{…}`),
 * and the document names its own keywords (`\SetKwFunction`, `\SetKwProg`,
 * `\SetKwInOut`, `\SetKw`). `numbered`: the `linesnumbered` option; `ends`: whether
 * blocks print "end" (not with `vlined` or `noend`). Null when it holds a statement
 * it does not know or unbalanced braces.
 */
export function parseAlgorithm2e(body: string, options: { numbered: boolean; ends: boolean }, expand?: AlgorithmMacroExpander): AlgorithmSpec | null {
  const source = body.replace(/(^|[^\\])%[^\n]*/g, "$1");
  const ends = options.ends && !/\\SetAlgo(?:NoEnd|Vlined)(?![A-Za-z@])/.test(source);
  const numberEvery = options.numbered || /\\LinesNumbered(?![A-Za-z@])/.test(source) ? 1 : 0;
  const lines: AlgorithmLine[] = [];
  /** The document's keywords: `\SetKwFunction{FMain}{Main}`, `\SetKwProg{Fn}{Function}{:}{end}`, `\SetKwInOut{Input}{input}`, `\SetKw{Break}{break}`, `\SetKwBlock`. */
  const functions = new Map<string, string>();
  const programs = new Map<string, { lead: string; separator: string; end: string }>();
  const inputs = new Map<string, string>();
  const keywords = new Map<string, string>();
  const blocks = new Map<string, { begin: string; end: string }>();
  /** `\SetKwFor{parFor}{parallel-for}{do}{endfor}`: loops of the document's own, written as `\For`. */
  const loops = new Map<string, { lead: string; trail: string; end: string }>();
  let failed = false;
  /** `\Indp` and `\Indm` (GaLore's code box): levels added to the lines after them. */
  let shift = 0;
  let expansions = 0;
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

  const read = (text: string, depth: number) => {
    let pending = "";
    let i = 0;
    const push = (line: Omit<AlgorithmLine, "depth" | "numbered"> & { numbered?: boolean }) => {
      // A document keyword written with LaTeX (`\SetKwFor{hnode}{A \heavynode{} maintains}{}{}`) is drawn as LaTeX, in bold.
      if (line.lead && /[\\${]/.test(line.lead)) line = { ...line, lead: undefined, text: `\\textbf{${line.lead}} ${line.text}`.trim() };
      lines.push({ depth: depth + shift, numbered: true, ...line, text: words(line.text) });
    };
    const flush = (comment?: string) => {
      const text = pending.replace(/\s+/g, " ").trim();
      pending = "";
      if (text || comment !== undefined) push({ text, comment });
    };
    const end = () => { if (ends) push({ lead: "end", text: "" }); };
    /**
     * The statements of a one-line form (`\lIf{$E$ is empty}{\Return $T$ \tcp*[f]{Unchanged}}`), read as statements
     * are, on one line: their text and comment; null (the algorithm stays source) when they hold a block.
     */
    const inline = (body: string): { text: string; comment?: string } | null => {
      const mark = lines.length;
      read(body, depth);
      const added = lines.splice(mark);
      if (failed || added.some((line) => line.lead || line.rule || line.depth !== depth + shift)) { failed = true; return null; }
      const comment = [...added].reverse().find((line) => line.comment !== undefined)?.comment;
      return { text: added.map((line) => line.text).filter(Boolean).join("; "), ...(comment !== undefined ? { comment } : {}) };
    };
    /**
     * algorithm2e's side comment before a block's arguments: `\For(\tcp*[f]{Re-set sparsifiers}){c}{…}`,
     * `\ForEach(\label{l:x}){c}{…}`. Its comment text (labels draw nothing), "" when there is none, or null when the
     * parentheses do not close.
     */
    const sideComment = (): string | null => {
      let at = i;
      while (/\s/.test(text[at] ?? "")) at++;
      if (text[at] !== "(") return "";
      let depth = 0;
      for (let k = at + 1; k < text.length; k++) {
        const c = text[k];
        if (c === "\\") { k++; continue; }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ")" && depth === 0) {
          i = k + 1;
          return text.slice(at + 1, k).replace(/\\label\s*\{[^{}]*\}/g, "").replace(/\\tc[pc]\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, "$1").trim();
        }
      }
      return null;
    };
    /** The next `count` groups after `i`, past spaces and an optional `[…]` first. */
    const args = (count: number, optional = false) => {
      const out: string[] = [];
      const skip = () => { while (/\s/.test(text[i] ?? "")) i++; };
      if (optional) { skip(); const group = readOptional(text, i); if (group) i = group.end; }
      for (let n = 0; n < count; n++) {
        skip();
        const group = readGroup(text, i);
        if (!group) { failed = true; return null; }
        out.push(group.content.trim());
        i = group.end;
      }
      return out;
    };
    while (i < text.length && !failed) {
      const char = text[i];
      if (char === "$" || text.startsWith("\\(", i)) {
        const close = mathEnd(text, i);
        if (close < 0) { failed = true; break; }
        pending += text.slice(i, close);
        i = close;
        continue;
      }
      if (char === "{") {
        const group = readGroup(text, i);
        if (!group) { failed = true; break; }
        pending += text.slice(i, group.end);
        i = group.end;
        continue;
      }
      if (char === "}") { failed = true; break; }
      if (char !== "\\") { pending += char; i++; continue; }
      const match = /^\\(?:([A-Za-z@]+)(\*?)|([^A-Za-z@]))/.exec(text.slice(i, i + 64));
      if (!match) { pending += char; i++; continue; }
      i += match[0].length;
      const command = match[1];
      if (!command) {
        // `\;` ends a statement, as does a line break; other symbols are text.
        if (match[3] === ";" || match[3] === "\\") flush();
        else pending += match[0];
        continue;
      }
      if (command in IGNORED_2E) { args(IGNORED_2E[command], command === "caption"); continue; }
      const input = INPUTS_2E[command] ?? inputs.get(command);
      if (input) { flush(); const [value] = args(1) ?? []; if (value !== undefined) push({ lead: input, text: value, numbered: false }); continue; }
      const loop = command in LOOPS_2E ? null : loops.get(command);
      if (command in LOOPS_2E || loop) {
        flush();
        const side = sideComment();
        if (side === null) { failed = true; break; }
        const parts = args(2);
        if (!parts) break;
        push({ lead: loop ? loop.lead : LOOPS_2E[command], text: parts[0], trail: loop ? loop.trail : "do", ...(side ? { comment: side } : {}) });
        read(parts[1], depth + 1);
        if (!loop) end();
        else if (ends && loop.end) push({ lead: loop.end, text: "" });
        continue;
      }
      if (command === "Repeat") {
        flush();
        const parts = args(2);
        if (!parts) break;
        push({ lead: "repeat", text: "" });
        read(parts[1], depth + 1);
        push({ lead: "until", text: parts[0] });
        continue;
      }
      if (command === "If" || command === "uIf" || command === "ElseIf" || command === "uElseIf") {
        flush();
        const side = sideComment();
        if (side === null) { failed = true; break; }
        const parts = args(2);
        if (!parts) break;
        push({ lead: command.endsWith("ElseIf") ? "else if" : "if", text: parts[0], trail: "then", ...(side ? { comment: side } : {}) });
        read(parts[1], depth + 1);
        if (!command.startsWith("u")) end();
        continue;
      }
      if (command === "Else" || command === "uElse") {
        flush();
        const parts = args(1);
        if (!parts) break;
        push({ lead: "else", text: "" });
        read(parts[0], depth + 1);
        if (command === "Else") end();
        continue;
      }
      if (command === "eIf") {
        flush();
        if (sideComment() === null) { failed = true; break; }
        const parts = args(3);
        if (!parts) break;
        push({ lead: "if", text: parts[0], trail: "then" });
        read(parts[1], depth + 1);
        push({ lead: "else", text: "" });
        read(parts[2], depth + 1);
        end();
        continue;
      }
      // One-line forms: `\lIf{c}{s}`, `\lFor{c}{s}`, `\lElse{s}`.
      if (command === "lIf" || command === "lElseIf" || command in LINE_LOOPS_2E) {
        flush();
        const parts = args(2);
        if (!parts) break;
        const loop = LINE_LOOPS_2E[command];
        const statement = inline(parts[1]);
        if (!statement) break;
        push({ lead: loop ?? (command === "lIf" ? "if" : "else if"), text: `${parts[0]} \\textbf{${loop ? "do" : "then"}} ${statement.text}`, ...(statement.comment !== undefined ? { comment: statement.comment } : {}) });
        continue;
      }
      if (command === "lElse") {
        flush();
        const parts = args(1);
        const statement = parts && inline(parts[0]);
        if (!statement) break;
        push({ lead: "else", text: statement.text, ...(statement.comment !== undefined ? { comment: statement.comment } : {}) });
        continue;
      }
      const block = command === "Begin" ? { begin: "begin", end: "end" } : blocks.get(command);
      if (block) {
        flush();
        const parts = args(1);
        if (!parts) break;
        push({ lead: block.begin, text: "" });
        read(parts[0], depth + 1);
        if (block.end) push({ lead: block.end, text: "" });
        continue;
      }
      const program = programs.get(command);
      if (program) {
        flush();
        const parts = args(2);
        if (!parts) break;
        push({ lead: program.lead, text: `${parts[0]}${program.separator}` });
        read(parts[1], depth + 1);
        if (program.end) push({ lead: program.end, text: "" });
        continue;
      }
      if (command === "KwRet" || command === "Return") {
        // A keyword: `\Return{x}` and `\Return $x$` both print "return x".
        let at = i;
        while (/\s/.test(text[at] ?? "")) at++;
        const [value] = text[at] === "{" ? args(1) ?? [] : [];
        pending += `\\textbf{return} ${value ?? ""}`;
        continue;
      }
      if (command === "KwTo") { pending += "\\textbf{to} "; continue; }
      if (command === "tcp" || command === "tcc") {
        // A comment: on the statement it follows (`x\; \tcp*{c}`), or on a line of its own.
        const [comment] = args(1, true) ?? [];
        if (comment === undefined) break;
        if (pending.trim()) flush(comment);
        else if (match[2] && lines.length && lines[lines.length - 1].comment === undefined) lines[lines.length - 1].comment = comment;
        else flush(comment);
        continue;
      }
      if (command === "SetKwFunction") { const parts = args(2); if (parts) functions.set(name(parts[0]), parts[1]); continue; }
      if (command === "SetKwProg") { const parts = args(4); if (parts) programs.set(name(parts[0]), { lead: parts[1], separator: parts[2], end: parts[3] }); continue; }
      if (command === "SetKwInOut" || command === "SetKwInput") { const parts = args(2); if (parts) inputs.set(name(parts[0]), `${parts[1]}:`); continue; }
      if (command === "SetKw" || command === "SetKwData") { const parts = args(2); if (parts) keywords.set(name(parts[0]), command === "SetKw" ? `\\textbf{${parts[1]}}` : parts[1]); continue; }
      if (command === "SetKwBlock") { const parts = args(3); if (parts) blocks.set(name(parts[0]), { begin: parts[1], end: parts[2] }); continue; }
      if (command === "SetKwFor") { const parts = args(4); if (parts) loops.set(name(parts[0]), { lead: parts[1], trail: parts[2], end: parts[3] }); continue; }
      const fn = functions.get(command);
      if (fn !== undefined) {
        let at = i;
        while (/\s/.test(text[at] ?? "")) at++;
        const group = text[at] === "{" ? readGroup(text, at) : null;
        if (group) i = group.end;
        pending += group ? `\\textsc{${fn}}(${group.content.trim()})` : `\\textsc{${fn}}`;
        continue;
      }
      const keyword = keywords.get(command);
      if (keyword !== undefined) { pending += `${keyword} `; continue; }
      // A statement it does not know (another package's, or the document's own): the algorithm stays source.
      // Definitions made in the algorithm (cs.DS 2611.09172's `\let\oldnl\nl \newcommand{\nlnonumber}{…}`, unnumbering
      // lines) change how it prints in ways not read here: it stays source.
      if (/^(?:let|g?def|edef|xdef|newcommand|renewcommand|providecommand|csname)$/.test(command)) { failed = true; break; }
      if (command === "Indp" || command === "Indm") { flush(); shift = Math.max(0, shift + (command === "Indp" ? 1 : -1)); continue; }
      if (/^[A-Z]/.test(command) && !TEXT_CAPITALS.test(command)) {
        // The document's own statement macro (GaLore's `\PyCode{…}`): its expansion, read in its place.
        const at = i - match[0].length;
        const use = expand && expansions < 200 ? expand(text.slice(at)) : null;
        if (use && use.length) { text = text.slice(0, at) + use.text + text.slice(at + use.length); i = at; expansions++; continue; }
        failed = true;
        break;
      }
      pending += match[0];
    }
    flush();
  };

  read(source, 0);
  return failed || !lines.length ? null : { lines, numberEvery };
}
