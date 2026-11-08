import { readGroup, readOptional } from "../../../macros/core";

/* The body of an `algorithmic` environment, for the Visual mode: the
 * statements of the algorithmic package (\STATE, \IF, \FOR …) and of
 * algpseudocode (\State, \If, \For …), as numbered, indented lines. What it
 * does not know (algorithm2e's \KwIn, \eIf) makes it null: left as source. */

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
