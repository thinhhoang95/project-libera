/* The cells of a tabular, each with its exact range in the source
 * (docs/latex-visual-editor-plan.md §6.3). Rows end at `\\` and cells at `&`,
 * both at brace depth zero and outside math, comments and nested
 * environments. Rule lines are recorded but are not cells, and
 * `\multicolumn{n}{spec}{…}` is one cell spanning n columns. */

import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";

export type TableCell = {
  /** The cell's text, trimmed, as a source range (absolute). */
  from: number;
  to: number;
  /** The whole cell between its separators, spaces included. */
  outerFrom: number;
  outerTo: number;
  text: string;
  span: number;
  /** For a \multicolumn cell: the range of its content group's inside. */
  contentFrom?: number;
  contentTo?: number;
  /** Contains a comment, a line break or a nested tabular: edited as source. */
  sourceOnly: boolean;
};

export type TableRow = {
  cells: TableCell[];
  /** From the row's first cell to the end of its `\\` (or of the body for a last row without one). */
  from: number;
  to: number;
  /** Rules before this row: \hline, \toprule, \midrule, \bottomrule, \cline. */
  rulesBefore: string[];
  /** Where each of `rulesBefore` is (absolute), for removing them. */
  ruleRanges: Array<{ from: number; to: number }>;
  /** Where the row's `\\` starts, or null when the last row has none. */
  breakAt: number | null;
};

export type TableModel = {
  /** The column specification group's inside (`lc|r`) as a range. */
  specFrom: number;
  specTo: number;
  spec: string;
  columns: string[];
  rows: TableRow[];
  /** Rules after the last row. */
  rulesAfter: string[];
  /** Where each of `rulesAfter` is (absolute). */
  rulesAfterRanges: Array<{ from: number; to: number }>;
  bodyFrom: number;
  bodyTo: number;
  /** The document's `\newcolumntype`s the specification was read with. */
  types?: ColumnTypes;
};

/** `\newcolumntype` letters and how many arguments each takes (definitions.ts `columnTypes`). */
export type ColumnTypes = ReadonlyMap<string, { arity: number }>;

const TABULAR_NEWLINE = /^\\tabularnewline(?![A-Za-z@])/;
/**
 * A rule and its own arguments: `\hline`, booktabs' `\toprule[w]` and `\addlinespace[l]` take no group, so a group
 * after them (`\hline` then `{\small Random} & …` on the next line) is the next row's first cell.
 */
// arydshln's `\hdashline` and `\cdashline{1-2}`, makecell's `\Xhline{1pt}` and `\Cline`, hhline's `\hhline{|=|=|}`, and
// colortbl's `\arrayrulecolor{…}` are rules too (Self-RAG's ablation tables).
const RULE = /^\\(?:noalign(?![A-Za-z@])\s*\{[^}]*\}|(?:hline|toprule|midrule|bottomrule|addlinespace|hdashline|firsthline|lasthline)(?![A-Za-z@])(\s*\[[^\]]*\])?|(?:cmidrule|cline|cdashline|Cline|Xhline|hhline|arrayrulecolor)(?![A-Za-z@])(\s*\([^)]*\))?(\s*\[[^\]]*\])?(\s*\{[^}]*\})?(\s*\{[^}]*\})?|specialrule(?![A-Za-z@])(\s*\{[^}]*\}){0,3})/;

/** The column letters of a specification, without rules, `@{…}`, `>{…}`, `p{…}` widths and repeats expanded. */
/** A `ctable` read from its source: caption, label, the table as a tabular, its notes, and the command's length. */
export type CtableReading = { caption: string | null; label: string | null; captionBelow: boolean; tabular: string; notes: string[]; length: number };

/** Options of a `key=value` list, split at commas outside braces (`caption={A, B}`). */
function keyValues(text: string) {
  const values = new Map<string, string>();
  let depth = 0;
  let start = 0;
  const add = (part: string) => {
    const at = part.indexOf("=");
    const key = (at < 0 ? part : part.slice(0, at)).trim();
    if (!key) return;
    const value = at < 0 ? "" : part.slice(at + 1).trim();
    values.set(key, /^\{[\s\S]*\}$/.test(value) ? value.slice(1, -1) : value);
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    else if (text[i] === "," && depth === 0) { add(text.slice(start, i)); start = i + 1; }
  }
  add(text.slice(start));
  return values;
}

/**
 * The ctable package's `\ctable[caption={…},label=…]{spec}{notes}{rows}` (Callaway & Sant'Anna's tables), as a
 * tabular: `\FL` is the top rule, `\ML` a row end and a mid rule, `\LL` a row end and the bottom rule, `\NN` a row
 * end; the notes are its `\tnote[mark]{text}`s. `source` starts at the command; null when it is not one.
 */
export function readCtable(source: string): CtableReading | null {
  const head = /^\\ctable\s*/.exec(source);
  if (!head) return null;
  let i = head[0].length;
  const skip = () => { while (/\s/.test(source[i] ?? "")) i++; };
  const options = source[i] === "[" ? readOptional(source, i, TEX_GROUPS) : null;
  if (options) { i = options.end; skip(); }
  const groups: string[] = [];
  for (let n = 0; n < 3; n++) {
    skip();
    const group = source[i] === "{" ? readGroup(source, i, TEX_GROUPS) : null;
    if (!group) return null;
    groups.push(group.content);
    i = group.end;
  }
  const [spec, notesText, rows] = groups;
  const values = keyValues(options?.content ?? "");
  const notes: string[] = [];
  for (const match of notesText.matchAll(/\\tnote\s*(?:\[([^\]]*)\])?\s*\{/g)) {
    const group = readGroup(notesText, (match.index ?? 0) + match[0].length - 1, TEX_GROUPS);
    if (group) notes.push(`${match[1] ? `${match[1]} ` : ""}${group.content.trim()}`);
  }
  const body = rows
    .replace(/\\FL(?![A-Za-z@])/g, "\\toprule ")
    .replace(/\\ML(?![A-Za-z@])/g, "\\\\ \\midrule ")
    .replace(/\\LL(?![A-Za-z@])/g, "\\\\ \\bottomrule ")
    .replace(/\\NN(?![A-Za-z@])/g, "\\\\ ");
  return {
    caption: values.get("caption") ?? null, label: values.get("label") ?? null, captionBelow: values.has("botcap"),
    tabular: `\\begin{tabular}{${spec}}${body}\\end{tabular}`, notes, length: i,
  };
}

/** An AASTeX `deluxetable` read from its source: caption (where it is), labels, `\tablenum`, the table as a tabular, its notes. */
export type DeluxeTableReading = { caption: string | null; captionAt: number; labels: string[]; number: string | null; tabular: string; notes: string[] };

/** AASTeX's commands in a deluxetable's rows, as what they print: a digit's or a point's width, "no data", a note's mark. */
function deluxeCells(text: string, columns: number) {
  return text
    .replace(/\\phn(?![A-Za-z@])\s*/g, "\u2007")
    .replace(/\\phd(?![A-Za-z@])\s*/g, "\u2008")
    .replace(/\\phm\s*\{/g, "\\phantom{")
    .replace(/\\nodata(?![A-Za-z@])\s*/g, "$\\cdots$")
    .replace(/\\tablenotemark\s*\{/g, "\\textsuperscript{")
    .replace(/\\tableline(?![A-Za-z@])/g, "\\hline")
    .replace(/\\(?:nl|nextline)(?![A-Za-z@])/g, "\\\\")
    .replace(/\\colhead\s*\{/g, "\\multicolumn{1}{c}{")
    // A heading across the table: `\sidehead{…}` on the left, `\cutinhead{…}` centred between rules.
    .replace(/\\(sidehead|cutinhead)\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g, (_, command: string, heading: string) => command === "sidehead"
      ? `\\multicolumn{${columns}}{l}{${heading}} \\\\`
      : `\\hline \\multicolumn{${columns}}{c}{${heading}} \\\\ \\hline`);
}

/**
 * AASTeX's `\begin{deluxetable}{spec}` (2611.08676's tables): `\tablecaption{…}`, `\tablehead{\colhead{…} & …}` and
 * layout before `\startdata`, its rows up to `\enddata`, then `\tablenotetext{a}{…}`, `\tablecomments{…}` and
 * `\tablerefs{…}`. Read as a tabular with AASTeX's rules (two above the head, one under it and one at the end), and
 * the notes as the class prints them. `source` is the whole environment; null for anything else in it (it stays source).
 */
export function readDeluxeTable(source: string): DeluxeTableReading | null {
  const head = /^\\begin\s*\{(deluxetable\*?)\}\s*(?:\[[^\]]*\]\s*)?\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}(?:\s*\[[^\]]*\])?/.exec(source);
  if (!head) return null;
  const end = new RegExp(String.raw`\\end\s*\{${head[1].replace("*", "\\*")}\}\s*$`).exec(source);
  if (!end) return null;
  const spec = head[2];
  // AASTeX's `D` columns split numbers at their point over two columns (with `\decimals`): not read here.
  const columns = parseColumnSpec(spec);
  if (!columns.length || columns.includes("D")) return null;
  // Comments blanked out, keeping offsets (a `\%` is text).
  const body = source.slice(0, end.index).replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (comment, before: string, slashes: string) => before + slashes + " ".repeat(comment.length - before.length - slashes.length));
  let caption: string | null = null;
  let captionAt = -1;
  let number: string | null = null;
  let headRows: string | null = null;
  let rows: string | null = null;
  const labels: string[] = [];
  const notes: string[] = [];
  const withoutLabels = (text: string) => text.replace(/\\label\s*\{([^{}]*)\}/g, (_, key: string) => { labels.push(key.trim()); return ""; }).trim();
  let i = head[0].length;
  const group = () => {
    const open = /^\s*\{/.exec(body.slice(i, i + 200));
    const read = open ? readGroup(body, i + open[0].length - 1, TEX_GROUPS) : null;
    if (read) i = read.end;
    return read;
  };
  while (i < body.length) {
    const space = /^\s+/.exec(body.slice(i, i + 400));
    if (space) { i += space[0].length; continue; }
    const command = /^\\([A-Za-z@]+)\*?/.exec(body.slice(i, i + 60));
    if (!command) return null;
    const at = i;
    i += command[0].length;
    switch (command[1]) {
      case "tablecaption": {
        const text = group();
        if (!text) return null;
        caption = withoutLabels(text.content);
        captionAt = at;
        break;
      }
      case "tablehead": {
        const text = group();
        if (!text) return null;
        headRows = text.content.trim().replace(/\\\\\s*$/, "");
        break;
      }
      case "tablenum": {
        const text = group();
        if (!text) return null;
        number = text.content.trim();
        break;
      }
      case "tablewidth": case "tabletypesize": case "tablecolumns": case "label": {
        const text = group();
        if (!text) return null;
        if (command[1] === "label") labels.push(text.content.trim());
        break;
      }
      case "tablenotetext": {
        const mark = group();
        const text = mark && group();
        if (!mark || !text) return null;
        notes.push(mark.content.trim() ? `\\textsuperscript{${mark.content.trim()}}${withoutLabels(text.content)}` : withoutLabels(text.content));
        break;
      }
      case "tablecomments": case "tablerefs": {
        const text = group();
        if (!text) return null;
        notes.push(`\\textsc{${command[1] === "tablerefs" ? "References" : "Note"}}---${withoutLabels(text.content)}`);
        break;
      }
      case "startdata": {
        const stop = /\\enddata(?![A-Za-z@])/.exec(body.slice(i));
        if (!stop || rows !== null) return null;
        rows = body.slice(i, i + stop.index).trim();
        i += stop.index + stop[0].length;
        break;
      }
      // Layout: centring, rotation, the decimal alignment of `D` columns (refused above), a long table's breaks.
      case "centering": case "rotate": case "decimals": case "tablebreak": case "startlongtable": break;
      default: return null;
    }
  }
  if (rows === null) return null;
  const lines = [`\\hline\\hline`];
  if (headRows !== null && headRows) lines.push(`${deluxeCells(headRows, columns.length)} \\\\ \\hline`);
  const data = deluxeCells(rows, columns.length).replace(/\\\\\s*(?:\\hline\s*)*$/, "");
  lines.push(`${data} \\\\ \\hline`);
  return { caption, captionAt, labels, number, tabular: `\\begin{tabular}{${spec}}\n${lines.join("\n")}\n\\end{tabular}`, notes };
}

export function parseColumnSpec(spec: string, types?: ColumnTypes) {
  return columnSpans(spec, 0, types)?.map((column) => column.letter) ?? [];
}

/** Most columns a specification may expand to; a larger one (nested `*{64}{…}` repeats) is left as source. */
const MAX_COLUMNS = 256;
/** Arguments each column type takes: `p{2cm}`, `w{l}{2cm}`. */
/** Arguments of the column letters that take them; dcolumn's `D{.}{.}{3.2}` takes three (its cells are formulas). */
const COLUMN_ARGUMENTS: Record<string, number> = { p: 1, m: 1, b: 1, w: 2, W: 2, D: 3 };

/**
 * Each column of a specification with its whole source span: the letter, its
 * arguments, and the `>{…}` before and `<{…}` after it. `*{n}{…}` repeats are
 * expanded (the spans of repeated columns are the repeat's), within limits.
 * Null for a specification that cannot be read or is too large.
 */
export function columnSpans(spec: string, depth = 0, types?: ColumnTypes): Array<{ letter: string; from: number; to: number; repeated: boolean }> | null {
  const columns: Array<{ letter: string; from: number; to: number; repeated: boolean }> = [];
  let before = -1;
  for (let i = 0; i < spec.length; i++) {
    const char = spec[i];
    if (/\s|\|/.test(char)) continue;
    if (char === "@" || char === "!") {
      const end = matchingBrace(spec, i + 1);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (char === ">") {
      const end = matchingBrace(spec, i + 1);
      if (end < 0) return null;
      if (before < 0) before = i;
      i = end;
      continue;
    }
    if (char === "<") {
      // Belongs to the column before it.
      const end = matchingBrace(spec, i + 1);
      if (end < 0 || !columns.length) return null;
      columns[columns.length - 1].to = end + 1;
      i = end;
      continue;
    }
    if (char === "*") {
      if (depth >= 2) return null;
      const countEnd = matchingBrace(spec, i + 1);
      const bodyEnd = countEnd < 0 ? -1 : matchingBrace(spec, countEnd + 1);
      if (countEnd < 0 || bodyEnd < 0) return null;
      const count = Number(spec.slice(i + 2, countEnd).trim());
      // The count is bounded on its own: `*{100000000000000000000}{}` repeats nothing, but the loop would still run.
      if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COLUMNS) return null;
      const inner = columnSpans(spec.slice(countEnd + 2, bodyEnd), depth + 1, types);
      if (!inner || columns.length + count * inner.length > MAX_COLUMNS) return null;
      for (let n = 0; n < count; n++) for (const column of inner) columns.push({ letter: column.letter, from: i, to: bodyEnd + 1, repeated: true });
      i = bodyEnd;
      continue;
    }
    // A letter, or a column type the document gives another character (estout's `\newcolumntype{.}{D{.}{.}{-1}}`).
    if (/[A-Za-z]/.test(char) || types?.has(char)) {
      let end = i + 1;
      for (let n = 0; n < (types?.get(char)?.arity ?? COLUMN_ARGUMENTS[char] ?? 0); n++) {
        const close = matchingBrace(spec, end);
        if (close < 0) return null;
        end = close + 1;
      }
      // siunitx-style options: `S[table-format=2.1]`.
      if (spec[end] === "[") {
        const close = spec.indexOf("]", end);
        if (close < 0) return null;
        end = close + 1;
      }
      columns.push({ letter: char, from: before >= 0 ? before : i, to: end, repeated: false });
      if (columns.length > MAX_COLUMNS) return null;
      before = -1;
      i = end - 1;
      continue;
    }
    // Anything else in a specification is not understood.
    if (char !== "{" && char !== "}") return null;
  }
  return columns;
}

function matchingBrace(text: string, open: number) {
  if (open < 0 || text[open] !== "{") return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Reads a tabular environment's source, which starts at document position
 * `offset`. Returns null for one it cannot map exactly.
 */
export function parseTabular(source: string, offset = 0, types?: ColumnTypes): TableModel | null {
  const begin = /^\\begin\s*\{([A-Za-z*]+)\}/.exec(source);
  if (!begin) return null;
  const env = begin[1];
  let index = begin[0].length;
  // tabular*, tabularx and tabulary take a width first; an optional [pos] may come before the spec.
  const skipSpace = () => { while (/\s/.test(source[index] ?? "")) index++; };
  skipSpace();
  if (source[index] === "[") { const close = source.indexOf("]", index); if (close < 0) return null; index = close + 1; skipSpace(); }
  if (env === "tabular*" || env === "tabularx" || env === "tabulary" || env === "xltabular") {
    const end = matchingBrace(source, index);
    if (end < 0) return null;
    index = end + 1;
    skipSpace();
  }
  const specEnd = matchingBrace(source, index);
  if (specEnd < 0) return null;
  const specFrom = index + 1;
  const spec = source.slice(specFrom, specEnd);
  const endMatch = new RegExp(`\\\\end\\s*\\{${env.replace("*", "\\*")}\\}\\s*$`).exec(source);
  if (!endMatch) return null;
  const bodyFrom = specEnd + 1;
  const bodyTo = endMatch.index;

  const rows: TableRow[] = [];
  let cells: TableCell[] = [];
  let rules: string[] = [];
  let ruleRanges: Array<{ from: number; to: number }> = [];
  let cellStart = bodyFrom;
  let rowStart = -1;
  let depth = 0;
  let environments = 0;
  let sourceOnly = false;
  let math: string | null = null;

  const pushCell = (end: number) => {
    const raw = source.slice(cellStart, end);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    let from = cellStart + lead;
    const to = Math.max(from, end - trail);
    let text = source.slice(from, to);
    /** Moves the cell's start past `length` characters and the spaces after them. */
    const advance = (length: number) => {
      const rest = text.slice(length);
      const skip = length + (rest.length - rest.trimStart().length);
      from += skip;
      text = text.slice(skip);
    };
    // A commented-out line before the cell's content (`%\footnotesize SPP-net & …`) is not part of it.
    const skipComments = () => { for (let comment = /^%[^\n]*(?:\n|$)/.exec(text); comment; comment = /^%[^\n]*(?:\n|$)/.exec(text)) advance(comment[0].length); };
    skipComments();
    // Rules and spaces at the start of a row belong to the row, not its first cell.
    if (!cells.length) {
      for (let rule = RULE.exec(text); rule; rule = RULE.exec(text)) {
        rules.push(rule[0].trim());
        ruleRanges.push({ from: offset + from, to: offset + from + rule[0].trimEnd().length });
        advance(rule[0].length);
        skipComments();
      }
    }
    const cell: TableCell = { from: offset + from, to: offset + to, outerFrom: offset + cellStart, outerTo: offset + end, text, span: 1, sourceOnly };
    // The spec may hold one level of groups: `{@{}l}`.
    const multi = /^\\multicolumn\s*\{\s*(\d+)\s*\}\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*\{/.exec(text);
    if (multi) {
      const open = from + multi[0].length - 1;
      const close = matchingBrace(source, open);
      if (close > 0 && !source.slice(close + 1, to).trim()) {
        cell.span = Number(multi[1]) || 1;
        cell.contentFrom = offset + open + 1;
        cell.contentTo = offset + close;
      }
    }
    if (/\\multirow\b/.test(text)) cell.sourceOnly = true;
    if (rowStart < 0 && text) rowStart = from;
    cells.push(cell);
    sourceOnly = false;
  };

  for (let i = bodyFrom; i < bodyTo; i++) {
    const char = source[i];
    if (char === "%") {
      const end = source.indexOf("\n", i);
      i = end < 0 || end > bodyTo ? bodyTo : end;
      sourceOnly = true;
      continue;
    }
    if (math) {
      // The closing delimiter first: `\)` starts with a backslash.
      if (source.startsWith(math, i)) { i += math.length - 1; math = null; continue; }
      if (char === "\\") i++;
      continue;
    }
    if (char === "$") { math = source[i + 1] === "$" ? "$$" : "$"; if (math === "$$") i++; continue; }
    if (char === "{") { depth++; continue; }
    if (char === "}") { depth--; continue; }
    if (char === "\\") {
      if (source.startsWith("\\begin", i)) { environments++; sourceOnly = true; }
      else if (source.startsWith("\\end", i)) environments--;
      else if (source[i + 1] === "(") math = "\\)";
      else if (source[i + 1] === "[") math = "\\]";
      else if ((source[i + 1] === "\\" || TABULAR_NEWLINE.test(source.slice(i, i + 16))) && depth === 0 && environments === 0) {
        // `\\`, or array's `\tabularnewline`, ends the row.
        pushCell(i);
        let end = i + (source[i + 1] === "\\" ? 2 : "\\tabularnewline".length);
        if (source[end] === "*") end++;
        const spacing = /^[ \t]*\[[^\]]*\]/.exec(source.slice(end, bodyTo));
        if (spacing) end += spacing[0].length;
        rows.push({ cells, from: offset + (rowStart >= 0 ? rowStart : cells[0]?.from - offset), to: offset + end, rulesBefore: rules, ruleRanges, breakAt: offset + i });
        cells = [];
        rules = [];
        ruleRanges = [];
        rowStart = -1;
        cellStart = end;
        i = end - 1;
        continue;
      } else if (source[i + 1] === "\\" || source.startsWith("\\newline", i)) sourceOnly = true;
      i++;
      continue;
    }
    if (char === "&" && depth === 0 && environments === 0) {
      pushCell(i);
      cellStart = i + 1;
    }
  }
  // Unbalanced math, braces or environments: the cell map would be wrong, so the table stays as source.
  if (math || depth !== 0 || environments !== 0) return null;
  const spans = columnSpans(spec, 0, types);
  if (!spans) return null;
  // The text after the last `\\`: a last row, or only rules.
  const tail = source.slice(cellStart, bodyTo);
  const rulesAfter: string[] = [];
  const rulesAfterRanges: Array<{ from: number; to: number }> = [];
  if (cells.length || tail.trim()) {
    // A commented-out row before the closing rule (`% c & d \\` then `\hline`) is no row.
    let rest = withoutComments(tail).trim();
    if (!cells.length) {
      for (let rule = RULE.exec(rest); rule; rule = RULE.exec(rest)) { rulesAfter.push(rule[0].trim()); rest = rest.slice(rule[0].length).trimStart(); }
    }
    if (cells.length || rest) {
      rulesAfter.length = 0;
      pushCell(bodyTo);
      rows.push({ cells, from: offset + (rowStart >= 0 ? rowStart : cellStart), to: offset + bodyTo, rulesBefore: rules, ruleRanges, breakAt: null });
    } else {
      // Rules after the last row: keep the ones already read there too.
      rulesAfter.unshift(...rules);
      rulesAfterRanges.push(...ruleRanges, ...ruleRangesIn(source, cellStart, bodyTo, offset));
    }
  } else { rulesAfter.push(...rules); rulesAfterRanges.push(...ruleRanges); }

  return { specFrom: offset + specFrom, specTo: offset + specEnd, spec, columns: spans.map((column) => column.letter), rows, rulesAfter, rulesAfterRanges, bodyFrom: offset + bodyFrom, bodyTo: offset + bodyTo, types };
}

/** The rules at the start of [from, to) of `source`, past spaces and comment lines, as absolute ranges. */
function ruleRangesIn(source: string, from: number, to: number, offset: number) {
  const ranges: Array<{ from: number; to: number }> = [];
  let i = from;
  while (i < to) {
    const space = /^\s+/.exec(source.slice(i, to));
    if (space) { i += space[0].length; continue; }
    if (source[i] === "%") { const end = source.indexOf("\n", i); i = end < 0 || end > to ? to : end + 1; continue; }
    const rule = RULE.exec(source.slice(i, to));
    if (!rule) break;
    ranges.push({ from: offset + i, to: offset + i + rule[0].trimEnd().length });
    i += rule[0].length;
  }
  return ranges;
}

/** A longtable read for display: its caption and label, and a plain tabular of the rows it prints first. */
export type LongTableDisplay = { caption: string | null; captionAt: number; label: string | null; tabular: string };

const LONGTABLE_MARKERS = /^\\(endfirsthead|endhead|endfoot|endlastfoot)(?![A-Za-z])/;

/**
 * A `longtable` (or `xltabular`) as the page shows it where it starts: the
 * first head (`\endfirsthead`, else `\endhead`), the body and the last foot
 * (`\endlastfoot`, else `\endfoot`), without the repeated head and foot. The
 * caption and label leave the rows. Rows written through the document's own
 * macros come out of `expand` (null when it cannot), so this is drawn, not
 * edited cell by cell. Null for a source it cannot read.
 */
export function readLongTable(source: string, expand: (text: string) => string | null, types?: ColumnTypes): LongTableDisplay | null {
  const begin = /^\\begin\s*\{((?:longtable|xltabular)\*?)\}/.exec(source);
  if (!begin) return null;
  const env = begin[1];
  let index = begin[0].length;
  const skipSpace = () => { while (/\s/.test(source[index] ?? "")) index++; };
  skipSpace();
  if (source[index] === "[") { const close = source.indexOf("]", index); if (close < 0) return null; index = close + 1; skipSpace(); }
  if (env.startsWith("xltabular")) { const end = matchingBrace(source, index); if (end < 0) return null; index = end + 1; skipSpace(); }
  const specEnd = matchingBrace(source, index);
  if (specEnd < 0) return null;
  const spec = source.slice(index + 1, specEnd);
  const endMatch = new RegExp(`\\\\end\\s*\\{${env.replace("*", "\\*")}\\}\\s*$`).exec(source);
  if (!endMatch) return null;
  const bodyFrom = specEnd + 1;
  const body = source.slice(bodyFrom, endMatch.index);

  // Split at the head and foot markers, at brace depth zero and outside comments.
  const parts: Record<string, { text: string; from: number }> = {};
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "%") { const end = body.indexOf("\n", i); i = end < 0 ? body.length : end; continue; }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\\") {
      const marker = depth === 0 ? LONGTABLE_MARKERS.exec(body.slice(i)) : null;
      if (marker) {
        parts[marker[1]] = { text: body.slice(start, i), from: start };
        start = i + marker[0].length;
        i = start - 1;
      } else i++;
    }
  }
  const main = { text: body.slice(start), from: start };
  const head = parts.endfirsthead ?? parts.endhead ?? null;
  const foot = parts.endlastfoot ?? parts.endfoot ?? null;

  // The caption row: `\caption[…]{…}` and `\label{…}`, and the `\\` that ends them when nothing else is on the row.
  let caption: string | null = null;
  let captionAt = -1;
  let label: string | null = null;
  const withoutCaption = (part: { text: string; from: number }) => {
    const text = part.text;
    const command = /\\caption\*?\s*(?:\[[^\]]*\]\s*)?\{/.exec(text);
    if (!command) return text;
    const open = command.index + command[0].length - 1;
    const close = matchingBrace(text, open);
    if (close < 0) return text;
    caption = text.slice(open + 1, close);
    captionAt = bodyFrom + part.from + open + 1;
    let rest = text.slice(close + 1);
    const labelMatch = /^\s*\\label\s*\{([^}]*)\}/.exec(rest);
    if (labelMatch) { label = labelMatch[1].trim(); rest = rest.slice(labelMatch[0].length); }
    const lineEnd = /^\s*\\\\\*?(?:\s*\[[^\]]*\])?/.exec(rest);
    if (lineEnd) rest = rest.slice(lineEnd[0].length);
    return text.slice(0, command.index) + rest;
  };
  const sections = [head, main, foot].filter((part): part is { text: string; from: number } => !!part);
  const texts = sections.map((part) => (caption === null ? withoutCaption(part) : part.text));

  // Rows built by macros (`\row{a}{b}` → `a & b \\`): expand, then drop comments, which only end macro lines.
  const expanded = expandInChunks(texts.join("\n"), expand);
  const tabular = `\\begin{tabular}{${spec}}${withoutComments(expanded)}\\end{tabular}`;
  return parseTabular(tabular, 0, types) ? { caption, captionAt, label, tabular } : null;
}

/** A table body longer than this is expanded in pieces. */
const EXPANSION_CHUNK = 4000;

/** Where lines end outside braces and comments in `text` (each index is the start of the next line), for cutting a table body. */
function lineCuts(text: string) {
  const cuts: number[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") i++;
    else if (char === "%") { const end = text.indexOf("\n", i); if (end < 0) break; i = end - 1; }
    else if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\n" && depth <= 0) cuts.push(i + 1);
  }
  return cuts;
}

/**
 * `expand` applied to a table body in pieces cut at line ends outside braces, so that a long table does not hit the
 * expander's limit on one result and one macro it cannot read does not take the table with it: a piece it cannot expand
 * is tried line by line (a call whose arguments run over a few lines is tried joined), and a line it still cannot expand
 * stays as written, its macro shown as source by the cell it lands in.
 */
export function expandInChunks(text: string, expand: (text: string) => string | null): string {
  if (text.length <= EXPANSION_CHUNK) {
    const whole = expand(text);
    if (whole !== null) return whole;
  }
  const cuts = lineCuts(text);
  const nextCut = (after: number, limit: number) => cuts.find((cut) => cut > after && cut <= limit) ?? limit;
  let output = "";
  for (let start = 0; start < text.length;) {
    const end = cuts.find((cut) => cut - start >= EXPANSION_CHUNK) ?? text.length;
    const piece = text.length <= EXPANSION_CHUNK ? null : expand(text.slice(start, end));
    if (piece !== null) { output += piece; start = end; continue; }
    // Line by line; a call whose arguments run on (even past the end of the piece) takes the lines it needs.
    let from = start;
    while (from < end) {
      let to = nextCut(from, text.length);
      let got = expand(text.slice(from, to));
      for (let extra = 0; got === null && extra < 4 && to < text.length; extra++) { to = nextCut(to, text.length); got = expand(text.slice(from, to)); }
      if (got === null) { to = nextCut(from, text.length); got = text.slice(from, to); }
      output += got;
      from = to;
    }
    start = from;
  }
  return output;
}

/** Drops `%` comments (keeping `\%`): after expansion they only end the lines of macro bodies. */
function withoutComments(text: string) {
  return text.replace(/(^|[^\\])%[^\n]*/g, "$1");
}

/**
 * A tabular whose rows or cells are written through the document's macros
 * (`\row{a}{b}` for `a & b \\`): its expanded reading, to draw (not edit)
 * when expanding changes the grid. Null when the tabular's own `&` and `\\`
 * already give its cells, or the expansion cannot be read.
 */
export function macroBuiltTabular(source: string, expand: (text: string) => string | null, types?: ColumnTypes): string | null {
  const expanded = expandInChunks(source, expand);
  if (expanded === source) return null;
  const reading = withoutComments(expanded);
  const built = parseTabular(reading, 0, types);
  if (!built) return null;
  const own = parseTabular(source, 0, types);
  // Cells per row, and rules: a macro may write a rule (`\shline` for `\noalign{…}\hline\noalign{…}`).
  const shape = (model: TableModel) => model.rows.map((row) => `${row.rulesBefore.length}/${row.cells.reduce((count, cell) => count + cell.span, 0)}`).join(",");
  return own && shape(own) === shape(built) ? null : reading;
}

export type TableChange = { from: number; to: number; insert: string };

/**
 * The change that sets one cell's text (a \multicolumn cell keeps its
 * wrapper). With the cell's `current` text, only the part that differs is
 * replaced (one typed character is a one-character change).
 */
export function setCellText(cell: TableCell, text: string, current?: string): TableChange {
  const from = cell.contentFrom !== undefined && cell.contentTo !== undefined ? cell.contentFrom : cell.from;
  const to = cell.contentFrom !== undefined && cell.contentTo !== undefined ? cell.contentTo : cell.to;
  if (current === undefined || current.length !== to - from) return { from, to, insert: text };
  let start = 0;
  while (start < current.length && start < text.length && current[start] === text[start]) start++;
  let end = 0;
  while (end < current.length - start && end < text.length - start && current[current.length - 1 - end] === text[text.length - 1 - end]) end++;
  return { from: from + start, to: to - end, insert: text.slice(start, text.length - end) };
}

/** Indentation of the line a position is on, for inserted rows. */
function indentationBefore(source: string, offset: number, pos: number) {
  const local = pos - offset;
  const lineStart = source.lastIndexOf("\n", local - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))![0];
}

/** Changes that insert an empty row after row `index` (or before the first row when index is -1). */
export function insertRow(model: TableModel, source: string, offset: number, index: number): TableChange[] {
  const width = Math.max(model.columns.length, ...model.rows.map((row) => row.cells.reduce((sum, cell) => sum + cell.span, 0)));
  // An empty row: just its separators.
  const cells = Array.from({ length: Math.max(1, width) - 1 }, () => "&").join(" ");
  if (index < 0) {
    const first = model.rows[0];
    const at = first ? first.cells[0].from : model.bodyFrom;
    return [{ from: at, to: at, insert: `${cells} \\\\\n${indentationBefore(source, offset, at)}` }];
  }
  const row = model.rows[index];
  if (!row) return [];
  const indent = indentationBefore(source, offset, row.cells[0]?.from ?? row.from);
  if (row.breakAt === null) {
    // The last row has no `\\` yet: add one after its last cell, then the new row.
    const end = row.cells[row.cells.length - 1]?.to ?? row.to;
    return [{ from: end, to: end, insert: ` \\\\\n${indent}${cells}` }];
  }
  return [{ from: row.to, to: row.to, insert: `\n${indent}${cells} \\\\` }];
}

/** Changes that delete row `index` with its line break. */
export function deleteRow(model: TableModel, source: string, offset: number, index: number): TableChange[] {
  const row = model.rows[index];
  if (!row) return [];
  let from = row.cells[0]?.from ?? row.from;
  let to = row.to;
  const local = (pos: number) => pos - offset;
  // Take the whole line when the row is alone on it.
  const lineStart = source.lastIndexOf("\n", local(from) - 1) + 1;
  if (!source.slice(lineStart, local(from)).trim()) from = offset + lineStart;
  const lineEnd = source.indexOf("\n", local(to));
  if (lineEnd >= 0 && !source.slice(local(to), lineEnd).trim()) to = offset + lineEnd + 1;
  if (row.breakAt === null && index > 0) {
    // Deleting the last row: the previous row's `\\` goes too.
    const previous = model.rows[index - 1];
    if (previous.breakAt !== null) from = previous.breakAt;
    to = row.to;
  }
  return [{ from, to, insert: "" }];
}

/** Changes that insert an empty column after column `index` (-1: before the first), in the spec and every row. */
export function insertColumn(model: TableModel, index: number, letter = "l"): TableChange[] | null {
  const changes: TableChange[] = [];
  // Place the letter after the whole specification of the index-th column (`p{2cm}`, `>{…}l<{…}`).
  const spans = editableSpans(model.spec, model.types);
  if (!spans || spans.length !== model.columns.length) return null;
  const specAt = model.specFrom + (index < 0 ? (spans[0]?.from ?? 0) : spans[index].to);
  changes.push({ from: specAt, to: specAt, insert: letter });
  for (const row of model.rows) {
    let column = 0;
    let done = false;
    // A new empty cell: "& " after an existing separator, or " &" after a row's last cell.
    const after = (c: number) => (c < row.cells.length - 1 ? { from: row.cells[c].outerTo + 1, insert: " &" } : { from: row.cells[c].to, insert: " &" });
    for (let c = 0; c < row.cells.length && !done; c++) {
      const cell = row.cells[c];
      if (index < 0 && c === 0) { changes.push({ from: cell.from, to: cell.from, insert: "& " }); done = true; break; }
      column += cell.span;
      if (column - 1 === index) { const at = after(c); changes.push({ from: at.from, to: at.from, insert: at.insert }); done = true; }
      else if (column - 1 > index) return null; // inside a \multicolumn span
    }
    if (!done && row.cells.length) {
      const at = after(row.cells.length - 1);
      changes.push({ from: at.from, to: at.from, insert: at.insert });
    }
  }
  return changes.sort((a, b) => a.from - b.from);
}

/** Changes that delete column `index` from the spec and every row; null when a \multicolumn spans it. */
export function deleteColumn(model: TableModel, index: number): TableChange[] | null {
  const spans = editableSpans(model.spec, model.types);
  if (!spans || spans.length !== model.columns.length || model.columns.length <= 1) return null;
  // The column's whole specification goes, with its `>{…}` and `<{…}`.
  const changes: TableChange[] = [{ from: model.specFrom + spans[index].from, to: model.specFrom + spans[index].to, insert: "" }];
  for (const row of model.rows) {
    let column = 0;
    for (let c = 0; c < row.cells.length; c++) {
      const cell = row.cells[c];
      if (column === index) {
        if (cell.span !== 1) return null;
        // Remove the cell and the separator after it (or before it, for the last cell).
        // A row's first cell starts after the row's rules (\hline) and line break: those stay.
        const next = row.cells[c + 1];
        if (next) changes.push({ from: c === 0 ? cell.from : cell.outerFrom, to: next.outerFrom, insert: "" });
        else if (c > 0) changes.push({ from: row.cells[c - 1].to, to: cell.to, insert: "" });
        else changes.push({ from: cell.from, to: cell.to, insert: "" });
        break;
      }
      column += cell.span;
      if (column > index) return null;
    }
  }
  return changes.sort((a, b) => a.from - b.from);
}

/** Column spans that can be edited one by one: null when a repeat (`*{n}{…}`) covers any column. */
function editableSpans(spec: string, types?: ColumnTypes) {
  const spans = columnSpans(spec, 0, types);
  return spans && spans.every((span) => !span.repeated) ? spans : null;
}

/* ---- Rows written through the document's macros ------------------------------------------------------------- */

/**
 * The rows of a tabular that the document's macros write (`\row{a}{b}` for `a & b \\`), by row index of the
 * tabular's own reading: each such row's expansion, a tabular body to draw (not edit), or null when its expansion
 * cannot be read (the row is shown as its source). Rows whose cells only use macros (`\blocka{64}{3}`) are not
 * among them: they stay cells. Null when the tabular has no such row, or its own reading fails.
 */
export function macroRowReadings(source: string, expand: (text: string) => string | null, types?: ColumnTypes): Record<number, string | null> | null {
  const own = parseTabular(source, 0, types);
  if (!own) return null;
  const readings: Record<number, string | null> = {};
  let any = false;
  own.rows.forEach((row, index) => {
    const text = source.slice(row.from, row.to);
    const expanded = expand(text);
    if (expanded === text) return;
    any = true;
    if (expanded === null) { readings[index] = null; return; }
    const body = withoutComments(expanded);
    const sub = parseTabular(`\\begin{tabular}{${own.spec}}${body}\\end{tabular}`, 0, types);
    if (!sub) { readings[index] = null; return; }
    const shape = (r: TableRow) => r.cells.map((cell) => cell.span).join(",");
    // The same one row, cell for cell: the macros are in its cells.
    if (sub.rows.length === 1 && !sub.rows[0].rulesBefore.length && !sub.rulesAfter.length && shape(sub.rows[0]) === shape(row)) return;
    readings[index] = body;
  });
  return any && Object.keys(readings).length ? readings : null;
}

/* ---- What the commands around a tabular set for its grid ----------------------------------------------------- */

/** xcolor's `\rowcolors{start}{odd}{even}` and the row height `\arraystretch` in force for a tabular. */
export type TableSettings = { rowColors?: { start: number; odd: string; even: string }; stretch?: number };

/**
 * The settings `text` (the LaTeX before a tabular in its float or group) leaves for it: the last `\rowcolors`
 * (none after a `\hiderowcolors`), and `stretch`, the body of `\arraystretch` in force there. Undefined when none.
 */
export function readTableSettings(text: string, stretch?: string | null): TableSettings | undefined {
  const settings: TableSettings = {};
  const plain = withoutComments(text);
  let last: RegExpExecArray | null = null;
  for (const match of plain.matchAll(/\\(rowcolors\*?|hiderowcolors|showrowcolors)(?![A-Za-z@])(?:\s*\[[^\]]*\])?(?:\s*\{\s*(\d+)\s*\}\s*\{([^{}]*)\}\s*\{([^{}]*)\})?/g)) {
    if (match[1] === "hiderowcolors") last = null;
    else if (match[1].startsWith("rowcolors") && match[2]) last = match;
  }
  if (last) settings.rowColors = { start: Number(last[2]), odd: last[3].trim(), even: last[4].trim() };
  // A `\renewcommand{\arraystretch}{…}` in the text, else the one in force (the preamble's).
  const own = [...plain.matchAll(/\\(?:renewcommand\s*\{?\s*\\arraystretch\s*\}?|def\s*\\arraystretch)\s*\{([^{}]*)\}/g)].at(-1)?.[1] ?? stretch;
  const factor = own === undefined || own === null ? NaN : Number(own.trim());
  if (Number.isFinite(factor) && factor > 0 && factor !== 1) settings.stretch = Math.min(4, Math.max(0.5, factor));
  return settings.rowColors || settings.stretch ? settings : undefined;
}

/* ---- Editing: merging and splitting cells, alignment, rules, moving rows and columns ------------------------- */

/** One change replacing `current` at `from` by `next`, writing only the characters that differ. */
function replaceMinimal(from: number, current: string, next: string): TableChange {
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let end = 0;
  while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end++;
  return { from: from + start, to: from + current.length - end, insert: next.slice(start, next.length - end) };
}

/** The cells of a row covering columns [first, last] exactly, as indices; null when a span crosses either edge or the row is short. */
function cellsCovering(row: TableRow, first: number, last: number) {
  let column = 0;
  let from = -1;
  for (let c = 0; c < row.cells.length; c++) {
    if (column === first) from = c;
    column += row.cells[c].span;
    if (from >= 0 && column - 1 === last) return { from, to: c };
    if (column - 1 >= last) return null;
  }
  return null;
}

/** The column a row's cell starts at. */
export function columnOfCell(row: TableRow, cellIndex: number) {
  let column = 0;
  for (let i = 0; i < cellIndex; i++) column += row.cells[i]?.span ?? 1;
  return column;
}

const MULTICOLUMN = /^\\multicolumn\s*\{\s*(\d+)\s*\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{/;
const MULTIROW = /^\\multirow\s*(?:\[[^\]]*\]\s*)?\{\s*(\d+)\s*\}\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\}\s*(?:\[[^\]]*\]\s*)?\{/;

/** What a cell shows: a `\multicolumn`'s content, else its text. */
function cellContent(cell: TableCell, source: string, offset: number) {
  return cell.contentFrom !== undefined && cell.contentTo !== undefined ? source.slice(cell.contentFrom - offset, cell.contentTo - offset) : cell.text;
}

/** Whether LaTeX has a comment (an unescaped `%`): wrapped in braces, it would hide the closing one. */
function hasComment(text: string) {
  return /(^|[^\\])(?:\\\\)*%/.test(text);
}

/**
 * Changes that merge the cells of rows [r1, r2] and columns [c1, c2] into one: `\multicolumn{n}{a}{…}` across
 * columns, `\multirow{n}{*}{…}` down rows (both for a block), with the merged cells' text joined in the first;
 * the other rows' cells in the block become empty. Null when a cell crosses the block's edge, holds a comment or
 * a `\multirow` already, or the block is one cell.
 */
export function mergeCells(model: TableModel, source: string, offset: number, r1: number, r2: number, c1: number, c2: number): TableChange[] | null {
  if (r1 > r2) [r1, r2] = [r2, r1];
  if (c1 > c2) [c1, c2] = [c2, c1];
  if (r1 < 0 || c1 < 0 || (r1 === r2 && c1 === c2)) return null;
  const width = c2 - c1 + 1;
  const height = r2 - r1 + 1;
  const letter = model.columns[c1];
  const align = letter === "l" || letter === "c" || letter === "r" ? letter : "c";
  const changes: TableChange[] = [];
  const texts: string[] = [];
  const blocks: Array<{ from: number; to: number; current: string }> = [];
  for (let r = r1; r <= r2; r++) {
    const row = model.rows[r];
    const covering = row && cellsCovering(row, c1, c2);
    if (!covering) return null;
    const cells = row.cells.slice(covering.from, covering.to + 1);
    if (cells.some((cell) => hasComment(cell.text) || /\\multirow\b/.test(cell.text) || (cell.span > 1 && cell.contentFrom === undefined))) return null;
    for (const cell of cells) { const text = cellContent(cell, source, offset).trim(); if (text) texts.push(text); }
    const from = cells[0].from;
    const to = cells[cells.length - 1].to;
    blocks.push({ from, to, current: source.slice(from - offset, to - offset) });
  }
  const content = texts.join(" ");
  blocks.forEach((block, i) => {
    let text = i === 0 ? (height > 1 ? `\\multirow{${height}}{*}{${content}}` : content) : "";
    if (width > 1) text = `\\multicolumn{${width}}{${align}}{${text}}`;
    changes.push(replaceMinimal(block.from, block.current, text));
  });
  return changes;
}

/** Changes that split a `\multicolumn` (into its columns, the text in the first) or a `\multirow` (into its rows); null for another cell. */
export function splitCell(model: TableModel, source: string, offset: number, r: number, c: number): TableChange[] | null {
  const cell = model.rows[r]?.cells[c];
  if (!cell) return null;
  const current = source.slice(cell.from - offset, cell.to - offset);
  if (cell.contentFrom !== undefined && cell.contentTo !== undefined && MULTICOLUMN.test(current)) {
    const content = source.slice(cell.contentFrom - offset, cell.contentTo - offset);
    return [replaceMinimal(cell.from, current, `${content}${" &".repeat(Math.max(0, cell.span - 1))}`)];
  }
  const multirow = MULTIROW.exec(current);
  if (multirow) {
    const open = cell.from - offset + multirow[0].length - 1;
    const close = matchingBrace(source, open);
    if (close < 0 || source.slice(close + 1, cell.to - offset).trim()) return null;
    return [replaceMinimal(cell.from, current, source.slice(open + 1, close))];
  }
  return null;
}

/** The change that sets column `column`'s alignment letter (`l`, `c` or `r`) in the specification; null when it is another kind of column. */
export function setColumnAlignment(model: TableModel, column: number, letter: "l" | "c" | "r"): TableChange[] | null {
  const spans = editableSpans(model.spec, model.types);
  const span = spans?.[column];
  if (!span || spans!.length !== model.columns.length) return null;
  let at = span.from;
  // Past `>{…}` before the letter.
  while (at < span.to) {
    if (/\s/.test(model.spec[at])) { at++; continue; }
    if (model.spec[at] !== ">") break;
    const close = matchingBrace(model.spec, at + 1);
    if (close < 0) return null;
    at = close + 1;
  }
  const current = model.spec[at];
  if (!/^[lcr]$/.test(current ?? "") || current === letter || model.types?.has(current)) return null;
  return [{ from: model.specFrom + at, to: model.specFrom + at + 1, insert: letter }];
}

/** Whether the table is ruled with booktabs (`\toprule`, `\midrule`, `\bottomrule`, `\cmidrule`) rather than `\hline`. */
function booktabs(model: TableModel) {
  return [...model.rows.flatMap((row) => row.rulesBefore), ...model.rulesAfter].some((rule) => /^\\(?:toprule|midrule|bottomrule|cmidrule)/.test(rule));
}

/** Changes that add a rule above row `r` (`below`: under it): `\hline`, or booktabs' rule for that place when the table uses booktabs. */
export function addRule(model: TableModel, source: string, offset: number, r: number, below = false): TableChange[] | null {
  const row = model.rows[r];
  if (!row || !row.cells.length) return null;
  const ruled = booktabs(model);
  const last = r === model.rows.length - 1;
  if (below && !last) return addRule(model, source, offset, r + 1, false);
  const rule = !ruled ? "\\hline" : below ? "\\bottomrule" : r === 0 ? "\\toprule" : "\\midrule";
  const at = row.cells[0].from;
  const indent = indentationBefore(source, offset, at);
  if (below) {
    if (row.breakAt === null) {
      // The last row gains a `\\` first: a rule must start a row.
      const end = row.cells[row.cells.length - 1].to;
      return [{ from: end, to: end, insert: ` \\\\\n${indent}${rule}` }];
    }
    return [{ from: row.to, to: row.to, insert: `\n${indent}${rule}` }];
  }
  const local = at - offset;
  const lineStart = source.lastIndexOf("\n", local - 1) + 1;
  const alone = !source.slice(lineStart, local).trim();
  return [{ from: at, to: at, insert: alone ? `${rule}\n${indent}` : `${rule} ` }];
}

/** Changes that remove the rules above row `r` (`below`: under it); null when there are none. */
export function removeRules(model: TableModel, source: string, offset: number, r: number, below = false): TableChange[] | null {
  if (!model.rows[r]) return null;
  const ranges = below ? (model.rows[r + 1]?.ruleRanges ?? (r === model.rows.length - 1 ? model.rulesAfterRanges : [])) : model.rows[r].ruleRanges;
  if (!ranges.length) return null;
  const changes: TableChange[] = [];
  // Rules next to each other (only spaces between) go together, with their line when nothing else is on it.
  let group: { from: number; to: number } | null = null;
  const flush = () => {
    if (!group) return;
    let { from, to } = group;
    const lineStart = source.lastIndexOf("\n", from - offset - 1) + 1;
    let lineEnd = source.indexOf("\n", to - offset);
    if (lineEnd < 0) lineEnd = source.length;
    if (!source.slice(lineStart, from - offset).trim() && !source.slice(to - offset, lineEnd).trim() && lineEnd < source.length) { from = offset + lineStart; to = offset + lineEnd + 1; }
    else {
      // Only the rule and the spaces after it.
      while (/[ \t]/.test(source[to - offset] ?? "")) to++;
    }
    changes.push({ from, to, insert: "" });
    group = null;
  };
  for (const range of ranges) {
    if (group && !source.slice(group.to - offset, range.from - offset).trim()) group.to = range.to;
    else { flush(); group = { ...range }; }
  }
  flush();
  return changes;
}

/** The changes that swap row `r` with the row above (`direction` -1) or below (1); the rules between rows stay where they are. */
export function moveRow(model: TableModel, source: string, offset: number, r: number, direction: -1 | 1): TableChange[] | null {
  const a = model.rows[r];
  const b = model.rows[r + direction];
  if (!a || !b || !a.cells.length || !b.cells.length) return null;
  const range = (row: TableRow) => ({ from: row.cells[0].from, to: row.cells[row.cells.length - 1].to });
  const ra = range(a);
  const rb = range(b);
  const text = (span: { from: number; to: number }) => source.slice(span.from - offset, span.to - offset);
  // A last row ends without `\\`: its text moves, the `\\` stays.
  return [replaceMinimal(ra.from, text(ra), text(rb)), replaceMinimal(rb.from, text(rb), text(ra))].sort((x, y) => x.from - y.from);
}

/** The changes that swap column `column` with the one left (`direction` -1) or right (1), in the specification and every row. */
export function moveColumn(model: TableModel, source: string, offset: number, column: number, direction: -1 | 1): TableChange[] | null {
  const other = column + direction;
  const spans = editableSpans(model.spec, model.types);
  if (!spans || spans.length !== model.columns.length || !spans[column] || !spans[other]) return null;
  const changes: TableChange[] = [];
  const specText = (span: { from: number; to: number }) => model.spec.slice(span.from, span.to);
  changes.push(replaceMinimal(model.specFrom + spans[column].from, specText(spans[column]), specText(spans[other])));
  changes.push(replaceMinimal(model.specFrom + spans[other].from, specText(spans[other]), specText(spans[column])));
  for (const row of model.rows) {
    const width = row.cells.reduce((sum, cell) => sum + cell.span, 0);
    // A short row without either column is left alone.
    if (width <= Math.min(column, other)) continue;
    const a = cellsCovering(row, column, column);
    const b = cellsCovering(row, other, other);
    if (!a || !b) return null;
    const ca = row.cells[a.from];
    const cb = row.cells[b.from];
    const text = (cell: TableCell) => source.slice(cell.from - offset, cell.to - offset);
    changes.push(replaceMinimal(ca.from, text(ca), text(cb)), replaceMinimal(cb.from, text(cb), text(ca)));
  }
  return changes.filter((change) => change.from !== change.to || change.insert).sort((x, y) => x.from - y.from);
}

/**
 * The text a cell's editor writes: a comment on its last line would hide what follows the cell on its line (its
 * `&` or `\\`), so a line break ends it; `after` is the rest of that line in the document.
 */
export function safeCellText(text: string, after: string) {
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  return hasComment(lastLine) && after.trim() ? `${text}\n` : text;
}
