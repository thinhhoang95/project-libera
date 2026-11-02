// Citation commands in LaTeX source: `\cite{a,b}`, `\citep[p.~3]{a}`,
// biblatex's `\parencite`, `\textcite`, multicites `\parencites[x]{a}{b}`,
// starred forms and the like. Comments and literal examples are skipped.
// Offsets are UTF-16 offsets into the source, like scanCitations' for Markdown.

export type LatexCitation = {
  /** The command name, without the backslash or star. */
  command: string;
  /** Keys in written order, `*` (as in `\nocite{*}`) left out. */
  keys: string[];
  start: number;
  end: number;
};

const CITE_COMMAND = /^(?:no|full|paren|text|auto|foot|smart|super)?cite(?:p|t|alp|alt|author|year|yearpar|title|date|url|num)?s?$/i;
const LITERAL_ENVIRONMENT = /^(?:verbatim\*?|Verbatim\*?|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|comment)$/;
const DEFINITION = /^(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand)$/;

export function isLatexCiteCommand(name: string) {
  return CITE_COMMAND.test(name);
}

/** The end of a group opened at `from` by `open`, or -1 when it is not closed. */
function groupEnd(source: string, from: number, open: string, close: string, comments = true) {
  let depth = 0;
  let braces = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") { index += 1; continue; }
    if (comments && char === "%") { index = commentEnd(source, index) - 1; continue; }
    // Braces protect brackets/parentheses in notes, e.g. [{see [a]}].
    if (open !== "{") {
      if (char === "{") braces += 1;
      else if (char === "}") braces -= 1;
      if (braces || char === "}") continue;
    }
    if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index + 1;
  }
  return -1;
}

function skipSpace(source: string, from: number) {
  let index = from;
  while (index < source.length) {
    if (/\s/.test(source[index])) index += 1;
    else if (source[index] === "%") index = commentEnd(source, index);
    else break;
  }
  return index;
}

function commentEnd(source: string, from: number) {
  let end = from;
  while (end < source.length && source[end] !== "\r" && source[end] !== "\n") end += 1;
  if (source[end] === "\r" && source[end + 1] === "\n") return end + 2;
  return Math.min(end + 1, source.length);
}

/** A control word, or one control symbol (`\\`, `\%`, …). */
function commandEnd(source: string, from: number) {
  let end = from + 1;
  if (!/[A-Za-z]/.test(source[end] ?? "")) return Math.min(end + 1, source.length);
  while (end < source.length && /[A-Za-z]/.test(source[end])) end += 1;
  return end;
}

function inlineEnd(source: string, from: number) {
  if (source[from] === "{") {
    const end = groupEnd(source, from, "{", "}", false);
    return end < 0 ? source.length : end;
  }
  const end = source.indexOf(source[from], from + 1);
  const lineEnd = commentEnd(source, from);
  return end < 0 || end >= lineEnd ? lineEnd : end + 1;
}

function skipGroup(source: string, from: number, open: string, close: string) {
  const end = groupEnd(source, from, open, close);
  return end < 0 ? source.length : end;
}

/** Definitions store tokens; a citation in their body is not executed here. */
function definitionEnd(source: string, from: number, primitive: boolean) {
  let index = skipSpace(source, from);
  if (source[index] === "{") index = groupEnd(source, index, "{", "}");
  else if (source[index] === "\\") index = commandEnd(source, index);
  else return from;
  if (index < 0) return source.length;
  index = skipSpace(source, index);
  if (primitive) {
    while (index < source.length && source[index] !== "{") {
      if (source[index] === "%") index = commentEnd(source, index);
      else index += 1;
    }
  } else {
    while (source[index] === "[") {
      const close = groupEnd(source, index, "[", "]");
      if (close < 0) return source.length;
      index = skipSpace(source, close);
    }
  }
  if (source[index] !== "{") return index;
  const end = groupEnd(source, index, "{", "}");
  return end < 0 ? source.length : end;
}

function literalKeys(text: string) {
  const keys: string[] = [];
  let from = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (text[index] === "\\") { index += 1; continue; }
    if (text[index] === "{") { index = skipGroup(text, index, "{", "}") - 1; continue; }
    if (index < text.length && text[index] !== ",") continue;
    const key = text.slice(from, index).trim();
    if (key && key !== "*" && !/[\s{}\\]/.test(key)) keys.push(key);
    from = index + 1;
  }
  return keys;
}

/** Every citation command in LaTeX `source`, in document order. */
export function scanLatexCitations(source: string): LatexCitation[] {
  const citations: LatexCitation[] = [];
  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] === "%") { cursor = commentEnd(source, cursor); continue; }
    if (source[cursor] !== "\\") { cursor += 1; continue; }
    const start = cursor;
    cursor = commandEnd(source, cursor);
    const command = source.slice(start + 1, cursor);
    if (source[cursor] === "*") cursor += 1;
    if (command === "begin") {
      const from = skipSpace(source, cursor);
      const end = source[from] === "{" ? groupEnd(source, from, "{", "}") : -1;
      const environment = end < 0 ? "" : source.slice(from + 1, end - 1);
      if (LITERAL_ENVIRONMENT.test(environment)) {
        const ending = new RegExp(`\\\\end\\s*\\{${environment.replace("*", "\\*")}\\}`).exec(source.slice(end));
        cursor = ending ? end + ending.index + ending[0].length : source.length;
      }
      continue;
    }
    if (command === "verb" || command === "lstinline" || command === "mintinline") {
      let from = command === "verb" ? cursor : skipSpace(source, cursor);
      if (source[from] === "[") from = skipSpace(source, skipGroup(source, from, "[", "]"));
      if (command === "mintinline" && source[from] === "{") from = skipSpace(source, skipGroup(source, from, "{", "}"));
      cursor = from < source.length ? inlineEnd(source, from) : source.length;
      continue;
    }
    if (DEFINITION.test(command) || /^(?:g|e|x)?def$/.test(command)) {
      cursor = definitionEnd(source, cursor, !DEFINITION.test(command));
      // xparse definitions have an argument specification before the body.
      if (/DocumentCommand$/.test(command)) {
        const from = skipSpace(source, cursor);
        if (source[from] === "{") cursor = skipGroup(source, from, "{", "}");
      }
      continue;
    }
    if (!isLatexCiteCommand(command)) continue;
    // biblatex multicites (`\cites`, `\parencites`, …) take several key groups.
    const multi = /s$/i.test(command);
    const keys: string[] = [];
    let end = cursor;
    let groups = 0;
    for (;;) {
      let index = skipSpace(source, end);
      // A multicite's global notes `(pre)(post)`, then each cite's `[pre][post]`.
      while (multi && !groups && source[index] === "(") {
        const close = groupEnd(source, index, "(", ")");
        if (close < 0) break;
        index = skipSpace(source, close);
      }
      while (source[index] === "[") {
        const close = groupEnd(source, index, "[", "]");
        if (close < 0) break;
        index = skipSpace(source, close);
      }
      if (source[index] !== "{") break;
      const close = groupEnd(source, index, "{", "}");
      if (close < 0) break;
      const text = source.slice(index + 1, close - 1).replace(/\\[\s\S]|%[^\r\n]*(?:\r\n?|\n|$)[ \t]*/g, (token) => token.startsWith("%") ? "" : token);
      keys.push(...literalKeys(text));
      end = close;
      groups += 1;
      if (!multi) break;
    }
    if (!groups) continue;
    citations.push({ command, keys, start, end });
    cursor = end;
  }
  return citations;
}

/** Keys the LaTeX source cites, in document order, each once. */
export function latexCitedKeys(source: string) {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const citation of scanLatexCitations(source)) {
    for (const key of citation.keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** Library-relative paths of LaTeX sources whose citations count (not `.bib`, `.sty` or `.cls`). */
export function isLatexCitingPath(path: string) {
  return /\.tex$/i.test(path);
}

/** The commands Cite at cursor writes into LaTeX. */
export type LatexCiteCommand = "cite" | "citep";

/** `\command{a,b}` for literal keys, or null when a key would break the command. */
export function latexCitation(keys: readonly string[], command: LatexCiteCommand = "cite") {
  if (!keys.length || keys.some((key) => !key || /[\s,{}\\%]/.test(key))) return null;
  return `\\${command}{${keys.join(",")}}`;
}
