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

type Kind = "plain" | "dashed" | "hook" | "twohead" | "mapsto" | "double" | "equal" | "both" | "squiggly" | "tail";
type Arrow = {
  dx: number; dy: number; kind: Kind; reverse: boolean;
  /** The label on the left-hand side of the arrow's direction (xy's `^`, tikz-cd's `"label"`), and on the right-hand side (`_`, `"label"'`). */
  left: string | null; right: string | null;
  /** xy's `@<1ex>`: the sign of the shift to the left (+) or the right (-) of the direction; 0 when the arrow is not shifted. */
  shift: number;
  /** xy's `@{}` with its label in the middle (`|-{\perp}`): nothing is drawn but the label. */
  middle: string | null;
  /** tikz-cd's `draw=none` arrow carrying a corner (`\lrcorner`): the corner as drawn, a pullback or pushout mark. */
  mark: string | null;
  /** tikz-cd's `from=2-1, to=1-2`: the (row, column), counted from 0, the arrow starts at, whatever cell it is written in. */
  from: [number, number] | null;
};
const PLAIN = { shift: 0, middle: null, mark: null, from: null };
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
  leftrightarrow: { kind: "both", reverse: false }, squiggly: { kind: "squiggly", reverse: false }, tail: { kind: "tail", reverse: false },
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
  let shift = 0;
  let invisible = false;
  while (text[at] === "@") {
    if (text[at + 1] === "<") {
      // `@<1.1ex>`: the arrow runs beside its line; two opposite ones make an adjunction.
      const close = text.indexOf(">", at);
      const amount = close < 0 ? null : /^\s*(-?\s*[\d.]+)\s*(?:pt|em|ex|pc|mm|cm)?\s*$/.exec(text.slice(at + 2, close));
      if (!amount || shift !== 0) return null;
      shift = Math.sign(parseFloat(amount[1].replace(/\s/g, "")));
      if (!shift) return null;
      at = skipSpaces(text, close + 1);
      continue;
    }
    const group = text[at + 1] === "{" ? readGroup(text, at + 1) : null;
    if (!group) return null;
    if (group.content.trim() === "") invisible = true;
    else {
      const found = XY_STYLES[group.content.replace(/[\s{}^_]/g, "")];
      if (!found) return null;
      style = found;
    }
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
    // `^-{f}` (2611.08002): the same side; the `-` only says the label sits tight against the arrow.
    const token = readToken(text, skipSpaces(text, text[next + 1] === "-" ? next + 2 : next + 1));
    if (!token) return null;
    if (text[next] === "^") { if (left !== null) return null; left = token.content; } else { if (right !== null) return null; right = token.content; }
    at = token.end;
  }
  // `|-{\perp}`: the label of an invisible arrow, in the middle of its slot.
  let middle: string | null = null;
  const bar = skipSpaces(text, at);
  if (text[bar] === "|") {
    const token = readToken(text, skipSpaces(text, text[bar + 1] === "-" ? bar + 2 : bar + 1));
    if (!token) return null;
    middle = token.content;
    at = token.end;
  }
  // A label on the arrow itself of a visible arrow, positioned (`^<<{f}`) or turned (`^(0.3){f}`) is drawn differently.
  if (/^\s*[|<>(]/.test(text.slice(at, at + 4))) return null;
  if (invisible !== (middle !== null) || (invisible && (left !== null || right !== null || shift !== 0 || dx * dy !== 0))) return null;
  return { arrow: { dx, dy, ...style, left, right, ...PLAIN, shift, middle }, end: at };
}

/** A tikz-cd `"label"` option: its text, whether a prime follows (the label on the other side) and the label's own options
 * (`"f"'{description}`); null for what does not read. */
function readQuoted(text: string): { label: string; swap: boolean; options: string[] } | null {
  let depth = 0;
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") { i++; continue; }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === '"' && depth === 0) {
      let rest = text.slice(i + 1).trim();
      const swap = rest.startsWith("'");
      if (swap) rest = rest.slice(1).trim();
      if (rest === "") return { label: text.slice(1, i), swap, options: [] };
      const group = rest[0] === "{" ? readGroup(rest, 0) : null;
      return group && group.end === rest.length ? { label: text.slice(1, i), swap, options: splitOptions(group.content) } : null;
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
    // The older `\arrow[hook]{r}{f}`: options, then the direction and the label in groups (2611.09610).
    const next = skipSpaces(text, end);
    const direction = text[next] === "{" ? readGroup(text, next) : null;
    if (direction && DIRECTIONS.test(direction.content.trim())) {
      options.push(direction.content.trim());
      end = direction.end;
      const label = readGroup(text, skipSpaces(text, end));
      if (label) { older = label.content; end = label.end; }
    }
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
  let origin: [number, number] | null = null;
  let to: [number, number] | null = null;
  let style: { kind: Kind; reverse: boolean } | null = null;
  let swap = false;
  let invisible = false;
  let corner: number | null = null;
  const labels: Array<{ label: string; swap: boolean }> = older !== null ? [{ label: older, swap: false }] : [];
  for (const option of options) {
    const ref = /^(from|to)\s*=\s*(\d+)\s*-\s*(\d+)$/.exec(option);
    if (DIRECTIONS.test(option)) {
      if (directed) return null;
      ({ dx, dy } = steps(option));
      directed = true;
    } else if (ref) {
      // `from=2-1, to=1-2`: rows and columns counted from 1. (`from=0` names another arrow, a 2-cell: not drawn.)
      const cell: [number, number] = [Number(ref[2]) - 1, Number(ref[3]) - 1];
      if (cell[0] < 0 || cell[1] < 0) return null;
      if (ref[1] === "from") { if (origin) return null; origin = cell; } else { if (to) return null; to = cell; }
    } else if (option.startsWith('"')) {
      const label = readQuoted(option);
      if (!label) return null;
      let turned = false;
      let rotate = 0;
      for (const extra of label.options) {
        const pair = /^([a-z ]+?)\s*=\s*(.*)$/.exec(extra);
        // `description`, `anchor=center`: the label on the arrow, drawn beside it. `name`, `inner sep`: for 2-cells, which are not drawn.
        // `sloped` turns the label along its arrow (2611.13239's `"\sim"'{sloped}`): drawn upright, which a horizontal arrow's label is anyway.
        if (extra === "description" || extra === "anchor=center" || extra === "sloped" || pair?.[1] === "name" || pair?.[1] === "inner sep") continue;
        if (pair?.[1] === "pos" && /^[01]?\.?\d*$/.test(pair[2].trim())) { turned = true; continue; }
        if (pair?.[1] === "rotate" && /^-?\d+$/.test(pair[2].trim())) { rotate = Number(pair[2].trim()); turned = true; continue; }
        return null;
      }
      const base = CORNERS[label.label.trim()];
      // A positioned or turned label is only understood as a corner mark.
      if (turned && base === undefined) return null;
      if (base !== undefined) {
        corner = (((base + rotate) % 360) + 360) % 360;
        if (corner % 90 !== 0) return null;
      } else if (label.label.trim() !== "") labels.push(label);
    } else if (option === "swap") swap = true;
    else if (option === "draw=none") invisible = true;
    // How far an arrow stops short of its objects is no matter.
    else if (/^shorten\s*[<>]=\s*-?[\d.]+\s*(?:pt|mm|cm|em|ex)?$/.test(option)) continue;
    else if (TIKZCD_STYLES[option]) { if (style) return null; style = TIKZCD_STYLES[option]; }
    else return null;
  }
  if (origin || to) {
    if (!origin || !to || directed) return null;
    dx = to[1] - origin[1];
    dy = to[0] - origin[0];
  } else if (!directed) return null;
  if (!dx && !dy) return null;
  let left: string | null = null;
  let right: string | null = null;
  for (const label of labels) {
    if (label.swap !== swap) { if (right !== null) return null; right = label.label; } else { if (left !== null) return null; left = label.label; }
  }
  let mark: string | null = null;
  if (invisible) {
    // An invisible arrow is only the corner mark of a square (a pullback or pushout), drawn in the middle of its square.
    if (corner === null || left !== null || right !== null || style || Math.abs(dx) !== 1 || Math.abs(dy) !== 1) return null;
    mark = CORNER_COMMAND[corner];
  } else if (corner !== null) return null;
  return { arrow: { dx, dy, ...(style ?? { kind: "plain", reverse: false }), left, right, ...PLAIN, mark, from: origin }, end };
}

/** tikz-cd's corner marks (quiver draws a pullback as `\lrcorner`, turned by `rotate=`), by their angle counted counterclockwise from `\lrcorner`. */
const CORNERS: Record<string, number> = { "\\lrcorner": 0, "\\urcorner": 90, "\\ulcorner": 180, "\\llcorner": 270 };
const CORNER_COMMAND: Record<number, string> = { 0: "\\lrcorner", 90: "\\urcorner", 180: "\\ulcorner", 270: "\\llcorner" };

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
  both: ["\\xleftrightarrow", "\\xleftrightarrow"], dashed: null, squiggly: null, tail: null,
};
/** Arrows KaTeX has as plain glyphs (not stretchy): their labels are stacked over and under them. */
const GLYPHS: Partial<Record<Kind, [string, string | null]>> = {
  dashed: ["\\dashrightarrow", "\\dashleftarrow"], squiggly: ["\\rightsquigarrow", null], tail: ["\\rightarrowtail", "\\leftarrowtail"],
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
    if (GLYPHS[kind]) {
      const base = GLYPHS[kind]![forward ? 0 : 1];
      if (!base) return null;
      const over = above || extra > 0 ? `\\overset{${pad(above)}}{${base}}` : base;
      return below ? `\\underset{${below}}{${over}}` : over;
    }
    const command = pair?.[forward ? 0 : 1];
    if (!command) return null;
    return `${command}${below ? `[${pad(below)}]` : extra > 0 ? `[${pad(null)}]` : ""}{${pad(above)}}`;
  }
  if (dx === 0) {
    const forward = (dy > 0) !== reverse;
    const rightLabel = dy > 0 ? arrow.left : arrow.right;
    const leftLabel = dy > 0 ? arrow.right : arrow.left;
    const size = Math.abs(dy) > 1 ? "\\Bigg" : "\\Big";
    // KaTeX has no dashed, wavy, hooked or two-headed vertical arrow: those stay source rather than turn into a plain one.
    const pair = VERTICAL[kind];
    if (!pair) return null;
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
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) output[2 * r][2 * c] = at(r, c)?.text ?? "";
  }
  // Every arrow with the cell it starts at (tikz-cd's `from=` arrow may be written in any cell).
  const placed: Array<{ r: number; c: number; arrow: Arrow }> = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      for (const arrow of at(r, c)?.arrows ?? []) placed.push(arrow.from ? { r: arrow.from[0], c: arrow.from[1], arrow } : { r, c, arrow });
    }
  }
  const starts = new Set(placed.map(({ r, c }) => `${r},${c}`));
  /** The arrows in each slot of the grid; `null` for the slots a long arrow runs through. */
  const slots = new Map<string, Arrow[] | null>();
  const sharable = (arrow: Arrow) => arrow.shift !== 0 || arrow.middle !== null;
  for (const { r, c, arrow } of placed) {
    const toRow = r + arrow.dy;
    const toColumn = c + arrow.dx;
    if (r >= height || c >= width || toRow < 0 || toRow >= height || toColumn < 0 || toColumn >= width) return null;
    const stepRow = Math.sign(arrow.dy);
    const stepColumn = Math.sign(arrow.dx);
    // A straight arrow crossing cells needs them empty; its slots are all its own. A diagonal one is drawn in the slot next to its
    // start, which is where a `from=, to=` arrow ends only when it runs to the next cell over (xy's `[dll]` has always been drawn there).
    const straight = arrow.dx === 0 || arrow.dy === 0;
    if (!straight && arrow.from && (Math.abs(arrow.dx) !== 1 || Math.abs(arrow.dy) !== 1)) return null;
    const length = straight ? Math.abs(arrow.dx) + Math.abs(arrow.dy) : 1;
    if (length > 1 && sharable(arrow)) return null;
    for (let k = 1; k <= 2 * length - 1; k++) {
      const key = `${2 * r + k * stepRow},${2 * c + k * stepColumn}`;
      const held = slots.get(key);
      if (length === 1 && sharable(arrow) && held && held.every(sharable)) held.push(arrow);
      else if (held !== undefined) return null;
      else slots.set(key, k === 1 ? [arrow] : null);
      if (k % 2 === 0) {
        const row = r + (k / 2) * stepRow;
        const column = c + (k / 2) * stepColumn;
        if (!/^(?:\{\s*\})?$/.test(at(row, column)?.text ?? "") || starts.has(`${row},${column}`)) return null;
      }
    }
  }
  for (const [key, arrows] of slots) {
    if (!arrows) continue;
    const drawn = slotGlyph(arrows);
    if (drawn === null) return null;
    const [row, column] = key.split(",").map(Number);
    output[row][column] = drawn;
  }
  return `\\begin{array}{${"c".repeat(2 * width - 1)}} ${output.map((row) => row.join(" & ")).join(" \\\\ ")} \\end{array}`;
}

/** What one slot of the grid shows: an arrow, a corner mark, or an adjunction (two opposite arrows with the symbol between them). */
function slotGlyph(arrows: Arrow[]): string | null {
  // A shifted arrow on its own is not drawn: only an opposite pair has its sides.
  if (arrows.length === 1 && arrows[0].middle === null) return arrows[0].shift !== 0 ? null : arrows[0].mark ?? glyph(arrows[0]);
  const symbols = arrows.filter((arrow) => arrow.middle !== null);
  const real = arrows.filter((arrow) => arrow.middle === null);
  if (symbols.length > 1 || real.length > 2) return null;
  const symbol = symbols[0]?.middle ?? null;
  if (real.length === 0) return symbol;
  if (real.length === 1) return null;
  const [a, b] = real;
  const horizontal = a.dy === 0;
  if ((b.dy === 0) !== horizontal || (symbols[0] && (symbols[0].dy === 0) !== horizontal) || a.shift === 0 || b.shift === 0) return null;
  const glyphs = new Map([a, b].map((arrow) => [arrow, glyph(arrow)]));
  if (glyphs.get(a) === null || glyphs.get(b) === null) return null;
  if (horizontal) {
    // Facing right the left-hand side is up, facing left it is down; each arrow keeps its labels on its outer side, away from the other.
    const up = (arrow: Arrow) => (arrow.dx > 0) === (arrow.shift > 0);
    if (up(a) === up(b)) return null;
    const [top, bottom] = up(a) ? [a, b] : [b, a];
    if ((top.dx > 0 ? top.right : top.left) !== null || (bottom.dx > 0 ? bottom.left : bottom.right) !== null) return null;
    return `\\begin{array}{c} ${glyphs.get(top)} \\\\[-0.5em] ${symbol ?? ""} \\\\[-0.5em] ${glyphs.get(bottom)} \\end{array}`;
  }
  // Vertical: facing down the left-hand side is the page's right, facing up it is the page's left.
  const onRight = (arrow: Arrow) => (arrow.dy > 0) === (arrow.shift > 0);
  if (onRight(a) === onRight(b)) return null;
  const [leftOne, rightOne] = onRight(a) ? [b, a] : [a, b];
  // The label on the inner side of an arrow would run into the other.
  if ((leftOne.dy > 0 ? leftOne.left : leftOne.right) !== null || (rightOne.dy > 0 ? rightOne.right : rightOne.left) !== null) return null;
  return `${glyphs.get(leftOne)}\\,${symbol ?? ""}\\,${glyphs.get(rightOne)}`;
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
