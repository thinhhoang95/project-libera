import type { EditorState, Text } from "@codemirror/state";
import type { WidgetType } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";
import { definitionExtentAround, definitionExtentAt, macroAt, type LatexDefinitions } from "../../macros/definitions";
import { expandLatexMacros, expandLatexMacroUse, needsMathMode, readMacroArguments, substituteArguments } from "../../macros/expand";
import { enumerateItemLabel, environmentName } from "../../macros/numbering";
import { katexForEnvironment, renderKatex } from "./math-render";
import { argumentInner, commandArguments, hasDirectError } from "./render-fragment";
import { CONTROL_SYMBOLS, cssColor, LIGATURE_CHARS, readAccent, SYMBOL_COMMANDS, TEXT_LIGATURES, todayText } from "./symbols";
import { parseTabular } from "./table-model";
import { argumentGroups, transparentPlan } from "./transparent";
import {
  ChipWidget, EnvironmentFooterWidget, EnvironmentHeaderWidget, FigureWidget, FootnoteMarkWidget, graphicsBase, HeadingNumberWidget, ImageWidget,
  ItemMarkerWidget, LineBreakWidget, MacroPieceWidget, MacroWidget, MathWidget, PreambleWidget, SymbolWidget, TableWidget, TitleWidget, type FigureSpec,
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
const FIGURE_LAYOUT = /^\\(?:centering|raggedright|raggedleft|tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|hfill|vfill|hspace\*?|vspace\*?|par|medskip|smallskip|bigskip|noindent|quad|qquad|captionsetup|addvspace|newline)$/;
/** Definitions the grammar parses as unknown commands. */
const DEFINITION_COMMANDS = /^\\(?:providecommand|DeclareRobustCommand|DeclareMathOperator|(?:New|Renew|Provide|Declare)Document(?:Command|Environment)|gdef|edef|xdef|newcounter|numberwithin|crefname|Crefname)$/;
const SECTION_CLASSES: Record<string, string> = {
  Book: "cm-vis-hpart", Part: "cm-vis-hpart", Chapter: "cm-vis-h0", Section: "cm-vis-h1", SubSection: "cm-vis-h2",
  SubSubSection: "cm-vis-h3", Paragraph: "cm-vis-h4", SubParagraph: "cm-vis-h4",
};
const INLINE_STYLES: Record<string, string> = {
  TextBoldCommand: "cm-vis-b", TextItalicCommand: "cm-vis-i", EmphasisCommand: "cm-vis-em", UnderlineCommand: "cm-vis-u",
  TextTeletypeCommand: "cm-vis-tt", TextSmallCapsCommand: "cm-vis-sc", TextSansSerifCommand: "cm-vis-sf", TextMediumCommand: "cm-vis-md",
  StrikeOutCommand: "cm-vis-s", TextSuperscriptCommand: "cm-vis-sup", TextSubscriptCommand: "cm-vis-sub",
};
const MATH_CONTAINERS = new Set(["DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment", "Math", "InlineMath", "DisplayMath"]);
const BULLETS = ["•", "–", "∗", "·"];
const TEXT_BLOCKS: Record<string, string> = {
  quote: "cm-vis-quote", quotation: "cm-vis-quote", verse: "cm-vis-quote", center: "cm-vis-center", flushleft: "cm-vis-flushleft",
  flushright: "cm-vis-flushright", abstract: "cm-vis-abstract",
};
/** Node types the walk does something with; it only goes inside the others. */
const HANDLED = new Set([
  ...Object.keys(SECTION_CLASSES), ...Object.keys(INLINE_STYLES), "TextColorCommand", "ColorBoxCommand", "HrefCommand", "UrlCommand",
  "FootnoteCommand", "EndnoteCommand", "DollarMath", "BracketMath", "ParenMath", "EquationEnvironment", "EquationArrayEnvironment",
  "Cite", "Ref", "Label", "FigureEnvironment", "TableEnvironment", "TabularEnvironment", "ListEnvironment", "Item", "Environment",
  "EndEnv", "Maketitle", "IncludeGraphics", "LineBreak", "Tilde", "Normal", "UnknownCommand",
]);
const THEOREM_STYLE_CLASSES ={ plain: "cm-vis-thm-plain", definition: "cm-vis-thm-definition", remark: "cm-vis-thm-remark" };
/** Layout commands in user environment code that draw nothing worth showing. */
const LAYOUT_NOISE = /\\(?:par|noindent|indent|medskip|smallskip|bigskip|hfill|vfill|null|ignorespaces|unskip|relax|nopagebreak|newline|centering|raggedright|raggedleft|normalfont|itshape|upshape|bfseries|mdseries|rmfamily|sffamily|ttfamily)(?![A-Za-z])|\\[vh]space\*?\s*\{[^}]*\}|\\(?:begin|end)\s*\{[^}]*\}(?:\[[^\]]*\])?|\\item(?:\[([^\]]*)\])?/g;

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
function itemsBefore(list: SyntaxNode, pos: number, state: EditorState, counter: string | null) {
  let count = 0;
  const content = list.getChild("Content");
  if (!content) return 0;
  const cursor = content.cursor();
  const walk = (): void => {
    do {
      if (cursor.from >= pos) return;
      if (cursor.name === "ListEnvironment") continue;
      if (cursor.name === "Item") { if (cursor.to <= pos && !cursor.node.getChild("OptionalArgument")) count++; continue; }
      if (cursor.name === "UnknownCommand") { const change = cursor.to <= pos ? counterChange(state, cursor.node, counter) : null; if (change) { count = change(count); continue; } }
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
function environmentCode(code: string) {
  return code.replace(LAYOUT_NOISE, (_, item?: string) => (item !== undefined ? item : "")).replace(/\s+/g, " ").trim();
}

type ListContext = { node: SyntaxNode; variant: "bullet" | "number" | "description"; depth: number; count: number; template: string | null };

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

  const isConsumed = (node: { from: number; to: number }) => consumed.some(([start, end]) => node.from >= start && node.to <= end);

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
  const collapseLine = (node: SyntaxNode, kind: string, extra?: Replace) => {
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
            list.count = itemsBefore(node, from, state, list.variant === "number" ? enumCounter(list.depth) : null);
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

      switch (name) {
        case "TextColorCommand": case "ColorBoxCommand": {
          const args = commandArguments(node);
          const model = args.find((arg) => arg.optional);
          const mandatory = args.filter((arg) => !arg.optional);
          const colorRange = mandatory[0] && argumentInner(mandatory[0].node);
          const textRange = mandatory[1] && argumentInner(mandatory[1].node);
          if (!colorRange || !textRange || textRange.to <= textRange.from || hasDirectError(node)) return;
          const modelRange = model && argumentInner(model.node);
          const color = cssColor(modelRange ? read(state, modelRange.from, modelRange.to) : null, read(state, colorRange.from, colorRange.to));
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
          emit({
            kind: "footnote", from: node.from, to: node.to, reveal: "touch",
            replaces: structural ? [{ from: node.from, to: inner.from, widget: new FootnoteMarkWidget() }, { from: inner.to, to: node.to }] : [],
            marks: [{ from: inner.from, to: inner.to, class: "cm-vis-footnote" }],
          });
          return;
        }
        case "DollarMath": case "BracketMath": case "ParenMath": {
          if (!structural) return false;
          for (let parent = node.parent; parent; parent = parent.parent) if (MATH_CONTAINERS.has(parent.name)) return false;
          if (hasDirectError(node) || node.lastChild?.type.isError) return false;
          const displayNode = node.getChild("DisplayMath");
          const display = name === "BracketMath" || !!displayNode;
          const math = displayNode ? displayNode.getChild("Math") : name === "DollarMath" ? node.getChild("InlineMath")?.getChild("Math") : node.getChild("Math");
          if (!math || (displayNode && hasDirectError(displayNode))) return false;
          const latex = read(state, math.from, math.to);
          if (!latex.trim()) return false;
          const expanded = expandLatexMacros(latex, defs, { mode: "math", pos: node.from });
          const html = expanded.ok ? renderKatex(expanded.text, display) : null;
          if (!html) return false;
          const span = display ? aloneOnLines(doc, node.from, node.to) : null;
          const range = span ?? { from: node.from, to: node.to };
          emit({
            kind: "math", from: range.from, to: range.to, reveal: "strict",
            replaces: [{ from: range.from, to: range.to, block: !!span, widget: new MathWidget(html, display, !!span, read(state, node.from, node.to), false, node.from - range.from, range.to - range.from) }],
          });
          return false;
        }
        case "EquationEnvironment": case "EquationArrayEnvironment": {
          if (!structural) return false;
          for (let parent = node.parent; parent; parent = parent.parent) if (MATH_CONTAINERS.has(parent.name)) return false;
          const formed = wellFormedEnvironment(node, state);
          if (!formed || !formed.content) return false;
          const body = read(state, formed.content.from, formed.content.to);
          const source = katexForEnvironment(formed.name, body);
          const expanded = expandLatexMacros(source.latex, defs, { mode: "math", pos: node.from });
          const html = expanded.ok ? renderKatex(expanded.text, !source.inline) : null;
          if (!html) return false;
          const span = source.inline ? null : aloneOnLines(doc, node.from, node.to);
          const range = span ?? { from: node.from, to: node.to };
          emit({
            kind: "math", from: range.from, to: range.to, reveal: "strict",
            replaces: [{ from: range.from, to: range.to, block: !!span, widget: new MathWidget(html, !source.inline, !!span, read(state, node.from, node.to), source.numbered, node.from - range.from, range.to - range.from) }],
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
          emit({
            kind: name === "Cite" ? "cite" : "ref", from: node.from, to: node.to, reveal: "strict",
            replaces: [{ from: node.from, to: node.to, widget: new ChipWidget(name === "Cite" ? "cite" : "ref", command, keys, notes, node.to - node.from) }],
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
          const formed = wellFormedEnvironment(node, state);
          if (!formed) return;
          if (!structural) return false;
          const figure = figureSpec(node, formed.name, state);
          if (!figure) return;
          const span = aloneOnLines(doc, node.from, node.to);
          const range = span ?? { from: node.from, to: node.to };
          figure.numberOffset = node.from - range.from;
          figure.length = range.to - range.from;
          for (const tabular of figure.tabulars ?? []) tabular.offset -= range.from;
          emit({ kind: "figure", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new FigureWidget(figure) }] });
          return false;
        }
        case "TabularEnvironment": {
          const formed = wellFormedEnvironment(node, state);
          // longtable has its own head, foot and caption rows: shown as source.
          if (!formed || /^(?:longtable|xltabular)\*?$/.test(formed.name)) return;
          if (!structural) return false;
          const source = read(state, node.from, node.to);
          if (!parseTabular(source, 0)) return;
          const span = aloneOnLines(doc, node.from, node.to);
          const range = span ?? { from: node.from, to: node.to };
          emit({ kind: "table", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new TableWidget(source, node.from - range.from, range.to - range.from) }] });
          return false;
        }
        case "ListEnvironment": {
          const formed = wellFormedEnvironment(node, state);
          if (!formed) return;
          const list = listContext(node, formed.name, lists, state, 0);
          lists.push(list);
          if (structural) {
            collapseLine(formed.begin, "list-begin");
            collapseLine(formed.end, "list-end");
          }
          if (formed.content) {
            const first = doc.lineAt(formed.begin.to).number + 1;
            const last = doc.lineAt(formed.end.from).number - 1;
            if (last >= first) emit({ kind: "list-body", from: node.from, to: node.to, reveal: "never", replaces: [], lines: [{ from: doc.line(first).from, to: doc.line(last).to, class: `cm-vis-list cm-vis-list-d${Math.min(6, list.depth)}` }] });
          }
          return;
        }
        case "Item": {
          const list = lists[lists.length - 1];
          if (!list || !structural) return false;
          const optional = node.getChild("OptionalArgument");
          const optionalRange = optional && argumentInner(optional);
          let label: string;
          let variant = list.variant;
          if (optionalRange) {
            label = read(state, optionalRange.from, optionalRange.to).replace(/\\(?:textbf|textit|emph)\s*/g, "").replace(/[{}]/g, "").trim();
            if (list.variant !== "description") variant = "number";
          } else if (list.variant === "number") {
            list.count++;
            label = enumerateItemLabel(list.count, list.depth, list.template);
          } else label = list.variant === "description" ? "" : BULLETS[(list.depth - 1) % BULLETS.length];
          const line = doc.lineAt(node.from);
          const replaceFrom = read(state, line.from, node.from).trim() ? node.from : line.from;
          emit({ kind: "item", from: replaceFrom, to: node.to, reveal: "never", replaces: [{ from: replaceFrom, to: node.to, widget: new ItemMarkerWidget(label, variant, list.depth) }] });
          return false;
        }
        case "Environment": case "KnownEnvironment": {
          if (name === "KnownEnvironment") return;
          return environment(node);
        }
        case "EndEnv": {
          // `\end{document}`: its environment starts in the preamble, so the end line is its own construct.
          if (node.parent?.name === "DocumentEnvironment" && structural && !hasDirectError(node)) collapseLine(node, "document-end");
          return false;
        }
        case "Maketitle": {
          if (!structural) return false;
          const title = readTitleParts(state, node.from);
          const span = aloneOnLines(doc, node.from, node.to);
          const range = span ?? { from: node.from, to: node.to };
          emit({ kind: "title", from: range.from, to: range.to, reveal: "strict", replaces: [{ from: range.from, to: range.to, block: !!span, widget: new TitleWidget(title.title, title.author, title.date, range.to - range.from) }] });
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
        case "UnknownCommand":
          return unknownCommand(node);
      }
      return;
    },
    leave(ref) {
      if (ref.name === "ListEnvironment" && lists.length && lists[lists.length - 1].node.from === ref.from) lists.pop();
    },
  });

  function environment(node: SyntaxNode): false | undefined {
    const formed = wellFormedEnvironment(node, state);
    if (!formed) return undefined;
    const name = formed.name;
    const theorem = defs.theorems.get(name);
    const user = defs.environments.get(name);
    const block = TEXT_BLOCKS[name];
    if (!theorem && !user && !block && name !== "proof") return undefined;
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
      const after = readOptional(read(state, begin.to, Math.min(doc.length, begin.to + 400)), 0, TEX_GROUPS);
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

    if (theorem || name === "proof" || name === "abstract") {
      const variant = theorem ? "theorem" : name === "proof" ? "proof" : "abstract";
      const title = theorem ? theorem.title : name === "proof" ? (note ?? "Proof") : "Abstract";
      const header = new EnvironmentHeaderWidget(variant, title, theorem ? note : null, theorem?.numbered ? "theorem" : null, 0);
      const span = aloneOnLines(doc, begin.from, headerEnd);
      if (structural) {
        emit({ kind: "env-header", from: span?.from ?? begin.from, to: headerEnd, reveal: "line", wholeLine: true, replaces: [{ from: span?.from ?? begin.from, to: headerEnd, widget: header }] });
        if (name === "proof") {
          const endSpan = aloneOnLines(doc, formed.end.from, formed.end.to);
          emit({ kind: "env-footer", from: formed.end.from, to: formed.end.to, reveal: "line", wholeLine: true, replaces: [{ from: endSpan?.from ?? formed.end.from, to: formed.end.to, widget: new EnvironmentFooterWidget(null) }] });
        } else collapseLine(formed.end, "env-end");
      }
      const styleClass = theorem ? THEOREM_STYLE_CLASSES[theorem.style] : name === "abstract" ? "cm-vis-abstract" : "cm-vis-proof";
      if (formed.content && formed.content.to > headerEnd) emit({ kind: "env-body", from: headerEnd, to: formed.end.from, reveal: "never", replaces: [], marks: [{ from: headerEnd, to: formed.end.from, class: styleClass }], lines: name === "abstract" && contentLines && contentLines.to >= contentLines.from ? [{ ...contentLines, class: "cm-vis-abstract-line" }] : undefined });
      return undefined;
    }
    if (user) {
      const beginCode = environmentCode(userArgs ? substituteArguments(user.begin, userArgs) : user.begin);
      const endCode = environmentCode(user.end);
      if (structural) {
        const span = aloneOnLines(doc, begin.from, headerEnd);
        if (beginCode) emit({ kind: "env-header", from: span?.from ?? begin.from, to: headerEnd, reveal: "line", wholeLine: true, replaces: [{ from: span?.from ?? begin.from, to: headerEnd, widget: new EnvironmentHeaderWidget("user", beginCode, null, null, 0) }] });
        else collapseLine(begin, "env-begin", span ? undefined : { from: begin.from, to: headerEnd });
        const endSpan = aloneOnLines(doc, formed.end.from, formed.end.to);
        if (endCode) emit({ kind: "env-footer", from: formed.end.from, to: formed.end.to, reveal: "line", wholeLine: true, replaces: [{ from: endSpan?.from ?? formed.end.from, to: formed.end.to, widget: new EnvironmentFooterWidget(endCode) }] });
        else collapseLine(formed.end, "env-end");
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

  function unknownCommand(node: SyntaxNode): false | undefined {
    const ctrl = node.firstChild;
    if (!ctrl) return undefined;
    const text = read(state, ctrl.from, ctrl.to);
    // `\setcounter{enumi}{3}` in a list: its next item is 4.
    if (/^\\(?:set|addto|step|refstep)counter$/.test(text)) for (let i = lists.length - 1; i >= 0; i--) {
      if (lists[i].variant !== "number") continue;
      const change = counterChange(state, node, enumCounter(lists[i].depth));
      if (change) { lists[i].count = change(lists[i].count); return undefined; }
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
    if (SYMBOL_COMMANDS[text] !== undefined && emptyArgs) {
      emit({ kind: "symbol", from: ctrl.from, to: end, reveal: "never", replaces: [{ from: ctrl.from, to: end, widget: new SymbolWidget(SYMBOL_COMMANDS[text], read(state, ctrl.from, end), /TeX/.test(text) ? "cm-vis-symbol cm-vis-logo" : "cm-vis-symbol") }] });
      return false;
    }
    if (text === "\\today" && emptyArgs) {
      emit({ kind: "symbol", from: ctrl.from, to: end, reveal: "never", replaces: [{ from: ctrl.from, to: end, widget: new SymbolWidget(todayText(), read(state, ctrl.from, end)) }] });
      return false;
    }
    return undefined;
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

  function macroUse(node: SyntaxNode, name: string): false | undefined {
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
    if (!use) return undefined;
    const to = node.from + use.length;
    const fingerprint = use.used.join(",");
    const ensure = /^\s*\\ensuremath\s*\{([\s\S]*)\}\s*$/.exec(use.text);
    if (ensure || (needsMathMode(use.text) && macroAt(defs, name, node.from)?.mathOnly)) {
      // A math macro used in text through \ensuremath: drawn as a formula.
      const latex = ensure ? ensure[1] : use.text;
      const html = renderKatex(expandLatexMacros(latex, defs, { mode: "math", pos: node.from }).text, false);
      if (!html) return undefined;
      emit({ kind: "math", from: node.from, to, reveal: "strict", replaces: [{ from: node.from, to, widget: new MathWidget(html, false, false, read(state, node.from, to), false, 0, to - node.from) }] });
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
 * Whether the figure widget would show everything in a figure or table: its
 * images, tables, one caption, labels, comments and layout commands. Text,
 * other commands and sub-figures are not drawn by it, so such a figure stays
 * source (its parts render on their own).
 */
function figureCovered(node: SyntaxNode, state: EditorState) {
  const content = node.getChild("Content");
  if (!content) return true;
  let covered = true;
  let captions = 0;
  content.cursor().iterate((ref) => {
    if (!covered) return false;
    const name = ref.name;
    if (ref.type.isError) { covered = false; return false; }
    if (SKIPPED.has(name) || name === "Whitespace" || name === "NewLine" || name === "BlankLine" || name === "LineBreak" || name === "Tilde") return false;
    if (name === "IncludeGraphics" || name === "Label" || name === "TabularEnvironment" || name === "SetLengthCommand" || name === "Centering") return false;
    if (name === "Caption") { if (++captions > 1) covered = false; return false; }
    if (name === "Normal") { if (read(state, ref.from, ref.to).trim()) covered = false; return false; }
    if (name === "UnknownCommand") {
      const ctrl = ref.node.firstChild;
      if (!ctrl || !FIGURE_LAYOUT.test(read(state, ctrl.from, ctrl.to))) covered = false;
      return false;
    }
    // `\begin{center}` around a table: its markup is layout, its content is checked.
    if (name === "Environment") { if (environmentName(ref.node, (from, to) => read(state, from, to)) !== "center") covered = false; return undefined; }
    if (name === "BeginEnv" || name === "EndEnv") return false;
    if (name === "Content" || name === "Text" || name === "Command" || name === "KnownCommand" || name === "KnownEnvironment") return undefined;
    covered = false;
    return false;
  });
  return covered;
}

/** What a figure or table environment shows: its images or tabulars, and its caption. */
function figureSpec(node: SyntaxNode, env: string, state: EditorState): FigureSpec | null {
  if (!figureCovered(node, state)) return null;
  const images: FigureSpec["images"] = [];
  const tabulars: Array<{ source: string; offset: number }> = [];
  let caption: SyntaxNode | null = null;
  let firstContent = Number.MAX_SAFE_INTEGER;
  node.cursor().iterate((ref) => {
    if (ref.name === "Comment") return false;
    if (ref.name === "IncludeGraphics") {
      const argument = ref.node.getChild("IncludeGraphicsArgument")?.getChild("FilePathArgument") ?? ref.node.getChild("IncludeGraphicsArgument");
      const inner = argument && argumentInner(argument);
      const options = ref.node.getChild("OptionalArgument");
      const optionsRange = options && argumentInner(options);
      if (inner) images.push({ path: state.doc.sliceString(inner.from, inner.to).trim(), width: graphicsWidth(optionsRange ? state.doc.sliceString(optionsRange.from, optionsRange.to) : null) });
      firstContent = Math.min(firstContent, ref.from);
      return false;
    }
    if (ref.name === "TabularEnvironment") {
      const source = state.doc.sliceString(ref.from, ref.to);
      // A longtable is shown as source (see the TabularEnvironment case): so is its table.
      if (/^\\begin\s*\{(?:longtable|xltabular)\*?\}/.test(source)) tabulars.push({ source: "", offset: ref.from });
      else tabulars.push({ source, offset: ref.from });
      firstContent = Math.min(firstContent, ref.from);
      return false;
    }
    if (ref.name === "Caption") {
      // A sub-figure's caption is not the figure's.
      let nested = false;
      for (let parent = ref.node.parent; parent && parent.from !== node.from; parent = parent.parent) if (parent.name === "FigureEnvironment" || parent.name === "TableEnvironment") nested = true;
      if (!nested) caption = ref.node;
      return false;
    }
    return undefined;
  });
  const captionNode = caption as SyntaxNode | null;
  const captionArgument = captionNode?.getChild("TextArgument");
  const captionRange = captionArgument && argumentInner(captionArgument);
  if (!images.length && !tabulars.length && !captionRange) return null;
  if (tabulars.some((tabular) => !parseTabular(tabular.source, 0))) return null;
  return {
    env,
    images,
    caption: captionRange ? state.doc.sliceString(captionRange.from, captionRange.to) : null,
    captionPos: captionRange?.from ?? node.from,
    start: node.from,
    base: images.length ? graphicsBase(state) : undefined,
    kind: node.name === "TableEnvironment" ? "table" : "figure",
    numberOffset: 0,
    length: node.to - node.from,
    tabulars: tabulars.length ? tabulars : undefined,
    captionAbove: captionRange ? captionRange.from < firstContent : false,
  };
}

/** `\title`, `\author` and `\date` from the document, for `\maketitle`. */
const titleCache = new WeakMap<Text, Map<number, ReturnType<typeof scanTitleParts>>>();

/** `\title`, `\author` and `\date` before a `\maketitle` at `pos` (cached per document version). */
function readTitleParts(state: EditorState, pos: number) {
  let byPos = titleCache.get(state.doc);
  if (!byPos) titleCache.set(state.doc, byPos = new Map());
  let parts = byPos.get(pos);
  if (!parts) byPos.set(pos, parts = scanTitleParts(state, pos));
  return parts;
}

function scanTitleParts(state: EditorState, pos: number) {
  // TeX reads them before \maketitle; the preamble is where they almost always are.
  const text = state.doc.sliceString(0, Math.min(pos, 120_000));
  const part = (command: string) => {
    const pattern = new RegExp(`\\\\${command}\\s*(?:\\[[^\\]]*\\])?\\s*\\{`, "g");
    let found: string | null = null;
    for (const match of text.matchAll(pattern)) {
      const lineStart = text.lastIndexOf("\n", match.index ?? 0) + 1;
      if (/(^|[^\\])%/.test(text.slice(lineStart, match.index))) continue;
      const open = (match.index ?? 0) + match[0].length - 1;
      let depth = 0;
      for (let i = open; i < text.length; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) { found = text.slice(open + 1, i); break; }
      }
    }
    return found;
  };
  return { title: part("title"), author: part("author"), date: part("date") };
}
