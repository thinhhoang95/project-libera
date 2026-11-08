import type { SyntaxNode, Tree } from "@lezer/common";
import { latexParser as parser } from "../codemirror/latex-parser";
import { hashString } from "../../macros/core";
import { definitionExtentAt, macroAt, type LatexDefinitions } from "./definitions";
import { expandLatexMacros, expandLatexMacroUse } from "./expand";
import { disabledRegions, isPairMacro, macroEnvironmentRegionAt, macroEnvironmentRegions, regionContaining, structureMacroNames, usesStructureMacro } from "./structure";

/** Definitions whose body is not run where it is written: nothing in it is counted. */
const DEFINITION_START = /^\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|[gex]?def|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment)(?![A-Za-z@])/;

/* Numbers as the PDF will show them (docs/latex-visual-editor-plan.md §7.7):
 * one pass over the headings, equations, figures, tables, theorems,
 * footnotes and counter commands of the tree, in document order, with each
 * \label bound to the last number stepped before it in its environment. */

export type NumberingKind = "section" | "equation" | "figure" | "table" | "algorithm" | "theorem" | "footnote" | "item";

export type NumberingEntry = {
  /** Start of the construct: the sectioning command, the environment, the footnote. */
  pos: number;
  kind: NumberingKind;
  number: string | null;
  /** Equation numbers per row of an `align`-like environment (null: not numbered). */
  rows?: Array<string | null>;
  /** Rows numbered by an explicit `\tag`, which KaTeX draws itself (it gets no number slot). */
  tagged?: boolean[];
  level?: number;
  /** Theorem environment name. */
  env?: string;
};

export type LabelTarget = { number: string; kind: NumberingKind | "page"; pos: number; env?: string; title?: string };

export type LatexNumbering = {
  entries: NumberingEntry[];
  labels: Map<string, LabelTarget>;
  /** Counter values at the end, to continue in a file included after this one. */
  counters: Record<string, number>;
  appendix: boolean;
  /** Equal for equal numbering, so number widgets can tell when to update. */
  fingerprint: string;
};

export const EMPTY_NUMBERING: LatexNumbering = { entries: [], labels: new Map(), counters: {}, appendix: false, fingerprint: "" };

const SECTION_LEVELS: Record<string, number> = { Book: -2, Part: -1, Chapter: 0, Section: 1, SubSection: 2, SubSubSection: 3, Paragraph: 4, SubParagraph: 5 };
const SECTION_COUNTERS = ["chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];
const CHAPTER_CLASSES = /^(?:book|report|memoir|scrbook|scrreprt|amsbook|thesis|ut-thesis|mitthesis)$/;
const NUMBERED_EQUATIONS = new Set(["equation", "multline"]);
const NUMBERED_ROWS = new Set(["align", "alignat", "flalign", "gather", "eqnarray", "IEEEeqnarray", "subeqnarray"]);
const MATH_CONTAINERS = new Set(["DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment", "Math"]);

function roman(value: number) {
  const numerals: Array<[number, string]> = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [amount, numeral] of numerals) while (value >= amount) { out += numeral; value -= amount; }
  return out;
}

function alph(value: number) {
  let out = "";
  for (let n = value; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
  return out;
}

export function formatCounterValue(value: number, style: "arabic" | "roman" | "Roman" | "alph" | "Alph") {
  // Out of range for letters and numerals (TeX would stop with an error): shown as a number, without the work.
  if (style === "arabic" || !Number.isSafeInteger(value) || value < 1 || ((style === "roman" || style === "Roman") && value > 4999)) return String(value);
  if (style === "roman") return roman(value);
  if (style === "Roman") return roman(value).toUpperCase();
  if (style === "alph") return alph(value);
  return alph(value).toUpperCase();
}

type Read = (from: number, to: number) => string;

/** The name in `\begin{name}` of an environment node. */
export function environmentName(node: SyntaxNode, read: Read) {
  const begin = node.getChild("BeginEnv");
  const group = begin?.getChild("EnvNameGroup");
  if (!group) return null;
  return read(group.from + 1, group.to - 1).trim();
}

/** Floats a `\caption` numbers, by environment name: starred, wrapped and sideways forms and `algorithm` included. */
export const FLOAT_KINDS: Record<string, "figure" | "table" | "algorithm"> = {
  figure: "figure", "figure*": "figure", wrapfigure: "figure", sidewaysfigure: "figure", "sidewaysfigure*": "figure", SCfigure: "figure",
  table: "table", "table*": "table", wraptable: "table", sidewaystable: "table", "sidewaystable*": "table", SCtable: "table",
  algorithm: "algorithm", "algorithm*": "algorithm",
};

/** The kind of float an environment node is (its `\caption` numbers a figure, table or algorithm), or null. */
export function floatKind(node: SyntaxNode, read: Read): "figure" | "table" | "algorithm" | null {
  if (node.name !== "FigureEnvironment" && node.name !== "TableEnvironment" && node.name !== "Environment") return null;
  const env = environmentName(node, read) ?? "";
  return FLOAT_KINDS[env] ?? (node.name === "FigureEnvironment" && !/^sub/.test(env) ? "figure" : node.name === "TableEnvironment" && !/^sub/.test(env) ? "table" : null);
}

/** `longtable` and `xltabular`: tables that are their own float, with a caption and head and foot rows. */
export function isLongTable(node: SyntaxNode, read: Read) {
  return /^(?:longtable|xltabular)\*?$/.test(environmentName(node, read) ?? "");
}

/** Splits an align-like body into rows at `\\` outside braces and nested environments. */
export function splitMathRows(body: string) {
  const rows: string[] = [];
  let depth = 0;
  let environments = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "%") { const end = body.indexOf("\n", i); i = end < 0 ? body.length : end; continue; }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\\") {
      if (body.startsWith("\\begin", i)) environments++;
      else if (body.startsWith("\\end", i)) environments--;
      else if (body[i + 1] === "\\" && depth === 0 && environments === 0) {
        rows.push(body.slice(start, i));
        i++;
        // `\\[2pt]` and `\\*` belong to the break.
        if (body[i + 1] === "*") i++;
        const spacing = /^\s*\[[^\]]*\]/.exec(body.slice(i + 1));
        if (spacing) i += spacing[0].length;
        start = i + 1;
        continue;
      }
      i++;
    }
  }
  rows.push(body.slice(start));
  return rows;
}

/** TeX source without its `%` comments (an escaped `\%` stays). */
export function stripTexComments(text: string) {
  return text.includes("%") ? text.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, "$1$2") : text;
}

/** amsmath ignores a `\\` right before `\end{align}`; eqnarray makes it an empty, numbered row. */
function dropTrailingBreak(env: string, rows: string[]) {
  if (env !== "eqnarray" && rows.length > 1 && !rows[rows.length - 1].trim()) rows.pop();
  return rows;
}

const ENUM_COUNTERS = ["enumi", "enumii", "enumiii", "enumiv"];

/** The label an `enumerate` item shows: `1.`, `(a)`, or a custom `[(i)]` / `label=(\alph*)` template. */
export function enumerateItemLabel(count: number, depth: number, template: string | null) {
  if (template) {
    // enumerate's `[(i)]` and enumitem's `label=(\alph*)`.
    const label = /(?:^|,)\s*label\s*=\s*([^,]+)/.exec(template)?.[1]?.trim() ?? (/=/.test(template) ? null : template);
    if (label !== null) {
      const starred = label.replace(/\\(arabic|alph|Alph|roman|Roman)\*/, (_, style: "arabic" | "alph" | "Alph" | "roman" | "Roman") => formatCounterValue(count, style));
      if (starred !== label) return starred.replace(/[{}]/g, "");
      const token = /[1aAiI]/.exec(label);
      if (token) {
        const style = token[0] === "1" ? "arabic" : token[0] === "a" ? "alph" : token[0] === "A" ? "Alph" : token[0] === "i" ? "roman" : "Roman";
        return label.slice(0, token.index) + formatCounterValue(count, style) + label.slice(token.index + 1);
      }
    }
  }
  const style = (["arabic", "alph", "roman", "Alph"] as const)[Math.min(3, depth - 1)];
  const value = formatCounterValue(count, style);
  return depth === 2 ? `(${value})` : `${value}.`;
}

/**
 * What `\ref` shows for an item: LaTeX's `\p@enumii\theenumii` and so on
 * (`1a`, `1(a)i`) by default; with a custom label, enumitem's `ref=` or the
 * label itself. `counts` are the item numbers of the enclosing enumerate
 * levels, outermost first, ending with this item's.
 */
export function enumerateItemReference(counts: number[], templates: Array<string | null>) {
  const depth = counts.length;
  const template = templates[depth - 1];
  if (template) {
    const ref = /(?:^|,)\s*ref\s*=\s*([^,]+)/.exec(template)?.[1]?.trim();
    if (ref) return ref.replace(/\\(arabic|alph|Alph|roman|Roman)\*/g, (_, style: "arabic" | "alph" | "Alph" | "roman" | "Roman") => formatCounterValue(counts[depth - 1], style)).replace(/[{}]/g, "");
    return enumerateItemLabel(counts[depth - 1], depth, template).replace(/\.$/, "");
  }
  const [first, second, third, fourth] = counts;
  if (depth === 1) return formatCounterValue(first, "arabic");
  if (depth === 2) return `${first}${formatCounterValue(second, "alph")}`;
  if (depth === 3) return `${first}(${formatCounterValue(second, "alph")})${formatCounterValue(third, "roman")}`;
  return `${first}(${formatCounterValue(second, "alph")})${formatCounterValue(third, "roman")}${formatCounterValue(fourth, "Alph")}`;
}

function stripTitle(text: string) {
  return text.replace(/\\(?:textbf|textit|emph|texttt|textsc|mathrm|mbox|textrm|textsf)\s*/g, "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/** What a label after `\refstepcounter{counter}` refers to: `\refstepcounter{table}` makes a table label. */
function counterKind(counter: string): NumberingKind {
  if (SECTION_COUNTERS.includes(counter) || counter === "part") return "section";
  if (counter === "equation" || counter === "figure" || counter === "table" || counter === "algorithm" || counter === "footnote") return counter;
  if (/^enum(?:i|ii|iii|iv)$/.test(counter)) return "item";
  return "theorem";
}

export type NumberingStart = {
  /** Counter values where the file is included (a chapter of a main file). */
  counters: Record<string, number>;
  appendix: boolean;
};

/** A file the document `\input`s or `\include`s, parsed: its counters advance the document's. */
export type IncludedFile = { tree: Tree; read: Read };

export type NumberingOptions = {
  start?: NumberingStart | null;
  /** The files `\input{name}` and `\include{name}` read, by name as written (see definitions.ts `loadKey`); null when unknown. */
  includes?: ((name: string) => IncludedFile | null) | null;
};

/** Numbers the document. `read` gives the text of a range of the document `tree` belongs to. */
export function computeLatexNumbering(tree: Tree, read: Read, defs: LatexDefinitions, options: NumberingOptions = {}): LatexNumbering {
  const chapters = CHAPTER_CLASSES.test(defs.documentClass ?? "");
  const counters = new Map<string, number>(Object.entries(options.start?.counters ?? {}));
  // `\setcounter{secnumdepth}{n}` in the body is a counter; in the preamble, a definition.
  const secnumdepth = () => (counters.has("secnumdepth") ? counters.get("secnumdepth")! : defs.secnumdepth ?? (chapters ? 2 : 3));
  const within = new Map<string, string>([...defs.counterWithin]);
  // The counters printed with their parent's number first (`\thefigure` is `\thechapter.\arabic{figure}` in a book);
  // resetting is separate: a book's footnotes restart each chapter but print alone.
  const prefix = new Map<string, string>([...defs.counterPrefix]);
  if (chapters) for (const name of ["equation", "figure", "table", "footnote"]) if (!within.has(name)) { within.set(name, "chapter"); if (name !== "footnote") prefix.set(name, "chapter"); }
  for (const theorem of defs.theorems.values()) if (theorem.within && theorem.counter === theorem.name) { within.set(theorem.name, theorem.within); prefix.set(theorem.name, theorem.within); }
  for (let i = 1; i < SECTION_COUNTERS.length; i++) { within.set(SECTION_COUNTERS[i], SECTION_COUNTERS[i - 1]); prefix.set(SECTION_COUNTERS[i], SECTION_COUNTERS[i - 1]); }
  if (!chapters) { within.delete("section"); prefix.delete("section"); }
  // A counter numbered within itself, directly or through others (`\numberwithin{equation}{equation}`), is
  // an error in TeX: drop the edge that closes the cycle so stepping and formatting stay finite.
  for (const map of [within, prefix]) {
    for (const counter of [...map.keys()]) {
      const seen = new Set<string>([counter]);
      for (let parent = map.get(counter); parent !== undefined; parent = map.get(parent)) {
        if (seen.has(parent)) { map.delete(counter); break; }
        seen.add(parent);
      }
    }
  }
  let appendix = options.start?.appendix ?? false;
  /** Open `subequations` environments: their equations are numbered 3a, 3b. */
  const subequations: Array<{ node: number; parent: string; saved: number }> = [];

  const value = (name: string) => counters.get(name) ?? 0;
  const reset = (name: string) => {
    for (const [counter, parent] of within) if (parent === name) { counters.set(counter, 0); reset(counter); }
  };
  const step = (name: string) => { counters.set(name, value(name) + 1); reset(name); };
  const formatting = new Set<string>();
  /** A document's own `\renewcommand{\theequation}{…}`: its counter commands evaluated, "?" when it uses anything else. */
  const customFormat = (name: string): string | undefined => {
    const macro = macroAt(defs, `the${name}`, Number.MAX_SAFE_INTEGER);
    if (!macro) return undefined;
    if (macro.arity || macro.unsupported || formatting.has(name)) return "?";
    formatting.add(name);
    try {
      const text = macro.body.replace(/\\(arabic|roman|Roman|alph|Alph)\s*\{\s*([A-Za-z@]+)\s*\}|\\the([A-Za-z@]+)|\\relax|[{}]/g, (_whole, style?: "arabic" | "roman" | "Roman" | "alph" | "Alph", counter?: string, other?: string) => {
        if (style && counter) return formatCounterValue(value(counter), style);
        if (other) return format(other);
        return "";
      });
      return /\\|\?/.test(text) ? "?" : text.trim();
    } finally {
      formatting.delete(name);
    }
  };
  const format = (name: string, depth = 0): string => {
    // subequations redefines \theequation as \theparentequation\alph{equation}.
    const top = subequations[subequations.length - 1];
    if (name === "equation" && top) return `${top.parent}${formatCounterValue(value(name), "alph")}`;
    const custom = customFormat(name);
    if (custom !== undefined) return custom;
    const own = name === "part" ? formatCounterValue(value(name), "Roman")
      : appendix && ((chapters && name === "chapter") || (!chapters && name === "section")) ? formatCounterValue(value(name), "Alph")
        : String(value(name));
    const parent = prefix.get(name);
    // \thesubsection is \thesection.\arabic{subsection}, and so on; a section in a chapter class starts with the chapter.
    if (!parent || (parent === "chapter" && !chapters) || depth > 8) return own;
    return `${format(parent, depth + 1)}.${own}`;
  };

  const entries: NumberingEntry[] = [];
  const labels = new Map<string, LabelTarget>();
  // The label target: sections set it globally; environments push a scope.
  let globalTarget: LabelTarget | null = null;
  const scopes: Array<{ node: number; target: LabelTarget | null }> = [];
  const currentTarget = () => scopes.length ? scopes[scopes.length - 1].target : globalTarget;
  const setTarget = (target: LabelTarget) => { if (scopes.length) scopes[scopes.length - 1].target = target; else globalTarget = target; };
  const lists: Array<{ enumerate: boolean; count: number; depth: number; template: string | null }> = [];
  /** The enumerate list a counter `enumi`…`enumiv` belongs to, innermost first. */
  const enumerateList = (counter: string) => {
    const depth = ENUM_COUNTERS.indexOf(counter) + 1;
    if (!depth) return null;
    for (let i = lists.length - 1; i >= 0; i--) if (lists[i].enumerate && lists[i].depth === depth) return lists[i];
    return null;
  };
  const itemTarget = (list: (typeof lists)[number], pos: number): LabelTarget => {
    const enclosing = lists.filter((item) => item.enumerate && lists.indexOf(item) <= lists.indexOf(list));
    return { number: enumerateItemReference(enclosing.map((item) => item.count), enclosing.map((item) => item.template)), kind: "item", pos };
  };

  const argumentText = (node: SyntaxNode, index = 0) => {
    let seen = 0;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "TextArgument" || child.name === "ShortTextArgument") {
        if (seen++ === index) return read(child.from + 1, child.to - 1);
      }
    }
    return null;
  };

  let includeDepth = 0;
  const included = new Set<string>();
  /** Numbers an `\input`/`\include`d file in place: its counters count, its entries and labels (positions in another file) do not. */
  const numberIncluded = (node: SyntaxNode) => {
    const argument = node.getChild("InputArgument") ?? node.getChild("IncludeArgument");
    const name = argument ? read(argument.from + 1, argument.to - 1).trim() : "";
    const file = name && includeDepth < 4 && !included.has(name) ? options.includes?.(name) : null;
    if (!file) return;
    const entryCount = entries.length;
    const savedLabels = new Map(labels);
    const savedRead = read;
    included.add(name);
    includeDepth++;
    read = file.read;
    try {
      file.tree.iterate(visitor);
    } finally {
      read = savedRead;
      includeDepth--;
      included.delete(name);
      entries.length = entryCount;
      labels.clear();
      for (const [key, target] of savedLabels) labels.set(key, target);
      // A label right after the include refers to the last number in it, which is not in this file.
      if (globalTarget) globalTarget = { ...globalTarget, pos: -1 };
    }
  };

  // Macros that write structure (`\mysec{…}` for `\section{…}`, `\beq … \eeq`): their expansion is
  // parsed and numbered where the macro is used. Nothing here runs for a document without them.
  const structureNames = structureMacroNames(defs);
  const mainRead = read;
  const regions = structureNames.size ? macroEnvironmentRegions(() => mainRead(0, tree.length), defs) : [];
  /** The macro use whose expansion is being numbered: its expansion's constructs sit inside the use's ancestors. */
  let macroHost: SyntaxNode | null = null;
  /** Nodes starting before this are already numbered (a macro's arguments, a macro environment, a definition). */
  let skipUntil = -1;
  /** A node's ancestors, continuing past an expansion's root into the macro use's. */
  function* ancestors(node: SyntaxNode): Generator<[SyntaxNode, boolean]> {
    for (let parent = node.parent; parent; parent = parent.parent) yield [parent, false];
    if (macroHost) for (let parent = macroHost.parent; parent; parent = parent.parent) yield [parent, true];
  }
  /** Entries and targets an expansion numbers at a construct of the document (its figure): not moved to the macro use. */
  const fixed = new WeakSet<object>();
  /** The floats being read, innermost last: their number once captioned, and sub-figure labels waiting for it. */
  const floats: Array<{ from: number; number: string | null; count: number; waiting: Array<{ target: LabelTarget; letter: string }> }> = [];
  /** Steps a float's counter for its caption, numbering the float (or its panel) at `at`. */
  const numberCaption = (kind: "figure" | "table" | "algorithm", at: SyntaxNode, outer: boolean) => {
    const keep = <T extends object>(value: T) => { if (outer) fixed.add(value); return value; };
    step(kind);
    const number = format(kind);
    entries.push(keep({ pos: at.from, kind, number }));
    setTarget(keep({ number, kind, pos: at.from }));
    // Sub-figures captioned before the float's own caption get its number now: 5a, 5b.
    const float = floats[floats.length - 1];
    if (float && float.number === null) {
      float.number = number;
      for (const { target, letter } of float.waiting) target.number = `${number}${letter}`;
      float.waiting = [];
    }
  };
  /** subcaption's `subfigure` caption: a letter in its float, after the float's number ("3a"), which may come later. */
  const numberSubCaption = (kind: "figure" | "table", at: SyntaxNode) => {
    const float = floats[floats.length - 1];
    if (!float) return;
    float.count++;
    const letter = alph(float.count);
    const target: LabelTarget = { number: float.number === null ? "?" : `${float.number}${letter}`, kind, pos: at.from };
    if (float.number === null) float.waiting.push({ target, letter });
    setTarget(target);
    // The panel shows its letter: "(a)".
    entries.push({ pos: at.from, kind, number: letter });
  };
  /** What `\iffalse … \fi` leaves out of the document: not numbered. */
  const disabled = includeDepth ? [] : disabledRegions(mainRead(0, tree.length));
  /** Nodes entered (for what follows the `\fi` inside them) but not counted themselves: by name and start. */
  const passive = new Set<string>();
  const numberExpansion = (host: SyntaxNode, text: string) => {
    const entryCount = entries.length;
    const labelsBefore = new Map(labels);
    const targetBefore = globalTarget;
    const scopeTargets = scopes.map((scope) => scope.target);
    const savedRead = read;
    read = (from, to) => text.slice(from, to);
    macroHost = host;
    skipUntil = -1;
    try {
      parser.parse(text).iterate(visitor);
    } finally {
      read = savedRead;
      macroHost = null;
      // What the expansion numbered is at the macro use.
      const moved = <T extends { pos: number }>(value: T) => (fixed.has(value) ? value : { ...value, pos: host.from });
      for (let i = entryCount; i < entries.length; i++) entries[i] = moved(entries[i]);
      for (const [key, target] of labels) if (labelsBefore.get(key) !== target) labels.set(key, moved(target));
      if (globalTarget && globalTarget !== targetBefore) globalTarget = moved(globalTarget);
      scopes.forEach((scope, index) => { if (scope.target && scope.target !== scopeTargets[index]) scope.target = moved(scope.target); });
    }
  };
  /** Numbers a use of a macro that writes structure; false when `node` is not one. */
  const numberMacroUse = (node: SyntaxNode, command: string) => {
    if (macroHost || includeDepth || !structureNames.has(command.slice(1)) || !macroAt(defs, command.slice(1), node.from)) return false;
    const region = macroEnvironmentRegionAt(regions, node.from);
    if (region) {
      const expanded = expandLatexMacros(read(region.from, region.to), defs, { mode: "text", pos: region.from });
      if (expanded.ok) numberExpansion(node, expanded.text);
      skipUntil = region.to;
      return true;
    }
    // Half of a pair without the other half: an environment that is never closed is not numbered.
    if (isPairMacro(defs, command.slice(1))) return true;
    const use = expandLatexMacroUse(read(node.from, node.from + 4000), defs, { mode: "text", pos: node.from });
    if (!use) return false;
    numberExpansion(node, use.text);
    skipUntil = node.from + use.length;
    return true;
  };

  const visitor: Parameters<Tree["iterate"]>[0] = {
    enter(ref) {
      if (ref.from < skipUntil) return false;
      const name = ref.name;
      // `\iffalse … \fi`: what starts inside is not counted; a node running past the `\fi` is entered for what follows it.
      if (disabled.length && !macroHost && !includeDepth) {
        const region = regionContaining(disabled, ref.from);
        if (region) {
          if (ref.to <= region.to) return false;
          passive.add(`${name}@${ref.from}`);
          return undefined;
        }
      }
      const node = ref.node;
      // A definition's body is not run where it is written: `\newcommand{\fn}[1]{\footnote{#1}}` is no footnote.
      if (!macroHost && !includeDepth && ref.from >= 0) {
        const extent = definitionExtentAt(defs, ref.from);
        if (extent && ref.to <= extent.to && DEFINITION_START.test(read(ref.from, ref.from + 40))) { skipUntil = extent.to; return false; }
      }
      if ((name === "FigureEnvironment" || name === "TableEnvironment" || name === "Environment") && floatKind(node, read)) floats.push({ from: ref.from, number: null, count: 0, waiting: [] });
      if (name === "Comment" || name === "VerbatimEnvironment" || name === "TikzPictureEnvironment") return false;
      if (name === "Input" || name === "Include") { numberIncluded(node); return false; }
      if (name in SECTION_LEVELS) {
        const command = node.getChild("SectioningCommand");
        if (!command) return;
        const level = SECTION_LEVELS[name];
        const ctrl = command.firstChild;
        const starred = !!ctrl && (read(ctrl.from, ctrl.to).endsWith("*") || read(ctrl.to, ctrl.to + 1) === "*");
        const counter = level === -1 ? "part" : level === -2 ? null : SECTION_COUNTERS[level];
        const titleNode = command.getChild("SectioningArgument");
        const title = titleNode ? stripTitle(read(titleNode.from + 1, titleNode.to - 1)) : "";
        let number: string | null = null;
        if (counter && !starred && level <= secnumdepth()) {
          step(counter);
          number = format(counter);
        }
        entries.push({ pos: command.from, kind: "section", number, level });
        if (number) setTarget({ number, kind: "section", pos: command.from, title });
        return;
      }
      if (name === "UnknownCommand") {
        const ctrl = node.firstChild;
        if (!ctrl || ctrl.name !== "CtrlSeq") return;
        const command = read(ctrl.from, ctrl.to);
        if (structureNames.size && numberMacroUse(node, command)) return false;
        if (command === "\\captionof" && read(ctrl.to, ctrl.to + 1) !== "*") {
          // caption's `\captionof{table}{…}`: a caption outside a float, numbered where it is (or at its minipage).
          const kind = FLOAT_KINDS[argumentText(node, 0)?.trim() ?? ""];
          if (kind) {
            let at: [SyntaxNode, boolean] = [node, false];
            for (const [parent, outer] of ancestors(node)) if (parent.name === "Environment" && environmentName(parent, outer ? mainRead : read) === "minipage") { at = [parent, outer]; break; }
            numberCaption(kind, ...at);
          }
          return false;
        }
        if (command === "\\appendix") {
          appendix = true;
          const top = chapters ? "chapter" : "section";
          counters.set(top, 0);
          reset(top);
        } else if (command === "\\setcounter" || command === "\\addtocounter") {
          const counter = argumentText(node, 0)?.trim();
          const amount = Number(argumentText(node, 1)?.trim());
          if (counter && Number.isFinite(amount)) {
            counters.set(counter, command === "\\setcounter" ? amount : value(counter) + amount);
            // An enumerate counter: the list's next item continues from it.
            const list = enumerateList(counter);
            if (list) list.count = command === "\\setcounter" ? amount : list.count + amount;
          }
        } else if (command === "\\stepcounter" || command === "\\refstepcounter") {
          const counter = argumentText(node, 0)?.trim();
          const list = counter ? enumerateList(counter) : null;
          if (list) {
            list.count++;
            if (command === "\\refstepcounter") setTarget(itemTarget(list, node.from));
          } else if (counter) {
            step(counter);
            if (command === "\\refstepcounter") setTarget({ number: format(counter), kind: counterKind(counter), pos: node.from, env: counter });
          }
        } else if (command === "\\footnotemark") {
          // A bare \footnotemark steps the counter; one with [n] does not.
          if (read(ctrl.to, ctrl.to + 1) !== "[") step("footnote");
        }
        return;
      }
      if (name === "FootnoteCommand" || name === "EndnoteCommand") {
        // `\footnote[5]{…}` prints 5 and steps nothing; endnotes have their own counter.
        const optional = node.getChild("OptionalArgument");
        const counter = name === "FootnoteCommand" ? "footnote" : "endnote";
        let number: string;
        if (optional) number = read(optional.from + 1, optional.to - 1).trim();
        else { step(counter); number = format(counter); }
        entries.push({ pos: node.from, kind: "footnote", number });
        // A label in the note's text refers to the note (LaTeX sets \@currentlabel there), until the note ends.
        scopes.push({ node: node.from, target: { number, kind: "footnote", pos: node.from } });
        return;
      }
      if (name === "EquationEnvironment" || name === "EquationArrayEnvironment") {
        // Inner environments (aligned, cases, matrices) are part of an outer formula.
        for (let parent = node.parent; parent; parent = parent.parent) if (MATH_CONTAINERS.has(parent.name)) return false;
        const env = environmentName(node, read) ?? "";
        const base = env.replace(/\*$/, "");
        const starred = env.endsWith("*");
        const content = node.getChild("Content");
        // Commented-out \tag, \label and \nonumber do nothing.
        let body = stripTexComments(content ? read(content.from, content.to) : "");
        // Row breaks, labels and tags written through macros (`\newcommand{\nl}{\\}`) count as written.
        if (structureNames.size && usesStructureMacro(body, defs)) {
          const expanded = expandLatexMacros(body, defs, { mode: "math", pos: node.from });
          if (expanded.ok) body = stripTexComments(expanded.text);
        }
        if (name === "EquationEnvironment") {
          let number: string | null = null;
          const tag = /\\tag\*?\s*\{([^}]*)\}/.exec(body);
          if (tag) number = tag[1];
          else if (NUMBERED_EQUATIONS.has(base) && !starred && !/\\(?:nonumber|notag)\b/.test(body)) { step("equation"); number = format("equation"); }
          entries.push({ pos: node.from, kind: "equation", number, rows: [number], tagged: [!!tag] });
          for (const match of body.matchAll(/\\label\s*\{([^}]*)\}/g)) if (number) labels.set(match[1].trim(), { number, kind: "equation", pos: node.from });
        } else {
          const numbered = NUMBERED_ROWS.has(base) && !starred;
          const tagged: boolean[] = [];
          // amsmath keeps a \label in a \nonumber row for the next numbered row.
          let waiting: string[] = [];
          const rows = dropTrailingBreak(base, splitMathRows(body)).map((row) => {
            const tag = /\\tag\*?\s*\{([^}]*)\}/.exec(row);
            let number: string | null = null;
            if (tag) number = tag[1];
            else if (numbered && !/\\(?:nonumber|notag)\b/.test(row)) { step("equation"); number = format("equation"); }
            tagged.push(!!tag);
            waiting.push(...[...row.matchAll(/\\label\s*\{([^}]*)\}/g)].map((match) => match[1].trim()));
            if (number) {
              for (const key of waiting) labels.set(key, { number, kind: "equation", pos: node.from });
              waiting = [];
            }
            return number;
          });
          entries.push({ pos: node.from, kind: "equation", number: rows.find((row) => row !== null) ?? null, rows, tagged });
        }
        return false;
      }
      if (name === "DollarMath" || name === "BracketMath" || name === "ParenMath") return false;
      if (name === "FigureEnvironment" || name === "TableEnvironment") {
        // The number is stepped by \caption (below), so a \label before it refers to the section. In a
        // sub-figure it refers to nothing until its caption (the caption package's "??").
        scopes.push({ node: node.from, target: /^sub/.test(environmentName(node, read) ?? "") ? null : currentTarget() });
        return;
      }
      if (name === "TabularEnvironment" && isLongTable(node, read)) {
        // A longtable's \caption numbers it as a table; its \label refers to it.
        scopes.push({ node: node.from, target: currentTarget() });
        return;
      }
      if (name === "Caption") {
        // `\caption*{…}` numbers nothing.
        const ctrl = node.firstChild;
        if (ctrl && read(ctrl.to, ctrl.to + 1) === "*") return false;
        // Through `ancestors`, a caption a macro writes belongs to the figure the macro is used in.
        // In a minipage of a float (side-by-side panels), the number is the panel's: recorded at the minipage.
        let panel: [SyntaxNode, boolean] | null = null;
        for (const [parent, outer] of ancestors(node)) {
          // A figure around the macro use is in the document: read there, and its number stays at it.
          const readParent = outer ? mainRead : read;
          if (parent.name === "TabularEnvironment" && isLongTable(parent, readParent)) {
            numberCaption("table", parent, outer);
            return;
          }
          if (parent.name !== "FigureEnvironment" && parent.name !== "TableEnvironment" && parent.name !== "Environment") continue;
          const env = environmentName(parent, readParent) ?? "";
          if (env === "subfigure" || env === "subtable") { numberSubCaption(env === "subtable" ? "table" : "figure", parent); return false; }
          if (env === "minipage") { panel ??= [parent, outer]; continue; }
          const kind = floatKind(parent, readParent);
          if (!kind) continue;
          // A \label inside the caption refers to the figure too. A float's second caption (two tables in
          // one float, without minipages) numbers another table: recorded at that caption.
          const float = floats[floats.length - 1];
          const again = !panel && !outer && float?.from === parent.from && float.number !== null;
          numberCaption(kind, ...(panel ?? (again ? [node, false] as [SyntaxNode, boolean] : [parent, outer])));
          return;
        }
        return false;
      }
      if (name === "Environment") {
        const env = environmentName(node, read) ?? "";
        scopes.push({ node: node.from, target: env === "subtable" ? null : currentTarget() });
        // The appendix package's `appendices` environment letters its sections, as `\appendix` does.
        if (env === "appendices") {
          appendix = true;
          const top = chapters ? "chapter" : "section";
          counters.set(top, 0);
          reset(top);
        }
        if (env === "subequations") {
          // One equation number for the group, and 3a, 3b for the equations in it; a label right after the \begin is the group's.
          step("equation");
          const parent = format("equation");
          subequations.push({ node: node.from, parent, saved: value("equation") });
          counters.set("equation", 0);
          setTarget({ number: parent, kind: "equation", pos: node.from });
          return;
        }
        const theorem = defs.theorems.get(env);
        if (theorem) {
          let number: string | null = null;
          if (theorem.numbered) {
            const counter = theorem.counter;
            step(counter);
            number = format(counter);
          }
          entries.push({ pos: node.from, kind: "theorem", number, env });
          if (number) setTarget({ number, kind: "theorem", pos: node.from, env });
        }
        return;
      }
      if (name === "ListEnvironment") {
        const env = environmentName(node, read) ?? "";
        const optional = node.getChild("BeginEnv")?.getChild("OptionalArgument");
        lists.push({
          enumerate: env === "enumerate", count: 0, depth: lists.filter((list) => list.enumerate).length + (env === "enumerate" ? 1 : 0),
          template: optional ? read(optional.from + 1, optional.to - 1) : null,
        });
        scopes.push({ node: node.from, target: currentTarget() });
        return;
      }
      if (name === "Item") {
        const list = lists[lists.length - 1];
        if (list?.enumerate && !node.getChild("OptionalArgument")) {
          list.count++;
          setTarget(itemTarget(list, node.from));
        }
        return;
      }
      if (name === "Label") {
        const argument = node.getChild("LabelArgument");
        if (!argument) return false;
        const key = read(argument.from, argument.to).replace(/^\{|\}$/g, "").trim();
        const target = currentTarget();
        if (key && target) labels.set(key, target);
        return false;
      }
      return;
    },
    leave(ref) {
      const name = ref.name;
      if (passive.size && passive.delete(`${name}@${ref.from}`)) return;
      if (floats.length && floats[floats.length - 1].from === ref.from && (name === "FigureEnvironment" || name === "TableEnvironment" || name === "Environment")) floats.pop();
      if (name === "FigureEnvironment" || name === "TableEnvironment" || name === "Environment" || name === "ListEnvironment" || name === "FootnoteCommand" || name === "EndnoteCommand" || name === "TabularEnvironment") {
        if (scopes.length && scopes[scopes.length - 1].node === ref.from) scopes.pop();
        if (name === "ListEnvironment") lists.pop();
        const group = subequations[subequations.length - 1];
        if (name === "Environment" && group?.node === ref.from) { subequations.pop(); counters.set("equation", group.saved); }
      }
    },
  };
  tree.iterate(visitor);

  // An entry is recorded where its construct starts, which can be before entries already recorded
  // (a figure's number comes from its caption): lookups search by position.
  entries.sort((a, b) => a.pos - b.pos);
  // Everything a widget can show: numbers, titles, kinds, positions.
  const fingerprint = hashString(JSON.stringify([
    entries.map((entry) => [entry.pos, entry.kind, entry.number, entry.rows ?? null, entry.tagged ?? null, entry.level ?? null, entry.env ?? null]),
    [...labels].map(([key, target]) => [key, target.number, target.kind, target.pos, target.env ?? null, target.title ?? null]),
  ]));
  return { entries, labels, counters: Object.fromEntries(counters), appendix, fingerprint };
}

/** The entry of a construct starting at `pos`, by binary search. */
export function numberingEntryAt(numbering: LatexNumbering, pos: number, kind?: NumberingKind) {
  const { entries } = numbering;
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = entries[middle];
    if (entry.pos === pos) {
      // Several kinds can start at one position (a footnote in a heading is not one); look around for the kind.
      if (!kind || entry.kind === kind) return entry;
      for (let i = middle - 1; i >= 0 && entries[i].pos === pos; i--) if (entries[i].kind === kind) return entries[i];
      for (let i = middle + 1; i < entries.length && entries[i].pos === pos; i++) if (entries[i].kind === kind) return entries[i];
      return null;
    }
    if (entry.pos < pos) low = middle + 1; else high = middle - 1;
  }
  return null;
}

const CREF_NAMES: Record<string, [string, string, string, string]> = {
  section: ["section", "sections", "Section", "Sections"],
  equation: ["eq.", "eqs.", "Equation", "Equations"],
  figure: ["fig.", "figs.", "Figure", "Figures"],
  table: ["table", "tables", "Table", "Tables"],
  algorithm: ["algorithm", "algorithms", "Algorithm", "Algorithms"],
  footnote: ["footnote", "footnotes", "Footnote", "Footnotes"],
  item: ["item", "items", "Item", "Items"],
  theorem: ["theorem", "theorems", "Theorem", "Theorems"],
};

/** What a reference command shows for a label: `\ref` "2.1", `\eqref` "(3)", `\cref` "fig. 1", `\Cref` "Figure 1", `\autoref` "Figure 1". */
export function referenceText(command: string, targets: Array<LabelTarget | null>, defs: LatexDefinitions, keys: string[]) {
  const name = command.replace(/^\\/, "").replace(/\*$/, "");
  const numbers = targets.map((target, index) => target?.number ?? `??${keys[index] ? "" : ""}`);
  const first = targets[0];
  if (name === "eqref") return numbers.map((number) => `(${number})`).join(", ");
  if (name === "pageref" || name === "vpageref") return targets.map((target) => (target?.kind === "page" ? target.number : "?")).join(", ");
  if (name === "nameref") return first?.title ?? numbers[0];
  if (name === "cref" || name === "Cref" || name === "autoref" || name === "Autoref" || name === "cpageref") {
    const capital = name !== "cref";
    const kind = first?.kind ?? "section";
    const theorem = kind === "theorem" && first?.env ? defs.theorems.get(first.env) : null;
    const custom = defs.crefNames.get(capital ? `${theorem?.name ?? kind}:capital` : theorem?.name ?? kind) ?? defs.crefNames.get(theorem?.name ?? kind);
    const builtin = CREF_NAMES[kind === "page" ? "section" : kind] ?? CREF_NAMES.section;
    const plural = targets.length > 1;
    let label = custom ? (plural ? custom.plural : custom.singular)
      : theorem ? theorem.title + (plural ? "s" : "")
        : name.startsWith("auto") || name.startsWith("Auto") ? builtin[2] : builtin[(capital ? 2 : 0) + (plural ? 1 : 0)];
    if (capital && label) label = label[0].toUpperCase() + label.slice(1);
    const list = kind === "equation" && !name.startsWith("auto") && !name.startsWith("Auto") ? numbers.map((number) => `(${number})`) : numbers;
    return `${label} ${list.length > 2 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list.join(" and ")}`;
  }
  return numbers.join(", ");
}
