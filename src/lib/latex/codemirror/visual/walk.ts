import type { EditorState, Text } from "@codemirror/state";
import type { WidgetType } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";
import { boxTitleOf, definitionExtentAround, definitionExtentAt, emptyLatexDefinitions, isInLatexComment, macroAt, readBoxDefinitions, type LatexBoxDefinition, type LatexDefinitions } from "../../macros/definitions";
import { expandLatexMacros, expandLatexMacroUse, expandMacroUseWithProvenance, needsMathMode, provenanceOf, readMacroArguments, substituteArguments } from "../../macros/expand";
import { expansionState, placeAtCall } from "./macro-provenance";
import { CAPTION_OF, enumerateItemLabel, enumitemListStart, environmentName, FLOAT_KINDS, JMLR_REF_WORDS, floatKind, KOMA_CAPTION, LIST_CONTINUES, listOptionMap, restatableTheorem, stripTexComments, wrappedTheorem } from "../../macros/numbering";
import { readAlgorithm2eBody, readAlgorithmicBody } from "./algorithm";
import { isPairMacro, itemMacroNames, MATH_ENVIRONMENT, macroEnvironmentRegionAt, macroEnvironmentRegions, macroPassThrough, structureMacroNames, type MacroEnvironmentRegion } from "../../macros/structure";
import { latexParser, OPAQUE_DRAWING_ENVIRONMENTS } from "../latex-parser";
import { countedRows, katexForEnvironment, mathparForKatex, renderKatex } from "./math-render";
import { readSiunitx, SIUNITX_TEXT } from "./siunitx";
import { latexProjectField } from "../editing";
import { disabledField, macroSourcesField, visualConfig } from "./model";
import { citationNoteText, citationNotes, prettyrefText, REFERENCE_IN_MATH, withReferenceNumbers } from "./references";
import { acronymText, argumentInner, CITE_ALIASES, commandArguments, hasDirectError } from "./render-fragment";
import { circledText, CONTROL_SYMBOLS, cssColor, DINGBATS, FONT_SWITCHES, LIGATURE_CHARS, readAccent, SIZE_COMMAND, SYMBOL_COMMANDS, TEXT_LIGATURES, todayText } from "./symbols";
import { macroBuiltTabular, macroRowReadings, parseTabular, readCtable, readDeluxeTable, readLongTable, readTableSettings } from "./table-model";
import { argumentGroups, transparentPlan } from "./transparent";
import { gameTabular } from "./game";
import { FRAMED_PROSE, genericListHead, GENERIC_LISTS, readEnvironmentArguments, tableRuleRun, WRAPPER_ENVIRONMENTS } from "./environments";
import {
  ChipWidget, ColumnsWidget, EnvironmentFooterWidget, EnvironmentHeaderWidget, ExpandedEnvironmentWidget, type ExpandedEnvironmentSpec, type FigureContent, FigureWidget, FootnoteMarkWidget, graphicsBase, HeadingNumberWidget, ImageWidget,
  BiographyHeaderWidget, ExampleMarkerWidget, ItemMarkerWidget, QedMarkWidget, LineBreakWidget, LiteralTextWidget, MacroFootnoteWidget, MacroHeadingWidget, MacroPieceWidget, MacroWidget, MathWidget, PreambleWidget, SymbolWidget, TableWidget, TitleWidget, BibliographyListWidget, type FigureSpec,
  RestatedTheoremWidget, restatablesIn, TodoWidget, type TableExtras,
} from "./widgets";
import { beginDocumentIndex } from "../../document-begin";
import { detailsView, frontMatterDetails, type FrontDetailsView } from "./front-matter";
import { CODE_ENVIRONMENTS, CodeCaptionWidget, CodeFileWidget, codeTokens, ContentsWidget, CounterWidget, documentCounters, inlineCodeRange, IncludeChipWidget, LinkTextWidget, PdfPagesWidget, readCodeHeader, TEXT_WRAPPERS as STYLED_WRAPPERS, TextDrawingWidget } from "./text-commands";

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

/** The accent at the start of `text` (`\'e`, `\c c`) when its letter is on the same line, else null. */
function sameLineAccent(text: string) {
  const accent = readAccent(text);
  return accent && !text.slice(0, accent.length).includes("\n") ? accent : null;
}

export type RevealPolicy = "touch" | "strict" | "line" | "never" | "toggle";

export type Replace = { from: number; to: number; widget?: WidgetType; block?: boolean; side?: number };
export type Mark = { from: number; to: number; class: string; attributes?: Record<string, string> };
export type LineStyle = { from: number; to: number; class: string };

export type Construct = {
  kind: string;
  from: number;
  to: number;
  reveal: RevealPolicy;
  /** "line" policy: with `wholeLine`, the cursor anywhere on the construct's lines reveals it. */
  wholeLine?: boolean;
  replaces: Replace[];
  /** Line classes that apply only while the construct is drawn (collapsed `\begin` lines, a heading's size). */
  hiddenLines?: LineStyle[];
  /** Styles that stay while the source shows (bold text). */
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
/** A `tikzpicture`, `pgfpicture` or `circuitikz`: parsed as opaque text (latex-parser.ts), so it is a drawing and not code. */
const isDrawingVerbatim = (node: SyntaxNode, read: (from: number, to: number) => string) => node.name === "VerbatimEnvironment" && OPAQUE_DRAWING_ENVIRONMENTS.has(environmentName(node, read) ?? "");
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
/** What a float may set for the tabular after it, which its grid draws (`\rowcolors{2}{gray!10}{white}`). */
const TABLE_SETTING = /^\\(?:rowcolors\*?|showrowcolors|hiderowcolors|arrayrulecolor)$/;
/**
 * What a macro's expansion may hold only as TeX programming: building names, appending to macros, global and expanded
 * definitions, box registers, and conditionals other than the `\ifx` of cvpr's `\onedot` (which the renderer reads).
 */
const TEX_PROGRAMMING = /\\(?:expandafter|csname|endcsname|noexpand|g@addto@macro|@for|@ifnextchar|@ifstar|typeout|gdef|xdef|edef|newif|setbox|advance|multiply|divide|ifdefined|ifcsname|ifnum|ifdim|ifcase|if@[A-Za-z@]*|PackageError|PackageWarning|ClassError)(?![A-Za-z@])|\\if(?!x(?![A-Za-z@]))[a-z]{3,}[A-Za-z@]*|\\ifx(?![A-Za-z@])(?!\s*\\@let@token)/;
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
/** linguex's example (`\ex.`, `\exg.` with a gloss, `\exi.`) and part (`\a.`, `\b.`) markers. */
const LINGUEX_MARKER = /^\\(?:ex|exg|exi|a|b)$/;

/** Whether a citation's notes can be printed as text (`[\emph{inter alia}]`); one that cannot leaves the citation source. */
function notesUnderstood(notes: { pre?: string; post?: string }) {
  return [notes.pre, notes.post].every((note) => !note || citationNoteText(note) !== null);
}

const FLOAT_LENGTHS = /^\\(?:tabcolsep|arraycolsep|arrayrulewidth|aboverulesep|belowrulesep|doublerulesep|extrarowheight|abovecaptionskip|belowcaptionskip|textfloatsep|intextsep|columnsep|parskip|parindent)$/;
// A length register alone (`\vskip\baselineskip`, 2610.30364) is glue too.
const GLUE = String.raw`(?:-?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|in|cm|mm|bp|sp|mu|pc|dd|cc|\\[A-Za-z@]+)|-?\s*\\[A-Za-z@]+)`;
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
  else if (/^\\(?:vspace|hspace|addvspace|Needspace|needspace)$/.test(command)) i += /^\s*\{[^{}]*\}/.exec(rest())?.[0].length ?? 0;
  else if (/^\\(?:setlength|addtolength)$/.test(command)) i += /^\s*\\[A-Za-z@]+\s*\{[^{}]*\}/.exec(rest())?.[0].length ?? 0;
  // TeX's line-break hints (bibtex's `50\penalty0 (2):`, `\looseness=-1`) and url's `\urlstyle{same}`: a number ends with the space after it.
  else if (command === "\\penalty") i += /^\s*(?:-?\d+[ \t]*|\\[A-Za-z@]+[ \t]*)/.exec(rest())?.[0].length ?? 0;
  else if (command === "\\looseness") i += /^\s*=?\s*-?\d+[ \t]*/.exec(rest())?.[0].length ?? 0;
  else if (command === "\\urlstyle") i += /^\s*\{[^{}]*\}/.exec(rest())?.[0].length ?? 0;
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
  startcontents: 0, makeatletter: 0, makeatother: 0, protect: 0, relax: 0, vskip: 0, let: 0,
  // AASTeX's `\restartappendixnumbering` and `\startlongtable` print nothing.
  restartappendixnumbering: 0, startlongtable: 0,
  // MNRAS's `\bsp` (a typesetting note on the last page) and its page range and year metadata.
  bsp: 0, pagerange: 1, pubyear: 1,
  tiny: 0, scriptsize: 0, footnotesize: 0, small: 0, normalsize: 0, large: 0, Large: 0, LARGE: 0, huge: 0, Huge: 0,
  vspace: 1, addvspace: 1, setstretch: 1, linespread: 1, thispagestyle: 1, pagestyle: 1, pagenumbering: 1, newgeometry: 1, tikzset: 1, pgfplotsset: 1,
  hypersetup: 1, captionsetup: 1, sisetup: 1, lstset: 1, enlargethispage: 1, hyphenation: 1, ccsdesc: 1,
  setlength: 2, addtolength: 2, colorlet: 2, definecolor: 3, addcontentsline: 3, printcontents: 3, newcommand: 2,
  // State the numbering reads (numbering.ts): `\appendix`, `\setcounter{equation}{0}`, and a counter's format
  // (`\renewcommand{\theequation}{S\arabic{equation}}`, only a `\the…` one). Column and spacing switches, TeX groups.
  // Counters and boxes declared (`\newcounter`, chngcntr's `\counterwithin*`, `\newsavebox`): definitions, which print nothing.
  newcounter: 1, counterwithin: 2, counterwithout: 2, newsavebox: 1,
  // Set-up that prints nothing: numberwithin, cleveref crefalias, zref-clever zcsetup.
  numberwithin: 2, crefalias: 2, zcsetup: 1,
  appendix: 0, setcounter: 2, addtocounter: 2, renewcommand: 2, onecolumn: 0, twocolumn: 0, frenchspacing: 0, nonfrenchspacing: 0,
  // IEEEtran's `\appendices`; counters stepped where they are.
  appendices: 0, stepcounter: 1, refstepcounter: 1,
  // IEEEtran's publication-id and running-head switches, `\nobalance`, `\suppressfloats[t]` and `\appendixpage` (an "Appendices" heading, not drawn): print nothing here.
  IEEEpubidadjcol: 0, IEEEpeerreviewmaketitle: 0, nobalance: 0, suppressfloats: 0, appendixpage: 0,
  begingroup: 0, endgroup: 0,
  // `\eject`, needspace's `\Needspace{16\baselineskip}`, revtex's `\onecolumngrid`/`\twocolumngrid`, `\addtocontents{toc}{…}` and
  // `\AtEndDocument{…}` (run at the end, not here): page-layout lines that print nothing where they stand.
  eject: 0, Needspace: 1, needspace: 1, onecolumngrid: 0, twocolumngrid: 0, addtocontents: 2, AtEndDocument: 1,
  // xcolor's alternating row fills, drawn by the tables after them.
  rowcolors: 3, showrowcolors: 0, hiderowcolors: 0,
  // TeX's own dimension, skip and penalty assignments (`\medmuskip=3mu\relax`, `\relpenalty=10000`): line breaking and
  // spacing only. Each reads its `= value` (see TEX_ASSIGNMENT), not a `{…}`.
  medmuskip: 0, thinmuskip: 0, thickmuskip: 0, relpenalty: 0, binoppenalty: 0, hangindent: 0, hangafter: 0, parindent: 0, parskip: 0,
  baselineskip: 0, lineskip: 0, leftskip: 0, rightskip: 0, parfillskip: 0, tolerance: 0, emergencystretch: 0, hbadness: 0, vbadness: 0,
  widowpenalty: 0, clubpenalty: 0, hyphenpenalty: 0, exhyphenpenalty: 0, tabcolsep: 0, arraycolsep: 0,
  // TikZ/PGF setup that draws nothing (`\usetikzlibrary{calc}`, `\pgfkeys{…}`, `\pgfmathsetlengthmacro{\w}{width("$x$")}`), a float's
  // label (`\floatname{algorithm}{Construction}`), algorithmicx's `\algtext*{EndIf}`, a paragraph's break (`\break`).
  usetikzlibrary: 1, usepgflibrary: 1, pgfkeys: 1, pgfmathsetlengthmacro: 2, pgfmathsetmacro: 2, floatname: 2, algtext: 1,
  fontsize: 2, selectfont: 0, break: 0,
  // More of TeX assignments (itemsep1pt, topsep=0pt, predisplaypenalty=0 followed by relax): see TEX_ASSIGNMENT.
  itemsep: 0, parsep: 0, topsep: 0, partopsep: 0, labelsep: 0, labelwidth: 0, leftmargin: 0, rightmargin: 0, itemindent: 0, listparindent: 0, columnsep: 0, abovedisplayskip: 0, belowdisplayskip: 0,
  abovedisplayshortskip: 0, belowdisplayshortskip: 0, predisplaypenalty: 0, postdisplaypenalty: 0, interlinepenalty: 0, brokenpenalty: 0, displaywidowpenalty: 0, floatingpenalty: 0,
};
/** Setup commands of LAYOUT_LINE_ARGS that print nothing wherever they stand, so they hide even among other things on a line. */
const INLINE_SETUP = /^\\(?:pagenumbering|pagestyle|thispagestyle|fontsize|selectfont|hypersetup|captionsetup|sisetup|lstset|tikzset|pgfplotsset|usetikzlibrary|pgfkeys|floatname)$/;
/** The TeX assignments of LAYOUT_LINE_ARGS that take an `= value` (a glue, a dimension or an integer) rather than a group. */
const TEX_ASSIGNMENT = /^(?:itemsep|parsep|topsep|partopsep|labelsep|labelwidth|leftmargin|rightmargin|itemindent|listparindent|columnsep|abovedisplayskip|belowdisplayskip|abovedisplayshortskip|belowdisplayshortskip|predisplaypenalty|postdisplaypenalty|interlinepenalty|brokenpenalty|displaywidowpenalty|floatingpenalty|predisplaysize|medmuskip|thinmuskip|thickmuskip|relpenalty|binoppenalty|hangindent|hangafter|parindent|parskip|baselineskip|lineskip|leftskip|rightskip|parfillskip|tolerance|emergencystretch|hbadness|vbadness|widowpenalty|clubpenalty|hyphenpenalty|exhyphenpenalty|tabcolsep|arraycolsep)$/;
/** What follows such an assignment's name: an optional `=`, a number with a unit (or none: a penalty), then any `plus`/`minus` glue. */
const TEX_ASSIGNMENT_VALUE = new RegExp(String.raw`^\s*=?\s*-?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:(?:pt|em|ex|in|cm|mm|bp|sp|mu|pc|dd|cc|fil+)(?![A-Za-z]))?(?:\s*(?:plus|minus)\s*-?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|in|cm|mm|bp|sp|mu|pc|dd|cc|fil+)(?![A-Za-z]))*`);
/** A definition's body that writes table rows, cells or rules (`#1 & #2 & #3\\`, `\midrule\multicolumn…`): a row helper. */
const ROW_HELPER_BODY = /&|\\\\|\\(?:hline|toprule|midrule|bottomrule|cline|cmidrule|noalign|addlinespace)(?![A-Za-z@])/;
/** The lists of contents a document prints, by the kind of entry they list. */
const CONTENTS_LISTS: Record<string, "section" | "figure" | "table"> = { "\\tableofcontents": "section", "\\listoffigures": "figure", "\\listoftables": "table" };
/** Layout-line commands whose `[…]` is text, not an option (ICML's `\twocolumn[\icmltitle{…}…]`): such a line stays. */
const LAYOUT_LINE_TEXT_OPTION = /^(?:onecolumn|twocolumn)$/;

/** `\let\c@lemmaL\c@theorem`: LaTeX's internal counter register of one counter made another's (they count together). */
const COUNTER_ALIAS = /^\\let\s*\\c@[A-Za-z@]+\s*=?\s*\\c@[A-Za-z@]+(?![A-Za-z@])/;
/** Where a row helper's definition ends, from `at` (just after `\newcommand`): `{\name}[n]{body}` with table rows, cells or rules in its body; -1 otherwise. */
function rowHelperDefinition(text: string, at: number) {
  const name = /^\s*(?:\{\s*\\[A-Za-z@]+\s*\}|\\[A-Za-z@]+)/.exec(text.slice(at, at + 80));
  if (!name) return -1;
  let i = at + name[0].length;
  for (let open = /^\s*\[/.exec(text.slice(i)); open; open = /^\s*\[/.exec(text.slice(i))) {
    const optional = readOptional(text, i + open[0].length - 1, TEX_GROUPS);
    if (!optional) return -1;
    i = optional.end;
  }
  const open = /^\s*\{/.exec(text.slice(i));
  const body = open ? readGroup(text, i + open[0].length - 1, TEX_GROUPS) : null;
  return body && ROW_HELPER_BODY.test(body.content) ? body.end : -1;
}

/** The lines from `from` (the first thing on its line) that hold only layout commands with their arguments, or null. */
function layoutLine(state: EditorState, from: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(from);
  if (read(state, line.from, from).trim()) return null;
  const i = layoutRun(read(state, from, Math.min(state.doc.length, from + 4000)));
  return i > 0 ? { from: line.from, to: state.doc.lineAt(Math.min(state.doc.length, from + i)).to } : null;
}

/** How much of the start of `text` (one line) is layout commands with their arguments (see LAYOUT_LINE_ARGS); 0 when something else is on the line. */
function layoutRun(text: string, partial = false): number {
  let i = 0;
  for (;;) {
    i += /^[ \t]*/.exec(text.slice(i))![0].length;
    if (i >= text.length || text[i] === "\n" || text[i] === "\r" || text[i] === "%") break;
    const command = /^\\([A-Za-z@]+)\*?/.exec(text.slice(i, i + 60));
    const count = command && Object.hasOwn(LAYOUT_LINE_ARGS, command[1]) ? LAYOUT_LINE_ARGS[command[1]] : undefined;
    if (!command || count === undefined) return partial ? i : 0;
    i += command[0].length;
    if (command[1] === "vskip") { i += PRIMITIVE_GLUE.exec(text.slice(i))?.[0].length ?? 0; continue; }
    // `\let\c@lemmaL\c@theorem`: a counter that shares another's count (numbering.ts reads it); no other `\let`.
    if (command[1] === "let") {
      const alias = COUNTER_ALIAS.exec(text.slice(i - command[0].length, i + 80));
      if (!alias) return 0;
      i += alias[0].length - command[0].length;
      continue;
    }
    if (TEX_ASSIGNMENT.test(command[1])) {
      const value = TEX_ASSIGNMENT_VALUE.exec(text.slice(i));
      if (!value) return 0;
      i += value[0].length;
      continue;
    }
    // A row helper's definition (`\newcommand{\ntrow}[3]{#1 & #2 & #3\\}`): table setup, not text.
    if (/^(?:newcommand|renewcommand)$/.test(command[1])) {
      const helper = rowHelperDefinition(text, i);
      if (helper > 0) { i = helper; continue; }
    }
    // `\renewcommand` of a counter's format (`{\thesection}` or `\thesection`), of `\qedsymbol`, or of the table row height (`\arraystretch`) only.
    if (command[1] === "renewcommand" && !/^\s*(?:\{\s*\\(?:the[A-Za-z]+|qedsymbol|arraystretch)\s*\}|\\(?:the[A-Za-z]+|qedsymbol|arraystretch)(?![A-Za-z]))/.test(text.slice(i, i + 60))) return 0;
    // `\newcommand` is only a layout line as a row helper (above).
    if (command[1] === "newcommand") return 0;
    const optional = /^[ \t]*\[/.exec(text.slice(i));
    if (optional) {
      if (LAYOUT_LINE_TEXT_OPTION.test(command[1])) return 0;
      const group = readOptional(text, i + optional[0].length - 1, TEX_GROUPS);
      if (!group) return 0;
      i = group.end;
    }
    for (let k = 0; k < count; k++) {
      const space = /^\s*/.exec(text.slice(i))![0];
      if (space.includes("\n\n")) return 0;
      const at = i + space.length;
      // `\setlength\parindent{0pt}`: an unbraced length.
      const unbraced = k === 0 && /^(?:setlength|addtolength|renewcommand|newsavebox)$/.test(command[1]) ? /^\\[A-Za-z@]+/.exec(text.slice(at, at + 60)) : null;
      if (unbraced) { i = at + unbraced[0].length; continue; }
      const group = text[at] === "{" ? readGroup(text, at, TEX_GROUPS) : null;
      if (!group) return 0;
      i = group.end;
    }
    // `\newcounter{c}[section]`: the counter it counts within.
    if (command[1] === "newcounter") {
      const within = /^[ \t]*\[/.exec(text.slice(i));
      const group = within ? readOptional(text, i + within[0].length - 1, TEX_GROUPS) : null;
      if (group) i = group.end;
    }
  }
  return i;
}

/** Layout inside a line of text, which prints nothing there: hidden, shown again at the cursor (`\noindent Text`, `\protect\ref`). */
const INLINE_LAYOUT = /^\\(?:eject|onecolumngrid|twocolumngrid|noindent|indent|smallskip|medskip|bigskip|protect|justifying|onehalfspacing|doublespacing|singlespacing|newpage|clearpage|cleardoublepage|leavevmode|FloatBarrier|phantomsection|nopagebreak|pagebreak|raggedright|raggedleft|appendix|frenchspacing|nonfrenchspacing|allowbreak|nobreak|nolinebreak|relax)$/;
/** Wrappers whose last argument is text (`\afterpage{…}`, `\raisebox{-0.1cm}{\protect\includegraphics…}`), by the number of `{…}` arguments they read. */
const TEXT_WRAPPERS: Record<string, number> = { "\\afterpage": 1, "\\raisebox": 2, "\\resizebox": 3, "\\scalebox": 2 };
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
    } else if (!/^(?:BIBdecl|relax|expandafter|ifx|else|fi)$/.test(command[1])) break; // natbib's `\expandafter\ifx\csname urlstyle\endcsname\relax … \else … \fi` around the `\doi` definition
    if (from < 0) from = start;
    to = i;
  }
  // Only when nothing else comes before the first item.
  return from >= 0 && !text.slice(to).replace(/%[^\n]*/g, "").trim() ? { from, to } : null;
}

/** Definitions the grammar parses as unknown commands. */
/** Definition commands whose arguments end with their line when the line ends (`\algtext*{EndIf}`, `\newif\ifdraft`). */
const NEXT_LINE_STOPS = /^\\(?:algtext|newif)\*?\s*(?:\{[^{}]*\}|\\[A-Za-z@]+)\s*$/;
const DEFINITION_COMMANDS =/^\\(?:providecommand|DeclareRobustCommand|DeclareMathOperator|(?:New|Renew|Provide|Declare)Document(?:Command|Environment)|gdef|edef|xdef|numberwithin|crefname|Crefname|algnewcommand|algrenewcommand|algdef|algblockdefx|algblock|algtext|newif|newcolumntype)$/;
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
  MathTextCommand: "cm-vis-rm", Hbox: "cm-vis-rm",
};
const MATH_CONTAINERS = new Set(["DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment", "Math", "InlineMath", "DisplayMath"]);
/** Acknowledgment environments of conference classes (NeurIPS `ack`, ACM `acks`). */
const ACKNOWLEDGMENTS = /^(?:ack|acks|acknowledgments|acknowledgements|acknowledgment|acknowledgement)$/;
const BULLETS = ["•", "–", "∗", "·"];
const TEXT_BLOCKS: Record<string, string> = {
  quote: "cm-vis-quote", quotation: "cm-vis-quote", verse: "cm-vis-quote", center: "cm-vis-center", flushleft: "cm-vis-flushleft",
  flushright: "cm-vis-flushright", abstract: "cm-vis-abstract",
  // The appendix package's environment: its lines fold away, its sections are lettered (numbering.ts).
  appendices: "cm-vis-appendices", APPENDICES: "cm-vis-appendices",
  // `\begin{appendix}`, which runs `\appendix` (KOMA papers): the same.
  appendix: "cm-vis-appendices",
  // `tabbing`: lines of text with tab stops (`\=`, `\>`), drawn as gaps (Featherweight Go's proofs).
  tabbing: "cm-vis-tabbing",
  // setspace's line spacing and pdflscape's rotated pages: layout, whose lines fold away (applied economics papers).
  singlespace: "cm-vis-sized", onehalfspace: "cm-vis-sized", doublespace: "cm-vis-sized", spacing: "cm-vis-sized", landscape: "cm-vis-sized",
  // Keywords under an abstract (JMLR, SIAM, IEEE).
  keywords: "cm-vis-keywords", IEEEkeywords: "cm-vis-keywords", keyword: "cm-vis-keywords", AMS: "cm-vis-keywords",
  // amsmath's `subequations` (numbering 3a, 3b): its equations are drawn on their own, and its lines fold away.
  subequations: "cm-vis-sized",
  // revtex's `widetext` (text set across both columns): layout, whose lines fold away.
  widetext: "cm-vis-sized",
  // `\begin{small} … \end{small}`: a size, which draws nothing; its lines fold away.
  ...Object.fromEntries(["tiny", "scriptsize", "footnotesize", "small", "normalsize", "large", "Large", "LARGE", "huge", "Huge"].map((size) => [size, "cm-vis-sized"])),
};
/** Node types the walk does something with; it only goes inside the others. */
const HANDLED = new Set([
  ...Object.keys(SECTION_CLASSES), ...Object.keys(INLINE_STYLES), "TextColorCommand", "ColorBoxCommand", "HrefCommand", "UrlCommand",
  "FootnoteCommand", "EndnoteCommand", "DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment",
  "Cite", "Ref", "Label", "FigureEnvironment", "TableEnvironment", "TabularEnvironment", "ListEnvironment", "Item", "Environment",
  "EndEnv", "Maketitle", "IncludeGraphics", "LineBreak", "Tilde", "Normal", "UnknownCommand", "Group",
  "BibliographyCommand", "BibliographyStyleCommand", "Centering", "SetLengthCommand", "ParBoxCommand", "HorizontalLine", "Input", "Include",
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

/** `\includegraphics` options the image widget draws besides its width (widgets.ts: graphicsStyle). */
const GRAPHICS_STYLE_KEYS = /(?:^|,)\s*(?:height|totalheight|scale|angle|trim|viewport|clip|page|keepaspectratio)\b/;

/** A minipage's width as CSS (`\begin{minipage}[t]{0.48\textwidth}` 48%), from its opening; undefined when not one of those. */
function minipageWidth(opening: string) {
  const width = /^\\begin\s*\{minipage\}\s*(?:\[[^\]]*\]\s*){0,3}\{([^{}]*)\}/.exec(opening)?.[1];
  return width ? graphicsWidth(`width=${width.trim()}`) : undefined;
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

/** Per parse, a list's `\item`s and changes to its counter, in order: where each ends, and the count after it. */
const itemCounts = new WeakMap<object, Map<string, { defs: LatexDefinitions; ends: number[]; counts: number[] }>>();

/** The item count of `list` (not of lists inside it) at `pos`: its `\item`s before it, and changes to its counter. */
function itemsBefore(list: SyntaxNode, pos: number, state: EditorState, counter: string | null, defs: LatexDefinitions, base = 0) {
  // A long list is built in pieces, each asking for the count where it starts: the list is read once per parse,
  // not once per piece (an `enumerate` of 10,000 items took seconds to build).
  let root = list;
  while (root.parent) root = root.parent!;
  let lists = root.tree ? itemCounts.get(root.tree) : undefined;
  if (root.tree && !lists) itemCounts.set(root.tree, (lists = new Map()));
  const key = `${list.from}:${list.to}:${counter}:${base}`;
  let read = lists?.get(key);
  if (!read || read.defs !== defs) {
    read = { defs, ...readItemCounts(list, state, counter, defs, base) };
    lists?.set(key, read);
  }
  // They do not overlap: those that end by `pos` come first.
  let low = 0;
  for (let high = read.ends.length; low < high;) {
    const mid = (low + high) >> 1;
    if (read.ends[mid] <= pos) low = mid + 1;
    else high = mid;
  }
  return read.counts[low];
}

function readItemCounts(list: SyntaxNode, state: EditorState, counter: string | null, defs: LatexDefinitions, base = 0) {
  const ends: number[] = [];
  const counts = [base];
  const content = list.getChild("Content");
  if (!content) return { ends, counts };
  const add = (end: number, change: (count: number) => number) => { ends.push(end); counts.push(change(counts[counts.length - 1])); };
  const cursor = content.cursor();
  const itemMacros = itemMacroNames(defs);
  // As the walk counts them when it draws the list whole: not in an inner list of the document's own, nor in `\iffalse … \fi`.
  const disabled = state.field(disabledField, false) ?? [];
  const walk = (): void => {
    do {
      if (cursor.name === "ListEnvironment") continue;
      if (cursor.name === "Environment" && defs.lists?.has(environmentName(cursor.node, (from, to) => state.doc.sliceString(from, to)) ?? "")) continue;
      if (cursor.name === "Item") { if (!cursor.node.getChild("OptionalArgument") && !disabled.some((region) => region.from <= cursor.from && cursor.from < region.to)) add(cursor.to, (count) => count + 1); continue; }
      if (cursor.name === "UnknownCommand") {
        // `\step` for `\item` counts as an item.
        const ctrl = cursor.node.firstChild;
        if (itemMacros.size && ctrl && itemMacros.has(state.doc.sliceString(ctrl.from + 1, ctrl.to))) { add(cursor.to, (count) => count + 1); continue; }
        const change = counterChange(state, cursor.node, counter);
        if (change) { add(cursor.to, change); continue; }
      }
      if (cursor.firstChild()) { walk(); cursor.parent(); }
    } while (cursor.nextSibling());
  };
  if (cursor.firstChild()) walk();
  return { ends, counts };
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
 * with `\newtheorem*{namedtheorem}{\theoremname}`): an unnumbered theorem whose heading is the argument, or holds it
 * (math.CO 2611.11191's restated `\newtheorem*{teoremarepinner}{Theorem \theteoremarepnum}` with
 * `\renewcommand{\theteoremarepnum}{\ref{r:#1}}`: "Theorem 1.1"). Null otherwise.
 */
function namedTheorem(code: string, defs: LatexDefinitions) {
  // `\renewcommand{\theoremname}{#1}` or `\def\reptheoremlabel{#1}` before the `\begin` (cs.GT 2611.05777's `reptheorem`).
  const match = /^\s*(?:\\(?:re)?newcommand\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))|\\def\s*\\([A-Za-z@]+))\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\\begin\s*\{([^{}]+)\}\s*$/.exec(code);
  if (!match) return null;
  const name = match[1] ?? match[2] ?? match[3];
  const theorem = defs.theorems.get(match[5].trim());
  let title = theorem?.title.replace(/\\protect\s*/g, "").trim() ?? "";
  // The title may reach the argument through another macro (`\newtheorem*{reptheorembody}{\reptheoremheading}` with
  // `\DeclareRobustCommand{\reptheoremheading}{\Cref{\reptheoremlabel}}`): argument-less macros of the document are read through.
  for (let pass = 0; pass < 4; pass++) {
    const next = title.replace(/\\([A-Za-z@]+)(?![A-Za-z@])/g, (whole, macroName: string) => {
      const macro = macroName === name ? null : macroAt(defs, macroName, Number.MAX_SAFE_INTEGER);
      return macro && !macro.arity && !macro.optional && !macro.spec && !macro.provided && macro.body.length < 200 && !macro.body.includes("#") ? macro.body.trim() : whole;
    });
    if (next === title) break;
    title = next;
  }
  const use = new RegExp(String.raw`\\${name}(?![A-Za-z@])`, "g");
  if (!theorem || theorem.numbered || title.match(use)?.length !== 1) return null;
  return { theorem, title: title.replace(use, () => match[4].trim()) };
}

/** `inline`: a list run into its paragraph (paralist's `inparaenum`), whose lines are not indented. */
/** `adjusted`: a list continued from another or started elsewhere (enumitem's `resume`, `start=`); `base`: the count it starts from here. */
type ListContext = { node: SyntaxNode; variant: "bullet" | "number" | "description"; depth: number; count: number; template: string | null; inline?: boolean; adjusted?: boolean; base?: number; plain?: boolean };
/** paralist's lists, as the lists they are; the `inpara` ones run into their paragraph (Depth Anything's `inparaenum`). */
const PARALIST: Record<string, "enumerate" | "itemize" | "description"> = {
  compactenum: "enumerate", asparaenum: "enumerate", inparaenum: "enumerate", compactitem: "itemize", asparaitem: "itemize", inparaitem: "itemize",
  compactdesc: "description", asparadesc: "description", inparadesc: "description",
  // enumitem's inline lists (`\begin{enumerate*}`): items run into the paragraph.
  "enumerate*": "enumerate", "itemize*": "itemize", "description*": "description",
};

/**
 * How a region left out is faded: the lines it holds whole, and only its own text on a line it shares with text that
 * is drawn (2410.03413's `… section~2 \ifnum\llncs=1 (short)\else (full)\fi.` in a paragraph).
 */
function disabledStyle(doc: Text, region: { from: number; to: number }): Pick<Construct, "lines" | "marks"> {
  const first = doc.lineAt(region.from);
  const last = doc.lineAt(region.to);
  const before = !!doc.sliceString(first.from, region.from).trim();
  const after = !!doc.sliceString(region.to, last.to).trim();
  const marks: Mark[] = [];
  let wholeFrom = region.from;
  let wholeTo = region.to;
  if (before || (first.number === last.number && after)) {
    marks.push({ from: region.from, to: first.number === last.number ? region.to : first.to, class: "cm-vis-disabled-text" });
    if (first.number === last.number) return { marks };
    wholeFrom = first.to + 1;
  }
  if (after) {
    marks.push({ from: last.from, to: region.to, class: "cm-vis-disabled-text" });
    wholeTo = last.from - 1;
  }
  return { lines: wholeTo >= wholeFrom ? [{ from: wholeFrom, to: wholeTo, class: "cm-vis-disabled" }] : [], marks };
}

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
    if (region.from >= from) emit({ kind: "disabled", from: region.from, to: region.to, reveal: "never", replaces: [], ...disabledStyle(doc, region) });
  }
  /** The disabled region a node starts in: nothing is drawn for it, though what follows the `\fi` inside it is. */
  const startsDisabled = (pos: number) => disabled.find((region) => region.from <= pos && pos < region.to);
  // AASTeX's front matter, which the class prints without `\maketitle`: a title block over its lines. A walk that starts
  // inside them leaves them to the walk that draws the block.
  // (From the file's start without a body start: the run is the one right before the abstract, wherever that is.)
  const aastexFront = AASTEX.test(defs.documentClass ?? "") ? aastexFrontMatterIn(doc, Math.max(0, env.preambleEnd), defs.documentClass!) : null;
  const aastexTitle = aastexFront && aloneOnLines(doc, aastexFront.from, aastexFront.to) ? aastexFront : null;
  if (aastexTitle && aastexTitle.from < from && from < aastexTitle.to) consumed.push([aastexTitle.from, aastexTitle.to]);

  /** A use of a macro that writes a figure's caption (`\mycap{…}` for `\caption{…}`), maybe with a label: the caption's text. */
  const captionMacro = (use: SyntaxNode): CaptionMacroUse | null => {
    const ctrl = use.firstChild;
    const name = ctrl ? read(state, ctrl.from + 1, ctrl.to) : "";
    const macro = name && structureMacroNames(defs).has(name) ? macroAt(defs, name, use.from) : null;
    if (!macro) return null;
    // An argument the parser ends early (`\mycap{{ figure.}` with its `}` lines after `\end{figure}`) is read past the
    // float in the text: the caption would swallow `\end{figure}`, and a brace typed far below would make it one.
    if (use.getChildren("TextArgument").some((argument) => hasDirectError(argument) || argument.lastChild?.lastChild?.type.isError)) return null;
    const expansion = expandLatexMacroUse(read(state, use.from, Math.min(doc.length, use.from + 4000)), defs, { mode: "text", pos: use.from });
    if (!expansion) return null;
    const parts = topConstructs(expansion.text);
    if (parts[0]?.name !== "Caption") return null;
    const range = argumentInner(parts[0].getChild("TextArgument") ?? parts[0]);
    if (!range) return null;
    const text = expansion.text.slice(range.from, range.to);
    if (parts.length === 1 || (parts.length === 2 && parts[1].name === "Label")) return { text, body: [] };
    // `\tbl{caption}{\begin{tabular}…}` for `\caption{#1}\noindent\makebox[\linewidth]{#2}` (the OD estimation paper):
    // the caption, and the arguments put in a box after it, which are the float's content (checked and drawn as such).
    const plan = captionBoxPlan(macro);
    if (!plan) return null;
    const body: SyntaxNode[] = [];
    for (const [index, argument] of use.getChildren("TextArgument").entries()) {
      if (plan.body.has(index + 1)) body.push(argument);
      else if (!plan.caption.has(index + 1)) return null;
    }
    return { text, body };
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
      // Only the row-writing macros are expanded here: the macros inside cells (`\Mach{..}{..}`) are drawn by the
      // cells, each on its own, so one the expander cannot take (or a long table) does not lose the whole table.
      const display = readLongTable(read(state, node.from, node.to), expandRowsAt(node.from), defs.columnTypes);
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
    // Rows written through the document's macros are drawn from their expansion, row by row (the others stay
    // editable); when the tabular's own rows cannot be read, the whole table is drawn from it (read-only).
    const macroRows = macroRowReadings(source, expandRowsAt(node.from), defs.columnTypes);
    const built = macroRows ? null : macroBuiltTabular(source, expandRowsAt(node.from), defs.columnTypes);
    // A tabular of rules only (`\hline\hline`) draws nothing to show: it stays source.
    if (!built && !parseTabular(source, 0, defs.columnTypes)?.rows.length) return undefined;
    const span = aloneOnLines(doc, node.from, node.to);
    const range = span ?? { from: node.from, to: node.to };
    // `{\rowcolors{2}{gray!10}{white}\renewcommand{\arraystretch}{1.3}\begin{tabular}…}`: what its group sets for it.
    let container = node.from;
    for (let parent = node.parent; parent && parent.parent?.name !== "DocumentEnvironment"; parent = parent.parent) {
      if (parent.name === "Group" || parent.name === "NonEmptyGroup" || parent.name === "Content") { container = parent.from; break; }
    }
    const extras = tableExtras(read(state, Math.max(container, node.from - 2000), node.from), defs, node.from, macroRows);
    emit({ kind: "table", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new TableWidget(built ?? source, node.from - range.from, range.to - range.from, !!built, extras) }] });
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
      for (const part of content.sources ?? []) part.offset -= range.from;
      // A caption written out (not by a macro) is edited in place.
      if (content.caption && read(state, content.captionPos, content.captionPos + content.caption.length) === content.caption) content.captionOffset = content.captionPos - range.from;
      if (content.algorithm?.offset !== undefined) content.algorithm = { ...content.algorithm, offset: content.algorithm.offset - range.from };
    }
    figure.length = range.to - range.from;
    emit({ kind: "figure", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new FigureWidget(figure) }] });
    return false;
  };

  /**
   * Whether an item label written with formulas or commands can be drawn: each `$…$` is a formula KaTeX reads (the
   * document's macros expanded), and outside them only text styles and spacing. Else the label is shown as written.
   */
  const drawableLabel = (label: string, pos: number) => {
    let drawable = true;
    const text = label.replace(/\$([^$]*)\$/g, (_, formula: string) => {
      const expanded = expandLatexMacros(formula, defs, { mode: "math", pos });
      if (!expanded.ok || renderKatex(expanded.text, false) === null) drawable = false;
      return "";
    });
    if (!drawable) return false;
    return [...text.matchAll(/\\([A-Za-z@]+)/g)].every((use) => /^(?:textbf|textit|emph|textrm|textsf|texttt|textsc|textnormal|textup|textsl|textmd|textsuperscript|textsubscript|mathrm|mbox|bfseries|itshape|mdseries|upshape|rmfamily|sffamily|ttfamily|normalfont|bf|it|rm|tt|sf|em)$/.test(use[1])) && !/\$/.test(text);
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
      // A label that cannot be drawn (an unknown command, a formula KaTeX rejects) stays as written.
      if (latex && !drawableLabel(label, list.node.from)) latex = false;
      if (list.variant !== "description") variant = "number";
    } else if (list.variant === "number") {
      list.count++;
      label = enumerateItemLabel(list.count, list.depth, list.template);
      // enumitem's `label=$(\square_{\arabic*})$`: the formula drawn; as source when it cannot be.
      latex = /[\\$]/.test(label) && drawableLabel(label, list.node.from);
    } else if (list.plain) {
      // `\begin{list}{}{…}` and `trivlist`: no label unless the item gives one.
      label = "";
    } else if (list.variant === "bullet" && bulletLabel(list.template)) {
      // enumitem's `\begin{itemize}[label=--]`: the bullet it chose.
      ({ label, latex } = bulletLabel(list.template)!);
    } else label = list.variant === "description" ? "" : BULLETS[(list.depth - 1) % BULLETS.length];
    const line = doc.lineAt(at);
    const replaceFrom = read(state, line.from, at).trim() ? at : line.from;
    const numberedAt = list.adjusted && optional === null && list.variant === "number" ? at - replaceFrom : null;
    emit({ kind: "item", from: replaceFrom, to, reveal: "strict", replaces: [{ from: replaceFrom, to, widget: new ItemMarkerWidget(label, variant, list.depth, { latex, inline: list.inline }, numberedAt, to - replaceFrom) }] });
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

  /** A citation's note with the document's macros expanded (`$\pm 1\masyr$`, `\Gaia{}`), when they can be; else as written. */
  const noteMacros = (text: string, pos: number) => {
    if (!text.includes("\\")) return text;
    const expanded = expandLatexMacros(text, defs, { mode: "text", pos });
    return expanded.ok ? expanded.text : text;
  };

  /** The address a `\url`/`\href` argument with macros in it prints (`\repourl/tree`), or null when a command stays in it. */
  const expandedUrl = (raw: string, pos: number) => {
    const expanded = expandLatexMacros(raw, defs, { mode: "text", pos });
    const text = expanded.ok ? expanded.text.replace(/\\([%#&_~$^{}])/g, "$1").trim() : null;
    return text && !/\\[A-Za-z@]/.test(text) && !/[{}]/.test(text) ? text : null;
  };

  /** Whether a command is inside the argument or group of another (`\IfFileExists{a}{\input{a}}{}`, `{\small \input{x}}`). */
  /** Groups that only scope layout (`{\setlength{\tabcolsep}{3pt}\input{table}}`): not an argument of anything. */
  const layoutGroups = new Set<number>();
  const inArgument = (node: SyntaxNode) => {
    for (let parent = node.parent; parent; parent = parent.parent) if (!layoutGroups.has(parent.from) && /^(?:Group|NonEmptyGroup|TextArgument|ShortTextArgument|LongArg|SectioningArgument)$/.test(parent.name)) return true;
    return false;
  };

  /** Whether `\input{file}` names a file the project has (or the project is not known: a file opened on its own, a chapter). */
  const includeResolves = (file: string, isInput: boolean) => {
    const config = state.facet(visualConfig);
    const paths = state.field(latexProjectField, false)?.allPaths;
    if (!paths?.length || (config.rootPath && config.rootPath !== config.documentPath)) return true;
    const name = file.replace(/^\.\//, "");
    // `\input` of a bare name may be a file of TeX's distribution, not the project's.
    if (isInput && !/\//.test(name) && !/\.tex$/i.test(name)) return false;
    return paths.some((path) => { const known = path.replace(/^\.\//, ""); return known === name || known === `${name}.tex`; });
  };

  /** Hides a `\begin`/`\end` line when it is alone on its line, collapsing it; else only the markup. */
  const collapseLine =(node: { from: number; to: number }, kind: string, extra?: Replace) => {
    const span = aloneOnLines(doc, node.from, node.to);
    const replace: Replace = extra ?? { from: span ? span.from : node.from, to: span ? span.to : node.to };
    emit({
      kind, from: replace.from, to: replace.to, reveal: "line", wholeLine: true, replaces: [replace],
      hiddenLines: span && !extra ? [{ from: span.from, to: span.to, class: "cm-vis-collapsed" }] : undefined,
    });
  };

  /**
   * A definition written in the body is source that prints nothing: folded as one unit when it is alone on its lines
   * (a trailing comment allowed), hidden when it sits on one line of text, else left as it is. False when left.
   */
  const foldDefinition = (start: number, end: number) => {
    const first = doc.lineAt(start);
    const last = doc.lineAt(end);
    if (!doc.sliceString(first.from, start).trim() && /^\s*(?:%.*)?$/.test(doc.sliceString(end, last.to))) {
      collapseLine({ from: first.from, to: last.to }, "layout");
      consumed.push([first.from, last.to]);
      return true;
    }
    if (first.number !== last.number) return false;
    emit({ kind: "layout", from: start, to: end, reveal: "touch", replaces: [{ from: start, to: end }] });
    consumed.push([start, end]);
    return true;
  };

  tree.iterate({
    from,
    to,
    enter(ref) {
      const name = ref.name;
      if (SKIPPED.has(name)) {
        // The grammar may end a definition early (`\newcommand*`): its name and body that follow are source too.
        const extent = DEFINITION_NODES.has(name) ? definitionExtentAt(defs, ref.from) : null;
        const freshDefinition = DEFINITION_NODES.has(name) && !isConsumed(ref);
        let folded = false;
        if (extent && extent.to > ref.to) consumed.push([ref.from, extent.to]);
        // `\renewcommand{\theequation}{S\arabic{equation}}` in the body: a counter's format, which numbering reads; its
        // line folds away as other layout lines do.
        // A table's row helper (`\newcommand{\ntrow}[3]{#1 & #2 & #3\\}`) and its row height (`\renewcommand{\arraystretch}{1.12}`)
        // fold away the same way; the line shows again at the cursor.
        if ((name === "RenewCommand" || name === "NewCommand") && ref.from > env.preambleEnd && ref.from >= from && ref.from < to && !isConsumed(ref)) {
          const line = layoutLine(state, ref.from);
          if (line) { collapseLine(line, "layout"); consumed.push([line.from, line.to]); folded = true; }
          else if (structural && name === "RenewCommand" && /^\\renewcommand\*?\s*(?:\{\s*\\the[A-Za-z]+\s*\}|\\the[A-Za-z]+(?![A-Za-z]))/.test(read(state, ref.from, Math.min(doc.length, ref.from + 60)))) {
            // In a line of text, or at the start of a group that only scopes it (`{\renewcommand{\thefootnote}{}\footnotetext{…}}`,
            // 2610.30364): hidden, with the group's braces, shown again at the cursor.
            let group = ref.node.parent;
            for (let up = 0; up < 4 && group && group.name !== "Group"; up++) group = group.parent;
            const open = group?.name === "Group" ? group.firstChild : null;
            const close = group?.name === "Group" ? group.lastChild : null;
            const scoped = !!open && !!close && open.name === "OpenBrace" && close.name === "CloseBrace" && !read(state, open.to, ref.from).trim();
            const from = scoped ? open.from : ref.from;
            emit({ kind: "layout", from, to: ref.to, reveal: "touch", replaces: [{ from, to: ref.to }] });
            if (scoped) emit({ kind: "layout", from: close.from, to: close.to, reveal: "touch", replaces: [{ from: close.from, to: close.to }] });
            folded = true;
          }
        }
        // `\let\c@lemmaL\c@theorem` in the body (2611.11388's supplement): counters made to count together, which
        // numbering reads. Its line folds away; in a line of text it is hidden, shown again at the cursor.
        if (name === "Let" && ref.from > env.preambleEnd && ref.from >= from && ref.from < to && !isConsumed(ref)) {
          const alias = COUNTER_ALIAS.exec(read(state, ref.from, Math.min(doc.length, ref.from + 80)));
          if (alias) {
            folded = true;
            const line = layoutLine(state, ref.from);
            if (line) { collapseLine(line, "layout"); consumed.push([line.from, line.to]); }
            else if (structural) {
              emit({ kind: "layout", from: ref.from, to: ref.from + alias[0].length, reveal: "touch", replaces: [{ from: ref.from, to: ref.from + alias[0].length }] });
              consumed.push([ref.from, ref.from + alias[0].length]);
            }
          }
        }
        // Any other definition in the body (`\newcommand{\psladder}[3][]{…\begin{tikzpicture}…}`, `\newenvironment`, `\def`, `\let`):
        // one inert unit. Its body is never drawn; the whole definition folds away like a layout line, shown again at the cursor.
        // (`\def\@title`, `\@author`, `\@date` are the parts of a hand-made title block, which reads them and draws the
        // block over them, or leaves them as source when it is not one.)
        if (freshDefinition && !folded && structural && !/^\\(?:g|e|x)?def\s*\\@(?:title|author|date)(?![A-Za-z@])/.test(read(state, ref.from, Math.min(doc.length, ref.from + 24))) && ref.from > env.preambleEnd && ref.from >= from && ref.from < to && !startsDisabled(ref.from)) foldDefinition(ref.from, Math.max(ref.to, extent?.to ?? 0));
        // `\verb|…|`, `\lstinline`, `verbatim`, `lstlisting`, `minted`: code, its text taken as written.
        // (A long block is built in pieces: the piece with its `\end` line draws that line.)
        if (VISIBLE_SKIPPED.has(name) && name !== "Csname" && ref.from < to && (ref.from >= from || name === "VerbatimEnvironment") && ref.from > env.preambleEnd && !isConsumed(ref) && !startsDisabled(ref.from)) drawCode(ref.node, ref.from >= from);
        return false;
      }
      if (env.preambleEnd > 0 && ref.to <= env.preambleEnd) return false;
      if (consumed.length && isConsumed(ref)) return false;
      if (aastexTitle && ref.from === aastexTitle.from && ref.to <= aastexTitle.to && ref.from >= from) {
        const span = aloneOnLines(doc, aastexTitle.from, aastexTitle.to)!;
        consumed.push([span.from, span.to]);
        if (structural) emit({ kind: "title", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new TitleWidget(aastexTitle.title, aastexTitle.author, null, span.to - span.from, null, aastexTitle.notes) }] });
        return false;
      }
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
        if (!argument || !inner || hasDirectError(command)) return;
        const label = trailingLabel(state, node.getChild("Content"), argument.to);
        const end = label ? label.to : argument.to;
        // `\section*{}` (a class's abstract placeholder, 2611.13868): no title and no number, so nothing is drawn; its line folds away.
        if (inner.to <= inner.from) {
          if (!/^\\[A-Za-z]+\*\s*(?:\[[^\]]*\])?\s*\{$/.test(read(state, command.from, inner.from)) || name === "Paragraph" || name === "SubParagraph") return;
          if (label) consumed.push([label.from, label.to]);
          emit({ kind: "heading", from: command.from, to: end, reveal: "line", wholeLine: true, replaces: structural ? [{ from: command.from, to: end }] : [], hiddenLines: [{ from: command.from, to: inner.to, class: `cm-vis-heading ${SECTION_CLASSES[name]}` }] });
          return;
        }
        if (label) consumed.push([label.from, label.to]);
        // \paragraph and \subparagraph are run-in: only the title is a heading, the text after it is not.
        const runIn = name === "Paragraph" || name === "SubParagraph";
        // With the cursor on its lines (a run-in heading: in it or at either edge), the heading is its source at the
        // text's size, so is what is typed after its `}`; it is drawn once the cursor is out.
        emit({
          kind: "heading", from: command.from, to: end, ...(runIn ? { reveal: "touch" as const } : { reveal: "line" as const, wholeLine: true }),
          replaces: structural ? [
            { from: command.from, to: inner.from, widget: new HeadingNumberWidget(SECTION_CLASSES[name], read(state, command.from, inner.from)) },
            { from: inner.to, to: end },
          ] : [],
          marks: runIn ? [{ from: inner.from, to: inner.to, class: "cm-vis-runin" }] : undefined,
          hiddenLines: runIn ? undefined : [{ from: command.from, to: inner.to, class: `cm-vis-heading ${SECTION_CLASSES[name]}` }],
        });
        return;
      }

      if (!starts) {
        // Containers that began before the walked range: keep list context for the items inside.
        // So for enumitem's lists of the document's own (`\newlist{steps}{enumerate}{3}`), as drawList draws them.
        const generic = name === "Environment" && isGenericList(node) ? genericListHead(node, state) : null;
        const custom = generic?.kind ?? (name === "Environment" ? defs.lists?.get(environmentName(node, readNode) ?? "") ?? PARALIST[environmentName(node, readNode) ?? ""] : undefined);
        if (name === "ListEnvironment" || custom) {
          const formed = wellFormedEnvironment(node, state);
          if (formed) {
            const list = listContext(node, custom ?? formed.name, lists, state, 0);
            if (custom && (/^inpara/.test(formed.name) || formed.name.endsWith("*")) && !defs.lists?.has(formed.name)) list.inline = true;
            if (generic) { list.template = generic.template; list.plain = generic.plain; }
            if (!list.template && custom && !generic) list.template = customListLabel(defs, formed.name, list.depth);
            list.count = itemsBefore(node, from, state, list.variant === "number" ? enumCounter(list.depth) : null, defs, list.base);
            lists.push(list);
            // A long list is built in pieces (structural.ts): its `\end` line is drawn by the piece it is in.
            if (structural && formed.end.from >= from && formed.end.from < to) collapseLine(formed.end, "list-end");
          }
        }
        // A wrapper that only folds away (`samepage`, `multicols`) begun in an earlier piece: its `\end` is folded by the piece it is in.
        else if (structural && name === "Environment") {
          const wrapperName = environmentName(node, readNode) ?? "";
          if (Object.hasOwn(WRAPPER_ENVIRONMENTS, wrapperName) && !defs.environments.has(wrapperName)) {
            const formed = wellFormedEnvironment(node, state);
            if (formed && formed.end.from >= from && formed.end.from < to) collapseLine(formed.end, "env-end");
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
        if (!switched) {
          // `{\hypersetup{linkcolor=black}\tableofcontents}`, `{\setlength{\tabcolsep}{3.5pt}\input{tables/ablation}}`: braces that only
          // scope layout commands. The braces and the commands fold away (or hide, in a line of text); what follows them is drawn as usual.
          if (structural && node.from >= from && node.from < to && !hasDirectError(node) && !isConsumed(node)) {
            const innerText = read(state, node.from + 1, Math.min(node.to - 1, node.from + 1 + 400));
            // (A list of contents is drawn, not folded: only what comes before it is layout.)
            const contents = /\\(?:tableofcontents|listoffigures|listoftables|listoftodos)(?![A-Za-z@])/.exec(innerText);
            const run = innerText.includes("\n") ? 0 : layoutRun(contents ? innerText.slice(0, contents.index) : innerText, true);
            if (run > 0) {
              const rest = read(state, node.from + 1 + run, node.to - 1);
              if (!rest.trim() && foldDefinition(node.from, node.to)) return false;
              // The list of contents the group scopes the layout of: drawn as the list, over the whole line.
              const listing = CONTENTS_LISTS[rest.trim()];
              const span = listing ? aloneOnLines(doc, node.from, node.to) : null;
              if (listing && span) {
                consumed.push([span.from, span.to]);
                emit({ kind: "contents", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new ContentsWidget(listing, span.to - span.from) }] });
                return false;
              }
              if (rest.trim()) {
                consumed.push([node.from, node.from + 1 + run]);
                layoutGroups.add(node.from);
                emit({ kind: "layout", from: node.from, to: node.to, reveal: "touch", replaces: [{ from: node.from, to: node.from + 1 + run }, { from: node.to - 1, to: node.to }] });
                return;
              }
            }
          }
          // BibTeX's protective braces (`{G}aussian`, `{PDE}s` in a .bbl) print nothing: hidden, back at the caret. Plain words only,
          // and not the argument of a command (`\foo {x}`).
          const inner = read(state, node.from + 1, node.to - 1);
          const before = read(state, Math.max(0, node.from - 60), node.from);
          // `{\urlstyle{same}\url{…}}` (url's style switch, scoped by the braces) is plain too.
          const plain = inner.replace(/\\urlstyle\s*\{[^{}]*\}\s*/g, "").replace(/\\url\s*\{[^{}]*\}/g, "U");
          if (/^[A-Za-z0-9][A-Za-z0-9 .,:;'’\-–]*$/.test(plain) && !/(?:\\[A-Za-z@]+\*?\s*|[}\]])$/.test(before) && !hasDirectError(node)) {
            emit({ kind: "style", from: node.from, to: node.to, reveal: "touch", replaces: [{ from: node.from, to: node.from + 1 }, { from: node.to - 1, to: node.to }] });
          }
          return;
        }
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
        case "Input": case "Include": {
          // `\input{chapters/intro}`, `\include{…}` in the text: a chip naming the file (what it holds is shown where the file is open). Not inside
          // another command's argument (`\IfFileExists{a}{\input{a}}{}`), and not a file the project is known not to have.
          const command = read(state, node.from, node.to).match(/^\\(input|include)\s*\{([^{}]*)\}$/);
          const file = command?.[2].trim();
          if (!structural || !command || !file || /[#\\%]/.test(file) || hasDirectError(node) || inArgument(node) || !includeResolves(file, command[1] === "input")) return;
          emit({ kind: "symbol", from: node.from, to: node.to, reveal: "strict", replaces: [{ from: node.from, to: node.to, widget: new IncludeChipWidget(file, read(state, node.from, node.to), node.to - node.from) }] });
          return false;
        }
        case "HrefCommand": case "UrlCommand": {
          const url = node.getChild("UrlArgument");
          const urlRange = url && argumentInner(url);
          const text = name === "HrefCommand" ? (node.getChild("ShortTextArgument") ?? node.getChild("TextArgument")) : url;
          let textRange = text && argumentInner(text);
          // bibtex's `\href {url} {text}` and an address followed by a line break (`\href{url}\n  {\emph{Title}}`): the grammar ends the
          // command at the address, so the text group after it (one space or one line break away) is read here.
          let hrefEnd = node.to;
          const loose = name === "HrefCommand" && urlRange && !textRange ? /^[ \t]*(?:\r?\n[ \t]*)?\{/.exec(read(state, node.to, Math.min(doc.length, node.to + 4000))) : null;
          if (loose) {
            const group = readGroup(read(state, node.to, Math.min(doc.length, node.to + 4000)), loose[0].length - 1, TEX_GROUPS);
            if (group) { textRange = { from: node.to + loose[0].length, to: node.to + group.end - 1 }; hrefEnd = node.to + group.end; }
          }
          if (!urlRange || !textRange || textRange.to <= textRange.from || (hasDirectError(node) && !loose)) return;
          // A user macro in the address (`\url{\repourl}`, `\href{\site/x}{…}`, 2610.30364) is expanded; one that cannot be stays source.
          const rawUrl = read(state, urlRange.from, urlRange.to);
          const href = rawUrl.includes("\\") ? expandedUrl(rawUrl, node.from) : rawUrl;
          if (href === null) return;
          const title = `${href} (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}-click to open)`;
          if (name === "UrlCommand" && href !== rawUrl) {
            if (!structural) return;
            emit({
              kind: "style", from: node.from, to: node.to, reveal: "touch",
              replaces: [{ from: node.from, to: urlRange.from }, { from: urlRange.from, to: urlRange.to, widget: new LinkTextWidget(href, title, urlRange.to - urlRange.from) }, { from: urlRange.to, to: node.to }],
            });
            return;
          }
          emit({
            kind: "style", from: node.from, to: hrefEnd, reveal: "touch",
            replaces: [{ from: node.from, to: textRange.from }, { from: textRange.to, to: hrefEnd }],
            marks: [{ from: textRange.from, to: textRange.to, class: "cm-vis-link", attributes: { "data-href": href, title } }],
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
          const optionals = node.getChildren("OptionalArgument").map((arg) => { const range = argumentInner(arg); return range ? noteMacros(read(state, range.from, range.to), node.from) : ""; });
          const notes = optionals.length > 1 ? { pre: optionals[0] || undefined, post: optionals[1] || undefined } : { post: optionals[0] || undefined };
          if (!notesUnderstood(notes)) return false;
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
          // biblatex's multicites (`\parencites[12]{a}[34]{b}`): the grammar ends at the first group; the chip takes
          // every group after it, each with its notes (one it cannot read leaves the citation source).
          const more: Array<{ keys: string[]; notes: { pre?: string; post?: string } }> = [];
          if (name === "Cite" && /^\\(?:[cC]ites|[pP]arencites|[tT]extcites|[aA]utocites|[fF]ootcites|[sS]martcites|supercites)$/.test(command)) {
            const after = read(state, node.to, Math.min(doc.length, node.to + 2000));
            let at = 0;
            for (;;) {
              const optionals: string[] = [];
              let next = at;
              for (;;) {
                const space = /^[ \t]*\n?[ \t]*/.exec(after.slice(next))![0].length;
                const optional = after[next + space] === "[" ? readOptional(after, next + space) : null;
                if (!optional || optionals.length === 2) break;
                optionals.push(optional.content);
                next = optional.end;
              }
              const space = /^[ \t]*\n?[ \t]*/.exec(after.slice(next))![0].length;
              const group = after[next + space] === "{" ? readGroup(after, next + space) : null;
              if (!group) break;
              const groupKeys = group.content.split(",").map((key) => key.trim()).filter(Boolean);
              const groupNotes = citationNotes(optionals, defs, node.from);
              if (!groupKeys.length || /[{}\\]/.test(group.content) || !notesUnderstood(groupNotes)) return false;
              more.push({ keys: groupKeys, notes: groupNotes });
              at = group.end;
            }
            if (more.length) { to = node.to + at; consumed.push([node.from, to]); }
          }
          emit({
            kind: name === "Cite" ? "cite" : "ref", from: node.from, to, reveal: "strict",
            replaces: [{ from: node.from, to, widget: new ChipWidget(name === "Cite" ? "cite" : "ref", command, keys, notes, to - node.from, more) }],
          });
          return false;
        }
        case "Label": {
          if (!structural) return false;
          const argument = node.getChild("LabelArgument");
          const inner = argument && argumentInner(argument);
          // cleveref's `\label[Property]{key}`: the grammar ends at the `[`; the chip takes the optional type and the group after it.
          const typed = !argument ? /^\[[^\][{}]*\]\s*\{([^{}]*)\}/.exec(read(state, node.to, Math.min(doc.length, node.to + 300))) : null;
          if (typed && typed[1].trim()) {
            const to = node.to + typed[0].length;
            consumed.push([node.from, to]);
            emit({ kind: "label", from: node.from, to, reveal: "strict", replaces: [{ from: node.from, to, widget: new ChipWidget("label", "\\label", [typed[1].trim()], {}, to - node.from) }] });
            return false;
          }
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
        // Side-by-side `\parbox{0.45\textwidth}{…}\hfill\parbox{…}{…}`: columns.
        case "ParBoxCommand": {
          const command = node.parent?.parent;
          if (command?.name === "Command" && drawColumns(command) === false) return false;
          // A single `\parbox{w}{…}` in the text: its text (a list in it is drawn as lists are).
          return starts ? textWrapper(node, "\\parbox") ?? undefined : undefined;
        }
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
          if (defs.lists?.has(environmentName(node, readNode) ?? "") || PARALIST[environmentName(node, readNode) ?? ""] || isGenericList(node)) return drawList(node);
          // AASTeX's `deluxetable`: a table float of its own commands; one it cannot read stays as it was.
          if (/^deluxetable\*?$/.test(environmentName(node, readNode) ?? "") && !defs.environments.has(environmentName(node, readNode)!)) return drawDeluxeTable(node) ?? environment(node);
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
          if ((boxEnvironments(doc, defs).has(environmentName(node, readNode) ?? "") || FRAMED_PROSE.test(environmentName(node, readNode) ?? "")) && !defs.environments.has(environmentName(node, readNode) ?? "")) return drawBox(node);
          // Side-by-side minipages outside floats: columns.
          if (environmentName(node, readNode) === "minipage" && drawColumns(node) === false) return false;
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
          const title = readTitleParts(state, node.from, titleClass(defs, defs.documentClass));
          // `\title{…}`, `\author{…}` and `\date{…}` written in the body right before `\maketitle`: what the title block
          // shows, folded into it (Alt-click shows their source).
          const bodyStart = Math.max(0, env.preambleEnd);
          const run = titleRun(state, defs, bodyStart, node.from);
          // Only within this walk's range, so the construct does not start before what is being built (the structural
          // layer widens a range holding `\maketitle` back to titleRunStart).
          const declarations = run && bodyStart + run.start >= from ? bodyStart + run.start : null;
          // acmart's teaser figure among them is drawn on its own: the block ends before it, and the rest up to `\maketitle` folds away.
          const gaps = declarations !== null ? run!.gaps.map((gap) => ({ from: bodyStart + gap.from, to: bodyStart + gap.to })) : [];
          const trimmed = (start: number, end: number) => {
            while (start < end && /\s/.test(read(state, start, start + 1))) start++;
            while (end > start && /\s/.test(read(state, end - 1, end))) end--;
            return { start, end };
          };
          // A comment after `\maketitle` on its line (cs.LO 2610.41832's `\maketitle%[E]`) is part of its line.
          const commentLine = doc.lineAt(node.to);
          const end = /^[ \t]*%/.test(read(state, node.to, commentLine.to)) ? commentLine.to : node.to;
          const blockEnd = gaps.length ? trimmed(declarations!, gaps[0].from).end : end;
          const folded = declarations !== null ? aloneOnLines(doc, declarations, blockEnd) : null;
          const span = folded ?? aloneOnLines(doc, node.from, end);
          const range = span ?? { from: node.from, to: node.to };
          if (range.from < node.from) consumed.push([range.from, Math.min(node.from, range.to)]);
          // An abstract and keywords in the run are printed with the title (amsart's abstract before `\maketitle`).
          const inRun = folded ? run : null;
          // With a command left as source in the run, the block ends before it but its parts are read up to `\maketitle`.
          const widget = new TitleWidget(title.title, title.author, title.date, range.to - range.from, inRun?.abstract ?? title.abstract, [...title.notes, ...(inRun?.notes ?? [])], title.details, gaps.length ? end - range.from : null);
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
          // AASTeX's `\bibliography{refs}{}` takes an empty group after it, which prints nothing.
          const empty = /^[ \t]*\{\s*\}/.exec(read(state, node.to, Math.min(doc.length, node.to + 20)));
          const span = aloneOnLines(doc, node.from, node.to + (empty?.[0].length ?? 0));
          if (!structural || !inner || !span || hasDirectError(node)) return false;
          if (empty) consumed.push([node.to, node.to + empty[0].length]);
          emit({ kind: "bibliography", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new BibliographyListWidget(bibliographyHeading(defs), read(state, inner.from, inner.to).trim(), span.to - span.from) }] });
          return false;
        }
        case "BibliographyStyleCommand": {
          // `\bibliographystyle{plain}` prints nothing: its own line folds away.
          if (structural && !hasDirectError(node)) {
            if (aloneOnLines(doc, node.from, node.to)) collapseLine(node, "bibliography-style");
            // After a size switch in a group (`{\footnotesize\bibliographystyle{abbrv}`, 2611.07785): hidden where it stands.
            else emit({ kind: "symbol", from: node.from, to: node.to, reveal: "touch", replaces: [{ from: node.from, to: node.to }] });
          }
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
          // Typing before an existing backslash can leave the caret between the two backslashes.
          if (structural) emit({ kind: "symbol", from: node.from, to: node.to, reveal: "strict", replaces: [{ from: node.from, to: node.to, widget: new LineBreakWidget() }] });
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
          // TeX's single quotes, `` `word' ``: ‘word’ (a pair in this text; an apostrophe alone is left as typed).
          for (const match of text.matchAll(/(?<!`)`(?!`)([^`'\n]*?[^`'\s\n])'(?!')/g)) {
            const open = node.from + match.index!;
            const close = open + match[0].length - 1;
            if (open < symbolsUntil) continue;
            emit({ kind: "symbol", from: open, to: open + 1, reveal: "never", replaces: [{ from: open, to: open + 1, widget: new SymbolWidget("‘", "`") }] });
            emit({ kind: "symbol", from: close, to: close + 1, reveal: "never", replaces: [{ from: close, to: close + 1, widget: new SymbolWidget("’", "'") }] });
          }
          return false;
        }
        case "Centering": case "SetLengthCommand": {
          // `\centering` or `\setlength{\parindent}{0pt}` on a line of layout: it folds away (M-13).
          const line = structural ? layoutLine(state, node.from) : null;
          if (line) { collapseLine(line, "layout"); consumed.push([line.from, line.to]); }
          // `{\centering text\par}` in a line of text: the switch prints nothing there.
          else if (structural && name === "Centering" && /^\\centering$/.test(read(state, node.from, node.to))) emit({ kind: "symbol", from: node.from, to: node.to, reveal: "touch", replaces: [{ from: node.from, to: node.to }] });
          return false;
        }
        case "HorizontalLine":
          return tableRule(node);
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
    // As for a heading: the widget, and the line style while it is drawn.
    emit({
      kind: "heading", from, to: headerEnd, reveal: "line", wholeLine: true,
      replaces: structural ? [{ from, to: headerEnd, widget: new MacroHeadingWidget(book ? "Bibliography" : "References", headerEnd - from) }] : [],
      hiddenLines: [{ from, to: headerEnd, class: `cm-vis-heading ${book ? "cm-vis-h0" : "cm-vis-h1"}` }],
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
  /**
   * Table rules outside a tabular (`\midrule`, `\hline`, `\cmidrule(lr){2-3}`): a file of rows that a parent file `\input`s
   * inside its tabular (astro-ph 2611.07227's `tables/*.tex`) holds them with no table around. They are drawn as the line
   * they are (the rule's own line, or a border on the row they follow); the rows stay text. Inside a tabular, a formula or
   * a macro's body they are left to what draws those. Undefined when this is not such a rule.
   */
  function tableRule(node: SyntaxNode): false | undefined {
    const start = node.from;
    if (isConsumed(node)) return false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (/^(?:TabularEnvironment|TabularContent|DollarMath|BracketMath|ParenMath|EquationEnvironment|EquationArrayEnvironment|NewCommand|RenewCommand|Def)$/.test(parent.name)) return undefined;
      if (parent.name === "Environment" && /^(?:tabular\*?|tabularx|tabulary|longtable\*?|xltabular|array|deluxetable\*?|ruledtabular|supertabular|tabu|NiceTabular)$/.test(environmentName(parent, readNode) ?? "")) return undefined;
    }
    const run = tableRuleRun(read(state, start, Math.min(doc.length, start + 400)));
    if (!run) return undefined;
    const end = start + run.end;
    const line = doc.lineAt(start);
    // A rule run beyond the line's end is not drawn.
    if (end > line.to) return undefined;
    consumed.push([start, end]);
    if (!structural) return false;
    const before = read(state, line.from, start).trim();
    const after = read(state, end, line.to).trim();
    // The line classes apply while the rule is drawn: the cursor on the line shows its source, plain.
    if (!before && !after) {
      emit({ kind: "layout", from: line.from, to: line.to, reveal: "line", wholeLine: true, replaces: [{ from: line.from, to: line.to }], hiddenLines: [{ from: line.from, to: line.from, class: run.heavy ? "cm-vis-rule-row cm-vis-rule-row-heavy" : "cm-vis-rule-row" }] });
    } else {
      emit({ kind: "symbol", from: start, to: end, reveal: "line", wholeLine: true, replaces: [{ from: start, to: end }], hiddenLines: [{ from: line.from, to: line.from, class: after ? "cm-vis-rule-above" : "cm-vis-rule-below" }] });
    }
    return false;
  }

  /** LaTeX's own `list` and `trivlist` (unless the document defines an environment of that name). */
  function isGenericList(node: SyntaxNode) {
    if (node.name !== "Environment") return false;
    const name = environmentName(node, readNode) ?? "";
    return GENERIC_LISTS.test(name) && !defs.environments.has(name);
  }

  function drawList(node: SyntaxNode): undefined {
    const formed = wellFormedEnvironment(node, state);
    if (!formed) return undefined;
    // enumitem's lists of the document's own (`\newlist{exercises}{enumerate}{6}`) are lists of their kind.
    // LaTeX's `list` and `trivlist`: an itemize or enumerate by their label, whose layout arguments are not drawn.
    const generic = isGenericList(node) ? genericListHead(node, state) : null;
    if (isGenericList(node) && !generic) return undefined;
    const custom = generic?.kind ?? defs.lists?.get(formed.name) ?? PARALIST[formed.name];
    const list = listContext(node, custom ?? formed.name, lists, state, 0);
    if (generic) { list.template = generic.template; list.plain = generic.plain; }
    if (!list.template && defs.lists?.has(formed.name)) list.template = customListLabel(defs, formed.name, list.depth);
    if ((/^inpara/.test(formed.name) || formed.name.endsWith("*")) && !defs.lists?.has(formed.name)) list.inline = true;
    lists.push(list);
    if (structural) {
      collapseLine(formed.begin, "list-begin");
      // Past the walked range, the piece with the `\end` line draws it (see above): a list of hundreds of items is not walked whole.
      if (formed.end.from < to) collapseLine(formed.end, "list-end");
    }
    if (formed.content && !list.inline) {
      const first = doc.lineAt(formed.begin.to).number + 1;
      const last = doc.lineAt(formed.end.from).number - 1;
      if (last >= first) emit({ kind: "list-body", from: node.from, to: node.to, reveal: "never", replaces: [], lines: [{ from: doc.line(first).from, to: doc.line(last).to, class: `cm-vis-list cm-vis-list-d${Math.min(6, list.depth)}` }] });
    }
    return undefined;
  }

  /**
   * Code: `\verb|…|` and `\lstinline|…|` in the typewriter face, their markup hidden; a `verbatim`, `lstlisting` or `minted`
   * block as its lines, as written, in the typewriter face (edited in place), its `\begin` and `\end` lines folded away
   * (listings' caption drawn over it). One whose delimiters or options are not closed on their line stays source.
   */
  function drawCode(node: SyntaxNode, starts: boolean) {
    if (node.name === "VerbCommand" || node.name === "LstInlineCommand") {
      const content = node.getChild("VerbContent") ?? node.getChild("LstInlineContent");
      const range = content ? inlineCodeRange(read(state, content.from, content.to)) : null;
      if (!content || !range || content.from + range.to + 1 !== node.to) return;
      inlineCode(node.from, content.from + range.from, content.from + range.to, node.to);
      return;
    }
    const formed = wellFormedEnvironment(node, state);
    if (!formed || !CODE_ENVIRONMENTS.test(formed.name) || !formed.content) return;
    const header = readCodeHeader(formed.name, read(state, formed.content.from, Math.min(formed.content.to, formed.content.from + 2000)));
    if (!header) return;
    const headerEnd = formed.content.from + header.end;
    const opening = aloneOnLines(doc, formed.begin.from, headerEnd);
    const closing = aloneOnLines(doc, formed.end.from, formed.end.to);
    if (!opening || !closing || doc.lineAt(opening.from).number !== doc.lineAt(headerEnd).number) return;
    if (structural) {
      if (!starts) {
        if (closing.from >= from) collapseLine(closing, "code-end");
        return;
      }
      if (header.caption) {
        const widget = new CodeCaptionWidget(header.caption, header.numbered, node.from - opening.from);
        emit({ kind: "env-header", from: opening.from, to: opening.to, reveal: "line", wholeLine: true, replaces: [{ from: opening.from, to: opening.to, widget }] });
      } else collapseLine(opening, "code-begin");
      if (closing.from < to) collapseLine(closing, "code-end");
    }
    const first = doc.lineAt(opening.to).number + 1;
    const last = doc.lineAt(closing.from).number - 1;
    if (last < first) return;
    const body = { from: doc.line(first).from, to: doc.line(last).to };
    const marks = codeTokens(read(state, body.from, body.to), header.language).map((token) => ({ from: body.from + token.from, to: body.from + token.to, class: token.class }));
    emit({ kind: "code-body", from: node.from, to: node.to, reveal: "never", replaces: [], marks, lines: [{ ...body, class: "cm-vis-code-line" }] });
  }

  /** Inline code from `from` to `to` (its markup around it hidden): typewriter text, edited in place. */
  function inlineCode(from: number, codeFrom: number, codeTo: number, to: number) {
    if (codeTo <= codeFrom) return;
    emit({
      kind: "style", from, to, reveal: "touch",
      replaces: structural ? [{ from, to: codeFrom }, { from: codeTo, to }] : [],
      marks: [{ from: codeFrom, to: codeTo, class: "cm-vis-code-inline" }],
    });
    consumed.push([from, to]);
    symbolsUntil = Math.max(symbolsUntil, to);
  }

  /** AASTeX's `deluxetable` (2611.08676): its caption, rows and notes as a table float, drawn read-only; null when it cannot be read. */
  function drawDeluxeTable(node: SyntaxNode): false | null {
    if (!wellFormedEnvironment(node, state)) return null;
    const table = readDeluxeTable(read(state, node.from, node.to));
    if (!table || !parseTabular(table.tabular, 0, defs.columnTypes)?.rows.length) return null;
    if (!structural) return false;
    const span = aloneOnLines(doc, node.from, node.to);
    const range = span ?? { from: node.from, to: node.to };
    const spec: FigureSpec = {
      env: "deluxetable", images: [], tabulars: [{ source: table.tabular, offset: node.from - range.from, readOnly: true }], caption: table.caption,
      captionPos: table.captionAt >= 0 ? node.from + table.captionAt : node.from, captionAbove: true, kind: "table", numberOffset: node.from - range.from,
      notes: table.notes.length ? table.notes : undefined, start: range.from, length: range.to - range.from,
    };
    emit({ kind: "figure", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new FigureWidget(spec) }] });
    return false;
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
   * Side-by-side minipages or `\parbox`es outside floats (separated by `\hfill`, `\hspace{…}`, `%` lines, not a blank
   * line), at `item` (the run's first; a later one is covered by it): columns at their widths, drawn once for the run.
   * False when drawn, null when not columns (a single box, one not complete, one in a group).
   */
  function drawColumns(item: SyntaxNode): false | null {
    const columnOf = (candidate: SyntaxNode) => {
      if (candidate.name === "Environment" && environmentName(candidate, readNode) === "minipage") {
        const formed = wellFormedEnvironment(candidate, state);
        const opening = /^\\begin\s*\{minipage\}\s*(?:\[[^\]]*\]\s*){0,3}\{[^{}]*\}/.exec(read(state, candidate.from, Math.min(candidate.to, candidate.from + 300)));
        if (!formed || !opening || hasDirectError(candidate)) return null;
        const from = candidate.from + opening[0].length;
        return { from, to: Math.max(from, formed.end.from), width: minipageWidth(opening[0]) };
      }
      const command = candidate.name === "Command" ? candidate.firstChild?.getChild("ParBoxCommand") : null;
      if (!command || hasDirectError(command)) return null;
      const args = commandArguments(command).filter((arg) => !arg.optional);
      const width = args[0] && argumentInner(args[0].node);
      const body = args[1] && argumentInner(args[1].node);
      if (args.length !== 2 || !width || !body) return null;
      return { from: body.from, to: body.to, width: graphicsWidth(`width=${read(state, width.from, width.to).trim()}`) };
    };
    const gap = (candidate: SyntaxNode) => candidate.name === "NewLine" || candidate.name === "Whitespace" || candidate.name === "Comment"
      || (candidate.name === "Command" && /^\\(?:hfill|hfil|hspace\*?\s*\{[^{}]*\}|quad|qquad|enspace|enskip)$/.test(read(state, candidate.from, candidate.to).trim()));
    if (!structural) return null;
    for (let parent = item.parent; parent; parent = parent.parent) {
      if (parent.name === "TextArgument" || parent.name === "Group" || parent.name === "NonEmptyGroup" || parent.name === "FigureEnvironment" || parent.name === "TableEnvironment") return null;
    }
    let first = item;
    for (let previous = item.prevSibling; previous && (gap(previous) || columnOf(previous)); previous = previous.prevSibling) if (!gap(previous)) first = previous;
    const items: SyntaxNode[] = [];
    let lastNewLine = false;
    for (let next: SyntaxNode | null = first; next && (gap(next) || columnOf(next)); next = next.nextSibling) {
      // A blank line between two boxes (two newlines in a row) sets them one above the other.
      if (next.name === "NewLine") { if (lastNewLine) break; lastNewLine = true; continue; }
      if (next.name !== "Whitespace") lastNewLine = false;
      if (!gap(next)) items.push(next);
    }
    const columns = items.map(columnOf);
    if (items.length < 2 || columns.some((column) => !column)) return null;
    const span = aloneOnLines(doc, first.from, items.at(-1)!.to);
    if (!span) return null;
    if (item.from !== first.from) return false;
    consumed.push([span.from, span.to]);
    const spec = columns.map((column) => ({ offset: column!.from - span.from, length: column!.to - column!.from, body: read(state, column!.from, column!.to), ...(column!.width ? { width: column!.width } : {}) }));
    emit({ kind: "columns", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new ColumnsWidget(spec, span.to - span.from, graphicsBase(state)) }] });
    return false;
  }

  /**
   * A tcolorbox or mdframed box in the text (a `\newtcolorbox` of the document too): a frame around its lines, its
   * title (`title=…`) as its first line; its `\begin` and `\end` lines fold away. One whose `\begin` or `\end` shares
   * its line with text stays source, its content drawn as text.
   */
  function drawBox(node: SyntaxNode): undefined {
    const formed = wellFormedEnvironment(node, state);
    const use = formed && boxUse(node, state, true, defs);
    if (!formed || !use) return undefined;
    const beginSpan = aloneOnLines(doc, formed.begin.from, use.end);
    const endSpan = aloneOnLines(doc, formed.end.from, formed.end.to);
    if (!beginSpan || !endSpan) return undefined;
    consumed.push([formed.begin.from, use.end]);
    if (structural) {
      const header = { from: beginSpan.from, to: beginSpan.to };
      if (use.title) emit({ kind: "env-header", ...header, reveal: "line", wholeLine: true, replaces: [{ ...header, widget: new EnvironmentHeaderWidget("user", `\\textbf{${use.title}}`, null, use.counted ? "counter" : null, use.counted ? formed.begin.from - beginSpan.from : 0, beginSpan.to - beginSpan.from) }] });
      else emit({ kind: "env-begin", ...header, reveal: "line", wholeLine: true, replaces: [header], hiddenLines: [{ ...header, class: "cm-vis-collapsed" }] });
      collapseLine(formed.end, "env-end");
    }
    // The framed lines: the title's, then the content's (the first and last close the frame).
    const first = use.title ? doc.lineAt(beginSpan.from).number : doc.lineAt(beginSpan.to).number + 1;
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
    const trimEnd = (start: number, end: number) => { while (end > start && /\s/.test(read(state, end - 1, end))) end--; return end; };
    const end = trimEnd(formed.begin.to, stop);
    // A command left as source (one the class's front matter does not hold here): the block ends before the first,
    // each stays source, and the commands between and after them fold away (title-edit reads up to `end`).
    const gaps = parts.unknown.map((gap) => ({ from: formed.begin.to + gap.from, to: formed.begin.to + gap.to }));
    const span = aloneOnLines(doc, formed.begin.from, gaps.length ? trimEnd(formed.begin.to, gaps[0].from) : end);
    if (!span) return undefined;
    const rests = gaps.map((gap, index) => {
      const restEnd = trimEnd(gap.to, index + 1 < gaps.length ? gaps[index + 1].from : end);
      let restStart = gap.to;
      while (restStart < restEnd && /\s/.test(read(state, restStart, restStart + 1))) restStart++;
      return restEnd > restStart ? aloneOnLines(doc, restStart, restEnd) : null;
    });
    consumed.push([span.from, span.to]);
    for (const rest of rests) if (rest) consumed.push([rest.from, rest.to]);
    if (structural) {
      const authorCount = parts.author ? parts.author.split(/\\(?:and|And|AND)(?![A-Za-z])/).filter((piece) => piece.trim()).length : 0;
      const details = detailsView(frontMatterDetails(read(state, formed.begin.to, stop), formed.begin.to, defs.documentClass ?? "", authorCount, true));
      emit({ kind: "title", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new TitleWidget(parts.title, parts.author, parts.date, span.to - span.from, null, [], details, gaps.length ? end - span.from : null) }] });
      for (const rest of rests) if (rest) collapseLine(rest, "title-rest");
      collapseLine(formed.end, "env-end");
    }
    return undefined;
  }

  function environment(node: SyntaxNode): false | undefined {
    const formed = wellFormedEnvironment(node, state);
    if (!formed) return undefined;
    // IEEEtran's `IEEEproof` is amsthm's `proof` (its optional `[Proof of …]` heading and end mark), unless the document defines it.
    const name = formed.name === "IEEEproof" && !defs.environments.has("IEEEproof") && !defs.theorems.has("IEEEproof") ? "proof" : formed.name;
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
    // IEEEtran's `\begin{IEEEbiographynophoto}{Name} … \end{IEEEbiographynophoto}` (and `IEEEbiography[{photo}]{Name}`): the
    // name in bold italics over the biography's text; the photo (an `\includegraphics`) is a "[photo]" mark. Its begin line shows
    // the source on a click (reveal "line"), as the other environment headers do.
    if ((name === "IEEEbiographynophoto" || name === "IEEEbiography") && !defs.environments.has(name)) {
      const nameEnd = formed.begin.getChild("EnvNameGroup")?.to ?? formed.begin.to;
      const head = /^(\s*\[(?:[^[\]{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\])?\s*\{((?:[^{}\\]|\\[A-Za-z]+\s*)*)\}/.exec(read(state, nameEnd, Math.min(doc.length, nameEnd + 600)));
      if (!head || (head[1] && !/\\includegraphics/.test(head[1])) || (name === "IEEEbiographynophoto" && head[1])) return undefined;
      const headerEnd = nameEnd + head[0].length;
      consumed.push([formed.begin.from, headerEnd]);
      if (structural) {
        const span = aloneOnLines(doc, formed.begin.from, headerEnd);
        const from = span?.from ?? formed.begin.from;
        const label = `${head[1] ? "[photo] " : ""}${head[2].replace(/\\[A-Za-z]+\s*/g, "").replace(/\s+/g, " ").trim()}`;
        emit({ kind: "env-header", from, to: headerEnd, reveal: "line", wholeLine: true, replaces: [{ from, to: headerEnd, widget: new BiographyHeaderWidget(label, headerEnd - from) }] });
        collapseLine(formed.end, "env-end");
      }
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
    // sgame's `\begin{game}{2}{2}[Row][Column] … \end{game}` (2611.05706): a strategic-form game, drawn as a table when its rows
    // and columns are those it declares (read-only: the table is a reading, a click shows the source).
    if (name === "game" && !defs.environments.has("game") && defs.packages.includes("sgame")) {
      const game = gameTabular(read(state, node.from, formed.end.from));
      if (!game) return undefined;
      if (!structural) return false;
      const span = aloneOnLines(doc, node.from, node.to);
      const range = span ?? { from: node.from, to: node.to };
      consumed.push([node.from, node.to]);
      emit({ kind: "table", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new TableWidget(game.tabular, 0, range.to - range.from, true) }] });
      return false;
    }
    // A `minipage` in the text (a list set in a narrower box): its text, its opening (with the width) and end folded away.
    if (name === "minipage") {
      const nameEnd = formed.begin.getChild("EnvNameGroup")?.to ?? formed.begin.to;
      const head = /^(?:\s*\[[^\]\n]*\]){0,3}\s*\{[^{}\n]*(?:\{[^{}\n]*\}[^{}\n]*)*\}/.exec(read(state, nameEnd, Math.min(doc.length, nameEnd + 200)));
      if (!head) return undefined;
      const headerEnd = nameEnd + head[0].length;
      consumed.push([formed.begin.from, headerEnd]);
      if (structural) {
        collapseLine({ from: formed.begin.from, to: headerEnd }, "env-begin");
        collapseLine(formed.end, "env-end");
      }
      return undefined;
    }
    // `adjustbox`, `multicols`, `sideways`, `lrbox`…: a box or layout around their content, drawn as if they were not there
    // (an lrbox's content is faded: LaTeX saves it for `\usebox`); their `\begin` with its arguments and `\end` fold away.
    const wrapper = Object.hasOwn(WRAPPER_ENVIRONMENTS, name) && !defs.environments.has(name) ? WRAPPER_ENVIRONMENTS[name] : null;
    if (wrapper) {
      const nameEnd = formed.begin.getChild("EnvNameGroup")?.to ?? formed.begin.to;
      const argsEnd = readEnvironmentArguments(read(state, nameEnd, Math.min(doc.length, nameEnd + 600)), wrapper.args);
      if (argsEnd === null) return undefined;
      const headerEnd = nameEnd + argsEnd;
      consumed.push([formed.begin.from, headerEnd]);
      if (structural) {
        collapseLine({ from: formed.begin.from, to: headerEnd }, "env-begin");
        collapseLine(formed.end, "env-end");
      }
      if (wrapper.lines && formed.content && formed.content.to > headerEnd) {
        const bodyFrom = doc.lineAt(Math.min(doc.length, headerEnd + 1)).from;
        const bodyTo = doc.lineAt(Math.max(formed.end.from - 1, 0)).to;
        if (bodyTo >= bodyFrom) emit({ kind: "env-body", from: headerEnd, to: formed.end.from, reveal: "never", replaces: [], lines: [{ from: bodyFrom, to: bodyTo, class: wrapper.lines }] });
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
      // The proof's own `\renewcommand{\qedsymbol}{$\blacksquare$}` right after its header on the same line (math.CO 2611.13390):
      // hidden as part of the header's construct, so the cursor anywhere on the line shows the whole line's source, the
      // command's too (a construct of its own would lose the reveal to the header, whose range is longer).
      let qedRenewal: { from: number; to: number } | null = null;
      if (name === "proof" && structural && !block) {
        const after = read(state, headerEnd, Math.min(doc.length, headerEnd + 400));
        const renewal = /^[ \t]*\\renewcommand\*?[ \t]*\{[ \t]*\\qedsymbol[ \t]*\}[ \t]*(?=\{)/.exec(after);
        const body = renewal ? readGroup(after, renewal[0].length, TEX_GROUPS) : null;
        if (body && headerEnd + body.end <= formed.end.from) {
          qedRenewal = { from: headerEnd, to: headerEnd + body.end };
          consumed.push([headerEnd, qedRenewal.to]);
        }
      }
      if (structural) {
        emit({ kind: "env-header", from: span?.from ?? begin.from, to: qedRenewal?.to ?? headerEnd, reveal: "line", wholeLine: true, replaces: [{ from: span?.from ?? begin.from, to: headerEnd, widget: header }, ...(qedRenewal ? [qedRenewal] : [])] });
        if (name === "proof") {
          const endSpan = aloneOnLines(doc, formed.end.from, formed.end.to);
          // amsthm's end mark (□, or the document's `\renewcommand{\qedsymbol}{$\blacksquare$}`); ∎ without it.
          // (Looked up just inside the proof: a `\renewcommand` written in it lasts to its `\end`.)
          // A mark renewed in the proof itself is out of scope at its `\end`, so it is drawn from its expansion.
          const qedAt = Math.max(begin.to, formed.end.from - 1);
          const qedMacro = macroAt(defs, "qedsymbol", qedAt);
          const qedLocal = qedMacro && qedMacro.pos >= 0 ? expandLatexMacros("\\qedsymbol", defs, { mode: "text", pos: qedAt }) : null;
          const qed = qedMacro ? (qedLocal?.ok ? qedLocal.text : "\\qedsymbol") : null;
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

  /** A `\setcounter{c}{n}` (`\addtocounter`, `\stepcounter`, `\refstepcounter`) with its arguments: folded or hidden; false when malformed. */
  function counterCommandHidden(node: SyntaxNode, text: string) {
    const mandatory = commandArguments(node).filter((arg) => !arg.optional);
    if (mandatory.length !== (/^\\(?:set|addto)counter$/.test(text) ? 2 : 1) || hasDirectError(node) || mandatory.some((arg) => !argumentInner(arg.node))) return false;
    if (!structural) return true;
    const line = layoutLine(state, node.from);
    if (line) { collapseLine(line, "layout"); consumed.push([line.from, line.to]); return true; }
    const end = mandatory[mandatory.length - 1].node.to;
    emit({ kind: "symbol", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: end }] });
    consumed.push([node.from, end]);
    return true;
  }

  /**
   * A command wrapping text (`TEXT_WRAPPERS`: `\added{…}`, `\replaced{new}{old}`, `\hl{…}`, `\fbox{…}`, `\parbox{w}{…}`,
   * `\enquote{…}`; xcolor's `\fcolorbox{frame}{fill}{…}`): its markup and hidden arguments are hidden, its text styled and
   * edited in place; its options (`\added[id=R1]{…}`) are hidden. Null when it is none of these, the document defines it,
   * or its arguments are broken (it stays source).
   */
  function textWrapper(node: SyntaxNode, text: string): undefined | null {
    const box = text === "\\fcolorbox" ? { args: [null, null, "cm-vis-fbox"] } : null;
    const spec: { args: Array<string | null>; open?: string; close?: string; package?: string } | undefined = box ?? (Object.hasOwn(STYLED_WRAPPERS, text) ? STYLED_WRAPPERS[text] : undefined);
    if (!spec || macroAt(defs, text.slice(1), node.from) || hasDirectError(node)) return null;
    if (spec.package && !defs.packages.includes(spec.package)) return null;
    const args = commandArguments(node);
    const used = args.filter((arg) => !arg.optional).slice(0, spec.args.length);
    // Options only before the arguments: what follows them is text.
    if (used.length < spec.args.length || args.some((arg) => arg.optional && arg.node.from > used[used.length - 1].node.from)) return null;
    const inners = used.map((arg) => argumentInner(arg.node));
    if (inners.some((inner) => !inner)) return null;
    let style: string | undefined;
    if (box) {
      const frame = cssColor(null, read(state, inners[0]!.from, inners[0]!.to), defs.colors);
      const fill = cssColor(null, read(state, inners[1]!.from, inners[1]!.to), defs.colors);
      if (!frame || !fill) return null;
      style = `border-color: ${frame}; background: color-mix(in srgb, ${fill} 35%, transparent)`;
    }
    const end = used[used.length - 1].node.to;
    const replaces: Replace[] = [];
    const marks: Mark[] = [];
    let hiddenFrom = node.from;
    let shown = 0;
    spec.args.forEach((className, index) => {
      if (className === null) return;
      const inner = inners[index]!;
      // Between two shown arguments (`\replaced{new}{old}`), a space.
      const open = shown === 0 ? spec.open : " ";
      replaces.push({ from: hiddenFrom, to: inner.from, widget: open ? new SymbolWidget(open, text) : undefined });
      if (className && inner.to > inner.from) marks.push({ from: inner.from, to: inner.to, class: className, attributes: style ? { style } : undefined });
      hiddenFrom = inner.to;
      shown++;
    });
    replaces.push({ from: hiddenFrom, to: end, widget: spec.close ? new SymbolWidget(spec.close, text) : undefined });
    emit({ kind: "style", from: node.from, to: end, reveal: "touch", replaces: structural ? replaces : [], marks });
    // The hidden arguments (a `\parbox`'s width, `\fcolorbox`'s colours) are not walked.
    spec.args.forEach((className, index) => { if (className === null) consumed.push([used[index].node.from, used[index].node.to]); });
    return undefined;
  }

  function unknownCommand(node: SyntaxNode): false | undefined {
    const ctrl = node.firstChild;
    if (!ctrl) return undefined;
    const text = read(state, ctrl.from, ctrl.to);
    // A title block written by hand in a body file (`\def\@title{…}` `\def\@author{…}` then `\arxivmaketitle`, a macro the
    // main preamble `\let`s to `\@maketitle`): the title block, over those lines. Alt-click and the cursor show the source.
    const hand = handTitleBlock(state, defs, node, env.preambleEnd);
    if (hand) {
      if (hand.from < from) return false;
      if (structural) emit({ kind: "title", from: hand.from, to: hand.to, reveal: "strict", replaces: [{ from: hand.from, to: hand.to, block: true, widget: new TitleWidget(hand.title, hand.author, hand.date, hand.to - hand.from) }] });
      consumed.push([hand.from, node.from]);
      return false;
    }
    // booktabs' `\cmidrule`, `\cline` and `\specialrule` outside a tabular: a rule line, as `\midrule` and `\hline` are.
    if (/^\\(?:cline|cmidrule|specialrule)$/.test(text)) {
      const rule = tableRule(node);
      if (rule !== undefined) return rule;
    }
    // linguex's numbered examples (cs.CL 2611.11838): `\ex.` is "(1)", its parts `\a.` and `\b.` are "a.", "b.".
    if (LINGUEX_MARKER.test(text) && read(state, ctrl.to, ctrl.to + 1) === "." && defs.packages.includes("linguex") && !macroAt(defs, text.slice(1), node.from)) {
      if (structural) emit({ kind: "symbol", from: node.from, to: ctrl.to + 1, reveal: "touch", replaces: [{ from: node.from, to: ctrl.to + 1, widget: new ExampleMarkerWidget(text === "\\a" || text === "\\b") }] });
      consumed.push([node.from, ctrl.to + 1]);
      return false;
    }
    // The separators between keywords: llncs's and svjour3's `\keywords{a \and b}` (a centred dot), elsarticle's `\sep` (a comma).
    if ((text === "\\and" || (text === "\\sep" && defs.documentClass === "elsarticle")) && !commandArguments(node).length && structural) {
      let inKeywords = text === "\\sep";
      for (let parent = node.parent; parent && !inKeywords; parent = parent.parent) {
        if (parent.name === "UnknownCommand" && parent.firstChild && read(state, parent.firstChild.from, parent.firstChild.to) === "\\keywords") inKeywords = true;
      }
      if (inKeywords) {
        // "First \sep Second" is "First, Second": the space before `\sep` goes with it.
        const from = text === "\\sep" ? ctrl.from - (/[ \t]*$/.exec(read(state, Math.max(doc.lineAt(ctrl.from).from, ctrl.from - 20), ctrl.from))?.[0].length ?? 0) : ctrl.from;
        emit({ kind: "symbol", from, to: ctrl.to, reveal: "touch", replaces: [{ from, to: ctrl.to, widget: new SymbolWidget(text === "\\sep" ? "," : "·", text) }] });
        return false;
      }
    }
    // revtex's `\acknowledgments` (a command, not an environment; its text runs to the next section or `\bibliography`): the
    // unnumbered "Acknowledgments" heading, as the `ack` environment draws it; the line is its source with the cursor on it.
    if (/^\\acknowledge?ments?$/.test(text) && !commandArguments(node).length && !hasDirectError(node) && !macroAt(defs, text.slice(1), node.from)) {
      const span = aloneOnLines(doc, node.from, ctrl.to);
      if (span) {
        if (structural) emit({ kind: "env-header", from: span.from, to: span.to, reveal: "line", wholeLine: true, replaces: [{ from: span.from, to: span.to, widget: new EnvironmentHeaderWidget("abstract", "Acknowledgments", null, null, 0) }] });
        return false;
      }
    }
    // biblatex's `\printbibliography[title=…]`: the References list, on its own lines only.
    if (text === "\\printbibliography") {
      const end = commandArguments(node).filter((arg) => arg.optional).at(-1)?.node.to ?? ctrl.to;
      // A trailing comment (`\printbibliography % print bibliography`, math.ST 2611.09087) is part of the line.
      const comment = /^[ \t]*%[^\n]*/.exec(read(state, end, doc.lineAt(end).to))?.[0].length ?? 0;
      const span = aloneOnLines(doc, node.from, end + comment);
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
      // `\twocolumn[{ … }]`'s own `{`, and where its `}` is: the wrapper's delimiters (a braced content only when the group is all of it).
      const contentFrom = ctrl.to + (open?.[0].length ?? 0);
      const groupAt = block ? block.content.search(/\S/) : -1;
      const group = block && block.content[groupAt] === "{" ? readGroup(block.content, groupAt, TEX_GROUPS) : null;
      const wrapped = group && !block!.content.slice(group.end).trim() ? group : null;
      if (block && icml) {
        const end = ctrl.to + block.end;
        const span = aloneOnLines(doc, node.from, end);
        const range = span ?? { from: node.from, to: end };
        consumed.push([range.from, range.to]);
        if (structural) emit({ kind: "title", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new TitleWidget(icml.title, icml.author, null, range.to - range.from, icml.abstract, [], icml.details) }] });
        return false;
      }
      // CVPR's `\twocolumn[{\maketitle \begin{center}…\captionof{figure}{…}\end{center}}]`: the title (its `\maketitle`
      // is walked as usual), then the teaser figure, numbered at its `\captionof`; the wrapper's opening folds away.
      const teaser = wrapped ? teaserFigure(wrapped.content) : null;
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
      // Any other `\twocolumn[{ … }]` or `\twocolumn[ … ]` (a title block, text set across both columns): a wrapper. Its content is
      // drawn as it would be outside, the `\twocolumn[{` and `}]` fold away (the cursor on their lines shows them).
      if (block && open && !teaser && !hasDirectError(node) && block.content.trim()) {
        const openingEnd = wrapped ? contentFrom + groupAt + 1 : contentFrom;
        const closing = { from: wrapped ? contentFrom + wrapped.end - 1 : ctrl.to + block.end - 1, to: ctrl.to + block.end };
        if (closing.from >= openingEnd) {
          consumed.push([node.from, openingEnd], [closing.from, closing.to]);
          if (structural) {
            collapseLine({ from: node.from, to: openingEnd }, "env-begin");
            collapseLine(closing, "env-end");
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
    // jmlr's `\tableref{tab:x}` / `\sectionref` / `\appendixref` (jmlrutils.sty: "Table 3"), prettyref's `\prettyref{eq:x}` and cleveref's
    // `\Cpageref{x}`: a reference chip (clicking it shows the source like any chip, see ChipWidget).
    {
      const refName = /^\\([A-Za-z]+)ref$/.exec(text)?.[1];
      const jmlr = !!refName && Object.hasOwn(JMLR_REF_WORDS, refName) && (/^jmlr/.test(defs.documentClass ?? "") || defs.packages.includes("jmlrutils"));
      const pretty = text === "\\prettyref" && defs.packages.includes("prettyref") && !macroAt(defs, "prettyref", node.from);
      const page = /^\\[cC]pageref$/.test(text) && !macroAt(defs, text.slice(1), node.from);
      if (jmlr || pretty || page) {
        const argument = commandArguments(node).find((arg) => !arg.optional);
        const inner = argument && argumentInner(argument.node);
        const keys = inner ? read(state, inner.from, inner.to).split(",").map((key) => key.trim()).filter(Boolean) : [];
        if (inner && argument && keys.length && !keys.some((key) => /[\\{}]/.test(key)) && !hasDirectError(node) && !read(state, ctrl.to, argument.node.from).trim() && (!pretty || prettyrefText(state, keys) !== null)) {
          if (structural) emit({ kind: "ref", from: node.from, to: argument.node.to, reveal: "strict", replaces: [{ from: node.from, to: argument.node.to, widget: new ChipWidget("ref", text, keys, {}, argument.node.to - node.from) }] });
          return false;
        }
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
      // The bookmark's group on the next line (`\texorpdfstring{Proof of $H$}` newline `{From H}`, 2611.07413): the parser does not
      // take it as the command's argument, so it is read from the text.
      const next = args.length === 1 && first ? /^[ \t]*\n?[ \t]*/.exec(read(state, args[0].node.to, Math.min(doc.length, args[0].node.to + 200)))![0].length : 0;
      const written = next ? argumentGroups(read(state, args[0].node.to, Math.min(doc.length, args[0].node.to + 4000)), args[0].node.to, next, 1)?.[0] : null;
      if (first && (args.length === 2 || written) && !hasDirectError(node)) {
        const end = args.length === 2 ? args[1].node.to : written!.close + 1;
        consumed.push([first.to, end]);
        emit({ kind: "style", from: node.from, to: end, reveal: "touch", replaces: structural ? [{ from: node.from, to: first.from }, { from: first.to, to: end }] : [] });
        return undefined;
      }
    }
    // `\setcounter{enumi}{3}` in a list: its next item is 4.
    if (/^\\(?:set|addto|step|refstep)counter$/.test(text)) {
      for (let i = lists.length - 1; i >= 0; i--) {
        if (lists[i].variant !== "number") continue;
        const change = counterChange(state, node, enumCounter(lists[i].depth));
        if (change) { lists[i].count = change(lists[i].count); break; }
      }
      // It prints nothing: a line of them folds away, and one in a line of text (`\setcounter{enumi}{6} \item …`) is hidden.
      if (counterCommandHidden(node, text)) return false;
    }
    // `\footnotemark` (`[n]`): the note's number, as a footnote's mark; the `\footnotetext` after it has the note.
    if (text === "\\footnotemark") {
      const optional = read(state, ctrl.to, ctrl.to + 1) === "[" ? commandArguments(node).find((arg) => arg.optional) : null;
      // An empty group after it (`\footnotemark{}`) prints nothing: it is part of the mark.
      const empty = /^\{\s*\}/.exec(read(state, optional ? optional.node.to : ctrl.to, Math.min(doc.length, (optional ? optional.node.to : ctrl.to) + 8)));
      const to = (optional ? optional.node.to : ctrl.to) + (empty?.[0].length ?? 0);
      if (structural && !hasDirectError(node)) emit({ kind: "footnote", from: node.from, to, reveal: "touch", replaces: [{ from: node.from, to, widget: new FootnoteMarkWidget() }] });
      return false;
    }
    // `\footnotetext{…}`: the text of a note marked with `\footnotemark`, set as a footnote's (styled in both layers),
    // after its number.
    // A `\thanks{…}` in the text is the same, marked "*" (no counter).
    if (text === "\\footnotetext" || text === "\\thanks") {
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
    // `\hfill {\huge $\lrcorner$}` (2611.13390's end-of-claim mark): the parser hangs the group on `\hfill`. A group with a size
    // or font switch is drawn as any such group, after the gap; a mark alone on its line is pushed to the right, as the fill does.
    if (text === "\\hfill") {
      const hung = commandArguments(node).find((arg) => !arg.optional)?.node;
      const switched = hung && !/\S/.test(read(state, ctrl.to, hung.from)) ? groupSwitch(hung) : null;
      if (hung && switched) {
        const line = doc.lineAt(ctrl.from);
        const alone = !read(state, line.from, ctrl.from).trim() && !read(state, hung.to, line.to).trim();
        if (structural) emit({ kind: "symbol", from: ctrl.from, to: ctrl.to, reveal: "touch", replaces: [{ from: ctrl.from, to: ctrl.to, widget: new SymbolWidget(" ", text, "cm-vis-symbol cm-vis-hfill") }] });
        consumed.push([hung.from, switched.textFrom]);
        emit({
          kind: "style", from: hung.from, to: hung.to, reveal: "touch",
          replaces: structural ? [{ from: hung.from, to: switched.textFrom }, { from: switched.close.from, to: hung.to }] : [],
          marks: switched.className ? [{ from: switched.textFrom, to: switched.close.from, class: switched.className, attributes: switched.style ? { style: switched.style } : undefined }] : undefined,
          lines: alone ? [{ from: line.from, to: line.to, class: "cm-vis-hfill-right" }] : undefined,
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
    // Tracked changes, soul's styles, boxes, `\enquote`, margin notes: their text, styled, edited in place.
    const wrapped = textWrapper(node, text);
    if (wrapped !== null) return wrapped;
    // minted's `\mintinline{python}|x = 1|` (or `{x = 1}`): inline code.
    if (text === "\\mintinline" && !macroAt(defs, "mintinline", node.from)) {
      const language = commandArguments(node).find((arg) => !arg.optional);
      if (language && argumentInner(language.node)) {
        const after = read(state, language.node.to, Math.min(doc.length, language.node.to + 2000));
        const range = inlineCodeRange(after);
        if (range && !hasDirectError(node)) {
          inlineCode(node.from, language.node.to + range.from, language.node.to + range.to, language.node.to + range.to + 1);
          return false;
        }
      }
    }
    if (!structural) {
      // The style layer only needs the arguments of macros drawn with editable arguments.
      if (ctrl.name === "CtrlSeq" && macroAt(defs, text.slice(1), node.from)) return macroUse(node, text.slice(1));
      return undefined;
    }
    // Accents show their source while the cursor touches them: `\c` typed before `This` is
    // already `\c T` (Ţ), but the writer is usually on the way to `\cite`. One whose letter is on the next line stays
    // source: `\c` typed at a line's end would pull the next line's first letter up into it, out of sight.
    if (ctrl.name === "CtrlSym") {
      const accent = sameLineAccent(read(state, node.from, Math.min(doc.length, node.from + 8)));
      if (accent) {
        symbolsUntil = node.from + accent.length;
        emit({ kind: "symbol", from: node.from, to: node.from + accent.length, reveal: "touch", replaces: [{ from: node.from, to: node.from + accent.length, widget: new SymbolWidget(accent.char, read(state, node.from, node.from + accent.length)) }] });
        return false;
      }
      const symbol = CONTROL_SYMBOLS[text];
      if (symbol !== undefined && symbol !== "") {
        // A backslash typed before an existing space, newline or symbol leaves the caret inside the token.
        emit({ kind: "symbol", from: ctrl.from, to: ctrl.to, reveal: "strict", replaces: [{ from: ctrl.from, to: ctrl.to, widget: new SymbolWidget(symbol, text) }] });
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
    const accent = sameLineAccent(read(state, node.from, Math.min(doc.length, node.from + 8)));
    if (accent && /^\\[uvHckrdb]$/.test(text)) {
      symbolsUntil = node.from + accent.length;
      emit({ kind: "symbol", from: node.from, to: node.from + accent.length, reveal: "touch", replaces: [{ from: node.from, to: node.from + accent.length, widget: new SymbolWidget(accent.char, read(state, node.from, node.from + accent.length)) }] });
      return false;
    }
    const name = text.slice(1);
    // A counter printed in the text (`\theex`, `\arabic{ex}`, `\Roman{section}`): its value here, from the numbering pass.
    const counters = /^(?:arabic|alph|Alph|roman|Roman|fnsymbol|value|the[A-Za-z]+)$/.test(name) ? documentCounters(defs, () => read(state, 0, Math.max(0, env.preambleEnd))) : null;
    if (counters) {
      const argument = /^the/.test(name) ? null : args.find((arg) => !arg.optional);
      const inner = argument && argumentInner(argument.node);
      const counter = argument ? (inner ? read(state, inner.from, inner.to).trim() : "") : name.slice(3);
      const own = /^the/.test(name) ? macroAt(defs, name, node.from) : null;
      // A document's own `\theex` that only formats counters is numbered as written (numbering.ts reads it).
      const formatOnly = !own || (!own.arity && !own.body.includes("#") && /^(?:[^\\]|\\(?:arabic|alph|Alph|roman|Roman|fnsymbol|the[A-Za-z]+)(?![A-Za-z]))*$/.test(own.body));
      if (counters.has(counter) && formatOnly && (argument || !args.length) && !hasDirectError(node)) {
        const end = argument ? argument.node.to : ctrl.to;
        emit({ kind: "symbol", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: end, widget: new CounterWidget(read(state, node.from, end)) }] });
        return false;
      }
    }
    if (DEFINITION_COMMANDS.test(text)) return skipDefinition(node);
    // `\detokenize{{instruction}}`: its argument as literal characters (braces and all), in the typewriter face; the source at the caret.
    if (text === "\\detokenize" && structural && !macroAt(defs, "detokenize", node.from)) {
      const argument = commandArguments(node).find((arg) => !arg.optional);
      const range = argument && argumentInner(argument.node);
      if (argument && range && argument.node.from === ctrl.to && !hasDirectError(node) && !/[\\%#]/.test(read(state, range.from, range.to))) {
        const end = argument.node.to;
        emit({ kind: "symbol", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: end, widget: new LiteralTextWidget(read(state, range.from, range.to), read(state, node.from, end)) }] });
        consumed.push([node.from, end]);
        return false;
      }
    }
    // ifdraft's `\ifdraft{draft-only code}{}`: in the final version (no `draft` class option) only its second argument is
    // printed, here nothing: folded away as a unit, shown again at the cursor. A draft document, or text in the second, stays source.
    if (text === "\\ifdraft" && structural && defs.packages.includes("ifdraft") && !defs.classOptions?.includes("draft") && !macroAt(defs, "ifdraft", node.from)) {
      const groups = commandArguments(node).filter((arg) => !arg.optional);
      const last = groups[1];
      const gap = last ? read(state, groups[0].node.to, last.node.from) : "x";
      if (groups.length === 2 && !gap.trim() && read(state, last.node.from + 1, last.node.to - 1).trim() === "" && !isConsumed(node) && node.from >= from && node.from < to && foldDefinition(node.from, last.node.to)) return false;
    }
    const macro = macroAt(defs, name, node.from);
    // A .bbl's own `\providecommand{\doi}[1]{doi: #1}` (or `{doi: \begingroup \urlstyle{rm}\Url}`) is the stock fallback: `\doi{…}` is drawn as a link below.
    const stockDoi = name === "doi" && !!macro && macro.end !== undefined && macro.end <= doc.length &&/^\\providecommand\s*\{\\doi\}[^]*doi:/.test(read(state, macro.pos, macro.end));
    // The arxiv template's own `\def\keywords#1{… \def\and{ $\cdot$ } …}` (arxiv.sty, in the project) is llncs's keywords line: drawn below.
    const stockKeywords = name === "keywords" && !!macro && defs.packages.includes("arxiv");
    if (macro && !stockDoi && !stockKeywords) return macroUse(node, name);
    const drawn = packageCommand(node, ctrl, text, args);
    if (drawn !== null) return drawn;
    if (SIUNITX_TEXT.test(text)) {
      const unit = siunitxInText(node);
      if (unit !== null) return unit;
    }
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
        // A label with commands (`CGK{\etalchar{+}}20`) is printed as text, or the line stays source.
        const authorYear = given !== null && /\(\s*\d{4}[a-z]?\s*\)/.test(given);
        const printed = given !== null && !authorYear && /[\\{}]/.test(given) ? citationNoteText(citationNotes([given], defs, node.from).post ?? given) : given;
        if (given !== null && printed === null) return false;
        const label = given === null ? `[${bibitemNumber(doc, env.from, node.from)}]` : authorYear ? "" : `[${printed}]`;
        const to = keyArgument.node.to;
        // A label written with commands (BibTeX's alpha style: `[CGK{\etalchar{+}}20]`, 2611.07622) is drawn as LaTeX, its macros expanded.
        const written = given !== null && /[\\$]/.test(given) && label !== "";
        emit({ kind: "item", from: node.from, to, reveal: "strict", replaces: [{ from: node.from, to, widget: new ItemMarkerWidget(label, "number", 1, written ? { latex: true } : {}, null, to - node.from) }] });
        return false;
      }
    }
    // ACL's `\newcite{key}` and other styles' citation commands: chips, cited as the natbib command they act like.
    if (CITE_ALIASES[text]) {
      const keysArgument = args.find((arg) => !arg.optional);
      const inner = keysArgument && argumentInner(keysArgument.node);
      if (inner && !hasDirectError(node)) {
        const keys = read(state, inner.from, inner.to).split(",").map((key) => key.trim()).filter(Boolean);
        const optionals = args.filter((arg) => arg.optional).map((arg) => { const range = argumentInner(arg.node); return range ? noteMacros(read(state, range.from, range.to), node.from) : ""; });
        const notes = optionals.length > 1 ? { pre: optionals[0] || undefined, post: optionals[1] || undefined } : { post: optionals[0] || undefined };
        if (!notesUnderstood(notes)) return false;
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
    // `\large{\textbf{APPENDIX}}`: the switch, then a group (the parser hangs it on the command): the group's text, the
    // switch and the braces hidden until the cursor touches them.
    if (SIZE_COMMAND.test(text) && args.length === 1 && !args[0].optional && !hasDirectError(node)) {
      const group = argumentInner(args[0].node);
      if (group && !read(state, ctrl.to, args[0].node.from).trim()) {
        emit({ kind: "symbol", from: ctrl.from, to: args[0].node.to, reveal: "touch", replaces: [{ from: ctrl.from, to: group.from }, { from: group.to, to: args[0].node.to }] });
        return undefined;
      }
    }
    // `\color{black}` is the default colour: a no-op, hidden until the cursor touches it (a group that runs over sections is not
    // drawn as a coloured group, but this switch in it is still nothing).
    if (text === "\\color" && args.length === 1 && !args[0].optional && !hasDirectError(node)) {
      const name = argumentInner(args[0].node);
      if (name && /^\s*black\s*$/.test(read(state, name.from, name.to)) && !defs.colors.has("black")) {
        emit({ kind: "symbol", from: ctrl.from, to: args[0].node.to, reveal: "touch", replaces: [{ from: ctrl.from, to: args[0].node.to }] });
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

  /** siunitx's `\SI{12.5}{\kilo\meter}` (and `\num`, `\si`, …) in text: drawn as KaTeX draws it in a formula; null when not read (source). */
  function siunitxInText(node: SyntaxNode): false | null {
    if (!structural || hasDirectError(node)) return null;
    const unit = readSiunitx(read(state, node.from, Math.min(doc.length, node.from + 2000)), 0);
    const html = unit ? renderKatex(unit.latex, false) : null;
    if (!unit || !html) return null;
    const to = node.from + unit.end;
    emit({ kind: "math", from: node.from, to, reveal: "strict", replaces: [{ from: node.from, to, widget: new MathWidget(html, false, false, read(state, node.from, to), false, 0, to - node.from) }] });
    consumed.push([node.from, to]);
    return false;
  }

  /**
   * Package commands of the text (group D2 of the paper batches): layout lines and layout in text, text wrappers,
   * eurosym's sign, todonotes' notes, acronyms, keywords and thm-restate's restated theorems. Structural layer only;
   * null when `node` is none of these, or one it cannot read (it stays source).
   */
  function packageCommand(node: SyntaxNode, ctrl: SyntaxNode, text: string, args: ReturnType<typeof commandArguments>): false | undefined | null {
    const mandatory = args.filter((arg) => !arg.optional);
    const first = mandatory[0] && argumentInner(mandatory[0].node);
    // `\ensuremath{…}` in text (lhs2TeX's `\ensuremath{\Conid{C}}`, 2610.41832): its argument, as an inline formula.
    if (text === "\\ensuremath" && first && args[0] === mandatory[0] && !read(state, ctrl.to, first.from - 1).trim() && !hasDirectError(node)) {
      const expanded = expandLatexMacros(read(state, first.from, first.to), defs, { mode: "math", pos: node.from });
      const html = expanded.ok ? renderKatex(withReferences(expanded.text), false) : null;
      if (!html) return undefined;
      const end = mandatory[0].node.to;
      emit({ kind: "math", from: node.from, to: end, reveal: "strict", replaces: [{ from: node.from, to: end, widget: new MathWidget(html, false, false, read(state, node.from, end), false, 0, end - node.from, referenced(expanded.text)) }] });
      consumed.push([node.from, end]);
      return false;
    }
    // bibtex's `\doi{10.1000/x}` (a natbib .bbl entry; its `\providecommand{\doi}[1]{doi: #1}` is the fallback): "doi: 10.1000/x", a link to doi.org.
    if (text === "\\doi" && args.length === 1 && mandatory.length === 1 && first && !hasDirectError(node)) {
      const doi = read(state, first.from, first.to).trim().replace(/\\([%#&_~$^{}])/g, "$1");
      if (doi && !/[\\{}\s]/.test(doi)) {
        const end = mandatory[0].node.to;
        const href = `https://doi.org/${doi}`;
        emit({ kind: "style", from: node.from, to: end, reveal: "strict", replaces: [{ from: node.from, to: end, widget: new LinkTextWidget(`doi: ${doi}`, `${href} (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}-click to open)`, end - node.from, href) }] });
        consumed.push([node.from, end]);
        return false;
      }
    }
    // `\tableofcontents`, `\listoffigures`, `\listoftables` on their own line: the list they print, read-only.
    const contents = CONTENTS_LISTS[text];
    if (contents && !args.length) {
      const span = aloneOnLines(doc, node.from, ctrl.to);
      if (span) {
        emit({ kind: "contents", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new ContentsWidget(contents, span.to - span.from) }] });
        return false;
      }
    }
    // listings' `\lstinputlisting[caption=…]{file}`, minted's `\inputminted{python}{file}`: a code block naming the file.
    if ((text === "\\lstinputlisting" || text === "\\inputminted") && !hasDirectError(node)) {
      const file = mandatory[text === "\\inputminted" ? 1 : 0];
      const inner = file && argumentInner(file.node);
      const span = inner ? aloneOnLines(doc, node.from, file.node.to) : null;
      if (inner && span && span.from === doc.lineAt(node.from).from) {
        const options = args.find((arg) => arg.optional && arg.node.to <= file.node.from);
        const range = options && argumentInner(options.node);
        const header = range ? readCodeHeader("lstlisting", `[${read(state, range.from, range.to)}]`) : null;
        const numbered = text === "\\lstinputlisting" && !!header?.numbered;
        emit({ kind: "code-file", from: span.from, to: span.to, reveal: "strict", replaces: [{ from: span.from, to: span.to, block: true, widget: new CodeFileWidget(read(state, inner.from, inner.to).trim(), header?.caption ?? null, numbered, span.to - span.from) }] });
        return false;
      }
    }
    // A line holding only layout folds away.
    if (Object.hasOwn(LAYOUT_LINE_ARGS, text.slice(1))) {
      const line = layoutLine(state, node.from);
      if (line) { collapseLine(line, "layout"); consumed.push([line.from, line.to]); return false; }
      // Among other things on a line (`\ifllncs\else\pagenumbering{roman}\fi`): hidden with its arguments, shown again at the caret.
      if (structural && INLINE_SETUP.test(text) && !isConsumed(node) && node.from >= from && node.from < to && !hasDirectError(node) && mandatory.length === LAYOUT_LINE_ARGS[text.slice(1)]) {
        const end = args.length ? Math.max(ctrl.to, ...args.map((arg) => arg.node.to)) : ctrl.to;
        if (doc.lineAt(end).number === doc.lineAt(node.from).number) {
          emit({ kind: "layout", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: end }] });
          consumed.push([node.from, end]);
          return false;
        }
      }
    }
    // In a line of text (`\item \zcsetup{reftype=Property}\label{x}`): set-up that prints nothing is hidden, its source back at the caret.
    if (/^\\(?:zcsetup|crefalias|numberwithin)$/.test(text) && !hasDirectError(node) && !macroAt(defs, text.slice(1), node.from)) {
      const count = text === "\\zcsetup" ? 1 : 2;
      if (mandatory.length >= count && mandatory.slice(0, count).every((arg, index) => index === 0 || !read(state, mandatory[index - 1].node.to, arg.node.from).trim())) {
        const end = mandatory[count - 1].node.to;
        if (structural) emit({ kind: "symbol", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: end }] });
        consumed.push([node.from, end]);
        return false;
      }
    }
    // In a line of text, `\newline` and `\par` are breaks; space and layout commands print nothing (`\vspace{2pt}`, `\noindent`).
    if (text === "\\newline" || text === "\\par" || text === "\\break") {
      emit({ kind: "symbol", from: ctrl.from, to: ctrl.to, reveal: "never", replaces: [{ from: ctrl.from, to: ctrl.to, widget: new LineBreakWidget() }] });
      return undefined;
    }
    // pdfpages' `\includepdf[pages=1]{file.pdf}` (2611.10154): a placeholder naming the file.
    if (text === "\\includepdf" && mandatory.length >= 1 && !hasDirectError(node)) {
      const file = argumentInner(mandatory[0].node);
      const end = mandatory[0].node.to;
      if (file) {
        const source = read(state, node.from, end);
        emit({ kind: "symbol", from: node.from, to: end, reveal: "strict", replaces: [{ from: node.from, to: end, widget: new PdfPagesWidget(read(state, file.from, file.to).trim(), source, end - node.from) }] });
        consumed.push([node.from, end]);
        return false;
      }
    }
    if (/^\\(?:vspace|addvspace|vskip|hspace|hskip|Needspace|needspace|penalty|looseness|urlstyle)$/.test(text) && !hasDirectError(node)) {
      const end = layoutExtent(state, ctrl.to, text);
      if (end > ctrl.to || /skip$/.test(text)) {
        const horizontal = /^\\h/.test(text);
        emit({ kind: "symbol", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: end, widget: horizontal ? new SymbolWidget(" ", read(state, node.from, end)) : undefined }] });
        consumed.push([node.from, end]);
        return undefined;
      }
    }
    // llncs's / amsthm's `\qed` (and `\qedsymbol`): the end mark, a square. Right before `\end{proof}` the proof's own footer
    // draws the mark, so `\qed` there is hidden (its source shows when the caret enters it); elsewhere it is drawn as the mark.
    if ((text === "\\qed" || text === "\\qedsymbol") && !mandatory.length && !hasDirectError(node)) {
      const footer = /^\s*\\end\s*\{proof\}/.test(doc.sliceString(ctrl.to, Math.min(doc.length, ctrl.to + 40)));
      emit({ kind: "symbol", from: ctrl.from, to: ctrl.to, reveal: "touch", replaces: [{ from: ctrl.from, to: ctrl.to, widget: footer ? undefined : new QedMarkWidget(text) }] });
      return false;
    }
    if (INLINE_LAYOUT.test(text)) {
      let textFrom = ctrl.to;
      while (textFrom < doc.length && / |\t/.test(read(state, textFrom, textFrom + 1))) textFrom++;
      // A group the parser hung on it (`\onehalfspacing{…}`) is text: its braces are hidden too.
      const group = mandatory[0] && mandatory[0].node.from === textFrom ? first : null;
      emit({ kind: "symbol", from: node.from, to: group ? mandatory[0].node.to : textFrom, reveal: "touch", replaces: group ? [{ from: node.from, to: group.from }, { from: group.to, to: mandatory[0].node.to }] : [{ from: node.from, to: textFrom }] });
      return undefined;
    }
    // Space in a line of text: `\hfill`, `\hfil` (a gap), `\vfill` (nothing); `\linebreak` breaks it.
    if (/^\\(?:hfill|hfil|vfill)$/.test(text)) {
      emit({ kind: "symbol", from: ctrl.from, to: ctrl.to, reveal: "touch", replaces: [{ from: ctrl.from, to: ctrl.to, widget: text === "\\vfill" ? undefined : new SymbolWidget(" ", text, "cm-vis-symbol cm-vis-hfill") }] });
      return false;
    }
    if (text === "\\linebreak" && !mandatory.length) {
      const end = args[0]?.optional ? args[0].node.to : ctrl.to;
      emit({ kind: "symbol", from: ctrl.from, to: end, reveal: "never", replaces: [{ from: ctrl.from, to: end, widget: new LineBreakWidget() }] });
      return false;
    }
    // `\phantom{x}` takes the space of its content, unseen (a space here); `\vphantom{x}` only a height (nothing).
    if (/^\\[hv]?phantom$/.test(text) && mandatory.length === 1 && first && !hasDirectError(node)) {
      const end = mandatory[0].node.to;
      emit({ kind: "symbol", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: end, widget: text === "\\vphantom" ? undefined : new SymbolWidget(" ", read(state, node.from, end)) }] });
      return false;
    }
    // `\rule{2cm}{0.4pt}` (a bar), `\hrulefill` and `\dotfill` (a line and dots across), drawn as in a caption or cell.
    if ((text === "\\rule" && mandatory.length === 2 && !hasDirectError(node)) || ((text === "\\hrulefill" || text === "\\dotfill") && !mandatory.length)) {
      const end = text === "\\rule" ? mandatory[1].node.to : ctrl.to;
      emit({ kind: "symbol", from: node.from, to: end, reveal: "strict", replaces: [{ from: node.from, to: end, widget: new TextDrawingWidget(read(state, node.from, end), end - node.from) }] });
      return false;
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
    if (AASTEX.test(defs.documentClass ?? "") && first && !hasDirectError(node)) {
      // AASTeX's `\uat{Planet hosting stars}{1242}` in the keywords: the Unified Astronomy Thesaurus concept, then its number.
      const id = text === "\\uat" && mandatory.length === 2 ? argumentInner(mandatory[1].node) : null;
      if (id) {
        const end = mandatory[1].node.to;
        emit({ kind: "style", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: first.from }, { from: first.to, to: end, widget: new SymbolWidget(` (${read(state, id.from, id.to).trim()})`, read(state, node.from, end)) }] });
        consumed.push([node.from, first.from]);
        return undefined;
      }
      // `\facilities{Gemini:South, LDT}` and `\software{…}`: a paragraph after its label, as the class prints them; a
      // `\facility{HST}` in the list is its name.
      const label = mandatory.length === 1 ? AASTEX_LABELS[text] : undefined;
      if (label !== undefined) {
        const end = mandatory[0].node.to;
        let listed = false;
        for (let parent = node.parent; parent && !listed; parent = parent.parent) listed = parent.name === "UnknownCommand" && !!parent.firstChild && read(state, parent.firstChild.from, parent.firstChild.to) === "\\facilities";
        emit({ kind: "style", from: node.from, to: end, reveal: "touch", replaces: [{ from: node.from, to: first.from, widget: listed && text === "\\facility" ? undefined : new SymbolWidget(label, text, "cm-vis-keywords-label") }, { from: first.to, to: end }] });
        consumed.push([node.from, first.from]);
        return undefined;
      }
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
    // The same call for a restatable that lives in another file (cs.GT 2611.05777's `\pathconcentrationlemma*` in the appendix, its
    // `restatable` in rsd.tex): this file cannot read the theorem, so a chip names it; a click opens the source.
    if (!restated && !args.length && ctrl.name === "CtrlSeq" && read(state, ctrl.to, ctrl.to + 1) === "*" && /^\\[a-z]{6,}$/.test(text)
      && (defs.packages.includes("thm-restate") || defs.packages.includes("thmtools")) && !macroAt(defs, text.slice(1), node.from) && !hasDirectError(node)) {
      const end = ctrl.to + 1;
      if (aloneOnLines(doc, node.from, end)) {
        if (structural) emit({ kind: "label", from: node.from, to: end, reveal: "strict", replaces: [{ from: node.from, to: end, widget: new ChipWidget("label", text, [`${text.slice(1)} (restated)`], {}, end - node.from) }] });
        consumed.push([node.from, end]);
        return false;
      }
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
    const fold = (end: number) => {
      if (structural && !isConsumed(node) && node.from > env.preambleEnd && node.from >= from && node.from < to && !startsDisabled(node.from) && foldDefinition(node.from, end)) return;
      consumed.push([node.from, end]);
    };
    if (extent) { fold(Math.max(node.to, extent.to)); return false; }
    const text = read(state, node.from, Math.min(doc.length, node.from + 8000));
    let index = /^\\[A-Za-z@]+\*?/.exec(text)![0].length;
    for (let parts = 0; parts < 8; parts++) {
      const space = /^(?:\s|%[^\n]*\n)*/.exec(text.slice(index))![0];
      if (space.includes("\n\n")) break;
      // A command that takes its arguments on its own line (`\algtext*{EndIf}`, `\newif\ifx`) does not read the next line's.
      if (space.includes("\n") && NEXT_LINE_STOPS.test(text.slice(0, index))) break;
      const at = index + space.length;
      const name = /^\\[A-Za-z@]+/.exec(text.slice(at));
      const group = name ? null : readGroup(text, at, TEX_GROUPS) ?? readOptional(text, at, TEX_GROUPS);
      if (name) index = at + name[0].length;
      else if (group) index = group.end;
      else break;
    }
    fold(node.from + index);
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
      // As for a heading written out: the widget, and the line style while it is drawn.
      emit({
        kind: "heading", from: node.from, to, reveal: "strict",
        replaces: structural ? [{ from: node.from, to, widget: new MacroHeadingWidget(title, to - node.from) }] : [],
        hiddenLines: runIn ? undefined : [{ from: node.from, to, class: `cm-vis-heading ${SECTION_CLASSES[first.name]}` }],
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
    if (first.name === "Environment" || first.name === "EquationEnvironment" || first.name === "EquationArrayEnvironment" || first.name === "ListEnvironment"
      || first.name === "FigureEnvironment" || first.name === "TableEnvironment" || first.name === "TabularEnvironment") {
      if (!structural) return done();
      return expandedEnvironment(node.from, to, use.text) || expandedFloat(node, to, first) ? done() : null;
    }
    return null;
  }

  /**
   * A float or tabular a macro writes (`\tbl{caption}{\begin{tabular}…}` for `\begin{table}\caption{#1}#2\end{table}`):
   * drawn as the float it is, read from its expansion, with the parts copied from the call's arguments placed at their
   * text in the call, so they are edited there (macro-provenance.ts). False when it is not one the float reader draws.
   */
  function expandedFloat(use: SyntaxNode, to: number, env: SyntaxNode) {
    const expansion = expandMacroUseWithProvenance(read(state, use.from, Math.min(doc.length, use.from + 4000)), defs, { mode: "text", pos: use.from });
    if (!expansion || use.from + expansion.length !== to) return false;
    const scratch = expansionState(state, expansion.text);
    const readText = (start: number, end: number) => expansion.text.slice(start, end);
    const span = aloneOnLines(doc, use.from, to);
    const range = span ?? { from: use.from, to };
    if (env.name === "TabularEnvironment" || isTabular(env, readText)) {
      // A tabular written whole as an argument is edited there, by cell; one the definition writes is read-only.
      const source = expansion.text.slice(env.from, env.to);
      if (!parseTabular(source, 0, defs.columnTypes)?.rows.length) return false;
      const at = provenanceOf(expansion, env.from, env.to);
      emit({ kind: "table", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: at === null ? new TableWidget(source, use.from - range.from, range.to - range.from, true) : new TableWidget(source, use.from + at - range.from, range.to - range.from) }] });
      return true;
    }
    const kind = floatKind(env, readText);
    if (!kind || !wellFormedEnvironment(env, scratch)) return false;
    const figure = figureSpec(env, environmentName(env, readText) ?? "", scratch, defs, expandRowsAt(use.from), () => null, kind);
    if (!figure) return false;
    emit({ kind: "figure", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new FigureWidget(placeAtCall(figure, expansion, use.from, range)) }] });
    return true;
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
    // A wrapper whose argument holds a paragraph heading (q-bio.NC 2610.36484's `\rev{\paragraph{Version.} …}`) is one:
    // when its body only passes the argument on or styles it, it is read from the text to its closing brace in the same
    // paragraph (argumentGroups), and the argument's parts are drawn on their own.
    const broken = node.getChildren("TextArgument").some((argument) => hasDirectError(argument) || argument.lastChild?.lastChild?.type.isError);
    if (broken && !/^\s*\{\s*\\(?:paragraph|subparagraph)\*?\s*\{/.test(read(state, node.from + 1 + name.length, Math.min(doc.length, node.from + name.length + 40)))) return undefined;
    if (!broken && structureMacroNames(defs).has(name)) {
      const drawn = structuralMacroUse(node, name);
      if (drawn !== null) return drawn;
    }
    const source = read(state, node.from, Math.min(doc.length, node.from + 4000));
    // Arguments that stay editable text, when the body allows it.
    const own = macroAt(defs, name, node.from)!;
    // `\renewcommand{\paragraph}{\para}` (2611.07413): a macro of no arguments whose body is another macro takes the arguments
    // that follow it (TeX reads them for `\para`), so `\paragraph{Title.}` is drawn as `\para{Title.}`.
    const hop = own.arity === 0 && !own.spec && own.optional === undefined && !own.alias ? /^\s*\\([A-Za-z@]+)\s*$/.exec(own.body) : null;
    const hopped = hop ? macroAt(defs, hop[1], node.from) : null;
    const macro = hopped && hopped.arity >= 1 && !hopped.unsupported && !hopped.alias ? hopped : own;
    const plan = transparentPlan(macro, defs);
    const groups = plan ? argumentGroups(source, node.from, 1 + name.length, macro.arity) : null;
    if (broken && !(plan && groups)) return undefined;
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
    // AASTeX's `\newcommand{\css}{\ensuremath{\mathrm{CS}_{2}}\xspace}` (2611.08676): the trailing `\xspace` is a space,
    // which the text after the use already has.
    const ensure = /^\s*\\ensuremath\s*\{([\s\S]*)\}\s*(?:\\xspace\s*)?$/.exec(use.text);
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
  const template = range ? state.doc.sliceString(range.from, range.to) : null;
  // enumitem's `start=5` starts it here; `resume` continues another list, which the numbering pass counts (the items take its numbers).
  const start = variant === "number" && template && LIST_CONTINUES.test(template) ? enumitemListStart(template, name, new Map()) : null;
  return { node, variant, depth, count: count + (start?.count ?? 0), template, adjusted: !!start, base: start?.count ?? 0 };
}

/** enumitem's `label=…` of an itemize (`[label=--]`, `[label=$\star$]`): its bullet, as text or LaTeX; null when it gives none. */
function bulletLabel(template: string | null): { label: string; latex: boolean } | null {
  if (!template || !/(?:^|,)\s*label\s*=/.test(template)) return null;
  const label = listOptionMap(template).get("label");
  if (label === null || label === undefined) return null;
  if (/[\\$]/.test(label)) return { label, latex: true };
  return { label: label.replace(/---/g, "—").replace(/--/g, "–").replace(/[{}]/g, ""), latex: false };
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
  node.name === "UnknownCommand" && !!node.firstChild && /^\\(?:subfigure|subfloat|subcaptionbox\*?)$/.test(read(node.firstChild.from, node.firstChild.to))
  && node.getChildren("TextArgument").length >= (read(node.firstChild.from, node.firstChild.to).startsWith("\\subcaptionbox") ? 2 : 1);

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
 * tcolorbox's and mdframed's boxes, and the document's own (`\newtcolorbox{prompt}[1][]{title=#1}`, `\newmdenv{note}`):
 * those of the project's definitions (a chapter's boxes are in the main file's preamble or a style file) and of the open
 * file as written, per document version.
 */
const BASE_BOX: LatexBoxDefinition = { title: null, arity: 0, optional: false, counter: false, within: null };
const boxCache = new WeakMap<Text, { defs: LatexDefinitions | undefined; boxes: Map<string, LatexBoxDefinition> }>();
export function boxEnvironments(doc: Text, defs?: LatexDefinitions) {
  const cached = boxCache.get(doc);
  if (cached && cached.defs === defs) return cached.boxes;
  const boxes = new Map<string, LatexBoxDefinition>([["tcolorbox", BASE_BOX], ["mdframed", BASE_BOX], ...(defs?.boxes ?? [])]);
  const text = doc.toString();
  if (/\\(?:(?:re)?newtcolorbox|DeclareTColorBox|NewTColorBox|newmdenv)\b/.test(text)) {
    const own = emptyLatexDefinitions();
    readBoxDefinitions(text, own);
    for (const [name, box] of own.boxes ?? []) boxes.set(name, box);
  }
  boxCache.set(doc, { defs, boxes });
  return boxes;
}

/** A box environment's options and title as used (`\begin{prompt}[Self-RAG]`, `\begin{tcolorbox}[title=…]`, `\begin{BoxBox}[label=…,\n …]{Title}`), and where its opening ends. */
function boxUse(node: SyntaxNode, state: EditorState, prose = false, defs?: LatexDefinitions) {
  const name = environmentName(node, (from, to) => read(state, from, to)) ?? "";
  const box = boxEnvironments(state.doc, defs).get(name) ?? (prose && FRAMED_PROSE.test(name) ? BASE_BOX : undefined);
  const begin = node.getChild("BeginEnv");
  const nameEnd = begin?.getChild("EnvNameGroup")?.to;
  if (!box || !begin || nameEnd === undefined) return null;
  const after = read(state, nameEnd, Math.min(state.doc.length, nameEnd + 4000));
  // Its options (or a document box's optional first argument) after the name, which may run over lines, then its other arguments.
  const args: string[] = [];
  let at = 0;
  const optional = /^[ \t]*\[/.test(after) ? readOptional(after, after.indexOf("["), TEX_GROUPS) : null;
  if (optional) { args.push(optional.content); at = optional.end; } else if (box.optional) args.push("");
  for (let n = args.length; n < box.arity; n++) {
    const open = /^\s*\{/.exec(after.slice(at));
    const group = open ? readGroup(after, at + open[0].length - 1, TEX_GROUPS) : null;
    if (!group) return null;
    args.push(group.content);
    at = group.end;
  }
  // A document box's title may be its argument (`title=#1`); a title with a parameter not given is not known.
  const own = box.optional && args[0] ? boxTitleOf(args[0]) : null;
  const given = name === "tcolorbox" || name === "mdframed" ? boxTitleOf(args[0] ?? "") : own ?? box.title?.replace(/#(\d)/g, (whole, n: string) => args[Number(n) - 1] ?? whole) ?? null;
  const title = given && !/#\d/.test(given) ? given : null;
  return { title, end: Math.max(begin.to, nameEnd + at), name, counted: box.counter && !!title && /\\thetcbcounter(?![A-Za-z@])/.test(title) };
}


/**
 * Whether the figure widget would show everything in a float: its images,
 * drawings, tables and algorithms, one caption per float or minipage panel,
 * labels, comments and layout commands. Text, other commands and environments
 * it does not draw are recorded in `sources`: shown as source (or a placeholder
 * naming them) inside the float, which stays drawn around them. False only for
 * what makes the float's structure unreadable (a parse error, a panel with two captions).
 */
function figureCovered(node: SyntaxNode, state: EditorState, defs: LatexDefinitions, captionMacro: (use: SyntaxNode) => CaptionMacroUse | null, sources: SourcePart[] = []) {
  const content = node.getChild("Content");
  if (!content) return true;
  /** A part the widget does not draw: its source is shown in its place. */
  const unknown = (from: number, to: number, name?: string) => { sources.push(name ? { from, to, name } : { from, to }); };
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
  const notesFrom = floatNotesStart(node, state, defs);
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
    // A listing or `\verb` text is visible content the figure widget cannot draw: shown as its source, in its place.
    if (VISIBLE_SKIPPED.has(name) && !isDrawingVerbatim(ref.node, readState)) { unknown(ref.from, ref.to, name === "VerbatimEnvironment" ? `Code (${environmentName(ref.node, readState) ?? "listing"})` : undefined); return false; }
    // The notes after the last image, grid or caption (tablenotes, a notes minipage, `\floatfoot`, a "Notes:" paragraph).
    if (ref.from >= notesFrom && name !== "EndEnv") return false;
    // Notes between the content and a caption at the end.
    if (notesBefore && ref.from >= notesBefore.from && ref.to <= notesBefore.to) return false;
    if (SKIPPED.has(name) || name === "Whitespace" || name === "NewLine" || name === "BlankLine" || name === "LineBreak" || name === "Tilde") return false;
    if (name === "IncludeGraphics" || name === "IncludeSvg" || name === "Label" || name === "TabularEnvironment" || name === "SetLengthCommand" || name === "Centering") return false;
    if (name === "Caption") { caption(ref.node); return false; }
    if (ref.to <= proseBefore && PROSE_NODES.has(name)) return false;
    if (name === "Normal") { if (read(state, ref.from, ref.to).trim()) unknown(ref.from, ref.to); return false; }
    // A drawing from another file (`\input{fig}`, often TikZ), or a table's (`\include{tables/stats}`, the cannabis
    // pass-through paper's tables): shown as a placeholder.
    if (name === "Input" || name === "Include") return false;
    // `\[ \input{dict.tikz} \]`, a tikz-cd diagram in a formula: a drawing too.
    if (mathDrawing(ref.node, state)) return false;
    // A box of text around a minipage (`\colorbox{c}{\begin{minipage}{\dimexpr…\relax}…}`): a framed box of text.
    if (name === "ColorBoxCommand") {
      const box = textBoxUse(ref.node, state, defs);
      if (box) noteUntil = Math.max(noteUntil, ref.from + box.end);
      else unknown(ref.from, ref.to);
      return false;
    }
    if (name === "UnknownCommand") {
      const ctrl = ref.node.firstChild;
      const command = ctrl ? read(state, ctrl.from, ctrl.to) : "";
      if (command === "\\includestandalone" || diagramDrawing(ref.node, state) || importedFile(ref.node, state)) return false;
      // AASTeX's `\plotone{file}`, `\plottwo{a}{b}` and the `\epsscale{…}` they are drawn at.
      if (aastexPlot(command, ref.node, state, defs)) return false;
      // floatrow's `\floatfoot{Notes: …}`, wherever it is: a note under the caption.
      if (command === "\\floatfoot") {
        const note = groupAfter(state, ctrl!.to);
        if (!note) { unknown(ref.from, ref.to); return false; }
        noteUntil = Math.max(noteUntil, note.end);
        return false;
      }
      // `{\tt \footnotesize \begin{tabularx}…}` (SimPO's example generations): the font is the grid's, its content checked.
      if (FONT_SWITCHES[command]) { for (const argument of ref.node.getChildren("TextArgument")) argument.cursor().iterate(visit); return false; }
      // subcaption's `\subcaption*{Notes: …}` under a figure: unnumbered text, drawn under the caption.
      if (command === "\\subcaption" && read(state, ctrl!.to, ctrl!.to + 1) === "*") {
        const note = starredNote(state, ctrl!.to);
        if (!note) { unknown(ref.from, ref.to); return false; }
        noteUntil = note.end;
        return false;
      }
      if (ref.to <= proseBefore && (command === "\\justify" || command === "\\justifying")) return false;
      // `\subfigure[caption]{…}`: a panel, its caption in brackets and its content checked as the float's.
      if (isSubFloatCommand(ref.node, readState)) { panel(ref.node); return false; }
      // caption's `\captionof{table}{…}`, KOMA's `\captionabove{…}`, and a macro that writes the caption (`\mycap{…}`), are captions.
      if (CAPTION_OF.test(command) || KOMA_CAPTION.test(command)) { caption(ref.node); return false; }
      // A caption macro's content arguments (`\tbl{caption}{\begin{tabular}…}`) are checked as the float's content.
      const written = captionMacro(ref.node);
      if (written) { caption(ref.node); for (const argument of written.body) argument.cursor().iterate(visit); return false; }
      // `\resizebox{\linewidth}{!}{\input{fig}}`: a drawing, scaled. One holding more: its content is checked part by part.
      if (DRAWING_WRAPPERS.test(command)) { if (!drawingOnly(ref.node, state, panel, defs, notesFrom)) ref.node.getChildren("TextArgument").at(-1)?.cursor().iterate(visit); return false; }
      // Layout with what it takes (`\vskip 0.15in`, `\vspace*{2pt}`, `\setlength\tabcolsep{3pt}`, `\aboverulesep = 2mm`,
      // acmart's `\Description{…}`): none of it is drawn, so none of it is content.
      if (FIGURE_LAYOUT.test(command) || SIZE_COMMAND.test(command) || FLOAT_LENGTHS.test(command) || TABLE_SETTING.test(command)) { noteUntil = Math.max(noteUntil, layoutExtent(state, ctrl!.to, command)); return false; }
      // `\fbox{\begin{minipage}…}`, or a macro writing such a box (cs.CL 2611.11838's `\genbox{color}{title}{text}`).
      const box = textBoxUse(ref.node, state, defs);
      if (box) { noteUntil = Math.max(noteUntil, ref.from + box.end); return false; }
      if (!layoutMacro(ref.node, state, defs)) unknown(ref.from, ref.to, SOURCE_PLACEHOLDERS[command]);
      return false;
    }
    // `\begin{center}`, minipages and sub-figures: their markup is layout, their content is checked. A TikZ picture
    // is a drawing; an algorithm is its caption and its algorithmic lines.
    if (name === "Environment" || name === "FigureEnvironment") {
      const env = environmentName(ref.node, readState) ?? "";
      if (name === "FigureEnvironment" && !SUB_FLOATS.has(env)) { unknown(ref.from, ref.to); return false; }
      if (env === "tikzpicture" || TABULAR_NAMES.test(env)) return false;
      if (env === "algorithmic") { if (!algorithmicSpec(ref.node, state, defs)) covered = false; return false; }
      // adjustbox's `\begin{adjustbox}{width=\linewidth}`, threeparttable and revtex's `ruledtabular` (drawn as the
      // grid's rules): around the content, which is checked.
      if (env === "adjustbox" || env === "threeparttable" || env === "ThreePartTable" || env === "ruledtabular") return undefined;
      // overpic: an image with text put over it, drawn without the overlay; a `picture` puts labels over the images
      // around it (Neyshabur's `\begin{picture}(0,0)\put(-162,90){$\ell_2$ norm}…`), noted as an overlay.
      if (env === "overpic" || env === "picture") return false;
      // A diagram the PDF draws, and a box whose content is drawn as text (Self-RAG's prompts in a `tcolorbox`).
      if (DIAGRAM_ENVIRONMENTS[env] || boxEnvironments(state.doc, defs).has(env)) return false;
      // Any other environment is shown as its source (a known one it cannot draw, a forest tree or framed text, as a
      // placeholder naming it), in its place.
      if (env !== "center" && !SIZE_ENVIRONMENTS.has(env) && !PANEL_ENVIRONMENTS.has(env)) { unknown(ref.from, ref.to, SOURCE_PLACEHOLDERS[env]); return false; }
      return undefined;
    }
    if (name === "BeginEnv" || name === "EndEnv") return false;
    // `\mbox{\subfigure[…]{…} \subfigure[…]{…}}`: a box around the content (one holding more is checked part by part).
    if (name === "MathTextCommand") { if (!drawingOnly(ref.node, state, panel, defs)) ref.node.getChildren("TextArgument").at(-1)?.cursor().iterate(visit); return false; }
    // `{\small \begin{tabular}…}`: a group around the content, for its size; a panel command's group.
    if (name === "Group" || name === "NonEmptyGroup" || name === "OpenBrace" || name === "CloseBrace" || name === "TextArgument" || name === "LongArg") return undefined;
    // `\\` between images (a `KnownCtrlSym` holding a `LineBreak`) is layout.
    if (name === "Content" || name === "Text" || name === "Command" || name === "KnownCommand" || name === "KnownCtrlSym" || name === "KnownEnvironment") return undefined;
    unknown(ref.from, ref.to);
    return false;
  };
  content.cursor().iterate(visit);
  return covered;
}

/** A part of a float the figure widget does not draw: its range, and the name of what it is when it is a known thing it cannot draw. */
type SourcePart = { from: number; to: number; name?: string };

/** Things a float may hold that are known but drawn only in the PDF: shown as a placeholder naming them. */
const SOURCE_PLACEHOLDERS: Record<string, string> = {
  // `framed`, `shaded` and `leftbar` hold prose: a placeholder would hide the text, so they are source parts (visible, editable).
  forest: "Tree (forest)",
  lstlisting: "Code (lstlisting)", minted: "Code (minted)", "\\chemfig": "Chemical structure (chemfig)", "\\Tree": "Tree (qtree)", "\\lstinputlisting": "Code (lstinputlisting)",
  "\\inputminted": "Code (minted)", dirtree: "Directory tree (dirtree)", "\\dirtree": "Directory tree (dirtree)", "\\schemestart": "Reaction scheme (chemfig)",
};

/** import's `\subimport{dir/}{file}` and `\import{dir/}{file}` (a drawing from another file, as `\input`): the file, else null. */
function importedFile(node: SyntaxNode, state: EditorState) {
  const ctrl = node.firstChild;
  if (!ctrl || !/^\\(?:sub)?(?:import|inputfrom|includefrom)\*?$/.test(read(state, ctrl.from, ctrl.to))) return null;
  const args = node.getChildren("TextArgument").map((argument) => { const inner = argumentInner(argument); return inner ? read(state, inner.from, inner.to).trim() : null; });
  if (args.length !== 2 || args.some((arg) => !arg)) return null;
  return `${args[0]!.replace(/\/?$/, "/")}${args[1]}`;
}

/**
 * A float's parts not drawn, merged where only space or comments separate them (a line of unknown commands is one
 * source line), and without those inside another.
 */
function mergeSourceParts(parts: SourcePart[], state: EditorState) {
  const sorted = [...parts].sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: SourcePart[] = [];
  for (const part of sorted) {
    const last = merged.at(-1);
    if (last && part.to <= last.to) continue;
    // Unnamed parts on the same lines join; a named one (a placeholder) stays apart.
    if (last && !last.name && !part.name && /^[ \t]*(?:\n[ \t]*)?$/.test(read(state, last.to, part.from))) { last.to = part.to; continue; }
    merged.push({ ...part });
  }
  return merged;
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
  const read2e = readAlgorithm2eBody(read(state, content.from, content.to), defs, node.from);
  if (read2e) read2e.algorithm.offset = content.from;
  return read2e;
}

/** An `algorithmic` environment's lines, or null when they cannot be read. The document's macros may write statements. */
function algorithmicSpec(node: SyntaxNode, state: EditorState, defs?: LatexDefinitions) {
  const content = node.getChild("Content");
  const options = node.getChild("BeginEnv")?.getChild("OptionalArgument");
  const range = options && argumentInner(options);
  const spec = content ? readAlgorithmicBody(read(state, content.from, content.to), range ? read(state, range.from, range.to) : null, defs, node.from) : null;
  if (spec) spec.offset = content!.from;
  return spec;
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
export function rowMacroNames(defs: LatexDefinitions) {
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

/**
 * What a tabular's grid takes from around it: the `\rowcolors` and `\arraystretch` set in `before` (the LaTeX
 * before it in its float or group) or in force at `pos`, and the rows the document's macros write. Undefined for none.
 */
function tableExtras(before: string, defs: LatexDefinitions, pos: number, macroRows: Record<number, string | null> | null): TableExtras | undefined {
  const settings = readTableSettings(before, macroAt(defs, "arraystretch", pos)?.body);
  if (!settings && !macroRows) return undefined;
  return { ...(settings ? { settings } : {}), ...(macroRows ? { macroRows } : {}) };
}

/** AASTeX's classes (aastex631, aastex7, aastex701), and emulateapj, which has its commands. */
export const AASTEX = /^(?:aastex\d*|emulateapj)$/;
/** AASTeX's labelled paragraphs at the end of a paper, by command. */
const AASTEX_LABELS: Record<string, string> = { "\\facilities": "Facilities: ", "\\facility": "Facility: ", "\\software": "Software: " };

/** AASTeX's `\plotone{file}`, `\plottwo{a}{b}` or `\epsscale{x}`, written whole, in its class and not redefined. */
function aastexPlot(command: string, node: SyntaxNode, state: EditorState, defs: LatexDefinitions) {
  const arity = command === "\\plotone" || command === "\\epsscale" ? 1 : command === "\\plottwo" ? 2 : 0;
  if (!arity || !AASTEX.test(defs.documentClass ?? "") || macroAt(defs, command.slice(1), node.from) || hasDirectError(node)) return false;
  const args = commandArguments(node);
  return args.length === arity && args.every((arg) => !arg.optional && !!argumentInner(arg.node));
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

/** A use of a macro that writes a float's caption: the caption's text, and the arguments it puts after it as content. */
type CaptionMacroUse = { text: string; body: SyntaxNode[] };
/** Boxes a caption macro may put its content in (`\makebox[\linewidth]{#2}`), up to the group that holds it. */
const CONTENT_BOXES = /\\(?:makebox|framebox|parbox|resizebox\*?|scalebox|adjustbox|mbox|centerline|hbox(?:\s*to\s*\\[A-Za-z@]+)?)\s*(?:\[[^\]]*\]\s*|\{[^{}#]*\}\s*)*(?=\{)/g;
const captionBoxPlans = new WeakMap<object, { caption: Set<number>; body: Set<number> } | null>();
/**
 * A caption macro whose body is `\caption{#1}` followed by layout and a box around other arguments
 * (`\caption{#1}\noindent\makebox[\linewidth]{#2}`): which arguments are the caption's and which the content's; null otherwise.
 */
function captionBoxPlan(macro: { body: string; optional?: string; spec?: unknown; arity: number }) {
  if (captionBoxPlans.has(macro)) return captionBoxPlans.get(macro)!;
  let plan: { caption: Set<number>; body: Set<number> } | null = null;
  const head = macro.optional === undefined && !macro.spec ? /^\s*\\caption\s*(?:\[[^\]]*\]\s*)?\{/.exec(macro.body) : null;
  const group = head ? readGroup(macro.body, head[0].length - 1, TEX_GROUPS) : null;
  if (head && group) {
    const caption = new Set([...macro.body.slice(0, group.end).matchAll(/#(\d)/g)].map((match) => Number(match[1])));
    const rest = macro.body.slice(group.end)
      .replace(/\\label\s*\{[^{}]*\}/g, "")
      .replace(CONTENT_BOXES, "")
      .replace(/\\([A-Za-z@]+)(?![A-Za-z@])/g, (whole, name: string) => (FIGURE_LAYOUT.test(`\\${name}`) || SIZE_COMMAND.test(`\\${name}`) ? "" : whole))
      .replace(/[{}\s]/g, "");
    const body = new Set([...rest.matchAll(/#(\d)/g)].map((match) => Number(match[1])));
    // Only parameters are left, each its own, none also in the caption.
    if (body.size && /^(?:#\d)+$/.test(rest) && rest.length === body.size * 2 && [...body].every((n) => !caption.has(n))) plan = { caption, body };
  }
  captionBoxPlans.set(macro, plan);
  return plan;
}

/** Boxes around a minipage of text: `\colorbox{c}{…}`, `\fcolorbox{f}{c}{…}`, `\fbox{…}`, `\framebox[w][s]{…}`. */
const TEXT_BOX = /^\\(?:colorbox\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\}|fcolorbox\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\}\s*\{[^{}]*\}|fbox|framebox\s*(?:\[[^\]]*\]\s*){0,2})\s*\{/;
/** Layout before a box of text (a macro's `\vspace{0.2em}\noindent`). */
const BOX_LAYOUT = /^(?:\s|%[^\n]*(?:\n|$)|\\(?:noindent|par|medskip|smallskip|bigskip|centering|vfill|hfill)(?![A-Za-z@])|\\[vh]space\*?\s*\{[^{}]*\})*/;

/**
 * A box of text at the start of `text`, after layout: a box holding one minipage and nothing else
 * (`\colorbox{promptcolor}{%\n\begin{minipage}{\dimexpr\linewidth-2\fboxsep\relax} … \end{minipage}}`). The minipage's
 * width is the box's business (a `\dimexpr`, `\linewidth`): only its text is drawn. Its text and where the box ends; null otherwise.
 */
function textBoxAt(text: string): { body: string; end: number } | null {
  const at = BOX_LAYOUT.exec(text)![0].length;
  const head = TEXT_BOX.exec(text.slice(at, at + 200));
  const group = head ? readGroup(text, at + head[0].length - 1, TEX_GROUPS) : null;
  if (!group) return null;
  const inner = stripTexComments(group.content);
  const begin = /^\s*\\begin\s*\{minipage\}/.exec(inner);
  if (!begin) return null;
  let i = begin[0].length;
  for (let open = /^\s*\[/.exec(inner.slice(i)); open; open = /^\s*\[/.exec(inner.slice(i))) {
    const optional = readOptional(inner, i + open[0].length - 1, TEX_GROUPS);
    if (!optional) return null;
    i = optional.end;
  }
  const widthOpen = /^\s*\{/.exec(inner.slice(i));
  const width = widthOpen ? readGroup(inner, i + widthOpen[0].length - 1, TEX_GROUPS) : null;
  const end = /\\end\s*\{minipage\}\s*$/.exec(inner);
  if (!width || !end) return null;
  const body = inner.slice(width.end, end.index);
  return balancedEnvironments(body) ? { body: body.trim(), end: group.end } : null;
}

/**
 * A box of text in a float (`\colorbox{…}{\begin{minipage}…}`, `\fbox{…}`, or a use of a document macro that writes one,
 * cs.CL 2611.11838's `\genbox{color}{title}{text}`): its text and its length from the node's start; null otherwise.
 */
function textBoxUse(node: SyntaxNode, state: EditorState, defs: LatexDefinitions): { body: string; end: number } | null {
  if (node.name === "ColorBoxCommand") {
    const box = textBoxAt(read(state, node.from, node.to));
    return box && box.end === node.to - node.from ? box : null;
  }
  const ctrl = node.name === "UnknownCommand" ? node.firstChild : null;
  const command = ctrl ? read(state, ctrl.from, ctrl.to) : "";
  if (!command) return null;
  const isBox = /^\\(?:fbox|framebox|fcolorbox)$/.test(command);
  const macro = isBox ? null : macroAt(defs, command.slice(1), node.from);
  if (!isBox && (!macro || !/\\begin\s*\{minipage\}/.test(macro.body))) return null;
  const window = read(state, node.from, Math.min(state.doc.length, node.from + 20000));
  if (isBox) return textBoxAt(window);
  const use = expandLatexMacroUse(window, defs, { mode: "text", pos: node.from });
  const box = use ? textBoxAt(use.text) : null;
  // Nothing but space and comments after the box in the expansion.
  return use && box && !stripTexComments(use.text.slice(box.end)).trim() ? { body: box.body, end: use.length } : null;
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
      if (text === "\\includestandalone" || FIGURE_LAYOUT.test(text) || SIZE_COMMAND.test(text) || TABLE_SETTING.test(text)) return false;
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
const FLOAT_CONTENT_END = /\\end\s*\{(?:tabular\*?|ruledtabular|tabularx|tabulary|longtable|xltabular|algorithmic|tikzpicture|overpic|subfigure|subtable|adjustbox|tikzcd|quantikz|circuitikz|pchstack|pcvstack|tcolorbox|mdframed|lstlisting|verbatim|minted|forest|framed)\}|\\\]|\\includegraphics\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}|\\plotone\s*\{[^{}]*\}|\\plottwo\s*\{[^{}]*\}\s*\{[^{}]*\}|\\(?:input|include|includestandalone|c?tikzfig)\s*\{[^{}]*\}|\\caption(?:of|above|below|aboveof|belowof)?\*?\s*(?:\[[^\]]*\])?\s*\{/g;

/**
 * Where a float's notes start: after its last grid, image, included file or caption. Text from there to the end is the
 * notes applied economics puts under its tables and figures; infinity when the float has no such content.
 */
function floatNotesStart(node: SyntaxNode, state: EditorState, defs?: LatexDefinitions) {
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
  const boxes = boxEnvironments(state.doc, defs);
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
function floatNotes(node: SyntaxNode, state: EditorState, range?: { from: number; to: number }, exclude: SourcePart[] = []) {
  const from = range?.from ?? floatNotesStart(node, state);
  const to = range?.to ?? node.getChild("EndEnv")?.from;
  if (!Number.isFinite(from) || to === undefined || from >= to) return null;
  let raw = read(state, from, to);
  // Parts shown as source (a listing after the caption) are not notes.
  for (const part of exclude) if (part.to > from && part.from < to) raw = raw.slice(0, Math.max(0, part.from - from)) + " ".repeat(Math.min(to, part.to) - Math.max(from, part.from)) + raw.slice(Math.min(to, part.to) - from);
  let text = stripTexComments(raw);
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
    .replace(/\\(?:begin|end)\s*\{(?:tablenotes|threeparttable|ThreePartTable|ruledtabular|singlespace|onehalfspace|doublespace|spacing|minipage|footnotesize|small|scriptsize|flushleft|center|justify|adjustbox)\}(?:\s*\[[^\]]*\])?(?:\s*\{[^{}]*\})?/g, " ")
    .replace(/\\(?:vspace|hspace)\*?\s*\{[^{}]*\}|\\rule\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{[^{}]*\}|\\setlength\s*\{?\\[A-Za-z@]+\}?\s*\{[^{}]*\}/g, " ")
    .replace(/\\floatfoot\s*\{/g, "{")
    // AASTeX's notes under a `table`: `\tablenotetext{a}{…}` after its mark, `\tablecomments{…}` and `\tablerefs{…}` after theirs.
    .replace(/\\tablenotetext\s*\{([^{}]*)\}\s*\{/g, (_, mark: string) => (mark.trim() ? `\\textsuperscript{${mark.trim()}}{` : "{"))
    .replace(/\\table(comments|refs)\s*\{/g, (_, kind: string) => `\\textsc{${kind === "refs" ? "References" : "Note"}}---{`)
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
function figureSpec(node: SyntaxNode, env: string, state: EditorState, defs: LatexDefinitions, expand: (text: string) => string | null, captionMacro: (use: SyntaxNode) => CaptionMacroUse | null, kind: FigureContent["kind"]): FigureSpec | null {
  const found: SourcePart[] = [];
  if (!figureCovered(node, state, defs, captionMacro, found)) return null;
  const sourceParts = mergeSourceParts(found, state);
  /** Whether [from, to] is inside a part shown as source (the collection leaves it to that part). */
  const inSource = (from: number, to: number) => sourceParts.some((part) => from >= part.from && to <= part.to);
  /** Parts the collection could not read (a tabular without rows): shown as source too, in the content they are in. */
  const unread: SourcePart[] = [];
  const readState = (from: number, to: number) => read(state, from, to);
  const algorithm2e = algorithm2eSpec(node, state, defs);
  const isPanel = (candidate: SyntaxNode) => (candidate.name === "Environment" && environmentName(candidate, readState) === "minipage") || isSubFloat(candidate, readState) || isSubFloatCommand(candidate, readState);
  let valid = true;
  const notesFrom = floatNotesStart(node, state, defs);
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
      // subcaption's `\subcaptionbox[list]{caption}[width]{content}`: the caption is its first group, the width the bracket after it.
      if (read(state, root.from, root.from + 14) === "\\subcaptionbox") {
        const all = commandArguments(root);
        const width = all.findIndex((arg) => !arg.optional);
        const captionArg = all[width];
        const inner = captionArg && argumentInner(captionArg.node);
        if (inner) { content.caption = read(state, inner.from, inner.to); content.captionPos = inner.from; }
        const bracket = all[width + 1]?.optional ? argumentInner(all[width + 1].node) : null;
        const css = bracket ? graphicsWidth(`width=${read(state, bracket.from, bracket.to).trim()}`) : null;
        if (css) content.width = css;
        // A starred one has no letter.
        if (read(state, root.from + 14, root.from + 15) === "*") content.unnumbered = true;
      } else {
        const bracket = root.getChild("OptionalArgument");
        const inner = bracket && argumentInner(bracket);
        if (bracket) { content.caption = inner ? read(state, inner.from, inner.to) : ""; content.captionPos = inner?.from ?? bracket.from; }
      }
    }
    // A minipage panel's width (`\begin{minipage}{0.48\linewidth}`): the share of the row it takes.
    if (root !== node && root.name === "Environment" && environmentName(root, readState) === "minipage") {
      const css = minipageWidth(read(state, root.from, Math.min(root.to, root.from + 300)));
      if (css) content.width = css;
    }
    const found = (at: number) => { content.firstContent = Math.min(content.firstContent, at); };
    /** AASTeX's `\epsscale{…}`: the width of the plots after it. */
    let scale = 1;
    /** The end of the last box of text read (a macro's arguments the parser left beside it are part of it). */
    let boxUntil = -1;
    const step = (ref: SyntaxNodeRef): boolean | undefined => {
      const name = ref.name;
      if (name === "Comment" || ref.from < boxUntil) return false;
      // What is shown as source is the source part's.
      if (ref.from !== root.from && inSource(ref.from, ref.to)) return false;
      // A panel is content of its own: the float's caption after the panels is below them.
      if (ref.from !== root.from && skipPanels && isPanel(ref.node)) { found(ref.from); return false; }
      // A box of text around a minipage (`\colorbox{c}{\begin{minipage}…}`, `\fbox{…}`, a macro writing one): framed text.
      if ((name === "ColorBoxCommand" || name === "UnknownCommand") && ref.from < notesFrom) {
        const box = textBoxUse(ref.node, state, defs);
        if (box) {
          (content.boxes ??= []).push({ title: null, body: box.body });
          boxUntil = ref.from + box.end;
          found(ref.from);
          return false;
        }
      }
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
        if (written !== null) {
          content.caption = written.text;
          content.captionPos = ref.from;
          for (const argument of written.body) argument.cursor().iterate(step);
          return false;
        }
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
        const diagram = diagramDrawing(ref.node, state) ?? importedFile(ref.node, state);
        if (diagram) { content.drawings!.push(diagram); content.places.drawings.push(ref.from); found(ref.from); return false; }
        // AASTeX's `\plotone{file}` (the column's width, times `\epsscale`) and `\plottwo{a}{b}` (half of it each).
        if (aastexPlot(command, ref.node, state, defs)) {
          const files = ref.node.getChildren("TextArgument").map((argument) => { const inner = argumentInner(argument); return inner ? read(state, inner.from, inner.to).trim() : ""; });
          if (command === "\\epsscale") { scale = Number(files[0]) || 1; return false; }
          for (const file of files) {
            content.images.push({ path: imagePath(file, state.doc), width: `${Math.min(100, (command === "\\plotone" ? 100 : 50) * scale)}%` });
            content.places.images.push(ref.from);
          }
          found(ref.from);
          return false;
        }
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
      if ((name === "Environment" || name === "KnownEnvironment" || name === "TikzPictureEnvironment" || isDrawingVerbatim(ref.node, readState)) && !isTabular(ref.node, readState)) {
        const envName = environmentName(ref.node, readState) ?? "";
        if (envName === "tikzpicture") { content.drawings!.push(""); content.places.drawings.push(ref.from); found(ref.from); return false; }
        if (DIAGRAM_ENVIRONMENTS[envName]) { content.drawings!.push(`diagram:${DIAGRAM_ENVIRONMENTS[envName]}`); content.places.drawings.push(ref.from); found(ref.from); return false; }
        // Labels a `picture` puts over the images: drawn in the PDF only, noted as an overlay.
        if (envName === "picture") { content.overlay = true; return false; }
        // A box (`tcolorbox`, `mdframed`, the document's `\newtcolorbox`): its title and text, in a frame.
        const box = boxUse(ref.node, state, false, defs);
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
          const options = optionsRange ? read(state, optionsRange.from, optionsRange.to) : null;
          content.images.push({ path: imagePath(read(state, inner.from, inner.to), state.doc), width: graphicsWidth(options), ...(options && GRAPHICS_STYLE_KEYS.test(options) ? { options } : {}) });
          content.places.images.push(ref.from);
        }
        found(ref.from);
        return false;
      }
      // svg's `\includesvg[width=…]{file}`: the SVG file, drawn as an image.
      if (name === "IncludeSvg") {
        const argument = ref.node.getChild("IncludeSvgArgument")?.getChild("FilePathArgument") ?? ref.node.getChild("IncludeSvgArgument");
        const inner = argument && argumentInner(argument);
        const options = ref.node.getChild("OptionalArgument");
        const optionsRange = options && argumentInner(options);
        if (inner) {
          const file = read(state, inner.from, inner.to).trim();
          content.images.push({ path: imagePath(/\.svg$/i.test(file) ? file : `${file}.svg`, state.doc), width: graphicsWidth(optionsRange ? read(state, optionsRange.from, optionsRange.to) : null) });
          content.places.images.push(ref.from);
        }
        found(ref.from);
        return false;
      }
      if (isTabular(ref.node, readState)) {
        const source = read(state, ref.from, ref.to);
        // A longtable is shown as source (see the TabularEnvironment case): so is its table.
        if (/^\\begin\s*\{(?:longtable|xltabular)\*?\}/.test(source)) unread.push({ from: ref.from, to: ref.to });
        else {
          // Rows written through the document's macros are drawn from their expansion, row by row; the whole table
          // (read-only) when its own rows cannot be read.
          const macroRows = macroRowReadings(source, expand, defs.columnTypes);
          const built = macroRows ? null : macroBuiltTabular(source, expand, defs.columnTypes);
          const tabular: NonNullable<FigureContent["tabulars"]>[number] = built ? { source: built, offset: ref.from, readOnly: true } : { source, offset: ref.from };
          // `\rowcolors` and `\arraystretch` set in the float before it.
          const extras = tableExtras(read(state, Math.max(node.from, ref.from - 2000), ref.from), defs, ref.from, macroRows);
          if (extras) tabular.extras = extras;
          // A grid it cannot read (rules only, or not split into rows) is shown as its source.
          if (!parseTabular(tabular.source, 0, defs.columnTypes)?.rows.length) { unread.push({ from: ref.from, to: ref.to }); found(ref.from); return false; }
          // revtex's `ruledtabular`: double rules above and below the grid.
          for (let parent = ref.node.parent; parent && parent.from > root.from; parent = parent.parent) if (parent.name === "Environment" && environmentName(parent, readState) === "ruledtabular") { tabular.ruled = true; break; }
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
    };
    root.cursor().iterate(step);
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
    // algorithm2e's statements are the float's body, not notes after its caption (cs.DS 2611.09172's caption on top).
    if (root === node && !algorithm2e) {
      const notes = floatNotes(node, state, undefined, sourceParts);
      const before = notesBefore && floatNotes(node, state, notesBefore, sourceParts);
      if (before) content.notes = [...(content.notes ?? []), before];
      if (notes) content.notes = [...(content.notes ?? []), notes];
    }
    return content;
  };

  const panels: SyntaxNode[] = [];
  node.cursor().iterate((ref) => {
    if (ref.from === node.from) return undefined;
    if (ref.name === "Comment") return false;
    // The minipage in a box of text (`\fbox{\begin{minipage}…}`) is the box's, not a panel.
    if (ref.name === "ColorBoxCommand" || (ref.name === "UnknownCommand" && textBoxUse(ref.node, state, defs))) return false;
    if (inSource(ref.from, ref.to)) return false;
    if (isPanel(ref.node)) { panels.push(ref.node); return false; }
    return undefined;
  });
  const own = collect(node, kind, true);
  const parts = panels.map((panel) => collect(panel, kind, false));
  if (!valid) return null;
  const empty = (part: FigureContent) => !part.images.length && !part.tabulars && !part.drawings && !part.algorithm && !part.boxes && part.caption === null;
  if (empty(own) && parts.every(empty)) return null;
  // The parts shown as source go to the panel they are in, else to the float, before or after its drawn content.
  for (const part of [...sourceParts, ...unread].sort((a, b) => a.from - b.from)) {
    const at = panels.findIndex((panel) => part.from >= panel.from && part.to <= panel.to);
    const content = at >= 0 ? parts[at] : own;
    (content.sources ??= []).push({ offset: part.from, length: part.to - part.from, text: read(state, part.from, part.to), ...(part.name ? { name: part.name } : {}), ...(part.from < content.firstContent ? { before: true } : {}) });
  }
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

/**
 * A title block written by hand where it is printed (stat.ME 2611.11188's supplement): `\def\@title{…}`, `\def\@author{…}`
 * and `\def\@date{…}` on lines of their own, then a use of a macro the document `\let`s to `\@maketitle` (or `\maketitle`).
 * The block runs from the first `\def` of the chain right before the use to the use; null when something else stands
 * between them or shares their lines, or the macro is not known to print the title, so the lines stay source.
 */
export function handTitleBlock(state: EditorState, defs: LatexDefinitions, node: SyntaxNode, preambleEnd: number) {
  const ctrl = node.firstChild;
  if (node.name !== "UnknownCommand" || !ctrl || ctrl.name !== "CtrlSeq" || read(state, ctrl.to, node.to).trim()) return null;
  const name = read(state, ctrl.from + 1, ctrl.to);
  const macro = macroAt(defs, name, node.from);
  if (!macro || !macro.alias || macro.arity !== 0 || macro.unsupported || !/^\\(?:@maketitle|maketitle)$/.test(macro.body.trim())) return null;
  const bodyStart = Math.max(0, preambleEnd);
  const lower = Math.max(bodyStart, node.from - 20_000);
  const text = read(state, lower, node.from);
  const items: Array<{ name: string; from: number; to: number; content: string }> = [];
  for (const match of text.matchAll(/\\(?:g|e|x)?def\s*\\@(title|author|date)(?![A-Za-z@])\s*\{/g)) {
    const index = match.index ?? 0;
    if (isInLatexComment(text, index)) continue;
    const group = readGroup(text, index + match[0].length - 1, TEX_GROUPS);
    if (group) items.push({ name: match[1], from: lower + index, to: lower + group.end, content: group.content });
  }
  // The chain of definitions that ends at the use, with only space and comments between them.
  let end = node.from;
  const chain: typeof items = [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].to > end || !/^(?:\s|%[^\n]*)*$/.test(read(state, items[i].to, end))) break;
    chain.unshift(items[i]);
    end = items[i].from;
  }
  const last = (part: string) => chain.filter((item) => item.name === part).at(-1)?.content.trim() ?? null;
  const title = last("title");
  const author = last("author");
  if (!chain.length || (!title && !author)) return null;
  const span = aloneOnLines(state.doc, chain[0].from, ctrl.to);
  if (!span) return null;
  const date = last("date");
  return { from: span.from, to: span.to, title, author, date: date || null };
}

/** `\title`, `\author` and `\date` from the document, for `\maketitle`. */
const titleCache = new WeakMap<Text, Map<string, ReturnType<typeof scanTitleParts>>>();

/** The class that decides how the title block reads its commands: JHEP's `jheppub` package (over `article`) gives its own. */
export function titleClass(defs: { packages: readonly string[] }, documentClass: string | null) {
  return defs.packages.includes("jheppub") ? "jheppub" : documentClass;
}

/** `\title`, `\author` and `\date` before a `\maketitle` at `pos` (cached per document version). */
function readTitleParts(state: EditorState, pos: number, documentClass: string | null) {
  let byPos = titleCache.get(state.doc);
  if (!byPos) titleCache.set(state.doc, byPos = new Map());
  // The title block's commands in a file the preamble `\input`s (SIAM's shared `ex_shared.tex`, arXiv 2611.09593): read before the document's own.
  const included = (state.field(macroSourcesField, false) ?? [])
    .filter((source) => source.key?.startsWith("input:") && /\\(?:title|author)(?![A-Za-z@])/.test(stripTexComments(source.text)))
    .map((source) => `${source.text}\n`).join("");
  const key = `${pos}:${included}`;
  let parts = byPos.get(key);
  if (!parts) byPos.set(key, parts = scanTitleParts(included + state.doc.sliceString(0, Math.min(pos, 120_000)), documentClass));
  return parts;
}

/** JHEP's `\affiliation[1]{Institute}` lines, numbered by their option, as places under the authors (not editable in place). */
function jhepPlaces(text: string): FrontDetailsView | null {
  const places: FrontDetailsView["places"] = [];
  for (const match of text.matchAll(/\\affiliation\s*(?:\[([^\]]*)\])?\s*\{/g)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    if (/(^|[^\\])%/.test(text.slice(lineStart, match.index))) continue;
    const group = readGroup(text, match.index + match[0].length - 1, TEX_GROUPS);
    if (group) places.push({ label: match[1] ? `${match[1].trim()} ` : "", latex: group.content.trim(), editable: false });
  }
  return places.length ? { subtitle: null, authorLines: [], places, notes: [] } : null;
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
function frontMatterParts(text: string): { title: string | null; author: string | null; date: string | null; unknown: Array<{ from: number; to: number }> } | null {
  // Comments blanked, so offsets are the text's.
  const source = text.replace(/(^|[^\\])((?:\\\\)*)(%[^\n]*)/g, (_, before: string, escapes: string, comment: string) => before + escapes + " ".repeat(comment.length));
  let title: string | null = null;
  let date: string | null = null;
  const authors: string[] = [];
  // Commands the class's front matter does not hold here, each alone on its lines: they stay source, the rest is drawn.
  const unknown: Array<{ from: number; to: number }> = [];
  let i = 0;
  while (i < source.length) {
    const space = /^\s+/.exec(source.slice(i, i + 200));
    if (space) { i += space[0].length; continue; }
    const command = /^\\([A-Za-z@]+)\*?/.exec(source.slice(i, i + 60));
    if (!command || /^(?:begin|end|par|item)$/.test(command[1])) return null;
    const start = i;
    const known = FRONT_MATTER_COMMANDS.test(command[1]);
    if (!known && (!/^[ \t]*$/.test(source.slice(source.lastIndexOf("\n", i - 1) + 1, i)))) return null;
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
    if (!known) {
      if (!/^[ \t]*(?:\n|$)/.test(source.slice(i, i + 200))) return null;
      unknown.push({ from: start, to: i });
      continue;
    }
    if (command[1] === "title") title = args.at(-1) ?? title;
    else if (command[1] === "author") authors.push(frontMatterAuthor(args.at(-1) ?? ""));
    else if (command[1] === "date") date = args.at(-1) ?? date;
  }
  if (title === null && !authors.length) return null;
  return { title, author: authors.length ? authors.join(" \\and ") : null, date, unknown };
}

/** AASTeX's front matter commands: the title block's, its metadata (printed small or not at all), and space. */
const AASTEX_DECLARATIONS = /^(?:title|shorttitle|shortauthors|author|affiliation|altaffiliation|email|correspondingauthor|collaboration|nocollaboration|received|revised|accepted|published|submitjournal|journalinfo|doi|watermark|setwatermarkfontsize|AuthorCollaborationLimit|keywords|vspace|vskip|and|thanks)$/;

type AastexFrontMatter = { from: number; to: number; title: string | null; author: string | null; notes: Array<[string, string]> };

/**
 * AASTeX's front matter (2611.08676), which the class prints without `\maketitle`: the run of `\title`, `\author[orcid=…]{…}`,
 * `\affiliation{…}`, `\email[show]{…}` and `\correspondingauthor{…}` that ends `text` (the body up to the abstract).
 * Each author is drawn with their affiliations under the name; the corresponding author, the emails the class shows
 * (all of them before AASTeX 7, only `[show]` ones since) and keywords are small lines. Offsets are in `text`; null when
 * something else comes right before the abstract, or the run has no title or author.
 */
function aastexFrontMatter(text: string, documentClass: string): AastexFrontMatter | null {
  type Declaration = { name: string; optional: string | null; groups: string[] };
  let run: { start: number; end: number; items: Declaration[] } | null = null;
  let i = 0;
  while (i < text.length) {
    const space = /^\s+/.exec(text.slice(i, i + 400));
    if (space) { i += space[0].length; continue; }
    if (text[i] === "%") { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end + 1; continue; }
    const start = i;
    const command = /^\\([A-Za-z@]+)\*?/.exec(text.slice(i, i + 60));
    let end = command ? i + command[0].length : i + 1;
    const item: Declaration = { name: command?.[1] ?? "", optional: null, groups: [] };
    if (command) {
      for (;;) {
        const at = end + (/^[ \t]*\n?[ \t]*/.exec(text.slice(end, end + 40))?.[0].length ?? 0);
        const group = text[at] === "[" ? readOptional(text, at, TEX_GROUPS) : text[at] === "{" ? readGroup(text, at, TEX_GROUPS) : null;
        if (!group) break;
        if (text[at] === "{") item.groups.push(group.content.trim());
        else item.optional ??= group.content.trim();
        end = group.end;
      }
    }
    if (command && AASTEX_DECLARATIONS.test(command[1])) {
      run ??= { start, end, items: [] };
      run.items.push(item);
      run.end = end;
    } else run = null;
    i = end;
  }
  if (!run) return null;
  // Before AASTeX 7 every `\email` is printed; since, only `\email[show]{…}`.
  const allEmails = /^aastex6\d*$/.test(documentClass) || documentClass === "emulateapj";
  let title: string | null = null;
  const authors: Array<{ name: string; places: string[] }> = [];
  const emails: string[] = [];
  const notes: Array<[string, string]> = [];
  const keywords: string[] = [];
  for (const item of run.items) {
    const last = item.groups.at(-1);
    if (last === undefined) continue;
    if (item.name === "title") title = last;
    else if (item.name === "author") authors.push({ name: last, places: [] });
    else if (item.name === "affiliation" || item.name === "altaffiliation") {
      // An affiliation is its author's: one before any author is not read.
      if (!authors.length) return null;
      authors.at(-1)!.places.push(last);
    } else if (item.name === "email") { if (allEmails || /^\s*show\s*$/.test(item.optional ?? "")) emails.push(last); }
    else if (item.name === "correspondingauthor") notes.push(["Corresponding author", last]);
    else if (item.name === "collaboration") notes.push(["Collaboration", last]);
    else if (item.name === "keywords") keywords.push(last);
  }
  if (title === null && !authors.length) return null;
  if (emails.length) notes.push([emails.length > 1 ? "Emails" : "Email", emails.join(", ")]);
  if (keywords.length) notes.push(["Keywords", keywords.join(", ")]);
  const author = authors.length ? authors.map(({ name, places }) => [name, ...places.map((place) => `{\\small ${place}}`)].join(" \\\\ ")).join(" \\and ") : null;
  return { from: run.start, to: run.end, title, author, notes };
}

/** AASTeX's front matter in the body (cached per document version), at document positions; null when there is none. */
const aastexFrontCache = new WeakMap<Text, { bodyStart: number; documentClass: string; front: AastexFrontMatter | null }>();
function aastexFrontMatterIn(doc: Text, bodyStart: number, documentClass: string) {
  const cached = aastexFrontCache.get(doc);
  if (cached && cached.bodyStart === bodyStart && cached.documentClass === documentClass) return cached.front;
  let front: AastexFrontMatter | null = null;
  const body = doc.sliceString(bodyStart, Math.min(doc.length, bodyStart + 60_000));
  let stop = -1;
  let titled = false;
  for (const match of body.matchAll(/\\begin\s*\{abstract\}|\\section\*?\s*[[{]|\\maketitle(?![A-Za-z@])/g)) {
    if (isInLatexComment(body, match.index ?? 0)) continue;
    if (match[0].startsWith("\\maketitle")) titled = true;
    else if (stop < 0) stop = match.index ?? 0;
  }
  // With a `\maketitle` the title block is drawn there.
  if (stop > 0 && !titled) {
    const found = aastexFrontMatter(body.slice(0, stop), documentClass);
    if (found) front = { ...found, from: bodyStart + found.from, to: bodyStart + found.to };
  }
  aastexFrontCache.set(doc, { bodyStart, documentClass, front });
  return front;
}

/**
 * ICML's title block in `\twocolumn[…]` (`\icmltitle`, `icmlauthorlist`, `\icmlauthor{Name}{aff}`, `\icmlaffiliation{aff}{…}`) and
 * MLSys's, which is the same with another prefix (`\mlsystitle`…): the title, the authors (numbered when they have
 * different affiliations) and the affiliations in the order they are first used; null when it is not one.
 */
function icmlTitle(block: string): { title: string | null; author: string | null; abstract: string | null; details: FrontDetailsView | null } | null {
  const prefix = /\\(icml|mlsys)title(?![A-Za-z@])/.exec(block)?.[1];
  if (!prefix) return null;
  const title = commandGroups(block, `${prefix}title`).at(-1) ?? null;
  if (title === null) return null;
  const affiliations = new Map<string, string>();
  for (const match of block.matchAll(new RegExp(`\\\\${prefix}affiliation\\s*\\{([^{}]*)\\}\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`, "g"))) affiliations.set(match[1].trim(), match[2].trim());
  const used: Array<{ name: string; keys: string[] }> = [...block.matchAll(new RegExp(`\\\\${prefix}author\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}\\s*\\{([^{}]*)\\}`, "g"))].map((match) => ({ name: match[1].trim(), keys: match[2].split(",").map((key) => key.trim()).filter((key) => affiliations.has(key)) }));
  const order = [...new Set(used.flatMap((author) => author.keys))];
  // One affiliation needs no numbers; several are told apart by them, as the class prints them.
  const authors = used.map((author) => (order.length > 1 && author.keys.length ? `${author.name}\\textsuperscript{${author.keys.map((key) => order.indexOf(key) + 1).sort((a, b) => a - b).join(",")}}` : author.name));
  const places = order.map((key, index) => ({ label: order.length > 1 ? `${index + 1} ` : "", latex: affiliations.get(key)!, editable: false }));
  const abstract = abstractIn(block);
  return { title, author: authors.length ? authors.join(" \\and ") : null, abstract: abstract ? abstract.text : null, details: places.length ? { subtitle: null, authorLines: [], places, notes: [] } : null };
}

/** The `\begin{abstract} … \end{abstract}` in `content` (outside comments), as offsets into it; null without one. */
function abstractIn(content: string) {
  for (const begin of content.matchAll(/\\begin\s*\{abstract\}/g)) {
    const at = begin.index ?? 0;
    if (isInLatexComment(content, at)) continue;
    const end = /\\end\s*\{abstract\}/.exec(content.slice(at + begin[0].length));
    if (end) return { from: at, to: at + begin[0].length + end.index + end[0].length, text: content.slice(at + begin[0].length, at + begin[0].length + end.index).trim() };
  }
  return null;
}

/**
 * What may come right before `\maketitle` and is shown by it: the title block's declarations, and the metadata the
 * classes print small or not at all (acmart's `\ccsdesc`, `\setcopyright`, `\acmConference`; amsart's `\subjclass`).
 */
const TITLE_DECLARATIONS = /^(?:title|subtitle|author|date|thanks|and|AND|affiliation|address|email|institute|inst|keywords|titlerunning|authorrunning|runningtitle|shorttitle|shortauthors|editor|jmlrheading|ShortHeadings|firstpageno|vspace|vskip|smallskip|medskip|bigskip|subjclass|ccsdesc|orcid|additionalaffiliation|authornote|authornotemark|titlenote|subtitlenote|dedicatory|curraddr|urladdr|setcopyright|copyrightyear|acm[A-Z][A-Za-z]*|settopmatter|received|citestyle|Copyright|journaltitle|cpr|doival|lefttitle|righttitle|totalpg|jnlDoiYr|jnlPage|history|preprint|altaffiliation|collaboration|pacs|homepage|noaffiliation|affil|pagerange|pubyear|affiliations|abstract|ead|cormark|cortext|fnmark|fntext|tnotemark|tnotetext|credit|nonumnote|affilmark|lmcsorcid|authorinfo|makeatletter|makeatother|IEEEpubid|IEEEaftertitletext|IEEEpubidadjcol|markboth|markright)$/;
/** What ends a run of title declarations rather than staying source inside it: text, sections, environments. */
const RUN_ENDERS = /^(?:begin|end|part|chapter|section|subsection|subsubsection|paragraph|subparagraph|item|maketitle|par|noindent|indent|bibliography|printbibliography|appendix|label|footnote|textbf|textit|emph|cite|ref|includegraphics|caption)$/;
/** Definitions among them (acmart's `\renewcommand{\shortauthors}{…}`, a paper's `\newcommand{\gentxt}[1]{…}`): they print nothing. */
const TITLE_DEFINITIONS = /^(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|let)$/;
/**
 * Environments among them: an abstract the class prints with the title (acmart's, amsart's), acmart's CCS metadata,
 * and its teaser figure, which is drawn on its own (the title block stops before it).
 */
const TITLE_ENVIRONMENTS = /^(?:abstract|CCSXML|teaserfigure|authgrp|keywords|IEEEkeywords|comment)$/;
/** Classes that print an abstract written before `\maketitle` with the title (amsart: under it; acmart: in the block). */
const ABSTRACT_WITH_TITLE = /^(?:acmart|amsart|amsproc|amsbook|revtex4(?:-[12])?|sn-jnl|jfp|aa|cas-[sd]c|lmcs|IEEEojcsys)$/;
/** The headings of A&A's structured `\abstract{…}{…}{…}{…}{…}`. */
const AA_ABSTRACT_LABELS = ["Context", "Aims", "Methods", "Results", "Conclusions"];

type TitleRun = {
  start: number;
  /** Figures in the run, drawn on their own (acmart's `teaserfigure`). */
  gaps: Array<{ from: number; to: number }>;
  abstract: string | null;
  notes: Array<[string, string]>;
};

/** The run of title declarations before `\maketitle` at `pos`, in the body from `bodyStart`. */
function titleRun(state: EditorState, defs: LatexDefinitions, bodyStart: number, pos: number) {
  if (pos <= bodyStart) return null;
  const wrapper = (name: string) => { const macro = macroAt(defs, name, pos); return macro ? macroPassThrough(macro, defs) : null; };
  return titleDeclarationsStart(read(state, bodyStart, pos), ABSTRACT_WITH_TITLE.test(defs.documentClass ?? ""), wrapper);
}

/** Where the title block of `\maketitle` at `pos` starts when it folds declarations before it, or null. */
export function titleRunStart(state: EditorState, defs: LatexDefinitions, preambleEnd: number, pos: number) {
  const bodyStart = Math.max(0, preambleEnd);
  const run = titleRun(state, defs, bodyStart, pos);
  return run ? bodyStart + run.start : null;
}

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
function titleDeclarationsStart(text: string, abstractWithTitle = false, wrapper?: (name: string) => "discard" | "identity" | null): TitleRun | null {
  let run: TitleRun | null = null;
  let keywords: string[] = [];
  let subjclass: string[] = [];
  let ccs: string[] = [];
  // Commands the run does not know, each alone on its lines (revtex's `\pacs{…}` in a class not read here): they stay
  // source, and the declarations around them stay in the block (they are kept once a declaration follows, or `\maketitle`).
  let unknown: Array<{ from: number; to: number }> = [];
  const keep = () => { if (run && unknown.length) run.gaps.push(...unknown); unknown = []; };
  let i = 0;
  while (i < text.length) {
    const space = /^\s+/.exec(text.slice(i, i + 400));
    if (space) { i += space[0].length; continue; }
    if (text[i] === "%") { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end + 1; continue; }
    const start = i;
    // `\begin{abstract} … \end{abstract}` and the other environments the run may hold.
    const begin = /^\\begin\s*\{([^{}]*)\}/.exec(text.slice(i, i + 80));
    const env = begin?.[1].trim();
    if (begin && env && TITLE_ENVIRONMENTS.test(env) && (!/^(?:abstract|keywords|IEEEkeywords)$/.test(env) || abstractWithTitle)) {
      const close = new RegExp(String.raw`\\end\s*\{${env}\}`).exec(text.slice(i));
      if (close) {
        const end = i + close.index + close[0].length;
        keep();
        run ??= { start, gaps: [], abstract: null, notes: [] };
        if (env === "teaserfigure") run.gaps.push({ from: start, to: end });
        if (env === "abstract") run.abstract = stripTexComments(text.slice(i + begin[0].length, i + close.index)).trim();
        // cas-sc's and IEEEojcsys' keywords environment: the block's "Keywords" line (elsarticle's `\sep` separates them).
        if (env === "keywords" || env === "IEEEkeywords") keywords.push(stripTexComments(text.slice(i + begin[0].length, i + close.index)).replace(/\\sep(?![A-Za-z@])/g, ",").replace(/\s+/g, " ").replace(/\s+,/g, ",").trim());
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
      if (command[1] === "let") end += /^\s*\\[A-Za-z@]+\s*=?\s*(?:\\[A-Za-z@]+|\\.)/.exec(text.slice(end, end + 120))?.[0].length ?? 0;
      else if (TITLE_DEFINITIONS.test(command[1])) end +=/^\s*(?:\\[A-Za-z@]+|\{\s*\\[A-Za-z@]+\s*\})(?:#\d)*/.exec(text.slice(end, end + 80))?.[0].length ?? 0;
      for (;;) {
        // A&A's `\abstract` takes five groups, with comment lines between them (2611.07227).
        // `\author` with its `{` on the next line (cs.IT 2611.09184): one line break is space to TeX.
        const blank = command[1] === "abstract" || command[1] === "markboth" ? /^(?:\s|%[^\n]*)*/ : !groups.length && /^(?:title|author)$/.test(command[1]) ? /^[ \t]*(?:\n[ \t]*)?/ : /^[ \t]*/;
        const at = end + (blank.exec(text.slice(end, end + 400))?.[0].length ?? 0);
        const group = text[at] === "[" ? readOptional(text, at, TEX_GROUPS) : text[at] === "{" ? readGroup(text, at, TEX_GROUPS) : null;
        if (!group) break;
        if (text[at] === "{") groups.push(group.content);
        end = group.end;
      }
    }
    if (command && (TITLE_DECLARATIONS.test(command[1]) || TITLE_DEFINITIONS.test(command[1]))) {
      keep();
      run ??= { start, gaps: [], abstract: null, notes: [] };
      if (command[1] === "keywords" && groups.length) keywords.push(groups.at(-1)!.trim());
      if (command[1] === "subjclass" && groups.length) subjclass.push(groups.at(-1)!.trim());
      if (command[1] === "ccsdesc" && groups.length) ccs.push(groups.at(-1)!.trim());
      // sn-jnl's abstract is a command: `\abstract{…}`.
      // A&A's takes several (context, aims, methods, results, conclusions), each printed under its label.
      if (command[1] === "abstract" && groups.length) {
        run.abstract = groups.length === 1 ? stripTexComments(groups[0]).trim() : groups.map((group, index) => `\\textit{${AA_ABSTRACT_LABELS[index] ?? "…"}.} ${stripTexComments(group).trim()}`).join(" ");
      }
      i = end;
      continue;
    }
    // A version switch around declarations (cs.DS 2611.09172's `\iffullversion{ \title{…} }`): one that prints nothing,
    // or passes on only declarations, is part of the run.
    const kind = command && groups.length === 1 ? wrapper?.(command[1]) : null;
    if (kind && (kind === "discard" || !groups[0].trim() || titleDeclarationsStart(groups[0], abstractWithTitle, wrapper)?.start === groups[0].search(/\S/))) {
      keep();
      run ??= { start, gaps: [], abstract: null, notes: [] };
      i = end;
      continue;
    }
    // A file the run includes (acmart's abstract in `\input{abstract}`) is drawn on its own, as a teaser figure is.
    if (run && command && /^(?:input|include)$/.test(command[1]) && groups.length === 1) {
      keep();
      run.gaps.push({ from: start, to: end });
      i = end;
      continue;
    }
    if (run && command && !RUN_ENDERS.test(command[1]) && /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", start - 1) + 1, start)) && /^[ \t]*(?:%[^\n]*)?(?:\n|$)/.test(text.slice(end, end + 200))) {
      unknown.push({ from: start, to: end });
      i = end;
      continue;
    }
    // Anything else ends the run: the declarations after it may still make one.
    unknown = [];
    run = null;
    keywords = [];
    subjclass = [];
    ccs = [];
    i = command ? end : i + 1;
  }
  keep();
  if (run) run.notes = titleNotes(keywords, subjclass, ccs);
  return run;
}

/** Classes where each `\author{…}` adds an author, rather than replacing the last: acmart, the AMS classes, elsarticle, revtex, imsart, LIPIcs, AASTeX, Cambridge's jfp. */
export const ACCUMULATING_AUTHORS = /^(?:acmart|amsart|amsbook|amsproc|elsarticle|cas-[sd]c|lmcs|IEEEojcsys|revtex4(?:-[12])?|imsart|sn-jnl|jfp|lipics(?:-v20\d\d)?|oasics(?:-v20\d\d)?|aastex\d*|emulateapj|jheppub)$/;
/** LIPIcs' and OASIcs' classes, whose `\author{Name}{Affiliation}{email}{orcid}{funding}` takes five arguments. */
export const LIPICS = /^(?:lipics|oasics)(?:-v20\d\d)?$/;

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

/**
 * The name of a command the document defines as IEEEtran's "`\and` with a line break"
 * (`\newcommand{\linebreakand}{\end{@IEEEauthorhalign} … \begin{@IEEEauthorhalign}}`, cs.IT 2611.09184), or null.
 */
export function authorBreakMacro(text: string) {
  return /\\(?:re)?newcommand\s*\{\s*\\([A-Za-z]+)\s*\}\s*\{[\s%]*\\end\s*\{@IEEEauthorhalign\}/.exec(text)?.[1] ?? null;
}

/** The arguments of every `\command[…]{…}` in `text`, outside comments, in order. */
function commandGroups(text: string, command: string) {
  // sn-jnl's corresponding author is `\author*[1]{…}`.
  const pattern = new RegExp(`\\\\${command}(?![A-Za-z@])\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{`, "g");
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const lineStart = text.lastIndexOf("\n", match.index ?? 0) + 1;
    if (/(^|[^\\])%/.test(text.slice(lineStart, match.index))) continue;
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      // A comment's braces (cs.IT 2611.09184's `{%Tofar …\thanks{…` author draft) are not the group's.
      if (text[i] === "%") { const eol = text.indexOf("\n", i); if (eol < 0) break; i = eol; continue; }
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
  // LMCS's `\lmcsorcid{…}` and IEEEojcsys' `\affilmark{1,2}` (a superscript) in a name: the ORCID is not printed in the block.
  const cleanName = (name: string) => name.replace(/\\lmcsorcid\s*\{[^{}]*\}/g, "").replace(/\\affilmark\s*\{([^{}]*)\}/g, "\\textsuperscript{$1}");
  // IEEEtran's user macro for "`\and` with a line break" (`\linebreakand`): an author break; comments (a drafted list) are not shown.
  const breakMacro = authorBreakMacro(text);
  const plainName = (name: string) => (breakMacro ? stripTexComments(name).replace(new RegExp(`\\\\${breakMacro}(?![A-Za-z@])`, "g"), "\\and") : name);
  const authors = (LIPICS.test(documentClass ?? "") ? lipicsAuthors(text) : commandGroups(text, "author")).map(/^(?:lmcs|IEEEojcsys)$/.test(documentClass ?? "") ? cleanName : plainName);
  const author = !authors.length ? null : ACCUMULATING_AUTHORS.test(documentClass ?? "") ? authors.join(" \\and ") : authors.at(-1)!;
  const bodyStart = beginDocumentIndex(text);
  const jhep = documentClass === "jheppub";
  // JHEP's `\abstract{…}` command is the abstract, `\affiliation[1]{…}` the numbered places under the authors.
  const abstract = bodyStart > 0 ? /\\begin\s*\{abstract\}([\s\S]*?)\\end\s*\{abstract\}/.exec(stripTexComments(text.slice(0, bodyStart)))?.[1].trim() ?? (jhep ? commandGroups(stripTexComments(text.slice(0, bodyStart)), "abstract").at(-1)?.trim() ?? null : null) : null;
  // Keywords and classifications in the preamble (LIPIcs', acmart's): small lines of the block. Those in the body are
  // the title run's (titleDeclarationsStart), so they are not shown twice.
  // A definition of `\keywords` (`\newcommand\keywords[1]{…}`) is not a use of it.
  const preamble = (bodyStart > 0 ? text.slice(0, bodyStart) : "").replace(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def)\*?\s*\{?\s*\\(?=keywords|subjclass|ccsdesc)/g, "");
  const notes = titleNotes(commandGroups(preamble, "keywords"), commandGroups(preamble, "subjclass"), commandGroups(preamble, "ccsdesc"));
  // A date written with TeX's clock (1812.09970's `\ifcase\month\or January\or …\fi \number\year`) is not read: not shown.
  const date = last("date");
  // A class's affiliations, emails, institutes and notes (front-matter.ts).
  const authorCount = author ? author.split(/\\(?:and|And|AND)(?![A-Za-z])/).filter((piece) => piece.trim()).length : 0;
  const details = detailsView(frontMatterDetails(text, 0, documentClass ?? "", authorCount)) ?? (jhep ? jhepPlaces(text) : null);
  return { title: last("title"), author, date: date && /\\(?:ifcase|month|year|day|number)(?![A-Za-z@])/.test(date) ? null : date, abstract, notes, details };
}
