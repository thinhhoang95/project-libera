/* The cells of a tabular, each with its exact range in the source
 * (docs/latex-visual-editor-plan.md §6.3). Rows end at `\\` and cells at `&`,
 * both at brace depth zero and outside math, comments and nested
 * environments. Rule lines are recorded but are not cells, and
 * `\multicolumn{n}{spec}{…}` is one cell spanning n columns. */

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
const RULE = /^\\(?:noalign(?![A-Za-z@])\s*\{[^}]*\}|(?:hline|toprule|midrule|bottomrule|addlinespace)(?![A-Za-z@])(\s*\[[^\]]*\])?|(?:cmidrule|cline)(?![A-Za-z@])(\s*\([^)]*\))?(\s*\[[^\]]*\])?(\s*\{[^}]*\})?|specialrule(?![A-Za-z@])(\s*\{[^}]*\}){0,3})/;

/** The column letters of a specification, without rules, `@{…}`, `>{…}`, `p{…}` widths and repeats expanded. */
export function parseColumnSpec(spec: string, types?: ColumnTypes) {
  return columnSpans(spec, 0, types)?.map((column) => column.letter) ?? [];
}

/** Most columns a specification may expand to; a larger one (nested `*{64}{…}` repeats) is left as source. */
const MAX_COLUMNS = 256;
/** Arguments each column type takes: `p{2cm}`, `w{l}{2cm}`. */
const COLUMN_ARGUMENTS: Record<string, number> = { p: 1, m: 1, b: 1, w: 2, W: 2 };

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
    if (/[A-Za-z]/.test(char)) {
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
        rows.push({ cells, from: offset + (rowStart >= 0 ? rowStart : cells[0]?.from - offset), to: offset + end, rulesBefore: rules, breakAt: offset + i });
        cells = [];
        rules = [];
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
  if (cells.length || tail.trim()) {
    let rest = tail.trim();
    if (!cells.length) {
      for (let rule = RULE.exec(rest); rule; rule = RULE.exec(rest)) { rulesAfter.push(rule[0].trim()); rest = rest.slice(rule[0].length).trimStart(); }
    }
    if (cells.length || rest) {
      rulesAfter.length = 0;
      pushCell(bodyTo);
      rows.push({ cells, from: offset + (rowStart >= 0 ? rowStart : cellStart), to: offset + bodyTo, rulesBefore: rules, breakAt: null });
    } else {
      // Rules after the last row: keep the ones already read there too.
      rulesAfter.unshift(...rules);
    }
  } else rulesAfter.push(...rules);

  return { specFrom: offset + specFrom, specTo: offset + specEnd, spec, columns: spans.map((column) => column.letter), rows, rulesAfter, bodyFrom: offset + bodyFrom, bodyTo: offset + bodyTo, types };
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
  const expanded = expand(texts.join("\n"));
  if (expanded === null) return null;
  const tabular = `\\begin{tabular}{${spec}}${withoutComments(expanded)}\\end{tabular}`;
  return parseTabular(tabular, 0, types) ? { caption, captionAt, label, tabular } : null;
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
  const expanded = expand(source);
  if (expanded === null || expanded === source) return null;
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
