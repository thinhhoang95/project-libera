/* What the converter knows about the place a paste lands: the section the
 * cursor is in, the document class, the engine, the packages the preamble
 * loads, labels already used, the bibliography's keys. Pure data, built by
 * codemirror/markdown-paste.ts from the editor state (or by tests). */

import { stripLatexComments } from "../project";

export type PasteEngine = "pdflatex" | "xelatex" | "lualatex";
export type BibliographyDialect = "biblatex" | "natbib" | "plain";

export type LatexPasteContext = {
  /** Level of the last sectioning command before the cursor (part 0 … subparagraph 6), or null. */
  sectionLevel: number | null;
  sectionCommand: string | null;
  sectionTitle: string | null;
  documentClass: string | null;
  classOptions: string[];
  engine: PasteEngine;
  /** Packages the preamble loads (the root's, for a chapter file), with their options. */
  packages: ReadonlyMap<string, string[]>;
  /** Labels already defined in the document and the project. */
  labels: ReadonlySet<string>;
  /** The bibliography's keys, or null when they are not known. */
  bibKeys: ReadonlySet<string> | null;
  /** Library aliases → the key the bibliography has (`@old` cites `new`). */
  bibAliases: ReadonlyMap<string, string>;
  /** Commands and environments the document defines (`\newcommand`, `\newtheorem`…): LaTeX written in pasted text may use them. */
  definedCommands: ReadonlySet<string>;
  definedEnvironments: ReadonlySet<string>;
  /** Lists (and other list-based environments such as quote) around the paste: LaTeX nests four of a kind, six in all. */
  listDepth: { itemize: number; enumerate: number; other: number };
  /** Project files, relative to the document's folder, or null when not known. */
  files: ReadonlySet<string> | null;
  /** The document's folder, relative to the notebook ("" for its root). */
  documentDir: string;
  /** The paste lands in a command argument or a table: blocks are flattened to inline text. */
  inlineOnly: boolean;
  /**
   * The paste lands inside a float (`table`, `figure`): tables and images get no float of their own,
   * but may take a caption; or inside a box (`tcolorbox`, `minipage`), where neither floats nor captions fit.
   */
  container: "float" | "box" | null;
  /** The paste lands in a footnote's text: footnotes in it are written in parentheses. */
  inFootnote: boolean;
};

export function createPasteContext(partial: Partial<LatexPasteContext> = {}): LatexPasteContext {
  return {
    sectionLevel: null, sectionCommand: null, sectionTitle: null,
    documentClass: null, classOptions: [], engine: "pdflatex",
    packages: new Map(), labels: new Set(), bibKeys: null, bibAliases: new Map(), definedCommands: new Set(), definedEnvironments: new Set(),
    listDepth: { itemize: 0, enumerate: 0, other: 0 }, files: null, documentDir: "", inlineOnly: false, container: null, inFootnote: false,
    ...partial,
  };
}

export const SECTION_LEVELS: Record<string, number> = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6,
};

const CHAPTER_CLASSES = new Set(["book", "report", "memoir", "scrbook", "scrreprt", "amsbook", "extbook", "extreport", "ctexbook", "ctexrep", "tufte-book", "kaobook", "jsbook", "ltjsbook"]);

/** Packages a class or another package loads, so their commands need nothing more. */
const IMPLIED: Record<string, string[]> = {
  "class:beamer": ["hyperref", "xcolor", "graphicx", "amsmath", "amssymb", "amsthm"],
  "class:memoir": ["booktabs", "array"],
  "class:amsart": ["amsmath", "amsthm", "amsfonts"], "class:amsbook": ["amsmath", "amsthm", "amsfonts"], "class:amsproc": ["amsmath", "amsthm", "amsfonts"],
  tabularx: ["array"], xltabular: ["tabularx", "longtable", "array"], tabulary: ["array"],
  hyperref: ["url"], tcolorbox: ["xcolor"], tikz: ["xcolor", "graphicx"], pgfplots: ["xcolor", "graphicx"],
  mathtools: ["amsmath"], amssymb: ["amsfonts"], soulutf8: ["soul"], csquotes: [], "biblatex": [], fontspec: [],
  "unicode-math": ["amsmath"], ctex: ["xcolor"], todonotes: ["xcolor"],
};

/** Text with its comments removed (a `%` after an even run of backslashes starts one), via the project's own helper. */
function stripComments(text: string) {
  return stripLatexComments(text);
}

/** Literal environments, whose contents are not LaTeX (a `\section` in a verbatim block is not a heading). */
const LITERAL_ENVIRONMENTS = /\\begin\s*\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|filecontents\*?)\}[\s\S]*?(?:\\end\s*\{\1\}|$)/g;

export type PreambleInfo = {
  documentClass: string | null;
  classOptions: string[];
  packages: Map<string, string[]>;
  /** Text commands and environments the texts define. */
  commands: Set<string>;
  environments: Set<string>;
};

const DEFINES_COMMAND = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand)\*?\s*\{?\s*\\([A-Za-z@]+)|\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@]+)/g;
const DEFINES_ENVIRONMENT = /\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|newtheorem|declaretheorem|newmdenv|newtcolorbox|newtcbtheorem)\*?\s*(?:\[[^\]]*\])?\s*\{([A-Za-z*@]+)\}/g;

/** `\documentclass` and the `\usepackage`/`\RequirePackage` lines of preamble texts, with what they imply. */
export function readPreambleInfo(texts: string[]): PreambleInfo {
  let documentClass: string | null = null;
  let classOptions: string[] = [];
  const packages = new Map<string, string[]>();
  const commands = new Set<string>();
  const environments = new Set<string>();
  const add = (name: string, options: string[]) => {
    if (!name) return;
    const known = packages.get(name);
    packages.set(name, known ? [...new Set([...known, ...options])] : options);
    for (const implied of IMPLIED[name] ?? []) if (!packages.has(implied)) add(implied, []);
  };
  for (const raw of texts) {
    const text = stripComments(raw);
    const begin = text.search(/\\begin\s*\{document\}/);
    const preamble = begin >= 0 ? text.slice(0, begin) : text;
    const docClass = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/.exec(preamble);
    if (docClass && !documentClass) {
      documentClass = docClass[2].trim();
      classOptions = (docClass[1] ?? "").split(",").map((option) => option.trim()).filter(Boolean);
      for (const implied of IMPLIED[`class:${documentClass}`] ?? []) add(implied, []);
    }
    for (const match of preamble.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)) {
      const options = (match[1] ?? "").split(",").map((option) => option.trim()).filter(Boolean);
      for (const name of match[2].split(",")) add(name.trim(), options);
    }
    const definitions = text.replace(LITERAL_ENVIRONMENTS, "");
    for (const match of definitions.matchAll(DEFINES_COMMAND)) commands.add(match[1] ?? match[2]);
    for (const match of definitions.matchAll(DEFINES_ENVIRONMENT)) environments.add(match[1]);
  }
  return { documentClass, classOptions, packages, commands, environments };
}

export function hasPackage(context: LatexPasteContext, ...names: string[]) {
  return names.some((name) => context.packages.has(name));
}

/** Whether the class has `\chapter` (unknown classes are given the benefit of the doubt). */
export function hasChapters(context: LatexPasteContext) {
  return context.documentClass === null || CHAPTER_CLASSES.has(context.documentClass) || /book|report|thesis/i.test(context.documentClass);
}

export function isTwoColumn(context: LatexPasteContext) {
  return context.classOptions.includes("twocolumn") || /^(?:IEEEtran|acmart|revtex4-?\d?|aastex\d*|sigconf)$/.test(context.documentClass ?? "");
}

export function bibliographyDialect(context: LatexPasteContext): BibliographyDialect {
  if (hasPackage(context, "biblatex")) return "biblatex";
  if (hasPackage(context, "natbib")) return "natbib";
  return "plain";
}

/** Whether `<`, `>` and `|` print as themselves: T1 fonts or a Unicode engine. */
export function hasT1Fonts(context: LatexPasteContext) {
  return context.engine !== "pdflatex" || (context.packages.get("fontenc") ?? []).some((option) => /^(?:T1|LY1|T5|QX)$/.test(option));
}

/** The last sectioning command before `offset` in `text` (comments, verbatim blocks and macro definitions skipped). */
export function sectionBefore(text: string, offset: number): { level: number; command: string; title: string } | null {
  const before = stripComments(text.slice(0, offset)).replace(LITERAL_ENVIRONMENTS, "");
  let found: { level: number; command: string; title: string } | null = null;
  for (const match of before.matchAll(/\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g)) {
    // `\newcommand{\chap}[1]{\chapter{#1}}` defines a heading; it is not one.
    const lineStart = before.lastIndexOf("\n", match.index) + 1;
    if (/\\(?:newcommand|renewcommand|providecommand|def|gdef|edef|xdef|NewDocumentCommand|newenvironment)\b/.test(before.slice(lineStart, match.index))) continue;
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < before.length && depth > 0) {
      if (before[index] === "\\") index++;
      else if (before[index] === "{") depth++;
      else if (before[index] === "}") depth--;
      index++;
    }
    found = { level: SECTION_LEVELS[match[1]], command: match[1], title: before.slice(start, Math.max(start, index - 1)).replace(/\s+/g, " ").trim() };
  }
  return found;
}
