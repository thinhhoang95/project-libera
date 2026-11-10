import { hashString, readGroup, readOptional, TEX_GROUPS } from "../../macros/core";

/* The document's own definitions, read the way TeX would read them, for the
 * Visual mode (docs/latex-visual-editor-plan.md §7). Only forms whose meaning
 * is certain are kept; anything else is listed as not rendered, and its uses
 * stay as source. Definitions in source TeX does not run (comments, verbatim,
 * `\verb`, the false branch of `\iffalse`, bodies of other definitions) are
 * not read; definitions under a conditional the reader cannot evaluate hide
 * any earlier meaning (their uses stay source); and local definitions end
 * with their group (`{…}`, `\begingroup…\endgroup`, an environment). */

/** An xparse argument: mandatory, optional (with a default), or a star. */
export type XparseArgument = { type: "m" } | { type: "o" } | { type: "O"; default: string } | { type: "s" };

export type LatexMacro = {
  name: string;
  /** Arguments in total, the optional first one included. */
  arity: number;
  /** Default of the optional first argument (`\newcommand\x[2][default]`), or undefined when there is none. */
  optional?: string;
  /** xparse argument types, replacing `arity`/`optional`. */
  spec?: XparseArgument[];
  body: string;
  /** Only meaningful in math (`\DeclareMathOperator`). */
  mathOnly?: boolean;
  /** Where it was defined: -1 before the document body (preamble, other files), else its position in the open file. */
  pos: number;
  /** Where a local definition stops applying (its group closes); undefined when it lasts to the end. */
  end?: number;
  /** A definition the Visual mode cannot render (`\edef`, delimited parameters, under an unknown conditional): it hides earlier meanings, and its uses stay source. */
  unsupported?: boolean;
  /** `\let\a\b` with `\b` not one of the document's macros: only a name for another command, whose arguments are unknown. */
  alias?: boolean;
  /** `\providecommand`: does nothing when the command already exists, which for LaTeX's own commands the reader cannot know. */
  provided?: boolean;
  file?: string;
  fingerprint: string;
};

export type LatexEnvironmentDefinition = {
  name: string;
  arity: number;
  optional?: string;
  spec?: XparseArgument[];
  begin: string;
  end: string;
  pos: number;
};

export type TheoremStyle = "plain" | "definition" | "remark";
export type LatexTheoremDefinition = {
  name: string;
  title: string;
  /** The counter it steps: its own name, or the environment it shares one with. */
  counter: string;
  /** Counter it is reset by and numbered within (`[section]`). */
  within?: string;
  numbered: boolean;
  style: TheoremStyle;
};

export type LatexDefinitionNote = { pos: number; file?: string; name: string; message: string };

/** `paragraph`: a column whose cells wrap, as `p{…}` and tabularx's `X` do; the others are one line. */
export type LatexColumnType = { arity: number; align: "left" | "center" | "right"; paragraph?: boolean };

/** How a `\newcolumntype` body aligns: `>{\centering}`, `>{\raggedleft}`, or its base column (`c`, `r`). */
function columnTypeAlign(body: string): LatexColumnType["align"] {
  if (/\\centering(?![A-Za-z@])/.test(body)) return "center";
  if (/\\raggedleft(?![A-Za-z@])/.test(body)) return "right";
  if (/\\raggedright(?![A-Za-z@])/.test(body)) return "left";
  // Without its `>{…}`, `<{…}` and `@{…}` parts, the base column's letter.
  const base = body.replace(/[<>@!]\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "").replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, "").replace(/[\s|]/g, "");
  return base[0] === "c" ? "center" : base[0] === "r" ? "right" : "left";
}

export type LatexDefinitions = {
  /** Every definition of each name, in reading order (later ones win from where they are). */
  macros: Map<string, LatexMacro[]>;
  environments: Map<string, LatexEnvironmentDefinition>;
  theorems: Map<string, LatexTheoremDefinition>;
  /** `\newcounter{c}[within]` and `\numberwithin{c}{within}`: the counter that resets each one. */
  counterWithin: Map<string, string>;
  /** `\numberwithin{c}{within}` only: counters printed with their parent's number first (`\newcounter[within]` resets but prints alone). */
  counterPrefix: Map<string, string>;
  crefNames: Map<string, { singular: string; plural: string; capital?: boolean }>;
  documentClass: string | null;
  packages: string[];
  /** The options a package was loaded with (`\usepackage[ruled,vlined]{algorithm2e}`), by package name. */
  packageOptions: Map<string, string[]>;
  /** `\setcounter{secnumdepth}{n}` before the body. */
  secnumdepth?: number;
  /** `\graphicspath{{dir/}…}` directories, in order. */
  graphicsPaths: string[];
  /** array's `\newcolumntype{L}[1]{>{\raggedright}p{#1}}`: its arguments and how it aligns. */
  columnTypes: Map<string, LatexColumnType>;
  /** xcolor's `\definecolor{name}{model}{value}`, and `\colorlet{name}{color}` (model "", value the colour it names). */
  colors: Map<string, { model: string; value: string }>;
  /** enumitem's `\newlist{exercises}{enumerate}{6}`: lists of the document's own, by name, with the kind they are. */
  lists?: Map<string, "enumerate" | "itemize" | "description">;
  /** enumitem's `\setlist[exercises,1]{label=…}`: the options of a list's level, by `name:level`. */
  listOptions?: Map<string, string>;
  /**
   * Where the open file's definitions are (absolute ranges, in order), so edits inside one re-read them.
   * `broken`: a definition without its body, which runs to the end so any later edit may complete it; it is
   * no body to skip (what follows it is still the document).
   */
  extents: Array<{ from: number; to: number; broken?: boolean }>;
  /** Definitions that are wrong (a body using `#3` with two arguments). */
  problems: LatexDefinitionNote[];
  /** Definitions in forms the Visual mode does not render. */
  unsupported: LatexDefinitionNote[];
  /** Equal for equal definitions, so renderers can keep what did not change. */
  fingerprint: string;
};

export function emptyLatexDefinitions(): LatexDefinitions {
  return {
    macros: new Map(), environments: new Map(), theorems: new Map(), counterWithin: new Map(), counterPrefix: new Map(), crefNames: new Map(),
    documentClass: null, packages: [], packageOptions: new Map(), graphicsPaths: [], columnTypes: new Map(), colors: new Map(), extents: [], problems: [], unsupported: [], fingerprint: "",
  };
}

const DEFINITION = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|xdef|let|DeclareMathOperator|DeclarePairedDelimiter|foreach|newlist|setlist|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|newtheorem|theoremstyle|newcounter|numberwithin|counterwithin|crefname|Crefname|documentclass|usepackage|RequirePackage|input|setcounter|graphicspath|newcolumntype|definecolor|colorlet)(?![A-Za-z@])/g;

/** Environments whose contents TeX reads as text, not commands. */
const VERBATIM_ENVIRONMENTS = /^(?:verbatim\*?|Verbatim\*?|BVerbatim|LVerbatim|lstlisting|minted|comment|filecontents\*?)$/;

/** `keep`: a group whose definitions TeX runs at the top level later (`\AtBeginDocument{…}`), so they do not end with it. */
type Frame = { kind: "brace" | "group" | "env"; locals: LatexMacro[]; keep?: boolean };
type Branch = "run" | "skip" | "unknown";

/** TeX's own conditionals (and engine tests): each is closed by a `\fi`. */
const PRIMITIVE_CONDITIONALS = new Set([
  "if", "ifx", "ifcat", "ifnum", "ifdim", "ifodd", "ifvmode", "ifhmode", "ifmmode", "ifinner", "ifvoid", "ifhbox", "ifvbox", "ifeof", "ifcase",
  "ifdefined", "ifcsname", "iffontchar", "ifincsname", "ifpdfprimitive", "ifabsnum", "ifabsdim", "ifpdf", "ifxetex", "ifluatex", "ifPDFTeX", "ifpdftex", "ifvtex", "iftutex",
]);
/** etoolbox's tests of a command (`\ifdef\foo{yes}{no}`): macros with arguments, not conditionals. */
const COMMAND_TESTS = /^if(?:def|undef|cs)[a-z]*$/;
/** Commands whose argument TeX runs later at the top level: what it defines is not local to its braces. */
const DEFERRED_TOP_LEVEL = /^(?:AtBeginDocument|AtEndPreamble|AfterEndPreamble|AtEndOfClass|AtEndOfPackage)$/;

/**
 * A forward pass over TeX source, in step with the definition reader: what
 * is skipped (comments, verbatim, `\verb`, false branches), whether the
 * reader is under a conditional it cannot evaluate, and the groups that end
 * local definitions. Text the reader jumps over (definition bodies) is never
 * scanned, so the groups and conditionals in it do not count.
 */
class TexScanner {
  pos = 0;
  private frames: Frame[] = [];
  private conditionals: Array<{ first: Branch; second: Branch; inElse: boolean }> = [];
  /** Conditionals the source makes with `\newif\iffoo`: closed by `\fi` whatever follows them. */
  private newifs = new Set<string>();
  /** Where the next `{` opens a group run later at the top level (`\AtBeginDocument{`). */
  private deferredBrace = -1;
  private static SPECIAL = /[\\{}%]/g;
  constructor(readonly source: string) {}

  branch(): Branch {
    let unknown = false;
    for (const conditional of this.conditionals) {
      const state = conditional.inElse ? conditional.second : conditional.first;
      if (state === "skip") return "skip";
      if (state === "unknown") unknown = true;
    }
    return unknown ? "unknown" : "run";
  }

  /** The innermost open group, which ends a local definition made now. */
  innermost(): Frame | null {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }

  jump(to: number) { if (to > this.pos) this.pos = to; }

  private close(kind: Frame["kind"] | null, at: number) {
    // Closes the innermost frame of `kind` (any kind when null) and the frames opened inside it.
    let index = this.frames.length - 1;
    if (kind) while (index >= 0 && this.frames[index].kind !== kind) index--;
    if (index < 0) return;
    for (const frame of this.frames.splice(index)) if (!frame.keep) for (const macro of frame.locals) macro.end ??= at;
  }

  /** Whether `\name` opens a conditional that a `\fi` closes; etoolbox's and biblatex's `\ifbool{…}{…}{…}` are macros. */
  private opensConditional(name: string) {
    if (PRIMITIVE_CONDITIONALS.has(name) || this.newifs.has(name)) return true;
    if (COMMAND_TESTS.test(name)) return false;
    // `\ifbool{x}`, `\iffieldundef{x}`, `\ifnumequal{a}{b}`: a test taking braced arguments.
    return !/^\s*\{/.test(this.source.slice(this.pos, this.pos + 40));
  }

  private environmentName(at: number) {
    const match = /^\s*\{([^{}]*)\}/.exec(this.source.slice(at, at + 120));
    return match ? { name: match[1].trim(), end: at + match[0].length } : null;
  }

  /** Reads tokens that start before `to`. */
  advance(to: number) {
    const source = this.source;
    while (this.pos < to) {
      TexScanner.SPECIAL.lastIndex = this.pos;
      const found = TexScanner.SPECIAL.exec(source);
      if (!found || found.index >= to) { this.pos = to; return; }
      const at = found.index;
      const char = found[0];
      const skipping = this.branch() === "skip";
      if (char === "%") {
        const end = source.indexOf("\n", at);
        this.pos = end < 0 ? source.length : end + 1;
        continue;
      }
      if (char === "{" || char === "}") {
        this.pos = at + 1;
        if (skipping) continue;
        if (char === "{") {
          const keep = at === this.deferredBrace;
          this.frames.push(keep ? { kind: "brace", locals: [], keep } : { kind: "brace", locals: [] });
        } else this.close("brace", at);
        continue;
      }
      const word = /^\\(?:([A-Za-z@]+)|[\s\S]?)/.exec(source.slice(at, at + 64))!;
      this.pos = at + Math.max(1, word[0].length);
      const name = word[1];
      if (!name) continue;
      if (name === "fi") { this.conditionals.pop(); continue; }
      if (name === "else") { const top = this.conditionals[this.conditionals.length - 1]; if (top) top.inElse = true; continue; }
      if (name === "iffalse") { this.conditionals.push({ first: "skip", second: "run", inElse: false }); continue; }
      if (name === "iftrue") { this.conditionals.push({ first: "run", second: "skip", inElse: false }); continue; }
      if (/^if/.test(name) && name !== "ifthenelse" && this.opensConditional(name)) {
        // Under a false branch TeX only counts conditionals; elsewhere one it cannot evaluate.
        this.conditionals.push(skipping ? { first: "skip", second: "skip", inElse: false } : { first: "unknown", second: "unknown", inElse: false });
        continue;
      }
      if (skipping) continue;
      if (name === "newif") {
        // `\newif\iffoo` defines a conditional; it does not open one.
        const next = /^\s*\\([A-Za-z@]+)/.exec(source.slice(this.pos, this.pos + 80));
        if (next) { this.pos += next[0].length; this.newifs.add(next[1]); }
      } else if (DEFERRED_TOP_LEVEL.test(name)) {
        const open = /^\s*\{/.exec(source.slice(this.pos, this.pos + 40));
        if (open) this.deferredBrace = this.pos + open[0].length - 1;
      } else if (name === "verb" || name === "lstinline") {
        let index = this.pos;
        if (source[index] === "*") index++;
        if (name === "lstinline" && source[index] === "[") index = readOptional(source, index)?.end ?? index;
        const delimiter = source[index];
        const close = delimiter === "{" ? "}" : delimiter;
        const end = delimiter ? source.indexOf(close, index + 1) : -1;
        const lineEnd = source.indexOf("\n", index + 1);
        this.pos = end < 0 || (lineEnd >= 0 && end > lineEnd) ? Math.max(this.pos, index) : end + 1;
      } else if (name === "begin") {
        const env = this.environmentName(this.pos);
        if (env && VERBATIM_ENVIRONMENTS.test(env.name)) {
          const end = source.indexOf(`\\end{${env.name}}`, env.end);
          this.pos = end < 0 ? source.length : end + `\\end{${env.name}}`.length;
        } else {
          if (env) this.pos = env.end;
          // The document environment is not a group that matters: nothing is read after it.
          if (env?.name !== "document") this.frames.push({ kind: "env", locals: [] });
        }
      } else if (name === "end") {
        const env = this.environmentName(this.pos);
        if (env) this.pos = env.end;
        if (env?.name !== "document") this.close("env", at);
      } else if (name === "begingroup") this.frames.push({ kind: "group", locals: [] });
      else if (name === "endgroup") this.close("group", at);
      else if (name === "bgroup") this.frames.push({ kind: "brace", locals: [] });
      else if (name === "egroup") this.close("brace", at);
    }
  }
}

/** Whether `index` is inside a `%` comment on its line. */
function inComment(source: string, index: number) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  for (let i = lineStart; i < index; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (source[i] === "%") return true;
  }
  return false;
}

/** Skips spaces and `%` comments between a command's arguments (a blank line ends them). */
function skipSpace(source: string, index: number) {
  while (index < source.length) {
    const char = source[index];
    if (char === "%") {
      const end = source.indexOf("\n", index);
      if (end < 0) return source.length;
      index = end + 1;
      continue;
    }
    if (!/[ \t\r\n]/.test(char)) break;
    if (char === "\n" && /^\n[ \t]*\n/.test(source.slice(index, index + 40))) break;
    index++;
  }
  return index;
}

/** `{\name}` or `\name` (letters, or one other character). */
function readCommandName(source: string, index: number): { name: string; end: number } | null {
  index = skipSpace(source, index);
  if (source[index] === "{") {
    const group = readGroup(source, index, TEX_GROUPS);
    const match = group && /^\s*\\([A-Za-z@]+|.)\s*$/.exec(group.content);
    return match ? { name: match[1], end: group.end } : null;
  }
  const match = /^\\([A-Za-z@]+|.)/.exec(source.slice(index, index + 80));
  return match ? { name: match[1], end: index + match[0].length } : null;
}

function readGroupAt(source: string, index: number) {
  return readGroup(source, skipSpace(source, index), TEX_GROUPS);
}

function readOptionalAt(source: string, index: number) {
  return readOptional(source, skipSpace(source, index), TEX_GROUPS);
}

/** The highest `#n` in a body (`##` is a literal `#`). */
function highestParameter(body: string) {
  let highest = 0;
  for (const match of body.matchAll(/##|#([1-9])/g)) if (match[1]) highest = Math.max(highest, Number(match[1]));
  return highest;
}

/** xparse argument specifications; null when one is not supported. */
function parseXparseSpec(spec: string): XparseArgument[] | null {
  const args: XparseArgument[] = [];
  let index = 0;
  while (index < spec.length) {
    const char = spec[index];
    if (/\s|\+|!/.test(char)) { index++; continue; }
    if (char === "m") args.push({ type: "m" });
    else if (char === "o") args.push({ type: "o" });
    else if (char === "s") args.push({ type: "s" });
    else if (char === "O") {
      const group = readGroup(spec, index + 1);
      if (!group) return null;
      args.push({ type: "O", default: group.content });
      index = group.end;
      continue;
    } else return null;
    index++;
  }
  return args;
}

/** The names a pgffor list gives: letters written out (`A,B,C`) and letter ranges (`A,...,Z`); null for anything else. */
function foreachItems(list: string): string[] | null {
  const items = list.split(",").map((item) => item.trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i] === "..." || items[i] === "\\ldots") {
      const from = out[out.length - 1];
      const to = items[i + 1];
      if (!from || !to || !/^[A-Za-z]$/.test(from) || !/^[A-Za-z]$/.test(to) || to.charCodeAt(0) <= from.charCodeAt(0)) return null;
      for (let code = from.charCodeAt(0) + 1; code < to.charCodeAt(0); code++) out.push(String.fromCharCode(code));
      continue;
    }
    if (!/^[A-Za-z]+$/.test(items[i])) return null;
    out.push(items[i]);
  }
  return out.length && out.length <= 64 ? out : null;
}

/**
 * A pgffor loop whose body only defines one global macro per item, by name: `\foreach \x in {A,...,Z}{\expandafter\xdef
 * \csname m\x\endcsname{\noexpand\mathbf{\x}}}`. The macros it makes (`\mA` is `\mathbf{A}`), or null when the loop is
 * anything else. An `\xdef` body may hold only `\noexpand`ed commands and the loop variable (else what it expands to
 * depends on other definitions); a `\gdef` body may not use the variable (it is not replaced when defining).
 */
function readForeachDefinitions(source: string, index: number): { end: number; macros: Array<{ name: string; body: string }> } | null {
  const head = /^\s*\\([A-Za-z]+)\s+in\s*\{([^{}]*)\}\s*/.exec(source.slice(index, index + 240));
  if (!head) return null;
  const variable = head[1];
  const items = foreachItems(head[2]);
  const group = items ? readGroup(source, index + head[0].length, TEX_GROUPS) : null;
  if (!items || !group) return null;
  const body = group.content.replace(/(^|[^\\])%[^\n]*/g, "$1");
  const definition = new RegExp(String.raw`\s*\\expandafter\s*(\\global\s*)?\\([gex]?def)\s*\\csname\s*([A-Za-z@]*)\s*\\${variable}(?![A-Za-z@])\s*([A-Za-z@]*)\s*\\endcsname\s*`, "y");
  const variableUse = new RegExp(String.raw`\\${variable}(?![A-Za-z@])`, "g");
  const templates: Array<{ prefix: string; suffix: string; body: string; expanded: boolean }> = [];
  let at = 0;
  while (at < body.length) {
    if (!body.slice(at).trim()) break;
    definition.lastIndex = at;
    const match = definition.exec(body);
    if (!match) return null;
    const kind = match[2];
    const value = readGroup(body, definition.lastIndex, TEX_GROUPS);
    if (!value) return null;
    const global = !!match[1] || kind === "gdef" || kind === "xdef";
    // A local definition is made in the loop's group and gone after it: nothing to read.
    if (global) {
      const expanded = kind === "xdef" || kind === "edef";
      if (expanded) {
        // Every command other than the variable is protected by \noexpand.
        const unprotected = value.content.replace(/\\noexpand\s*\\[A-Za-z@]+/g, "").replace(variableUse, "");
        if (/\\[A-Za-z@]/.test(unprotected)) return null;
      } else if (variableUse.test(value.content)) return null;
      variableUse.lastIndex = 0;
      templates.push({ prefix: match[3], suffix: match[4], body: value.content, expanded });
    }
    at = value.end;
  }
  if (!templates.length) return null;
  const macros: Array<{ name: string; body: string }> = [];
  for (const item of items) {
    for (const template of templates) {
      const text = template.expanded ? template.body.replace(/\\noexpand\s*/g, "").replace(variableUse, item) : template.body;
      macros.push({ name: `${template.prefix}${item}${template.suffix}`, body: text });
    }
  }
  return { end: group.end, macros };
}

/** Another file whose definitions apply, and where it is read: by the open file (`loadedBy: ""`), by another source, or first (no `loadedBy`). */
export type DefinitionSource = {
  path: string;
  text: string;
  /** Path of the source that loads it with `\input` or `\usepackage`; "" for the open file. */
  loadedBy?: string;
  /** How the loader names it: `input:macros` or `package:mystyle` (see `loadKey`). */
  key?: string;
};

/** The key a source is loaded by: `\input{dir/macros.tex}` is "input:dir/macros", `\usepackage{mine}` "package:mine". */
export function loadKey(kind: "input" | "package", name: string) {
  const trimmed = name.trim().replace(/^\.\//, "");
  return kind === "input" ? `input:${trimmed.replace(/\.(?:tex|ltx)$/i, "")}` : `package:${trimmed.replace(/\.sty$/i, "")}`;
}

type ReadOptions = {
  file?: string;
  offset?: number;
  bodyStart?: number;
  /** Position all of a file's definitions take (a file input in the body applies from its `\input`); -1 by default. */
  filePos?: number;
  /** Called where the source loads another file (`\input{name}`, `\usepackage{name}`), to read its definitions there. */
  load?: (key: string, at: number) => void;
};

type ReadContext = { defs: LatexDefinitions; file?: string; offset: number; bodyStart: number; filePos: number; theoremStyle: TheoremStyle };

function effectivePos(context: ReadContext, index: number) {
  // Definitions in the preamble or in other files apply to the whole body.
  if (context.file !== undefined) return context.filePos;
  return index < context.bodyStart ? -1 : context.offset + index;
}

/** Whether a body uses the command it defines (`\def\small{\@setsize\small{10pt}\ixpt\@ixpt}`). */
function selfReferent(name: string, body: string) {
  if (!body.includes(`\\${name}`)) return false;
  return new RegExp(`\\\\${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z@])`).test(body);
}

/**
 * LaTeX's commands the Visual mode draws itself. A package or class restyles them for the page
 * (neurips_2020.sty's `\section` is `\@startsection{section}{1}{\z@}…`, its `\small` a font size):
 * that does not change what they show. The document's own redefinitions do.
 */
const DRAWN_BUILTINS = new Set([
  "part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph", "appendix",
  "title", "author", "date", "thanks", "and", "maketitle", "caption", "label", "ref", "eqref", "cite", "footnote", "footnotemark", "footnotetext",
  "textbf", "textit", "textsl", "textsc", "texttt", "textsf", "textrm", "textup", "textmd", "textnormal", "emph", "underline", "textsuperscript", "textsubscript",
  "tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge", "Huge",
  "rm", "bf", "it", "sl", "sc", "tt", "sf", "em", "includegraphics", "href", "url", "item",
  // stackengine's stacks, drawn as stacked lines, and relsize's sizes, drawn by KaTeX (their definitions are box arithmetic).
  "stackanchor", "stackon", "stackunder", "mathlarger", "mathsmaller",
]);
const PACKAGE_FILE = /\.(?:sty|cls)$/i;
/** Formula commands the Visual mode draws itself when a document builds them from boxes (see math-render.ts's KATEX_MACROS). */
const BOX_BUILT = new Set(["widebar"]);

function addMacro(context: ReadContext, macro: Omit<LatexMacro, "fingerprint">, mode: "new" | "renew" | "provide"): LatexMacro | null {
  // A class's or package's font machinery (naaclhlt2019.sty's `\small`) passes the command itself as a token,
  // which expanding cannot follow: LaTeX's own meaning is drawn instead.
  if (!macro.alias && selfReferent(macro.name, macro.body)) return null;
  if (context.file !== undefined && PACKAGE_FILE.test(context.file) && DRAWN_BUILTINS.has(macro.name)) return null;
  // The same restyling written in the document (Mask R-CNN's `\renewcommand\paragraph{\@startsection{paragraph}…}`):
  // the kernel's page machinery, not something to draw.
  if (DRAWN_BUILTINS.has(macro.name) && /\\@(?:startsection|setfontsize|setsize|dottedtocline|xpt|ixpt)(?![A-Za-z@])/.test(macro.body)) return null;
  // Formula commands built from box arithmetic (the TeX.SX `\widebar`: `\@ifnextchar`, `\setbox`, `\mathaccent"0362`),
  // which expanding cannot follow: KaTeX draws a near equivalent (math-render.ts).
  if (BOX_BUILT.has(macro.name) && /\\(?:@ifnextchar|setbox|mathaccent|wide@bar)(?![A-Za-z])/.test(macro.body)) return null;
  const existing = context.defs.macros.get(macro.name);
  if (mode === "provide" && existing?.length) return null;
  const fingerprint = hashString(JSON.stringify([macro.name, macro.arity, macro.optional ?? null, macro.spec ?? null, macro.body, !!macro.mathOnly, !!macro.unsupported, !!macro.alias, mode === "provide"]));
  const list = existing ?? [];
  const added: LatexMacro = { ...macro, ...(mode === "provide" ? { provided: true } : {}), fingerprint };
  list.push(added);
  context.defs.macros.set(macro.name, list);
  return added;
}

/** Commands whose definitions are global whatever the group (`\gdef`, and xparse's, which are made with expl3's global `\cs_new`). */
const GLOBAL_DEFINITIONS = /^(?:gdef|xdef|DeclareMathOperator|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand)$/;

/**
 * Reads the definitions in `source` into `defs`. `bodyStart` is where the
 * document body begins in `source` (definitions after it apply from where
 * they are); `offset` is `source`'s position in the open file. `file` is set
 * for other files of the project, whose definitions apply everywhere.
 */
export function readLatexDefinitions(source: string, defs = emptyLatexDefinitions(), options: ReadOptions = {}) {
  const context: ReadContext = {
    defs, file: options.file, offset: options.offset ?? 0,
    bodyStart: options.bodyStart ?? (options.file !== undefined ? source.length : bodyStartOf(source)),
    filePos: options.filePos ?? -1,
    theoremStyle: "plain",
  };
  const scanner = new TexScanner(source);
  const pattern = new RegExp(DEFINITION.source, "g");
  for (let match: RegExpExecArray | null; (match = pattern.exec(source));) {
    const start = match.index;
    scanner.advance(start);
    // Inside a comment, verbatim text or `\verb`, or in a branch TeX skips: not run.
    if (scanner.pos > start || scanner.branch() === "skip") { if (scanner.pos > pattern.lastIndex) pattern.lastIndex = scanner.pos; continue; }
    const uncertain = scanner.branch() === "unknown";
    let index = start + match[0].length;
    const command = match[1];
    const note = (list: LatexDefinitionNote[], name: string, message: string) => list.push({ pos: context.offset + start, file: context.file, name, message });
    const starred = source[index] === "*";
    if (starred) index++;
    const pos = effectivePos(context, start);
    // `\global\def`, and LyX's `\global\long\def` (prefixes can come in any order).
    const global = GLOBAL_DEFINITIONS.test(command) || /\\global\s*(?:\\(?:long|protected|outer)\s*)*$/.test(source.slice(Math.max(0, start - 48), start));
    /** The end of what this definition reads; its body is not run now, so the scanner jumps over it. */
    let end: number | null = null;
    /** A definition without its body: any edit after it may complete it. */
    let broken = false;
    let added: LatexMacro | null = null;
    /** A definition that cannot be rendered still hides the earlier meaning of its name. */
    const shadow = (name: string, message: string) => {
      note(defs.unsupported, name, message);
      added = addMacro(context, { name, arity: 0, body: "", pos, file: context.file, unsupported: true }, "renew");
    };

    if (/^(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef)$/.test(command) && /\\WithSuffix\s*$/.test(source.slice(Math.max(0, start - 24), start))) {
      // suffix's `\WithSuffix\newcommand\foo*{…}` defines what `\foo*` does; `\foo` itself keeps its meaning. The body
      // is skipped (it is not run here), and the suffix is no missing body.
      const name = readCommandName(source, index);
      if (!name) continue;
      const open = /^[^{\\]{0,8}\{/.exec(source.slice(name.end, name.end + 12));
      const body = open ? readGroup(source, name.end + open[0].length - 1, TEX_GROUPS) : null;
      if (body) end = body.end;
      note(defs.unsupported, name.name, `\\${name.name} has a variant made with \\WithSuffix`);
    } else if (command === "newcommand" || command === "renewcommand" || command === "providecommand" || command === "DeclareRobustCommand") {
      const name = readCommandName(source, index);
      if (!name) continue;
      index = name.end;
      const count = readOptionalAt(source, index);
      let arity = 0;
      if (count) { arity = Number(count.content.trim()) || 0; index = count.end; }
      const optional = count ? readOptionalAt(source, index) : null;
      if (optional) index = optional.end;
      const body = readGroupAt(source, index);
      if (!body) { note(defs.problems, name.name, `\\${name.name} has no {…} body`); broken = true; if (uncertain) shadow(name.name, `\\${name.name} is defined under a condition`); }
      else {
        end = body.end;
        const highest = highestParameter(body.content);
        if (uncertain) shadow(name.name, `\\${name.name} is defined under a condition`);
        else if (highest > arity) note(defs.problems, name.name, `\\${name.name} uses #${highest} but takes ${arity} argument${arity === 1 ? "" : "s"}`);
        else added = addMacro(context, { name: name.name, arity, optional: optional ? optional.content : undefined, body: body.content, pos, file: context.file },
          command === "renewcommand" ? "renew" : command === "providecommand" ? "provide" : "new");
      }
    } else if (command === "def" || command === "gdef" || command === "edef" || command === "xdef") {
      const name = readCommandName(source, index);
      // `\xdef\csname m\x\endcsname{…}` defines a name made at run time, not `\csname`.
      if (!name || source[skipSpace(source, index)] === "{" || name.name === "csname") continue;
      index = name.end;
      const open = source.indexOf("{", index);
      if (open < 0) continue;
      const parameters = source.slice(index, open);
      const body = readGroup(source, open, TEX_GROUPS);
      if (!body) { note(defs.problems, name.name, `\\${name.name} has no {…} body`); broken = true; }
      else {
        end = body.end;
        // `\def\bea#1\eea{\begin{align}#1\end{align}}`: one argument up to a closing command, used once in the
        // body. That is an opening and a closing macro (`\bea` the body before #1, `\eea` the rest), as TeX reads a use.
        const pair = /^\s*#1\s*\\([A-Za-z@]+)\s*$/.exec(parameters);
        const halves = pair && !uncertain && command !== "edef" && command !== "xdef" ? body.content.split("#1") : null;
        if (pair && halves?.length === 2 && !halves.join("").includes("#") && pair[1] !== name.name) {
          added = addMacro(context, { name: name.name, arity: 0, body: halves[0], pos, file: context.file }, "renew");
          const closing = addMacro(context, { name: pair[1], arity: 0, body: halves[1], pos, file: context.file }, "renew");
          if (closing && !global) (scanner.innermost()?.locals ?? []).push(closing);
        } else if (command === "edef" || command === "xdef") shadow(name.name, `\\${command} is expanded when it is defined`);
        else if (!/^\s*(?:#[1-9]\s*)*$/.test(parameters)) shadow(name.name, `\\${name.name} has delimited parameters`);
        else if (uncertain) shadow(name.name, `\\${name.name} is defined under a condition`);
        else added = addMacro(context, { name: name.name, arity: (parameters.match(/#/g) ?? []).length, body: body.content, pos, file: context.file }, "renew");
      }
    } else if (command === "let") {
      const name = readCommandName(source, index);
      if (!name) continue;
      let after = skipSpace(source, name.end);
      if (source[after] === "=") after = skipSpace(source, after + 1);
      const target = /^\\([A-Za-z@]+|.)/.exec(source.slice(after, after + 80));
      if (!target) continue;
      end = after + target[0].length;
      if (uncertain) shadow(name.name, `\\${name.name} is defined under a condition`);
      else {
        // The meaning the target has here (its latest definition still in force).
        const list = defs.macros.get(target[1]) ?? [];
        let aliased: LatexMacro | undefined;
        for (let i = list.length - 1; i >= 0 && !aliased; i--) if (list[i].end === undefined || list[i].end! > context.offset + start) aliased = list[i];
        added = addMacro(context, aliased ? { ...aliased, name: name.name, pos, file: context.file, end: undefined, provided: undefined }
          : { name: name.name, arity: 0, body: `\\${target[1]}`, alias: true, pos, file: context.file }, "renew");
      }
    } else if (command === "DeclareMathOperator") {
      const name = readCommandName(source, index);
      if (!name) continue;
      const body = readGroupAt(source, name.end);
      if (!body) continue;
      end = body.end;
      if (uncertain) shadow(name.name, `\\${name.name} is defined under a condition`);
      else added = addMacro(context, { name: name.name, arity: 0, body: `\\operatorname${starred ? "*" : ""}{${body.content}}`, mathOnly: true, pos, file: context.file }, "new");
    } else if (command === "DeclarePairedDelimiter") {
      // mathtools' `\DeclarePairedDelimiter\abs{\lvert}{\rvert}`: `\abs{x}` at normal size, `\abs*{x}` grown to fit,
      // `\abs[\big]{x}` at a size given. An xparse macro with a star, an optional size and the content.
      const name = readCommandName(source, index);
      if (!name) continue;
      const left = readGroupAt(source, name.end);
      const right = left && readGroupAt(source, left.end);
      if (!left || !right) { note(defs.problems, name.name, `\\${name.name} needs its two delimiters`); broken = true; }
      else {
        end = right.end;
        const open = left.content.trim();
        const close = right.content.trim();
        if (uncertain) shadow(name.name, `\\${name.name} is defined under a condition`);
        else added = addMacro(context, {
          name: name.name, arity: 3, spec: [{ type: "s" }, { type: "o" }, { type: "m" }], mathOnly: true, pos, file: context.file,
          body: `\\IfBooleanTF{#1}{\\left${open} #3 \\right${close}}{\\IfNoValueTF{#2}{\\mathopen{${open}}#3\\mathclose{${close}}}{\\mathopen{#2${open}}#3\\mathclose{#2${close}}}}`,
        }, "new");
      }
    } else if (command === "newlist") {
      // enumitem's `\newlist{exercises}{enumerate}{6}`: a list of the document's own, of a known kind.
      const nameGroup = readGroupAt(source, index);
      const kind = nameGroup && readGroupAt(source, nameGroup.end);
      const levels = kind && readGroupAt(source, kind.end);
      if (nameGroup && kind && levels) {
        end = levels.end;
        const type = kind.content.trim().replace(/\*$/, "");
        if (type === "enumerate" || type === "itemize" || type === "description") (defs.lists ??= new Map()).set(nameGroup.content.trim(), type);
      }
    } else if (command === "setlist") {
      // `\setlist[exercises,1]{label=\thechapter.\arabic*}`: a level's label (and other options).
      const which = readOptionalAt(source, index);
      const options = readGroupAt(source, which?.end ?? index);
      if (which && options) {
        end = options.end;
        const [name, level] = which.content.split(",").map((part) => part.trim());
        if (name && /^\d+$/.test(level ?? "")) (defs.listOptions ??= new Map()).set(`${name}:${level}`, options.content.trim());
      }
    } else if (command === "foreach") {
      // pgffor's loop that defines one macro per letter (`\foreach \x in {A,...,Z}{\expandafter\xdef\csname m\x\endcsname
      // {\noexpand\mathbf{\x}}}`, `\mA` … `\mZ` in many theory papers): read as the macros it makes. Any other loop is not
      // a definition and is left alone.
      const loop = readForeachDefinitions(source, index);
      if (!loop) continue;
      end = loop.end;
      for (const macro of loop.macros) {
        if (uncertain) shadow(macro.name, `\\${macro.name} is defined under a condition`);
        else addMacro(context, { name: macro.name, arity: 0, body: macro.body, pos, file: context.file }, "renew");
      }
    } else if (/DocumentCommand$/.test(command)) {
      const name = readCommandName(source, index);
      if (!name) continue;
      const specGroup = readGroupAt(source, name.end);
      const body = specGroup && readGroupAt(source, specGroup.end);
      if (!specGroup || !body) { note(defs.problems, name.name, `\\${name.name} needs an argument specification and a body`); broken = true; }
      else {
        end = body.end;
        const spec = parseXparseSpec(specGroup.content);
        if (!spec) shadow(name.name, `\\${name.name} uses argument types other than m, o, O and s`);
        else if (uncertain) shadow(name.name, `\\${name.name} is defined under a condition`);
        else added = addMacro(context, { name: name.name, arity: spec.length, spec, body: body.content, pos, file: context.file },
          command.startsWith("Provide") ? "provide" : command.startsWith("New") ? "new" : "renew");
      }
    } else if (command === "newenvironment" || command === "renewenvironment" || command === "NewDocumentEnvironment" || command === "RenewDocumentEnvironment") {
      const nameGroup = readGroupAt(source, index);
      if (!nameGroup) continue;
      const name = nameGroup.content.trim();
      index = nameGroup.end;
      let arity = 0;
      let optional: string | undefined;
      let spec: XparseArgument[] | undefined;
      let supported = true;
      if (command.endsWith("DocumentEnvironment")) {
        const specGroup = readGroupAt(source, index);
        if (!specGroup) continue;
        const parsed = parseXparseSpec(specGroup.content);
        if (!parsed) { note(defs.unsupported, name, `${name} uses argument types other than m, o, O and s`); supported = false; }
        spec = parsed ?? undefined;
        arity = parsed?.length ?? 0;
        index = specGroup.end;
      } else {
        const count = readOptionalAt(source, index);
        if (count) { arity = Number(count.content.trim()) || 0; index = count.end; }
        const def = count ? readOptionalAt(source, index) : null;
        if (def) { optional = def.content; index = def.end; }
      }
      const begin = readGroupAt(source, index);
      const endCode = begin && readGroupAt(source, begin.end);
      if (!begin || !endCode) { note(defs.problems, name, `${name} needs begin and end code`); broken = true; }
      else {
        end = endCode.end;
        // An environment that cannot be rendered is left out; one under a condition too. A package or class that
        // restyles an existing one (neurips_2020.sty's `table`, for its caption skips) does not change what it shows.
        const restyled = /^[Rr]enew/.test(command) && context.file !== undefined && PACKAGE_FILE.test(context.file);
        if (!restyled) {
          if (uncertain) { note(defs.unsupported, name, `${name} is defined under a condition`); defs.environments.delete(name); }
          else if (supported) defs.environments.set(name, { name, arity, optional, spec, begin: begin.content, end: endCode.content, pos });
          else defs.environments.delete(name);
        }
      }
    } else if (command === "theoremstyle") {
      const style = readGroupAt(source, index);
      if (style) end = style.end;
      const value = style?.content.trim();
      if (value === "plain" || value === "definition" || value === "remark") context.theoremStyle = value;
    } else if (command === "newtheorem") {
      const nameGroup = readGroupAt(source, index);
      if (!nameGroup) continue;
      const name = nameGroup.content.trim();
      index = nameGroup.end;
      const shared = readOptionalAt(source, index);
      if (shared) index = shared.end;
      const title = readGroupAt(source, index);
      if (!title) continue;
      index = title.end;
      const within = shared ? null : readOptionalAt(source, index);
      end = within?.end ?? title.end;
      if (uncertain) { note(defs.unsupported, name, `${name} is defined under a condition`); defs.theorems.delete(name); }
      else defs.theorems.set(name, {
        name, title: title.content.trim(), counter: shared ? shared.content.trim() : name,
        within: within ? within.content.trim() : undefined, numbered: !starred, style: context.theoremStyle,
      });
    } else if (command === "newcounter") {
      const nameGroup = readGroupAt(source, index);
      if (!nameGroup) continue;
      const within = readOptionalAt(source, nameGroup.end);
      end = within?.end ?? nameGroup.end;
      if (within) defs.counterWithin.set(nameGroup.content.trim(), within.content.trim());
    } else if (command === "numberwithin" || command === "counterwithin") {
      const counter = readGroupAt(source, index);
      const within = counter && readGroupAt(source, counter.end);
      if (counter && within) {
        end = within.end;
        defs.counterWithin.set(counter.content.trim(), within.content.trim());
        // `\counterwithin*` resets only; the others also print the parent's number first.
        if (!(command === "counterwithin" && starred)) defs.counterPrefix.set(counter.content.trim(), within.content.trim());
      }
    } else if (command === "crefname" || command === "Crefname") {
      const type = readGroupAt(source, index);
      const singular = type && readGroupAt(source, type.end);
      const plural = singular && readGroupAt(source, singular.end);
      if (type && singular && plural) {
        end = plural.end;
        const key = command === "Crefname" ? `${type.content.trim()}:capital` : type.content.trim();
        defs.crefNames.set(key, { singular: singular.content, plural: plural.content, capital: command === "Crefname" });
      }
    } else if (command === "documentclass") {
      const options = readOptionalAt(source, index);
      const name = readGroupAt(source, options?.end ?? index);
      if (name) { end = name.end; defs.documentClass = name.content.trim(); }
    } else if (command === "usepackage" || command === "RequirePackage") {
      const packageOptions = readOptionalAt(source, index);
      const names = readGroupAt(source, packageOptions?.end ?? index);
      if (names) {
        end = names.end;
        for (const name of names.content.split(",")) {
          const trimmed = name.replace(/%[^\n]*/g, "").trim();
          if (!trimmed) continue;
          defs.packages.push(trimmed);
          if (packageOptions) defs.packageOptions.set(trimmed, packageOptions.content.replace(/%[^\n]*/g, "").split(",").map((option) => option.trim()).filter(Boolean));
          options.load?.(loadKey("package", trimmed), start);
        }
      }
    } else if (command === "input") {
      const name = readGroupAt(source, index);
      if (name) { end = name.end; options.load?.(loadKey("input", name.content), start); }
    } else if (command === "setcounter") {
      const counter = readGroupAt(source, index);
      const value = counter && readGroupAt(source, counter.end);
      if (counter && value && counter.content.trim() === "secnumdepth" && pos < 0 && /^\s*-?\d+\s*$/.test(value.content)) defs.secnumdepth = Number(value.content);
    } else if (command === "graphicspath") {
      const group = readGroupAt(source, index);
      if (group) {
        end = group.end;
        defs.graphicsPaths = [...group.content.matchAll(/\{([^{}]*)\}/g)].map((path) => path[1].trim()).filter(Boolean);
      }
    } else if (command === "newcolumntype") {
      // `\newcolumntype{L}[1]{…}`: a column letter, its arguments and its body.
      const letter = readGroupAt(source, index);
      const count = letter ? readOptionalAt(source, letter.end) : null;
      const body = letter ? readGroupAt(source, count?.end ?? letter.end) : null;
      if (letter && body && /^\s*[A-Za-z]\s*$/.test(letter.content)) {
        end = body.end;
        const arity = count ? Number(count.content.trim()) : 0;
        // Its base column, without the `>{…}`, `<{…}` and `@{…}` parts: `p{#1}`, `m{…}`, `b{…}` or `X` wrap.
        const base = body.content.replace(/[<>@!]\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
        const paragraph = /(?:^|[^\\A-Za-z])[pmb]\s*\{|(?:^|[^\\A-Za-z])X(?![A-Za-z])/.test(base);
        defs.columnTypes.set(letter.content.trim(), { arity: Number.isInteger(arity) && arity >= 0 && arity <= 9 ? arity : 0, align: columnTypeAlign(body.content), ...(paragraph ? { paragraph } : {}) });
      }
    } else if (command === "definecolor" || command === "colorlet") {
      // `\definecolor{myred}{RGB}{89,10,10}`, `\colorlet{accent}{red!60}`: names `\textcolor` and `\color` draw.
      const name = readGroupAt(source, index);
      const model = name && command === "definecolor" ? readGroupAt(source, name.end) : null;
      const value = name ? readGroupAt(source, model?.end ?? name.end) : null;
      if (name && value && (model || command === "colorlet")) {
        end = value.end;
        defs.colors.set(name.content.trim(), { model: model ? model.content.trim() : "", value: value.content.trim() });
      }
    }

    if (added && !global) (scanner.innermost()?.locals ?? []).push(added);
    if (broken && context.file === undefined) defs.extents.push({ from: context.offset + start, to: context.offset + source.length, broken: true });
    if (end !== null) {
      if (context.file === undefined) defs.extents.push({ from: context.offset + start, to: context.offset + end });
      // A definition's body is not run now: neither its groups nor its conditionals count.
      if (end > pattern.lastIndex) pattern.lastIndex = end;
      scanner.jump(end);
    }
  }
  scanner.advance(source.length);
  defs.fingerprint = definitionsFingerprint(defs);
  return defs;
}

export function definitionsFingerprint(defs: LatexDefinitions) {
  const parts: string[] = [];
  for (const [name, list] of defs.macros) parts.push(name, ...list.map((macro) => `${macro.fingerprint}@${macro.pos}-${macro.end ?? ""}`));
  for (const env of defs.environments.values()) parts.push(JSON.stringify(env));
  for (const thm of defs.theorems.values()) parts.push(JSON.stringify(thm));
  for (const [counter, within] of defs.counterWithin) parts.push(`${counter}<${within}`);
  for (const [counter, within] of defs.counterPrefix) parts.push(`${counter}<<${within}`);
  for (const [key, names] of defs.crefNames) parts.push(`${key}=${names.singular}/${names.plural}`);
  parts.push(defs.documentClass ?? "", String(defs.secnumdepth ?? ""), defs.graphicsPaths.join("|"));
  for (const [name, list] of defs.packageOptions) parts.push(`pkg:${name}:${list.join(",")}`);
  for (const [name, color] of defs.colors) parts.push(`color:${name}:${color.model}:${color.value}`);
  for (const [letter, type] of defs.columnTypes) parts.push(`col:${letter}:${type.arity}:${type.align}:${type.paragraph ? "p" : ""}`);
  for (const [name, kind] of defs.lists ?? []) parts.push(`list:${name}:${kind}`);
  for (const [level, options] of defs.listOptions ?? []) parts.push(`listopt:${level}:${options}`);
  return hashString(parts.join("\u0000"));
}

/**
 * Reads the definitions of other files and of the open file in TeX's reading
 * order: sources nobody loads first (a chapter's main file), then the open
 * file, each loaded source read where its loader `\input`s or `\usepackage`s it.
 */
export function collectLatexDefinitions(sources: readonly DefinitionSource[], open?: { text: string; bodyStart?: number }) {
  const defs = emptyLatexDefinitions();
  const byLoader = new Map<string, Map<string, DefinitionSource>>();
  for (const source of sources) {
    if (source.loadedBy === undefined || !source.key) continue;
    let keys = byLoader.get(source.loadedBy);
    if (!keys) byLoader.set(source.loadedBy, keys = new Map());
    if (!keys.has(source.key)) keys.set(source.key, source);
  }
  const read = new Set<string>();
  const loader = (path: string, depth: number) => (key: string, at: number) => {
    const source = byLoader.get(path)?.get(key);
    if (!source || read.has(source.path) || depth > 8 || read.size > 64) return;
    read.add(source.path);
    // A file the open file inputs in its body applies from there.
    const filePos = path === "" && open && at >= (open.bodyStart ?? bodyStartOf(open.text)) ? at : -1;
    readLatexDefinitions(source.text, defs, { file: source.path, filePos, load: loader(source.path, depth + 1) });
  };
  for (const source of sources) {
    if (source.loadedBy !== undefined || read.has(source.path)) continue;
    read.add(source.path);
    readLatexDefinitions(source.text, defs, { file: source.path, load: loader(source.path, 1) });
  }
  if (open) readLatexDefinitions(open.text, defs, { bodyStart: open.bodyStart, load: loader("", 1) });
  defs.fingerprint = definitionsFingerprint(defs);
  return defs;
}

/** Where the document body starts: after `\begin{document}`, or 0 for a chapter file without one. */
export function bodyStartOf(source: string) {
  const match = /\\begin\s*\{document\}/.exec(source);
  if (!match || inComment(source, match.index)) return 0;
  return match.index + match[0].length;
}

/** The definition of `name` that applies at `pos` in the open file (a local one only inside its group). */
export function macroAt(defs: LatexDefinitions, name: string, pos: number): LatexMacro | null {
  const list = defs.macros.get(name);
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].pos <= pos && (list[i].end === undefined || pos < list[i].end!)) return list[i];
  return null;
}

/** The definition body starting at `pos` in the open file, by binary search; null when none does (a broken definition has none). */
export function definitionExtentAt(defs: LatexDefinitions, pos: number) {
  const extents = defs.extents;
  let low = 0;
  let high = extents.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (extents[middle].from === pos) return extents[middle].broken ? null : extents[middle];
    if (extents[middle].from < pos) low = middle + 1; else high = middle - 1;
  }
  return null;
}

/** The definition body around `pos` (from < pos < to), if any; a broken definition's extent holds no body. */
export function definitionExtentAround(defs: LatexDefinitions, pos: number) {
  const extents = defs.extents;
  let low = 0;
  let high = extents.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (extents[middle].from < pos) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  const extent = found >= 0 ? extents[found] : null;
  return extent && !extent.broken && extent.to > pos ? extent : null;
}

type PositionMapper = { mapPos: (pos: number, assoc?: number) => number };

/**
 * The same definitions with their positions in the open file moved through an
 * edit that did not touch them. The fingerprint stays: the definitions are
 * the same, and so are the constructs they apply to.
 */
export function mapLatexDefinitions(defs: LatexDefinitions, changes: PositionMapper): LatexDefinitions {
  const map = (pos: number) => (pos < 0 ? pos : changes.mapPos(pos, 1));
  const macros = new Map<string, LatexMacro[]>();
  for (const [name, list] of defs.macros) macros.set(name, list.map((macro) => (macro.pos < 0 && macro.end === undefined ? macro : { ...macro, pos: map(macro.pos), end: macro.end === undefined ? undefined : map(macro.end) })));
  const environments = new Map<string, LatexEnvironmentDefinition>();
  for (const [name, env] of defs.environments) environments.set(name, env.pos < 0 ? env : { ...env, pos: map(env.pos) });
  const note = (item: LatexDefinitionNote) => (item.file !== undefined ? item : { ...item, pos: map(item.pos) });
  return {
    ...defs, macros, environments,
    extents: defs.extents.map((extent) => ({ from: map(extent.from), to: map(extent.to), ...(extent.broken ? { broken: true } : {}) })),
    problems: defs.problems.map(note), unsupported: defs.unsupported.map(note),
  };
}

/** How many macros and environments a summary counts (the latest definition of each name). */
export function definitionCounts(defs: LatexDefinitions) {
  return { macros: defs.macros.size, environments: defs.environments.size, theorems: defs.theorems.size, packages: new Set(defs.packages).size };
}

/** `\input`, `\include` and `\subfile` targets in a source (comments skipped), in order, with positions. */
export function readLatexInputs(source: string) {
  const inputs: Array<{ pos: number; command: string; path: string }> = [];
  for (const match of source.matchAll(/\\(input|include|subfile)\s*\{([^}]+)\}/g)) {
    if (inComment(source, match.index ?? 0)) continue;
    inputs.push({ pos: match.index ?? 0, command: match[1], path: match[2].trim() });
  }
  return inputs;
}

export { inComment as isInLatexComment };
