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
};

export type AlgorithmSpec = { lines: AlgorithmLine[]; numberEvery: number };

type Kind = { lead?: string; trail?: string; args: number; open?: boolean; close?: boolean; middle?: boolean; numbered?: boolean; name?: boolean };

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
export function parseAlgorithmic(body: string, options: string | null): AlgorithmSpec | null {
  const numberEvery = options && /^\s*\d+\s*$/.test(options) ? Number(options) : 0;
  // Comments, labels, vertical space and size switches are not lines of the algorithm.
  const source = body.replace(/(^|[^\\])%[^\n]*/g, "$1")
    .replace(/\\(?:label|vspace\*?|addvspace)\s*\{[^{}]*\}/g, "")
    .replace(/\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large)(?![A-Za-z@])/g, "");
  const lines: AlgorithmLine[] = [];
  let depth = 0;
  let i = 0;
  const statement = /\\([A-Za-z]+)(?![A-Za-z@])/g;
  // Find each statement command at brace depth zero; the text up to the next one is its line.
  const starts: Array<{ at: number; name: string; kind: Kind; end: number }> = [];
  let braces = 0;
  for (; i < source.length; i++) {
    const char = source[i];
    if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === "\\" && braces === 0) {
      statement.lastIndex = i;
      const match = statement.exec(source);
      if (match && match.index === i) {
        const kind = STATEMENTS[match[1].toLowerCase()];
        if (kind) starts.push({ at: i, name: match[1], kind, end: i + match[0].length });
        i += match[0].length - 1;
      } else i++;
    }
  }
  if (braces !== 0) return null;
  if (!starts.length || source.slice(0, starts[0].at).trim()) return null;
  for (let index = 0; index < starts.length; index++) {
    const { kind, end } = starts[index];
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
    }
    // algorithmic takes `\IF{c}` and `\STATE text`; an optional argument (`\STATE[label]`) is dropped.
    const optional = readOptional(rest.trimStart(), 0);
    if (optional && kind.args === 0) rest = rest.trimStart().slice(optional.end);
    const text = kind.name ? `\\textsc{${args[0]}}(${args[1] ?? ""})` : [...args, rest.trim()].filter(Boolean).join(" ");
    // `\State \Return x`: the statement is the return.
    if (!text && !kind.lead && comment === undefined && index + 1 < starts.length) continue;
    lines.push({ depth, lead: kind.lead, text, trail: kind.trail, comment, numbered: kind.numbered !== false });
    if (kind.open || kind.middle) depth++;
  }
  return { lines, numberEvery };
}

/* ---- algorithm2e ---------------------------------------------------------------- */

/** Settings and float markup in an algorithm2e body, with how many arguments they take: not lines. */
const IGNORED_2E: Record<string, number> = {
  SetAlgoLined: 0, SetAlgoVlined: 0, SetAlgoNoLine: 0, SetAlgoNoEnd: 0, SetAlgoShortEnd: 0, SetAlgoLongEnd: 0,
  DontPrintSemicolon: 0, PrintSemicolon: 0, LinesNumbered: 0, LinesNotNumbered: 0, LinesNumberedHidden: 0, nl: 0,
  Indp: 0, Indm: 0, BlankLine: 0, centering: 0, SetSideCommentLeft: 0, SetSideCommentRight: 0, SetNoFillComment: 0, SetFillComment: 0,
  tiny: 0, scriptsize: 0, footnotesize: 0, small: 0, normalsize: 0, large: 0,
  caption: 1, label: 1, vspace: 1, IncMargin: 1, DecMargin: 1, SetAlFnt: 1, SetAlCapFnt: 1, SetAlCapNameFnt: 1, SetAlCapSty: 1, SetAlCapSkip: 1,
  SetArgSty: 1, SetFuncSty: 1, SetKwSty: 1, SetCommentSty: 1, SetDataSty: 1, SetProgSty: 1, SetVlineSkip: 1, TitleOfAlgo: 1, RestyleAlgo: 1,
  SetInd: 2, SetNlSty: 3, SetAlgorithmName: 3,
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
export function parseAlgorithm2e(body: string, options: { numbered: boolean; ends: boolean }): AlgorithmSpec | null {
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
  let failed = false;
  const name = (text: string) => text.trim().replace(/^\\/, "");
  /** The document's function names and keywords in an argument (`\Fn{\FMain{$x$}}`), as they are drawn. */
  const words = (text: string) => !text.includes("\\") ? text : text.replace(/\\([A-Za-z@]+)(?![A-Za-z@])(\s*\{((?:[^{}]|\{[^{}]*\})*)\})?/g, (whole, command: string, group: string | undefined, args: string | undefined) => {
    const fn = functions.get(command);
    if (fn !== undefined) return group ? `\\textsc{${fn}}(${args!.trim()})` : `\\textsc{${fn}}`;
    const keyword = keywords.get(command);
    return keyword !== undefined ? `${keyword}${group ?? ""}` : whole;
  });

  const read = (text: string, depth: number) => {
    let pending = "";
    let i = 0;
    const push = (line: Omit<AlgorithmLine, "depth" | "numbered"> & { numbered?: boolean }) => lines.push({ depth, numbered: true, ...line, text: words(line.text) });
    const flush = (comment?: string) => {
      const text = pending.replace(/\s+/g, " ").trim();
      pending = "";
      if (text || comment !== undefined) push({ text, comment });
    };
    const end = () => { if (ends) push({ lead: "end", text: "" }); };
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
      if (command in LOOPS_2E) {
        flush();
        const parts = args(2);
        if (!parts) break;
        push({ lead: LOOPS_2E[command], text: parts[0], trail: "do" });
        read(parts[1], depth + 1);
        end();
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
        const parts = args(2);
        if (!parts) break;
        push({ lead: command.endsWith("ElseIf") ? "else if" : "if", text: parts[0], trail: "then" });
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
        push({ lead: loop ?? (command === "lIf" ? "if" : "else if"), text: `${parts[0]} \\textbf{${loop ? "do" : "then"}} ${parts[1]}` });
        continue;
      }
      if (command === "lElse") { flush(); const parts = args(1); if (parts) push({ lead: "else", text: parts[0] }); continue; }
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
      if (command === "KwRet" || command === "Return") { const [value] = args(1) ?? []; pending += `\\textbf{return} ${value ?? ""}`; continue; }
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
      if (/^[A-Z]/.test(command) && !TEXT_CAPITALS.test(command)) { failed = true; break; }
      pending += match[0];
    }
    flush();
  };

  read(source, 0);
  return failed || !lines.length ? null : { lines, numberEvery };
}
