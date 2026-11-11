import { readGroup, readOptional } from "../../../macros/core";
import { stripTexComments } from "../../macros/numbering";

/* Commutative diagrams in a formula, written for KaTeX: xy's `\xymatrix{…}` and tikz-cd's `\begin{tikzcd}…\end{tikzcd}`.
 *
 * KaTeX has neither package, so a diagram is drawn as an `array` whose cells alternate between the diagram's objects
 * and the arrows between them: an arrow from the object at (row, column) lies in the slot next to it in the arrow's
 * direction, as `\xrightarrow[below]{above}` for a horizontal one, a tall `\downarrow` with its labels beside it for
 * a vertical one, and an arrow glyph for a diagonal one.
 *
 * Only a diagram whose every arrow is understood is drawn: the arrow's direction letters (`r l u d`, repeated), its
 * style (plain, dashed, hooked, two-headed, `\mapsto`, double, reversed) and its `^`/`_` (xy) or `"label"` (tikz-cd)
 * labels. Curved, shifted, labelled-in-the-middle or otherwise decorated arrows, xy's cell decorations (`*+[F]{x}`),
 * and arrows to cells outside the grid are not: the diagram stays as written, so the Visual mode shows source and never
 * a different picture. */

type Kind = "plain" | "dashed" | "hook" | "twohead" | "mapsto" | "double" | "equal" | "both";
type Arrow = {
  dx: number; dy: number; kind: Kind; reverse: boolean;
  /** The label on the left-hand side of the arrow's direction (xy's `^`, tikz-cd's `"label"`), and on the right-hand side (`_`, `"label"'`). */
  left: string | null; right: string | null;
};
type Cell = { text: string; arrows: Arrow[] };

const DIRECTIONS = /^[rludRLUD]+$/;

/** xy's arrow styles (`\ar@{-->}`), with the markup of their tips (`^{(}->`) dropped. */
const XY_STYLES: Record<string, { kind: Kind; reverse: boolean }> = {
  "->": { kind: "plain", reverse: false }, "<-": { kind: "plain", reverse: true },
  "-->": { kind: "dashed", reverse: false }, "<--": { kind: "dashed", reverse: true },
  "->>": { kind: "twohead", reverse: false }, ">>": { kind: "twohead", reverse: false }, "<<": { kind: "twohead", reverse: true },
  "(->": { kind: "hook", reverse: false }, "|->": { kind: "mapsto", reverse: false },
  "=>": { kind: "double", reverse: false }, "<=": { kind: "double", reverse: true },
  "=": { kind: "equal", reverse: false }, "<->": { kind: "both", reverse: false },
};

/** tikz-cd's arrow keys. */
const TIKZCD_STYLES: Record<string, { kind: Kind; reverse: boolean }> = {
  hook: { kind: "hook", reverse: false }, "two heads": { kind: "twohead", reverse: false }, dashed: { kind: "dashed", reverse: false },
  "maps to": { kind: "mapsto", reverse: false }, mapsto: { kind: "mapsto", reverse: false }, Rightarrow: { kind: "double", reverse: false },
  Leftarrow: { kind: "double", reverse: true }, rightarrow: { kind: "plain", reverse: false }, leftarrow: { kind: "plain", reverse: true },
  leftrightarrow: { kind: "both", reverse: false },
};

/** What xy and tikz-cd cells hold that KaTeX would draw as something else (decorations, positioning), or not at all. */
const FOREIGN_CELL = /(?:^|[^\^_\\])\*\s*[+\-[{<!=*(]|\*\*|@|"|\\(?:save|restore|POS|drop|xybox|xypolygon|cir|ar|arrow|xymatrix|begin\s*\{tikzcd\})(?![A-Za-z])/;

const skipSpaces = (text: string, at: number) => { while (/\s/.test(text[at] ?? "")) at++; return at; };

/** The top-level pieces of `text` split at `separator` (`&` for cells, `\\` for rows): outside groups and inner environments. */
function splitTop(text: string, separator: "&" | "\\\\"): string[] | null {
  const pieces: string[] = [];
  let depth = 0;
  let environments = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      const name = /^\\([A-Za-z]+)/.exec(text.slice(i, i + 12))?.[1];
      if (text[i + 1] === "\\" && separator === "\\\\" && depth === 0 && environments === 0) {
        // `\\[2ex]` is a row's extra space, which the diagram does not take.
        if (text[skipSpaces(text, i + 2)] === "[") return null;
        pieces.push(text.slice(from, i));
        i += 1;
        from = i + 1;
        continue;
      }
      if (name === "begin" || name === "end") environments += name === "begin" ? 1 : -1;
      i += name ? name.length : 1;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "&" && separator === "&" && depth === 0 && environments === 0) { pieces.push(text.slice(from, i)); from = i + 1; }
  }
  if (depth !== 0 || environments !== 0) return null;
  pieces.push(text.slice(from));
  return pieces;
}

/** One token read as an argument: a group, a control sequence, or a character. */
function readToken(text: string, at: number): { content: string; end: number } | null {
  if (text[at] === "{") return readGroup(text, at);
  const control = /^\\(?:[A-Za-z]+|[^A-Za-z\s])/.exec(text.slice(at, at + 40));
  if (control) return { content: control[0], end: at + control[0].length };
  return /[A-Za-z0-9]/.test(text[at] ?? "") ? { content: text[at], end: at + 1 } : null;
}

function steps(directions: string) {
  const letters = directions.toLowerCase();
  const count = (letter: string) => letters.split(letter).length - 1;
  return { dx: count("r") - count("l"), dy: count("d") - count("u") };
}

/** An xy arrow after `\ar`: its styles `@{…}`, its target `[dr]` and its labels `^{…}` `_{…}`. */
function readXyArrow(text: string, from: number): { arrow: Arrow; end: number } | null {
  let at = skipSpaces(text, from);
  let style = XY_STYLES["->"];
  while (text[at] === "@") {
    const group = text[at + 1] === "{" ? readGroup(text, at + 1) : null;
    if (!group) return null;
    const found = XY_STYLES[group.content.replace(/[\s{}^_]/g, "")];
    if (!found) return null;
    style = found;
    at = skipSpaces(text, group.end);
  }
  const target = readOptional(text, at);
  if (!target || !DIRECTIONS.test(target.content.trim())) return null;
  const { dx, dy } = steps(target.content.trim());
  if (!dx && !dy) return null;
  let left: string | null = null;
  let right: string | null = null;
  at = target.end;
  for (;;) {
    const next = skipSpaces(text, at);
    if (text[next] !== "^" && text[next] !== "_") break;
    const token = readToken(text, skipSpaces(text, next + 1));
    if (!token) return null;
    if (text[next] === "^") { if (left !== null) return null; left = token.content; } else { if (right !== null) return null; right = token.content; }
    at = token.end;
  }
  // A label on the arrow itself (`|{f}`), positioned (`^<<{f}`) or turned (`^(0.3){f}`) is drawn differently.
  if (/^\s*[|<>(]/.test(text.slice(at, at + 4))) return null;
  return { arrow: { dx, dy, ...style, left, right }, end: at };
}

/** A tikz-cd `"label"` option: its text and whether a prime follows (the label on the other side); null for others (`"f"{pos=0.3}`). */
function readQuoted(text: string): { label: string; swap: boolean } | null {
  let depth = 0;
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") { i++; continue; }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === '"' && depth === 0) {
      const rest = text.slice(i + 1).trim();
      if (rest === "") return { label: text.slice(1, i), swap: false };
      return rest === "'" ? { label: text.slice(1, i), swap: true } : null;
    }
  }
  return null;
}

/** The comma-separated options, outside groups and quoted labels. */
function splitOptions(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") { i++; continue; }
    if (char === '"' && depth === 0) quoted = !quoted;
    else if (!quoted && char === "{") depth++;
    else if (!quoted && char === "}") depth--;
    else if (!quoted && depth === 0 && char === ",") { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** A tikz-cd arrow after `\ar` or `\arrow`: `[r, "f", hook]` or the older `{r}{f}`. */
function readTikzArrow(text: string, from: number): { arrow: Arrow; end: number } | null {
  const at = skipSpaces(text, from);
  let options: string[];
  let end: number;
  let older: string | null = null;
  if (text[at] === "[") {
    const group = readOptional(text, at);
    if (!group) return null;
    options = splitOptions(group.content);
    end = group.end;
  } else if (text[at] === "{") {
    const group = readGroup(text, at);
    if (!group) return null;
    options = [group.content.trim()];
    end = group.end;
    const label = readGroup(text, end);
    if (label) { older = label.content; end = label.end; }
  } else return null;
  let dx = 0;
  let dy = 0;
  let directed = false;
  let style: { kind: Kind; reverse: boolean } = { kind: "plain", reverse: false };
  let swap = false;
  const labels: Array<{ label: string; swap: boolean }> = older !== null ? [{ label: older, swap: false }] : [];
  for (const option of options) {
    if (DIRECTIONS.test(option)) {
      if (directed) return null;
      ({ dx, dy } = steps(option));
      directed = true;
    } else if (option.startsWith('"')) {
      const label = readQuoted(option);
      if (!label) return null;
      labels.push(label);
    } else if (option === "swap") swap = true;
    else if (TIKZCD_STYLES[option]) style = TIKZCD_STYLES[option];
    else return null;
  }
  if (!directed || (!dx && !dy)) return null;
  let left: string | null = null;
  let right: string | null = null;
  for (const label of labels) {
    if (label.swap !== swap) { if (right !== null) return null; right = label.label; } else { if (left !== null) return null; left = label.label; }
  }
  return { arrow: { dx, dy, ...style, left, right }, end };
}

/** A cell's text without its arrows, and the arrows. */
function readCell(cell: string, flavor: "xy" | "tikzcd"): Cell | null {
  let text = "";
  const arrows: Arrow[] = [];
  for (let i = 0; i < cell.length; i++) {
    if (cell[i] !== "\\") { text += cell[i]; continue; }
    const name = /^\\([A-Za-z]+)/.exec(cell.slice(i, i + 12))?.[1];
    if (name && (name === "ar" || (flavor === "tikzcd" && name === "arrow"))) {
      const read = flavor === "xy" ? readXyArrow(cell, i + 1 + name.length) : readTikzArrow(cell, i + 1 + name.length);
      if (!read) return null;
      arrows.push(read.arrow);
      i = read.end - 1;
      continue;
    }
    const length = name ? name.length + 1 : 2;
    text += cell.slice(i, i + length);
    i += length - 1;
  }
  text = text.trim();
  return FOREIGN_CELL.test(text) ? null : { text, arrows };
}

const HORIZONTAL: Record<Kind, [string, string | null] | null> = {
  plain: ["\\xrightarrow", "\\xleftarrow"], hook: ["\\xhookrightarrow", "\\xhookleftarrow"], twohead: ["\\xtwoheadrightarrow", "\\xtwoheadleftarrow"],
  mapsto: ["\\xmapsto", null], double: ["\\xRightarrow", "\\xLeftarrow"], equal: ["\\xlongequal", "\\xlongequal"],
  both: ["\\xleftrightarrow", "\\xleftrightarrow"], dashed: null,
};
const VERTICAL: Partial<Record<Kind, [string, string]>> = {
  plain: ["\\downarrow", "\\uparrow"], double: ["\\Downarrow", "\\Uparrow"], both: ["\\updownarrow", "\\updownarrow"],
};
const DIAGONAL: Record<string, [string, string]> = { "1,1": ["\\searrow", "\\nwarrow"], "-1,1": ["\\swarrow", "\\nearrow"], "1,-1": ["\\nearrow", "\\swarrow"], "-1,-1": ["\\nwarrow", "\\searrow"] };

/** An arrow as KaTeX draws it in its slot, or null when KaTeX has no such arrow. */
function glyph(arrow: Arrow): string | null {
  const { dx, dy, kind, reverse } = arrow;
  // The label on the page's upper side (a horizontal or diagonal arrow) and on its right side (a vertical one): the left-hand side of the direction is above going right, and on the page's right going down.
  const above = dx > 0 ? arrow.left : arrow.right;
  const below = dx > 0 ? arrow.right : arrow.left;
  if (dy === 0) {
    const forward = (dx > 0) !== reverse;
    const pair = HORIZONTAL[kind];
    const extra = (Math.abs(dx) - 1) * 1.5;
    const pad = (label: string | null) => (extra > 0 ? `\\hspace{${extra}em}${label ?? ""}\\hspace{${extra}em}` : label ?? "");
    if (kind === "dashed") {
      const base = forward ? "\\dashrightarrow" : "\\dashleftarrow";
      const over = above || extra > 0 ? `\\overset{${pad(above)}}{${base}}` : base;
      return below ? `\\underset{${below}}{${over}}` : over;
    }
    const command = pair?.[forward ? 0 : 1];
    if (!command) return null;
    return `${command}${below ? `[${pad(below)}]` : extra > 0 ? `[${pad(null)}]` : ""}{${pad(above)}}`;
  }
  if (dx === 0) {
    const pair = VERTICAL[kind];
    if (!pair) return null;
    const forward = (dy > 0) !== reverse;
    const rightLabel = dy > 0 ? arrow.left : arrow.right;
    const leftLabel = dy > 0 ? arrow.right : arrow.left;
    const size = Math.abs(dy) > 1 ? "\\Bigg" : "\\Big";
    return `${leftLabel ? `\\mathllap{\\scriptstyle ${leftLabel}\\,}` : ""}${size}${pair[forward ? 0 : 1]}${rightLabel ? `\\mathrlap{\\,\\scriptstyle ${rightLabel}}` : ""}`;
  }
  if (kind !== "plain") return null;
  const pair = DIAGONAL[`${Math.sign(dx)},${Math.sign(dy)}`];
  const base = pair[reverse ? 1 : 0];
  const over = above ? `\\overset{${above}}{${base}}` : base;
  return below ? `\\underset{${below}}{${over}}` : over;
}

/** The grid of a diagram's source as KaTeX's `array`, or null when something in it is not understood. */
function gridForKatex(body: string, flavor: "xy" | "tikzcd"): string | null {
  const source = stripTexComments(body);
  const rowTexts = splitTop(source, "\\\\");
  if (!rowTexts) return null;
  while (rowTexts.length > 1 && !rowTexts[rowTexts.length - 1].trim()) rowTexts.pop();
  const rows: Cell[][] = [];
  for (const rowText of rowTexts) {
    const cellTexts = splitTop(rowText, "&");
    if (!cellTexts) return null;
    const cells: Cell[] = [];
    for (const cellText of cellTexts) {
      const cell = readCell(cellText, flavor);
      if (!cell) return null;
      cells.push(cell);
    }
    rows.push(cells);
  }
  const height = rows.length;
  const width = Math.max(...rows.map((row) => row.length));
  const at = (row: number, column: number) => rows[row]?.[column];
  const output: string[][] = Array.from({ length: 2 * height - 1 }, () => Array.from({ length: 2 * width - 1 }, () => ""));
  const taken = new Set<string>();
  const take = (row: number, column: number) => { const key = `${row},${column}`; if (taken.has(key)) return false; taken.add(key); return true; };
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) output[2 * r][2 * c] = at(r, c)?.text ?? "";
  }
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      for (const arrow of at(r, c)?.arrows ?? []) {
        const toRow = r + arrow.dy;
        const toColumn = c + arrow.dx;
        if (toRow < 0 || toRow >= height || toColumn < 0 || toColumn >= width) return null;
        const stepRow = Math.sign(arrow.dy);
        const stepColumn = Math.sign(arrow.dx);
        // A straight arrow crossing cells needs them empty; its slots are all its own.
        const straight = arrow.dx === 0 || arrow.dy === 0;
        const length = straight ? Math.abs(arrow.dx) + Math.abs(arrow.dy) : 1;
        for (let k = 1; k <= 2 * length - 1; k++) {
          if (!take(2 * r + k * stepRow, 2 * c + k * stepColumn)) return null;
          if (k % 2 === 0) { const crossed = at(r + (k / 2) * stepRow, c + (k / 2) * stepColumn); if (crossed && (crossed.text || crossed.arrows.length)) return null; }
        }
        const drawn = glyph(arrow);
        if (drawn === null) return null;
        output[2 * r + stepRow][2 * c + stepColumn] = drawn;
      }
    }
  }
  return `\\begin{array}{${"c".repeat(2 * width - 1)}} ${output.map((row) => row.join(" & ")).join(" \\\\ ")} \\end{array}`;
}

/** xy's spacing modifiers after `\xymatrix`: `@C+1pc`, `@R=2em`, `@!`, `@1`. */
const XY_MODIFIER = /@[!CRMLU=+\-]*\s*[\d.]*\s*(?:pc|pt|em|ex|cm|mm|in|bp)?/y;

/** tikz-cd's options that only set spacing (`row sep=large`), or `ampersand replacement`. */
function tikzcdOptions(content: string): { ampersand: string | null } | null {
  let ampersand: string | null = null;
  for (const option of splitOptions(content)) {
    const named = /^(row sep|column sep|sep|ampersand replacement|cramped|nodes in empty cells)\s*(?:=\s*(.*))?$/.exec(option);
    if (!named) return null;
    if (named[1] === "ampersand replacement") ampersand = named[2]?.trim() || null;
  }
  return { ampersand };
}

/** Diagrams in `latex` as arrays; one that is not understood is left as written (and KaTeX then rejects it: source). */
export function diagramsForKatex(latex: string): string {
  let out = latex;
  if (out.includes("\\xymatrix")) {
    const pattern = /\\xymatrix(?![A-Za-z])/g;
    let result = "";
    let from = 0;
    for (let match: RegExpExecArray | null; (match = pattern.exec(out));) {
      let at = match.index + match[0].length;
      for (;;) {
        XY_MODIFIER.lastIndex = skipSpaces(out, at);
        const modifier = out[XY_MODIFIER.lastIndex] === "@" ? XY_MODIFIER.exec(out) : null;
        if (!modifier) break;
        at = XY_MODIFIER.lastIndex;
      }
      const group = readGroup(out, skipSpaces(out, at));
      const grid = group ? gridForKatex(group.content, "xy") : null;
      if (!group || !grid) continue;
      result += out.slice(from, match.index) + grid;
      from = pattern.lastIndex = group.end;
    }
    out = result + out.slice(from);
  }
  if (out.includes("{tikzcd}")) {
    const pattern = /\\begin\s*\{tikzcd\}/g;
    let result = "";
    let from = 0;
    for (let match: RegExpExecArray | null; (match = pattern.exec(out));) {
      const end = out.indexOf("\\end{tikzcd}", pattern.lastIndex);
      if (end < 0) continue;
      let body = out.slice(pattern.lastIndex, end);
      let ampersand: string | null = null;
      const optionsAt = skipSpaces(body, 0);
      if (body[optionsAt] === "[") {
        const group = readOptional(body, optionsAt);
        const options = group ? tikzcdOptions(group.content) : null;
        if (!group || !options) continue;
        ampersand = options.ampersand;
        body = body.slice(group.end);
      }
      if (ampersand) body = body.split(ampersand).join("&");
      const grid = gridForKatex(body, "tikzcd");
      if (!grid) continue;
      result += out.slice(from, match.index) + grid;
      from = pattern.lastIndex = end + "\\end{tikzcd}".length;
    }
    out = result + out.slice(from);
  }
  return out;
}
