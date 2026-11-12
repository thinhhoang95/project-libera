import { hashString, readGroup, readOptional, TEX_GROUPS } from "../../macros/core";
import { classMacros, packageMacros, readAlgorithmBlock } from "./packages";
import { BRACED_CONDITIONAL, decideBracedConditional, decideConditional, TOGGLE_PREFIX, type ConditionalFacts } from "./conditionals";
import { findBeginDocument } from "../document-begin";

/* The document's own definitions, read the way TeX would read them, for the
 * Visual mode (docs/latex-visual-editor-plan.md §7). Only forms whose meaning
 * is certain are kept; anything else is listed as not rendered, and its uses
 * stay as source. Definitions in source TeX does not run (comments, verbatim,
 * `\verb`, the false branch of `\iffalse`, bodies of other definitions) are
 * not read; definitions under a conditional the reader cannot evaluate hide
 * any earlier meaning (their uses stay source); and local definitions end
 * with their group (`{…}`, `\begingroup…\endgroup`, an environment). */

/** An xparse argument: mandatory, optional (with a default), or a star. */
/** `g`/`G{default}`: an optional argument in braces (the paper's `\E{X}` or `\E{X}{\mu}`), as `o`/`O` are in brackets. */
/**
 * `t+`: a token or not (as `s` is a star); `r()`/`R(){default}`: a required argument between two delimiters, and
 * `d()`/`D(){default}` an optional one; `e{^_}`/`E{^_}{{a}{b}}`: embellishments, one argument per token, given in any
 * order (`group` ties a specification's tokens together). `v` (verbatim) is not read: its uses stay source.
 */
export type XparseArgument = { type: "m" } | { type: "o" } | { type: "O"; default: string } | { type: "s" } | { type: "g" } | { type: "G"; default: string }
  | { type: "t"; token: string } | { type: "r"; open: string; close: string } | { type: "d"; open: string; close: string }
  | { type: "R"; open: string; close: string; default: string } | { type: "D"; open: string; close: string; default: string }
  | { type: "e"; token: string; group: number; default?: string }
  /** A TeX `\def` parameter with a delimiter (`\def\set#1:#2{…}`): the tokens up to `delimiter`, outside braces. */
  | { type: "u"; delimiter: string };

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
  /** An unsupported definition TeX certainly makes (`\def\fullversion` with delimited parameters): `\ifx\fullversion\undefined` is false. */
  exists?: boolean;
  /** `\let\a\b` with `\b` not one of the document's macros: only a name for another command, whose arguments are unknown. */
  alias?: boolean;
  /** `\providecommand`: does nothing when the command already exists, which for LaTeX's own commands the reader cannot know. */
  provided?: boolean;
  file?: string;
  /** Written by the Visual mode for a package the document loads (macros/packages.ts), not by the document. */
  package?: string;
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

/** A `\newif` switch set at `pos` (as a macro's), until `end` when set in a group. */
export type LatexSwitchSetting = { pos: number; value: boolean | null; end?: number };

/** `paragraph`: a column whose cells wrap, as `p{…}` and tabularx's `X` do; the others are one line. */
export type LatexColumnType = { arity: number; align: "left" | "center" | "right"; paragraph?: boolean; math?: boolean };

/** How a `\newcolumntype` body aligns: `>{\centering}`, `>{\raggedleft}`, or its base column (`c`, `r`). */
function columnTypeAlign(body: string): LatexColumnType["align"] {
  if (/\\centering(?![A-Za-z@])/.test(body)) return "center";
  if (/\\raggedleft(?![A-Za-z@])/.test(body)) return "right";
  if (/\\raggedright(?![A-Za-z@])/.test(body)) return "left";
  // Without its `>{…}`, `<{…}` and `@{…}` parts, the base column's letter.
  const base = body.replace(/[<>@!]\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "").replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, "").replace(/[\s|]/g, "");
  return base[0] === "c" ? "center" : base[0] === "r" ? "right" : "left";
}

/** An acronym's or glossary entry's forms (a glossary entry's name is both its short and long form). */
export type LatexAcronym = { short: string; long: string; shortPlural?: string; longPlural?: string };

/** A `key=value, key={value}` list as a map (acro's `\DeclareAcronym{gpu}{short = GPU, long = …}`). */
function keyValues(list: string) {
  const values = new Map<string, string>();
  let depth = 0;
  let start = 0;
  const add = (part: string) => {
    const equals = part.indexOf("=");
    if (equals > 0) values.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim().replace(/^\{([\s\S]*)\}$/, "$1"));
  };
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "{") depth++;
    else if (list[i] === "}") depth--;
    else if (list[i] === "," && depth === 0) { add(list.slice(start, i)); start = i + 1; }
  }
  add(list.slice(start));
  return values;
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
  /** tcolorbox's `\newtcolorbox` and mdframed's `\newmdenv` boxes of the document and its packages, by environment name. */
  boxes?: Map<string, LatexBoxDefinition>;
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
   * Acronyms and glossary entries by key: glossaries' `\newacronym{gpu}{GPU}{graphics processing unit}` and
   * `\newglossaryentry{key}{name=…}`, acronym's `\acro{CNN}[CNN]{Convolutional Neural Network}`, acro's `\DeclareAcronym`.
   */
  acronyms?: Map<string, LatexAcronym>;
  /**
   * `\newif\ifdraft` switches (and ifthen's booleans) by conditional name, each setting in reading order: `\newif` makes
   * one false, `\drafttrue` sets it. null where it is set under a condition the reader cannot evaluate.
   */
  switches?: Map<string, LatexSwitchSetting[]>;
  /**
   * Names whose definition is commented out (`% \def\conference`): a version switch the author turned off, which
   * `\ifx\conference\undefined` finds undefined when nothing else defines it (cs.DS 2611.09172).
   */
  commentedOut?: Set<string>;
  /** `\documentclass[options]{…}`'s options. */
  classOptions?: string[];
  /** `\PassOptionsToPackage{options}{name}`: options the package is loaded with when it is loaded later. */
  passedOptions?: Map<string, string[]>;
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

const DEFINITION = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|xdef|let|DeclareMathOperator|DeclarePairedDelimiter|foreach|newlist|setlist|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|NewExpandableDocumentCommand|RenewExpandableDocumentCommand|ProvideExpandableDocumentCommand|DeclareExpandableDocumentCommand|PassOptionsToPackage|PassOptionsToClass|newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|newtheorem|theoremstyle|newcounter|numberwithin|counterwithin|crefname|Crefname|documentclass|usepackage|RequirePackage|input|setcounter|graphicspath|newcolumntype|definecolor|colorlet|algnewcommand|algrenewcommand|algdef|algblockdefx|algblock|algtext|SetKwFunction|SetKwInOut|SetKwInput|SetKwProg|SetKwData|SetKwBlock|SetKwFor|SetKw|newacronym|acro|newglossaryentry|DeclareAcronym|loop|DeclareOption|ProcessOptions|ExecuteOptions|declaretheorem|declaretheoremstyle|newtheoremstyle|DeclarePairedDelimiterX|DeclarePairedDelimiterXPP|DeclareMathAlphabet|DeclareMathSymbol|mathchardef)(?![A-Za-z@])/g;

/** Environments whose contents TeX reads as text, not commands. */
const VERBATIM_ENVIRONMENTS = /^(?:verbatim\*?|Verbatim\*?|BVerbatim|LVerbatim|lstlisting|minted|comment|filecontents\*?)$/;

/** `keep`: a group whose definitions TeX runs at the top level later (`\AtBeginDocument{…}`), so they do not end with it. */
/** `uncertain`: code TeX may or may not run (a package option's, when how the package is loaded is not known). */
/** `pass`: a braced test's branch (`\iftoggle{t}{…}{…}`), no group: its local definitions are the group's around it. */
type Frame = { kind: "brace" | "group" | "env"; locals: Array<{ end?: number; file?: string }>; keep?: boolean; uncertain?: boolean; pass?: boolean };
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
  /** Where a `\unless` ends, which turns the next conditional around; -1 when none. */
  private unless = -1;
  /** Whether the group at `deferredBrace` is run only maybe (see `Frame`). */
  private deferredUncertain = false;
  /**
   * The branches of braced tests (`\iftoggle{t}{yes}{no}`), by where their `{` is: a branch taken is no group (etoolbox
   * passes it on without its braces), so what it defines lasts; one not known is run maybe (true); one not taken is skipped
   * to its end (`skipped`).
   */
  private branchBraces = new Map<number, boolean>();
  private skipped = new Map<number, number>();
  /** What decides a conditional here (the definitions read so far): `\ifnum\llncs=0` with `\def\llncs{0}`. None: every test is unknown. */
  facts?: ConditionalFacts;
  /** Called where the source sets a `\newif` switch (`\newif\ifdraft`, `\drafttrue`); null under a condition not evaluated. */
  onSwitch?: (name: string, value: boolean | null, at: number) => void;
  private static SPECIAL = /[\\{}%]/g;
  constructor(readonly source: string) {}

  branch(): Branch {
    let unknown = this.frames.some((frame) => frame.uncertain);
    for (const conditional of this.conditionals) {
      const state = conditional.inElse ? conditional.second : conditional.first;
      if (state === "skip") return "skip";
      if (state === "unknown") unknown = true;
    }
    return unknown ? "unknown" : "run";
  }

  /** Whether the reader is inside a group run later at the top level (`\AtBeginDocument{…}`). */
  deferred() {
    return this.frames.some((frame) => frame.keep);
  }

  /** The innermost open group, which ends a local definition made now. */
  innermost(): Frame | null {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }

  jump(to: number) { if (to > this.pos) this.pos = to; }

  /** The `{` at `at` opens code run at the top level later (not a group), maybe only (`uncertain`). */
  deferBrace(at: number, uncertain: boolean) {
    this.deferredBrace = at;
    this.deferredUncertain = uncertain;
  }

  /** All of the source is code TeX may or may not run. */
  assumeUncertain() {
    this.frames.push({ kind: "group", locals: [], keep: true, uncertain: true });
  }

  private close(kind: Frame["kind"] | null, at: number) {
    // Closes the innermost frame of `kind` (any kind when null) and the frames opened inside it.
    let index = this.frames.length - 1;
    if (kind) while (index >= 0 && this.frames[index].kind !== kind) index--;
    if (index < 0) return;
    // A local definition of another file (a `\renewcommand` in a table of the main file's body) ends there, before the open file.
    const outer = index > 0 ? this.frames[index - 1] : null;
    for (const frame of this.frames.splice(index)) {
      // A braced test's branch is no group: its definitions belong to the group around it.
      if (frame.pass) outer?.locals.push(...frame.locals);
      else if (!frame.keep) for (const macro of frame.locals) macro.end ??= macro.file !== undefined ? -1 : at;
    }
  }

  /** Whether `\name` is a `\newif` switch: made in this source or in one read before. */
  private isSwitch(name: string) {
    return this.newifs.has(name) || this.facts?.switchState?.(name) !== undefined;
  }

  /** A switch set at `at` (`\drafttrue`, `\newif\ifdraft`), unknown under a condition the reader cannot evaluate. */
  private setSwitch(name: string, value: boolean, at: number) {
    this.onSwitch?.(name, this.branch() === "unknown" ? null : value, at);
  }

  /** Whether `\name` opens a conditional that a `\fi` closes; etoolbox's and biblatex's `\ifbool{…}{…}{…}` are macros. */
  private opensConditional(name: string) {
    if (PRIMITIVE_CONDITIONALS.has(name) || this.isSwitch(name)) return true;
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
          const skipTo = this.skipped.get(at);
          if (skipTo !== undefined) { this.pos = Math.max(this.pos, skipTo); continue; }
          const branch = this.branchBraces.get(at);
          if (branch !== undefined) { this.frames.push({ kind: "brace", locals: [], pass: true,...(branch ? { uncertain: true } : {}) }); continue; }
          const keep = at === this.deferredBrace;
          this.frames.push(keep ? { kind: "brace", locals: [], keep, ...(this.deferredUncertain ? { uncertain: true } : {}) } : { kind: "brace", locals: [] });
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
      if (name === "unless") { this.unless = this.pos; continue; }
      if (!skipping && BRACED_CONDITIONAL.test(name)) {
        // `\iftoggle{t}{\newcommand…}{…}`: the branch taken is read, the other skipped; both maybe when the test is not known.
        const decided = decideBracedConditional(source, this.pos, name, this.facts ?? { constant: () => undefined });
        if (decided) {
          const unknown = decided.value === null;
          if (unknown || decided.value) this.branchBraces.set(decided.yes.from, unknown); else this.skipped.set(decided.yes.from, decided.yes.to);
          if (unknown || !decided.value) this.branchBraces.set(decided.no.from, unknown); else this.skipped.set(decided.no.from, decided.no.to);
          continue;
        }
      }
      // (`\iff` is the formula's arrow, not a conditional.)
      if (/^if/.test(name) && name !== "ifthenelse" && name !== "iff" && this.opensConditional(name)) {
        // Under a false branch TeX only counts conditionals. Elsewhere one is decided when what it tests is known
        // (`\ifnum\llncs=0` after `\def\llncs{0}`, `\if0`, a `\newif` switch), else it is unknown.
        const decided = !skipping && this.facts ? decideConditional(source, this.pos, name, this.facts) : null;
        const value = decided ? decided.value !== (this.unless >= 0 && !source.slice(this.unless, at).trim()) : null;
        this.unless = -1;
        this.conditionals.push(skipping ? { first: "skip", second: "skip", inElse: false } : value === null ? { first: "unknown", second: "unknown", inElse: false }
          : { first: value ? "run" : "skip", second: value ? "skip" : "run", inElse: false });
        continue;
      }
      if (skipping) continue;
      if (name === "newif") {
        // `\newif\iffoo` defines a conditional (false); it does not open one.
        const next = /^\s*\\([A-Za-z@]+)/.exec(source.slice(this.pos, this.pos + 80));
        if (next) { this.pos += next[0].length; this.newifs.add(next[1]); this.setSwitch(next[1], false, at); }
      } else if (/^[A-Za-z@]+(?:true|false)$/.test(name) && this.isSwitch(`if${name.replace(/(?:true|false)$/, "")}`)) {
        // `\drafttrue` after `\newif\ifdraft`.
        this.setSwitch(`if${name.replace(/(?:true|false)$/, "")}`, name.endsWith("true"), at);
      } else if (name === "newboolean" || name === "provideboolean" || name === "setboolean") {
        // ifthen's booleans are `\newif` switches: `\newboolean{draft}` is `\ifdraft`, `\setboolean{draft}{true}` sets it.
        const args = /^\s*\{\s*([A-Za-z@]+)\s*\}(?:\s*\{\s*(true|false)\s*\})?/.exec(source.slice(this.pos, this.pos + 120));
        const switchName = args ? `if${args[1]}` : "";
        if (args && name !== "setboolean" && !(name === "provideboolean" && this.isSwitch(switchName))) { this.newifs.add(switchName); this.setSwitch(switchName, false, at); }
        else if (args?.[2] && this.isSwitch(switchName)) this.setSwitch(switchName, args[2] === "true", at);
        if (args) this.pos += args[0].length;
      } else if (/^(?:new|provide|set)(?:toggle|bool)$|^(?:toggle|bool)(?:true|false)$/.test(name)) {
        // etoolbox: `\newtoggle{long}` (false), `\toggletrue{long}`, `\settoggle{long}{true}`; its booleans are `\newif`
        // switches (`\newbool{draft}` is `\ifdraft`).
        const args = (name.startsWith("set") ? /^\s*\{\s*([A-Za-z@]+)\s*\}\s*\{\s*(true|false)\s*\}/ : /^\s*\{\s*([A-Za-z@]+)\s*\}()/).exec(source.slice(this.pos, this.pos + 120));
        if (args) {
          this.pos += args[0].length;
          const switchName = name.includes("toggle") ? `${TOGGLE_PREFIX}${args[1]}` : `if${args[1]}`;
          if (name.startsWith("new") || (name.startsWith("provide") && !this.isSwitch(switchName))) { this.newifs.add(switchName); this.setSwitch(switchName, false, at); }
          else if (name.startsWith("set")) { if (args[2] && this.isSwitch(switchName)) this.setSwitch(switchName, args[2] === "true", at); }
          else if (!name.startsWith("provide") && this.isSwitch(switchName)) this.setSwitch(switchName, name.endsWith("true"), at);
        }
      } else if (DEFERRED_TOP_LEVEL.test(name)) {
        const open = /^\s*\{/.exec(source.slice(this.pos, this.pos + 40));
        if (open) this.deferBrace(this.pos + open[0].length - 1, false);
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

/**
 * The parameter text of a `\def` with delimiters (`#1:#2`, `#1.`) as argument types: each `#n` in order with the
 * delimiter after it, if any. Null when TeX's rules are not met (parameters numbered in order, nothing before `#1`),
 * a delimiter is not plain characters, or the body uses a parameter that is not there.
 */
function delimitedSpec(parameters: string, body: string): XparseArgument[] | null {
  const text = parameters.trim();
  if (!text.startsWith("#")) return null;
  const spec: XparseArgument[] = [];
  const pattern = /#([1-9])([^#{}%]*)/y;
  for (let next = 1; pattern.lastIndex < text.length;) {
    const match = pattern.exec(text);
    if (!match || Number(match[1]) !== next++) return null;
    const delimiter = match[2].trim();
    if (/\\par(?![A-Za-z@])/.test(delimiter)) return null;
    spec.push(delimiter ? { type: "u", delimiter } : { type: "m" });
  }
  return spec.length && highestParameter(body) <= spec.length ? spec : null;
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
    else if (char === "g") args.push({ type: "g" });
    else if (char === "O" || char === "G") {
      const group = readGroup(spec, index + 1);
      if (!group) return null;
      args.push({ type: char, default: group.content });
      index = group.end;
      continue;
    } else if (char === "t") {
      // One token: a character, or a braced one (`t{+}`).
      const token = /^(?:\{([^{}\\\s])\}|([^{}\\\s]))/.exec(spec.slice(index + 1));
      if (!token) return null;
      args.push({ type: "t", token: token[1] ?? token[2] });
      index += 1 + token[0].length;
      continue;
    } else if (char === "r" || char === "R" || char === "d" || char === "D") {
      // Two delimiter characters (a control sequence as a delimiter is not read), then R's and D's default.
      const delimiters = /^([^{}\\\s])([^{}\\\s])/.exec(spec.slice(index + 1));
      if (!delimiters || delimiters[1] === delimiters[2]) return null;
      index += 3;
      if (char === "R" || char === "D") {
        const group = readGroup(spec, index);
        if (!group) return null;
        args.push({ type: char, open: delimiters[1], close: delimiters[2], default: group.content });
        index = group.end;
      } else args.push({ type: char, open: delimiters[1], close: delimiters[2] });
      continue;
    } else if (char === "e" || char === "E") {
      const tokens = readGroup(spec, index + 1);
      if (!tokens || !/^[^{}\\\s]+$/.test(tokens.content.replace(/\s/g, ""))) return null;
      const list = [...tokens.content.replace(/\s/g, "")];
      index = tokens.end;
      const defaults: string[] = [];
      if (char === "E") {
        const group = readGroup(spec, index);
        if (!group) return null;
        index = group.end;
        for (let at = 0; at < group.content.length;) {
          const item = readGroup(group.content, at) ?? (/^\s+/.test(group.content.slice(at)) ? null : undefined);
          if (item === undefined) return null;
          if (item === null) { at++; continue; }
          defaults.push(item.content);
          at = item.end;
        }
      }
      for (const [n, token] of list.entries()) args.push({ type: "e", token, group: index, ...(defaults[n] !== undefined ? { default: defaults[n] } : {}) });
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

/** Most passes a `\loop` is run for here, and most macros it may make. */
const MAX_LOOP_PASSES = 64;
const MAX_LOOP_MACROS = 256;

/**
 * Plain TeX's `\loop … \repeat` that makes one macro per pass by name, the way a preamble builds `\cA`…`\cZ` (2611.13390):
 * a counter stepped each pass, `\edef\X{\@Alph\c@ctr}` for the letter, and `\expandafter\factory\X` calling a macro
 * `\def\factory#1{\expandafter\def\csname c#1\endcsname{\mathcal{#1}}}` (or the same `\csname` definition written in the
 * loop with `\X`). The macros it makes, in order, or null for any other shape: only these statements, a test of a counter
 * against a number last, a bounded number of passes. Nothing is run beyond that.
 */
function readLoopDefinitions(source: string, index: number, before: string, factory: (name: string) => LatexMacro | undefined): Array<{ name: string; body: string }> | null {
  const close = loopEnd(source, index);
  if (close < 0) return null;
  const raw = source.slice(index, close - "\\repeat".length).replace(/(^|[^\\])%[^\n]*/g, "$1");
  const test = /\\ifnum\s*(?:\\the\s*\\c@([A-Za-z@]+)|\\value\s*\{([A-Za-z@]+)\}|\\c@([A-Za-z@]+)|\\the([A-Za-z@]+)|\\([A-Za-z@]+))\s*([<>=])\s*(-?\d{1,6})\s*(?:\\relax)?\s*$/.exec(raw);
  if (!test) return null;
  const subject = test[1] ?? test[2] ?? test[3] ?? test[4] ?? test[5];
  const limit = Number(test[7]);
  const body = raw.slice(0, test.index);
  const counters = new Map<string, number>();
  /** A counter's or count register's value when the loop starts: set before it, or 0 from `\newcounter`/`\newcount`. */
  const initial = (name: string): number | null => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lastNumber = (pattern: RegExp) => { let found: string | null = null; for (const match of before.matchAll(pattern)) found = match[1]; return found === null ? null : Number(found); };
    const set = lastNumber(new RegExp(String.raw`\\setcounter\s*\{${escaped}\}\s*\{\s*(-?\d{1,6})\s*\}`, "g")) ?? lastNumber(new RegExp(String.raw`\\${escaped}\s*=\s*(-?\d{1,6})`, "g"));
    if (set !== null) return set;
    return new RegExp(String.raw`\\newcounter\s*\{${escaped}\}|\\newcount\s*\\${escaped}(?![A-Za-z@])`).test(before) ? 0 : null;
  };
  const read = (name: string) => {
    if (!counters.has(name)) {
      const value = initial(name);
      if (value === null) return null;
      counters.set(name, value);
    }
    return counters.get(name)!;
  };
  if (read(subject) === null) return null;
  const letters = new Map<string, string>();
  const macros: Array<{ name: string; body: string }> = [];
  const protectedBody = (text: string, variable: string | null, value: string) => {
    let out = text.replace(/\\noexpand\s*(\\[A-Za-z@]+)/g, "\u0001$1\u0001");
    if (variable) out = out.replace(new RegExp(String.raw`\\${variable}(?![A-Za-z@])`, "g"), value);
    // What is left unprotected must not be a command that expands further.
    if (/\\[A-Za-z@]/.test(out.replace(/\u0001\\[A-Za-z@]+\u0001/g, ""))) return null;
    return out.replace(/\u0001/g, "");
  };
  const make = (kind: string, prefix: string, middle: string, suffix: string, text: string, variable: string | null) => {
    const value = variable ? letters.get(variable)! : "";
    let content = text;
    if (kind === "edef" || kind === "xdef") {
      const protectedText = protectedBody(text, variable, value);
      if (protectedText === null) return false;
      content = protectedText;
    } else if (variable && new RegExp(String.raw`\\${variable}(?![A-Za-z@])`).test(text)) return false;
    macros.push({ name: `${prefix}${middle}${suffix}`, body: content });
    return true;
  };
  const sticky = (pattern: string) => new RegExp(String.raw`\s*${pattern}`, "y");
  const step = sticky(String.raw`\\(?:step|refstep)counter\s*\{([A-Za-z@]+)\}`);
  const addSet = sticky(String.raw`\\(add|set)tocounter\s*\{([A-Za-z@]+)\}\s*\{\s*(-?\d{1,6})\s*\}`);
  const advance = sticky(String.raw`(?:\\global\s*)?\\advance\s*\\([A-Za-z@]+)\s*(?:by\s*)?(-?\d{1,6})\s*(?:\\relax)?`);
  const variable = sticky(String.raw`(?:\\global\s*)?\\(edef|xdef)\s*\\([A-Za-z@]+)\s*\{\s*(?:\\@?(Alph|alph|arabic)\s*(?:\\c@([A-Za-z@]+)|\{([A-Za-z@]+)\})|\\the\s*\\c@([A-Za-z@]+)|\\the([A-Za-z@]+))\s*\}`);
  const called = sticky(String.raw`\\expandafter\s*\\([A-Za-z@]+)\s*\\([A-Za-z@]+)`);
  const named = sticky(String.raw`\\expandafter\s*(?:\\global\s*)?\\(def|gdef|edef|xdef)\s*\\csname\s*([A-Za-z@]*)\\([A-Za-z@]+)(?![A-Za-z@])\s*([A-Za-z@]*)\s*\\endcsname\s*`);
  for (let pass = 0; ; pass++) {
    if (pass >= MAX_LOOP_PASSES) return null;
    let at = 0;
    while (at < body.length) {
      if (!body.slice(at).trim()) break;
      const at0 = at;
      const take = (pattern: RegExp) => { pattern.lastIndex = at0; const found = pattern.exec(body); if (found) at = pattern.lastIndex; return found; };
      let m: RegExpExecArray | null;
      if ((m = take(step))) {
        const value = read(m![1]);
        if (value === null) return null;
        counters.set(m![1], value + 1);
      } else if ((m = take(addSet))) {
        const value = read(m![2]);
        if (value === null) return null;
        counters.set(m![2], m![1] === "add" ? value + Number(m![3]) : Number(m![3]));
      } else if ((m = take(advance))) {
        const value = read(m![1]);
        if (value === null) return null;
        counters.set(m![1], value + Number(m![2]));
      } else if ((m = take(variable))) {
        const style = m![3] ?? "arabic";
        const counter = m![4] ?? m![5] ?? m![6] ?? m![7];
        const value = read(counter);
        if (value === null) return null;
        if (style === "arabic") letters.set(m![2], String(value));
        else if (value >= 1 && value <= 26) letters.set(m![2], String.fromCharCode((style === "Alph" ? 64 : 96) + value));
        else return null;
      } else if ((m = take(called))) {
        const item = letters.get(m![2]);
        const macro = item === undefined ? undefined : factory(m![1]);
        if (item === undefined || !macro || macro.arity !== 1 || macro.optional !== undefined || macro.spec || macro.unsupported || macro.alias || macro.body.includes("##")) return null;
        const factoryBody = macro.body.replace(/(^|[^\\])%[^\n]*/g, "$1");
        const header = /^\s*\\expandafter\s*(?:\\global\s*)?\\(def|gdef|edef|xdef)\s*\\csname\s*([A-Za-z@]*)#1([A-Za-z@]*)\s*\\endcsname\s*/.exec(factoryBody);
        const value = header && readGroup(factoryBody, header[0].length, TEX_GROUPS);
        if (!header || !value || factoryBody.slice(value.end).trim()) return null;
        // The argument is put in when the factory runs, then the definition is read as written.
        if (!make(header[1], header[2], item, header[3], value.content.replace(/#1/g, item), null)) return null;
      } else if ((m = take(named))) {
        const value = letters.has(m![3]) ? readGroup(body, at, TEX_GROUPS) : null;
        if (!value) return null;
        if (!make(m![1], m![2], letters.get(m![3])!, m![4], value.content, m![3])) return null;
        at = value.end;
      } else return null;
      if (macros.length > MAX_LOOP_MACROS) return null;
    }
    const value = read(subject)!;
    const again = test[6] === "<" ? value < limit : test[6] === ">" ? value > limit : value === limit;
    if (!again) return macros.length ? macros : null;
  }
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
  /** Code TeX may or may not run (a package option's, when how the package is loaded is not known): read as under a condition. */
  uncertain?: boolean;
};

/** `deferred`: the definition being read is in `\AtBeginDocument{…}` (it runs after the packages' own hooks). */
type ReadContext = { defs: LatexDefinitions; file?: string; offset: number; bodyStart: number; filePos: number; theoremStyle: TheoremStyle; deferred?: boolean };

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
  // Citations and references, which a template's own natbib.sty or hyperref.sty defines (ICLR's and ACL's ship natbib.sty).
  "citep", "citet", "citealt", "citealp", "citeauthor", "Citeauthor", "citeyear", "citeyearpar", "Citet", "Citep", "Citealt", "Citealp", "citenum", "citetext",
  "textcite", "Textcite", "parencite", "Parencite", "autocite", "Autocite", "footcite", "nocite",
  "cref", "Cref", "crefrange", "Crefrange", "autoref", "Autoref", "nameref", "pageref", "vref", "vpageref",
  "textbf", "textit", "textsl", "textsc", "texttt", "textsf", "textrm", "textup", "textmd", "textnormal", "emph", "underline", "textsuperscript", "textsubscript",
  "tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge", "Huge",
  "rm", "bf", "it", "sl", "sc", "tt", "sf", "em", "includegraphics", "href", "url", "item",
  // stackengine's stacks, drawn as stacked lines, and relsize's sizes, drawn by KaTeX (their definitions are box arithmetic).
  "stackanchor", "stackon", "stackunder", "mathlarger", "mathsmaller",
]);
const PACKAGE_FILE = /\.(?:sty|cls)$/i;
/** Formula commands the Visual mode draws itself when a document builds them from boxes (see math-render.ts's KATEX_MACROS). */
const BOX_BUILT = new Set(["widebar"]);
/** TeX's sized delimiters, which documents wrap for spacing (mleftright's idiom). */
const SIZED_DELIMITERS = new Set(["left", "right", "middle"]);

/** Whether `body` uses a `\let` copy of LaTeX's own `\name` (`\oldparagraph` after `\let\oldparagraph\paragraph`). */
function callsSavedOriginal(defs: LatexDefinitions, name: string, body: string) {
  for (const use of body.matchAll(/\\([A-Za-z@]+)/g)) {
    const saved = defs.macros.get(use[1])?.at(-1);
    if (saved?.alias && saved.body === `\\${name}`) return true;
  }
  return false;
}

function addMacro(context: ReadContext, macro: Omit<LatexMacro, "fingerprint">, mode: "new" | "renew" | "provide"): LatexMacro | null {
  // A class's or package's font machinery (naaclhlt2019.sty's `\small`) passes the command itself as a token,
  // which expanding cannot follow: LaTeX's own meaning is drawn instead.
  if (!macro.alias && selfReferent(macro.name, macro.body)) return null;
  if (context.file !== undefined && PACKAGE_FILE.test(context.file) && DRAWN_BUILTINS.has(macro.name)) return null;
  // The same restyling written in the document (Mask R-CNN's `\renewcommand\paragraph{\@startsection{paragraph}…}`):
  // the kernel's page machinery, not something to draw.
  if (DRAWN_BUILTINS.has(macro.name) && /\\@(?:startsection|setfontsize|setsize|dottedtocline|xpt|ixpt)(?![A-Za-z@])/.test(macro.body)) return null;
  // hyperref sets `\ref` and `\pageref` again at `\begin{document}`: a preamble redefinition (a thesis's
  // `\renewcommand{\ref}{\hyperref}`) is undone, so the references are drawn as references.
  if ((macro.name === "ref" || macro.name === "pageref") && macro.pos < 0 && !context.deferred && context.defs.packages.includes("hyperref")) return null;
  // Formula commands built from box arithmetic (the TeX.SX `\widebar`: `\@ifnextchar`, `\setbox`, `\mathaccent"0362`),
  // which expanding cannot follow: KaTeX draws a near equivalent (math-render.ts).
  if (BOX_BUILT.has(macro.name) && /\\(?:@ifnextchar|setbox|mathaccent|wide@bar)(?![A-Za-z])/.test(macro.body)) return null;
  // A drawn command wrapped around its saved self (2107.05853's `\let\oldparagraph\paragraph`
  // `\renewcommand{\paragraph}[1]{\oldparagraph{#1.}}`): LaTeX's own is drawn (a heading), without what the wrapper adds.
  if (DRAWN_BUILTINS.has(macro.name) && !macro.alias && callsSavedOriginal(context.defs, macro.name, macro.body)) return null;
  // mleftright's spacing fix written out (2611.09172's `\let\originalleft\left`, then `\renewcommand{\left}{\mathopen{}
  // \mathclose\bgroup\originalleft}` and `\renewcommand{\right}{\aftergroup\egroup\originalright}`): TeX's group tricks
  // around the saved delimiter, which a formula renderer cannot run. TeX's own `\left` and `\right` are drawn.
  if (SIZED_DELIMITERS.has(macro.name) && !macro.alias && callsSavedOriginal(context.defs, macro.name, macro.body) && /\\(?:aftergroup|bgroup|egroup|mathopen|mathclose)(?![A-Za-z@])/.test(macro.body)) return null;
  const existing = context.defs.macros.get(macro.name);
  if (mode === "provide" && existing?.length) return null;
  const fingerprint = hashString(JSON.stringify([macro.name, macro.arity, macro.optional ?? null, macro.spec ?? null, macro.body, !!macro.mathOnly, !!macro.unsupported, !!macro.alias, mode === "provide"]));
  const list = existing ?? [];
  const added: LatexMacro = { ...macro, ...(mode === "provide" ? { provided: true } : {}), fingerprint };
  list.push(added);
  context.defs.macros.set(macro.name, list);
  return added;
}

/** What a macro without arguments stands for when it is a plain constant (`\def\llncs{0}`), which conditionals may test. */
function constantOf(macro: LatexMacro | null | undefined) {
  return macro && !macro.unsupported && !macro.alias && !macro.provided && !macro.arity && !macro.spec && !macro.mathOnly && macro.body.length <= 64 && !/[\\{}#%$&^_~]/.test(macro.body) ? macro.body : undefined;
}

/** A body that defines a macro named by an argument (`\newcommand{\newmathabbrev}[2]{\newcommand{#1}{\mathrm{#2}}}`). */
const DEFINER_BODY = /^\s*\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|DeclareMathOperator)\*?\s*(?:\{\s*#[1-9]\s*\}|#[1-9])/;
function definerOf(macro: LatexMacro | undefined) {
  return !!macro && !macro.unsupported && !macro.alias && macro.arity > 0 && !macro.spec && macro.optional === undefined && DEFINER_BODY.test(macro.body);
}

/** The definition commands, and the uses of the document's definers (named by letters). */
function definitionPattern(definers: ReadonlySet<string>) {
  const names = [...definers].filter((name) => /^[A-Za-z@]+$/.test(name));
  return new RegExp(names.length ? String.raw`${DEFINITION.source}|\\(${names.join("|")})(?![A-Za-z@])` : DEFINITION.source, "g");
}

/** One undelimited argument at `index`: a group's content, a command, or a character; null at a paragraph's end. */
function readArgumentAt(source: string, index: number) {
  const at = skipSpace(source, index);
  if (source[at] === "{") return readGroup(source, at, TEX_GROUPS);
  const token = /^(?:\\[A-Za-z@]+|\\[^A-Za-z@\s]|[^\s{}%\\])/.exec(source.slice(at, at + 80));
  return token ? { content: token[0], end: at + token[0].length } : null;
}

/** A `\newcommand` body written without braces, one token on the definition's line (`\newcommand\cfont\mathsf`, `\newcommand{\x}\alpha`). */
function unbracedBody(source: string, index: number) {
  const token = /^[ \t]*(\\[A-Za-z@]+|\\[^A-Za-z@\s]|[^\s{}%\\[])/.exec(source.slice(index, index + 80));
  if (!token || /^\\(?:begin|end|par)$/.test(token[1])) return null;
  return { content: token[1], end: index + token[0].length };
}

/** Where plain TeX's `\loop … \repeat` that starts at `index` ends (its body is the text up to `\repeat`, outside groups); -1 when it does not. */
function loopEnd(source: string, index: number) {
  let depth = 0;
  for (let i = index; i < source.length; i++) {
    const char = source[i];
    if (char === "%") { const end = source.indexOf("\n", i); if (end < 0) return -1; i = end; continue; }
    if (char === "{") depth++;
    else if (char === "}") { if (--depth < 0) return -1; }
    else if (char === "\\") {
      const word = /^\\(?:[A-Za-z@]+|[\s\S])/.exec(source.slice(i, i + 40))!;
      if (word[0] === "\\repeat" && depth === 0) return i + word[0].length;
      i += word[0].length - 1;
    }
  }
  return -1;
}

/**
 * Whether the package or class `context.file` was loaded with `option` (`\usepackage[accepted]{icml2020}`), the
 * class's options counting for every package as LaTeX's do; null when how it was loaded is not known.
 */
function optionGiven(context: ReadContext, option: string): boolean | null {
  const file = context.file !== undefined ? /^(.*)\.(sty|cls)$/i.exec(context.file) : null;
  if (!file) return null;
  const named = (name: string) => file[1] === name || file[1].endsWith(`/${name}`);
  const classOptions = context.defs.classOptions ?? [];
  if (file[2].toLowerCase() === "cls") return context.defs.documentClass !== null && named(context.defs.documentClass) ? classOptions.includes(option) : null;
  const loaded = context.defs.packages.find(named);
  if (loaded === undefined) return null;
  return (context.defs.packageOptions.get(loaded) ?? []).includes(option) || classOptions.includes(option);
}

/** thmtools' and amsthm's theorem styles the document makes (`\newtheoremstyle{named}…`, `\declaretheoremstyle[…]{mythm}`), by name. */
const documentTheoremStyles = new WeakMap<LatexDefinitions, Map<string, TheoremStyle>>();

/**
 * The look of a theorem style the document makes, as one of amsthm's three: an italic body is `plain`, an italic
 * head `remark`, anything else `definition` (an upright body under a bold head).
 */
function styleOfFonts(bodyFont: string, headFont: string): TheoremStyle {
  if (/\\(?:itshape|slshape|em|it|sl|textit|emph)(?![A-Za-z])/.test(bodyFont)) return "plain";
  if (/\\(?:itshape|slshape|it|sl|textit)(?![A-Za-z])/.test(headFont) && !/\\(?:bfseries|bf|textbf)(?![A-Za-z])/.test(headFont)) return "remark";
  return "definition";
}

/** A theorem style named in the document: amsthm's three, thmtools' `theorem` (plain), or one the document made. */
function theoremStyleNamed(defs: LatexDefinitions, name: string): TheoremStyle | null {
  if (name === "plain" || name === "definition" || name === "remark") return name;
  if (name === "theorem") return "plain";
  return documentTheoremStyles.get(defs)?.get(name) ?? null;
}

/** `key=value` options (`name=Theorem, numberwithin=section`), values without their braces. */
function optionValues(text: string) {
  const options = new Map<string, string>();
  let depth = 0;
  let item = "";
  const flush = () => {
    const pair = /^\s*([A-Za-z]+)\s*(?:=\s*([\s\S]*?))?\s*$/.exec(item);
    if (pair) options.set(pair[1].toLowerCase(), (pair[2] ?? "").replace(/^\{([\s\S]*)\}$/, "$1").trim());
    item = "";
  };
  for (const char of text) {
    if (char === "{") depth++;
    else if (char === "}") depth--;
    if (char === "," && depth === 0) flush(); else item += char;
  }
  flush();
  return options;
}

/** Math fonts a `\DeclareMathAlphabet` may name, by NFSS family, and the KaTeX alphabet each is drawn with. */
function mathAlphabetBody(encoding: string, family: string, series: string, shape: string): string | null {
  const bold = /^(?:sb|b|bx|eb|ub)$/.test(series.trim());
  const italic = /^(?:it|sl)$/.test(shape.trim());
  const name = family.trim();
  let kind: "rm" | "sf" | "tt" | "cal" | "scr" | "frak" | "bb" | null = null;
  if (/^\\rmdefault$|^(?:cmr|lmr|ptm|ppl|pnc|pbk|txr|pxr|bch|cmdh|cmfib)$/.test(name)) kind = "rm";
  else if (/^\\sfdefault$|^(?:cmss|lmss|phv|uhv|fvs|cmbr|iwona|txss|pxss)$/.test(name)) kind = "sf";
  else if (/^\\ttdefault$|^(?:cmtt|lmtt|pcr|txtt|pxtt)$/.test(name)) kind = "tt";
  // Calligraphic: the OMS encoding's math symbols (`\pazocal` from zplm), Euler script.
  else if (encoding.trim() === "OMS" || /^(?:eus|cmsy|zplm|zpsy)$/.test(name)) kind = "cal";
  // Zapf Chancery (`\mathpzc`) and RSFS are script letters.
  else if (/^(?:pzc|rsfs|rsfso)$/.test(name)) kind = "scr";
  else if (/^(?:euf|yfrak|ygoth)$/.test(name)) kind = "frak";
  else if (/^(?:bbm|bbmss|msb|bbold|dsrom|dsss)$/.test(name)) kind = "bb";
  if (!kind) return null;
  if (kind === "rm") return bold && italic ? "\\boldsymbol{#1}" : bold ? "\\mathbf{#1}" : italic ? "\\mathit{#1}" : "\\mathrm{#1}";
  // KaTeX has no bold sans letters in formulas: bold is what tells them apart (the paper's `\mathbfsf` for tensors).
  if (kind === "sf") return bold ? "\\mathbf{#1}" : italic ? "\\mathsfit{#1}" : "\\mathsf{#1}";
  return { tt: "\\mathtt{#1}", cal: "\\mathcal{#1}", scr: "\\mathscr{#1}", frak: "\\mathfrak{#1}", bb: "\\mathbb{#1}" }[kind];
}

/** Computer Modern's Greek letters by position: upright capitals in `operators` and `letters` (0–10), italic lower case in `letters` (11–39). */
const GREEK_CAPITALS = ["Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega"];
const GREEK_LOWER = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega", "varepsilon", "vartheta", "varpi", "varrho", "varsigma", "varphi"];
/** The large operators of Computer Modern's extension font, by position (text and display sizes). */
const LARGE_SYMBOLS: Record<number, string> = { 0x50: "\\sum", 0x58: "\\sum", 0x51: "\\prod", 0x59: "\\prod", 0x52: "\\int", 0x5a: "\\int", 0x53: "\\bigcup", 0x5b: "\\bigcup", 0x54: "\\bigcap", 0x5c: "\\bigcap", 0x56: "\\bigwedge", 0x5e: "\\bigwedge", 0x57: "\\bigvee", 0x5f: "\\bigvee", 0x60: "\\coprod", 0x61: "\\coprod" };
const MATH_CLASSES: Record<string, string> = { mathord: "", mathalpha: "", mathop: "\\mathop", mathbin: "\\mathbin", mathrel: "\\mathrel", mathopen: "\\mathopen", mathclose: "\\mathclose", mathpunct: "\\mathpunct" };

/**
 * A math symbol by its font and position (`\DeclareMathSymbol{\R}{\mathalpha}{AMSb}{"52}` is `\mathbb{R}`,
 * `\mathchardef\mhyphen="2D` a hyphen): Computer Modern's letters, Greek and large operators, and the AMS
 * blackboard letters; null for any other.
 */
function mathSymbolBody(mathClass: string, font: string, position: number): string | null {
  if (!Number.isInteger(position) || position < 0 || position > 255) return null;
  const char = String.fromCharCode(position);
  let symbol: string | null = null;
  if (font === "operators" || font === "letters") {
    if (position <= 10) symbol = font === "operators" ? `\\${GREEK_CAPITALS[position]}` : `\\mathit{\\${GREEK_CAPITALS[position]}}`;
    else if (font === "letters" && position <= 39) symbol = `\\${GREEK_LOWER[position - 11]}`;
    else if (/[A-Za-z0-9]/.test(char)) symbol = font === "operators" ? `\\mathrm{${char}}` : char;
    // The text font's punctuation, where Computer Modern has the ASCII character (a hyphen, not a dash).
    else if (font === "operators" && /[!()*+,\-./:;=?@[\]]/.test(char)) symbol = `\\text{${char}}`;
  } else if (font === "largesymbols" || font === "cmlargesymbols") symbol = LARGE_SYMBOLS[position] ?? null;
  else if (font === "AMSb" && /[A-Z]/.test(char)) symbol = `\\mathbb{${char}}`;
  if (!symbol) return null;
  const wrapper = MATH_CLASSES[mathClass.replace(/^\\/, "").trim()];
  if (wrapper === undefined) return null;
  // A large operator keeps its own class (and its limits).
  return wrapper && !LARGE_SYMBOLS[position] ? `${wrapper}{${symbol}}` : symbol;
}

/** A TeX number: decimal, `"` hexadecimal, `'` octal or `` ` `` a character's code; NaN for anything else. */
function texNumber(text: string) {
  const value = text.trim();
  if (/^[0-9]+$/.test(value)) return Number(value);
  if (/^"[0-9A-Fa-f]+$/.test(value)) return parseInt(value.slice(1), 16);
  if (/^'[0-7]+$/.test(value)) return parseInt(value.slice(1), 8);
  const code = /^`\\?(.)$/.exec(value);
  return code ? code[1].charCodeAt(0) : Number.NaN;
}

/** Commands whose definitions are global whatever the group (`\gdef`, and xparse's, which are made with expl3's global `\cs_new`). */
const GLOBAL_DEFINITIONS = /^(?:gdef|xdef|DeclareMathOperator|(?:New|Renew|Provide|Declare)(?:Expandable)?DocumentCommand)$/;

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
  if (options.uncertain) scanner.assumeUncertain();
  if (source.includes("%")) for (const match of source.matchAll(/^[ \t]*%+[ \t]*\\(?:def|newcommand\s*\{?)\s*\\([A-Za-z@]+)/gm)) (defs.commentedOut ??= new Set()).add(match[1]);
  /** The code of the options given, run at `\ProcessOptions`. */
  const pendingOptions: Array<{ text: string; offset: number; uncertain: boolean }> = [];
  /** Every option's code, by name, for `\ExecuteOptions`. */
  const declaredOptions = new Map<string, { text: string; offset: number }>();
  // Conditionals are decided by what is defined where the reader is (TeX reads the file in this order).
  const here = () => context.offset + scanner.pos;
  const latest = (name: string) => {
    const list = defs.macros.get(name) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].end === undefined || list[i].end! > here()) return list[i];
    return undefined;
  };
  scanner.facts = {
    constant: (name) => constantOf(latest(name)),
    defined: (name) => definedState(defs, latest(name), name),
    switchState: (name) => {
      const list = defs.switches?.get(name);
      if (!list) return undefined;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].end === undefined || list[i].end! > here()) return list[i].value;
      return null;
    },
  };
  scanner.onSwitch = (name, value, at) => {
    const setting: LatexSwitchSetting = { pos: effectivePos(context, at), value };
    const switches = defs.switches ??= new Map();
    const list = switches.get(name);
    if (list) list.push(setting); else switches.set(name, [setting]);
    if (!scanner.deferred()) scanner.innermost()?.locals.push(setting);
  };
  // Macros the document defines macros with (`\newcommand{\newmathabbrev}[2]{\newcommand{#1}{\mathrm{#2}}}`): their uses are read too.
  const definers = new Set<string>();
  for (const [name, list] of defs.macros) if (definerOf(list[list.length - 1])) definers.add(name);
  let pattern = definitionPattern(definers);
  for (let match: RegExpExecArray | null; (match = pattern.exec(source));) {
    const start = match.index;
    scanner.advance(start);
    // Inside a comment, verbatim text or `\verb`, or in a branch TeX skips: not run.
    if (scanner.pos > start || scanner.branch() === "skip") { if (scanner.pos > pattern.lastIndex) pattern.lastIndex = scanner.pos; continue; }
    const uncertain = scanner.branch() === "unknown";
    context.deferred = scanner.deferred();
    let index = start + match[0].length;
    // algorithmicx's `\algnewcommand{\LineComment}[1]{\State …}` is `\newcommand` (and `\algrenewcommand` is `\renewcommand`);
    // match[2] is a definer macro of the document's own (definitionPattern).
    const written = match[1] ?? match[2];
    const command = written === "algnewcommand" ? "newcommand" : written === "algrenewcommand" ? "renewcommand" : written;
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
      added = addMacro(context, { name, arity: 0, body: "", pos, file: context.file, unsupported: true, ...(uncertain ? {} : { exists: true }) }, "renew");
    };

    if (match[1] === undefined) {
      // A use of one of the document's definers: what its body defines, with the arguments put in (2402.08434's
      // `\newmathabbrev{\Pr}{Pr}` is `\newcommand{\Pr}{\mathrm{Pr}}`). Under a condition it defines nothing (its uses stay source).
      const definer = latest(command);
      if (!definer || !definerOf(definer)) continue;
      const args: string[] = [];
      let at = start + match[0].length;
      for (let n = 0; n < definer.arity; n++) {
        const argument = readArgumentAt(source, at);
        if (!argument) break;
        args.push(argument.content);
        at = argument.end;
      }
      if (args.length < definer.arity) continue;
      end = at;
      if (!uncertain) {
        const text = definer.body.replace(/##|#([1-9])/g, (all, n: string | undefined) => (n ? args[Number(n) - 1] ?? all : "#"));
        // Read where the use is: in the preamble, everywhere; in the body, from there. Its extents are the use's.
        const extents = defs.extents.length;
        readLatexDefinitions(text, defs, { file: context.file, offset: context.offset + start, bodyStart: start < context.bodyStart ? text.length + 1 : 0, filePos: context.filePos });
        defs.extents.length = extents;
      }
    } else if (/^(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef)$/.test(command) && /\\WithSuffix\s*$/.test(source.slice(Math.max(0, start - 24), start))) {
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
      // TeX reads the body as one argument: a group, or one token (2204.14024's `\newcommand\cfont\mathsf`).
      const body = readGroupAt(source, index) ?? unbracedBody(source, index);
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
        else if (!/^\s*(?:#[1-9]\s*)*$/.test(parameters)) {
          // `\def\set#1:#2{\Set{{#1} \colon {#2}}}`: parameters with delimiters, read up to each one at a use.
          const spec = uncertain ? null : delimitedSpec(parameters, body.content);
          if (spec) added = addMacro(context, { name: name.name, arity: spec.length, spec, body: body.content, pos, file: context.file }, "renew");
          else shadow(name.name, `\\${name.name} has delimited parameters`);
        }
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
      // `\let\x\undefined` removes a command (before defining it again): its uses are not drawn.
      else if (/^@?undefined$/.test(target[1])) added = addMacro(context, { name: name.name, arity: 0, body: "", pos, file: context.file, unsupported: true }, "renew");
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
    } else if (command === "DeclarePairedDelimiterX" || command === "DeclarePairedDelimiterXPP") {
      // The forms with a body (2410.03413's `\DeclarePairedDelimiterX\braket[2]{\langle}{\rangle}{#1 \delimsize\vert #2}`),
      // whose `\delimsize` is the size of the outer delimiters; XPP adds code before and after them.
      const name = readCommandName(source, index);
      if (!name) continue;
      const count = readOptionalAt(source, name.end);
      const arity = count ? Number(count.content.trim()) : 0;
      const groups: Array<{ content: string; end: number }> = [];
      for (let at = count?.end ?? name.end, n = 0; n < (command === "DeclarePairedDelimiterX" ? 3 : 5); n++) {
        const group = readGroupAt(source, at);
        if (!group) break;
        groups.push(group);
        at = group.end;
      }
      if (groups.length < (command === "DeclarePairedDelimiterX" ? 3 : 5) || !Number.isInteger(arity) || arity < 0 || arity > 7) { note(defs.problems, name.name, `\\${name.name} needs its delimiters and body`); broken = true; }
      else {
        end = groups[groups.length - 1].end;
        const [pre, left, right, post, inner] = command === "DeclarePairedDelimiterX" ? ["", groups[0].content, groups[1].content, "", groups[2].content] : groups.map((group) => group.content);
        const [open, close] = [left.trim(), right.trim()];
        // The document's arguments come after the star and the size.
        const shifted = inner.replace(/##|#([1-9])/g, (all, n: string | undefined) => (n ? `#${Number(n) + 2}` : all));
        const sized = (size: string) => shifted.replace(/\\delimsize(?![A-Za-z@])\s*/g, size);
        if (uncertain || highestParameter(inner) > arity) shadow(name.name, uncertain ? `\\${name.name} is defined under a condition` : `\\${name.name} uses more arguments than it takes`);
        else added = addMacro(context, {
          name: name.name, arity: arity + 2, spec: [{ type: "s" }, { type: "o" }, ...Array.from({ length: arity }, () => ({ type: "m" as const }))], mathOnly: true, pos, file: context.file,
          body: `${pre}\\IfBooleanTF{#1}{\\left${open} ${sized("\\middle")} \\right${close}}{\\IfNoValueTF{#2}{\\mathopen{${open}}${sized("")}\\mathclose{${close}}}{\\mathopen{#2${open}}${sized("#2")}\\mathclose{#2${close}}}}${post}`,
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
        if (!spec) shadow(name.name, `\\${name.name} uses an argument type the Visual mode does not read (verbatim, or a processor)`);
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
        if (!parsed) { note(defs.unsupported, name, `${name} uses an argument type the Visual mode does not read (verbatim, or a processor)`); supported = false; }
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
      const value = style ? theoremStyleNamed(defs, style.content.trim()) : null;
      if (value) context.theoremStyle = value;
    } else if (command === "newtheoremstyle" || command === "declaretheoremstyle") {
      // amsthm's `\newtheoremstyle{named}{space}{space}{bodyfont}{indent}{headfont}{punct}{space}{spec}` (2211.14219) and
      // thmtools' `\declaretheoremstyle[bodyfont=…]{name}`: read as the amsthm style they look like (their fonts).
      const keys = command === "declaretheoremstyle" ? readOptionalAt(source, index) : null;
      const nameGroup = readGroupAt(source, keys?.end ?? index);
      if (!nameGroup) continue;
      let style: TheoremStyle;
      if (command === "declaretheoremstyle") {
        const values = optionValues(keys?.content ?? "");
        end = nameGroup.end;
        style = values.has("bodyfont") || values.has("headfont") ? styleOfFonts(values.get("bodyfont") ?? "\\itshape", values.get("headfont") ?? "\\bfseries") : "plain";
      } else {
        const groups: string[] = [];
        for (let at = nameGroup.end, n = 0; n < 8; n++) {
          const group = readGroupAt(source, at);
          if (!group) break;
          groups.push(group.content);
          at = group.end;
          end = group.end;
        }
        if (groups.length < 8) continue;
        style = styleOfFonts(groups[2], groups[4]);
      }
      let styles = documentTheoremStyles.get(defs);
      if (!styles) documentTheoremStyles.set(defs, styles = new Map());
      styles.set(nameGroup.content.trim(), style);
    } else if (command === "declaretheorem") {
      // thmtools' `\declaretheorem[name=Theorem, numberwithin=section, sibling=theorem, style=definition]{lemma}`
      // (2204.14024); the name is the environment's, capitalised, when none is given.
      const before = readOptionalAt(source, index);
      const names = readGroupAt(source, before?.end ?? index);
      if (!names) continue;
      const after = before ? null : readOptionalAt(source, names.end);
      end = after?.end ?? names.end;
      const values = optionValues(before?.content ?? after?.content ?? "");
      const title = values.get("name") ?? values.get("title") ?? values.get("heading");
      const within = values.get("numberwithin") ?? values.get("parent") ?? values.get("within");
      const sibling = values.get("sibling") ?? values.get("numberlike") ?? values.get("sharenumber");
      const styleName = values.get("style");
      const style = styleName ? theoremStyleNamed(defs, styleName) : context.theoremStyle;
      for (const name of names.content.split(",").map((part) => part.trim()).filter(Boolean)) {
        // A style the reader does not know (one a class makes): the theorem's look is not known.
        if (uncertain || !style) { note(defs.unsupported, name, uncertain ? `${name} is defined under a condition` : `${name} uses a theorem style the Visual mode does not know`); defs.theorems.delete(name); continue; }
        defs.theorems.set(name, {
          name, title: title ?? name.charAt(0).toUpperCase() + name.slice(1), counter: sibling || name,
          within: sibling ? undefined : within || undefined, numbered: !/^(?:no|false)$/i.test(values.get("numbered") ?? ""), style,
        });
      }
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
      // One in the body applies from where it is: numbering reads it there (not the end of the document's numbers).
      if (counter && within && pos >= 0) end = within.end;
      else if (counter && within) {
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
        // Under a condition the reader cannot evaluate, the names may not apply: cleveref's own are kept.
        const key = command === "Crefname" ? `${type.content.trim()}:capital` : type.content.trim();
        if (uncertain) note(defs.unsupported, key, `\\${command}{${type.content.trim()}} is set under a condition`);
        else defs.crefNames.set(key, { singular: singular.content, plural: plural.content, capital: command === "Crefname" });
      }
    } else if (command === "documentclass") {
      const options = readOptionalAt(source, index);
      const name = readGroupAt(source, options?.end ?? index);
      if (name) {
        end = name.end;
        // A subfiles chapter (`\documentclass[../main.tex]{subfiles}`) is typeset with its main file's class, read before it.
        if (name.content.trim() !== "subfiles") {
          defs.documentClass = name.content.trim();
          // The class's options, which its `\DeclareOption`s and every package's see.
          defs.classOptions = [...(defs.passedOptions?.get(name.content.trim()) ?? []), ...(options ? options.content.replace(/%[^\n]*/g, "").split(",").map((option) => option.trim()).filter(Boolean) : [])];
        }
        addClassTheorems(defs, name.content.trim(), options?.content ?? "");
        // The class's text commands written in packages.ts (AASTeX's `\apj`); the document's own definitions win.
        for (const { replaces, ...macro } of classMacros(name.content.trim())) if (replaces || !defs.macros.get(macro.name)?.length) addMacro(context, { ...macro, pos, file: context.file, package: name.content.trim() }, "renew");
      }
    } else if (command === "PassOptionsToPackage" || command === "PassOptionsToClass") {
      // `\PassOptionsToPackage{numbers}{natbib}` before natbib is loaded (often by a class): its options when it is.
      const list = readGroupAt(source, index);
      const names = list && readGroupAt(source, list.end);
      if (list && names) {
        end = names.end;
        const values = list.content.replace(/%[^\n]*/g, "").split(",").map((option) => option.trim()).filter(Boolean);
        for (const name of names.content.split(",").map((part) => part.trim()).filter(Boolean)) {
          if (uncertain) { note(defs.unsupported, name, `options for ${name} are passed under a condition`); continue; }
          const passed = defs.passedOptions ??= new Map();
          passed.set(name, [...(passed.get(name) ?? []), ...values]);
        }
      }
    } else if (command === "usepackage" || command === "RequirePackage") {
      const packageOptions = readOptionalAt(source, index);
      const names = readGroupAt(source, packageOptions?.end ?? index);
      if (names) {
        end = names.end;
        for (const name of names.content.split(",")) {
          const trimmed = name.replace(/%[^\n]*/g, "").trim();
          if (!trimmed) continue;
          defs.packages.push(trimmed);
          const passed = defs.passedOptions?.get(trimmed) ?? [];
          if (packageOptions || passed.length) defs.packageOptions.set(trimmed, [...passed, ...(packageOptions?.content.replace(/%[^\n]*/g, "").split(",").map((option) => option.trim()).filter(Boolean) ?? [])]);
          // What a package not in the project defines (complexity's `\NP`, physics' `\abs`); a copy in the project, read next, wins.
          for (const { replaces, ...macro } of packageMacros(trimmed, defs.packageOptions.get(trimmed) ?? [])) if (replaces || !defs.macros.get(macro.name)?.length) addMacro(context, { ...macro, pos, file: context.file, package: trimmed }, "renew");
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
      // A letter, or another character a specification has no use for (estout's `\newcolumntype{.}{D{.}{.}{-1}}`).
      if (letter && body && /^\s*(?:[A-Za-z]|[^\s|@!<>*{}\[\]\\])\s*$/.test(letter.content)) {
        end = body.end;
        const arity = count ? Number(count.content.trim()) : 0;
        // Its base column, without the `>{…}`, `<{…}` and `@{…}` parts: `p{#1}`, `m{…}`, `b{…}` or `X` wrap.
        const base = body.content.replace(/[<>@!]\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
        const paragraph = /(?:^|[^\\A-Za-z])[pmb]\s*\{|(?:^|[^\\A-Za-z])X(?![A-Za-z])/.test(base);
        // Cells typeset as formulas: dcolumn's `D{.}{.}{#1}` (aligned on the decimal point) and `>{$}c<{$}`.
        const decimal = /(?:^|[^\\A-Za-z])D\s*\{/.test(base);
        const math = decimal || />\s*\{\s*\$\s*\}/.test(body.content);
        defs.columnTypes.set(letter.content.trim(), {
          arity: Number.isInteger(arity) && arity >= 0 && arity <= 9 ? arity : 0, align: decimal ? "right" : columnTypeAlign(body.content),
          ...(paragraph ? { paragraph } : {}), ...(math ? { math } : {}),
        });
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
    } else if (command === "newacronym" || command === "acro" || command === "newglossaryentry" || command === "DeclareAcronym") {
      // Acronyms and glossary entries, which `\gls{gpu}`, `\ac{CNN}` and the like print (B5-15). They are kept for the
      // whole document, as the packages write them to the .aux file: a use before the definition still prints them.
      const options = command === "newacronym" ? readOptionalAt(source, index) : null;
      const key = readGroupAt(source, options?.end ?? index);
      let entry: LatexAcronym | null = null;
      if (key && command === "newacronym") {
        const short = readGroupAt(source, key.end);
        const long = short && readGroupAt(source, short.end);
        const extra = options ? keyValues(options.content) : new Map<string, string>();
        if (short && long) entry = { short: short.content.trim(), long: long.content.trim(), shortPlural: extra.get("shortplural"), longPlural: extra.get("longplural") };
      } else if (key && command === "acro") {
        // `\acro{CNN}[short]{long}`: the short form defaults to the key.
        const short = readOptionalAt(source, key.end);
        const long = readGroupAt(source, short?.end ?? key.end);
        if (long) entry = { short: short ? short.content.trim() : key.content.trim(), long: long.content.trim() };
      } else if (key) {
        const fields = readGroupAt(source, key.end);
        const values = fields ? keyValues(fields.content) : null;
        if (values && command === "newglossaryentry" && values.has("name")) entry = { short: values.get("name")!, long: values.get("name")!, shortPlural: values.get("plural") };
        if (values && command === "DeclareAcronym" && values.has("short") && values.has("long")) entry = { short: values.get("short")!, long: values.get("long")!, shortPlural: values.get("short-plural-form"), longPlural: values.get("long-plural-form") };
      }
      if (key && entry) (defs.acronyms ??= new Map()).set(key.content.trim(), entry);
    } else if (command === "algdef" || command === "algblockdefx" || command === "algblock" || command === "algtext") {
      // algorithmicx's blocks (2411.02681's `\algblockdefx[ON]{Blk}{EndBlk}[1]{#1}{}`): commands for algorithm.ts to read.
      const block = readAlgorithmBlock(source, index, command, starred, (name) => macroAt(defs, name, Number.MAX_SAFE_INTEGER));
      if (block) {
        end = block.end;
        if (!uncertain) for (const macro of block.macros) addMacro(context, { ...macro, pos, file: context.file }, "renew");
      }
    } else if (/^SetKw(?:Function|InOut|Input|Prog|Data|Block|For|Comment|IF|Repeat)?$/.test(command)) {
      // algorithm2e's keywords declared before an algorithm (`\SetKwInOut{Input}{Input}` in a preamble): macros whose
      // body is the declaration, which an algorithm reads first (walk.ts); in text and formulas their uses stay source.
      const count = command === "SetKwProg" || command === "SetKwFor" ? 4 : command === "SetKwIF" ? 8 : command === "SetKwBlock" || command === "SetKwComment" || command === "SetKwRepeat" ? 3 : 2;
      const groups: string[] = [];
      let at = index;
      while (groups.length < count) {
        const group = readGroupAt(source, at);
        if (!group) break;
        groups.push(group.content);
        at = group.end;
      }
      const name = /^\s*\\?([A-Za-z@]+)\s*$/.exec(groups[0] ?? "")?.[1];
      if (name && groups.length === count) {
        end = at;
        if (!uncertain) added = addMacro(context, { name, arity: 0, body: source.slice(start, at), mathOnly: true, pos, file: context.file, package: "algorithm2e" }, "renew");
      }
    } else if (command === "loop") {
      // Plain TeX's `\loop … \repeat` (2410.03413 makes `\frakA`… in one): `\repeat` closes the `\unless\ifnum` in it, so
      // read as code it would leave every later definition under a condition. Its body is skipped whole.
      const close = loopEnd(source, index);
      if (close < 0) continue;
      end = close;
      // A loop that only makes macros by name (`\cA`…`\cZ`) is read as the macros it makes; any other is skipped.
      const made = readLoopDefinitions(source, index, source.slice(0, start), latest);
      for (const macro of made ?? []) {
        if (uncertain) shadow(macro.name, `\\${macro.name} is defined under a condition`);
        else addMacro(context, { name: macro.name, arity: 0, body: macro.body, pos, file: context.file }, "renew");
      }
    } else if (command === "DeclareOption" || command === "ProcessOptions" || command === "ExecuteOptions") {
      // A package's or class's option (ICML's `\DeclareOption{accepted}{\gdef\isaccepted{1}}`): its code runs at
      // `\ProcessOptions` when the option is given (`\usepackage[accepted]{icml2020}`), maybe when how the package is
      // loaded is not known, and not otherwise; the defaults (`\ExecuteOptions{oneside,final}`) run where they are.
      const run = (option: { text: string; offset: number }, maybe: boolean) => {
        const extents = defs.extents.length;
        readLatexDefinitions(option.text, defs, { file: context.file, offset: option.offset, bodyStart: option.offset < context.offset + context.bodyStart ? option.text.length + 1 : 0, filePos: context.filePos, uncertain: maybe });
        defs.extents.length = extents;
      };
      if (command === "ProcessOptions") {
        for (const option of pendingOptions.splice(0)) run(option, option.uncertain);
        continue;
      }
      if (command === "ExecuteOptions") {
        const list = readGroupAt(source, index);
        if (!list) continue;
        end = list.end;
        for (const name of list.content.split(",").map((part) => part.trim())) {
          const option = declaredOptions.get(name);
          if (option) run(option, uncertain);
        }
      } else {
        const option = starred ? null : readGroupAt(source, index);
        const body = readGroupAt(source, option?.end ?? index);
        if (!body) continue;
        end = body.end;
        const given = starred ? false : optionGiven(context, option!.content.trim());
        const code = { text: body.content, offset: context.offset + skipSpace(source, option?.end ?? index) + 1 };
        if (option) declaredOptions.set(option.content.trim(), code);
        if (given !== false) pendingOptions.push({ ...code, uncertain: uncertain || given === null });
      }
    } else if (command === "DeclareMathAlphabet") {
      // `\DeclareMathAlphabet{\mathbfsf}{OT1}{cmss}{bx}{n}`: drawn with the KaTeX alphabet of that font's look.
      const name = readCommandName(source, index);
      const font: string[] = [];
      for (let at = name?.end ?? index, n = 0; name && n < 4; n++) {
        const group = readGroupAt(source, at);
        if (!group) break;
        font.push(group.content);
        at = group.end;
        end = group.end;
      }
      if (!name || font.length < 4) continue;
      const body = mathAlphabetBody(font[0], font[1], font[2], font[3]);
      if (uncertain || !body) shadow(name.name, uncertain ? `\\${name.name} is defined under a condition` : `\\${name.name} is a math alphabet the Visual mode does not have`);
      else added = addMacro(context, { name: name.name, arity: 1, body, mathOnly: true, pos, file: context.file }, "new");
    } else if (command === "DeclareMathSymbol" || command === "mathchardef") {
      // `\DeclareMathSymbol{\R}{\mathalpha}{AMSb}{"52}` and `\mathchardef\mhyphen="2D`: a symbol of a font, by position.
      const name = readCommandName(source, index);
      if (!name) continue;
      let symbol: string | null = null;
      if (command === "DeclareMathSymbol") {
        const groups: string[] = [];
        for (let at = name.end, n = 0; n < 3; n++) {
          const group = readGroupAt(source, at) ?? readArgumentAt(source, at);
          if (!group) break;
          groups.push(group.content.trim());
          at = group.end;
          end = group.end;
        }
        if (groups.length < 3) continue;
        symbol = mathSymbolBody(groups[0], groups[1], texNumber(groups[2]));
      } else {
        const value = /^\s*=?\s*("[0-9A-Fa-f]+|'[0-7]+|[0-9]+|`\\?.)/.exec(source.slice(name.end, name.end + 40));
        if (!value) continue;
        end = name.end + value[0].length;
        const code = texNumber(value[1]);
        const family = (code >> 8) & 15;
        if (code < 0x8000 && family <= 3) symbol = mathSymbolBody(["mathord", "mathop", "mathbin", "mathrel", "mathopen", "mathclose", "mathpunct", "mathalpha"][code >> 12], ["operators", "letters", "symbols", "largesymbols"][family], code & 255);
      }
      if (uncertain) shadow(name.name, `\\${name.name} is defined under a condition`);
      // A package's numbers made with `\mathchardef` (`\@mmm=3000`) are no symbols: not drawn, not listed.
      else if (!symbol && command === "mathchardef") added = addMacro(context, { name: name.name, arity: 0, body: "", pos, file: context.file, unsupported: true }, "renew");
      else if (!symbol) shadow(name.name, `\\${name.name} is a symbol of a font the Visual mode does not have`);
      else added = addMacro(context, { name: name.name, arity: 0, body: symbol, mathOnly: true, pos, file: context.file }, "renew");
    }

    if (added && definerOf(added) && !definers.has(added.name)) {
      definers.add(added.name);
      const last = pattern.lastIndex;
      pattern = definitionPattern(definers);
      pattern.lastIndex = last;
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
  for (const [name, box] of defs.boxes ?? []) parts.push(`box:${name}:${JSON.stringify(box)}`);
  parts.push(defs.documentClass ?? "", String(defs.secnumdepth ?? ""), defs.graphicsPaths.join("|"));
  for (const [name, list] of defs.packageOptions) parts.push(`pkg:${name}:${list.join(",")}`);
  for (const [name, color] of defs.colors) parts.push(`color:${name}:${color.model}:${color.value}`);
  for (const [letter, type] of defs.columnTypes) parts.push(`col:${letter}:${type.arity}:${type.align}:${type.paragraph ? "p" : ""}${type.math ? "m" : ""}`);
  for (const [name, kind] of defs.lists ?? []) parts.push(`list:${name}:${kind}`);
  for (const [level, options] of defs.listOptions ?? []) parts.push(`listopt:${level}:${options}`);
  for (const [key, entry] of defs.acronyms ?? []) parts.push(`acr:${key}:${JSON.stringify(entry)}`);
  for (const [name, list] of defs.switches ?? []) parts.push(`switch:${name}:${list.map((setting) => `${setting.value}@${setting.pos}-${setting.end ?? ""}`).join(",")}`);
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
  // The boxes of every file read (a chapter's boxes are in the main file's preamble or a style file).
  for (const source of sources) if (BOX_DEFINITION.test(source.text)) readBoxDefinitions(source.text, defs);
  if (open && BOX_DEFINITION.test(open.text)) readBoxDefinitions(open.text, defs);
  defs.fingerprint = definitionsFingerprint(defs);
  return defs;
}

/** A box environment of tcolorbox or mdframed: its title as its options give it, its arguments, and its counter. */
export type LatexBoxDefinition = {
  /** The title its options give (`title={Box~\thetcbcounter: #2}`), with its `#n` still in it; null without one. */
  title: string | null;
  /** The arguments it takes (`[2][]`: two, the first optional); 0 for `\newmdenv` and boxes with no `[n]`. */
  arity: number;
  /** Whether the first argument is optional (given a default: `[2][]`). */
  optional: boolean;
  /** `auto counter`: the box is numbered (`\thetcbcounter`); `number within=section` restarts that count in each section. */
  counter: boolean;
  within: string | null;
};

const BOX_DEFINITION_COMMAND = String.raw`(?:(?:re)?newtcolorbox|DeclareTColorBox|NewTColorBox|newmdenv)`;
const BOX_DEFINITION = new RegExp(String.raw`\\${BOX_DEFINITION_COMMAND}(?![A-Za-z@])`);

/** A box's title from its options (`title=Prompt`, mdframed's `frametitle={…}`), null without one. */
export function boxTitleOf(options: string) {
  const match = /(?:^|,)\s*(?:frame)?title\s*=\s*/.exec(options);
  if (!match) return null;
  const rest = options.slice((match.index ?? 0) + match[0].length);
  const value = rest[0] === "{" ? readGroup(rest, 0, TEX_GROUPS)?.content : /^[^,]*/.exec(rest)?.[0];
  return value?.trim() || null;
}

/**
 * `\newtcolorbox[auto counter,number within=section]{Name}[2][]{title={Box~\thetcbcounter: #2},…,#1}` (its options may
 * span lines, and so may the header), `\newtcolorbox{Name}{…}`, `\DeclareTColorBox{Name}{O{}m}{…}` and
 * mdframed's `\newmdenv[options]{Name}`: the names with the title, arguments and counter, in `defs.boxes`.
 * `\Crefname={Box}{Boxes}` among the options names the box for cleveref.
 */
export function readBoxDefinitions(source: string, defs: LatexDefinitions) {
  const text = source.includes("%") ? source.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, "$1$2") : source;
  const boxes = defs.boxes ??= new Map();
  for (const match of text.matchAll(new RegExp(String.raw`\\(${BOX_DEFINITION_COMMAND})\*?(?![A-Za-z@])`, "g"))) {
    let at = (match.index ?? 0) + match[0].length;
    const skip = () => { at += /^\s*/.exec(text.slice(at))![0].length; };
    skip();
    // The initialisation options (`[auto counter,…]`) before the name; mdframed's are the box's own.
    let init = "";
    if (text[at] === "[") {
      const group = readOptional(text, at, TEX_GROUPS);
      if (!group) continue;
      init = group.content;
      at = group.end;
      skip();
    }
    const name = text[at] === "{" ? readGroup(text, at, TEX_GROUPS) : null;
    if (!name || !/^[A-Za-z@*]+$/.test(name.content.trim())) continue;
    at = name.end;
    let arity = 0;
    let optional = false;
    let options = "";
    if (match[1] === "newmdenv") options = init;
    else {
      skip();
      // xparse's argument specification of `\DeclareTColorBox{Name}{O{}m}{…}`: only the box's options come first.
      if (/^(?:DeclareTColorBox|NewTColorBox)$/.test(match[1]) && text[at] === "{") {
        const spec = readGroup(text, at, TEX_GROUPS);
        if (!spec) continue;
        at = spec.end;
        skip();
      } else {
        const count = /^\[(\d)\]/.exec(text.slice(at));
        if (count) {
          arity = Number(count[1]);
          at += count[0].length;
          skip();
          if (text[at] === "[") {
            const fallback = readOptional(text, at, TEX_GROUPS);
            if (!fallback) continue;
            optional = true;
            at = fallback.end;
            skip();
          }
        }
      }
      const body = text[at] === "{" ? readGroup(text, at, TEX_GROUPS) : null;
      options = body?.content ?? "";
    }
    const within = /(?:^|,)\s*number\s+within\s*=\s*([A-Za-z]+)/.exec(init)?.[1] ?? null;
    boxes.set(name.content.trim(), { title: boxTitleOf(options), arity, optional, counter: /(?:^|,)\s*auto\s+counter\s*(?:,|$)/.test(init), within });
    const crefname = /(?:^|,)\s*Crefname\s*=\s*\{([^{}]*)\}\s*\{([^{}]*)\}/.exec(init);
    if (crefname) defs.crefNames.set(`${name.content.trim()}:capital`, { singular: crefname[1].trim(), plural: crefname[2].trim(), capital: true });
  }
}

/** Where the document body starts: after `\begin{document}`, or 0 for a chapter file without one. */
export function bodyStartOf(source: string) {
  return findBeginDocument(source)?.end ?? 0;
}

/** The definition of `name` that applies at `pos` in the open file (a local one only inside its group). */
export function macroAt(defs: LatexDefinitions, name: string, pos: number): LatexMacro | null {
  const list = defs.macros.get(name);
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].pos <= pos && (list[i].end === undefined || pos < list[i].end!)) return list[i];
  return null;
}

/** The state of the `\newif` switch `name` at `pos` in the open file: true or false, null when not known, undefined for no switch. */
export function switchAt(defs: LatexDefinitions, name: string, pos: number): boolean | null | undefined {
  const list = defs.switches?.get(name);
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].pos <= pos && (list[i].end === undefined || pos < list[i].end!)) return list[i].value;
  return null;
}

/**
 * Whether `name` is defined, for `\ifx\x\undefined` and `\ifdefined`: true for one of the document's macros, false for
 * a name whose only definition is commented out, undefined when not known (LaTeX or a package may define it).
 */
function definedState(defs: LatexDefinitions, macro: LatexMacro | null | undefined, name: string) {
  if (macro && (macro.exists || (!macro.unsupported && !macro.alias))) return true;
  return !macro && defs.commentedOut?.has(name) ? false : undefined;
}

/** What decides a conditional at `pos` in the open file (conditionals.ts): constants, switches, and in a formula or not. */
export function conditionalFacts(defs: LatexDefinitions, pos: number, math?: boolean): ConditionalFacts {
  return {
    constant: (name) => constantOf(macroAt(defs, name, pos)),
    defined: (name) => definedState(defs, macroAt(defs, name, pos), name),
    switchState: (name) => switchAt(defs, name, pos),
    math,
  };
}

const factsKeys = new WeakMap<LatexDefinitions, string>();

/** What conditionals may read in `defs` (constants, switches, the names defined), equal when they decide the same. */
export function conditionalFactsKey(defs: LatexDefinitions) {
  let key = factsKeys.get(defs);
  if (key !== undefined) return key;
  const parts: string[] = [];
  for (const [name, list] of defs.macros) parts.push(`${name}=${list.map((macro) => constantOf(macro) ?? (macro.exists ? "!" : macro.unsupported || macro.alias ? "?" : "")).join(",")}`);
  for (const [name, list] of defs.switches ?? []) parts.push(`${name}:${list.map((setting) => setting.value).join(",")}`);
  if (defs.commentedOut) parts.push(`%${[...defs.commentedOut].join(",")}`);
  factsKeys.set(defs, key = parts.join("\u0000"));
  return key;
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
  const switches = defs.switches && new Map([...defs.switches].map(([name, list]) => [name, list.map((setting) => (setting.pos < 0 && setting.end === undefined ? setting : { ...setting, pos: map(setting.pos), end: setting.end === undefined ? undefined : map(setting.end) }))]));
  return {
    ...defs, macros, environments, ...(switches ? { switches } : {}),
    extents: defs.extents.map((extent) => ({ from: map(extent.from), to: map(extent.to), ...(extent.broken ? { broken: true } : {}) })),
    problems: defs.problems.map(note), unsupported: defs.unsupported.map(note),
  };
}

/** How many macros and environments a summary counts (the latest definition of each name). */
export function definitionCounts(defs: LatexDefinitions) {
  // A package's commands (complexity's 300 classes) are not the document's macros.
  let macros = 0;
  for (const list of defs.macros.values()) if (!list[list.length - 1].package) macros++;
  return { macros, environments: defs.environments.size, theorems: defs.theorems.size, packages: new Set(defs.packages).size };
}

/** An included file as written: `path` is the name the numbering and the loaders key it by (`dir` + `file` for the import package's commands). */
export type LatexInput = { pos: number; end: number; command: string; path: string; dir?: string; file?: string };

/**
 * `\input`, `\include` and `\subfile` targets in a source (comments skipped), in order, with positions; and the import
 * package's `\import{dir/}{file}`, `\subimport{dir/}{file}`, `\inputfrom`, `\includefrom` and their `sub` forms.
 */
export function readLatexInputs(source: string) {
  const inputs: LatexInput[] = [];
  for (const match of source.matchAll(/\\(input|include|subfile)\s*\{([^}]+)\}|\\((?:sub)?(?:import|inputfrom|includefrom))\*?\s*\{([^{}]*)\}\s*\{([^{}]+)\}/g)) {
    if (inComment(source, match.index ?? 0)) continue;
    const pos = match.index ?? 0;
    if (match[1]) { inputs.push({ pos, end: pos + match[0].length, command: match[1], path: match[2].trim() }); continue; }
    const dir = match[4].trim().replace(/^(?:\.\/)+/, "").replace(/^\.$/, "").replace(/([^/])$/, "$1/");
    inputs.push({ pos, end: pos + match[0].length, command: match[3], path: `${dir}${match[5].trim()}`, dir, file: match[5].trim() });
  }
  return inputs;
}

export { inComment as isInLatexComment };

/** Classes whose theorems are known here, with their options (their `.cls` is rarely in the project, and reads only through its conditionals). */
const KNOWN_THEOREM_CLASSES = /^(?:llncs|(?:lipics|oasics)(?:-v\d+)?|acmart)$/;

/**
 * The theorems a well-known class defines, for the names the document has not defined (the document's own
 * `\newtheorem` replaces them, as acmart lets it). LIPIcs and acmart theorems share the theorem counter; llncs's have
 * their own unless `envcountsame`, and are numbered in sections with `envcountsect`.
 */
function addClassTheorems(defs: LatexDefinitions, cls: string, optionText: string) {
  if (!KNOWN_THEOREM_CLASSES.test(cls)) return;
  const options = optionText.replace(/%[^\n]*/g, "").split(",").map((option) => option.trim());
  /** `counter`: the counter it steps (its own name by default), or null when it is not numbered. */
  const add = (name: string, title: string, style: TheoremStyle, counter: string | null = name, within?: string) => {
    if (defs.theorems.has(name)) return;
    defs.theorems.set(name, { name, title, counter: counter ?? name, ...(within ? { within } : {}), numbered: counter !== null, style });
  };
  if (cls === "llncs") {
    const same = options.includes("envcountsame");
    const sect = options.includes("envcountsect");
    const reset = options.includes("envcountreset");
    add("theorem", "Theorem", "plain", "theorem", sect ? "section" : undefined);
    if (reset && !sect && !defs.counterWithin.has("theorem")) defs.counterWithin.set("theorem", "section");
    add("claim", "Claim", "remark", null);
    const plain = new Set(["corollary", "definition", "lemma", "proposition"]);
    for (const name of ["case", "conjecture", "corollary", "definition", "example", "exercise", "lemma", "note", "problem", "property", "proposition", "question", "solution", "remark"]) {
      const fresh = !defs.theorems.has(name);
      add(name, name[0].toUpperCase() + name.slice(1), plain.has(name) ? "plain" : "remark", same ? "theorem" : name, !same && sect ? "section" : undefined);
      if (fresh && !same && !sect && reset && !defs.counterWithin.has(name)) defs.counterWithin.set(name, "section");
    }
  } else if (cls === "acmart") {
    if (options.some((option) => /^acmthm\s*=\s*false$/.test(option))) return;
    add("theorem", "Theorem", "plain", "theorem", "section");
    for (const name of ["conjecture", "proposition", "lemma", "corollary"]) add(name, name[0].toUpperCase() + name.slice(1), "plain", "theorem");
    for (const name of ["example", "definition"]) add(name, name[0].toUpperCase() + name.slice(1), "definition", "theorem");
  } else {
    // LIPIcs and OASIcs.
    add("theorem", "Theorem", "plain", "theorem", options.includes("numberwithinsect") ? "section" : undefined);
    for (const name of ["lemma", "corollary", "proposition", "exercise", "definition", "conjecture", "observation"]) add(name, name[0].toUpperCase() + name.slice(1), "plain", "theorem");
    add("example", "Example", "definition", "theorem");
    for (const name of ["note", "remark", "claim"]) {
      add(name, name[0].toUpperCase() + name.slice(1), name === "claim" ? "definition" : "remark", "theorem");
      add(`${name}*`, name[0].toUpperCase() + name.slice(1), name === "claim" ? "definition" : "remark", null);
    }
  }
}

/**
 * The theorem definitions of a document class the project has (the book 2403.14606's nowfnt.cls), as source the
 * definition reader reads: its `\theoremstyle`s and `\newtheorem`s, and llncs-style `\spnewtheorem`s written as those,
 * without the rest of the class (its page macros are not the document's). Both branches of the class's conditionals are
 * read, the later winning. Empty for the classes known above and for a class that defines none.
 */
export function classTheoremSource(cls: string, text: string) {
  if (KNOWN_THEOREM_CLASSES.test(cls)) return "";
  const out: string[] = [];
  for (const match of text.matchAll(/\\(newtheorem|theoremstyle|spnewtheorem|spn@wtheorem)(?![A-Za-z@])(\*?)/g)) {
    const at = match.index ?? 0;
    if (inComment(text, at)) continue;
    let index = at + match[0].length;
    if (match[1] === "theoremstyle") {
      const style = readGroupAt(text, index);
      if (style) out.push(`\\theoremstyle{${style.content.trim()}}`);
      continue;
    }
    const name = readGroupAt(text, index);
    if (!name || /[#\\]/.test(name.content) || name.content.trim() === "proof") continue;
    index = name.end;
    const shared = match[2] ? null : readOptionalAt(text, index);
    if (shared) index = shared.end;
    const title = readGroupAt(text, index);
    if (!title) continue;
    index = title.end;
    const within = shared || match[2] ? null : readOptionalAt(text, index);
    if (within) index = within.end;
    const star = match[2];
    const head = `\\newtheorem${star}{${name.content.trim()}}${shared ? `[${shared.content.trim()}]` : ""}{${title.content.trim()}}${within ? `[${within.content.trim()}]` : ""}`;
    if (match[1] === "newtheorem") { out.push(head); continue; }
    // `\spnewtheorem{name}…{caption font}{body font}`: an italic body is the plain style, an upright one under a bold caption the definition style.
    const captionFont = readGroupAt(text, index);
    const bodyFont = captionFont && readGroupAt(text, captionFont.end);
    if (!captionFont || !bodyFont) continue;
    const style = /\\(?:itshape|it|slshape|sl)(?![A-Za-z])/.test(bodyFont.content) ? "plain" : /\\(?:bfseries|bf)(?![A-Za-z])/.test(captionFont.content) ? "definition" : "remark";
    out.push(`\\theoremstyle{${style}}${head}`);
  }
  return out.join("\n");
}
