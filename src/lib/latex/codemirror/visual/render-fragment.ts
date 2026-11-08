import type { SyntaxNode } from "@lezer/common";
import { latexParser as parser } from "../latex-parser";
import type { LatexAuxData } from "../../aux-file";
import type { LatexDefinitions } from "../../macros/definitions";
import { expandLatexMacros } from "../../macros/expand";
import type { LatexNumbering } from "../../macros/numbering";
import { renderKatex } from "./math-render";
import { citationText, referenceChipText, type BibLookup } from "./references";
import { circledText, CONTROL_SYMBOLS, cssColor, FONT_SWITCHES, LIGATURE_CHARS, readAccent, SIZE_COMMAND, SYMBOL_COMMANDS, TEXT_LIGATURES, todayText } from "./symbols";

/* A static renderer for short LaTeX: captions, macro expansions, theorem
 * names, table cells and the title block (docs/latex-visual-editor-plan.md
 * §7.4). It knows the same inline constructs as the Visual mode; anything
 * else is shown as source in monospace, so it never misrepresents its input. */

export type FragmentContext = {
  defs: LatexDefinitions;
  numbering: LatexNumbering;
  aux: LatexAuxData;
  bib: BibLookup;
  /** Where the fragment is in the open file, for definitions written in the body. */
  pos?: number;
  /** Draws an image of the project (an `\includegraphics` in a table cell); without it, the command shows as source. */
  image?: (path: string, width: string | null) => Node;
  /** Draws a tabular nested in a cell, read-only; without it, the tabular shows as source. */
  tabular?: (source: string) => Node;
};

/** Commands that print nothing here: spacing helpers that only matter to TeX's line breaking. */
const INVISIBLE = new Set(["\\xspace", "\\ignorespaces", "\\unskip", "\\relax", "\\protect", "\\nobreak", "\\null", "\\leavevmode", "\\strut", "\\raggedright", "\\raggedleft", "\\arraybackslash", "\\selectfont"]);
/** Layout inside a drawn caption, cell or title (not in text, where it stays as source): vertical space and settings draw nothing… */
const VERTICAL_LAYOUT = /^\\(?:vspace|vskip|smallskip|medskip|bigskip|vfill|addvspace|newpage|clearpage|pagebreak|noindent|par|fontsize|setlength|addtolength|linespread|baselineskip)\*?$/;
/** …and horizontal space is a space. */
const HORIZONTAL_SPACE = /^\\(?:hspace|hskip|hfill|hfil|enskip|enspace)\*?$/;
/** Boxes that print their (last) argument: `\mbox{…}`, `\rlap{$^*$}`, `\multirow{2}{*}{…}`, `\rotatebox{90}{…}`. */
const BOXES = new Set(["\\mbox", "\\hbox", "\\makebox", "\\fbox", "\\framebox", "\\rlap", "\\llap", "\\text", "\\textnormal", "\\textup", "\\textrm", "\\textmd", "\\textsl", "\\centerline", "\\multirow", "\\rotatebox", "\\raisebox", "\\scalebox", "\\resizebox", "\\parbox", "\\makecell", "\\shortstack"]);
/** Citation commands of other bibliography styles, as the natbib command they act like (ACL's `\newcite` is `\citet`). */
export const CITE_ALIASES: Record<string, string> = { "\\newcite": "\\citet", "\\shortcite": "\\cite", "\\citeN": "\\citet", "\\citeNP": "\\citep", "\\citealtNP": "\\citealt" };

/**
 * TeX's own conditionals in a macro's expansion, which a drawing cannot evaluate: the `\else`
 * branch, or nothing. cvpr.sty's `\onedot` (`\futurelet\@let@token\@onedot`, then
 * `\ifx\@let@token.\else.\null\fi`) adds the dot after `\eg`: "e.g.".
 */
function withoutConditionals(text: string) {
  // An inline TikZ drawing (`\tikz\fill[c] (0,0) rectangle (1ex,1ex);`, a colour key in a table): a small square.
  if (text.includes("\\tikz")) text = text.replace(/\\tikz(?![A-Za-z@])\s*(?:\[[^\]]*\]\s*)?(?:\{(?:[^{}]|\{[^{}]*\})*\}|[^;]*;)/g, "■");
  if (!/\\(?:if|futurelet)/.test(text)) return text;
  return text
    .replace(/\\futurelet\s*\\[A-Za-z@]+/g, "")
    .replace(/\\if[A-Za-z@]*\s*(?:\\[A-Za-z@]+|[^\\\s])\s*(?:\\[A-Za-z@]+|[^\\\s])?([^]*?)\\else([^]*?)\\fi(?![A-Za-z@])/g, "$2")
    .replace(/\\if[A-Za-z@]*\s*(?:\\[A-Za-z@]+|[^\\\s])\s*(?:\\[A-Za-z@]+|[^\\\s])?[^]*?\\fi(?![A-Za-z@])/g, "");
}

/** An `\includegraphics` width as CSS: `0.5\linewidth` as 50%, absolute units as written; null when not one of those. */
export function graphicsWidthCss(options: string | null) {
  const width = options && /(?:^|,)\s*width\s*=\s*([\d.]*)\s*(\\(?:line|text|column)width|cm|mm|in|pt|em|ex|px)/.exec(options);
  if (!width) return null;
  const amount = width[1] ? Number(width[1]) : 1;
  if (!Number.isFinite(amount)) return null;
  return width[2].startsWith("\\") ? `${Math.min(100, amount * 100)}%` : `${amount}${width[2]}`;
}

const STYLE_TAGS: Record<string, [string, string?]> = {
  TextBoldCommand: ["strong"], TextItalicCommand: ["em"], EmphasisCommand: ["em", "cm-vis-em"], UnderlineCommand: ["u"],
  TextTeletypeCommand: ["code", "cm-vis-tt"], TextSmallCapsCommand: ["span", "cm-vis-sc"], TextSansSerifCommand: ["span", "cm-vis-sf"],
  TextMediumCommand: ["span", "cm-vis-md"], StrikeOutCommand: ["s"], TextSuperscriptCommand: ["sup"], TextSubscriptCommand: ["sub"],
};

function element(tag: string, className?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function raw(text: string) {
  const code = element("code", "cm-vis-raw");
  code.textContent = text;
  return code;
}

/** Text with dashes and TeX quotes typeset. */
export function typesetText(text: string) {
  return text.replace(TEXT_LIGATURES, (match) => LIGATURE_CHARS[match] ?? match).replace(/~/g, " ");
}

/** The inside of an argument node (`{…}` or `[…]`), as a range. */
export function argumentInner(node: SyntaxNode) {
  const first = node.firstChild;
  const last = node.lastChild;
  if (!first || !last) return null;
  const opened = first.name === "OpenBrace" || first.name === "OpenBracket" ? first.to : node.from;
  // An argument that never closed (an error node last) has no inside to show.
  if (last.type.isError || (last.name !== "CloseBrace" && last.name !== "CloseBracket")) {
    // ShortTextArgument wraps the braces one level down.
    if (first.name === "ShortTextArgument" || first.name === "TextArgument") return argumentInner(first);
    return null;
  }
  return { from: opened, to: last.from };
}

/** The arguments of a command node, in order: `{…}` ones and `[…]` ones. */
export function commandArguments(node: SyntaxNode) {
  const args: Array<{ node: SyntaxNode; optional: boolean }> = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "OptionalArgument") args.push({ node: child, optional: true });
    else if (/Argument$/.test(child.name)) args.push({ node: child, optional: false });
  }
  return args;
}

/** Whether a node or one of its direct children is a parse error. */
export function hasDirectError(node: SyntaxNode) {
  if (node.type.isError) return true;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.isError) return true;
    // Arguments carry their own closing brace.
    if (/Argument$/.test(child.name) && child.lastChild?.type.isError) return true;
  }
  return false;
}

export function renderLatexFragment(latex: string, context: FragmentContext): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const expansion = expandLatexMacros(latex, context.defs, { mode: "text", pos: context.pos });
  // Accents (`\'e`) span a command and the letter after it; typeset them before parsing.
  const source = withoutConditionals(expansion.text).replace(/\\(?:['`^"~=.]|[uvHckrdb](?![A-Za-z]))\s*(?:\{\s*(?:\\[ij]|[A-Za-z])\s*\}|(?:\\[ij](?![A-Za-z])|[A-Za-z]))/g, (match) => readAccent(match)?.char ?? match);
  const tree = parser.parse(source);
  const read = (from: number, to: number) => source.slice(from, to);

  const renderRange = (parent: Node, from: number, to: number, container: SyntaxNode) => {
    let at = from;
    // `\bf` and `\small` style (or size) everything after them in their group.
    let target = parent;
    for (let child = container.firstChild; child; child = child.nextSibling) {
      if (child.to <= from || child.from >= to) continue;
      if (child.from > at) target.appendChild(document.createTextNode(typesetText(read(at, child.from))));
      const switched = fontSwitch(child);
      if (switched) {
        if (switched.className) { const span = element("span", switched.className); target.appendChild(span); target = span; }
        // What the parser hung on the switch is text: `\tt [CLS]`, `\small{…}`.
        for (let argument = switched.command.firstChild; argument; argument = argument.nextSibling) {
          if (argument.name === "OptionalArgument") target.appendChild(document.createTextNode(typesetText(read(argument.from, argument.to))));
          else if (argument.name === "TextArgument" || argument.name === "ShortTextArgument") renderArgument(target, argument);
        }
        at = child.to;
        continue;
      }
      renderNode(target, child);
      at = child.to;
    }
    if (at < to) target.appendChild(document.createTextNode(typesetText(read(at, to))));
  };

  /** A font or size switch (`\bf`, `\small`): its command and the class it styles with ("" for a size). */
  const fontSwitch = (node: SyntaxNode) => {
    const command = node.name === "Command" ? node.firstChild : node;
    const ctrl = command?.name === "UnknownCommand" ? command.firstChild : null;
    if (!command || !ctrl || ctrl.name !== "CtrlSeq") return null;
    const text = read(ctrl.from, ctrl.to);
    const className = FONT_SWITCHES[text] ?? (SIZE_COMMAND.test(text) ? "" : undefined);
    return className === undefined ? null : { command, className };
  };

  const renderArgument = (parent: Node, argument: SyntaxNode) => {
    const inner = argumentInner(argument);
    if (!inner) { parent.appendChild(raw(read(argument.from, argument.to))); return; }
    // Descend to the node holding the content (LongArg, ShortArg), keeping the range.
    let holder: SyntaxNode = argument;
    for (let child = argument.firstChild; child; child = child.nextSibling) {
      if (child.from <= inner.from && child.to >= inner.to && child.name !== "OpenBrace") holder = child;
    }
    renderRange(parent, inner.from, inner.to, holder);
  };

  const renderNode = (parent: Node, node: SyntaxNode): void => {
    const name = node.name;
    if (node.type.isError) { parent.appendChild(raw(read(node.from, node.to))); return; }
    switch (name) {
      case "Comment": return;
      case "Whitespace": case "NewLine": parent.appendChild(document.createTextNode(" ")); return;
      case "BlankLine": parent.appendChild(element("br")); return;
      case "Normal": parent.appendChild(document.createTextNode(typesetText(read(node.from, node.to)))); return;
      case "Tilde": parent.appendChild(document.createTextNode(" ")); return;
      case "Ampersand": parent.appendChild(document.createTextNode(" ")); return;
      case "OpenBrace": case "CloseBrace": return;
      case "DollarMath": case "ParenMath": case "BracketMath": {
        const display = name === "BracketMath" || !!node.getChild("DisplayMath");
        const math = display && name === "DollarMath" ? node.getChild("DisplayMath")!.getChild("Math") : (node.getChild("InlineMath")?.getChild("Math") ?? node.getChild("Math"));
        const html = math ? renderKatex(read(math.from, math.to), false) : null;
        if (!html) { parent.appendChild(raw(read(node.from, node.to))); return; }
        const span = element("span", "cm-vis-fragment-math");
        span.innerHTML = html;
        parent.appendChild(span);
        return;
      }
    }
    if (name === "Command" || name === "KnownCommand" || name === "KnownCtrlSym") {
      for (let child = node.firstChild; child; child = child.nextSibling) renderNode(parent, child);
      return;
    }
    if (name === "LineBreak") { parent.appendChild(element("br")); return; }
    const style = STYLE_TAGS[name];
    if (style) {
      const argument = node.getChild("TextArgument") ?? node.getChild("ShortTextArgument");
      if (!argument || hasDirectError(node)) { parent.appendChild(raw(read(node.from, node.to))); return; }
      const wrapper = element(style[0], style[1]);
      renderArgument(wrapper, argument);
      parent.appendChild(wrapper);
      return;
    }
    if (name === "TextColorCommand" || name === "ColorBoxCommand") {
      const args = commandArguments(node);
      const model = args.find((arg) => arg.optional);
      const mandatory = args.filter((arg) => !arg.optional);
      const colorRange = mandatory[0] ? argumentInner(mandatory[0].node) : null;
      const color = colorRange ? cssColor(model ? read(argumentInner(model.node)!.from, argumentInner(model.node)!.to) : null, read(colorRange.from, colorRange.to)) : null;
      if (!color || !mandatory[1]) { parent.appendChild(raw(read(node.from, node.to))); return; }
      const span = element("span", name === "ColorBoxCommand" ? "cm-vis-colorbox" : undefined);
      if (name === "ColorBoxCommand") span.style.backgroundColor = color; else span.style.color = color;
      renderArgument(span, mandatory[1].node);
      parent.appendChild(span);
      return;
    }
    if (name === "HrefCommand") {
      const text = node.getChild("ShortTextArgument") ?? node.getChild("TextArgument");
      const span = element("span", "cm-vis-link");
      if (text) renderArgument(span, text);
      parent.appendChild(span);
      return;
    }
    if (name === "UrlCommand") {
      const url = node.getChild("UrlArgument");
      const span = element("span", "cm-vis-link");
      span.textContent = url ? read(url.from + 1, url.to - 1) : "";
      parent.appendChild(span);
      return;
    }
    if (name === "FootnoteCommand" || name === "EndnoteCommand") {
      parent.appendChild(Object.assign(element("sup", "cm-vis-footnote-mark"), { textContent: "*" }));
      return;
    }
    // Alignment and lengths inside a cell or caption (`\centering`, `\setlength{\tabcolsep}{0pt}`) have no effect here.
    if (name === "Label" || name === "Centering" || name === "SetLengthCommand") return;
    // Brackets the parser took for an optional argument (`mAP@[.5, .95]`) are text.
    if (name === "OptionalArgument" || name === "OpenBracket" || name === "CloseBracket") { parent.appendChild(document.createTextNode(typesetText(read(node.from, node.to)))); return; }
    // A tabular inside a cell (`\begin{tabular}{@{}c@{}}LOC \\ method\end{tabular}`): a small grid.
    if (name === "TabularEnvironment" && context.tabular) { parent.appendChild(context.tabular(read(node.from, node.to))); return; }
    if (name === "KnownEnvironment") { renderRange(parent, node.from, node.to, node); return; }
    // `\multicolumn{2}{c}{…}` outside a table cell: its text.
    if (name === "MultiColumn") {
      const argument = node.getChildren("TextArgument").at(-1) ?? node.getChildren("ShortTextArgument").at(-1);
      if (argument) { renderArgument(parent, argument); return; }
    }
    // `\textnormal{…}`, `\text{…}`, `\mbox{…}` outside math: their text.
    if (name === "MathTextCommand") {
      const argument = node.getChild("TextArgument") ?? node.getChild("ShortTextArgument");
      if (argument) { renderArgument(parent, argument); return; }
    }
    if (name === "IncludeGraphics" && context.image) {
      // An image in a table cell or caption.
      const argument = node.getChild("IncludeGraphicsArgument")?.getChild("FilePathArgument") ?? node.getChild("IncludeGraphicsArgument");
      const inner = argument && argumentInner(argument);
      const options = node.getChild("OptionalArgument");
      if (inner) { parent.appendChild(context.image(read(inner.from, inner.to).trim(), graphicsWidthCss(options ? read(options.from + 1, options.to - 1) : null))); return; }
    }
    if (name === "Cite") {
      const keys = node.getChild("BibKeyArgument");
      const ctrl = node.firstChild!;
      const keyText = keys ? read(keys.from, keys.to).replace(/^\{|\}$/g, "") : "";
      const optionals = node.getChildren("OptionalArgument").map((arg) => read(arg.from + 1, arg.to - 1));
      const chip = element("span", "cm-vis-chip cm-vis-cite");
      chip.textContent = citationText({ command: read(ctrl.from, ctrl.to), keys: keyText.split(",").map((key) => key.trim()).filter(Boolean), pre: optionals.length > 1 ? optionals[0] : undefined, post: optionals.at(-1) }, context.aux, context.bib);
      parent.appendChild(chip);
      return;
    }
    if (name === "Ref") {
      const keys = node.getChild("RefArgument");
      const ctrl = node.firstChild!;
      const keyText = keys ? read(keys.from, keys.to).replace(/^\{|\}$/g, "") : "";
      const chip = element("span", "cm-vis-chip cm-vis-ref");
      chip.textContent = referenceChipText(read(ctrl.from, ctrl.to), keyText.split(",").map((key) => key.trim()).filter(Boolean), context.numbering, context.aux, context.defs);
      parent.appendChild(chip);
      return;
    }
    if (name === "UnknownCommand") {
      const ctrl = node.firstChild;
      const text = ctrl ? read(ctrl.from, ctrl.to) : "";
      if (ctrl?.name === "CtrlSym" && text in CONTROL_SYMBOLS) { parent.appendChild(document.createTextNode(CONTROL_SYMBOLS[text])); return; }
      if (text in SYMBOL_COMMANDS && commandArguments(node).every((arg) => read(arg.node.from, arg.node.to).replace(/\s/g, "") === "{}")) {
        parent.appendChild(document.createTextNode(SYMBOL_COMMANDS[text]));
        return;
      }
      if (text === "\\today") { parent.appendChild(document.createTextNode(todayText())); return; }
      // xspace: a space, unless punctuation, a closing brace, a footnote or the end follows (`\bert{} is` → "BERT is").
      if (text === "\\xspace") {
        const after = source.slice(ctrl!.to).replace(/^\s+/, "");
        if (after && !/^(?:[,.'/?;:!~\-)\]}"]|\\(?:footnote|footnotemark)(?![A-Za-z])|\\\/|\\ )/.test(after)) parent.appendChild(document.createTextNode(" "));
        return;
      }
      if (INVISIBLE.has(text) || VERTICAL_LAYOUT.test(text)) return;
      if (HORIZONTAL_SPACE.test(text)) { parent.appendChild(document.createTextNode(" ")); return; }
      if (BOXES.has(text)) {
        const argument = commandArguments(node).filter((arg) => !arg.optional).at(-1);
        if (argument) { renderArgument(parent, argument.node); return; }
      }
      if (CITE_ALIASES[text]) {
        const argument = commandArguments(node).find((arg) => !arg.optional);
        const inner = argument && argumentInner(argument.node);
        if (inner) {
          const chip = element("span", "cm-vis-chip cm-vis-cite");
          chip.textContent = citationText({ command: CITE_ALIASES[text], keys: read(inner.from, inner.to).split(",").map((key) => key.trim()).filter(Boolean) }, context.aux, context.bib);
          parent.appendChild(chip);
          return;
        }
      }
      if (SIZE_COMMAND.test(text) && !commandArguments(node).length) return;
      if (text === "\\textcircled") {
        const arg = commandArguments(node)[0];
        const inner = arg && !arg.optional ? argumentInner(arg.node) : null;
        const char = inner ? circledText(read(inner.from, inner.to)) : null;
        if (char) { parent.appendChild(document.createTextNode(char)); return; }
      }
      if (text === "\\and" || text === "\\And" || text === "\\AND") { parent.appendChild(element("span", "cm-vis-author-sep")); return; }
      if (text === "\\thanks") { parent.appendChild(Object.assign(element("sup", "cm-vis-footnote-mark"), { textContent: "*" })); return; }
      if (text === "\\footnotemark") { parent.appendChild(Object.assign(element("sup", "cm-vis-footnote-mark"), { textContent: "*" })); return; }
      if (text === "\\ensuremath") {
        const arg = commandArguments(node)[0];
        const inner = arg && argumentInner(arg.node);
        const html = inner ? renderKatex(read(inner.from, inner.to), false) : null;
        if (html) { const span = element("span", "cm-vis-fragment-math"); span.innerHTML = html; parent.appendChild(span); return; }
      }
      parent.appendChild(raw(read(node.from, node.to)));
      return;
    }
    // Groups and argument holders: render their content.
    if (name === "Group" || name === "NonEmptyGroup" || name === "LongArg" || name === "ShortArg" || name === "Text" || name === "Content" || name === "LaTeX" || name === "TextArgument" || name === "ShortTextArgument") {
      renderRange(parent, node.from, node.to, node);
      return;
    }
    parent.appendChild(raw(read(node.from, node.to)));
  };

  const top = tree.topNode;
  renderRange(fragment, 0, source.length, top);
  return fragment;
}

/** Renders a fragment into a new element. */
export function renderLatexInto(tag: string, className: string, latex: string, context: FragmentContext) {
  const node = element(tag, className);
  node.appendChild(renderLatexFragment(latex, context));
  return node;
}
