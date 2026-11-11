import type { LatexMacro } from "../../macros/definitions";
import { readMacroArguments } from "../../macros/expand";
import { canonicalTokens, type TexChange } from "./tex-tokens";

/* The pieces of a formula the formula editor edits one at a time (docs/latex-visual-editor-plan.md §6.2).
 * A formula is split, in its source, at its top-level `&` and `\\`: one piece per cell of each row. What is
 * between the pieces (the `&`s, the `\\[2pt]`s, `\label`, `\tag`, `\nonumber`, `%` comments, `\intertext`,
 * `\hline`) is never given to MathLive and so is never rewritten. A formula that is a single alignment
 * environment (`\[\begin{pmatrix}…\end{pmatrix}\]`, an `equation` holding a `split`) is split at that
 * environment's rows. Macros MathLive cannot read (an optional argument, an xparse spec, physics' delimited
 * forms, an unrenderable body) become opaque atoms that are written back as they were written. */

export type FormulaPiece = {
  /** The piece's source, trimmed of the spaces around it, in content offsets. An empty cell is an empty range. */
  from: number;
  to: number;
  /** Row and cell (between `&`s) of the environment the formula was split at. */
  row: number;
  cell: number;
  /** Why MathLive cannot edit this piece (it opens as source), or null. */
  reason: string | null;
};

export type FormulaLayout = {
  pieces: FormulaPiece[];
  /** The environment whose rows the pieces are, or null for a formula that is not split at an environment. */
  env: string | null;
};

/** Environments whose body is rows of `&`-separated cells. */
const ROW_ENVIRONMENT = /^(?:align|alignat|flalign|xalignat|xxalignat|gather|multline|eqnarray|split|aligned|alignedat|gathered|multlined|cases|dcases|rcases|drcases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|array|darray|subarray)\*?$/;
/** Those whose first group is an argument, not content: `array{cc}`, `alignat{2}`. */
const ENVIRONMENT_ARGUMENT = /^(?:array|darray|subarray|alignat|alignedat|xalignat|xxalignat)\*?$/;
/** Markup between pieces, kept as written, with how many brace groups it takes. */
const KEPT: Record<string, number> = {
  label: 1, tag: 1, "tag*": 1, nonumber: 0, notag: 0, intertext: 1, shortintertext: 1, hline: 0, hdashline: 0, cline: 1, noalign: 1, displaybreak: 0, allowbreak: 0,
};

export function isRowEnvironment(name: string) {
  return ROW_ENVIRONMENT.test(name);
}

/** The end of the brace group at `index` (after spaces), or null. */
function groupEnd(text: string, index: number, end = text.length) {
  while (index < end && /\s/.test(text[index])) index++;
  if (text[index] !== "{") return null;
  let depth = 0;
  for (let i = index; i < end; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return null;
}

/** The end of the `[…]` at `index` (after spaces), or `index` when there is none. */
function optionalEnd(text: string, index: number, end = text.length) {
  let at = index;
  while (at < end && /[ \t]/.test(text[at])) at++;
  if (text[at] !== "[") return index;
  const close = text.indexOf("]", at);
  return close < 0 || close >= end ? index : close + 1;
}

type Segment = { from: number; to: number; row: number; cell: number };

/** Splits `text[start, end)` at its top-level `&` and `\\`, leaving out kept markup and comments. `atomic`: ranges never split. */
function splitRows(text: string, start: number, end: number, atomic: ReadonlyArray<readonly [number, number]>): Segment[] {
  const segments: Segment[] = [];
  let row = 0;
  let cell = 0;
  let segmentStart = start;
  let depth = 0;
  const cut = (to: number) => { segments.push({ from: segmentStart, to, row, cell }); };
  for (let i = start; i < end;) {
    const skip = atomic.find(([from, to]) => from === i && to > i);
    if (skip) { i = Math.min(end, skip[1]); continue; }
    const char = text[i];
    if (char === "%") {
      const newline = text.indexOf("\n", i);
      const after = newline < 0 || newline >= end ? end : newline + 1;
      if (depth === 0) { cut(i); segmentStart = after; }
      i = after;
      continue;
    }
    if (char === "\\") {
      const word = /^\\(?:[A-Za-z@]+\*?|.)/.exec(text.slice(i, i + 40))?.[0] ?? "\\";
      if (word === "\\\\" && depth === 0) {
        cut(i);
        let after = i + 2;
        if (text[after] === "*") after++;
        after = optionalEnd(text, after, end);
        row++;
        cell = 0;
        segmentStart = after;
        i = after;
        continue;
      }
      const name = word.slice(1);
      const kept = Object.hasOwn(KEPT, name) ? KEPT[name] : undefined;
      if (depth === 0 && kept !== undefined) {
        cut(i);
        let after = i + word.length;
        if (name === "displaybreak") after = optionalEnd(text, after, end);
        for (let n = 0; n < kept; n++) after = groupEnd(text, after, end) ?? after;
        segmentStart = after;
        i = after;
        continue;
      }
      if (name === "begin" || name === "end") {
        const after = groupEnd(text, i + word.length, end);
        depth += name === "begin" ? 1 : -1;
        i = after ?? i + word.length;
        continue;
      }
      i += word.length;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "&" && depth === 0) {
      cut(i);
      cell++;
      segmentStart = i + 1;
    }
    i++;
  }
  cut(end);
  return segments;
}

/** Pieces from segments: the non-blank ones, trimmed, and an empty piece for each empty cell of a row that has cells. */
function piecesOf(text: string, segments: Segment[]): Omit<FormulaPiece, "reason">[] {
  const pieces: Omit<FormulaPiece, "reason">[] = [];
  const byCell = new Map<string, Segment[]>();
  for (const segment of segments) {
    const key = `${segment.row}:${segment.cell}`;
    byCell.set(key, [...(byCell.get(key) ?? []), segment]);
  }
  const cellsInRow = new Map<number, number>();
  for (const segment of segments) cellsInRow.set(segment.row, Math.max(cellsInRow.get(segment.row) ?? 0, segment.cell + 1));
  for (const [key, list] of byCell) {
    const [row, cell] = key.split(":").map(Number);
    let any = false;
    for (const segment of list) {
      const slice = text.slice(segment.from, segment.to);
      if (!slice.trim()) continue;
      any = true;
      const lead = /^\s*/.exec(slice)![0].length;
      const trail = /\s*$/.exec(slice)![0].length;
      pieces.push({ from: segment.from + lead, to: segment.to - trail, row, cell });
    }
    // An empty cell of a row with several (`&= b`'s left side) can be filled; an empty row (after a final `\\`) is not a row.
    if (!any && (cellsInRow.get(row) ?? 0) > 1) {
      const last = list[list.length - 1];
      pieces.push({ from: last.to, to: last.to, row, cell });
    }
  }
  return pieces.sort((a, b) => a.row - b.row || a.cell - b.cell || a.from - b.from);
}

/** The environment that is the whole of `text[start, end)` (kept markup and spaces aside), with its body's range. */
function soleEnvironment(text: string, start: number, end: number, atomic: ReadonlyArray<readonly [number, number]>) {
  const segments = splitRows(text, start, end, atomic).filter((segment) => text.slice(segment.from, segment.to).trim());
  if (segments.length !== 1) return null;
  const slice = text.slice(segments[0].from, segments[0].to);
  const offset = segments[0].from + /^\s*/.exec(slice)![0].length;
  const trimmed = slice.trim();
  const begin = /^\\begin\s*\{([A-Za-z]+\*?)\}/.exec(trimmed);
  if (!begin || !ROW_ENVIRONMENT.test(begin[1])) return null;
  const close = `\\end{${begin[1]}}`;
  if (!trimmed.endsWith(close)) return null;
  let bodyFrom = offset + begin[0].length;
  bodyFrom = optionalEnd(text, bodyFrom);
  if (ENVIRONMENT_ARGUMENT.test(begin[1])) bodyFrom = groupEnd(text, bodyFrom) ?? bodyFrom;
  const bodyTo = offset + trimmed.length - close.length;
  // The `\end` must close this `\begin`, not a nested one of the same name.
  let depth = 0;
  for (const match of text.slice(bodyFrom, bodyTo).matchAll(/\\(begin|end)\s*\{[^}]*\}/g)) {
    depth += match[1] === "begin" ? 1 : -1;
    if (depth < 0) return null;
  }
  return depth === 0 && bodyFrom <= bodyTo ? { name: begin[1], from: bodyFrom, to: bodyTo } : null;
}

/**
 * How a formula's content (inside its delimiters, or its environment's body) splits into pieces. `env` is
 * the formula's own environment (`align`), or null for `$…$`, `\[…\]` and `equation`-like ones. `atomic`:
 * ranges (opaque macro uses) never split.
 */
export function formulaLayout(content: string, env: string | null, atomic: ReadonlyArray<readonly [number, number]> = []): FormulaLayout {
  let start = 0;
  let end = content.length;
  let name = env && ROW_ENVIRONMENT.test(env) ? env : null;
  if (!name) {
    for (let guard = 0, sole = soleEnvironment(content, start, end, atomic); sole && guard < 4; guard++, sole = soleEnvironment(content, start, end, atomic)) {
      ({ from: start, to: end, name } = sole);
    }
  }
  const pieces = piecesOf(content, splitRows(content, start, end, atomic));
  if (!pieces.length) pieces.push({ from: start + /^\s*/.exec(content.slice(start, end))![0].length, to: start + /^\s*/.exec(content.slice(start, end))![0].length, row: 0, cell: 0 });
  return { env: name, pieces: pieces.map((piece) => ({ ...piece, reason: pieceReason(content.slice(piece.from, piece.to)) })) };
}

/** Why a piece cannot go to MathLive as it is (it opens as source), or null. */
export function pieceReason(text: string): string | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "%") return "has a comment";
    if (text[i] === "#") return "has a macro parameter";
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth < 0) return "has an unbalanced brace";
  }
  if (depth !== 0) return "has an unbalanced brace";
  const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;
  if (count(/\\left(?![A-Za-z@])/g) !== count(/\\right(?![A-Za-z@])/g)) return "has a \\left without its \\right";
  if (count(/\\begin(?![A-Za-z@])/g) !== count(/\\end(?![A-Za-z@])/g)) return "has an unclosed environment";
  if (/\\(?:verb|label|tag)(?![A-Za-z@])/.test(text)) return "has markup inside a group";
  // xy-pic and tikz-cd diagrams (math-diagram.ts draws them) are not a formula MathLive reads: a click shows their source.
  if (/\\(?:xymatrix|arrow|ar)(?![A-Za-z@])/.test(text)) return "is a commutative diagram";
  return null;
}

/** Whether a piece's new text can be written without breaking the formula around it. */
export function writablePiece(text: string) {
  return pieceReason(text) === null && !/(^|[^\\])(?:\\\\)*\$/.test(text) && !/(^|[^\\])(?:\\\\)*\\[\])]/.test(text);
}

/* ---- Macros ------------------------------------------------------------------------------------------- */

export type MacroLookup = (name: string) => LatexMacro | null;
/** A use of a macro MathLive cannot read: written back as it is (`\dv[2]{f}{x}`, `\qty(a+b)`). */
export type OpaqueUse = { from: number; to: number; name: string };

/** physics' commands that read a delimited group after them (math-render.ts draws them). */
const DELIMITED = /\\physics@/;
const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "|": "|", "{": "}" };

/** Whether MathLive cannot read a macro's uses: an optional argument, an xparse spec, an unrenderable or delimited body, or such a macro in its body. */
function opaqueMacro(lookup: MacroLookup, name: string, seen = new Set<string>()): boolean {
  const macro = lookup(name);
  if (!macro) return false;
  if (macro.optional !== undefined || macro.spec || macro.unsupported || macro.alias || DELIMITED.test(macro.body)) return true;
  if (seen.has(name) || seen.size > 50) return false;
  seen.add(name);
  for (const match of macro.body.matchAll(/\\([A-Za-z@]+)/g)) if (opaqueMacro(lookup, match[1], seen)) return true;
  return false;
}

/**
 * The document macros a formula uses: the uses MathLive gets as opaque atoms, with their extent, and the
 * other macros (with those their bodies use), which MathLive gets as its own macros, written back by name.
 * `incomplete`: uses whose arguments are missing.
 */
export function formulaMacros(content: string, lookup: MacroLookup) {
  const opaque: OpaqueUse[] = [];
  const incomplete: number[] = [];
  const plain = new Map<string, LatexMacro>();
  const memo = new Map<string, boolean>();
  const isOpaque = (name: string) => {
    if (!memo.has(name)) memo.set(name, opaqueMacro(lookup, name));
    return memo.get(name)!;
  };
  const addPlain = (name: string) => {
    const queue = [name];
    for (let read = 0; read < queue.length && read < 200; read++) {
      const macro = lookup(queue[read]);
      if (!macro || plain.has(queue[read])) continue;
      plain.set(queue[read], macro);
      for (const match of macro.body.matchAll(/\\([A-Za-z@]+)/g)) queue.push(match[1]);
    }
  };
  for (let i = 0; i < content.length;) {
    if (content[i] === "%") { const newline = content.indexOf("\n", i); i = newline < 0 ? content.length : newline + 1; continue; }
    if (content[i] !== "\\") { i++; continue; }
    const word = /^\\(?:[A-Za-z@]+|.)/.exec(content.slice(i, i + 64))?.[0] ?? "\\";
    const name = word.slice(1);
    const macro = /^[A-Za-z@]+$/.test(name) ? lookup(name) : null;
    if (!macro) { i += word.length; continue; }
    if (!isOpaque(name)) { addPlain(name); i += word.length; continue; }
    const args = macro.alias ? { end: i + word.length } : readMacroArguments(content, i + word.length, macro);
    if (!args) { incomplete.push(i); i += word.length; continue; }
    let end = args.end;
    if (DELIMITED.test(macro.body)) {
      let at = end;
      const size = /^\s*\\(?:big|Big|bigg|Bigg)(?![A-Za-z@])\s*/.exec(content.slice(at, at + 20));
      if (size) at += size[0].length;
      while (/\s/.test(content[at] ?? "")) at++;
      const close = CLOSERS[content[at]];
      if (close) {
        let depth = 0;
        for (let k = at + 1; k < content.length; k++) {
          if (content[k] === "\\") { k++; continue; }
          if (content[k] === close && depth === 0) { end = k + 1; break; }
          if (content[k] === "{") depth++;
          else if (content[k] === "}") depth--;
          else if (close !== "|" && content[k] === content[at]) depth++;
          else if (close !== "|" && content[k] === close) depth--;
        }
      }
    }
    opaque.push({ from: i, to: end, name });
    i = end;
  }
  return { opaque, incomplete, plain };
}

const ATOM = "LiberaAtom";

function atomName(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return ATOM + name;
}

/**
 * A piece as MathLive gets it: each opaque use inside it replaced by an atom (`\LiberaAtomA`), which MathLive
 * draws as `render` says and writes back by that name. Null when a use crosses the piece's edge.
 */
export function pieceForMathLive(content: string, piece: Pick<FormulaPiece, "from" | "to">, uses: OpaqueUse[], render: (source: string) => string) {
  let value = "";
  let at = piece.from;
  const atoms: Record<string, { source: string; def: string }> = {};
  let count = 0;
  for (const use of uses) {
    if (use.to <= piece.from || use.from >= piece.to) continue;
    if (use.from < piece.from || use.to > piece.to) return null;
    const name = atomName(count++);
    const source = content.slice(use.from, use.to);
    atoms[name] = { source, def: render(source) };
    value += content.slice(at, use.from) + `\\${name}` + (/^[A-Za-z@]/.test(content.slice(use.to, use.to + 1)) ? " " : "");
    at = use.to;
  }
  value += content.slice(at, piece.to);
  return { value, atoms };
}

/** MathLive's text for a piece, as it is written back: atoms as the uses they stand for, `\bm` as `\boldsymbol` unless the piece used `\bm`. */
export function pieceFromMathLive(edited: string, atoms: Record<string, { source: string }>, original: string) {
  let text = edited.replace(new RegExp(`\\\\(${ATOM}[A-Z]+)(?![A-Za-z@])( ?)`, "g"), (match, name: string, space: string) => {
    const atom = atoms[name];
    if (!atom) return match;
    // A use that ends with a control word (`\alias`) keeps the space before a letter.
    return atom.source + (/\\[A-Za-z@]+$/.test(atom.source) ? space : "");
  });
  if (!/\\bm(?![A-Za-z@])/.test(original)) text = text.replace(/\\bm(?![A-Za-z@])/g, "\\boldsymbol");
  return text;
}

/** Whether two spellings typeset the same (MathLive's reading of a piece, against the piece). */
export function sameFormula(a: string, b: string) {
  const x = canonicalTokens(a);
  const y = canonicalTokens(b);
  return x.length === y.length && x.every((token, index) => token.text === y[index].text);
}

/** The change a source edit makes: the characters between the common start and end, exactly as typed. */
export function sourceChanges(original: string, edited: string, offset = 0): TexChange[] {
  if (original === edited) return [];
  let start = 0;
  while (start < original.length && start < edited.length && original[start] === edited[start]) start++;
  let end = 0;
  while (end < original.length - start && end < edited.length - start && original[original.length - 1 - end] === edited[edited.length - 1 - end]) end++;
  return [{ from: offset + start, to: offset + original.length - end, insert: edited.slice(start, edited.length - end) }];
}

/**
 * The piece to open for a click on row `row`, column `column` of the drawn formula (KaTeX's columns: eqnarray's
 * `a &=& b` is drawn as two). The cell's first piece, else the nearest one in the row, else the nearest row's.
 */
export function pieceIndexAt(layout: FormulaLayout, row: number, column: number) {
  const cell = layout.env && /^eqnarray\*?$/.test(layout.env) && column >= 1 ? 2 : column;
  let best = 0;
  let score = Infinity;
  layout.pieces.forEach((piece, index) => {
    const value = Math.abs(piece.row - row) * 1000 + Math.abs(piece.cell - cell);
    if (value < score) { score = value; best = index; }
  });
  return best;
}
