import { definitionExtentAt, macroAt, type LatexDefinitions } from "./definitions";

/* Macros that write a document's structure: `\newcommand{\mysec}[1]{\section{#1}}`,
 * `\newcommand{\step}{\item}`, `\newcommand{\nl}{\\}`, `\newcommand{\beq}{\begin{equation}}`.
 * Numbering and the Visual mode read structure from the parse tree, where such a
 * use is one unknown command: they expand it first (docs/features/latex-visual-editor.md). */

/** Commands whose meaning is structure: what numbering counts and what the Visual mode draws as more than text. */
const STRUCTURE_COMMANDS = /\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|item|label|caption|footnote|endnote|tag|nonumber|notag|begin|end|appendix|setcounter|addtocounter|stepcounter|refstepcounter)(?![A-Za-z@])|\\\\|&/;

const cache = new WeakMap<LatexDefinitions, Set<string>>();

/** Names of the document's macros that write structure, directly or through another such macro. */
export function structureMacroNames(defs: LatexDefinitions): Set<string> {
  let names = cache.get(defs);
  if (names) return names;
  const found = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, list] of defs.macros) {
      if (found.has(name)) continue;
      const writes = list.some((macro) => !macro.alias && (STRUCTURE_COMMANDS.test(macro.body) || [...macro.body.matchAll(/\\([A-Za-z@]+)/g)].some((use) => found.has(use[1]))));
      if (writes) { found.add(name); changed = true; }
    }
  }
  cache.set(defs, names = found);
  return names;
}

/** Whether `text` uses a macro that writes structure. */
export function usesStructureMacro(text: string, defs: LatexDefinitions) {
  const names = structureMacroNames(defs);
  if (!names.size) return false;
  for (const use of text.matchAll(/\\([A-Za-z@]+)/g)) if (names.has(use[1])) return true;
  return false;
}

/** Macros without arguments that are `\item` (`\newcommand{\step}{\item}`): items of the list they are used in. */
const itemCache = new WeakMap<LatexDefinitions, Set<string>>();
export function itemMacroNames(defs: LatexDefinitions): Set<string> {
  let names = itemCache.get(defs);
  if (names) return names;
  names = new Set();
  for (const [name, list] of defs.macros) {
    const macro = list[list.length - 1];
    if (macro && !macro.arity && !macro.alias && /^\s*\\item\s*$/.test(macro.body)) names.add(name);
  }
  itemCache.set(defs, names);
  return names;
}

/** An environment opened by one macro (`\beq` for `\begin{equation}`) and closed by another or by `\end{…}`. */
export type MacroEnvironmentRegion = { from: number; to: number; env: string };

/** Whether `name` opens or closes an environment on its own (`\beq`, `\eeq`): drawn and numbered only with its pair. */
export function isPairMacro(defs: LatexDefinitions, name: string) {
  const { open, close } = pairMacros(defs);
  return open.has(name) || close.has(name);
}

const pairCache = new WeakMap<LatexDefinitions, { open: Map<string, string>; close: Map<string, string> }>();

/** Macros without arguments whose body opens (`\begin{env}…`) or closes (`…\end{env}`) an environment it does not also close or open. */
function pairMacros(defs: LatexDefinitions) {
  const known = pairCache.get(defs);
  if (known) return known;
  const open = new Map<string, string>();
  const close = new Map<string, string>();
  for (const [name, list] of defs.macros) {
    const macro = list[list.length - 1];
    if (!macro || macro.arity || macro.alias) continue;
    const begins = [...macro.body.matchAll(/\\begin\s*\{([^}]+)\}/g)].map((match) => match[1].trim());
    const ends = [...macro.body.matchAll(/\\end\s*\{([^}]+)\}/g)].map((match) => match[1].trim());
    if (begins.length === 1 && !ends.length) open.set(name, begins[0]);
    else if (ends.length === 1 && !begins.length) close.set(name, ends[0]);
  }
  const pairs = { open, close };
  pairCache.set(defs, pairs);
  return pairs;
}

const regionCache = new WeakMap<LatexDefinitions, { text: string; regions: MacroEnvironmentRegion[] }>();

/**
 * The environments a document opens through a macro, from that use to the
 * matching close (another macro, or a literal `\end{env}`). Comments and the
 * definitions themselves are skipped. Empty, at no cost, when the document has
 * no such macros.
 */
export function macroEnvironmentRegions(source: string | (() => string), defs: LatexDefinitions): MacroEnvironmentRegion[] {
  const { open, close } = pairMacros(defs);
  if (!open.size) return [];
  const text = typeof source === "string" ? source : source();
  const cached = regionCache.get(defs);
  if (cached?.text === text) return cached.regions;
  const regions: MacroEnvironmentRegion[] = [];
  // Open regions per environment name, innermost last; a literal \begin of the same name nests inside them.
  const stack: Array<{ from: number; env: string; depth: number }> = [];
  const token = /%[^\n]*|\\begin\s*\{([^}]+)\}|\\end\s*\{([^}]+)\}|\\([A-Za-z@]+)/g;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    if (match[0].startsWith("%")) continue;
    // `\%` is an escaped percent, not a comment.
    if (match.index > 0 && text[match.index - 1] === "\\") continue;
    const extent = definitionExtentAt(defs, match.index);
    if (extent) { token.lastIndex = Math.max(token.lastIndex, extent.to); continue; }
    const top = stack[stack.length - 1];
    if (match[1] !== undefined) { if (top && top.env === match[1].trim()) top.depth++; continue; }
    if (match[2] !== undefined) {
      if (top && top.env === match[2].trim()) {
        if (top.depth > 0) top.depth--;
        else { stack.pop(); regions.push({ from: top.from, to: match.index + match[0].length, env: top.env }); }
      }
      continue;
    }
    const name = match[3];
    const end = match.index + match[0].length;
    if (open.has(name) && macroAt(defs, name, match.index)) stack.push({ from: match.index, env: open.get(name)!, depth: 0 });
    else if (close.has(name) && top && top.env === close.get(name) && macroAt(defs, name, match.index)) {
      if (top.depth > 0) top.depth--;
      else { stack.pop(); regions.push({ from: top.from, to: end, env: top.env }); }
    }
  }
  regions.sort((a, b) => a.from - b.from);
  // Only the outermost regions: an inner one is drawn with its outer one.
  const outer = regions.filter((region, index) => !regions.some((other, at) => at !== index && other.from <= region.from && other.to >= region.to && (other.from !== region.from || other.to !== region.to)));
  regionCache.set(defs, { text, regions: outer });
  return outer;
}

/** Environments whose body is a formula: one opened by a macro pair (`\bea … \eea`) is expanded as math. */
export const MATH_ENVIRONMENT = /^(?:equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math)\*?$/;

/** TeX's conditionals, which each need a `\fi`; `\newif\ifdraft` adds `\ifdraft`. (`\iftoggle`, `\ifthenelse` take arguments and need none.) */
const PRIMITIVE_IFS = new Set(["if", "ifx", "ifnum", "ifdim", "ifodd", "iftrue", "iffalse", "ifcase", "ifdefined", "ifcsname", "ifmmode", "ifvmode", "ifhmode", "ifinner", "ifvoid", "ifhbox", "ifvbox", "ifeof", "iffontchar", "ifincsname", "ifpdf"]);
const disabledCache = new Map<string, { names: string; regions: Array<{ from: number; to: number }> }>();
const discardCache = new WeakMap<LatexDefinitions, ReadonlyMap<string, number>>();

/**
 * The document's macros that throw their arguments away (`\newcommand{\cut}[1]{}`, a way to comment text out):
 * their names and how many arguments they take. Every definition of the name must discard, without an optional argument.
 */
export function discardingMacros(defs: LatexDefinitions): ReadonlyMap<string, number> {
  let names = discardCache.get(defs);
  if (names) return names;
  const found = new Map<string, number>();
  for (const [name, list] of defs.macros) {
    // (`\providecommand` does nothing for a command LaTeX already has: it discards nothing.)
    if (list.length && list.every((macro) => macro.arity >= 1 && macro.optional === undefined && !macro.spec && !macro.unsupported && !macro.alias && !macro.provided && !macro.body.includes("#"))) found.set(name, list[0].arity);
  }
  discardCache.set(defs, names = found);
  return names;
}

/** Where the `count` groups after `at` end (past spaces), skipping escaped braces and comments; -1 when one is missing. */
function groupsEnd(text: string, at: number, count: number) {
  let i = at;
  for (let group = 0; group < count; group++) {
    while (/\s/.test(text[i] ?? "")) i++;
    if (text[i] !== "{") return -1;
    let depth = 0;
    for (; i < text.length; i++) {
      const char = text[i];
      if (char === "\\") { i++; continue; }
      if (char === "%") { const end = text.indexOf("\n", i); if (end < 0) return -1; i = end; continue; }
      if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { i++; break; }
    }
    if (depth !== 0) return -1;
  }
  return i;
}

/**
 * What the document leaves out: `\iffalse … \fi`, from `\iffalse` to its `\fi`
 * or to an `\else` at its level (what follows the `\else` is typeset; nested
 * conditionals count, comments do not), and the uses of macros that discard
 * their arguments (`\cut{…}` with `\newcommand{\cut}[1]{}`), through their
 * arguments. Neither numbered nor drawn.
 */
export function disabledRegions(text: string, discarding: ReadonlyMap<string, number> = new Map()): Array<{ from: number; to: number }> {
  const used = [...discarding.keys()].filter((name) => text.includes(`\\${name}`));
  const comments = text.includes("\\begin{comment}");
  if (!/\\if(?:false|x|num)?(?![A-Za-z@])/.test(text) && !used.length && !comments) return [];
  const names = used.join(",");
  const cached = disabledCache.get(text);
  if (cached && cached.names === names) return cached.regions;
  const regions = [...falseRegions(text), ...discardedRegions(text, used, discarding), ...(comments ? commentRegions(text) : [])].sort((a, b) => a.from - b.from);
  // Only the outermost: a `\cut{…}` inside `\iffalse` is left out with it.
  const outer = regions.filter((region, index) => !regions.some((other, at) => at !== index && other.from <= region.from && other.to >= region.to && (at < index || other.from !== region.from || other.to !== region.to)));
  if (disabledCache.size > 8) disabledCache.clear();
  disabledCache.set(text, { names, regions: outer });
  return outer;
}

/**
 * The comment package's `\begin{comment} … \end{comment}`: text the document leaves out (Monotone Additive Statistics
 * keeps 26 KB of dropped proofs in them), drawn faded and not numbered, as `\iffalse` is.
 */
function commentRegions(text: string) {
  const regions: Array<{ from: number; to: number }> = [];
  const begin = /%[^\n]*|\\begin\s*\{comment\}/g;
  for (let match = begin.exec(text); match; match = begin.exec(text)) {
    if (match[0][0] === "%" || (match.index > 0 && text[match.index - 1] === "\\")) continue;
    const end = text.indexOf("\\end{comment}", match.index + match[0].length);
    if (end < 0) break;
    regions.push({ from: match.index, to: end + "\\end{comment}".length });
    begin.lastIndex = end + "\\end{comment}".length;
  }
  return regions;
}

/** Uses of the discarding macros `names`, through their arguments, outside comments. */
function discardedRegions(text: string, names: string[], discarding: ReadonlyMap<string, number>) {
  const regions: Array<{ from: number; to: number }> = [];
  if (!names.length) return regions;
  // Macro names are letters and `@`: nothing to escape.
  const use = new RegExp(`%[^\\n]*|\\\\(${names.join("|")})(?![A-Za-z@])`, "g");
  for (let match = use.exec(text); match; match = use.exec(text)) {
    if (!match[1] || (match.index > 0 && text[match.index - 1] === "\\")) continue;
    const end = groupsEnd(text, match.index + match[0].length, discarding.get(match[1])!);
    if (end < 0) continue;
    regions.push({ from: match.index, to: end });
    use.lastIndex = end;
  }
  return regions;
}

/**
 * A conditional the text decides as false, as `\iffalse`: `\ifx 1 0` and `\if ab` on two different characters,
 * `\ifnum 0=1` on two numbers. One that compares commands or registers is not decided here.
 */
function staticallyFalse(text: string, at: number, name: string) {
  if (name === "ifnum") {
    const test = /^\s*(-?\d+)\s*([<=>])\s*(-?\d+)/.exec(text.slice(at, at + 40));
    if (!test) return false;
    const [a, b] = [Number(test[1]), Number(test[3])];
    return !(test[2] === "<" ? a < b : test[2] === ">" ? a > b : a === b);
  }
  if (name !== "ifx" && name !== "if") return false;
  const tokens = /^\s*([^\\\s{}%])\s*([^\\\s{}%])/.exec(text.slice(at, at + 12));
  return !!tokens && tokens[1] !== tokens[2];
}

/** What `\iffalse … \fi` leaves out (see `disabledRegions`), and conditionals the text decides as false. */
function falseRegions(text: string) {
  const regions: Array<{ from: number; to: number }> = [];
  if (!/\\if(?:false|x|num)?(?![A-Za-z@])/.test(text)) return regions;
  const declared = new Set([...text.matchAll(/\\newif\s*\\(if[A-Za-z@]+)/g)].map((match) => match[1]));
  const token = /%[^\n]*|\\(if[A-Za-z@]*|fi|else)(?![A-Za-z@])/g;
  let start = -1;
  let depth = 0;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    if (match[0].startsWith("%")) { if (match.index > 0 && text[match.index - 1] === "\\") token.lastIndex = match.index + 1; continue; }
    if (match.index > 0 && text[match.index - 1] === "\\") continue;
    const name = match[1];
    if (start < 0) {
      if (name === "iffalse" || staticallyFalse(text, match.index + match[0].length, name)) { start = match.index; depth = 0; }
      continue;
    }
    if (name === "fi" || (name === "else" && depth === 0)) {
      if (depth === 0) { regions.push({ from: start, to: match.index + match[0].length }); start = -1; continue; }
      depth--;
    } else if (name !== "else" && (PRIMITIVE_IFS.has(name) || declared.has(name))) depth++;
  }
  return regions;
}

/** The region containing `pos`, by binary search over sorted regions. */
export function regionContaining<T extends { from: number; to: number }>(regions: readonly T[], pos: number): T | null {
  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const region = regions[middle];
    if (pos < region.from) high = middle - 1;
    else if (pos >= region.to) low = middle + 1;
    else return region;
  }
  return null;
}

/** The macro environment region starting at `pos`, or the one `pos` is inside. */
export function macroEnvironmentRegionAt(regions: MacroEnvironmentRegion[], pos: number, inside = false) {
  for (const region of regions) {
    if (region.from === pos) return region;
    if (inside && region.from < pos && pos < region.to) return region;
    if (region.from > pos) break;
  }
  return null;
}
