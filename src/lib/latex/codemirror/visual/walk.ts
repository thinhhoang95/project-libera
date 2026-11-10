import type { EditorState, Text } from "@codemirror/state";
import type { WidgetType } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";
import { definitionExtentAround, definitionExtentAt, isInLatexComment, macroAt, type LatexDefinitions } from "../../macros/definitions";
import { expandLatexMacros, expandLatexMacroUse, needsMathMode, readMacroArguments, substituteArguments } from "../../macros/expand";
import { CAPTION_OF, enumerateItemLabel, environmentName, FLOAT_KINDS, floatKind, KOMA_CAPTION, restatableTheorem, stripTexComments, wrappedTheorem } from "../../macros/numbering";
import { parseAlgorithm2e, parseAlgorithmic } from "./algorithm";
import { isPairMacro, itemMacroNames, MATH_ENVIRONMENT, macroEnvironmentRegionAt, macroEnvironmentRegions, structureMacroNames, type MacroEnvironmentRegion } from "../../macros/structure";
import { latexParser } from "../latex-parser";
import { countedRows, katexForEnvironment, mathparForKatex, renderKatex } from "./math-render";
import { disabledField } from "./model";
import { REFERENCE_IN_MATH, withReferenceNumbers } from "./references";
import { acronymText, argumentInner, CITE_ALIASES, commandArguments, hasDirectError } from "./render-fragment";
import { circledText, CONTROL_SYMBOLS, cssColor, DINGBATS, FONT_SWITCHES, LIGATURE_CHARS, readAccent, SIZE_COMMAND, SYMBOL_COMMANDS, TEXT_LIGATURES, todayText } from "./symbols";
import { macroBuiltTabular, parseTabular, readCtable, readLongTable } from "./table-model";
import { argumentGroups, transparentPlan } from "./transparent";
import {
  ChipWidget, EnvironmentFooterWidget, EnvironmentHeaderWidget, ExpandedEnvironmentWidget, type ExpandedEnvironmentSpec, type FigureContent, FigureWidget, FootnoteMarkWidget, graphicsBase, HeadingNumberWidget, ImageWidget,
  ItemMarkerWidget, LineBreakWidget, MacroFootnoteWidget, MacroHeadingWidget, MacroPieceWidget, MacroWidget, MathWidget, PreambleWidget, SymbolWidget, TableWidget, TitleWidget, BibliographyListWidget, type FigureSpec,
  RestatedTheoremWidget, restatablesIn, TodoWidget,
} from "./widgets";

/* One walk over the syntax tree that recognises constructs
 * (docs/latex-visual-editor-plan.md §3–4). Each construct says which markup
 * to hide, which text to style and which widget replaces it, and how the
 * cursor reveals its source. Anything not recognised, or with broken
 * delimiters, is left alone: it stays as source. */

/** Targets of a `\let` alias that keep a command drawn as its kind (a citation stays a citation). */
const ALIAS_FAMILIES: Record<string, RegExp> = {
  Cite: /^\\[A-Za-z]*cite[A-Za-z]*$/i,
  Ref: /^\\(?:[A-Za-z]*ref|autoref|nameref)$/i,
};

export type RevealPolicy = "touch" | "strict" | "line" | "never" | "toggle";

export type Replace = { from: number; to: number; widget?: WidgetType; block?: boolean; side?: number };
export type Mark = { from: number; to: number; class: string; attributes?: Record<string, string> };
export type LineStyle = { from: number; to: number; class: string };

export type Construct = {
  kind: string;
  from: number;
  to: number;
  reveal: RevealPolicy;
  /** "line" policy: the cursor in [from, lead] reveals; with `wholeLine`, anywhere on its lines. */
  lead?: number;
  wholeLine?: boolean;
  replaces: Replace[];
  /** Line classes that apply only while the construct is drawn (collapsed `\begin` lines). */
  hiddenLines?: LineStyle[];
  /** Styles that stay while the source shows (bold text, heading size). */
  marks?: Mark[];
  lines?: LineStyle[];
};

export type WalkEnvironment = {
  state: EditorState;
  tree: Tree;
  defs: LatexDefinitions;
  /** End of the `\begin{document}` line, or -1 for a file without one. */
  preambleEnd: number;
  preambleOpen: boolean;
  preambleSummary: string;
  /** "structural" builds widgets; "style" only marks and line classes. */
  layer: "structural" | "style";
};

// Definitions are source: their bodies are not drawn (a `textit` in a `newcommand` body is not italic text).
const SKIPPED = new Set([
  "Comment", "VerbatimEnvironment", "TikzPictureEnvironment", "VerbCommand", "LstInlineCommand", "Csname",
  "NewCommand", "RenewCommand", "NewEnvironment", "RenewEnvironment", "Def", "Let", "NewTheoremCommand", "TheoremStyleCommand",
]);
/** Skipped nodes whose text the PDF shows (listings, `\verb`): never part of what a widget replaces without drawing it. */
const VISIBLE_SKIPPED = new Set(["VerbatimEnvironment", "VerbCommand", "LstInlineCommand", "Csname"]);
/** Definition nodes of the grammar, which may end before the definition does (`\newcommand*{\a}{…}`). */
const DEFINITION_NODES = new Set(["NewCommand", "RenewCommand", "NewEnvironment", "RenewEnvironment", "Def", "Let", "NewTheoremCommand", "TheoremStyleCommand"]);
/** Built-in commands drawn by the walk, which a document may redefine. */
const OVERRIDABLE = new Set([
  "TextBoldCommand", "TextItalicCommand", "EmphasisCommand", "UnderlineCommand", "TextTeletypeCommand", "TextSmallCapsCommand", "TextSansSerifCommand",
  "TextMediumCommand", "StrikeOutCommand", "TextSuperscriptCommand", "TextSubscriptCommand", "TextColorCommand", "ColorBoxCommand", "HrefCommand",
  "UrlCommand", "FootnoteCommand", "EndnoteCommand", "Cite", "Ref", "Label", "Maketitle", "IncludeGraphics",
  "Book", "Part", "Chapter", "Section", "SubSection", "SubSubSection", "Paragraph", "SubParagraph",
]);
/** Built-in environments drawn by the walk, which `\renewenvironment` may change. */
const ENVIRONMENT_NODES = new Set(["FigureEnvironment", "TableEnvironment", "TabularEnvironment", "ListEnvironment", "EquationEnvironment", "EquationArrayEnvironment"]);
/** What may be in a figure or table besides its images, tables, caption and label, and still be drawn as one. */
const FIGURE_LAYOUT = /^\\(?:centering|raggedright|raggedleft|addtolength|setlength|definecolor|colorlet|tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|hfill|hfil|vfill|hspace\*?|vspace\*?|vskip|hskip|vglue|hglue|kern|par|medskip|smallskip|bigskip|noindent|quad|qquad|captionsetup|addvspace|newline|fontsize|selectfont|fontfamily|newcolumntype|arraybackslash|center|endcenter|Description|rule|[;,:!])$/;
/**
 * What a macro's expansion may hold only as TeX programming: building names, appending to macros, global and expanded
 * definitions, box registers, and conditionals other than the `\ifx` of cvpr's `\onedot` (which the renderer reads).
 */
const TEX_PROGRAMMING = /\\(?:expandafter|csname|endcsname|noexpand|g@addto@macro|@for|@ifnextchar|@ifstar|typeout|gdef|xdef|edef|newif|setbox|advance|multiply|divide|ifdefined|ifcsname|ifnum|ifdim|ifcase|if@[A-Za-z@]*|PackageError|PackageWarning|ClassError)(?![A-Za-z@])|\\if(?!x(?![A-Za-z@]))[a-z]{3,}[A-Za-z@]*/;
/** Whether every `\begin{x}` in a text is closed by its `\end{x}` in it, in order. */
function balancedEnvironments(text: string) {
  if (!text.includes("\\begin") && !text.includes("\\end")) return true;
  const open: string[] = [];
  for (const match of text.matchAll(/\\(begin|end)\s*\{([^{}]*)\}/g)) {
    if (match[1] === "begin") open.push(match[2].trim());
    else if (open.pop() !== match[2].trim()) return false;
  }
  return open.length === 0;
}

/** Lengths a float sets for its table or caption (`\aboverulesep = 2mm`, `\tabcolsep=3pt`): layout. */
const FLOAT_LENGTHS = /^\\(?:tabcolsep|arraycolsep|arrayrulewidth|aboverulesep|belowrulesep|doublerulesep|extrarowheight|abovecaptionskip|belowcaptionskip|textfloatsep|intextsep|columnsep|parskip|parindent)$/;
const GLUE = String.raw`-?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|in|cm|mm|bp|sp|mu|pc|dd|cc|\\[A-Za-z@]+)`;
/** `\vskip 0.15in plus 2pt minus 1pt`, `\kern-3pt`: TeX's glue after a primitive. */
const PRIMITIVE_GLUE = new RegExp(String.raw`^\s*${GLUE}(?:\s*(?:plus|minus)\s*(?:${GLUE}|-?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*fil+))*`);

/**
 * Where a layout command's arguments end, from `at` (just after its name): a star, a primitive's glue, an unbraced
 * `\setlength\tabcolsep{3pt}`, a length assignment `= 2mm`, or the group of `\Description{…}`.
 */
function layoutExtent(state: EditorState, at: number, command: string) {
  const text = read(state, at, Math.min(state.doc.length, at + 400));
  let i = text[0] === "*" ? 1 : 0;
  const rest = () => text.slice(i);
  if (/^\\(?:vskip|hskip|vglue|hglue|kern)$/.test(command)) i += PRIMITIVE_GLUE.exec(rest())?.[0].length ?? 0;
  // `\vspace*{2pt}`: the star keeps the grammar from attaching the group, which follows as text.
  else if (/^\\(?:vspace|hspace|addvspace)$/.test(command)) i += /^\s*\{[^{}]*\}/.exec(rest())?.[0].length ?? 0;
  else if (/^\\(?:setlength|addtolength)$/.test(command)) i += /^\s*\\[A-Za-z@]+\s*\{[^{}]*\}/.exec(rest())?.[0].length ?? 0;
  // `\rule{\textwidth}{0.4pt}` above a figure's notes (the cannabis pass-through paper): a line, drawn as the box's edge.
  else if (command === "\\rule") i += /^\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\}\s*\{[^{}]*\}/.exec(rest())?.[0].length ?? 0;
  else if (FLOAT_LENGTHS.test(command)) i += new RegExp(String.raw`^\s*=?\s*${GLUE}`).exec(rest())?.[0].length ?? 0;
  else if (command === "\\Description") {
    const open = /^\s*(?:\[[^\]]*\]\s*)?\{/.exec(rest());
    const group = open ? readGroup(text, i + open[0].length - 1, TEX_GROUPS) : null;
    if (group) i = group.end;
  }
  return at + i;
}
/**
 * Commands that set layout, spacing, page style or metadata and print nothing where they are, with the `{…}` arguments each
 * reads: a line holding only these folds away, as a `\begin` line does (M-13, B7-25, B4-21, B5-32, B6-23). `\medskip\noindent`,
 * `\vspace{-0.3cm}`, `\onehalfspacing`, `\tikzset{…}`, `\frontmatter`, `\tableofcontents`, acmart's `\ccsdesc[500]{…}`.
 */
const LAYOUT_LINE_ARGS: Record<string, number> = {
  par: 0, noindent: 0, indent: 0, smallskip: 0, medskip: 0, bigskip: 0, vfill: 0, newpage: 0, clearpage: 0, cleardoublepage: 0, pagebreak: 0, nopagebreak: 0,
  newline: 0, linebreak: 0, onehalfspacing: 0, doublespacing: 0, singlespacing: 0, justifying: 0, raggedright: 0, raggedleft: 0, centering: 0,
  frontmatter: 0, mainmatter: 0, backmatter: 0, tableofcontents: 0, listoffigures: 0, listoftables: 0, listoftodos: 0, FloatBarrier: 0, restoregeometry: 0,
  balance: 0, sloppy: 0, fussy: 0, flushbottom: 0, raggedbottom: 0, nolinenumbers: 0, linenumbers: 0, phantomsection: 0, allowdisplaybreaks: 0,
  startcontents: 0, makeatletter: 0, makeatother: 0, protect: 0, relax: 0, vskip: 0,
  tiny: 0, scriptsize: 0, footnotesize: 0, small: 0, normalsize: 0, large: 0, Large: 0, LARGE: 0, huge: 0, Huge: 0,
  vspace: 1, addvspace: 1, setstretch: 1, linespread: 1, thispagestyle: 1, pagestyle: 1, pagenumbering: 1, newgeometry: 1, tikzset: 1, pgfplotsset: 1,
  hypersetup: 1, captionsetup: 1, sisetup: 1, lstset: 1, enlargethispage: 1, hyphenation: 1, ccsdesc: 1,
  setlength: 2, addtolength: 2, colorlet: 2, definecolor: 3, addcontentsline: 3, printcontents: 3,
};

/** The lines from `from` (the first thing on its line) that hold only layout commands with their arguments, or null. */
function layoutLine(state: EditorState, from: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(from);
  if (read(state, line.from, from).trim()) return null;
  const text = read(state, from, Math.min(state.doc.length, from + 4000));
  let i = 0;
  for (;;) {
    i += /^[ \t]*/.exec(text.slice(i))![0].length;
    if (i >= text.length || text[i] === "\n" || text[i] === "\r" || text[i] === "%") break;
    const command = /^\\([A-Za-z@]+)\*?/.exec(text.slice(i, i + 60));
    const count = command && Object.hasOwn(LAYOUT_LINE_ARGS, command[1]) ? LAYOUT_LINE_ARGS[command[1]] : undefined;
    if (!command || count === undefined) return null;
    i += command[0].length;
    if (command[1] === "vskip") { i += PRIMITIVE_GLUE.exec(text.slice(i))?.[0].length ?? 0; continue; }
    const optional = /^[ \t]*\[/.exec(text.slice(i));
    if (optional) {
      const group = readOptional(text, i + optional[0].length - 1, TEX_GROUPS);
      if (!group) return null;
      i = group.end;
    }
    for (let k = 0; k < count; k++) {
      const space = /^\s*/.exec(text.slice(i))![0];
      if (space.includes("\n\n")) return null;
      const at = i + space.length;
      // `\setlength\parindent{0pt}`: an unbraced length.
      const unbraced = k === 0 && /^(?:setlength|addtolength)$/.test(command[1]) ? /^\\[A-Za-z@]+/.exec(text.slice(at, at + 60)) : null;
      if (unbraced) { i = at + unbraced[0].length; continue; }
      const group = text[at] === "{" ? readGroup(text, at, TEX_GROUPS) : null;
      if (!group) return null;
      i = group.end;
    }
  }
  return i > 0 ? { from: line.from, to: state.doc.lineAt(Math.min(state.doc.length, from + i)).to } : null;
}

/** Layout inside a line of text, which prints nothing there: hidden, shown again at the cursor (`\noindent Text`, `\protect\ref`). */
const INLINE_LAYOUT = /^\\(?:noindent|indent|smallskip|medskip|bigskip|protect|justifying|onehalfspacing|doublespacing|singlespacing|newpage|clearpage|cleardoublepage|leavevmode|FloatBarrier|phantomsection|nopagebreak|pagebreak|raggedright|raggedleft)$/;
/** Wrappers whose last argument is text (`\afterpage{…}`, `\raisebox{-0.1cm}{\protect\includegraphics…}`), by the number of `{…}` arguments they read. */
const TEXT_WRAPPERS: Record<string, number> = { "\\afterpage": 1, "\\raisebox": 2 };
/** A macro that only sets TeX's spacing (IEEEtran's `\BIBentryALTinterwordspacing`: `\spaceskip=… \relax`), or `\relax`. */
const SPACING_ONLY = /^\s*(?:\\x?spaceskip\s*=[^]*?\\relax\s*|\\relax\s*)+$/;

/**
 * Where a run of definitions at the start of `text` is (`\providecommand{\x}[1]{#1}`, `\def\x{…}`, `\let\x\y`,
 * `\csname …\endcsname`, `\BIBdecl`, comments): from its first to the end of its last, or null when it does not start there.
 */
function definitionsPrelude(text: string): { from: number; to: number } | null {
  let i = 0;
  let from = -1;
  let to = -1;
  for (;;) {
    i += /^\s*/.exec(text.slice(i))![0].length;
    if (i >= text.length) break;
    if (text[i] === "%") { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end; continue; }
    const command = /^\\([A-Za-z@]+)\*?/.exec(text.slice(i, i + 60));
    if (!command) break;
    const start = i;
    i += command[0].length;
    if (/^(?:providecommand|newcommand|renewcommand|def|gdef|let)$/.test(command[1])) {
      const name = /^\s*(?:\{\s*\\[A-Za-z@]+\s*\}|\\[A-Za-z@]+)(?:#\d)*/.exec(text.slice(i, i + 80));
      if (!name) break;
      i += name[0].length;
      if (command[1] === "let") {
        const target = /^\s*=?\s*\\(?:[A-Za-z@]+|.)/.exec(text.slice(i, i + 80));
        if (!target) break;
        i += target[0].length;
      } else {
        for (let open = /^\s*\[/.exec(text.slice(i)); open; open = /^\s*\[/.exec(text.slice(i))) {
          const optional = readOptional(text, i + open[0].length - 1, TEX_GROUPS);
          if (!optional) return null;
          i = optional.end;
        }
        const open = /^\s*\{/.exec(text.slice(i));
        const body = open ? readGroup(text, i + open[0].length - 1, TEX_GROUPS) : null;
        if (!body) return null;
        i = body.end;
      }
    } else if (command[1] === "csname") {
      const end = text.indexOf("\\endcsname", i);
      if (end < 0) break;
      i = end + "\\endcsname".length;
    } else if (!/^(?:BIBdecl|relax)$/.test(command[1])) break;
    if (from < 0) from = start;
    to = i;
  }
  // Only when nothing else comes before the first item.
  return from >= 0 && !text.slice(to).replace(/%[^\n]*/g, "").trim() ? { from, to } : null;
}

/** Definitions the grammar parses as unknown commands. */
const DEFINITION_COMMANDS = /^\\(?:providecommand|DeclareRobustCommand|DeclareMathOperator|(?:New|Renew|Provide|Declare)Document(?:Command|Environment)|gdef|edef|xdef|newcounter|numberwithin|crefname|Crefname|algnewcommand|algrenewcommand|algdef|algblockdefx|algblock|algtext)$/;
const SECTION_CLASSES: Record<string, string> = {
  Book: "cm-vis-hpart", Part: "cm-vis-hpart", Chapter: "cm-vis-h0", Section: "cm-vis-h1", SubSection: "cm-vis-h2",
  SubSubSection: "cm-vis-h3", Paragraph: "cm-vis-h4", SubParagraph: "cm-vis-h4",
};
/** ulem's commands (the grammar knows its `\sout`): underlines and strike-out. */
const ULEM_STYLES: Record<string, string> = { "\\uline": "cm-vis-u", "\\uuline": "cm-vis-u", "\\uwave": "cm-vis-u", "\\dashuline": "cm-vis-u", "\\dotuline": "cm-vis-u", "\\xout": "cm-vis-s" };
const INLINE_STYLES: Record<string, string> = {
  TextBoldCommand: "cm-vis-b", TextItalicCommand: "cm-vis-i", EmphasisCommand: "cm-vis-em", UnderlineCommand: "cm-vis-u",
  TextTeletypeCommand: "cm-vis-tt", TextSmallCapsCommand: "cm-vis-sc", TextSansSerifCommand: "cm-vis-sf", TextMediumCommand: "cm-vis-md",
  StrikeOutCommand: "cm-vis-s", TextSuperscriptCommand: "cm-vis-sup", TextSubscriptCommand: "cm-vis-sub",
  // `\textnormal{…}`, `\textrm{…}`, `\mbox{…}` in text: upright text, markup hidden.
  MathTextCommand: "cm-vis-rm",
};
const MATH_CONTAINERS = new Set(["DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment", "Math", "InlineMath", "DisplayMath"]);
/** Acknowledgment environments of conference classes (NeurIPS `ack`, ACM `acks`). */
const ACKNOWLEDGMENTS = /^(?:ack|acks|acknowledgments|acknowledgements|acknowledgment|acknowledgement)$/;
const BULLETS = ["•", "–", "∗", "·"];
const TEXT_BLOCKS: Record<string, string> = {
  quote: "cm-vis-quote", quotation: "cm-vis-quote", verse: "cm-vis-quote", center: "cm-vis-center", flushleft: "cm-vis-flushleft",
  flushright: "cm-vis-flushright", abstract: "cm-vis-abstract",
  // The appendix package's environment: its lines fold away, its sections are lettered (numbering.ts).
  appendices: "cm-vis-appendices",
  // `\begin{appendix}`, which runs `\appendix` (KOMA papers): the same.
  appendix: "cm-vis-appendices",
  // `tabbing`: lines of text with tab stops (`\=`, `\>`), drawn as gaps (Featherweight Go's proofs).
  tabbing: "cm-vis-tabbing",
  // setspace's line spacing and pdflscape's rotated pages: layout, whose lines fold away (applied economics papers).
  singlespace: "cm-vis-sized", onehalfspace: "cm-vis-sized", doublespace: "cm-vis-sized", spacing: "cm-vis-sized", landscape: "cm-vis-sized",
  // Keywords under an abstract (JMLR, SIAM, IEEE).
  keywords: "cm-vis-keywords", IEEEkeywords: "cm-vis-keywords",
  // amsmath's `subequations` (numbering 3a, 3b): its equations are drawn on their own, and its lines fold away.
  subequations: "cm-vis-sized",
  // `\begin{small} … \end{small}`: a size, which draws nothing; its lines fold away.
  ...Object.fromEntries(["tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge", "Huge"].map((size) => [size, "cm-vis-sized"])),
};
/** Node types the walk does something with; it only goes inside the others. */
const HANDLED = new Set([
  ...Object.keys(SECTION_CLASSES), ...Object.keys(INLINE_STYLES), "TextColorCommand", "ColorBoxCommand", "HrefCommand", "UrlCommand",
  "FootnoteCommand", "EndnoteCommand", "DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment",
  "Cite", "Ref", "Label", "FigureEnvironment", "TableEnvironment", "TabularEnvironment", "ListEnvironment", "Item", "Environment",
  "EndEnv", "Maketitle", "IncludeGraphics", "LineBreak", "Tilde", "Normal", "UnknownCommand", "Group",
  "BibliographyCommand", "BibliographyStyleCommand", "Centering", "SetLengthCommand",
]);
const THEOREM_STYLE_CLASSES ={ plain: "cm-vis-thm-plain", definition: "cm-vis-thm-definition", remark: "cm-vis-thm-remark" };
/** Layout commands in user environment code that draw nothing worth showing. */
const LAYOUT_NOISE = /\\(?:par|noindent|indent|medskip|smallskip|bigskip|hfill|vfill|null|ignorespaces|unskip|relax|nopagebreak|newline|centering|raggedright|raggedleft|normalfont|itshape|upshape|bfseries|mdseries|rmfamily|sffamily|ttfamily)(?![A-Za-z])|\\[vh]space\*?\s*\{[^}]*\}|\\(?:begin|end)\s*\{[^}]*\}(?:\[[^\]]*\])?|\\item(?:\[([^\]]*)\])?/g;

/** What a reference list is headed: the book classes' "Bibliography", else "References". */
function bibliographyHeading(defs: LatexDefinitions) {
  return /^(?:book|report|memoir|scrbook|scrreprt)$/.test(defs.documentClass ?? "") ? "Bibliography" : "References";
}

/** The range of whole lines `[from, to]` covers, when nothing else is on them. */
export function aloneOnLines(doc: Text, from: number, to: number) {
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  if (doc.sliceString(first.from, from).trim() || doc.sliceString(to, last.to).trim()) return null;
  return { from: first.from, to: last.to };
}

function read(state: EditorState, from: number, to: number) {
  return state.doc.sliceString(from, to);
}

function endName(node: SyntaxNode, state: EditorState) {
  const end = node.getChild("EndEnv");
  const group = end?.getChild("EnvNameGroup");
  return group ? read(state, group.from + 1, group.to - 1).trim() : null;
}

/** An environment with a matching `\end` and no parse error at its edges. */
export function wellFormedEnvironment(node: SyntaxNode, state: EditorState) {
  const begin = node.getChild("BeginEnv");
  const end = node.getChild("EndEnv");
  if (!begin || !end || hasDirectError(node) || hasDirectError(begin) || hasDirectError(end)) return null;
  const name = environmentName(node, (from, to) => read(state, from, to));
  if (!name || name !== endName(node, state)) return null;
  return { name, begin, end, content: node.getChild("Content") };
}

/** Width of an `\includegraphics` as CSS: fractions of the text width become percentages. */
function graphicsWidth(options: string | null) {
  if (!options) return undefined;
  const width = /(?:^|,)\s*width\s*=\s*([^,]+)/.exec(options)?.[1]?.trim();
  if (!width) return undefined;
  const fraction = /^([\d.]*)\s*\\(?:textwidth|linewidth|columnwidth|hsize)$/.exec(width);
  if (fraction) return `${Math.min(100, (Number(fraction[1] || 1) * 100))}%`;
  const length = /^([\d.]+)\s*(cm|mm|in|pt|em|ex)$/.exec(width);
  return length ? `${length[1]}${length[2]}` : undefined;
}

/** The enumerate counter of a numbered list at `depth` (`enumi`…`enumiv`). */
function enumCounter(depth: number) {
  return ["enumi", "enumii", "enumiii", "enumiv"][depth - 1] ?? null;
}

/** What a `\setcounter`, `\addtocounter` or `\stepcounter` of `counter` does to a list's item count; null for other commands. */
function counterChange(state: EditorState, node: SyntaxNode, counter: string | null): ((count: number) => number) | null {
  if (!counter) return null;
  const ctrl = node.firstChild;
  const command = ctrl ? read(state, ctrl.from, ctrl.to) : "";
  if (!/^\\(?:setcounter|addtocounter|stepcounter|refstepcounter)$/.test(command)) return null;
  const args = commandArguments(node).filter((arg) => !arg.optional).map((arg) => { const inner = argumentInner(arg.node); return inner ? read(state, inner.from, inner.to).trim() : ""; });
  if (args[0] !== counter) return null;
  if (command === "\\stepcounter" || command === "\\refstepcounter") return (count) => count + 1;
  const amount = Number(args[1]);
  if (!args[1] || !Number.isFinite(amount)) return null;
  return command === "\\setcounter" ? () => amount : (count) => count + amount;
}

/** The item count of `list` (not of lists inside it) at `pos`: its `\item`s before it, and changes to its counter. */
function itemsBefore(list: SyntaxNode, pos: number, state: EditorState, counter: string | null, defs: LatexDefinitions) {
  let count = 0;
  const content = list.getChild("Content");
  if (!content) return 0;
  const cursor = content.cursor();
  const itemMacros = itemMacroNames(defs);
  const walk = (): void => {
    do {
      if (cursor.from >= pos) return;
      if (cursor.name === "ListEnvironment") continue;
      if (cursor.name === "Item") { if (cursor.to <= pos && !cursor.node.getChild("OptionalArgument")) count++; continue; }
      if (cursor.name === "UnknownCommand") {
        // `\step` for `\item` counts as an item.
        const ctrl = cursor.node.firstChild;
        if (itemMacros.size && ctrl && cursor.to <= pos && itemMacros.has(state.doc.sliceString(ctrl.from + 1, ctrl.to))) { count++; continue; }
        const change = cursor.to <= pos ? counterChange(state, cursor.node, counter) : null;
        if (change) { count = change(count); continue; }
      }
      if (cursor.firstChild()) { walk(); cursor.parent(); }
    } while (cursor.nextSibling());
  };
  if (cursor.firstChild()) walk();
  return count;
}

/** The first `\label{…}` after `pos` on the same line, with only spaces between, as a node. */
function trailingLabel(state: EditorState, container: SyntaxNode | null, pos: number) {
  if (!container) return null;
  const line = state.doc.lineAt(pos);
  let found: SyntaxNode | null = null;
  container.cursor().iterate((ref) => {
    if (found || ref.from > line.to) return false;
    if (ref.to <= pos) return false;
    if (ref.name === "Label") {
      if (ref.from >= pos && !read(state, pos, ref.from).trim() && ref.to <= line.to) found = ref.node;
      return false;
    }
    return undefined;
  });
  return found as SyntaxNode | null;
}

/** Strips layout commands from a user environment's code, keeping `\item[label]` labels. */
/** The constructs at the top of a parsed piece of LaTeX (a macro's expansion), without wrappers, spaces and comments. */
function topConstructs(text: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (node: SyntaxNode) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      const name = child.name;
      if (name === "Whitespace" || name === "NewLine" || name === "Comment" || name === "BlankLine") continue;
      if (name === "Normal" && !text.slice(child.from, child.to).trim()) continue;
      if (name === "Text" || name === "Command" || name === "KnownCommand" || name === "KnownEnvironment") { visit(child); continue; }
      out.push(child);
    }
  };
  visit(latexParser.parse(text).topNode);
  return out;
}

/** A list body's items, split at `\item` outside groups and nested environments; null when text comes before the first. */
function splitItems(body: string): string[] | null {
  const items: string[] = [];
  let depth = 0;
  let environments = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\\") {
      if (body.startsWith("\\begin", i)) environments++;
      else if (body.startsWith("\\end", i)) environments--;
      else if (depth === 0 && environments === 0 && /^\\item(?![A-Za-z@])/.test(body.slice(i, i + 6))) {
        if (start < 0) { if (body.slice(0, i).trim()) return null; } else items.push(body.slice(start, i).trim());
        start = i + 5;
        const optional = /^\s*\[[^\]]*\]/.exec(body.slice(start));
        if (optional) start += optional[0].length;
        i = start - 1;
        continue;
      }
      i++;
    }
  }
  if (start < 0) return null;
  items.push(body.slice(start).trim());
  return items;
}

/** The environments a document opens and closes through macros, per document version. */
const regionCache = new WeakMap<Text, { defs: LatexDefinitions; regions: MacroEnvironmentRegion[] }>();
export function macroRegionsFor(doc: Text, defs: LatexDefinitions) {
  const cached = regionCache.get(doc);
  if (cached?.defs === defs) return cached.regions;
  const regions = macroEnvironmentRegions(() => doc.toString(), defs);
  regionCache.set(doc, { defs, regions });
  return regions;
}

function environmentCode(code: string) {
  return code.replace(LAYOUT_NOISE, (_, item?: string) => (item !== undefined ? item : "")).replace(/\s+/g, " ").trim();
}

/** Commands a user environment's code may keep that its header draws: text styles, sizes, colours, symbols, references. */
const DRAWABLE_CODE = /^\\(?:textbf|textit|emph|textsc|textsf|texttt|textrm|textup|textsl|textmd|underline|textcolor|color|tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge|bf|it|em|sc|sf|tt|rm|sl|ldots|dots|textellipsis|quad|qquad|S|P|dag|ddag|textbullet|textendash|textemdash|ref|eqref|cite|label|footnote|thanks|LaTeX|TeX)$/;
const DRAWABLE_SYMBOLS = new Set(["\\", ",", " ", "%", "&", "#", "_", "{", "}", "$", "@"]);

/**
 * What a user environment's code shows in its header ("" when it shows nothing), or null when it holds more than
 * text: conditionals, counters, glue and boxes of a size (Julia's `jinput`, `\ifx#1\relax…\vskip2ex…minipage…`), which
 * a header would show half-read. Then the `\begin` stays as source, and the body is drawn.
 */
function drawableEnvironmentCode(code: string): string | null {
  const text = environmentCode(code);
  // Formulas are drawn by KaTeX; around them, text and the commands above.
  const outside = text.replace(/\$[^$]*\$/g, "");
  for (const match of outside.matchAll(/\\([A-Za-z@]+|[^A-Za-z@])/g)) {
    if (match[1].length === 1 && !/[A-Za-z@]/.test(match[1]) ? !DRAWABLE_SYMBOLS.has(match[1]) : !DRAWABLE_CODE.test(`\\${match[1]}`)) return null;
  }
  if (/#\d/.test(outside)) return null;
  // Lengths and glue left by commands the noise filter removed (`\vskip2ex plus .2ex`, `{.19\textwidth}`).
  if (/(?:^|[^A-Za-z])-?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|in|cm|mm|bp|sp)(?![A-Za-z])|(?:^|\s)(?:plus|minus)\s/.test(outside)) return null;
  return text;
}

/**
 * The named-theorem idiom (O'Donnell's `\newenvironment{named}[1]{\renewcommand{\theoremname}{#1}\begin{namedtheorem}}`
 * with `\newtheorem*{namedtheorem}{\theoremname}`): an unnumbered theorem whose heading is the argument. Null otherwise.
 */
function namedTheorem(code: string, defs: LatexDefinitions) {
  const match = /^\s*\\(?:re)?newcommand\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\\begin\s*\{([^{}]+)\}\s*$/.exec(code);
  if (!match) return null;
  const theorem = defs.theorems.get(match[4].trim());
  if (!theorem || theorem.numbered || theorem.title.replace(/\\protect\s*/g, "").trim() !== `\\${match[1] ?? match[2]}`) return null;
  return { theorem, title: match[3].trim() };
}

/** `inline`: a list run into its paragraph (paralist's `inparaenum`), whose lines are not indented. */
type ListContext = { node: SyntaxNode; variant: "bullet" | "number" | "description"; depth: number; count: number; template: string | null; inline?: boolean };
/** paralist's lists, as the lists they are; the `inpara` ones run into their paragraph (Depth Anything's `inparaenum`). */
const PARALIST: Record<string, "enumerate" | "itemize" | "description"> = {
  compactenum: "enumerate", asparaenum: "enumerate", inparaenum: "enumerate", compactitem: "itemize", asparaitem: "itemize", inparaitem: "itemize",
  compactdesc: "description", asparadesc: "description", inparadesc: "description",
};

/**
 * Walks the constructs whose start is in [from, to). Constructs that start
 * before `from` are not emitted, so callers widen `from` to the start of any
 * construct overlapping it.
 */
export function walkConstructs(env: WalkEnvironment, from: number, to: number, emit: (construct: Construct) => void) {
  const { state, tree, defs } = env;
  const doc = state.doc;
  const structural = env.layer === "structural";
  const lists: ListContext[] = [];
  /** Ranges already hidden by a construct (a heading's trailing label), never walked again. */
  const consumed: Array<[number, number]> = [];
  let symbolsUntil = -1;

  if (env.preambleEnd > 0 && from === 0) {
    if (structural) {
      emit(env.preambleOpen
        ? { kind: "preamble", from: 0, to: 0, reveal: "toggle", replaces: [{ from: 0, to: 0, widget: new PreambleWidget(true, env.preambleSummary), block: true, side: -1 }] }
        : { kind: "preamble", from: 0, to: env.preambleEnd, reveal: "toggle", replaces: [{ from: 0, to: env.preambleEnd, widget: new PreambleWidget(false, env.preambleSummary), block: true }] });
    }
  }

  // A walk that starts inside a definition: the rest of it is source too.
  const around = from > 0 ? definitionExtentAround(defs, from) : null;
  if (around) consumed.push([around.from, around.to]);
  // A walk that starts inside an environment opened and closed by macros (`\beq … \eeq`): it is drawn whole, from its start.
  const insideRegion = from > 0 && structureMacroNames(defs).size ? macroEnvironmentRegionAt(macroRegionsFor(doc, defs), from, true) : null;
  if (insideRegion && insideRegion.from < from) consumed.push([insideRegion.from, insideRegion.to]);
  // `\iffalse … \fi` is left out of the document: shown as faded source, with nothing in it drawn.
  const disabled = (state.field(disabledField, false) ?? []).filter((region) => region.to > from && region.from < to);
  for (const region of disabled) {
    consumed.push([region.from, region.to]);
    if (region.from >= from) emit({ kind: "disabled", from: region.from, to: region.to, reveal: "never", replaces: [], lines: [{ from: region.from, to: region.to, class: "cm-vis-disabled" }] });
  }
  /** The disabled region a node starts in: nothing is drawn for it, though what follows the `\fi` inside it is. */
  const startsDisabled = (pos: number) => disabled.find((region) => region.from <= pos && pos < region.to);

  /** A use of a macro that writes a figure's caption (`\mycap{…}` for `\caption{…}`), maybe with a label: the caption's text. */
  const captionMacro = (use: SyntaxNode): string | null => {
    const ctrl = use.firstChild;
    const name = ctrl ? read(state, ctrl.from + 1, ctrl.to) : "";
    if (!name || !structureMacroNames(defs).has(name) || !macroAt(defs, name, use.from)) return null;
    const expansion = expandLatexMacroUse(read(state, use.from, Math.min(doc.length, use.from + 4000)), defs, { mode: "text", pos: use.from });
    if (!expansion) return null;
    const parts = topConstructs(expansion.text);
    if (parts[0]?.name !== "Caption" || parts.length > 2 || (parts.length === 2 && parts[1].name !== "Label")) return null;
    const range = argumentInner(parts[0].getChild("TextArgument") ?? parts[0]);
    return range ? expansion.text.slice(range.from, range.to) : null;
  };

  const readNode = (start: number, end: number) => read(state, start, end);

  /**
   * `\ref` and `\eqref` in a formula, which KaTeX has neither of: the number they show, as text. The
   * widget keeps the formula (`referenced`) to draw it again when numbering changes.
   */
  const withReferences = (latex: string) => withReferenceNumbers(latex, state);
  const referenced = (latex: string) => (REFERENCE_IN_MATH.test(latex) ? latex : null);

  /**
   * A group whose content starts with a font or size switch (`{\bf …}`): the class it styles with
   * ("" for a size: one size here), where its text starts (after the switch and its spaces) and its closing brace.
   */
  const groupSwitch = (group: SyntaxNode) => {
    const close = group.lastChild;
    if (!close || close.name !== "CloseBrace" || hasDirectError(group)) return null;
    // A group, or a command's argument (`\newblock {\em CoRR}`).
    let first: SyntaxNode | null = (group.getChild("Text") ?? group.getChild("LongArg"))?.firstChild ?? null;
    while (first && (first.name === "Whitespace" || first.name === "NewLine" || (first.name === "Normal" && !readNode(first.from, first.to).trim()))) first = first.nextSibling;
    const command = first?.name === "Command" ? first.firstChild : null;
    const ctrl = command?.name === "UnknownCommand" ? command.firstChild : null;
    if (!ctrl || ctrl.name !== "CtrlSeq") return null;
    const text = readNode(ctrl.from, ctrl.to);
    // `{\color{red} text}`: the colour's argument is part of the switch.
    const color = text === "\\color" ? colorSwitch(command!) : null;
    const className = color ? "cm-vis-color" : FONT_SWITCHES[text] ?? (SIZE_COMMAND.test(text) ? "" : undefined);
    if (className === undefined) return null;
    // TeX skips the spaces after a control word.
    let textFrom = color ? color.end : ctrl.to;
    while (textFrom < close.from && /\s/.test(readNode(textFrom, textFrom + 1))) textFrom++;
    return { className, textFrom, close, style: color ? `color: ${color.css}` : undefined };
  };

  /** `\color[model]{name}`: its CSS colour and where its argument ends; null for a colour it cannot draw. */
  const colorSwitch = (command: SyntaxNode) => {
    const args = commandArguments(command);
    const model = args.find((arg) => arg.optional);
    const name = args.find((arg) => !arg.optional);
    const nameRange = name && argumentInner(name.node);
    const modelRange = model && argumentInner(model.node);
    if (!name || !nameRange || hasDirectError(command)) return null;
    const css = cssColor(modelRange ? readNode(modelRange.from, modelRange.to) : null, readNode(nameRange.from, nameRange.to), defs.colors);
    return css ? { css, end: name.node.to } : null;
  };

  /**
   * Where a switch (`\color{red}`) stops applying (`text`: the end of its group or environment's content) and
   * where its container closes (`end`: an edit to the `}` or `\end` changes it); null at the document's top
   * level, where it would colour everything after it.
   */
  const switchEnd = (node: SyntaxNode) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      // A heading's argument too: `\section{\bf Introduction}` (B7-16).
      if (parent.name === "Group" || parent.name === "NonEmptyGroup" || parent.name === "TextArgument" || parent.name === "ShortTextArgument" || parent.name === "SectioningArgument") {
        const close = parent.lastChild;
        return close?.name === "CloseBrace" ? { text: close.from, end: close.to } : null;
      }
      if (parent.name === "Content") {
        const env = parent.parent;
        return env && env.name !== "DocumentEnvironment" && /Environment$/.test(env.name) ? { text: parent.to, end: env.to } : null;
      }
    }
    return null;
  };

  /** A tabular (or a longtable), drawn as a grid when its cells can be read. */
  const drawTabular = (node: SyntaxNode): false | undefined => {
    const formed = wellFormedEnvironment(node, state);
    if (!formed) return undefined;
    if (/^(?:longtable|xltabular)\*?$/.test(formed.name)) {
      // Its caption, first head, body and last foot, with rows written through the document's macros expanded.
      // Drawn, not edited by cell; one it cannot read has its parts drawn on their own.
      if (!structural) return false;
      const display = readLongTable(read(state, node.from, node.to), expandAt(node.from), defs.columnTypes);
      if (!display) return undefined;
      const span = aloneOnLines(doc, node.from, node.to);
      const range = span ?? { from: node.from, to: node.to };
      const spec: FigureSpec = {
        env: formed.name, images: [], caption: display.caption, captionPos: display.captionAt >= 0 ? node.from + display.captionAt : node.from,
        start: node.from, kind: "table", numberOffset: node.from - range.from, length: range.to - range.from,
        tabulars: [{ source: display.tabular, offset: node.from - range.from, readOnly: true }], captionAbove: true,
      };
      emit({ kind: "table", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new FigureWidget(spec) }] });
      return false;
    }
    if (!structural) return false;
    const source = read(state, node.from, node.to);
    // Rows written through the document's macros are drawn from their expansion (read-only).
    const built = macroBuiltTabular(source, expandRowsAt(node.from), defs.columnTypes);
    // A tabular of rules only (`\hline\hline`) draws nothing to show: it stays source.
    if (!built && !parseTabular(source, 0, defs.columnTypes)?.rows.length) return undefined;
    const span = aloneOnLines(doc, node.from, node.to);
    const range = span ?? { from: node.from, to: node.to };
    emit({ kind: "table", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new TableWidget(built ?? source, node.from - range.from, range.to - range.from, !!built) }] });
    return false;
  };

  /** A figure, table or algorithm float, drawn whole when the figure widget shows everything in it. */
  const drawFloat = (node: SyntaxNode, kind: FigureContent["kind"]): false | undefined => {
    const formed = wellFormedEnvironment(node, state);
    if (!formed) return undefined;
    if (!structural) return false;
    const figure = figureSpec(node, formed.name, state, defs, expandRowsAt(node.from), captionMacro, kind);
    if (!figure) return undefined;
    const span = aloneOnLines(doc, node.from, node.to);
    const range = span ?? { from: node.from, to: node.to };
    // Offsets were from the environment's start: from here on they are from the widget's.
    for (const content of [figure, ...(figure.panels ?? [])]) {
      content.numberOffset += node.from - range.from;
      for (const tabular of content.tabulars ?? []) tabular.offset -= range.from;
    }
    figure.length = range.to - range.from;
    emit({ kind: "figure", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new FigureWidget(figure) }] });
    return false;
  };

  /** An item marker in the current list for `\item` (or a macro for it) at [at, to]; `optional` is its `[label]`. */
  const emitItem = (at: number, to: number, optional: string | null) => {
    const list = lists[lists.length - 1];
    if (!list) return false;
    let label: string;
    let variant = list.variant;
    // A label with a formula or another command (`\item[$(i)$]`, `\item[\textbf{Step 1}]`, `\item[$\qKG(1^\secp)$:]`) is drawn as LaTeX.
    let latex = false;
    if (optional !== null) {
      latex = /[\\$]/.test(optional);
      label = latex ? optional.trim() : optional.replace(/[{}]/g, "").trim();
      if (list.variant !== "description") variant = "number";
    } else if (list.variant === "number") {
      list.count++;
      label = enumerateItemLabel(list.count, list.depth, list.template);
    } else label = list.variant === "description" ? "" : BULLETS[(list.depth - 1) % BULLETS.length];
    const line = doc.lineAt(at);
    const replaceFrom = read(state, line.from, at).trim() ? at : line.from;
    emit({ kind: "item", from: replaceFrom, to, reveal: "never", replaces: [{ from: replaceFrom, to, widget: new ItemMarkerWidget(label, variant, list.depth, { latex, inline: list.inline }) }] });
    return true;
  };

  const isConsumed = (node: { from: number; to: number }) => consumed.some(([start, end]) => node.from >= start && node.to <= end);

  /** Expands the document's macros in text at `pos`; null when the expansion fails. */
  const expandAt = (pos: number) => (text: string) => {
    const expanded = expandLatexMacros(text, defs, { mode: "text", pos });
    return expanded.ok ? expanded.text : null;
  };
  /** For a tabular: expands only when it uses a macro that writes rows or cells; else its text as it is. */
  const expandRowsAt = (pos: number) => {
    const expand = expandAt(pos);
    return (text: string) => {
      const rowMacros = rowMacroNames(defs);
      if (!rowMacros.size || ![...text.matchAll(/\\([A-Za-z@]+)/g)].some((use) => rowMacros.has(use[1]))) return text;
      return expand(text);
    };
  };

  /** The document's own definition of a built-in command at `node` (`\renewcommand{\textbf}`), which replaces the built-in drawing. */
  const overridden = (node: SyntaxNode) => {
    const command = node.getChild("SectioningCommand") ?? node;
    const name = /^\\([A-Za-z@]+)/.exec(read(state, command.from, Math.min(doc.length, command.from + 64)));
    const macro = name ? macroAt(defs, name[1], command.from) : null;
    // `\let\cite\textcite`: another command of the same kind, still drawn as one (with the target's name).
    if (macro?.alias && ALIAS_FAMILIES[node.name]?.test(macro.body)) return null;
    // `\providecommand` does nothing for a command LaTeX already has.
    return name && macro && !macro.provided ? { node: command, name: name[1] } : null;
  };

  /** Hides a `\begin`/`\end` line when it is alone on its line, collapsing it; else only the markup. */
  const collapseLine = (node: { from: number; to: number }, kind: string, extra?: Replace) => {
    const span = aloneOnLines(doc, node.from, node.to);
    const replace: Replace = extra ?? { from: span ? span.from : node.from, to: span ? span.to : node.to };
    emit({
      kind, from: replace.from, to: replace.to, reveal: "line", wholeLine: true, replaces: [replace],
      hiddenLines: span && !extra ? [{ from: span.from, to: span.to, class: "cm-vis-collapsed" }] : undefined,
    });
  };

  tree.iterate({
    from,
    to,
    enter(ref) {
      const name = ref.name;
      if (SKIPPED.has(name)) {
        // The grammar may end a definition early (`\newcommand*`): its name and body that follow are source too.
        const extent = DEFINITION_NODES.has(name) ? definitionExtentAt(defs, ref.from) : null;
        if (extent && extent.to > ref.to) consumed.push([ref.from, extent.to]);
        return false;
      }
      if (env.preambleEnd > 0 && ref.to <= env.preambleEnd) return false;
      if (consumed.length && isConsumed(ref)) return false;
      // A node starting before an `\iffalse`'s `\fi` and running past it (`\iffalse \section{A} \fi more`): only what follows is drawn.
      if (disabled.length && startsDisabled(ref.from)) return undefined;
      // Most nodes are text and argument holders: go inside without building a node object.
      if (!HANDLED.has(name)) return undefined;
      const node = ref.node;
      const starts = node.from >= from && node.from < to;

      if (OVERRIDABLE.has(name)) {
        // A redefined built-in is drawn as the document's macro, or stays source.
        const override = overridden(node);
        if (override) {
          if (override.node.from < from || override.node.from >= to) return undefined;
          const result = macroUse(override.node, override.name);
          // A heading's text after the command is still walked.
          return override.node === node ? result : undefined;
        }
      }
      if (ENVIRONMENT_NODES.has(name) && defs.environments.has(environmentName(node, (start, end) => read(state, start, end)) ?? "")) return undefined;

      if (name in SECTION_CLASSES) {
        const command = node.getChild("SectioningCommand");
        if (!command || command.from < from || command.from >= to) return;
        const argument = command.getChild("SectioningArgument");
        const inner = argument && argumentInner(argument);
        if (!argument || !inner || inner.to <= inner.from || hasDirectError(command)) return;
        const label = trailingLabel(state, node.getChild("Content"), argument.to);
        const end = label ? label.to : argument.to;
        if (label) consumed.push([label.from, label.to]);
        // \paragraph and \subparagraph are run-in: only the title is a heading, the text after it is not.
        const runIn = name === "Paragraph" || name === "SubParagraph";
        emit({
          kind: "heading", from: command.from, to: end, reveal: "line", lead: inner.from,
          replaces: structural ? [
            { from: command.from, to: inner.from, widget: new HeadingNumberWidget(SECTION_CLASSES[name], read(state, command.from, inner.from)) },
            { from: inner.to, to: end },
          ] : [],
          marks: runIn ? [{ from: inner.from, to: inner.to, class: "cm-vis-runin" }] : undefined,
          lines: runIn ? undefined : [{ from: command.from, to: inner.to, class: `cm-vis-heading ${SECTION_CLASSES[name]}` }],
        });
        return;
      }

      if (!starts) {
        // Containers that began before the walked range: keep list context for the items inside.
        if (name === "ListEnvironment") {
          const formed = wellFormedEnvironment(node, state);
          if (formed) {
            const list = listContext(node, formed.name, lists, state, 0);
            list.count = itemsBefore(node, from, state, list.variant === "number" ? enumCounter(list.depth) : null, defs);
            lists.push(list);
          }
        }
        return;
      }

      const inlineStyle = INLINE_STYLES[name];
      if (inlineStyle) {
        const argument = node.getChild("TextArgument") ?? node.getChild("ShortTextArgument");
        const inner = argument && argumentInner(argument);
        if (!inner || inner.to <= inner.from || hasDirectError(node)) return;
        emit({
          kind: "style", from: node.from, to: node.to, reveal: "touch",
          replaces: [{ from: node.from, to: inner.from }, { from: inner.to, to: node.to }],
          marks: [{ from: inner.from, to: inner.to, class: inlineStyle }],
        });
        return;
      }

      // `{\bf bold}`, `{\tt [CLS]}`, `{\small text}`: a group opened by a font or size switch styles what follows it.
      if (name === "Group") {
        const switched = groupSwitch(node);
        if (!switched) return;
        consumed.push([node.from, switched.textFrom]);
        emit({
          kind: "style", from: node.from, to: node.to, reveal: "touch",
          replaces: [{ from: node.from, to: switched.textFrom }, { from: switched.close.from, to: node.to }],
          marks: switched.className ? [{ from: switched.textFrom, to: switched.close.from, class: switched.className, attributes: switched.style ? { style: switched.style } : undefined }] : undefined,
        });
        return;
      }

      switch (name) {
        case "TextColorCommand": case "ColorBoxCommand": {
          const args = commandArguments(node);
          const model = args.find((arg) => arg.optional);
          const mandatory = args.filter((arg) => !arg.optional);
          const colorRange = mandatory[0] && argumentInner(mandatory[0].node);
          const textRange = mandatory[1] && argumentInner(mandatory[1].node);
          if (!colorRange || !textRange || textRange.to <= textRange.from || hasDirectError(node)) return;
          const modelRange = model && argumentInner(model.node);
          const color = cssColor(modelRange ? read(state, modelRange.from, modelRange.to) : null, read(state, colorRange.from, colorRange.to), defs.colors);
          if (!color) return;
          emit({
            kind: "style", from: node.from, to: node.to, reveal: "touch",
            replaces: [{ from: node.from, to: textRange.from }, { from: textRange.to, to: node.to }],
            marks: [{ from: textRange.from, to: textRange.to, class: name === "ColorBoxCommand" ? "cm-vis-colorbox" : "cm-vis-color", attributes: { style: `${name === "ColorBoxCommand" ? "background-color" : "color"}: ${color}` } }],
          });
          return;
        }
        case "HrefCommand": case "UrlCommand": {
          const url = node.getChild("UrlArgument");
          const urlRange = url && argumentInner(url);
          const text = name === "HrefCommand" ? (node.getChild("ShortTextArgument") ?? node.getChild("TextArgument")) : url;
          const textRange = text && argumentInner(text);
          if (!urlRange || !textRange || textRange.to <= textRange.from || hasDirectError(node)) return;
          emit({
            kind: "style", from: node.from, to: node.to, reveal: "touch",
            replaces: [{ from: node.from, to: textRange.from }, { from: textRange.to, to: node.to }],
            marks: [{ from: textRange.from, to: textRange.to, class: "cm-vis-link", attributes: { "data-href": read(state, urlRange.from, urlRange.to), title: `${read(state, urlRange.from, urlRange.to)} (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}-click to open)` } }],
          });
          return;
        }
        case "FootnoteCommand": case "EndnoteCommand": {
          const argument = node.getChild("TextArgument");
          const inner = argument && argumentInner(argument);
          if (!inner || hasDirectError(node)) return;
          // `\footnote{{…}}`: braces around the whole note print nothing (B6-22); a group opened by a switch is drawn as one.
          const body = read(state, inner.from, inner.to);
          const lead = /^\s*/.exec(body)![0].length;
          const group = body[lead] === "{" && body[lead + 1] !== "\\" ? readGroup(body, lead, TEX_GROUPS) : null;
          const braces = structural && group && !body.slice(group.end).trim() ? [{ from: inner.from + lead, to: inner.from + lead + 1 }, { from: inner.from + group.end - 1, to: inner.from + group.end }] : [];
          emit({
            kind: "footnote", from: node.from, to: node.to, reveal: "touch",
            replaces: structural ? [{ from: node.from, to: inner.from, widget: new FootnoteMarkWidget() }, ...braces, { from: inner.to, to: node.to }] : [],
            marks: [{ from: inner.from, to: inner.to, class: "cm-vis-footnote" }],
          });
          return;
        }
        case "DollarMath": case "BracketMath": case "ParenMath": {
          if (!structural) return false;
          // `\renewcommand{\(}{\left(}` (SIAM): `\(…\)` are the document's own delimiters, not a formula.
          if ((name === "ParenMath" && macroAt(defs, "(", node.from)) || (name === "BracketMath" && macroAt(defs, "[", node.from))) return undefined;
          for (let parent = node.parent; parent; parent = parent.parent) if (MATH_CONTAINERS.has(parent.name)) return false;
          if (hasDirectError(node) || node.lastChild?.type.isError) return false;
          const displayNode = node.getChild("DisplayMath");
          const display = name === "BracketMath" || !!displayNode;
          const math = displayNode ? displayNode.getChild("Math") : name === "DollarMath" ? node.getChild("InlineMath")?.getChild("Math") : node.getChild("Math");
          if (!math || (displayNode && hasDirectError(displayNode))) return false;
          const latex = read(state, math.from, math.to);
          if (!latex.trim()) return false;
          const expanded = expandLatexMacros(latex, defs, { mode: "math", pos: node.from });
          const html = expanded.ok ? renderKatex(withReferences(expanded.text), display) : null;
          if (!html) return false;
          const span = display ? aloneOnLines(doc, node.from, node.to) : null;
          const range = span ?? { from: node.from, to: node.to };
          emit({
            kind: "math", from: range.from, to: range.to, reveal: "strict",
            replaces: [{ from: range.from, to: range.to, block: !!span, widget: new MathWidget(html, display, !!span, read(state, node.from, node.to), false, node.from - range.from, range.to - range.from, referenced(expanded.text)) }],
          });
          return false;
        }
        case "EquationEnvironment": case "EquationArrayEnvironment": {
          if (!structural) return false;
          for (let parent = node.parent; parent; parent = parent.parent) if (MATH_CONTAINERS.has(parent.name)) return false;
          const formed = wellFormedEnvironment(node, state);
          if (!formed || !formed.content) return false;
          // The environment's own arguments (`\begin{array}{cc}`, `\begin{alignat}{2}`), which the grammar keeps in
          // BeginEnv: KaTeX needs them in front of the body.
          const begin = node.getChild("BeginEnv");
          const nameGroup = begin?.getChild("EnvNameGroup");
          const args = begin && nameGroup ? read(state, nameGroup.to, begin.to) : "";
          const body = (args.trim() ? args.trim() : "") + read(state, formed.content.from, formed.content.to);
          const source = katexForEnvironment(formed.name, body);
          const expanded = expandLatexMacros(source.latex, defs, { mode: "math", pos: node.from });
          // Rows numbered by hand (`\addtocounter{equation}{1}\tag{\theequation}`) are numbered rows.
          const counted = expanded.ok ? countedRows(expanded.text) : null;
          const latex = counted?.latex ?? expanded.text;
          const html = expanded.ok ? renderKatex(withReferences(latex), !source.inline) : null;
          if (!html) return false;
          const span = source.inline ? null : aloneOnLines(doc, node.from, node.to);
          const range = span ?? { from: node.from, to: node.to };
          emit({
            kind: "math", from: range.from, to: range.to, reveal: "strict",
            replaces: [{ from: range.from, to: range.to, block: !!span, widget: new MathWidget(html, !source.inline, !!span, read(state, node.from, node.to), source.numbered || !!counted?.numbered, node.from - range.from, range.to - range.from, referenced(latex)) }],
          });
          return false;
        }
        case "Cite": case "Ref": {
          if (!structural) return false;
          const keysNode = node.getChild(name === "Cite" ? "BibKeyArgument" : "RefArgument");
          const inner = keysNode && argumentInner(keysNode);
          if (!inner || hasDirectError(node)) return false;
          const keys = read(state, inner.from, inner.to).split(",").map((key) => key.trim()).filter(Boolean);
          if (!keys.length) return false;
          const ctrl = node.firstChild!;
          let command = read(state, ctrl.from, ctrl.to);
          if (read(state, ctrl.to, ctrl.to + 1) === "*" && !command.endsWith("*")) command += "*";
          // `\let\cite\textcite` cites the way its target does.
          const alias = macroAt(defs, command.replace(/^\\|\*$/g, ""), node.from);
          if (alias?.alias && ALIAS_FAMILIES[name].test(alias.body)) command = alias.body + (command.endsWith("*") ? "*" : "");
          const optionals = node.getChildren("OptionalArgument").map((arg) => { const range = argumentInner(arg); return range ? read(state, range.from, range.to) : ""; });
          const notes = optionals.length > 1 ? { pre: optionals[0] || undefined, post: optionals[1] || undefined } : { post: optionals[0] || undefined };
          // cleveref's `\crefrange{a}{b}`: the grammar ends it after `{a}`; the chip takes the second key's group too.
          let to = node.to;
          if (/^\\[cC]refrange\*?$/.test(command)) {
            const after = read(state, node.to, Math.min(doc.length, node.to + 300));
            const open = /^\s*\{/.exec(after);
            const second = open ? readGroup(after, open[0].length - 1) : null;
            if (!second || !second.content.trim() || /[{}\\,]/.test(second.content) || keys.length !== 1) return false;
            keys.push(second.content.trim());
            to = node.to + second.end;
            consumed.push([node.from, to]);
          }
          emit({
            kind: name === "Cite" ? "cite" : "ref", from: node.from, to, reveal: "strict",
            replaces: [{ from: node.from, to, widget: new ChipWidget(name === "Cite" ? "cite" : "ref", command, keys, notes, to - node.from) }],
          });
          return false;
        }
        case "Label": {
          if (!structural) return false;
          const argument = node.getChild("LabelArgument");
          const inner = argument && argumentInner(argument);
          if (!inner || hasDirectError(node)) return false;
          emit({
            kind: "label", from: node.from, to: node.to, reveal: "strict",
            replaces: [{ from: node.from, to: node.to, widget: new ChipWidget("label", "\\label", [read(state, inner.from, inner.to).trim()], {}, node.to - node.from) }],
          });
          return false;
        }
        case "FigureEnvironment": case "TableEnvironment": {
          // A subfigure on its own (its figure is not drawn whole) is drawn as a lettered panel.
          return drawFloat(node, floatKind(node, readNode) ?? (name === "TableEnvironment" ? "table" : "figure"));
        }
        case "TabularEnvironment": return drawTabular(node);
        case "ListEnvironment": return drawList(node);
        case "Item": {
          if (!lists.length || !structural) return false;
          const optional = node.getChild("OptionalArgument");
          const optionalRange = optional && argumentInner(optional);
          emitItem(node.from, node.to, optionalRange ? read(state, optionalRange.from, optionalRange.to) : null);
          return false;
        }
        case "Environment": case "KnownEnvironment": {
          if (name === "KnownEnvironment") return;
          // A list of the document's own (enumitem's `\newlist`): drawn as the lists the grammar knows.
          if (defs.lists?.has(environmentName(node, readNode) ?? "") || PARALIST[environmentName(node, readNode) ?? ""]) return drawList(node);
          // `table*`, `algorithm` and the other floats the grammar does not name; a theorem the document calls
          // `algorithm` (`\newtheorem{algorithm}{Algorithm}`, Callaway & Sant'Anna's bootstrap) is the document's own.
          const kind = floatKind(node, readNode);
          if (kind && !defs.theorems.has(environmentName(node, readNode) ?? "")) return drawFloat(node, kind);
          // `tabular*` and `tabulary` are tabulars the grammar does not name.
          if (isTabular(node, readNode)) return drawTabular(node);
          // A figure set without a float (`\begin{center}\includegraphics{…}\captionof{figure}{…}\end{center}`): drawn as one.
          const captioned = captionofBlock(node);
          if (captioned && drawFloat(node, captioned) === false) return false;
          // tcolorbox's and mdframed's boxes, and the document's own (`\newtcolorbox`): a frame around their lines.
          if (boxEnvironments(doc).has(environmentName(node, readNode) ?? "") && !defs.environments.has(environmentName(node, readNode) ?? "")) return drawBox(node);
          return environment(node);
        }
        case "EndEnv": {
          // `\end{document}`: its environment starts in the preamble, so the end line is its own construct. Only that one:
          // a stray `\end{equation}` the parser took as the document's end (SIAM's redefined `\(`) stays visible.
          if (node.parent?.name === "DocumentEnvironment" && structural && !hasDirectError(node) && /^\\end\s*\{document\}/.test(read(state, node.from, node.to))) collapseLine(node, "document-end");
          return false;
        }
        case "Maketitle": {
          if (!structural) return false;
          const title = readTitleParts(state, node.from, defs.documentClass);
          // `\title{…}`, `\author{…}` and `\date{…}` written in the body right before `\maketitle`: what the title block
          // shows, folded into it (Alt-click shows their source).
          const bodyStart = Math.max(0, env.preambleEnd);
          const run = node.from > bodyStart ? titleDeclarationsStart(read(state, bodyStart, node.from), ABSTRACT_WITH_TITLE.test(defs.documentClass ?? "")) : null;
          // Only within this walk's range, so the construct does not start before what is being built.
          const declarations = run && bodyStart + run.start >= from ? bodyStart + run.start : null;
          // acmart's teaser figure among them is drawn on its own: the block ends before it, and the rest up to `\maketitle` folds away.
          const gaps = declarations !== null ? run!.gaps.map((gap) => ({ from: bodyStart + gap.from, to: bodyStart + gap.to })) : [];
          const trimmed = (start: number, end: number) => {
            while (start < end && /\s/.test(read(state, start, start + 1))) start++;
            while (end > start && /\s/.test(read(state, end - 1, end))) end--;
            return { start, end };
          };
          const blockEnd = gaps.length ? trimmed(declarations!, gaps[0].from).end : node.to;
          const folded = declarations !== null ? aloneOnLines(doc, declarations, blockEnd) : null;
          const span = folded ?? aloneOnLines(doc, node.from, node.to);
          const range = span ?? { from: node.from, to: node.to };
          if (range.from < node.from) consumed.push([range.from, Math.min(node.from, range.to)]);
          // An abstract and keywords in the run are printed with the title (amsart's abstract before `\maketitle`).
          const inRun = folded ? run : null;
          const widget = new TitleWidget(title.title, title.author, title.date, range.to - range.from, inRun?.abstract ?? title.abstract, [...title.notes, ...(inRun?.notes ?? [])]);
          emit({ kind: "title", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget }] });
          if (folded && gaps.length) {
            gaps.forEach((gap, index) => {
              const rest = trimmed(gap.to, index + 1 < gaps.length ? gaps[index + 1].from : node.to);
              const lines = rest.end > rest.start ? aloneOnLines(doc, rest.start, rest.end) : null;
              if (lines) collapseLine(lines, "title-rest");
            });
          }
          return false;
        }
        case "BibliographyCommand": {
          // `\bibliography{refs}`: the References list it prints (from the compiled `.bbl`), on its own lines only.
          const argument = node.getChild("BibliographyArgument");
          const inner = argument && argumentInner(argument);
          const span = aloneOnLines(doc, node.from, node.to);
          if (!structural || !inner || !span || hasDirectError(node)) return false;
          emit({ kind: "bibliography", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new BibliographyListWidget(bibliographyHeading(defs), read(state, inner.from, inner.to).trim(), span.to - span.from) }] });
          return false;
        }
        case "BibliographyStyleCommand": {
          // `\bibliographystyle{plain}` prints nothing: its own line folds away.
          if (structural && !hasDirectError(node) && aloneOnLines(doc, node.from, node.to)) collapseLine(node, "bibliography-style");
          return false;
        }
        case "IncludeGraphics": {
          if (!structural) return false;
          const argument = node.getChild("IncludeGraphicsArgument")?.getChild("FilePathArgument") ?? node.getChild("IncludeGraphicsArgument");
          const inner = argument && argumentInner(argument);
          if (!inner || hasDirectError(node)) return false;
          emit({ kind: "image", from: node.from, to: node.to, reveal: "strict", replaces: [{ from: node.from, to: node.to, widget: new ImageWidget(read(state, inner.from, inner.to), node.to - node.from, graphicsBase(state)) }] });
          return false;
        }
        case "LineBreak": {
          if (structural) emit({ kind: "symbol", from: node.from, to: node.to, reveal: "never", replaces: [{ from: node.from, to: node.to, widget: new LineBreakWidget() }] });
          return false;
        }
        case "Tilde": {
          if (structural) emit({ kind: "symbol", from: node.from, to: node.to, reveal: "never", replaces: [{ from: node.from, to: node.to, widget: new SymbolWidget(" ", "~ (no break)", "cm-vis-symbol cm-vis-tilde") }] });
          return false;
        }
        case "Normal": {
          if (!structural) return false;
          const text = read(state, node.from, node.to);
          if (!text.includes("-") && !text.includes("`") && !text.includes("'")) return false;
          TEXT_LIGATURES.lastIndex = 0;
          for (let match: RegExpExecArray | null; (match = TEXT_LIGATURES.exec(text));) {
            const at = node.from + match.index;
            if (at < symbolsUntil) continue;
            emit({ kind: "symbol", from: at, to: at + match[0].length, reveal: "never", replaces: [{ from: at, to: at + match[0].length, widget: new SymbolWidget(LIGATURE_CHARS[match[0]], match[0]) }] });
          }
          return false;
        }
        case "Centering": case "SetLengthCommand": {
          // `\centering` or `\setlength{\parindent}{0pt}` on a line of layout: it folds away (M-13).
          const line = structural ? layoutLine(state, node.from) : null;
          if (line) { collapseLine(line, "layout"); consumed.push([line.from, line.to]); }
          return false;
        }
        case "UnknownCommand":
          return unknownCommand(node);
      }
      return;
    },
    leave(ref) {
      if ((ref.name === "ListEnvironment" || ref.name === "Environment") && lists.length && lists[lists.length - 1].node.from === ref.from) lists.pop();
    },
  });

  /**
   * `thebibliography` (a `.bbl` written into the file): a References heading for its `\begin` line and
   * its widest-label argument, its lines hanging from their `[n]` markers (see `\bibitem`).
   */
  function bibliography(node: SyntaxNode, formed: NonNullable<ReturnType<typeof wellFormedEnvironment>>): false | undefined {
    const begin = formed.begin;
    const nameEnd = begin.getChild("EnvNameGroup")?.to ?? begin.to;
    const after = read(state, nameEnd, Math.min(doc.length, nameEnd + 200));
    const spaces = /^\s*/.exec(after)![0].length;
    const widest = after[spaces] === "{" ? readGroup(after, spaces) : null;
    const headerEnd = Math.max(begin.to, widest ? nameEnd + widest.end : begin.to);
    consumed.push([begin.from, headerEnd]);
    const book = /^(?:book|report|memoir|scrbook|scrreprt)$/.test(defs.documentClass ?? "");
    const span = aloneOnLines(doc, begin.from, headerEnd);
    const from = span?.from ?? begin.from;
    // As for a heading: the widget in the structural layer, the line style in both.
    emit({
      kind: "heading", from, to: headerEnd, reveal: "line", wholeLine: true,
      replaces: structural ? [{ from, to: headerEnd, widget: new MacroHeadingWidget(book ? "Bibliography" : "References", headerEnd - from) }] : [],
      lines: [{ from, to: headerEnd, class: `cm-vis-heading ${book ? "cm-vis-h0" : "cm-vis-h1"}` }],
    });
    if (structural) collapseLine(formed.end, "env-end");
    // IEEEtran's .bbl opens with definitions for its entries (`\providecommand{\url}[1]{#1}`, `\csname url@samestyle\endcsname`,
    // `\BIBdecl`): they print nothing, so their lines fold away (Membership Inference, B5-27).
    const firstItem = /\\bibitem(?![A-Za-z@])/.exec(read(state, headerEnd, formed.end.from));
    const prelude = firstItem ? definitionsPrelude(read(state, headerEnd, headerEnd + firstItem.index)) : null;
    const preludeSpan = prelude && aloneOnLines(doc, headerEnd + prelude.from, headerEnd + prelude.to);
    if (preludeSpan) {
      consumed.push([preludeSpan.from, preludeSpan.to]);
      if (structural) collapseLine(preludeSpan, "bibliography-prelude");
    }
    if (formed.content) {
      const first = doc.lineAt(Math.min(doc.length, headerEnd + 1)).number + 1;
      const last = doc.lineAt(formed.end.from).number - 1;
      if (last >= first) emit({ kind: "list-body", from: node.from, to: node.to, reveal: "never", replaces: [], lines: [{ from: doc.line(first).from, to: doc.line(last).to, class: "cm-vis-bibliography" }] });
    }
    return undefined;
  }

  /** mathpartir's `mathpar`: its inference rules as one displayed formula; source when KaTeX cannot draw it. */
  function mathpar(node: SyntaxNode, formed: NonNullable<ReturnType<typeof wellFormedEnvironment>>): false | undefined {
    if (!structural || !formed.content) return undefined;
    const latex = mathparForKatex(read(state, formed.content.from, formed.content.to));
    const expanded = expandLatexMacros(latex, defs, { mode: "math", pos: node.from });
    const html = expanded.ok ? renderKatex(withReferences(expanded.text), true) : null;
    if (!html) return undefined;
    const span = aloneOnLines(doc, node.from, node.to);
    const range = span ?? { from: node.from, to: node.to };
    emit({ kind: "math", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new MathWidget(html, true, !!span, read(state, node.from, node.to), false, node.from - range.from, range.to - range.from, referenced(expanded.text)) }] });
    return false;
  }

  /** A list: its `\begin` and `\end` lines fold away and its lines are indented; its items are drawn as they are met. */
  function drawList(node: SyntaxNode): undefined {
    const formed = wellFormedEnvironment(node, state);
    if (!formed) return undefined;
    // enumitem's lists of the document's own (`\newlist{exercises}{enumerate}{6}`) are lists of their kind.
    const custom = defs.lists?.get(formed.name) ?? PARALIST[formed.name];
    const list = listContext(node, custom ?? formed.name, lists, state, 0);
    if (!list.template && defs.lists?.has(formed.name)) list.template = customListLabel(defs, formed.name, list.depth);
    if (/^inpara/.test(formed.name) && !defs.lists?.has(formed.name)) list.inline = true;
    lists.push(list);
    if (structural) {
      collapseLine(formed.begin, "list-begin");
      collapseLine(formed.end, "list-end");
    }
    if (formed.content && !list.inline) {
      const first = doc.lineAt(formed.begin.to).number + 1;
      const last = doc.lineAt(formed.end.from).number - 1;
      if (last >= first) emit({ kind: "list-body", from: node.from, to: node.to, reveal: "never", replaces: [], lines: [{ from: doc.line(first).from, to: doc.line(last).to, class: `cm-vis-list cm-vis-list-d${Math.min(6, list.depth)}` }] });
    }
    return undefined;
  }

  /** The kind a `center` or `minipage` outside floats captions with its `\captionof{figure}{…}`, else null. */
  function captionofBlock(node: SyntaxNode): FigureContent["kind"] | null {
    if (!structural || !/^(?:center|minipage|flushleft|flushright)$/.test(environmentName(node, readNode) ?? "")) return null;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.name === "FigureEnvironment" || parent.name === "TableEnvironment" || (parent.name === "Environment" && floatKind(parent, readNode))) return null;
    }
    const match = /\\captionof\s*\{\s*([A-Za-z]+)\s*\}/.exec(stripTexComments(read(state, node.from, node.to)));
    return match ? FLOAT_KINDS[match[1]] ?? null : null;
  }

  /**
   * A tcolorbox or mdframed box in the text (a `\newtcolorbox` of the document too): a frame around its lines, its
   * title (`title=…`) as its first line; its `\begin` and `\end` lines fold away. One whose `\begin` or `\end` shares
   * its line with text stays source, its content drawn as text.
   */
  function drawBox(node: SyntaxNode): undefined {
    const formed = wellFormedEnvironment(node, state);
    const use = formed && boxUse(node, state);
    if (!formed || !use) return undefined;
    const beginSpan = aloneOnLines(doc, formed.begin.from, use.end);
    const endSpan = aloneOnLines(doc, formed.end.from, formed.end.to);
    if (!beginSpan || !endSpan || doc.lineAt(beginSpan.from).number !== doc.lineAt(beginSpan.to).number) return undefined;
    consumed.push([formed.begin.from, use.end]);
    if (structural) {
      const header = { from: beginSpan.from, to: beginSpan.to };
      if (use.title) emit({ kind: "env-header", ...header, reveal: "line", wholeLine: true, replaces: [{ ...header, widget: new EnvironmentHeaderWidget("user", `\\textbf{${use.title}}`, null, null, 0) }] });
      else emit({ kind: "env-begin", ...header, reveal: "line", wholeLine: true, replaces: [header], hiddenLines: [{ ...header, class: "cm-vis-collapsed" }] });
      collapseLine(formed.end, "env-end");
    }
    // The framed lines: the title's, then the content's (the first and last close the frame).
    const first = doc.lineAt(beginSpan.to).number + (use.title ? 0 : 1);
    const last = doc.lineAt(endSpan.from).number - 1;
    if (last < first) return undefined;
    const lines: LineStyle[] = [{ from: doc.line(first).from, to: doc.line(last).to, class: "cm-vis-box" }, { from: doc.line(first).from, to: doc.line(first).from, class: "cm-vis-box-first" }, { from: doc.line(last).from, to: doc.line(last).from, class: "cm-vis-box-last" }];
    if (use.title) lines.push({ from: beginSpan.from, to: beginSpan.from, class: "cm-vis-box-title" });
    emit({ kind: "env-body", from: use.end, to: formed.end.from, reveal: "never", replaces: [], lines });
    return undefined;
  }

  /**
   * imsart's and elsarticle's `frontmatter`: the class prints the title block from the commands in it, with no
   * `\maketitle`. Drawn as the title block over those commands (up to the abstract or keywords, which are drawn as
   * text), when they are only front-matter commands; otherwise the environment stays source.
   */
  function frontMatter(formed: NonNullable<ReturnType<typeof wellFormedEnvironment>>): false | undefined {
    if (!formed.content) return undefined;
    const inside = read(state, formed.begin.to, formed.end.from);
    // The abstract or keywords (the grammar may nest them in text nodes): found in the text, outside comments.
    let stop = formed.end.from;
    for (const match of inside.matchAll(/\\begin\s*\{(?:abstract|keywords?)\}/g)) {
      if (isInLatexComment(inside, match.index ?? 0)) continue;
      stop = formed.begin.to + (match.index ?? 0);
      break;
    }
    const parts = frontMatterParts(read(state, formed.begin.to, stop));
    if (!parts) return undefined;
    let end = stop;
    while (end > formed.begin.to && /\s/.test(read(state, end - 1, end))) end--;
    const span = aloneOnLines(doc, formed.begin.from, end);
    if (!span) return undefined;
    consumed.push([span.from, span.to]);
    if (structural) {
      emit({ kind: "title", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new TitleWidget(parts.title, parts.author, parts.date, span.to - span.from) }] });
      collapseLine(formed.end, "env-end");
    }
    return undefined;
  }

  function environment(node: SyntaxNode): false | undefined {
    const formed = wellFormedEnvironment(node, state);
    if (!formed) return undefined;
    const name = formed.name;
    if (name === "thebibliography") return bibliography(node, formed);
    if (name === "frontmatter") return frontMatter(formed);
    if (name === "mathpar" || name === "mathpar*") return mathpar(node, formed);
    // thmtools' `\begin{restatable}[note]{theorem}{name}`: the theorem it names, with its heading over the whole opening.
    if (name === "restatable" || name === "restatable*") {
      const restated = restatableTheorem(node, readNode);
      const restatedTheorem = restated ? defs.theorems.get(restated.env) : undefined;
      if (!restated || !restatedTheorem) return undefined;
      const headerEnd = node.from + restated.length;
      consumed.push([formed.begin.from, headerEnd]);
      const span = aloneOnLines(doc, formed.begin.from, headerEnd);
      if (structural) {
        const header = new EnvironmentHeaderWidget("theorem", restatedTheorem.title, restated.note, restatedTheorem.numbered ? "theorem" : null, 0);
        emit({ kind: "env-header", from: span?.from ?? formed.begin.from, to: headerEnd, reveal: "line", wholeLine: true, replaces: [{ from: span?.from ?? formed.begin.from, to: headerEnd, widget: header }] });
        collapseLine(formed.end, "env-end");
      }
      if (formed.content && formed.content.to > headerEnd) emit({ kind: "env-body", from: headerEnd, to: formed.end.from, reveal: "never", replaces: [], marks: [{ from: headerEnd, to: formed.end.from, class: THEOREM_STYLE_CLASSES[restatedTheorem.style] }] });
      return undefined;
    }
    // CJK's `\begin{CJK}{UTF8}{gbsn} … \end{CJK}` (LongBench's Chinese prompts): its text, with the encoding and font folded away.
    if (name === "CJK" || name === "CJK*") {
      const nameEnd = formed.begin.getChild("EnvNameGroup")?.to ?? formed.begin.to;
      const head = /^\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{[^{}]*\}/.exec(read(state, nameEnd, Math.min(doc.length, nameEnd + 200)));
      if (!head) return undefined;
      const headerEnd = nameEnd + head[0].length;
      consumed.push([formed.begin.from, headerEnd]);
      if (structural) {
        collapseLine({ from: formed.begin.from, to: headerEnd }, "env-begin");
        collapseLine(formed.end, "env-end");
      }
      return undefined;
    }
    // acmart's and LIPIcs' `CCSXML`: the classification as XML, for the publisher. It prints nothing: it folds away.
    if (name === "CCSXML") {
      if (structural && aloneOnLines(doc, node.from, node.to)) collapseLine(node, "metadata");
      return false;
    }
    const theorem = defs.theorems.get(name);
    const user = defs.environments.get(name);
    const block = TEXT_BLOCKS[name];
    if (!theorem && !user && !block && name !== "proof" && !ACKNOWLEDGMENTS.test(name)) return undefined;
    const begin = formed.begin;
    // The optional argument (a theorem's name) may be inside BeginEnv or right after it.
    let headerEnd = begin.to;
    let note: string | null = null;
    const inside = begin.getChild("OptionalArgument");
    // A group the grammar put in BeginEnv is body text unless the environment takes arguments (`\begin{quote}{Hello}`).
    const stray = begin.getChild("TextArgument") ?? begin.getChild("ShortTextArgument");
    const takesArguments = !!user && !!(user.arity || user.spec);
    if (stray && !takesArguments) headerEnd = inside && inside.to <= stray.from ? inside.to : begin.getChild("EnvNameGroup")?.to ?? begin.to;
    if (inside && inside.to <= headerEnd) { const range = argumentInner(inside); note = range ? read(state, range.from, range.to) : null; }
    else if (!stray) {
      // TeX skips spaces and one line end before the `[` (Callaway & Sant'Anna's `\begin{assumption}` with
      // `[Irreversibility of Treatment]` on the next line); a blank line ends the search.
      const tail = read(state, begin.to, Math.min(doc.length, begin.to + 400));
      const gap = /^[ \t]*(?:\r?\n[ \t]*)?/.exec(tail)![0].length;
      const after = tail[gap] === "[" ? readOptional(tail, gap, TEX_GROUPS) : null;
      if (after && (theorem || name === "proof")) { note = after.content; headerEnd = begin.to + after.end; }
    }
    let userArgs: string[] | null = null;
    if (user && takesArguments) {
      // The arguments follow the name: the grammar may have put some of them in BeginEnv already.
      const argsFrom = begin.getChild("EnvNameGroup")?.to ?? begin.to;
      const read = readMacroArguments(state.doc.sliceString(argsFrom, Math.min(doc.length, argsFrom + 2000)), 0, user);
      if (!read) return undefined;
      userArgs = read.args;
      headerEnd = Math.max(begin.to, argsFrom + read.end);
    }
    const label = trailingLabel(state, formed.content, headerEnd);
    if (label) headerEnd = label.to;
    // The header widget covers the begin markup, its argument and label: nothing inside is walked.
    if (!block) consumed.push([begin.from, headerEnd]);
    const contentLines = formed.content ? { from: doc.lineAt(Math.min(doc.length, headerEnd + 1)).from, to: doc.lineAt(Math.max(formed.end.from - 1, 0)).to } : null;

    // NeurIPS's `ack` and the like: a heading as the abstract's.
    const acknowledgments = ACKNOWLEDGMENTS.test(name);
    // A user environment that is a theorem in a frame (the book 2403.14606's `boxdef`): drawn as the theorem, without the frame.
    const wrapped = user && !theorem ? wrappedTheorem(userArgs ? substituteArguments(user.begin, userArgs) : user.begin, user.end, defs) : null;
    const shown = theorem ?? (wrapped ? defs.theorems.get(wrapped.env) : undefined);
    if (shown || name === "proof" || name === "abstract" || acknowledgments) {
      const variant = shown ? "theorem" : name === "proof" ? "proof" : "abstract";
      const title = shown ? shown.title : name === "proof" ? (note ?? "Proof") : acknowledgments ? "Acknowledgments" : "Abstract";
      const header = new EnvironmentHeaderWidget(variant, title, theorem ? note : wrapped ? wrapped.note : null, shown?.numbered ? "theorem" : null, 0);
      const span = aloneOnLines(doc, begin.from, headerEnd);
      if (structural) {
        emit({ kind: "env-header", from: span?.from ?? begin.from, to: headerEnd, reveal: "line", wholeLine: true, replaces: [{ from: span?.from ?? begin.from, to: headerEnd, widget: header }] });
        if (name === "proof") {
          const endSpan = aloneOnLines(doc, formed.end.from, formed.end.to);
          // amsthm's end mark (□, or the document's `\renewcommand{\qedsymbol}{$\blacksquare$}`); ∎ without it.
          const qed = macroAt(defs, "qedsymbol", formed.end.from) ? "\\qedsymbol" : null;
          emit({ kind: "env-footer", from: formed.end.from, to: formed.end.to, reveal: "line", wholeLine: true, replaces: [{ from: endSpan?.from ?? formed.end.from, to: formed.end.to, widget: new EnvironmentFooterWidget(qed) }] });
        } else collapseLine(formed.end, "env-end");
      }
      const styleClass = shown ? THEOREM_STYLE_CLASSES[shown.style] : name === "abstract" ? "cm-vis-abstract" : acknowledgments ? "cm-vis-acknowledgments" : "cm-vis-proof";
      if (formed.content && formed.content.to > headerEnd) emit({ kind: "env-body", from: headerEnd, to: formed.end.from, reveal: "never", replaces: [], marks: [{ from: headerEnd, to: formed.end.from, class: styleClass }], lines: name === "abstract" && contentLines && contentLines.to >= contentLines.from ? [{ ...contentLines, class: "cm-vis-abstract-line" }] : undefined });
      return undefined;
    }
    if (user) {
      const code = userArgs ? substituteArguments(user.begin, userArgs) : user.begin;
      const named = namedTheorem(code, defs);
      if (named) {
        const span = aloneOnLines(doc, begin.from, headerEnd);
        if (structural) {
          emit({ kind: "env-header", from: span?.from ?? begin.from, to: headerEnd, reveal: "line", wholeLine: true, replaces: [{ from: span?.from ?? begin.from, to: headerEnd, widget: new EnvironmentHeaderWidget("theorem", named.title, null, null, 0) }] });
          collapseLine(formed.end, "env-end");
        }
        if (formed.content && formed.content.to > headerEnd) emit({ kind: "env-body", from: headerEnd, to: formed.end.from, reveal: "never", replaces: [], marks: [{ from: headerEnd, to: formed.end.from, class: THEOREM_STYLE_CLASSES[named.theorem.style] }] });
        return undefined;
      }
      // null: code the header cannot draw, whose `\begin` or `\end` stays as source; "": code that draws nothing.
      const beginCode = drawableEnvironmentCode(code);
      const endCode = drawableEnvironmentCode(user.end);
      if (structural) {
        const span = aloneOnLines(doc, begin.from, headerEnd);
        if (beginCode) emit({ kind: "env-header", from: span?.from ?? begin.from, to: headerEnd, reveal: "line", wholeLine: true, replaces: [{ from: span?.from ?? begin.from, to: headerEnd, widget: new EnvironmentHeaderWidget("user", beginCode, null, null, 0) }] });
        else if (beginCode === "") collapseLine(begin, "env-begin", span ? undefined : { from: begin.from, to: headerEnd });
        const endSpan = aloneOnLines(doc, formed.end.from, formed.end.to);
        if (endCode) emit({ kind: "env-footer", from: formed.end.from, to: formed.end.to, reveal: "line", wholeLine: true, replaces: [{ from: endSpan?.from ?? formed.end.from, to: formed.end.to, widget: new EnvironmentFooterWidget(endCode) }] });
        else if (endCode === "") collapseLine(formed.end, "env-end");
      }
      return undefined;
    }
    // quote, center and the other text blocks.
    if (structural) {
      collapseLine(begin, "env-begin", headerEnd < begin.to ? { from: begin.from, to: headerEnd } : undefined);
      collapseLine(formed.end, "env-end");
    }
    if (contentLines && contentLines.to >= contentLines.from) emit({ kind: "env-body", from: begin.to, to: formed.end.from, reveal: "never", replaces: [], lines: [{ ...contentLines, class: block }] });
    return undefined;
  }

  /** Whether `node` is inside an environment called `name` (a few levels up). */
  function insideEnvironment(node: SyntaxNode, name: string) {
    for (let parent = node.parent, depth = 0; parent && depth < 12; parent = parent.parent, depth++) {
      if (parent.name === "Environment" && environmentName(parent, readNode) === name) return true;
    }
    return false;
  }

  function unknownCommand(node: SyntaxNode): false | undefined {
    const ctrl = node.firstChild;
    if (!ctrl) return undefined;
    const text = read(state, ctrl.from, ctrl.to);
    // biblatex's `\printbibliography[title=…]`: the References list, on its own lines only.
    if (text === "\\printbibliography") {
      const end = commandArguments(node).filter((arg) => arg.optional).at(-1)?.node.to ?? ctrl.to;
      const span = aloneOnLines(doc, node.from, end);
      if (!span || hasDirectError(node) || macroAt(defs, "printbibliography", node.from)) return undefined;
      const options = read(state, ctrl.to, end);
      const title = /\btitle\s*=\s*\{?([^,{}\]]+)/.exec(options)?.[1]?.trim();
      if (structural) emit({ kind: "bibliography", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new BibliographyListWidget(title ?? bibliographyHeading(defs), "", span.to - span.from) }] });
      return false;
    }
    // `\index{social choice}` and `\glossary{…}`: entries for the back of the book, a small grey tag where they are
    // (O'Donnell's book has one every few lines).
    if (text === "\\index" || text === "\\glossary") {
      const argument = commandArguments(node).find((arg) => !arg.optional);
      const inner = argument && argumentInner(argument.node);
      // Only `\index{…}` with nothing between the command and its argument (no `[…]` of another package).
      if (inner && !hasDirectError(node) && !read(state, ctrl.to, argument.node.from).trim()) {
        const to = argument.node.to;
        if (structural) emit({ kind: "index", from: node.from, to, reveal: "strict", replaces: [{ from: node.from, to, widget: new ChipWidget("index", text, [read(state, inner.from, inner.to).trim()], {}, to - node.from) }] });
        return false;
      }
    }
    // ICML's title block: `\twocolumn[\icmltitle{…} \begin{icmlauthorlist}\icmlauthor{Name}{aff}…\end{icmlauthorlist}
    // \icmlaffiliation{aff}{Institution} …]`, drawn as the title block it prints; `\printAffiliationsAndNotice` with it.
    if (text === "\\twocolumn" || text === "\\printAffiliationsAndNotice") {
      const after = read(state, ctrl.to, Math.min(doc.length, ctrl.to + 20000));
      if (text === "\\printAffiliationsAndNotice") {
        const group = /^\s*\{/.exec(after) ? readGroup(after, after.indexOf("{"), TEX_GROUPS) : null;
        const end = ctrl.to + (group?.end ?? 0);
        if (structural) emit({ kind: "symbol", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: end }] });
        return false;
      }
      const open = /^\s*\[/.exec(after);
      const block = open ? readOptional(after, open[0].length - 1, TEX_GROUPS) : null;
      const icml = block ? icmlTitle(block.content) : null;
      if (block && icml) {
        const end = ctrl.to + block.end;
        const span = aloneOnLines(doc, node.from, end);
        const range = span ?? { from: node.from, to: end };
        consumed.push([range.from, range.to]);
        if (structural) emit({ kind: "title", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new TitleWidget(icml.title, icml.author, null, range.to - range.from) }] });
        return false;
      }
      // CVPR's `\twocolumn[{\maketitle \begin{center}…\captionof{figure}{…}\end{center}}]`: the title (its `\maketitle`
      // is walked as usual), then the teaser figure, numbered at its `\captionof`; the wrapper's opening folds away.
      const groupAt = block ? block.content.search(/\S/) : -1;
      const group = block && block.content[groupAt] === "{" ? readGroup(block.content, groupAt, TEX_GROUPS) : null;
      const teaser = group && !block!.content.slice(group.end).trim() ? teaserFigure(group.content) : null;
      if (block && teaser) {
        const inner = ctrl.to + open![0].length + groupAt + 1;
        const end = ctrl.to + block.end;
        const opening = aloneOnLines(doc, node.from, inner);
        const span = aloneOnLines(doc, inner + teaser.from, end);
        if (opening && span && !hasDirectError(node)) {
          consumed.push([span.from, span.to]);
          if (structural) {
            emit({ kind: "env-begin", from: opening.from, to: opening.to, reveal: "line", wholeLine: true, replaces: [opening], hiddenLines: [{ ...opening, class: "cm-vis-collapsed" }] });
            const spec: FigureSpec = {
              env: "teaser", images: teaser.images.map((image) => ({ path: imagePath(image.path, doc), width: image.width })), caption: teaser.caption.text,
              captionPos: inner + teaser.caption.at, captionAbove: false, kind: teaser.caption.kind, numberOffset: inner + teaser.caption.at - span.from,
              start: span.from, length: span.to - span.from, base: graphicsBase(state),
            };
            emit({ kind: "figure", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new FigureWidget(spec) }] });
          }
          return undefined;
        }
      }
    }
    // hyperref's `\hyperref[label]{text}`: the text, as a link to the label (Econometrica's "\hyperref[lemma:x]{identity
    // lemma}", 117 of them); ⌘/Ctrl-click follows it. Its 4-argument form stays source.
    if (text === "\\hyperref") {
      const parts = commandArguments(node);
      const label = parts.length === 2 && parts[0].optional ? argumentInner(parts[0].node) : null;
      const body = label && !parts[1].optional ? argumentInner(parts[1].node) : null;
      const key = label ? read(state, label.from, label.to).trim() : "";
      if (body && key && body.to > body.from && !hasDirectError(node)) {
        const to = parts[1].node.to;
        emit({
          kind: "style", from: node.from, to, reveal: "touch",
          replaces: structural ? [{ from: node.from, to: body.from }, { from: body.to, to }] : [],
          marks: [{ from: body.from, to: body.to, class: "cm-vis-link cm-vis-ref-link", attributes: { "data-ref": key, title: `${key} (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}-click to follow)` } }],
        });
        return undefined;
      }
    }
    // fancyref's `\Fref{sec:x}` (the grammar knows only `\fref` as a reference): a reference chip.
    if (text === "\\Fref" || text === "\\fref") {
      const argument = commandArguments(node).find((arg) => !arg.optional);
      const inner = argument && argumentInner(argument.node);
      if (inner && argument && !hasDirectError(node)) {
        const keys = read(state, inner.from, inner.to).split(",").map((key) => key.trim()).filter(Boolean);
        if (structural && keys.length) emit({ kind: "ref", from: node.from, to: argument.node.to, reveal: "strict", replaces: [{ from: node.from, to: argument.node.to, widget: new ChipWidget("ref", text, keys, {}, argument.node.to - node.from) }] });
        return false;
      }
    }
    // pifont's `\ding{51}`: the dingbat (✓, ✗, ★, ①).
    if (text === "\\ding") {
      const argument = commandArguments(node).find((arg) => !arg.optional);
      const inner = argument && argumentInner(argument.node);
      const char = inner ? DINGBATS[read(state, inner.from, inner.to).trim()] : undefined;
      if (char && argument) {
        if (structural) emit({ kind: "symbol", from: node.from, to: argument.node.to, reveal: "touch", replaces: [{ from: node.from, to: argument.node.to, widget: new SymbolWidget(char, read(state, node.from, argument.node.to)) }] });
        return false;
      }
    }
    // The ctable package's `\ctable[caption={…}]{spec}{notes}{rows}`: a table float, drawn read-only (Callaway & Sant'Anna).
    if (text === "\\ctable") {
      const table = readCtable(read(state, node.from, Math.min(doc.length, node.from + 40000)));
      if (table && parseTabular(table.tabular, 0, defs.columnTypes)) {
        const end = node.from + table.length;
        const span = aloneOnLines(doc, node.from, end);
        const range = span ?? { from: node.from, to: end };
        consumed.push([node.from, end]);
        if (structural) {
          const spec: FigureSpec = {
            images: [], tabulars: [{ source: table.tabular, offset: node.from - range.from, readOnly: true }], caption: table.caption, captionPos: node.from,
            captionAbove: table.caption !== null && !table.captionBelow, kind: "table", numberOffset: node.from - range.from, notes: table.notes.length ? table.notes : undefined,
            env: "ctable", start: range.from, length: range.to - range.from,
          };
          emit({ kind: "figure", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new FigureWidget(spec) }] });
        }
        return false;
      }
    }
    // caption's `\captionof{figure}{…}` on its own lines outside a drawn float: its caption, numbered where it is (or
    // at its minipage, as numbering.ts numbers it).
    if (text === "\\captionof" && structural && read(state, ctrl.to, ctrl.to + 1) !== "*") {
      const [type, body] = commandArguments(node).filter((arg) => !arg.optional).map((arg) => argumentInner(arg.node));
      const kind = type ? FLOAT_KINDS[read(state, type.from, type.to).trim()] : undefined;
      const span = aloneOnLines(doc, node.from, node.to);
      if (kind && body && span && !hasDirectError(node)) {
        let at = node.from;
        for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === "Environment" && environmentName(parent, readNode) === "minipage") { at = parent.from; break; }
        const spec: FigureSpec = {
          env: "captionof", images: [], caption: read(state, body.from, body.to), captionPos: body.from, captionAbove: false, kind,
          numberOffset: at - span.from, start: span.from, length: span.to - span.from,
        };
        emit({ kind: "figure", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new FigureWidget(spec) }] });
        return false;
      }
    }
    // `\rotatebox[origin=c]{45}{$\square$}`, a square turned into a diamond (the end of the Econometrica paper's examples): ◇.
    if (text === "\\rotatebox" && structural) {
      const [angle, content] = commandArguments(node).filter((arg) => !arg.optional).map((arg) => { const inner = argumentInner(arg.node); return inner ? read(state, inner.from, inner.to).trim() : null; });
      if (angle === "45" && content && /^\$\s*\\(?:square|Box)\s*\$$/.test(content) && !hasDirectError(node)) {
        emit({ kind: "symbol", from: node.from, to: node.to, reveal: "touch", replaces: [{ from: node.from, to: node.to, widget: new SymbolWidget("◇", read(state, node.from, node.to)) }] });
        return false;
      }
    }
    // tcolorbox's `\tcblower` between a box's upper and lower parts (Self-RAG's instructions and demonstrations): a dashed line.
    if (text === "\\tcblower") {
      if (structural) emit({ kind: "symbol", from: ctrl.from, to: ctrl.to, reveal: "touch", replaces: [{ from: ctrl.from, to: ctrl.to, widget: new SymbolWidget("", text, "cm-vis-symbol cm-vis-box-lower") }] });
      return false;
    }
    // A tab stop in `tabbing` (`\=` sets one, `\>` moves to the next, `\+`/`\-` indent): a gap, as the stops line up.
    if (/^\\[=><+-]$/.test(text) && insideEnvironment(node, "tabbing")) {
      if (structural) emit({ kind: "symbol", from: node.from, to: node.to, reveal: "touch", replaces: [{ from: node.from, to: node.to, widget: new SymbolWidget(text === "\\+" || text === "\\-" ? "" : " ", text, "cm-vis-symbol cm-vis-tab-stop") }] });
      return false;
    }
    // hyperref's `\texorpdfstring{$\ell_1$}{l1}` in a heading: the TeX the page shows; the bookmark's text is hidden.
    if (text === "\\texorpdfstring") {
      const args = commandArguments(node).filter((arg) => !arg.optional);
      const first = args[0] && argumentInner(args[0].node);
      if (first && args.length === 2 && !hasDirectError(node)) {
        const end = args[1].node.to;
        consumed.push([first.to, end]);
        emit({ kind: "style", from: node.from, to: end, reveal: "touch", replaces: structural ? [{ from: node.from, to: first.from }, { from: first.to, to: end }] : [] });
        return undefined;
      }
    }
    // `\setcounter{enumi}{3}` in a list: its next item is 4.
    if (/^\\(?:set|addto|step|refstep)counter$/.test(text)) for (let i = lists.length - 1; i >= 0; i--) {
      if (lists[i].variant !== "number") continue;
      const change = counterChange(state, node, enumCounter(lists[i].depth));
      if (change) { lists[i].count = change(lists[i].count); return undefined; }
    }
    // `\footnotemark` (`[n]`): the note's number, as a footnote's mark; the `\footnotetext` after it has the note.
    if (text === "\\footnotemark") {
      const optional = read(state, ctrl.to, ctrl.to + 1) === "[" ? commandArguments(node).find((arg) => arg.optional) : null;
      const to = optional ? optional.node.to : ctrl.to;
      if (structural && !hasDirectError(node)) emit({ kind: "footnote", from: node.from, to, reveal: "touch", replaces: [{ from: node.from, to, widget: new FootnoteMarkWidget() }] });
      return false;
    }
    // `\footnotetext{…}`: the text of a note marked with `\footnotemark`, set as a footnote's (styled in both layers),
    // after its number.
    if (text === "\\footnotetext") {
      const argument = commandArguments(node).find((arg) => !arg.optional);
      const inner = argument && argumentInner(argument.node);
      if (inner && !hasDirectError(node)) {
        emit({
          kind: "footnote", from: node.from, to: argument.node.to, reveal: "touch",
          replaces: structural ? [{ from: node.from, to: inner.from, widget: new FootnoteMarkWidget() }, { from: inner.to, to: argument.node.to }] : [],
          marks: [{ from: inner.from, to: inner.to, class: "cm-vis-footnote" }],
        });
        return undefined;
      }
    }
    // `\newblock` between a reference's parts: a space, as the default style sets it. A group the parser
    // read as its argument (`\newblock {\em CoRR}, 2017`) is the reference's text, styled by its switch.
    if (text === "\\newblock") {
      const argument = commandArguments(node).find((arg) => !arg.optional);
      let textFrom = ctrl.to;
      while (textFrom < doc.length && / |\t/.test(read(state, textFrom, textFrom + 1))) textFrom++;
      const switched = argument && argument.node.from === textFrom ? groupSwitch(argument.node) : null;
      if (switched) {
        consumed.push([node.from, switched.textFrom]);
        emit({
          kind: "style", from: node.from, to: argument!.node.to, reveal: "touch",
          replaces: structural ? [{ from: node.from, to: switched.textFrom }, { from: switched.close.from, to: argument!.node.to }] : [],
          marks: switched.className ? [{ from: switched.textFrom, to: switched.close.from, class: switched.className, attributes: switched.style ? { style: switched.style } : undefined }] : undefined,
        });
        return undefined;
      }
      if (structural) emit({ kind: "symbol", from: node.from, to: textFrom, reveal: "touch", replaces: [{ from: node.from, to: textFrom }] });
      return undefined;
    }
    // `\color{red}` and font switches (`\begin{quote} \it …`) style the rest of their group or environment
    // (a group they open, `{\it …}`, is drawn as a whole, above).
    // (The parser may give the switch the group after it as an argument: `{\tt {\small …}}`. Its control
    // sequence tells whether a group it opens drew it, and what follows it is walked as usual.)
    if ((text === "\\color" || FONT_SWITCHES[text]) && !isConsumed(ctrl)) {
      const color = text === "\\color" ? colorSwitch(node) : null;
      const after = color ? color.end : ctrl.to;
      const container = color || text !== "\\color" ? switchEnd(node) : null;
      if (container && container.text > after) {
        let textFrom = after;
        while (textFrom < container.text && / |\t/.test(read(state, textFrom, textFrom + 1))) textFrom++;
        emit({
          kind: "style", from: node.from, to: container.end, reveal: "touch",
          replaces: structural ? [{ from: node.from, to: textFrom }] : [],
          marks: [{ from: textFrom, to: container.text, class: color ? "cm-vis-color" : FONT_SWITCHES[text], attributes: color ? { style: `color: ${color.css}` } : undefined }],
        });
        consumed.push([node.from, textFrom]);
        return undefined;
      }
    }
    // ulem's underlines and strike-out: `\uline{…}` as `\underline`.
    if (ULEM_STYLES[text]) {
      const argument = commandArguments(node).find((arg) => !arg.optional);
      const inner = argument && argumentInner(argument.node);
      if (inner && !hasDirectError(node)) {
        emit({
          kind: "style", from: node.from, to: argument.node.to, reveal: "touch",
          replaces: structural ? [{ from: node.from, to: inner.from }, { from: inner.to, to: argument.node.to }] : [],
          marks: [{ from: inner.from, to: inner.to, class: ULEM_STYLES[text] }],
        });
        return undefined;
      }
    }
    if (!structural) {
      // The style layer only needs the arguments of macros drawn with editable arguments.
      if (ctrl.name === "CtrlSeq" && macroAt(defs, text.slice(1), node.from)) return macroUse(node, text.slice(1));
      return undefined;
    }
    // Accents show their source while the cursor touches them: `\c` typed before `This` is
    // already `\c T` (Ţ), but the writer is usually on the way to `\cite`.
    if (ctrl.name === "CtrlSym") {
      const accent = readAccent(read(state, node.from, Math.min(doc.length, node.from + 8)));
      if (accent) {
        symbolsUntil = node.from + accent.length;
        emit({ kind: "symbol", from: node.from, to: node.from + accent.length, reveal: "touch", replaces: [{ from: node.from, to: node.from + accent.length, widget: new SymbolWidget(accent.char, read(state, node.from, node.from + accent.length)) }] });
        return false;
      }
      const symbol = CONTROL_SYMBOLS[text];
      if (symbol !== undefined && symbol !== "") {
        emit({ kind: "symbol", from: ctrl.from, to: ctrl.to, reveal: "never", replaces: [{ from: ctrl.from, to: ctrl.to, widget: new SymbolWidget(symbol, text) }] });
      } else if (symbol === "" && structural) {
        // `\@` (Normalizing Flows' `RNN\@.`), `\/` and `\!` typeset nothing: hidden, shown again at the cursor.
        emit({ kind: "symbol", from: ctrl.from, to: ctrl.to, reveal: "touch", replaces: [{ from: ctrl.from, to: ctrl.to }] });
      }
      return false;
    }
    // A command with only empty groups after it: `\ldots{}`.
    let end = ctrl.to;
    const args = commandArguments(node);
    const emptyArgs = args.every((arg) => !arg.optional && read(state, arg.node.from, arg.node.to).replace(/\s/g, "") === "{}");
    if (emptyArgs && args.length) end = args[args.length - 1].node.to;
    const accent = readAccent(read(state, node.from, Math.min(doc.length, node.from + 8)));
    if (accent && /^\\[uvHckrdb]$/.test(text)) {
      symbolsUntil = node.from + accent.length;
      emit({ kind: "symbol", from: node.from, to: node.from + accent.length, reveal: "touch", replaces: [{ from: node.from, to: node.from + accent.length, widget: new SymbolWidget(accent.char, read(state, node.from, node.from + accent.length)) }] });
      return false;
    }
    const name = text.slice(1);
    if (DEFINITION_COMMANDS.test(text)) return skipDefinition(node);
    const macro = macroAt(defs, name, node.from);
    if (macro) return macroUse(node, name);
    const drawn = packageCommand(node, ctrl, text, args);
    if (drawn !== null) return drawn;
    // `\bibitem[label]{key}` in `thebibliography`: its marker, `[n]` in order or the label it gives.
    if (text === "\\bibitem") {
      const keyArgument = args.find((arg) => !arg.optional);
      let env: SyntaxNode | null = node.parent;
      while (env && !(env.name === "Environment" && environmentName(env, readNode) === "thebibliography")) env = env.parent;
      if (env && keyArgument && !hasDirectError(node)) {
        const optional = args.find((arg) => arg.optional && arg.node.to <= keyArgument.node.from);
        const range = optional && argumentInner(optional.node);
        const given = range ? read(state, range.from, range.to).trim().replace(/^\{([\s\S]*)\}$/, "$1") : null;
        // natbib's author–year labels (`[{Ba et~al.(2016)Ba, Kiros, and Hinton}]`) are not printed in the list.
        const label = given === null ? `[${bibitemNumber(doc, env.from, node.from)}]` : /\(\s*\d{4}[a-z]?\s*\)/.test(given) ? "" : `[${given}]`;
        const to = keyArgument.node.to;
        emit({ kind: "item", from: node.from, to, reveal: "strict", replaces: [{ from: node.from, to, widget: new ItemMarkerWidget(label, "number", 1) }] });
        return false;
      }
    }
    // ACL's `\newcite{key}` and other styles' citation commands: chips, cited as the natbib command they act like.
    if (CITE_ALIASES[text]) {
      const keysArgument = args.find((arg) => !arg.optional);
      const inner = keysArgument && argumentInner(keysArgument.node);
      if (inner && !hasDirectError(node)) {
        const keys = read(state, inner.from, inner.to).split(",").map((key) => key.trim()).filter(Boolean);
        const optionals = args.filter((arg) => arg.optional).map((arg) => { const range = argumentInner(arg.node); return range ? read(state, range.from, range.to) : ""; });
        const notes = optionals.length > 1 ? { pre: optionals[0] || undefined, post: optionals[1] || undefined } : { post: optionals[0] || undefined };
        const end = keysArgument.node.to;
        emit({ kind: "cite", from: node.from, to: end, reveal: "strict", replaces: [{ from: node.from, to: end, widget: new ChipWidget("cite", CITE_ALIASES[text], keys, notes, end - node.from) }] });
        return false;
      }
    }
    if (SYMBOL_COMMANDS[text] !== undefined && emptyArgs) {
      emit({ kind: "symbol", from: ctrl.from, to: end, reveal: "never", replaces: [{ from: ctrl.from, to: end, widget: new SymbolWidget(SYMBOL_COMMANDS[text], read(state, ctrl.from, end), /TeX/.test(text) ? "cm-vis-symbol cm-vis-logo" : "cm-vis-symbol") }] });
      return false;
    }
    if (text === "\\textcircled" && args.length === 1 && !args[0].optional) {
      const inner = argumentInner(args[0].node);
      const char = inner ? circledText(read(state, inner.from, inner.to)) : null;
      if (char) {
        emit({ kind: "symbol", from: ctrl.from, to: args[0].node.to, reveal: "touch", replaces: [{ from: ctrl.from, to: args[0].node.to, widget: new SymbolWidget(char, read(state, ctrl.from, args[0].node.to)) }] });
        return false;
      }
    }
    // `{\small …}`: one size here, so the switch is hidden until the cursor touches it.
    if (SIZE_COMMAND.test(text) && !args.length) {
      emit({ kind: "symbol", from: ctrl.from, to: ctrl.to, reveal: "touch", replaces: [{ from: ctrl.from, to: ctrl.to }] });
      return false;
    }
    if (text === "\\today" && emptyArgs) {
      emit({ kind: "symbol", from: ctrl.from, to: end, reveal: "never", replaces: [{ from: ctrl.from, to: end, widget: new SymbolWidget(todayText(), read(state, ctrl.from, end)) }] });
      return false;
    }
    return undefined;
  }

  /**
   * Package commands of the text (group D2 of the paper batches): layout lines and layout in text, text wrappers,
   * eurosym's sign, todonotes' notes, acronyms, keywords and thm-restate's restated theorems. Structural layer only;
   * null when `node` is none of these, or one it cannot read (it stays source).
   */
  function packageCommand(node: SyntaxNode, ctrl: SyntaxNode, text: string, args: ReturnType<typeof commandArguments>): false | undefined | null {
    const mandatory = args.filter((arg) => !arg.optional);
    const first = mandatory[0] && argumentInner(mandatory[0].node);
    // A line holding only layout folds away.
    if (Object.hasOwn(LAYOUT_LINE_ARGS, text.slice(1))) {
      const line = layoutLine(state, node.from);
      if (line) { collapseLine(line, "layout"); consumed.push([line.from, line.to]); return false; }
    }
    // In a line of text, `\newline` and `\par` are breaks; space and layout commands print nothing (`\vspace{2pt}`, `\noindent`).
    if (text === "\\newline" || text === "\\par") {
      emit({ kind: "symbol", from: ctrl.from, to: ctrl.to, reveal: "never", replaces: [{ from: ctrl.from, to: ctrl.to, widget: new LineBreakWidget() }] });
      return undefined;
    }
    if (/^\\(?:vspace|addvspace|vskip|hspace|hskip)$/.test(text) && !hasDirectError(node)) {
      const end = layoutExtent(state, ctrl.to, text);
      if (end > ctrl.to || /skip$/.test(text)) {
        const horizontal = /^\\h/.test(text);
        emit({ kind: "symbol", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: end, widget: horizontal ? new SymbolWidget(" ", read(state, node.from, end)) : undefined }] });
        consumed.push([node.from, end]);
        return undefined;
      }
    }
    if (INLINE_LAYOUT.test(text)) {
      let textFrom = ctrl.to;
      while (textFrom < doc.length && / |\t/.test(read(state, textFrom, textFrom + 1))) textFrom++;
      // A group the parser hung on it (`\onehalfspacing{…}`) is text: its braces are hidden too.
      const group = mandatory[0] && mandatory[0].node.from === textFrom ? first : null;
      emit({ kind: "symbol", from: node.from, to: group ? mandatory[0].node.to : textFrom, reveal: "touch", replaces: group ? [{ from: node.from, to: group.from }, { from: group.to, to: mandatory[0].node.to }] : [{ from: node.from, to: textFrom }] });
      return undefined;
    }
    // `\afterpage{…}` (a landscape table after this page) and `\raisebox{-0.1cm}{\protect\includegraphics…}` (Generative Agents'
    // inline icons): what they hold, drawn as the text around it.
    const wrapped = TEXT_WRAPPERS[text];
    if (wrapped && mandatory.length === wrapped && !hasDirectError(node)) {
      const content = argumentInner(mandatory[wrapped - 1].node);
      if (content) {
        const end = mandatory[wrapped - 1].node.to;
        emit({ kind: "style", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: content.from }, { from: content.to, to: end }] });
        consumed.push([node.from, content.from]);
        return undefined;
      }
    }
    // eurosym's `\euro{8.50}` and `\EUR{8.50}` (the minimum-wage paper): the sign, before the amount (after it with `right`).
    if ((text === "\\euro" || text === "\\EUR") && mandatory.length === 1 && first && !hasDirectError(node)) {
      const end = mandatory[0].node.to;
      const right = text === "\\EUR" && defs.packageOptions.get("eurosym")?.includes("right");
      const sign = (label: string, from: number, to: number) => ({ from, to, widget: new SymbolWidget(label, read(state, node.from, end)) });
      emit({
        kind: "symbol", from: node.from, to: end, reveal: "touch",
        replaces: right ? [{ from: node.from, to: first.from }, sign(" €", first.to, end)] : [sign(text === "\\EUR" ? "€ " : "€", node.from, first.from), { from: first.to, to: end }],
      });
      consumed.push([node.from, first.from]);
      return undefined;
    }
    // todonotes' `\todo[inline]{…}` and `\missingfigure{…}`: a note chip with its text.
    if ((text === "\\todo" || text === "\\missingfigure") && first && !hasDirectError(node)) {
      const end = mandatory[0].node.to;
      emit({ kind: "todo", from: node.from, to: end, reveal: "strict", replaces: [{ from: node.from, to: end, widget: new TodoWidget(text === "\\todo" ? "To do" : "Missing figure", read(state, first.from, first.to), end - node.from) }] });
      consumed.push([node.from, end]);
      return false;
    }
    // `\gls{gpu}`, `\acrlong{gpu}`, `\ac{CNN}`: the form of the entry they print, as a macro's text.
    if (first && ctrl.name === "CtrlSeq") {
      const starred = read(state, ctrl.to, ctrl.to + 1) === "*";
      const printed = acronymText(defs, text, read(state, first.from, first.to));
      if (printed !== null && !starred && !hasDirectError(node)) {
        const end = mandatory[0].node.to;
        emit({ kind: "macro", from: node.from, to: end, reveal: "strict", replaces: [{ from: node.from, to: end, widget: new MacroWidget(text.slice(1), printed, end - node.from, "acronym") }] });
        consumed.push([node.from, end]);
        return false;
      }
    }
    // `\keywords{…}` in the text (an abstract's, Stata Journal): "Keywords:" and the keywords.
    if (text === "\\keywords" && mandatory.length === 1 && first && !hasDirectError(node)) {
      const end = mandatory[0].node.to;
      emit({ kind: "style", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: first.from, widget: new SymbolWidget("Keywords: ", "\\keywords", "cm-vis-keywords-label") }, { from: first.to, to: end }] });
      consumed.push([node.from, first.from]);
      return undefined;
    }
    // thm-restate's `\promisemonoids*`: the restatable theorem of that name printed again, drawn as its heading.
    const restated = !args.length && ctrl.name === "CtrlSeq" && read(state, ctrl.to, ctrl.to + 1) === "*" ? restatablesIn(doc).get(text.slice(1)) : undefined;
    const restatedTheorem = restated && defs.theorems.get(restated.env);
    if (restated && restatedTheorem) {
      const end = ctrl.to + 1;
      const span = aloneOnLines(doc, node.from, end);
      const range = span ?? { from: node.from, to: end };
      emit({ kind: "env-header", from: range.from, to: range.to, reveal: "line", wholeLine: true, replaces: [{ from: range.from, to: range.to, widget: new RestatedTheoremWidget(text.slice(1), restatedTheorem.title, restated.note, !!restatedTheorem.numbered) }] });
      consumed.push([range.from, range.to]);
      return false;
    }
    return null;
  }

  /**
   * A definition the grammar does not know (`\providecommand`, `\NewDocumentCommand`, …): its name and
   * arguments are source, so nothing in its body is drawn. They may follow the command as separate nodes.
   */
  function skipDefinition(node: SyntaxNode): false {
    // The definition reader knows where it ends.
    const extent = definitionExtentAt(defs, node.from);
    if (extent) { consumed.push([node.from, Math.max(node.to, extent.to)]); return false; }
    const text = read(state, node.from, Math.min(doc.length, node.from + 8000));
    let index = /^\\[A-Za-z@]+\*?/.exec(text)![0].length;
    for (let parts = 0; parts < 8; parts++) {
      const space = /^(?:\s|%[^\n]*\n)*/.exec(text.slice(index))![0];
      if (space.includes("\n\n")) break;
      const at = index + space.length;
      const name = /^\\[A-Za-z@]+/.exec(text.slice(at));
      const group = name ? null : readGroup(text, at, TEX_GROUPS) ?? readOptional(text, at, TEX_GROUPS);
      if (name) index = at + name[0].length;
      else if (group) index = group.end;
      else break;
    }
    consumed.push([node.from, node.from + index]);
    return false;
  }

  /**
   * A use of a macro that writes structure (`\mysec{…}`, `\step`, `\seclabel{…}`, `\fn{…}`,
   * `\thm{…}`, `\beq … \eeq`): drawn as the heading, item, label, footnote or environment
   * its expansion is, read-only. Null when its expansion is something else.
   */
  function structuralMacroUse(node: SyntaxNode, name: string): false | null {
    const region = macroEnvironmentRegionAt(macroRegionsFor(doc, defs), node.from);
    if (region) {
      if (!structural) return false;
      // An `align` opened by `\bea` is a formula: math-only macros (`\DeclareMathOperator{\vecop}`) expand in it.
      const expanded = expandLatexMacros(read(state, region.from, region.to), defs, { mode: MATH_ENVIRONMENT.test(region.env) ? "math" : "text", pos: region.from });
      if (!expanded.ok || !expandedEnvironment(region.from, region.to, expanded.text)) return null;
      consumed.push([region.from, region.to]);
      return false;
    }
    // Half of a pair without its other half stays as it is.
    if (isPairMacro(defs, name)) return null;
    const use = expandLatexMacroUse(read(state, node.from, Math.min(doc.length, node.from + 4000)), defs, { mode: "text", pos: node.from });
    if (!use) return null;
    const to = node.from + use.length;
    const parts = topConstructs(use.text);
    if (!parts.length) return null;
    const [first, second] = parts;
    const inner = (argument: SyntaxNode | null) => { const range = argument && argumentInner(argument); return range ? use.text.slice(range.from, range.to) : null; };
    const done = () => { consumed.push([node.from, to]); return false as const; };

    if (first.name in SECTION_CLASSES && (parts.length === 1 || (parts.length === 2 && second.name === "Label"))) {
      const title = inner(first.getChild("SectioningCommand")?.getChild("SectioningArgument") ?? null);
      if (title === null) return null;
      const runIn = first.name === "Paragraph" || first.name === "SubParagraph";
      // As for a heading written out: the widget in the structural layer, the line style in both.
      emit({
        kind: "heading", from: node.from, to, reveal: "strict",
        replaces: structural ? [{ from: node.from, to, widget: new MacroHeadingWidget(title, to - node.from) }] : [],
        lines: runIn ? undefined : [{ from: node.from, to, class: `cm-vis-heading ${SECTION_CLASSES[first.name]}` }],
      });
      return done();
    }
    if (parts.length !== 1) return null;
    if (first.name === "Item") {
      if (!lists.length) return null;
      if (!structural) return done();
      emitItem(node.from, to, inner(first.getChild("OptionalArgument")));
      return done();
    }
    if (first.name === "Label") {
      const key = inner(first.getChild("LabelArgument"));
      if (key === null) return null;
      if (structural) emit({ kind: "label", from: node.from, to, reveal: "strict", replaces: [{ from: node.from, to, widget: new ChipWidget("label", "\\label", [key.trim()], {}, to - node.from) }] });
      return done();
    }
    if (first.name === "FootnoteCommand" || first.name === "EndnoteCommand") {
      const text = inner(first.getChild("TextArgument"));
      if (text === null) return null;
      if (structural) emit({ kind: "footnote", from: node.from, to, reveal: "strict", replaces: [{ from: node.from, to, widget: new MacroFootnoteWidget(text, to - node.from) }] });
      return done();
    }
    if (first.name === "Environment" || first.name === "EquationEnvironment" || first.name === "EquationArrayEnvironment" || first.name === "ListEnvironment") {
      if (!structural) return done();
      return expandedEnvironment(node.from, to, use.text) ? done() : null;
    }
    return null;
  }

  /** Draws an environment written through macros at [from, to] from its expansion `text`; false when it is not one it draws. */
  function expandedEnvironment(from: number, to: number, text: string) {
    const parts = topConstructs(text);
    if (parts.length !== 1) return false;
    const env = parts[0];
    const readText = (start: number, end: number) => text.slice(start, end);
    const envName = environmentName(env, readText);
    const content = env.getChild("Content");
    if (!envName || !env.getChild("EndEnv")) return false;
    // A float or grid written by macros (SIAM's `\bfigure…\efigure`): drawn as a plain body it would show its `\caption`
    // as text, without its number; it stays source, with its parts drawn on their own.
    if (envName in FLOAT_KINDS || /^(?:figure|table|algorithm)\*?$/.test(envName) || TABULAR_NAMES.test(envName)) return false;
    const body = content ? text.slice(content.from, content.to) : "";
    const span = aloneOnLines(doc, from, to);
    const range = span ?? { from, to };
    if (env.name === "EquationEnvironment" || env.name === "EquationArrayEnvironment") {
      const source = katexForEnvironment(envName, body);
      const expanded = expandLatexMacros(source.latex, defs, { mode: "math", pos: from });
      const counted = expanded.ok ? countedRows(expanded.text) : null;
      const latex = counted?.latex ?? expanded.text;
      const html = expanded.ok ? renderKatex(withReferences(latex), !source.inline) : null;
      if (!html) return false;
      emit({ kind: "math", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new MathWidget(html, !source.inline, !!span, read(state, from, to), source.numbered || !!counted?.numbered, from - range.from, range.to - range.from, referenced(latex)) }] });
      return true;
    }
    let spec: ExpandedEnvironmentSpec;
    if (env.name === "ListEnvironment") {
      const items = splitItems(body);
      if (!items) return false;
      spec = { header: null, body, items: { ordered: envName === "enumerate", items }, className: null, length: range.to - range.from };
    } else {
      const theorem = defs.theorems.get(envName);
      const user = defs.environments.get(envName);
      let note: string | null = null;
      let rest = body;
      const optional = /^\s*\[([^\]]*)\]/.exec(body);
      if (optional && (theorem || envName === "proof")) { note = optional[1]; rest = body.slice(optional[0].length); }
      const beginNote = env.getChild("BeginEnv")?.getChild("OptionalArgument");
      if (beginNote) { const inner = argumentInner(beginNote); if (inner) note = text.slice(inner.from, inner.to); }
      const header: ExpandedEnvironmentSpec["header"] = theorem ? { variant: "theorem", title: theorem.title, note, numbered: !!theorem.numbered }
        : envName === "proof" ? { variant: "proof", title: note ?? "Proof", note: null, numbered: false }
          : envName === "abstract" ? { variant: "abstract", title: "Abstract", note: null, numbered: false }
            : user && drawableEnvironmentCode(user.begin) ? { variant: "user", title: drawableEnvironmentCode(user.begin)!, note: null, numbered: false } : null;
      // An environment whose code the header cannot draw stays source, as when it is written out.
      if (!theorem && user && drawableEnvironmentCode(user.begin) === null) return false;
      const className = theorem ? THEOREM_STYLE_CLASSES[theorem.style] : envName === "proof" ? "cm-vis-proof" : envName === "abstract" ? "cm-vis-abstract" : null;
      spec = { header, body: rest.trim(), items: null, className, length: range.to - range.from };
    }
    emit({ kind: "macro-env", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new ExpandedEnvironmentWidget(spec) }] });
    return true;
  }

  function macroUse(node: SyntaxNode, name: string): false | undefined {
    // A macro in an environment's opening arguments (`\begin{subfigure}{\nfwidth}`) is a length or a setting: source.
    for (let parent = node.parent, depth = 0; parent && depth < 6; parent = parent.parent, depth++) if (parent.name === "BeginEnv") return undefined;
    // An argument the parser ends early (at a blank line or a heading: an unclosed brace) is read
    // further in the text than the tree shows: drawn from the text, the use would change with
    // edits the tree does not tie to it. Its parts are drawn on their own.
    if (node.getChildren("TextArgument").some((argument) => hasDirectError(argument) || argument.lastChild?.lastChild?.type.isError)) return undefined;
    if (structureMacroNames(defs).has(name)) {
      const drawn = structuralMacroUse(node, name);
      if (drawn !== null) return drawn;
    }
    const source = read(state, node.from, Math.min(doc.length, node.from + 4000));
    // Arguments that stay editable text, when the body allows it.
    const macro = macroAt(defs, name, node.from)!;
    const plan = transparentPlan(macro, defs);
    const groups = plan ? argumentGroups(source, node.from, 1 + name.length, macro.arity) : null;
    if (plan && groups) {
      const end = groups[groups.length - 1].close + 1;
      const replaces: Replace[] = [];
      if (structural) {
        replaces.push({ from: node.from, to: groups[0].open + 1, widget: new MacroPieceWidget(plan.pieces[0], name) });
        for (let i = 1; i < groups.length; i++) replaces.push({ from: groups[i - 1].close, to: groups[i].open + 1, widget: new MacroPieceWidget(plan.pieces[i], name) });
        replaces.push({ from: groups[groups.length - 1].close, to: end, widget: new MacroPieceWidget(plan.pieces[groups.length], name) });
      }
      emit({
        kind: "macro-args", from: node.from, to: end, reveal: "touch", replaces,
        marks: groups.map((group, index) => ({ from: group.open + 1, to: group.close, class: plan.marks[index].class, attributes: plan.marks[index].style ? { style: plan.marks[index].style } : undefined })),
      });
      // The arguments are walked like any other text.
      return undefined;
    }
    const use = expandLatexMacroUse(source, defs, { mode: "text", pos: node.from });
    // A macro that only sets TeX's spacing (IEEEtran's `\BIBentryALTinterwordspacing` in its references, B5-27) prints nothing.
    if (use && structural && SPACING_ONLY.test(use.text)) {
      const to = node.from + use.length;
      emit({ kind: "symbol", from: node.from, to, reveal: "touch", replaces: [{ from: node.from, to }] });
      consumed.push([node.from, to]);
      return false;
    }
    // A macro that only sets layout (`\tablestyle{2pt}{1.1}`) stays as written, as layout commands do.
    if (!use || (use.text.trim() && layoutOnly(use.text))) return undefined;
    // A macro whose expansion is TeX programming (ICML's `\icmlauthor`: `\g@addto@macro`, `\csname`, flags made with
    // `\newif`) would be drawn as raw tokens, worse than its use: it stays as written.
    if (TEX_PROGRAMMING.test(use.text)) return undefined;
    // Half of an environment written by a macro that is not a recognised pair (SIAM's `\bequalin` opens equation* and
    // aligned): a widget would show `\begin{…}` as text; the use stays as written.
    if (!balancedEnvironments(use.text)) return undefined;
    const to = node.from + use.length;
    const fingerprint = use.used.join(",");
    const ensure = /^\s*\\ensuremath\s*\{([\s\S]*)\}\s*$/.exec(use.text);
    if (ensure || (needsMathMode(use.text) && macroAt(defs, name, node.from)?.mathOnly)) {
      // A math macro used in text through \ensuremath: drawn as a formula.
      const latex = ensure ? ensure[1] : use.text;
      const formula = expandLatexMacros(latex, defs, { mode: "math", pos: node.from }).text;
      const html = renderKatex(withReferences(formula), false);
      if (!html) return undefined;
      emit({ kind: "math", from: node.from, to, reveal: "strict", replaces: [{ from: node.from, to, widget: new MathWidget(html, false, false, read(state, node.from, to), false, 0, to - node.from, referenced(formula)) }] });
      // The parser may attach only some of the arguments to the command: the rest are inside the widget too.
      consumed.push([node.from, to]);
      return false;
    }
    if (needsMathMode(use.text)) return undefined;
    emit({ kind: "macro", from: node.from, to, reveal: "strict", replaces: [{ from: node.from, to, widget: new MacroWidget(name, use.text, to - node.from, fingerprint) }] });
    consumed.push([node.from, to]);
    return false;
  }
}

function listContext(node: SyntaxNode, name: string, lists: ListContext[], state: EditorState, count: number): ListContext {
  const variant = name === "enumerate" ? "number" : name === "description" ? "description" : "bullet";
  const depth = lists.filter((list) => list.variant === variant || (variant !== "number" && list.variant !== "number")).length + 1;
  const optional = node.getChild("BeginEnv")?.getChild("OptionalArgument");
  const range = optional && argumentInner(optional);
  return { node, variant, depth, count, template: range ? state.doc.sliceString(range.from, range.to) : null };
}

/**
 * The label enumitem's `\setlist[name,level]{label=…}` gives a level of a list of the document's own, as an
 * `enumerateItemLabel` template; a counter it starts with (`\thechapter.\arabic*`) is left out, as the walk does not
 * know its value.
 */
function customListLabel(defs: LatexDefinitions, name: string, depth: number) {
  const options = defs.listOptions?.get(`${name}:${depth}`);
  if (!options || !/(?:^|,)\s*label\s*=/.test(options)) return null;
  return options.replace(/\\the[A-Za-z]+\s*\.?/g, "").replace(/\\emph\s*\{([^{}]*)\}/g, "$1");
}

/** Tabulars: the grammar names `tabular` and `tabularx`; `tabular*`, `tabulary` and `array`-like ones are plain environments. */
const TABULAR_NAMES = /^(?:tabular\*?|tabularx|tabulary|longtable\*?|xltabular)$/;
export function isTabular(node: SyntaxNode, read: (from: number, to: number) => string) {
  return node.name === "TabularEnvironment" || (node.name === "Environment" && TABULAR_NAMES.test(environmentName(node, read) ?? ""));
}

/** Containers inside a float that hold one caption each: side-by-side minipages, algorithm floats inside them, and subcaption's sub-floats. */
const PANEL_ENVIRONMENTS = new Set(["minipage", "algorithm", "algorithm*", "subfigure", "subtable"]);
/** subcaption's sub-floats (the grammar parses `subfigure` as a figure): panels whose captions are lettered, "(a)". */
const SUB_FLOATS = new Set(["subfigure", "subtable"]);
const isSubFloat = (node: SyntaxNode, read: (from: number, to: number) => string) => (node.name === "FigureEnvironment" || node.name === "Environment") && SUB_FLOATS.has(environmentName(node, read) ?? "");
/** The subfigure and subfig packages' panels, written as commands: `\subfigure[caption]{…}`, `\subfloat[caption]{…}`. */
const isSubFloatCommand = (node: SyntaxNode, read: (from: number, to: number) => string) =>
  node.name === "UnknownCommand" && !!node.firstChild && /^\\(?:subfigure|subfloat)$/.test(read(node.firstChild.from, node.firstChild.to)) && !!node.getChild("TextArgument");

/**
 * Diagrams of TikZ-based packages, typeset only in the PDF: in a float each is a placeholder naming its package, as a
 * `tikzpicture` is (quantikz's circuit in the QMA₁ paper, a tikz-cd square, xy's `\xymatrix{…}`, cryptocode's games).
 */
const DIAGRAM_ENVIRONMENTS: Record<string, string> = { tikzcd: "tikz-cd", quantikz: "quantikz", circuitikz: "circuitikz", pchstack: "cryptocode", pcvstack: "cryptocode", pgfpicture: "PGF" };
const DIAGRAM_COMMANDS: Record<string, string> = { "\\xymatrix": "xy", "\\procedure": "cryptocode", "\\pseudocode": "cryptocode", "\\procedureblock": "cryptocode", "\\pseudocodeblock": "cryptocode" };
/** tikzit's `\tikzfig{name}` and `\ctikzfig{name}`: a drawing read from `name.tikz`. */
const TIKZIT_FIGURE = /^\\c?tikzfig$/;
/** The drawing a float shows for a diagram command or environment: `diagram:<package>`, or tikzit's file; null for others. */
function diagramDrawing(node: SyntaxNode, state: EditorState) {
  if (node.name === "Environment") {
    const env = environmentName(node, (from, to) => read(state, from, to)) ?? "";
    return DIAGRAM_ENVIRONMENTS[env] ? `diagram:${DIAGRAM_ENVIRONMENTS[env]}` : null;
  }
  const ctrl = node.name === "UnknownCommand" ? node.firstChild : null;
  const command = ctrl ? read(state, ctrl.from, ctrl.to) : "";
  if (DIAGRAM_COMMANDS[command]) return `diagram:${DIAGRAM_COMMANDS[command]}`;
  if (TIKZIT_FIGURE.test(command)) {
    const argument = commandArguments(node).find((arg) => !arg.optional);
    const inner = argument && argumentInner(argument.node);
    return inner ? `${read(state, inner.from, inner.to).trim()}.tikz` : null;
  }
  return null;
}

/**
 * A displayed formula in a float that only holds a drawing KaTeX cannot draw (`\[ \input{dict.tikz} \]` in the
 * hypergraph paper, `\[\begin{tikzcd}…\end{tikzcd}\]`, `\[\xymatrix{…}\]`): the drawing, else null.
 */
function mathDrawing(node: SyntaxNode, state: EditorState) {
  if (!/^(?:BracketMath|DollarMath|EquationEnvironment)$/.test(node.name) || hasDirectError(node)) return null;
  const text = read(state, node.from, node.to).replace(/^(?:\\\[|\$\$|\\begin\s*\{equation\*?\})|(?:\\\]|\$\$|\\end\s*\{equation\*?\})$/g, "").trim();
  const input = /^\\input\s*\{([^{}]*)\}$/.exec(text);
  if (input) return input[1].trim();
  const env = /^\\begin\s*\{(tikzcd|quantikz)\}[\s\S]*\\end\s*\{(tikzcd|quantikz)\}$/.exec(text);
  if (env && env[1] === env[2]) return `diagram:${DIAGRAM_ENVIRONMENTS[env[1]]}`;
  return /^\\xymatrix\s*(?:@[^{]*)?\{[\s\S]*\}$/.test(text) ? "diagram:xy" : null;
}

/**
 * tcolorbox's and mdframed's boxes, and the document's own (`\newtcolorbox{prompt}[1][]{title=#1}`, `\newmdenv{note}`)
 * as written in the open file, per document version: their names, with the title their options give.
 */
const boxCache = new WeakMap<Text, Map<string, { title: string | null; arity: number }>>();
export function boxEnvironments(doc: Text) {
  let boxes = boxCache.get(doc);
  if (boxes) return boxes;
  boxes = new Map([["tcolorbox", { title: null, arity: 0 }], ["mdframed", { title: null, arity: 0 }]]);
  const text = doc.toString();
  if (/\\(?:(?:re)?newtcolorbox|DeclareTColorBox|NewTColorBox|newmdenv)\b/.test(text)) {
    for (const match of stripTexComments(text).matchAll(/\\(?:(?:re)?newtcolorbox|DeclareTColorBox|NewTColorBox|newmdenv)\s*(?:\[([^\]]*)\])?\s*\{([A-Za-z@*]+)\}/g)) {
      const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 2000);
      // `[1]` (arguments) and `[default]`, then the options; xparse's `{O{}}` spec first for `\DeclareTColorBox`.
      const count = /^\s*\[(\d)\]/.exec(after);
      const options = /^newmdenv/.test(match[0].slice(1)) ? match[1] ?? "" : (() => {
        const rest = after.slice(count ? count[0].length : 0).replace(/^\s*\[[^\]]*\]/, "");
        const group = /^\s*\{/.exec(rest) ? readGroup(rest, rest.indexOf("{"), TEX_GROUPS) : null;
        return group?.content ?? "";
      })();
      boxes.set(match[2], { title: boxTitle(options), arity: count ? Number(count[1]) : 0 });
    }
  }
  boxCache.set(doc, boxes);
  return boxes;
}

/** A box's title from its options (`title=Prompt`, mdframed's `frametitle={…}`), null without one. */
function boxTitle(options: string) {
  const match = /(?:^|,)\s*(?:frame)?title\s*=\s*/.exec(options);
  if (!match) return null;
  const rest = options.slice((match.index ?? 0) + match[0].length);
  const value = rest[0] === "{" ? readGroup(rest, 0, TEX_GROUPS)?.content : /^[^,]*/.exec(rest)?.[0];
  return value?.trim() || null;
}

/** A box environment's options and title as used (`\begin{prompt}[Self-RAG]`, `\begin{tcolorbox}[title=…]`), and where its opening ends. */
function boxUse(node: SyntaxNode, state: EditorState) {
  const name = environmentName(node, (from, to) => read(state, from, to)) ?? "";
  const box = boxEnvironments(state.doc).get(name);
  const begin = node.getChild("BeginEnv");
  const nameEnd = begin?.getChild("EnvNameGroup")?.to;
  if (!box || !begin || nameEnd === undefined) return null;
  const after = read(state, nameEnd, Math.min(state.doc.length, nameEnd + 2000));
  // Its options (or a document box's optional first argument) on the `\begin` line, then its other arguments.
  const args: string[] = [];
  let at = 0;
  const optional = /^[ \t]*\[/.test(after) ? readOptional(after, after.indexOf("["), TEX_GROUPS) : null;
  if (optional) { args.push(optional.content); at = optional.end; }
  for (let n = args.length; n < box.arity; n++) {
    const open = /^\s*\{/.exec(after.slice(at));
    const group = open ? readGroup(after, at + open[0].length - 1, TEX_GROUPS) : null;
    if (!group) return null;
    args.push(group.content);
    at = group.end;
  }
  // A document box's title may be its argument (`title=#1`); a title with a parameter not given is not known.
  const given = name === "tcolorbox" || name === "mdframed" ? boxTitle(args[0] ?? "") : box.title?.replace(/#(\d)/g, (whole, n: string) => args[Number(n) - 1] ?? whole) ?? null;
  return { title: given && !/#\d/.test(given) ? given : null, end: Math.max(begin.to, nameEnd + at), name };
}

/**
 * Whether the figure widget would show everything in a float: its images,
 * drawings, tables and algorithms, one caption per float or minipage panel,
 * labels, comments and layout commands. Text, other commands and sub-figures
 * are not drawn by it, so such a float stays source (its parts render on their own).
 */
function figureCovered(node: SyntaxNode, state: EditorState, defs: LatexDefinitions, captionMacro: (use: SyntaxNode) => string | null) {
  const content = node.getChild("Content");
  if (!content) return true;
  // algorithm2e's statements are the float's body: covered when they can be read.
  if (algorithm2eSpec(node, state, defs)) return true;
  const readState = (from: number, to: number) => read(state, from, to);
  let covered = true;
  // An algorithm float may describe its algorithm before the lines (Generalized Random Forests: "All tuning
  // parameters are pre-specified…"): prose there is drawn above them. Anywhere else, prose leaves the float source.
  const proseBefore = algorithmProseLimit(node, state);
  /** The end of a `\subcaption*{…}` note's group, whose text is drawn as the note. */
  let noteUntil = -1;
  /** Where the float's notes start (after its last image, grid or caption): text from there is drawn as a note. */
  const notesFrom = floatNotesStart(node, state);
  const notesBefore = notesBeforeCaption(node, state);
  /** Captions per container (the float, or the panel the caption is in). */
  const captions = new Map<number, number>();
  const caption = (at: SyntaxNode) => {
    // `\caption*{Notes: …}` beside a caption is a note under it (figureSpec), not a second caption.
    if (at.name === "Caption" && read(state, at.from, at.from + 9) === "\\caption*") return;
    let container = node.from;
    for (let parent = at.parent; parent && parent.from > node.from; parent = parent.parent) {
      if ((parent.name === "Environment" || parent.name === "FigureEnvironment") && PANEL_ENVIRONMENTS.has(environmentName(parent, readState) ?? "")) { container = parent.from; break; }
    }
    const count = (captions.get(container) ?? 0) + 1;
    captions.set(container, count);
    // A panel has one caption; the float itself may have several (two tables in one float, drawn as parts).
    if (count > 1 && container !== node.from) covered = false;
  };
  /** Sub-floats in a wrapper (`\scalebox{1}{\begin{subfigure}…}`): panels, checked as the float's content is; a `\subfigure[…]{…}` by its group. */
  const panel = (sub: SyntaxNode) => { (sub.name === "UnknownCommand" ? sub.getChildren("TextArgument").at(-1) ?? sub : sub).cursor().iterate(visit); return covered; };
  const visit = (ref: SyntaxNodeRef): boolean | undefined => {
    if (!covered) return false;
    const name = ref.name;
    if (ref.to <= noteUntil) return false;
    if (ref.type.isError) { covered = false; return false; }
    // A listing or `\verb` text is visible content the figure widget cannot draw: replacing the float would hide it.
    if (VISIBLE_SKIPPED.has(name)) { covered = false; return false; }
    // The notes after the last image, grid or caption (tablenotes, a notes minipage, `\floatfoot`, a "Notes:" paragraph).
    if (ref.from >= notesFrom && name !== "EndEnv") return false;
    // Notes between the content and a caption at the end.
    if (notesBefore && ref.from >= notesBefore.from && ref.to <= notesBefore.to) return false;
    if (SKIPPED.has(name) || name === "Whitespace" || name === "NewLine" || name === "BlankLine" || name === "LineBreak" || name === "Tilde") return false;
    if (name === "IncludeGraphics" || name === "Label" || name === "TabularEnvironment" || name === "SetLengthCommand" || name === "Centering") return false;
    if (name === "Caption") { caption(ref.node); return false; }
    if (ref.to <= proseBefore && PROSE_NODES.has(name)) return false;
    if (name === "Normal") { if (read(state, ref.from, ref.to).trim()) covered = false; return false; }
    // A drawing from another file (`\input{fig}`, often TikZ), or a table's (`\include{tables/stats}`, the cannabis
    // pass-through paper's tables): shown as a placeholder.
    if (name === "Input" || name === "Include") return false;
    // `\[ \input{dict.tikz} \]`, a tikz-cd diagram in a formula: a drawing too.
    if (mathDrawing(ref.node, state)) return false;
    if (name === "UnknownCommand") {
      const ctrl = ref.node.firstChild;
      const command = ctrl ? read(state, ctrl.from, ctrl.to) : "";
      if (command === "\\includestandalone" || diagramDrawing(ref.node, state)) return false;
      // floatrow's `\floatfoot{Notes: …}`, wherever it is: a note under the caption.
      if (command === "\\floatfoot") {
        const note = groupAfter(state, ctrl!.to);
        if (!note) { covered = false; return false; }
        noteUntil = Math.max(noteUntil, note.end);
        return false;
      }
      // `{\tt \footnotesize \begin{tabularx}…}` (SimPO's example generations): the font is the grid's, its content checked.
      if (FONT_SWITCHES[command]) { for (const argument of ref.node.getChildren("TextArgument")) argument.cursor().iterate(visit); return false; }
      // subcaption's `\subcaption*{Notes: …}` under a figure: unnumbered text, drawn under the caption.
      if (command === "\\subcaption" && read(state, ctrl!.to, ctrl!.to + 1) === "*") {
        const note = starredNote(state, ctrl!.to);
        if (!note) { covered = false; return false; }
        noteUntil = note.end;
        return false;
      }
      if (ref.to <= proseBefore && (command === "\\justify" || command === "\\justifying")) return false;
      // `\subfigure[caption]{…}`: a panel, its caption in brackets and its content checked as the float's.
      if (isSubFloatCommand(ref.node, readState)) { panel(ref.node); return false; }
      // caption's `\captionof{table}{…}`, KOMA's `\captionabove{…}`, and a macro that writes the caption (`\mycap{…}`), are captions.
      if (CAPTION_OF.test(command) || KOMA_CAPTION.test(command) || captionMacro(ref.node) !== null) { caption(ref.node); return false; }
      // `\resizebox{\linewidth}{!}{\input{fig}}`: a drawing, scaled.
      if (DRAWING_WRAPPERS.test(command)) { if (!drawingOnly(ref.node, state, panel, defs, notesFrom)) covered = false; return false; }
      // Layout with what it takes (`\vskip 0.15in`, `\vspace*{2pt}`, `\setlength\tabcolsep{3pt}`, `\aboverulesep = 2mm`,
      // acmart's `\Description{…}`): none of it is drawn, so none of it is content.
      if (FIGURE_LAYOUT.test(command) || SIZE_COMMAND.test(command) || FLOAT_LENGTHS.test(command)) { noteUntil = Math.max(noteUntil, layoutExtent(state, ctrl!.to, command)); return false; }
      if (!layoutMacro(ref.node, state, defs)) covered = false;
      return false;
    }
    // `\begin{center}`, minipages and sub-figures: their markup is layout, their content is checked. A TikZ picture
    // is a drawing; an algorithm is its caption and its algorithmic lines.
    if (name === "Environment" || name === "FigureEnvironment") {
      const env = environmentName(ref.node, readState) ?? "";
      if (name === "FigureEnvironment" && !SUB_FLOATS.has(env)) { covered = false; return false; }
      if (env === "tikzpicture" || TABULAR_NAMES.test(env)) return false;
      if (env === "algorithmic") { if (!algorithmicSpec(ref.node, state, defs)) covered = false; return false; }
      // adjustbox's `\begin{adjustbox}{width=\linewidth}` and threeparttable: around the content, which is checked.
      if (env === "adjustbox" || env === "threeparttable" || env === "ThreePartTable") return undefined;
      // overpic: an image with text put over it, drawn without the overlay; a `picture` puts labels over the images
      // around it (Neyshabur's `\begin{picture}(0,0)\put(-162,90){$\ell_2$ norm}…`), noted as an overlay.
      if (env === "overpic" || env === "picture") return false;
      // A diagram the PDF draws, and a box whose content is drawn as text (Self-RAG's prompts in a `tcolorbox`).
      if (DIAGRAM_ENVIRONMENTS[env] || boxEnvironments(state.doc).has(env)) return false;
      if (env !== "center" && !SIZE_ENVIRONMENTS.has(env) && !PANEL_ENVIRONMENTS.has(env)) covered = false;
      return undefined;
    }
    if (name === "BeginEnv" || name === "EndEnv") return false;
    // `\mbox{\subfigure[…]{…} \subfigure[…]{…}}`: a box around the content.
    if (name === "MathTextCommand") { if (!drawingOnly(ref.node, state, panel, defs)) covered = false; return false; }
    // `{\small \begin{tabular}…}`: a group around the content, for its size; a panel command's group.
    if (name === "Group" || name === "NonEmptyGroup" || name === "OpenBrace" || name === "CloseBrace" || name === "TextArgument" || name === "LongArg") return undefined;
    // `\\` between images (a `KnownCtrlSym` holding a `LineBreak`) is layout.
    if (name === "Content" || name === "Text" || name === "Command" || name === "KnownCommand" || name === "KnownCtrlSym" || name === "KnownEnvironment") return undefined;
    covered = false;
    return false;
  };
  content.cursor().iterate(visit);
  return covered;
}

/**
 * algorithm2e's `algorithm` (the document loads algorithm2e, and the float holds no `algorithmic`): its lines,
 * read from the float's body, and whether its caption is on top (the `ruled` styles); null when they cannot be read.
 */
function algorithm2eSpec(node: SyntaxNode, state: EditorState, defs: LatexDefinitions) {
  if (node.name !== "Environment" || !defs.packages.includes("algorithm2e")) return null;
  const env = environmentName(node, (from, to) => read(state, from, to));
  const content = node.getChild("Content");
  if ((env !== "algorithm" && env !== "algorithm*") || !content) return null;
  const body = read(state, content.from, content.to);
  if (/\\begin\s*\{algorithmic\}/.test(body)) return null;
  const options = defs.packageOptions.get("algorithm2e") ?? [];
  // Keywords declared before it (`\SetKwInOut{Input}{Input}` in the preamble) are read first; the document's statement
  // macros (`\PyCode{…}`) are read as what they write.
  let declarations = "";
  for (const name of defs.macros.keys()) { const macro = macroAt(defs, name, node.from); if (macro?.package === "algorithm2e") declarations += macro.body; }
  const expand = (source: string) => expandLatexMacroUse(source, defs, { mode: "text", pos: node.from });
  const algorithm = parseAlgorithm2e(declarations + body, { numbered: options.includes("linesnumbered"), ends: !options.some((option) => option === "vlined" || option === "noend") }, expand);
  return algorithm && { algorithm, ruled: options.some((option) => option === "ruled" || option === "algoruled") };
}

/** An `algorithmic` environment's lines, or null when they cannot be read. The document's macros may write statements. */
function algorithmicSpec(node: SyntaxNode, state: EditorState, defs?: LatexDefinitions) {
  const content = node.getChild("Content");
  const options = node.getChild("BeginEnv")?.getChild("OptionalArgument");
  const range = options && argumentInner(options);
  const expand = defs?.macros.size ? (source: string) => expandLatexMacroUse(source, defs, { mode: "text", pos: node.from }) : undefined;
  return content ? parseAlgorithmic(read(state, content.from, content.to), range ? read(state, range.from, range.to) : null, expand) : null;
}

/** Where each `\bibitem` of the `thebibliography` at `envFrom` is (outside comments), per document version. */
const bibitemCache = new WeakMap<Text, Map<number, number[]>>();
/** The number of the `\bibitem` at `at` in the `thebibliography` at `envFrom`: its place in the list. */
function bibitemNumber(doc: Text, envFrom: number, at: number) {
  let byEnvironment = bibitemCache.get(doc);
  if (!byEnvironment) bibitemCache.set(doc, byEnvironment = new Map());
  let starts = byEnvironment.get(envFrom);
  if (!starts) {
    const text = doc.sliceString(envFrom);
    const end = text.search(/\\end\s*\{thebibliography\}/);
    const body = (end < 0 ? text : text.slice(0, end)).replace(/(^|[^\\])%[^\n]*/g, (comment, before: string) => before + " ".repeat(comment.length - before.length));
    starts = [...body.matchAll(/\\bibitem(?![A-Za-z@])/g)].map((match) => envFrom + match.index);
    byEnvironment.set(envFrom, starts);
  }
  let count = 0;
  for (const start of starts) { if (start > at) break; count++; }
  return count;
}

/** etoolbox toggles as the document sets them (`\togglefalse{hq}`), per document version: unset is false. */
const toggleCache = new WeakMap<Text, Map<string, boolean>>();
function toggleValue(doc: Text, name: string) {
  let toggles = toggleCache.get(doc);
  if (!toggles) {
    toggles = new Map();
    for (const match of doc.toString().matchAll(/^[^%\n]*?\\toggle(true|false)\s*\{([^}]*)\}/gm)) toggles.set(match[2].trim(), match[1] === "true");
    toggleCache.set(doc, toggles);
  }
  return toggles.get(name) ?? false;
}

/** An image path as LaTeX reads it: `\iftoggle{hq}{a.pdf}{b.pdf}` is the branch the toggle chooses. */
function imagePath(path: string, doc: Text) {
  const toggle = /^\\iftoggle\s*\{([^}]*)\}\s*\{([^{}]*)\}\s*\{([^{}]*)\}$/.exec(path.trim());
  return toggle ? (toggleValue(doc, toggle[1].trim()) ? toggle[2] : toggle[3]).trim() : path.trim();
}

/** Names of the document's macros that write table rows or cells (`&`, `\\`), directly or through another one. */
const rowMacroCache = new WeakMap<LatexDefinitions, Set<string>>();
function rowMacroNames(defs: LatexDefinitions) {
  let names = rowMacroCache.get(defs);
  if (names) return names;
  names = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, list] of defs.macros) {
      if (names.has(name)) continue;
      // Cells, row ends, or rules (Mask R-CNN's thick `\shline`, `\noalign{…}\hline\noalign{…}`).
      const writesRows = list.some((macro) => /&|\\\\|\\(?:hline|toprule|midrule|bottomrule|cline|cmidrule|noalign)(?![A-Za-z@])/.test(macro.body) || [...macro.body.matchAll(/\\([A-Za-z@]+)/g)].some((use) => names!.has(use[1])));
      if (writesRows) { names.add(name); changed = true; }
    }
  }
  rowMacroCache.set(defs, names);
  return names;
}

/** Commands that scale or turn what their last argument draws. */
const DRAWING_WRAPPERS = /^\\(?:resizebox\*?|scalebox|rotatebox|reflectbox|raisebox|adjustbox|centerline)$/;
/** A use of a document macro that only sets layout (Mask R-CNN's `\tablestyle{4pt}{1.05}`: a column gap, row stretch and size). */
function layoutMacro(node: SyntaxNode, state: EditorState, defs: LatexDefinitions) {
  const ctrl = node.firstChild;
  const name = ctrl ? /^\\([A-Za-z@]+)$/.exec(read(state, ctrl.from, ctrl.to))?.[1] : undefined;
  if (!name || !macroAt(defs, name, node.from)) return false;
  const use = expandLatexMacroUse(read(state, node.from, Math.min(state.doc.length, node.from + 400)), defs, { mode: "text", pos: node.from });
  return !!use && layoutOnly(use.text);
}

/** Whether LaTeX is only layout a float may hold: lengths, `\renewcommand{\arraystretch}{…}`, sizes, `\centering`, space. */
function layoutOnly(text: string) {
  return !text
    .replace(/%[^\n]*/g, "")
    .replace(/\\(?:setlength|addtolength)\s*\{[^{}]*\}\s*\{[^{}]*\}/g, "")
    .replace(/\\(?:renewcommand\s*\{?\s*\\arraystretch\s*\}?|def\s*\\arraystretch)\s*\{[^{}]*\}/g, "")
    .replace(/\\(?:fontsize\s*\{[^{}]*\}\s*\{[^{}]*\}|[hv]space\*?\s*\{[^{}]*\})/g, "")
    .replace(/\\([A-Za-z@]+)(?![A-Za-z@])/g, (whole, name: string) => (FIGURE_LAYOUT.test(`\\${name}`) || SIZE_COMMAND.test(`\\${name}`) ? "" : whole))
    .trim();
}

/** `\begin{small} \begin{tabular}…` in a float: a size, around the content. */
const SIZE_ENVIRONMENTS = new Set(["tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge", "Huge"]);

/**
 * A wrapper's last argument holds only what a float draws: drawings (`\input`, `\includestandalone`,
 * `\includegraphics`, a TikZ picture), tabulars (`\resizebox{\linewidth}{!}{\begin{tabular}…}`), and layout.
 */
function drawingOnly(command: SyntaxNode, state: EditorState, panel?: (sub: SyntaxNode) => boolean, defs?: LatexDefinitions, notesFrom = Number.POSITIVE_INFINITY) {
  const argument = command.getChildren("TextArgument").at(-1);
  const inner = argument && argumentInner(argument);
  if (!argument || !inner) return false;
  const readState = (from: number, to: number) => read(state, from, to);
  let only = true;
  argument.cursor().iterate((ref) => {
    if (!only || ref.from < inner.from && ref.to <= inner.from) return false;
    const name = ref.name;
    // The float's notes, scaled with its table (the minimum-wage paper's `\resizebox{…}{!}{\begin{threeparttable}…
    // \begin{tablenotes}…}`): drawn under it.
    if (ref.from >= notesFrom) return false;
    if (name === "BeginEnv" || name === "EndEnv") return false;
    if (name === "TextArgument" || name === "LongArg" || name === "Text" || name === "Content" || name === "Command" || name === "KnownCommand" || name === "KnownCtrlSym" || name === "KnownEnvironment" || name === "OpenBrace" || name === "CloseBrace" || name === "Group") return undefined;
    if (SKIPPED.has(name) || name === "Whitespace" || name === "NewLine" || name === "LineBreak" || name === "Input" || name === "Include" || name === "IncludeGraphics" || name === "Centering") return false;
    if (isTabular(ref.node, readState)) return false;
    if (name === "Normal") { if (read(state, ref.from, ref.to).trim()) only = false; return false; }
    if (name === "UnknownCommand") {
      const ctrl = ref.node.firstChild;
      const text = ctrl ? read(state, ctrl.from, ctrl.to) : "";
      if (text === "\\includestandalone" || FIGURE_LAYOUT.test(text) || SIZE_COMMAND.test(text)) return false;
      if (DRAWING_WRAPPERS.test(text)) { if (!drawingOnly(ref.node, state, panel, defs)) only = false; return false; }
      // A document macro that only sets layout (`\tablestyle{2pt}{1.1}` before the tabular).
      if (defs && layoutMacro(ref.node, state, defs)) return false;
      // `\subfigure[…]{…}` in a float's wrapper: a panel, checked by the float.
      if (panel && isSubFloatCommand(ref.node, readState)) { if (!panel(ref.node)) only = false; return false; }
      only = false;
      return false;
    }
    // Sub-figures in a float's wrapper are panels: the float checks them.
    if (panel && isSubFloat(ref.node, readState)) { if (!panel(ref.node)) only = false; return false; }
    if (name === "Environment" || name === "KnownEnvironment") {
      const env = environmentName(ref.node, readState);
      if (env === "tikzpicture" || DIAGRAM_ENVIRONMENTS[env ?? ""]) return false;
      if (env === "center" || env === "adjustbox" || env === "threeparttable" || env === "ThreePartTable" || SIZE_ENVIRONMENTS.has(env ?? "")) return undefined;
      only = false;
      return false;
    }
    only = false;
    return false;
  });
  return only;
}

/** What ends a float's content: a grid, a drawing, an image, an included file or a caption. */
const FLOAT_CONTENT_END = /\\end\s*\{(?:tabular\*?|tabularx|tabulary|longtable|xltabular|algorithmic|tikzpicture|overpic|subfigure|subtable|adjustbox|tikzcd|quantikz|circuitikz|pchstack|pcvstack|tcolorbox|mdframed)\}|\\\]|\\includegraphics\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}|\\(?:input|include|includestandalone|c?tikzfig)\s*\{[^{}]*\}|\\caption(?:of|above|below|aboveof|belowof)?\*?\s*(?:\[[^\]]*\])?\s*\{/g;

/**
 * Where a float's notes start: after its last grid, image, included file or caption. Text from there to the end is the
 * notes applied economics puts under its tables and figures; infinity when the float has no such content.
 */
function floatNotesStart(node: SyntaxNode, state: EditorState) {
  const begin = node.getChild("BeginEnv");
  const end = node.getChild("EndEnv");
  if (!begin || !end) return Number.POSITIVE_INFINITY;
  const text = read(state, begin.to, end.from);
  let last = -1;
  for (const match of text.matchAll(FLOAT_CONTENT_END)) {
    let stop = (match.index ?? 0) + match[0].length;
    // A caption ends with its argument's closing brace.
    if (match[0].endsWith("{") && /^\\caption/.test(match[0])) {
      let group = readGroup(text, stop - 1, TEX_GROUPS);
      // `\captionof{figure}{…}`: its text is the second group.
      const next = group && /^\\captionof/.test(match[0]) ? /^\s*\{/.exec(text.slice(group.end)) : null;
      if (group && next) group = readGroup(text, group.end + next[0].length - 1, TEX_GROUPS);
      if (!group) return Number.POSITIVE_INFINITY;
      stop = group.end;
    }
    last = Math.max(last, stop);
  }
  // The document's own boxes (`\newtcolorbox{prompt}`) are content too.
  const boxes = boxEnvironments(state.doc);
  if (boxes.size > 2) for (const match of text.matchAll(/\\end\s*\{([^{}]+)\}/g)) if (boxes.has(match[1].trim())) last = Math.max(last, (match.index ?? 0) + match[0].length);
  return last < 0 ? Number.POSITIVE_INFINITY : begin.to + last;
}

/**
 * Notes written between a float's content and a caption at its end (a table, then `\par\vspace{2mm} Notes: …`, then
 * `\caption{…}`): their range, drawn as notes under the caption; null when there is no text there.
 */
function notesBeforeCaption(node: SyntaxNode, state: EditorState) {
  const begin = node.getChild("BeginEnv");
  const end = node.getChild("EndEnv");
  if (!begin || !end) return null;
  const text = read(state, begin.to, end.from);
  let content = -1;
  const captions: number[] = [];
  for (const match of text.matchAll(FLOAT_CONTENT_END)) {
    if (/^\\caption/.test(match[0])) captions.push(match.index ?? 0);
    else content = Math.max(content, (match.index ?? 0) + match[0].length);
  }
  const caption = captions.find((at) => at >= content);
  if (content < 0 || caption === undefined || captions.some((at) => at < content)) return null;
  const range = { from: begin.to + content, to: begin.to + caption };
  // Words, not only commands (`\includegraphics{a}\foo\caption{C}` holds something the widget does not draw).
  const notes = floatNotes(node, state, range);
  return notes && /[A-Za-z]{2}/.test(notes.replace(/\\[A-Za-z@]+/g, "")) ? range : null;
}

/** Commands in a float's notes whose group is not note text. */
const NOTE_GROUPS = /\\(?:subcaption\*|Description|captionsetup)\s*(?:\[[^\]]*\]\s*)?\{/;

/** The notes of a float as text to draw: what follows its content, without layout, labels and environment markup; null when nothing is left. */
function floatNotes(node: SyntaxNode, state: EditorState, range?: { from: number; to: number }) {
  const from = range?.from ?? floatNotesStart(node, state);
  const to = range?.to ?? node.getChild("EndEnv")?.from;
  if (!Number.isFinite(from) || to === undefined || from >= to) return null;
  let text = stripTexComments(read(state, from, to));
  // A `\subcaption*{…}` note is drawn as one already; acmart's `\Description{…}` (a screen reader's text) and
  // `\captionsetup{…}` print nothing.
  for (let at = text.search(NOTE_GROUPS); at >= 0; at = text.search(NOTE_GROUPS)) {
    const group = readGroup(text, text.indexOf("{", at), TEX_GROUPS);
    if (!group) break;
    text = text.slice(0, at) + text.slice(group.end);
  }
  text = text
    // Labels a `picture` puts over the images (an overlay, noted as one).
    .replace(/\\begin\s*\{picture\}[\s\S]*?\\end\s*\{picture\}/g, " ")
    .replace(/\\(?:singlespace|onehalfspace|doublespace|singlespacing|onehalfspacing|doublespacing)(?![A-Za-z@])/g, " ")
    .replace(/\\label\s*\{[^{}]*\}/g, "")
    .replace(/\\(?:begin|end)\s*\{(?:tablenotes|threeparttable|ThreePartTable|singlespace|onehalfspace|doublespace|spacing|minipage|footnotesize|small|scriptsize|flushleft|center|justify|adjustbox)\}(?:\s*\[[^\]]*\])?(?:\s*\{[^{}]*\})?/g, " ")
    .replace(/\\(?:vspace|hspace)\*?\s*\{[^{}]*\}|\\rule\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{[^{}]*\}|\\setlength\s*\{?\\[A-Za-z@]+\}?\s*\{[^{}]*\}/g, " ")
    .replace(/\\floatfoot\s*\{/g, "{")
    .replace(/\\item\s*\[([^\]]*)\]/g, " $1 ")
    .replace(/\\item(?![A-Za-z@])/g, " ")
    .replace(/\\(?:par|bigskip|medskip|smallskip|noindent|centering|justifying|raggedright|raggedleft|footnotesize|small|scriptsize|linebreak|newline|vfill|hfill)(?![A-Za-z@])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // The close of a group opened before the notes (`\resizebox{…}{!}{\begin{threeparttable}…\end{tablenotes}…}`).
  text = unbalancedBraces(text).trim();
  return text && !/^[{}\s]*$/.test(text) ? text : null;
}

/** Text without the braces that close a group it did not open, nor those it leaves open. */
function unbalancedBraces(text: string) {
  const unmatched = new Set<number>();
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "{") open.push(i);
    else if (text[i] === "}") { if (open.length) open.pop(); else unmatched.add(i); }
  }
  for (const at of open) unmatched.add(at);
  return unmatched.size ? text.split("").filter((_, at) => !unmatched.has(at)).join("") : text;
}

/** The group after a starred command at `at` (`\subcaption*{…}`): its text and where it ends; null without one. */
function starredNote(state: EditorState, at: number) {
  const after = read(state, at, Math.min(state.doc.length, at + 6000));
  const open = /^\*\s*\{/.exec(after);
  const group = open ? readGroup(after, open[0].length - 1, TEX_GROUPS) : null;
  return group ? { text: group.content.trim(), end: at + group.end } : null;
}

/** The group after `at` (floatrow's `\floatfoot{…}`): its text and where it ends; null without one. */
function groupAfter(state: EditorState, at: number) {
  const after = read(state, at, Math.min(state.doc.length, at + 6000));
  const open = /^\s*\{/.exec(after);
  const group = open ? readGroup(after, open[0].length - 1, TEX_GROUPS) : null;
  return group ? { text: group.content.trim(), end: at + group.end } : null;
}

/** What an algorithm float's prose may hold: text, formulas, styles, citations and references. */
const PROSE_NODES = new Set([
  "Normal", "Text", "Whitespace", "NewLine", "BlankLine", "Tilde", "DollarMath", "ParenMath", "InlineMath", "Math", "Dollar",
  "TextBoldCommand", "TextItalicCommand", "EmphasisCommand", "TextTeletypeCommand", "TextSmallCapsCommand", "Cite", "Ref", "UrlCommand", "HrefCommand",
]);

/**
 * Where an algorithm float's `algorithmic` starts (prose before it is drawn above the lines), or -1 when the float is
 * not an algorithm with algorithmic lines.
 */
function algorithmProseLimit(node: SyntaxNode, state: EditorState) {
  if (!/^algorithm\*?$/.test(environmentName(node, (from, to) => read(state, from, to)) ?? "")) return -1;
  const match = /\\begin\s*\{algorithmic\}/.exec(read(state, node.from, node.to));
  return match ? node.from + match.index : -1;
}

/**
 * An algorithm float's prose before its lines, as it reads: without the caption, labels, layout commands and comments;
 * null when there is none.
 */
function algorithmIntro(node: SyntaxNode, state: EditorState) {
  const limit = algorithmProseLimit(node, state);
  const begin = node.getChild("BeginEnv");
  if (limit < 0 || !begin) return null;
  let text = stripTexComments(read(state, begin.to, limit));
  // The caption with its (balanced) argument, and the labels.
  text = text.replace(/\\caption\*?\s*(?:\[[^\]]*\])?\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, "").replace(/\\label\s*\{[^{}]*\}/g, "");
  text = text.replace(/\\(?:vspace|hspace)\*?\s*\{[^{}]*\}|\\(?:justify|justifying|centering|raggedright|raggedleft|noindent|par|small|footnotesize|scriptsize|medskip|smallskip|bigskip)(?![A-Za-z@])/g, "");
  return text.trim() ? text.trim() : null;
}

/** A float's or panel's content as read, with where each part is (to split a float with several captions). */
type Collected = FigureContent & {
  firstContent: number;
  places: { images: number[]; drawings: number[]; captions: Array<{ pos: number; text: string; captionPos: number }> };
};

/**
 * A float with several captions and no minipages (two tables in one `table`): one part per
 * caption, with the content on its side. Captions above their content (the first caption
 * comes first) take what follows them; captions below take what comes before. The first
 * caption is numbered at the float, the others at themselves (numbering.ts).
 */
function captionSegments(own: Collected, floatFrom: number): FigureContent[] {
  const captions = own.places.captions;
  const starts = [...own.places.images, ...own.places.drawings, ...(own.tabulars ?? []).map((tabular) => tabular.offset)];
  const above = captions[0].pos < Math.min(...starts);
  // Each part's range: [this caption, next caption) above, (previous caption, this caption] below.
  const range = (index: number) => above
    ? { from: index === 0 ? -Infinity : captions[index].pos, to: index + 1 < captions.length ? captions[index + 1].pos : Infinity }
    : { from: index === 0 ? -Infinity : captions[index - 1].pos + 1, to: index + 1 < captions.length ? captions[index].pos + 1 : Infinity };
  return captions.map((caption, index) => {
    const { from, to } = range(index);
    const inside = (pos: number) => pos >= from && pos < to;
    const tabulars = (own.tabulars ?? []).filter((tabular) => inside(tabular.offset));
    const drawings = own.drawings?.filter((_, at) => inside(own.places.drawings[at])) ?? [];
    return {
      images: own.images.filter((_, at) => inside(own.places.images[at])),
      tabulars: tabulars.length ? tabulars : undefined,
      drawings: drawings.length ? drawings : undefined,
      caption: caption.text,
      captionPos: caption.captionPos,
      captionAbove: above,
      kind: own.kind,
      numberOffset: index === 0 ? own.numberOffset : caption.pos - floatFrom,
    };
  });
}

/**
 * What a float shows: its images, drawings, tabulars or algorithm, and its
 * caption; with side-by-side minipages, each panel's own. Numbers are looked
 * up where numbering records them: at the float, at a minipage panel, at an
 * algorithm, or at a `\captionof` outside a panel.
 */
function figureSpec(node: SyntaxNode, env: string, state: EditorState, defs: LatexDefinitions, expand: (text: string) => string | null, captionMacro: (use: SyntaxNode) => string | null, kind: FigureContent["kind"]): FigureSpec | null {
  if (!figureCovered(node, state, defs, captionMacro)) return null;
  const readState = (from: number, to: number) => read(state, from, to);
  const algorithm2e = algorithm2eSpec(node, state, defs);
  const isPanel = (candidate: SyntaxNode) => (candidate.name === "Environment" && environmentName(candidate, readState) === "minipage") || isSubFloat(candidate, readState) || isSubFloatCommand(candidate, readState);
  let valid = true;
  const notesFrom = floatNotesStart(node, state);
  const notesBefore = notesBeforeCaption(node, state);

  /** The content of a float or panel at `root`, leaving out the panels inside it (`skipPanels`). */
  const collect = (root: SyntaxNode, defaultKind: FigureContent["kind"], skipPanels: boolean): Collected => {
    const content: Collected = {
      images: [], tabulars: [], drawings: [], caption: null, captionPos: root.from, kind: defaultKind, numberOffset: 0, firstContent: Number.MAX_SAFE_INTEGER,
      places: { images: [], drawings: [], captions: [] },
    };
    let numberAt = root.from;
    const panelRoot = isPanel(root);
    // A sub-figure's caption is lettered, "(a)", numbered at it.
    if (isSubFloat(root, readState)) {
      content.sub = true;
      content.kind = environmentName(root, readState) === "subtable" ? "table" : "figure";
    }
    // `\subfigure[caption]{…}`: the caption is in brackets (below the content); none without them.
    const subCommand = isSubFloatCommand(root, readState);
    if (subCommand) {
      content.sub = true;
      content.kind = defaultKind === "table" ? "table" : "figure";
      const bracket = root.getChild("OptionalArgument");
      const inner = bracket && argumentInner(bracket);
      if (bracket) { content.caption = inner ? read(state, inner.from, inner.to) : ""; content.captionPos = inner?.from ?? bracket.from; }
    }
    const found = (at: number) => { content.firstContent = Math.min(content.firstContent, at); };
    root.cursor().iterate((ref) => {
      const name = ref.name;
      if (name === "Comment") return false;
      // A panel is content of its own: the float's caption after the panels is below them.
      if (ref.from !== root.from && skipPanels && isPanel(ref.node)) { found(ref.from); return false; }
      if (name === "UnknownCommand") {
        const ctrl = ref.node.firstChild;
        const command = ctrl ? read(state, ctrl.from, ctrl.to) : "";
        if (CAPTION_OF.test(command)) {
          // `\captionof{table}{…}`: a caption of the kind it names; numbered at its panel, or where it is.
          const args = ref.node.getChildren("TextArgument");
          const type = args[0] && argumentInner(args[0]);
          const text = args[1] && argumentInner(args[1]);
          const named = type ? FLOAT_KINDS[read(state, type.from, type.to).trim()] : undefined;
          if (named && text) {
            content.kind = named;
            content.caption = read(state, text.from, text.to);
            content.captionPos = text.from;
            numberAt = panelRoot ? root.from : ref.from;
          }
          return false;
        }
        // KOMA-Script's `\captionabove{…}` and `\captionbelow[short]{…}`: the float's caption, as `\caption`'s (below).
        if (KOMA_CAPTION.test(command)) {
          for (let parent = ref.node.parent; parent && parent.from !== root.from; parent = parent.parent) if (parent.name === "FigureEnvironment" || parent.name === "TableEnvironment") return false;
          const argument = ref.node.getChildren("TextArgument").at(-1);
          const inner = argument && argumentInner(argument);
          if (inner) {
            content.caption = read(state, inner.from, inner.to);
            content.captionPos = inner.from;
            content.places.captions.push({ pos: ref.from, text: content.caption, captionPos: inner.from });
          }
          return false;
        }
        const written = captionMacro(ref.node);
        if (written !== null) { content.caption = written; content.captionPos = ref.from; return false; }
        // `\subcaption*{Notes: …}`: a note under the caption (its group may follow the command outside its node).
        if (command === "\\subcaption" && ctrl && read(state, ctrl.to, ctrl.to + 1) === "*") {
          const note = starredNote(state, ctrl.to);
          if (note) (content.notes ??= []).push(note.text);
          return false;
        }
        if (command === "\\includestandalone") {
          const argument = ref.node.getChild("TextArgument");
          const inner = argument && argumentInner(argument);
          if (inner) { content.drawings!.push(read(state, inner.from, inner.to).trim()); content.places.drawings.push(ref.from); }
          found(ref.from);
          return false;
        }
        const diagram = diagramDrawing(ref.node, state);
        if (diagram) { content.drawings!.push(diagram); content.places.drawings.push(ref.from); found(ref.from); return false; }
        // floatrow's `\floatfoot{…}` before the caption (one after the content is read with the notes).
        if (command === "\\floatfoot" && ctrl && ref.from < notesFrom && !(notesBefore && ref.from >= notesBefore.from && ref.from < notesBefore.to)) {
          const note = groupAfter(state, ctrl.to);
          if (note) (content.notes ??= []).push(note.text);
          return false;
        }
        return undefined;
      }
      if (name === "Input" || name === "Include") {
        const argument = ref.node.getChild(name === "Input" ? "InputArgument" : "IncludeArgument");
        const inner = argument && argumentInner(argument.getChild("FilePathArgument") ?? argument);
        content.drawings!.push(inner ? read(state, inner.from, inner.to).trim() : "");
        content.places.drawings.push(ref.from);
        found(ref.from);
        return false;
      }
      const formula = mathDrawing(ref.node, state);
      if (formula) { content.drawings!.push(formula); content.places.drawings.push(ref.from); found(ref.from); return false; }
      if ((name === "Environment" || name === "KnownEnvironment") && !isTabular(ref.node, readState)) {
        const envName = environmentName(ref.node, readState) ?? "";
        if (envName === "tikzpicture") { content.drawings!.push(""); content.places.drawings.push(ref.from); found(ref.from); return false; }
        if (DIAGRAM_ENVIRONMENTS[envName]) { content.drawings!.push(`diagram:${DIAGRAM_ENVIRONMENTS[envName]}`); content.places.drawings.push(ref.from); found(ref.from); return false; }
        // Labels a `picture` puts over the images: drawn in the PDF only, noted as an overlay.
        if (envName === "picture") { content.overlay = true; return false; }
        // A box (`tcolorbox`, `mdframed`, the document's `\newtcolorbox`): its title and text, in a frame.
        const box = boxUse(ref.node, state);
        const boxContent = ref.node.getChild("EndEnv");
        if (box && boxContent) {
          (content.boxes ??= []).push({ title: box.title, body: read(state, box.end, boxContent.from).trim() });
          found(ref.from);
          return false;
        }
        // overpic's `\begin{overpic}[width=…]{file}`: the image (what it puts over it is drawn in the PDF).
        if (envName === "overpic") {
          const head = /^\\begin\s*\{overpic\}\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/.exec(read(state, ref.from, Math.min(ref.to, ref.from + 500)));
          if (head) {
            content.images.push({ path: imagePath(head[2], state.doc), width: graphicsWidth(head[1] ?? null) });
            content.places.images.push(ref.from);
            if (/\\put\s*\(/.test(read(state, ref.from + head[0].length, ref.to))) content.overlay = true;
          } else valid = false;
          found(ref.from);
          return false;
        }
        if (envName === "algorithmic") {
          const algorithm = algorithmicSpec(ref.node, state, defs);
          if (algorithm) content.algorithm = algorithm; else valid = false;
          found(ref.from);
          return false;
        }
        // An algorithm float (inside a minipage, or the float itself): its caption numbers an algorithm, at it.
        if (envName === "algorithm" || envName === "algorithm*") { content.kind = "algorithm"; numberAt = ref.from; }
        return undefined;
      }
      if (name === "IncludeGraphics") {
        const argument = ref.node.getChild("IncludeGraphicsArgument")?.getChild("FilePathArgument") ?? ref.node.getChild("IncludeGraphicsArgument");
        const inner = argument && argumentInner(argument);
        const options = ref.node.getChild("OptionalArgument");
        const optionsRange = options && argumentInner(options);
        if (inner) {
          content.images.push({ path: imagePath(read(state, inner.from, inner.to), state.doc), width: graphicsWidth(optionsRange ? read(state, optionsRange.from, optionsRange.to) : null) });
          content.places.images.push(ref.from);
        }
        found(ref.from);
        return false;
      }
      if (isTabular(ref.node, readState)) {
        const source = read(state, ref.from, ref.to);
        // A longtable is shown as source (see the TabularEnvironment case): so is its table.
        if (/^\\begin\s*\{(?:longtable|xltabular)\*?\}/.test(source)) valid = false;
        else {
          // Rows written through the document's macros are drawn from their expansion (read-only).
          const built = macroBuiltTabular(source, expand, defs.columnTypes);
          const tabular = built ? { source: built, offset: ref.from, readOnly: true } : { source, offset: ref.from };
          if (!parseTabular(tabular.source, 0, defs.columnTypes)?.rows.length) valid = false;
          content.tabulars!.push(tabular);
        }
        found(ref.from);
        return false;
      }
      if (name === "Caption") {
        // A sub-figure's caption is not the figure's.
        for (let parent = ref.node.parent; parent && parent.from !== root.from; parent = parent.parent) if (parent.name === "FigureEnvironment" || parent.name === "TableEnvironment") return false;
        const argument = ref.node.getChild("TextArgument");
        const inner = argument && argumentInner(argument);
        // `\caption*{…}` is a caption without a number; beside a numbered one (`\caption{…}` then `\captionsetup{…}
        // \caption*{Notes: …}`, the HANK paper's `\fignote`), a note under it.
        const starred = read(state, ref.from, ref.from + 9) === "\\caption*";
        if (inner && starred && content.caption !== null) { (content.notes ??= []).push(read(state, inner.from, inner.to)); return false; }
        if (inner && !starred && content.unnumbered && content.caption !== null) (content.notes ??= []).unshift(content.caption);
        if (inner) {
          content.caption = read(state, inner.from, inner.to);
          content.captionPos = inner.from;
          content.unnumbered = starred || undefined;
          if (!starred) content.places.captions.push({ pos: ref.from, text: content.caption, captionPos: inner.from });
        }
        return false;
      }
      return undefined;
    });
    content.numberOffset = numberAt - node.from;
    content.captionAbove = !subCommand && content.caption !== null && content.captionPos < content.firstContent;
    // algorithm2e sets its caption on top in the ruled styles and below otherwise, wherever it is written.
    if (algorithm2e && root === node) {
      content.algorithm = algorithm2e.algorithm;
      content.kind = "algorithm";
      content.captionAbove = content.caption !== null && algorithm2e.ruled;
    }
    if (!content.tabulars!.length) content.tabulars = undefined;
    if (!content.drawings!.length) content.drawings = undefined;
    if (root === node && content.algorithm) {
      const intro = algorithmIntro(node, state);
      if (intro) content.intro = intro;
    }
    if (root === node) {
      const notes = floatNotes(node, state);
      const before = notesBefore && floatNotes(node, state, notesBefore);
      if (before) content.notes = [...(content.notes ?? []), before];
      if (notes) content.notes = [...(content.notes ?? []), notes];
    }
    return content;
  };

  const panels: SyntaxNode[] = [];
  node.cursor().iterate((ref) => {
    if (ref.from === node.from) return undefined;
    if (ref.name === "Comment") return false;
    if (isPanel(ref.node)) { panels.push(ref.node); return false; }
    return undefined;
  });
  const own = collect(node, kind, true);
  const parts = panels.map((panel) => collect(panel, kind, false));
  if (!valid) return null;
  const empty = (part: FigureContent) => !part.images.length && !part.tabulars && !part.drawings && !part.algorithm && !part.boxes && part.caption === null;
  if (empty(own) && parts.every(empty)) return null;
  const strip = (part: Collected): FigureContent => {
    const { firstContent, places, ...content } = part;
    void firstContent;
    void places;
    return content;
  };
  // Two tables (or figures) in one float, each with its own caption: one part per caption, stacked.
  const segments = !parts.length && own.places.captions.length > 1 ? captionSegments(own, node.from) : null;
  return {
    ...strip(own),
    ...(segments ? { caption: null, images: [], tabulars: undefined, drawings: undefined } : {}),
    env,
    start: node.from,
    base: [own, ...parts].some((part) => part.images.length) ? graphicsBase(state) : undefined,
    length: node.to - node.from,
    panels: segments ?? (parts.length ? parts.map(strip) : undefined),
    stacked: segments ? true : undefined,
  };
}

/**
 * A teaser figure set without a float after `\maketitle` in `\twocolumn[{…}]` (CVPR's, Depth Anything's): `\begin{center}`,
 * images, `\captionsetup{type=figure}`, space, a `\captionof{figure}{…}` and a label, read from `text` (the grammar does
 * not read environments in an optional argument). Offsets are in `text`; null when it holds anything else.
 */
function teaserFigure(text: string) {
  // Comments blanked out, keeping offsets.
  const blank = text.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (comment, before: string, slashes: string) => before + slashes + " ".repeat(comment.length - before.length - slashes.length));
  const title = /\\maketitle(?![A-Za-z@])\s*/.exec(blank);
  const from = title ? (title.index ?? 0) + title[0].length : /^\s*/.exec(blank)![0].length;
  let rest = blank.slice(from);
  const images: Array<{ path: string; width?: string }> = [];
  let caption: { text: string; at: number; kind: FigureContent["kind"] } | null = null;
  const captionof = /\\captionof\s*\{\s*(figure|table)\s*\}\s*\{/.exec(rest);
  if (captionof) {
    const open = (captionof.index ?? 0) + captionof[0].length - 1;
    const group = readGroup(rest, open, TEX_GROUPS);
    if (!group) return null;
    caption = { text: group.content, at: from + (captionof.index ?? 0), kind: FLOAT_KINDS[captionof[1]] ?? "figure" };
    rest = rest.slice(0, captionof.index) + rest.slice(group.end);
  }
  rest = rest.replace(/\\includegraphics\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/g, (_, options: string | undefined, path: string) => { images.push({ path: path.trim(), width: graphicsWidth(options ?? null) }); return " "; });
  const left = rest
    .replace(/\\(?:begin|end)\s*\{center\}|\\(?:captionsetup|label)\s*\{[^{}]*\}|\\[vh]space\*?\s*\{[^{}]*\}|\\\\(?:\[[^\]]*\])?|\\(?:centering|par|noindent|hfill|medskip|smallskip|bigskip)(?![A-Za-z@])/g, " ")
    .trim();
  return !left && caption && images.length ? { from, images, caption } : null;
}

/** `\title`, `\author` and `\date` from the document, for `\maketitle`. */
const titleCache = new WeakMap<Text, Map<number, ReturnType<typeof scanTitleParts>>>();

/** `\title`, `\author` and `\date` before a `\maketitle` at `pos` (cached per document version). */
function readTitleParts(state: EditorState, pos: number, documentClass: string | null) {
  let byPos = titleCache.get(state.doc);
  if (!byPos) titleCache.set(state.doc, byPos = new Map());
  let parts = byPos.get(pos);
  if (!parts) byPos.set(pos, parts = scanTitleParts(state.doc.sliceString(0, Math.min(pos, 120_000)), documentClass));
  return parts;
}

/** What imsart's and elsarticle's front matter may hold before the abstract: the title block's commands. */
const FRONT_MATTER_COMMANDS = /^(?:title|runtitle|subtitle|author|runauthor|address|affiliation|affil|printead|ead|thanksref|thankstext|thanks|tnoteref|tnotetext|corref|cortext|fnref|fntext|date|dedicated|received|accepted|support|orcid|email|and|AND|thanksmark|dedicatory)$/;

/** An author written with imsart's name parts (`\fnms{Susan} \snm{Athey}\ead[label=e1]{…}`), as the name it prints. */
function frontMatterAuthor(author: string) {
  return author
    .replace(/\\(?:fnms|snm|bnms|particle|suffix)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:ead|thanksref|corref|fnref|thanksmark|orcid|inst|tnoteref)\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, "")
    .replace(/\s+/g, " ").trim();
}

/** The title block a `frontmatter` environment's commands give, or null when it holds anything else. */
function frontMatterParts(text: string): { title: string | null; author: string | null; date: string | null } | null {
  const source = stripTexComments(text);
  let title: string | null = null;
  let date: string | null = null;
  const authors: string[] = [];
  let i = 0;
  while (i < source.length) {
    const space = /^\s+/.exec(source.slice(i, i + 200));
    if (space) { i += space[0].length; continue; }
    const command = /^\\([A-Za-z@]+)\*?/.exec(source.slice(i, i + 60));
    if (!command || !FRONT_MATTER_COMMANDS.test(command[1])) return null;
    i += command[0].length;
    const args: string[] = [];
    for (;;) {
      let at = i;
      while (at < source.length && /[ \t]/.test(source[at])) at++;
      if (source[at] === "\n" && !/^\n[ \t]*\n/.test(source.slice(at, at + 40))) { at++; while (at < source.length && /[ \t]/.test(source[at])) at++; }
      if (source[at] === "[") { const optional = readOptional(source, at, TEX_GROUPS); if (!optional) return null; i = optional.end; continue; }
      if (source[at] === "{") { const group = readGroup(source, at, TEX_GROUPS); if (!group) return null; args.push(group.content); i = group.end; continue; }
      break;
    }
    if (command[1] === "title") title = args.at(-1) ?? title;
    else if (command[1] === "author") authors.push(frontMatterAuthor(args.at(-1) ?? ""));
    else if (command[1] === "date") date = args.at(-1) ?? date;
  }
  if (title === null && !authors.length) return null;
  return { title, author: authors.length ? authors.join(" \\and ") : null, date };
}

/** ICML's title block in `\twocolumn[…]`: the title, and each author with their affiliations' names; null when it is not one. */
function icmlTitle(block: string): { title: string | null; author: string | null } | null {
  const title = commandGroups(block, "icmltitle").at(-1) ?? null;
  if (title === null) return null;
  const affiliations = new Map<string, string>();
  for (const match of block.matchAll(/\\icmlaffiliation\s*\{([^{}]*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) affiliations.set(match[1].trim(), match[2].trim());
  const authors = [...block.matchAll(/\\icmlauthor\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{([^{}]*)\}/g)].map((match) => {
    const places = match[2].split(",").map((key) => affiliations.get(key.trim())).filter((place): place is string => !!place);
    return places.length ? `${match[1].trim()} \\\\ {\\small ${places.join("; ")}}` : match[1].trim();
  });
  return { title, author: authors.length ? authors.join(" \\and ") : null };
}

/**
 * What may come right before `\maketitle` and is shown by it: the title block's declarations, and the metadata the
 * classes print small or not at all (acmart's `\ccsdesc`, `\setcopyright`, `\acmConference`; amsart's `\subjclass`).
 */
const TITLE_DECLARATIONS = /^(?:title|subtitle|author|date|thanks|and|AND|affiliation|address|email|institute|inst|keywords|titlerunning|authorrunning|runningtitle|shorttitle|shortauthors|editor|jmlrheading|ShortHeadings|firstpageno|vspace|vskip|smallskip|medskip|bigskip|subjclass|ccsdesc|orcid|additionalaffiliation|authornote|authornotemark|titlenote|subtitlenote|dedicatory|curraddr|urladdr|setcopyright|copyrightyear|acm[A-Z][A-Za-z]*|settopmatter|received|citestyle|Copyright)$/;
/** Definitions among them (acmart's `\renewcommand{\shortauthors}{…}`, a paper's `\newcommand{\gentxt}[1]{…}`): they print nothing. */
const TITLE_DEFINITIONS = /^(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef)$/;
/**
 * Environments among them: an abstract the class prints with the title (acmart's, amsart's), acmart's CCS metadata,
 * and its teaser figure, which is drawn on its own (the title block stops before it).
 */
const TITLE_ENVIRONMENTS = /^(?:abstract|CCSXML|teaserfigure)$/;
/** Classes that print an abstract written before `\maketitle` with the title (amsart: under it; acmart: in the block). */
const ABSTRACT_WITH_TITLE = /^(?:acmart|amsart|amsproc|amsbook|revtex4(?:-[12])?|sn-jnl)$/;

type TitleRun = {
  start: number;
  /** Figures in the run, drawn on their own (acmart's `teaserfigure`). */
  gaps: Array<{ from: number; to: number }>;
  abstract: string | null;
  notes: Array<[string, string]>;
};

/** What `\keywords`, `\subjclass` and `\ccsdesc` add to a title block, as its small lines (label, LaTeX). */
function titleNotes(keywords: string[], subjclass: string[], ccs: string[]): Array<[string, string]> {
  const notes: Array<[string, string]> = [];
  if (ccs.length) notes.push(["CCS Concepts", ccs.map((concept) => concept.replace(/~/g, " → ")).join("; ")]);
  if (keywords.length) notes.push(["Keywords", keywords.join(", ")]);
  if (subjclass.length) notes.push(["Mathematics Subject Classification", subjclass.join("; ")]);
  return notes;
}

/**
 * The run of title declarations that ends `text` (`text` is the body up to `\maketitle`): where it starts, the abstract
 * and notes in it; null when something else comes right before `\maketitle`. Comments and spaces between them are part of the run.
 */
function titleDeclarationsStart(text: string, abstractWithTitle = false): TitleRun | null {
  let run: TitleRun | null = null;
  let keywords: string[] = [];
  let subjclass: string[] = [];
  let ccs: string[] = [];
  let i = 0;
  while (i < text.length) {
    const space = /^\s+/.exec(text.slice(i, i + 400));
    if (space) { i += space[0].length; continue; }
    if (text[i] === "%") { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end + 1; continue; }
    const start = i;
    // `\begin{abstract} … \end{abstract}` and the other environments the run may hold.
    const begin = /^\\begin\s*\{([^{}]*)\}/.exec(text.slice(i, i + 80));
    const env = begin?.[1].trim();
    if (begin && env && TITLE_ENVIRONMENTS.test(env) && (env !== "abstract" || abstractWithTitle)) {
      const close = new RegExp(String.raw`\\end\s*\{${env}\}`).exec(text.slice(i));
      if (close) {
        const end = i + close.index + close[0].length;
        run ??= { start, gaps: [], abstract: null, notes: [] };
        if (env === "teaserfigure") run.gaps.push({ from: start, to: end });
        if (env === "abstract") run.abstract = stripTexComments(text.slice(i + begin[0].length, i + close.index)).trim();
        i = end;
        continue;
      }
    }
    const command = /^\\([A-Za-z@]+)\*?/.exec(text.slice(i, i + 60));
    let end = -1;
    const groups: string[] = [];
    if (command) {
      end = i + command[0].length;
      // A definition's name and parameters (`\newcommand\x[1]{…}`, `\def\x#1{…}`), before its body.
      if (TITLE_DEFINITIONS.test(command[1])) end += /^\s*(?:\\[A-Za-z@]+|\{\s*\\[A-Za-z@]+\s*\})(?:#\d)*/.exec(text.slice(end, end + 80))?.[0].length ?? 0;
      for (;;) {
        const at = end + (/^[ \t]*/.exec(text.slice(end, end + 40))?.[0].length ?? 0);
        const group = text[at] === "[" ? readOptional(text, at, TEX_GROUPS) : text[at] === "{" ? readGroup(text, at, TEX_GROUPS) : null;
        if (!group) break;
        if (text[at] === "{") groups.push(group.content);
        end = group.end;
      }
    }
    if (command && (TITLE_DECLARATIONS.test(command[1]) || TITLE_DEFINITIONS.test(command[1]))) {
      run ??= { start, gaps: [], abstract: null, notes: [] };
      if (command[1] === "keywords" && groups.length) keywords.push(groups.at(-1)!.trim());
      if (command[1] === "subjclass" && groups.length) subjclass.push(groups.at(-1)!.trim());
      if (command[1] === "ccsdesc" && groups.length) ccs.push(groups.at(-1)!.trim());
      i = end;
      continue;
    }
    // Anything else ends the run: the declarations after it may still make one.
    run = null;
    keywords = [];
    subjclass = [];
    ccs = [];
    i = command ? end : i + 1;
  }
  if (run) run.notes = titleNotes(keywords, subjclass, ccs);
  return run;
}

/** Classes where each `\author{…}` adds an author, rather than replacing the last: acmart, the AMS classes, elsarticle, revtex, imsart, LIPIcs. */
const ACCUMULATING_AUTHORS = /^(?:acmart|amsart|amsbook|amsproc|elsarticle|revtex4(?:-[12])?|imsart|sn-jnl|lipics(?:-v20\d\d)?|oasics(?:-v20\d\d)?)$/;
/** LIPIcs' and OASIcs' classes, whose `\author{Name}{Affiliation}{email}{orcid}{funding}` takes five arguments. */
const LIPICS = /^(?:lipics|oasics)(?:-v20\d\d)?$/;

/**
 * LIPIcs' authors (Stein & Samuelson's `\author{Dario {Stein}}{iHub, Radboud University Nijmegen}{dario.stein@ru.nl}{}{}`):
 * each name with its affiliation and email under it, small, as the class prints them.
 */
function lipicsAuthors(text: string) {
  const authors: string[] = [];
  for (const match of text.matchAll(/\\author(?![A-Za-z@])/g)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    if (/(^|[^\\])%/.test(text.slice(lineStart, match.index))) continue;
    const parts: string[] = [];
    for (let at = match.index + match[0].length; parts.length < 5;) {
      const open = /^\s*\{/.exec(text.slice(at, at + 200));
      const group = open ? readGroup(text, at + open[0].length - 1, TEX_GROUPS) : null;
      if (!group) break;
      parts.push(group.content.trim());
      at = group.end;
    }
    if (!parts.length) continue;
    const [name, affiliation, email] = parts;
    authors.push([name, affiliation && `{\\small ${affiliation}}`, email && `{\\small \\texttt{${email}}}`].filter(Boolean).join(" \\\\ "));
  }
  return authors;
}

/** The arguments of every `\command[…]{…}` in `text`, outside comments, in order. */
function commandGroups(text: string, command: string) {
  const pattern = new RegExp(`\\\\${command}(?![A-Za-z@])\\s*(?:\\[[^\\]]*\\])?\\s*\\{`, "g");
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const lineStart = text.lastIndexOf("\n", match.index ?? 0) + 1;
    if (/(^|[^\\])%/.test(text.slice(lineStart, match.index))) continue;
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) { found.push(text.slice(open + 1, i)); break; }
    }
  }
  return found;
}

/**
 * The title block's parts as TeX reads them before `\maketitle` (the preamble is where they almost always are). acmart
 * and its kin add an author with each `\author`; acmart takes the abstract before `\begin{document}` and prints it with
 * the title, so an abstract in the preamble is part of the block.
 */
function scanTitleParts(text: string, documentClass: string | null) {
  const last = (command: string) => commandGroups(text, command).at(-1) ?? null;
  const authors = LIPICS.test(documentClass ?? "") ? lipicsAuthors(text) : commandGroups(text, "author");
  const author = !authors.length ? null : ACCUMULATING_AUTHORS.test(documentClass ?? "") ? authors.join(" \\and ") : authors.at(-1)!;
  const bodyStart = /\\begin\s*\{document\}/.exec(text)?.index ?? -1;
  const abstract = bodyStart > 0 ? /\\begin\s*\{abstract\}([\s\S]*?)\\end\s*\{abstract\}/.exec(stripTexComments(text.slice(0, bodyStart)))?.[1].trim() ?? null : null;
  // Keywords and classifications in the preamble (LIPIcs', acmart's): small lines of the block. Those in the body are
  // the title run's (titleDeclarationsStart), so they are not shown twice.
  // A definition of `\keywords` (`\newcommand\keywords[1]{…}`) is not a use of it.
  const preamble = (bodyStart > 0 ? text.slice(0, bodyStart) : "").replace(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def)\*?\s*\{?\s*\\(?=keywords|subjclass|ccsdesc)/g, "");
  const notes = titleNotes(commandGroups(preamble, "keywords"), commandGroups(preamble, "subjclass"), commandGroups(preamble, "ccsdesc"));
  return { title: last("title"), author, date: last("date"), abstract, notes };
}
