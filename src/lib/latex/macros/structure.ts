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

/** The macro environment region starting at `pos`, or the one `pos` is inside. */
export function macroEnvironmentRegionAt(regions: MacroEnvironmentRegion[], pos: number, inside = false) {
  for (const region of regions) {
    if (region.from === pos) return region;
    if (inside && region.from < pos && pos < region.to) return region;
    if (region.from > pos) break;
  }
  return null;
}
