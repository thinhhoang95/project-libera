import { biblatexCitation, biblatexPostnote, biblatexPrenote } from "@/lib/references/biblatex-export";
import type { Citation, CitationItem, ReferenceEntry } from "@/lib/references/types";
import { isMacroBlockLanguage } from "@/lib/markdown-macros";
import { LATEX_COMMANDS } from "../codemirror/latex-data";
import {
  escapeLatexText, headingSlug, indentLines, isSafeMathTex, isSafeRawLatex, isValidLabel, labelSlug, latexUrl, mathSymbolsToCommands, uniqueLabel,
  type LatexTextOptions,
} from "../latex-text";

export { indentLines };
import { nodeChildren, plainText, sourceOf, stripHeadingNumber, type MarkdownStructure, type MdNode } from "./analyze";
import { parseHeadingTemplate } from "./choices";
import { bibliographyDialect, hasPackage, hasT1Fonts, isTwoColumn, type LatexPasteContext } from "./context";
import type { HeadingTarget, MarkdownPasteChoices } from "./options";
import { parseMarkdown, type ParsedMarkdown } from "./parse";

/* The Markdown tree as LaTeX (docs/latex-markdown-paste-plan.md §4). One walk;
 * the tree is never changed, so the dialog can convert it again for every
 * change of an option. Each construct records the packages it needs and
 * anything it had to drop. */

export type RequiredPackage = { name: string; options?: string; line: string; reason: string };
export type PasteWarning = { code: string; message: string };
export type ConvertResult = {
  latex: string;
  /** Paragraphs, lists, environments: pasted inside a line, it needs blank lines around it. */
  block: boolean;
  /** Every package the output needs. */
  packages: RequiredPackage[];
  /** The ones the preamble does not load. */
  missing: RequiredPackage[];
  warnings: PasteWarning[];
};

const PACKAGES: Record<string, { options?: string; satisfiedBy: string[] }> = {
  hyperref: { satisfiedBy: ["hyperref"] },
  url: { satisfiedBy: ["url", "hyperref"] },
  ulem: { options: "normalem", satisfiedBy: ["ulem"] },
  soul: { satisfiedBy: ["soul", "soulutf8"] },
  xcolor: { satisfiedBy: ["xcolor"] },
  booktabs: { satisfiedBy: ["booktabs"] },
  tabularx: { satisfiedBy: ["tabularx", "xltabular"] },
  longtable: { satisfiedBy: ["longtable", "xltabular"] },
  array: { satisfiedBy: ["array", "tabularx", "xltabular"] },
  float: { satisfiedBy: ["float"] },
  graphicx: { satisfiedBy: ["graphicx"] },
  amsmath: { satisfiedBy: ["amsmath", "mathtools"] },
  amssymb: { satisfiedBy: ["amssymb"] },
  amsfonts: { satisfiedBy: ["amsfonts", "amssymb"] },
  listings: { satisfiedBy: ["listings"] },
  csquotes: { satisfiedBy: ["csquotes"] },
  tcolorbox: { satisfiedBy: ["tcolorbox"] },
};

/**
 * LaTeX written in the Markdown's text is kept only when it is on this list
 * of text commands (from the completion data, plus common ones) or defined
 * by the document itself; anything else is shown as text. An allowlist, so a
 * pasted command that reads or writes files cannot slip through by name.
 */
const TEXT_COMMANDS = new Set(LATEX_COMMANDS.filter((command) => command.text && !command.math).map((command) => command.name)
  .concat(["LaTeX", "TeX", "today", "ldots", "dots", "noindent", "newline", "linebreak", "pagebreak", "clearpage", "cleardoublepage", "smallskip", "medskip", "bigskip", "vfill", "hfill", "quad", "qquad", "centering", "raggedright", "raggedleft", "S", "P", "dag", "ddag", "copyright", "textbackslash", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref", "cite", "citep", "citet", "parencite", "textcite", "autocite", "footcite", "nocite", "label", "footnote", "emph", "textbf", "textit", "texttt", "textsc", "textsf", "textrm", "underline", "url", "href", "mbox", "hspace", "vspace", "si", "SI", "num", "unit", "qty", "ce", "gls", "acrshort", "acrlong", "acrfull", "ac", "todo"]));
/** Math commands: allowed inside kept LaTeX (in its formulas), never kept on their own in text. */
const MATH_COMMANDS = new Set(LATEX_COMMANDS.filter((command) => command.math && !command.text).map((command) => command.name));
/** Environments kept when written in the text (others are shown as text). */
const TEXT_ENVIRONMENTS = new Set(["center", "flushleft", "flushright", "quote", "quotation", "verse", "itemize", "enumerate", "description", "tabular", "tabular*", "tabularx", "array", "equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "flalign", "flalign*", "alignat", "alignat*", "figure", "figure*", "table", "table*", "minipage", "abstract", "theorem", "lemma", "proof", "definition", "corollary", "proposition", "remark", "example", "note", "small", "footnotesize"]);
/** What may not stand where only inline text fits (a command argument, a table cell, a heading). */
const BLOCK_COMMAND = /^\\(?:begin|part|chapter|section|subsection|subsubsection|paragraph|subparagraph|par|item|newpage|clearpage|cleardoublepage|pagebreak|maketitle|tableofcontents|listoffigures|listoftables|printbibliography|bibliography|bibliographystyle|appendix|caption|centering|vspace|bigskip|medskip|smallskip|vfill)(?![A-Za-z@])/;

/** Fence languages as listings names them; no prototype, so `constructor` or `__proto__` is not a language. */
const LISTINGS_LANGUAGES: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  python: "Python", py: "Python", python3: "Python", c: "C", h: "C", cpp: "C++", "c++": "C++", cc: "C++", hpp: "C++", java: "Java",
  r: "R", matlab: "Matlab", octave: "Octave", sql: "SQL", html: "HTML", xml: "XML", bash: "bash", sh: "sh", shell: "bash", zsh: "bash",
  tex: "TeX", latex: "TeX", ruby: "Ruby", rb: "Ruby", perl: "Perl", php: "PHP", fortran: "Fortran", f90: "Fortran", haskell: "Haskell",
  hs: "Haskell", lisp: "Lisp", scala: "Scala", csharp: "[Sharp]C", cs: "[Sharp]C", "c#": "[Sharp]C", pascal: "Pascal", delphi: "Delphi",
  lua: "Lua", prolog: "Prolog", erlang: "erlang", gnuplot: "Gnuplot", make: "make", makefile: "make", awk: "Awk", vhdl: "VHDL",
  verilog: "Verilog", ada: "Ada", cobol: "Cobol", tcl: "tcl", ml: "ML", ocaml: "ML", mathematica: "Mathematica", python2: "Python",
});

/**
 * Listings options on every generated listing: the document's `\lstset` may
 * turn on escapes to TeX (`escapeinside`, `escapechar`, `mathescape`,
 * `texcl`), which would run pasted code as LaTeX; these turn them off here.
 */
const LISTING_SAFETY = "escapechar={},escapeinside={},mathescape=false,texcl=false";

const DIAGRAM_LANGUAGES = new Set(["mermaid", "plantuml", "dot", "graphviz", "ditaa", "d2", "tikz", "chart", "vega", "vega-lite"]);

/** Libera's box and highlight shortcuts as xcolor names. */
const BOX_COLORS: Record<string, string> = { y: "yellow", r: "red", o: "orange", a: "orange", g: "green", t: "teal", b: "blue", v: "violet", p: "pink", s: "gray" };

const ALERT = /^\[!([A-Za-z]+)\][+-]?[ \t]*([^\n]*)\n?/;
const ALERT_TITLES: Record<string, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution", info: "Info", abstract: "Abstract", summary: "Summary", todo: "To do", success: "Success", question: "Question", failure: "Failure", danger: "Danger", bug: "Bug", example: "Example", quote: "Quote" };

const BREAK = "\u0000BR\u0000";

/** Commands `soul` copes with inside `\hl` and `\st` (it registers the font commands itself). */
const SOUL_SAFE = new Set(["textbf", "textit", "emph", "textsl", "textsc", "textsf", "textrm", "textup", "textmd", "underline", "ldots", "dots", "textbackslash", "textasciitilde", "textasciicircum", "textless", "textgreater", "textbar", "S", "P", "copyright", "textbullet", "dag", "ddag", "textregistered", "texttrademark"]);

/** A display environment, which cannot stand inside inline math. */
const DISPLAY_ENVIRONMENT = /\\begin\s*\{(?:equation|align|gather|multline|flalign|alignat|eqnarray|displaymath)\*?\}/;

type BlockState = {
  itemize: number;
  enumerate: number;
  /** Other list-based environments around (quote, quotation, description…): LaTeX nests six in all. */
  other: number;
  /** Inside a list item, quote or footnote: headings become bold paragraphs. */
  nested: boolean;
  /** Inside a footnote: no verbatim, no floats. */
  footnote: boolean;
};

type InlineState = {
  /** A sectioning title or caption: no line breaks, links as text, fragile commands protected. */
  moving?: boolean;
  /** A table cell: "wrap" columns take `\newline`, others a space. */
  cell?: "wrap" | "nowrap";
  footnote?: boolean;
  link?: boolean;
  /** Inside another command's argument (`\textbf{…}`): no `\verb`. */
  argument?: boolean;
};

function wrap(command: string, content: string) {
  return content.trim() ? `\\${command}{${content}}` : content;
}

function romanCounter(level: number) {
  return ["i", "ii", "iii", "iv"][Math.min(3, Math.max(0, level - 1))];
}

/** An optional argument; braces keep a `]` inside from ending it. */
function optionalArgument(text: string) {
  return /[\][]/.test(text) ? `[{${text}}]` : `[${text}]`;
}

/** The commands a formula uses that need a package. */
function mathPackages(tex: string): string[] {
  const needs: string[] = [];
  if (/\\(?:text|operatorname|tag|dfrac|tfrac|binom|dbinom|tbinom|iint|iiint|boldsymbol|eqref|substack|overset|underset|xrightarrow|xleftarrow|intertext)(?![A-Za-z])|\\begin\s*\{(?:aligned|gathered|alignedat|cases|split|multline|align|gather|flalign|alignat|equation\*|smallmatrix|[pbvBV]?matrix)\*?\}/.test(tex)) needs.push("amsmath");
  if (/\\(?:square|blacksquare|lesssim|gtrsim|varnothing|checkmark|nexists|leqslant|geqslant|therefore|because|triangleq|boxtimes|boxplus|circledast|mathfrak|lll|ggg|nleq|ngeq|subsetneq|supsetneq|curlyvee|curlywedge|ltimes|rtimes|eqslantless|eqslantgtr|precsim|succsim|lessgtr|gtrless|blacktriangle|vartriangle|smallsetminus|complement|beth|gimel|daleth|hbar|hslash|digamma|varkappa|Bbbk|backprime|measuredangle|sphericalangle|nmid|nparallel|nsim|ncong|varpropto)(?![A-Za-z])/.test(tex)) needs.push("amssymb");
  else if (/\\mathbb(?![A-Za-z])/.test(tex)) needs.push("amsfonts");
  return needs;
}

/** A notebook path with `.` and `..` resolved, or null when it climbs above the notebook. */
function normalizeNotebookPath(segments: string[]) {
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (!out.length) return null; out.pop(); } else out.push(segment);
  }
  return out;
}

/**
 * The image path as LaTeX will read it: relative to `baseDir`, the folder TeX
 * runs from (the compile root's), or null when it cannot be included (an
 * absolute path, one above the notebook, or characters TeX would read).
 */
export function localImagePath(src: string, baseDir: string): { path: string } | { remote: string } | null {
  const value = src.trim();
  if (/^(?:file|data|blob):/i.test(value)) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return { remote: value };
  const base = baseDir.split("/").filter(Boolean);
  let target: string[] | null;
  const raw = /^\/api\/files\/raw\/(.+)$/.exec(value.split(/[?#]/)[0]);
  if (raw) {
    // A Libera file URL: notebook-relative.
    try { target = normalizeNotebookPath(raw[1].split("/").map(decodeURIComponent)); } catch { return null; }
  } else {
    let path = value.split(/[?#]/)[0];
    try { path = decodeURIComponent(path); } catch { /* kept as written */ }
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
    target = normalizeNotebookPath([...base, ...path.split("/")]);
  }
  if (!target?.length) return null;
  let common = 0;
  while (common < base.length && common < target.length - 1 && base[common] === target[common]) common++;
  const path = [...base.slice(common).map(() => ".."), ...target.slice(common)].join("/");
  if (/[{}%#\\$&^~]/.test(path) || /[\u0000-\u001f]/.test(path)) return null;
  return { path };
}

export class MarkdownLatexConverter {
  private readonly required = new Map<string, RequiredPackage>();
  private readonly warnings = new Map<string, PasteWarning>();
  private readonly counts = new Map<string, number>();
  private readonly labels: Set<string>;
  /** Text replaced for this conversion only (heading numbers, alert markers): the tree is never changed. */
  private readonly overrides = new Map<MdNode, string>();
  private readonly skip = new Set<MdNode>();
  private readonly headingRank = new Map<number, number>();
  private readonly headingLabels = new Map<string, string>();
  private readonly footnoteLabels = new Map<string, string>();
  private readonly footnotesShown = new Set<string>();
  private pendingFootnoteTexts: string[] | null = null;
  private readonly textOptions: LatexTextOptions;

  constructor(
    private readonly parsed: ParsedMarkdown,
    private readonly structure: MarkdownStructure,
    private readonly choices: MarkdownPasteChoices,
    private readonly context: LatexPasteContext,
  ) {
    this.labels = new Set(context.labels);
    this.textOptions = {
      ot1: !hasT1Fonts(context),
      unicode: context.engine !== "pdflatex",
      dropEmoji: context.engine === "pdflatex",
      onDropped: (count) => this.warn("emoji", count, (n) => `pdfLaTeX cannot typeset emoji: ${n} removed.`),
    };
    structure.depths.forEach((depth, rank) => this.headingRank.set(depth, rank));
    // A caption paragraph leaves the text only when caption detection is on and that table will write the caption.
    structure.tables.forEach((table, index) => {
      if (table.captionNode && choices.tableCaptionFromText && choices.tables[index]?.caption.trim() && this.tableHoldsCaption(table.inFootnote)) this.skip.add(table.captionNode);
    });
    if (structure.numberedHeadings && choices.stripHeadingNumbers) {
      for (const heading of structure.headings) {
        const first = this.firstText(heading.node);
        if (first) this.overrides.set(first, stripHeadingNumber(first.value ?? ""));
      }
    }
    // Labels, and the anchors `[text](#anchor)` links resolve to. Anchors are GitHub's: a repeated
    // heading gets `-1`, `-2`…; a starred heading has no \label, so it publishes no anchor.
    if (choices.headingLabels && !choices.headingStarred) {
      const anchors = new Map<string, number>();
      for (const heading of structure.headings) {
        const base = headingSlug(heading.text);
        const seen = anchors.get(base) ?? 0;
        anchors.set(base, seen + 1);
        if (heading.nested) continue;
        const target = this.targetFor(heading.depth);
        if (!SECTION_TARGETS.has(target)) continue;
        const prefix = target === "chapter" ? "chap" : target === "part" ? "part" : "sec";
        const text = heading.node.children ? plainText({ type: "x", children: heading.node.children.map((child) => this.overrides.has(child) ? { ...child, value: this.overrides.get(child) } : child) }) : heading.text;
        const label = uniqueLabel(`${prefix}:${labelSlug(text, "heading")}`, this.labels);
        this.headingLabels.set(seen ? `${base}-${seen}` : base, label);
        this.overrides.set(heading.node, label);
      }
    }
    for (const [id, count] of structure.footnoteReferences) {
      if (count > 1) this.footnoteLabels.set(id, uniqueLabel(`fn:${labelSlug(id, "note")}`, this.labels));
    }
  }

  convert(): ConvertResult {
    const root = this.parsed.tree as unknown as MdNode;
    let latex: string;
    let block = false;
    if (this.context.inlineOnly) latex = this.flatten(nodeChildren(root)).replace(/\s*\n\s*/g, " ").trim();
    else {
      const around = this.context.listDepth;
      const parts = this.blocks(nodeChildren(root), { itemize: around.itemize, enumerate: around.enumerate, other: around.other, nested: false, footnote: false });
      latex = parts.join("\n\n");
      block = parts.length > 1 || /^(?:\\(?:begin|\[|part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\b|%)/.test(parts[0] ?? "") || /\n\s*\n/.test(parts[0] ?? "");
    }
    for (const [id] of this.structure.footnotes) {
      if (!this.structure.footnoteReferences.has(id)) this.warn("unreferenced-footnote", 1, (n) => `${n} footnote${n === 1 ? " is" : "s are"} never referenced and ${n === 1 ? "was" : "were"} left out.`);
    }
    const packages = [...this.required.values()];
    const missing = packages.filter((pkg) => !PACKAGES[pkg.name]?.satisfiedBy.some((name) => this.context.packages.has(name)));
    return { latex: latex.trim(), block, packages, missing, warnings: [...this.warnings.values()] };
  }

  /* ---- bookkeeping ------------------------------------------------------- */

  private need(name: string, reason: string) {
    if (this.required.has(name)) return;
    const options = PACKAGES[name]?.options;
    this.required.set(name, { name, options, line: `\\usepackage${options ? `[${options}]` : ""}{${name}}`, reason });
  }

  private warn(code: string, by: number, message: (count: number) => string) {
    const count = (this.counts.get(code) ?? 0) + by;
    this.counts.set(code, count);
    this.warnings.set(code, { code, message: message(count) });
  }

  private firstText(node: MdNode): MdNode | null {
    for (const child of nodeChildren(node)) {
      if (child.type === "text") return child;
      if (child.children) { const found = this.firstText(child); if (found) return found; }
      return null;
    }
    return null;
  }

  /** Whether a table gets a caption: in a float or a longtable (never inside a footnote, where tables have no float). */
  private tableHoldsCaption(inFootnote = false) {
    if (inFootnote || this.context.inlineOnly) return false;
    return this.tableEnvironment() === "longtable" || this.choices.tableFloat !== "none";
  }

  /** The table environment in effect: longtable cannot be used in two-column documents, so tabular stands in. */
  private tableEnvironment() {
    return this.choices.tableEnvironment === "longtable" && isTwoColumn(this.context) ? "tabular" : this.choices.tableEnvironment;
  }

  private targetFor(depth: number): HeadingTarget {
    const rank = this.headingRank.get(depth) ?? 0;
    return this.choices.headingMap[rank] ?? "bold";
  }

  /* ---- blocks ------------------------------------------------------------ */

  private blocks(nodes: MdNode[], state: BlockState): string[] {
    const out: string[] = [];
    for (const node of nodes) {
      if (this.skip.has(node)) continue;
      const text = this.block(node, state);
      if (text !== null && text.trim()) out.push(text);
    }
    return out;
  }

  private block(node: MdNode, state: BlockState): string | null {
    switch (node.type) {
      case "heading": return this.heading(node, state);
      case "paragraph": return this.paragraph(node, state);
      case "list": return this.list(node, state);
      case "blockquote": return this.blockquote(node, state);
      case "code": return this.code(node, state);
      case "math": return this.displayMath(node.value ?? "", state);
      case "table": return this.table(node, state);
      case "html": return this.htmlBlock(node);
      case "thematicBreak": case "definition": case "footnoteDefinition": case "liberaBibliography": case "yaml": case "toml":
        return null;
      default:
        if (node.children) return this.blocks(node.children, state).join("\n\n");
        return node.value ? this.escape(node.value) : null;
    }
  }

  private heading(node: MdNode, state: BlockState): string | null {
    const title = this.inline(nodeChildren(node), { moving: true }).replace(/\s+/g, " ").trim();
    if (!title) return null;
    if (state.nested) return `\\textbf{${title}}`;
    const rank = this.headingRank.get(node.depth ?? 1) ?? 0;
    const target = this.targetFor(node.depth ?? 1);
    const label = this.overrides.get(node);
    const labelText = label && !this.choices.headingStarred ? `\\label{${label}}` : "";
    switch (target) {
      case "bold": return `\\textbf{${title}}`;
      case "plain": return title;
      case "custom": {
        const parsed = parseHeadingTemplate(this.choices.headingCustoms[rank] ?? this.choices.headingCustom);
        if ("error" in parsed) {
          this.warn("heading-template", 1, () => "The custom heading is not valid, so those headings were written in bold.");
          return `\\textbf{${title}}`;
        }
        return parsed.template.replace("#1", () => title);
      }
      default: return `\\${target}${this.choices.headingStarred ? "*" : ""}{${title}}${labelText}`;
    }
  }

  private paragraph(node: MdNode, state: BlockState): string | null {
    const children = nodeChildren(node);
    const meaningful = children.filter((child) => !(child.type === "text" && !(child.value ?? "").trim()) && child.type !== "break");
    // A formula alone in its paragraph, written `$$…$$` or `\[…\]` or holding a display environment, is display math.
    if (meaningful.length === 1 && meaningful[0].type === "inlineMath"
      && (/^(?:\$\$|\\\[)/.test(sourceOf(meaningful[0], this.parsed.source)) || DISPLAY_ENVIRONMENT.test(meaningful[0].value ?? ""))) {
      return this.displayMath(meaningful[0].value ?? "", state);
    }
    // Images alone in their paragraph become figures.
    const images = meaningful.filter((child) => child.type === "image" || child.type === "imageReference" || (child.type === "html" && /^<img\b/i.test(child.value ?? "")));
    if (images.length && images.length === meaningful.length && !state.footnote) {
      return images.map((image) => this.figure(image)).filter(Boolean).join("\n\n");
    }
    const text = this.inline(children, { footnote: state.footnote }).trim();
    return text || null;
  }

  private list(node: MdNode, state: BlockState): string {
    const ordered = !!node.ordered;
    const env = ordered ? "enumerate" : "itemize";
    const level = ordered ? state.enumerate : state.itemize;
    const inner: BlockState = { ...state, nested: true, itemize: state.itemize + (ordered ? 0 : 1), enumerate: state.enumerate + (ordered ? 1 : 0) };
    if (level >= 4 || state.itemize + state.enumerate + state.other >= 6) {
      // LaTeX nests lists four deep (six in all): deeper items join the list around them.
      this.warn("deep-list", 1, () => "Lists nested deeper than LaTeX allows were joined to the list around them.");
      return nodeChildren(node).map((item) => this.listItem(item, state)).join("\n");
    }
    const start = node.start ?? 1;
    const lines: string[] = [];
    let begin = `\\begin{${env}}`;
    if (ordered && start !== 1) {
      if (hasPackage(this.context, "enumitem")) begin += `[start=${start}]`;
      else lines.push(`  \\setcounter{enum${romanCounter(level + 1)}}{${start - 1}}`);
    }
    const items = nodeChildren(node).map((item) => indentLines(this.listItem(item, inner), "  "));
    return [begin, ...lines, ...items, `\\end{${env}}`].join("\n");
  }

  private listItem(item: MdNode, state: BlockState): string {
    let label = "";
    if (item.checked === true || item.checked === false) {
      label = hasPackage(this.context, "amssymb")
        ? item.checked ? "[$\\boxtimes$]" : "[$\\square$]"
        : item.checked ? "[{[x]}]" : "[{[\\,]}]";
    }
    const parts = this.blocks(nodeChildren(item), state);
    if (!parts.length) return `\\item${label}`;
    const [first, ...rest] = parts;
    // `\item [text` would read the bracket as the item's label.
    const head = !label && first.startsWith("[") ? `\\item{} ${first}` : `\\item${label} ${first}`;
    return rest.reduce((text, part) => text + (/^\\begin\{(?:itemize|enumerate)\}/.test(part) ? "\n" : "\n\n") + part, head);
  }

  private blockquote(node: MdNode, state: BlockState): string | null {
    const box = node.data?.hProperties?.["data-box-color"];
    let title: string | null = null;
    const firstParagraph = nodeChildren(node)[0]?.type === "paragraph" ? nodeChildren(node)[0] : null;
    const firstText = firstParagraph ? this.firstText(firstParagraph) : null;
    const alert = firstText && firstParagraph && nodeChildren(firstParagraph)[0] === firstText ? ALERT.exec(firstText.value ?? "") : null;
    if (alert && firstText) {
      title = alert[2].trim() || ALERT_TITLES[alert[1].toLowerCase()] || alert[1][0].toUpperCase() + alert[1].slice(1).toLowerCase();
      this.overrides.set(firstText, (firstText.value ?? "").slice(alert[0].length));
    }
    // quote and quotation are lists to LaTeX: they count toward its six levels of nesting.
    const parts = this.blocks(nodeChildren(node), { ...state, nested: true, other: state.other + 1 });
    if (alert && firstText) this.overrides.delete(firstText);
    const color = typeof box === "string" ? BOX_COLORS[box.toLowerCase()] ?? "gray" : alert ? alertColor(alert[1]) : null;
    const escapedTitle = title ? this.escape(title) : null;
    if ((box || alert) && hasPackage(this.context, "tcolorbox") && !state.footnote) {
      const options = [`colback=${color}!6!white`, `colframe=${color}!55!black`, ...(escapedTitle ? [`title={${escapedTitle}}`] : [])];
      return `\\begin{tcolorbox}[${options.join(",")}]\n${indentLines(parts.join("\n\n"), "  ")}\n\\end{tcolorbox}`;
    }
    if (escapedTitle) {
      if (parts.length && !/^\\begin\{/.test(parts[0])) parts[0] = `\\textbf{${escapedTitle}.} ${parts[0]}`;
      else parts.unshift(`\\textbf{${escapedTitle}.}`);
    }
    if (!parts.length) return null;
    const env = this.choices.blockquote;
    if (env === "displayquote") this.need("csquotes", "block quotes as displayquote");
    return `\\begin{${env}}\n${indentLines(parts.join("\n\n"), "  ")}\n\\end{${env}}`;
  }

  private code(node: MdNode, state: BlockState): string | null {
    const language = (node.lang ?? "").trim().toLowerCase();
    if (isMacroBlockLanguage(node.lang)) return null;
    if (language === "math" || language === "latex-math" || language === "katex") return this.displayMath(node.value ?? "", state);
    const value = (node.value ?? "").replace(/\t/g, "    ");
    if (DIAGRAM_LANGUAGES.has(language)) this.warn("diagram", 1, (n) => `${n} diagram${n === 1 ? "" : "s"} (${language}) pasted as code: LaTeX cannot draw ${n === 1 ? "it" : "them"}.`);
    if (state.footnote) return this.codeLines(value);
    const comment = DIAGRAM_LANGUAGES.has(language) ? `% Diagram (${language})\n` : "";
    if (this.choices.codeBlocks === "lstlisting" && !/\\end\s*\{lstlisting\}/.test(value)) {
      this.need("listings", "code blocks as lstlisting");
      const name = Object.hasOwn(LISTINGS_LANGUAGES, language) ? LISTINGS_LANGUAGES[language] : undefined;
      const options = [...(name ? [`language=${name.includes("[") ? `{${name}}` : name}`] : []), LISTING_SAFETY];
      return `${comment}\\begin{lstlisting}[${options.join(",")}]\n${value}\n\\end{lstlisting}`;
    }
    // Text that would end the verbatim block early is pasted as escaped lines instead.
    if (!/\\end\s*\{verbatim\}/.test(value)) return `${comment}\\begin{verbatim}\n${value}\n\\end{verbatim}`;
    return comment + this.codeLines(value);
  }

  private codeLines(value: string) {
    return value.split("\n").map((line) => `\\texttt{${this.escapeCode(line)}}`).join("\\\\\n");
  }

  /** The formula as it can be written, or null when it could leave its delimiters or read files. */
  private mathTex(value: string): string | null {
    const tex = value.trim();
    // `\\[2pt]` is a line break with spacing, not a display-math opener.
    if (!tex || !isSafeMathTex(tex.replace(/\\\\/g, "  "))) return null;
    for (const name of mathPackages(tex)) this.need(name, "commands in the formulas");
    if (this.context.engine !== "pdflatex") return tex;
    const converted = mathSymbolsToCommands(tex);
    if (converted !== tex && /\\mathbb/.test(converted) && !/\\mathbb/.test(tex)) this.need("amsfonts", "symbols such as ℝ in formulas");
    return converted;
  }

  private unsafeMath(value: string) {
    this.warn("unsafe-math", 1, (n) => `${n} formula${n === 1 ? "" : "s"} could break out of math or read files and ${n === 1 ? "was" : "were"} pasted as text.`);
    return this.escape(value.replace(/\s+/g, " ").trim());
  }

  private inlineMath(value: string) {
    let tex = this.mathTex(value);
    if (tex === null) return this.unsafeMath(value);
    if (DISPLAY_ENVIRONMENT.test(tex)) {
      // A display environment inside running text: its inline counterpart (aligned, gathered) or its content.
      tex = tex
        .replace(/\\(begin|end)\s*\{(?:align|flalign|alignat|eqnarray)\*?\}/g, "\\$1{aligned}")
        .replace(/\\(begin|end)\s*\{(?:gather|multline)\*?\}/g, "\\$1{gathered}")
        .replace(/\\(?:begin|end)\s*\{(?:equation|displaymath)\*?\}/g, "")
        .replace(/\\label\s*\{[^}]*\}/g, "")
        .trim();
      if (/\\begin\{(?:aligned|gathered)\}/.test(tex)) this.need("amsmath", "aligned formulas in text");
      this.warn("inline-display", 1, () => "A display formula inside running text was written inline.");
    }
    return this.choices.inlineMath === "paren" ? `\\(${tex}\\)` : `$${tex}$`;
  }

  private displayMath(value: string, state: BlockState | null): string {
    const tex = this.mathTex(value);
    if (tex === null) return this.unsafeMath(value);
    if (!state || this.context.inlineOnly) return this.inlineMath(value);
    // A complete display environment (written inside `$$` by some chat models) is written as itself.
    const environment = /^\\begin\{(equation|align|gather|multline|flalign|alignat|eqnarray)(\*?)\}[\s\S]*\\end\{\1\2\}$/.exec(tex);
    if (environment) {
      // equation (unstarred) and eqnarray are LaTeX's own; the rest, equation* included, are amsmath's.
      if (!(environment[1] === "equation" && !environment[2]) && environment[1] !== "eqnarray") this.need("amsmath", `the ${environment[1]}${environment[2]} environment`);
      return tex;
    }
    let topLevel = tex;
    for (let previous = ""; previous !== topLevel;) {
      previous = topLevel;
      topLevel = topLevel.replace(/\\begin\{([^}]*)\}(?:(?!\\begin\{)[\s\S])*?\\end\{\1\}/g, "");
    }
    const star = this.choices.displayMath !== "equation";
    if (/\\\\/.test(topLevel)) {
      const env = /(?<!\\)&/.test(topLevel) ? "align" : "gather";
      this.need("amsmath", `multi-line formulas (${env})`);
      return `\\begin{${env}${star ? "*" : ""}}\n${tex}\n\\end{${env}${star ? "*" : ""}}`;
    }
    switch (this.choices.displayMath) {
      case "equation*": this.need("amsmath", "equation*"); return `\\begin{equation*}\n${tex}\n\\end{equation*}`;
      case "equation": return `\\begin{equation}\n${tex}\n\\end{equation}`;
      default: return `\\[\n${tex}\n\\]`;
    }
  }

  private htmlBlock(node: MdNode): string | null {
    const html = (node.value ?? "").trim();
    if (!html || /^<!--[\s\S]*-->$/.test(html)) return null;
    if (/^<img\b/i.test(html)) return this.figure(node);
    if (/^<br\s*\/?>$/i.test(html)) return null;
    const text = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
    const tags = [...new Set([...html.matchAll(/<([A-Za-z][\w-]*)/g)].map((match) => match[1].toLowerCase()))].filter((tag) => !/^(?:div|p|span|details|summary|center|section|article|br)$/.test(tag));
    if (tags.length) this.warn("html", tags.length, () => "Some HTML had no LaTeX equivalent: its tags were dropped and its text kept.");
    const decoded = decodeEntities(text).trim();
    return decoded ? this.escape(decoded) : null;
  }

  /* ---- figures ----------------------------------------------------------- */

  private imageSource(node: MdNode): { src: string; alt: string; title: string } | null {
    if (node.type === "html") {
      const html = node.value ?? "";
      const attribute = (name: string) => decodeEntities(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(html)?.slice(1).find((value) => value !== undefined) ?? "");
      return { src: attribute("src"), alt: attribute("alt"), title: attribute("title") };
    }
    if (node.type === "imageReference") {
      const definition = node.identifier ? this.structure.definitions.get(node.identifier) : undefined;
      if (!definition) return null;
      return { src: definition.url, alt: node.alt ?? "", title: definition.title ?? "" };
    }
    return { src: node.url ?? "", alt: node.alt ?? "", title: node.title ?? "" };
  }

  private resolveImage(src: string) {
    const resolved = localImagePath(src, this.context.documentDir);
    if (!resolved) {
      this.warn("image-path", 1, (n) => `${n} image path${n === 1 ? "" : "s"} could not be used in LaTeX and ${n === 1 ? "was" : "were"} left as a comment.`);
      return null;
    }
    if ("remote" in resolved) {
      this.warn("remote-image", 1, (n) => `${n} image${n === 1 ? " is a web address" : "s are web addresses"}: download ${n === 1 ? "it" : "them"} into the project to include ${n === 1 ? "it" : "them"}.`);
      return null;
    }
    if (/\.(?:svg|webp|gif|bmp|tiff?|heic)$/i.test(resolved.path)) {
      this.warn("image-format", 1, (n) => `${n} image${n === 1 ? " is" : "s are"} in a format pdfLaTeX cannot include (convert to PDF, PNG or JPEG).`);
    }
    if (this.context.files && !this.context.files.has(resolved.path)) {
      this.warn("missing-image", 1, (n) => `${n} image${n === 1 ? " is" : "s are"} not in the project yet.`);
    }
    return resolved.path;
  }

  private figure(node: MdNode): string | null {
    const image = this.imageSource(node);
    if (!image?.src) return null;
    const path = this.resolveImage(image.src);
    const caption = (image.title || image.alt).trim();
    if (path === null) {
      // Embedded images (data: URIs from Word) are not written out.
      const shown = /^data:/i.test(image.src) ? "an embedded image" : image.src.replace(/[\r\n]+/g, " ");
      const comment = `% Image not in the project: ${shown.length > 160 ? `${shown.slice(0, 157)}…` : shown}`;
      return caption ? `${comment}\n${this.escape(caption)}` : comment;
    }
    if (this.choices.images === "comment") return `% Image: ${path}${caption ? ` (${caption.replace(/[\r\n]+/g, " ")})` : ""}`;
    this.need("graphicx", "images");
    const width = Number(this.choices.imageWidth.toFixed(2));
    const graphic = `\\includegraphics[width=${width === 1 ? "" : width}\\linewidth]{${path}}`;
    if (this.choices.images === "inline") return graphic;
    const placement = this.placement();
    const lines = [`\\begin{figure}${placement}`, "  \\centering", `  ${graphic}`];
    if (caption) {
      lines.push(`  \\caption{${this.escape(caption)}}`);
      lines.push(`  \\label{${uniqueLabel(`fig:${labelSlug(caption, "figure")}`, this.labels)}}`);
    }
    lines.push("\\end{figure}");
    return lines.join("\n");
  }

  private placement() {
    const placement = this.choices.tablePlacement;
    if (placement === "H") this.need("float", "the H float placement");
    return placement ? `[${placement}]` : "";
  }

  /* ---- tables ------------------------------------------------------------ */

  private table(node: MdNode, state: BlockState): string | null {
    const index = this.structure.tables.findIndex((table) => table.node === node);
    const info = this.structure.tables[index];
    const choice = this.choices.tables[index] ?? { caption: info?.caption ?? "", label: "" };
    const rows = nodeChildren(node);
    if (!rows.length) return null;
    if (node.data?.hProperties?.rowspan) this.warn("rowspan", 1, () => "Cells merged across rows were split: the text stays in the first row, the cells below are empty.");
    // Cells by column; a cell from HTML may span several (`colspan`).
    const slots = new Map(rows.map((row) => {
      let column = 0;
      return [row, nodeChildren(row).map((cell) => {
        const span = Math.max(1, Number(cell.data?.hProperties?.colspan ?? 1) || 1);
        const slot = { cell, column, span };
        column += span;
        return slot;
      })];
    }));
    const columns = Math.max(1, node.align?.length ?? 0, ...rows.map((row) => slots.get(row)!.reduce((sum, slot) => sum + slot.span, 0)));
    const align = Array.from({ length: columns }, (_, column) => node.align?.[column] ?? null);
    const header = rows[0];
    const headerEmpty = nodeChildren(header).every((cell) => !plainText(cell).trim());
    const body = rows.slice(1);
    const single = (column: number) => rows.flatMap((row) => slots.get(row)!.filter((slot) => slot.column === column && slot.span === 1).map((slot) => slot.cell));

    // Column widths from the length of their text.
    const lengths = Array.from({ length: columns }, (_, column) => Math.max(1, ...single(column).map((cell) => plainText(cell).length)));
    const hasBreak = (column: number) => single(column).some((cell) => /"type":"break"|<br\b/i.test(JSON.stringify(cell)));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const environment = this.tableEnvironment();
    if (environment !== this.choices.tableEnvironment) this.warn("longtable-twocolumn", 1, () => "longtable does not work in two-column documents, so the tables were written as tabular.");
    const wrap = this.choices.tableWrap || environment === "tabularx";
    let wrapped = new Set<number>();
    if (wrap) {
      lengths.forEach((length, column) => { if ((length > 40 && total > 70) || hasBreak(column)) wrapped.add(column); });
      if (environment === "tabularx" && !wrapped.size) wrapped = new Set([lengths.indexOf(Math.max(...lengths))]);
    } else lengths.forEach((_, column) => { if (hasBreak(column)) wrapped.add(column); });

    const letter = (column: number) => align[column] === "center" ? "c" : align[column] === "right" ? "r" : "l";
    const ragged = (column: number) => align[column] === "center" ? "\\centering" : align[column] === "right" ? "\\raggedleft" : "\\raggedright";
    const shortWidth = lengths.reduce((sum, length, column) => wrapped.has(column) ? sum : sum + length, 0);
    const longTotal = lengths.reduce((sum, length, column) => wrapped.has(column) ? sum + length : sum, 0) || 1;
    const available = Math.max(0.3, 0.9 - shortWidth / 90 - 0.04 * columns);
    const spec = Array.from({ length: columns }, (_, column) => {
      if (!wrapped.has(column)) return letter(column);
      if (environment === "tabularx") return `>{${ragged(column)}\\arraybackslash}X`;
      this.need("array", "wrapping table columns");
      const width = Math.max(0.1, Math.round((available * lengths[column] / longTotal) * 20) / 20);
      return `>{${ragged(column)}\\arraybackslash}p{${width.toFixed(2).replace(/0$/, "")}\\linewidth}`;
    });
    const rules = this.choices.tableRules;
    const columnSpec = rules === "grid" ? `|${spec.join("|")}|` : spec.join("");
    if (rules === "booktabs") this.need("booktabs", "booktabs table rules");

    // A merged cell's \multicolumn uses l, c or r, which cannot take \newline: its breaks become spaces.
    const cellText = (cell: MdNode | undefined, column: number, span: number, bold: boolean) => {
      if (!cell) return "";
      const text = this.inline(nodeChildren(cell), { cell: span === 1 && wrapped.has(column) ? "wrap" : "nowrap" }).replace(/\s*\n\s*/g, " ").trim();
      return bold && text ? `\\textbf{${text}}` : text;
    };
    const longtable = environment === "longtable" && !state.footnote;
    this.pendingFootnoteTexts = longtable ? null : [];
    const rowLine = (row: MdNode, bold: boolean) => {
      const cells: string[] = [];
      let column = 0;
      for (const slot of slots.get(row)!) {
        if (slot.column >= columns) break;
        const span = Math.min(slot.span, columns - slot.column);
        const text = cellText(slot.cell, slot.column, span, bold);
        if (span > 1) {
          const edge = rules === "grid" ? `${slot.column === 0 ? "|" : ""}${letter(slot.column)}|` : letter(slot.column);
          cells.push(`\\multicolumn{${span}}{${edge}}{${text}}`);
        } else cells.push(text);
        column = slot.column + span;
      }
      // Rows with fewer cells than the table are padded.
      while (column++ < columns) cells.push("");
      return `${cells.join(" & ")} \\\\`;
    };
    const headerLine = headerEmpty ? null : rowLine(header, this.choices.tableBoldHeader);
    const bodyLines = body.map((row) => rowLine(row, false));
    // Each \footnotemark in the table stepped the counter: step back to the first mark's number,
    // then forward again before each text, so every text gets its own mark's number.
    const marks = this.pendingFootnoteTexts ?? [];
    this.pendingFootnoteTexts = null;
    const footnoteTexts = marks.length > 1
      ? [`\\addtocounter{footnote}{-${marks.length - 1}}`, ...marks.map((text, at) => at ? `\\stepcounter{footnote}${text}` : text)]
      : marks;

    const top = rules === "booktabs" ? "\\toprule" : rules === "none" ? null : "\\hline";
    const mid = rules === "booktabs" ? "\\midrule" : rules === "none" ? null : "\\hline";
    const bottom = rules === "booktabs" ? "\\bottomrule" : rules === "none" ? null : "\\hline";
    const between = rules === "grid" ? "\\hline" : null;
    const bodyWithRules = bodyLines.flatMap((line, row) => between && row < bodyLines.length - 1 ? [line, between] : [line]);
    const headBlock = [top, ...(headerLine ? [headerLine, mid] : [])].filter((line): line is string => !!line);

    const caption = choice.caption.trim();
    const captionLatex = caption ? this.captionLatex(caption) : "";
    const label = caption ? this.tableLabel(choice.label, caption) : null;
    const size = this.choices.tableSize !== "normal" ? `\\${this.choices.tableSize}` : null;

    if (longtable) {
      this.need("longtable", "long tables");
      const lines = [`\\begin{longtable}{${columnSpec}}`];
      if (captionLatex) lines.push(`  \\caption{${captionLatex}}${label ? `\\label{${label}}` : ""}\\\\`);
      if (headerLine) {
        lines.push(...headBlock.map((line) => `  ${line}`), "  \\endfirsthead");
        lines.push(...headBlock.map((line) => `  ${line}`), "  \\endhead");
      } else if (top) lines.push(`  ${top}`);
      if (bottom) lines.push(`  ${bottom}`, "  \\endlastfoot");
      lines.push(...bodyWithRules.map((line) => `  ${line}`), "\\end{longtable}");
      const table = lines.join("\n");
      return size ? `\\begingroup\n\\${this.choices.tableSize}\n${table}\n\\endgroup` : table;
    }

    const name = environment === "tabularx" ? "tabularx" : "tabular";
    if (name === "tabularx") this.need("tabularx", "tabularx tables");
    const tabular = [
      `\\begin{${name}}${name === "tabularx" ? "{\\linewidth}" : ""}{${columnSpec}}`,
      ...[...headBlock, ...bodyWithRules, ...(bottom ? [bottom] : [])].map((line) => `  ${line}`),
      `\\end{${name}}`,
    ].join("\n");
    const footnotes = footnoteTexts.join("\n");
    const float = this.choices.tableFloat === "none" || state.footnote || this.context.inlineOnly ? null : this.choices.tableFloat;
    if (!float) {
      if (caption) this.warn("caption-without-float", 1, () => "Captions need a table float: choose Table under Float to keep them.");
      const body = size ? `{${size}\n${tabular}\n}` : tabular;
      return footnotes ? `${body}\n${footnotes}` : body;
    }
    const lines = [`\\begin{${float}}${this.placement()}`];
    if (this.choices.tableCentering) lines.push("  \\centering");
    if (size) lines.push(`  ${size}`);
    const captionLines = captionLatex ? [`  \\caption{${captionLatex}}`, ...(label ? [`  \\label{${label}}`] : [])] : [];
    if (!this.choices.tableCaptionBelow) lines.push(...captionLines);
    lines.push(indentLines(tabular, "  "));
    if (this.choices.tableCaptionBelow) lines.push(...captionLines);
    lines.push(`\\end{${float}}`);
    return footnotes ? `${lines.join("\n")}\n${footnotes}` : lines.join("\n");
  }

  /** A caption typed (or found) as Markdown, as LaTeX. */
  private captionLatex(caption: string) {
    const parsed = parseMarkdown(caption, this.parsed.mathMarkers);
    const paragraph = nodeChildren(parsed.tree as unknown as MdNode).find((node) => node.type === "paragraph");
    if (!paragraph) return this.escape(caption);
    return this.inline(nodeChildren(paragraph), { moving: true }).replace(/\s+/g, " ").trim();
  }

  private tableLabel(given: string, caption: string) {
    const label = given.trim();
    if (label && isValidLabel(label)) {
      if (!this.labels.has(label)) { this.labels.add(label); return label; }
      this.warn("label-taken", 1, () => "A table label was already used, so a number was added to it.");
      return uniqueLabel(label, this.labels);
    }
    if (label) this.warn("label", 1, () => "A table label had characters LaTeX labels cannot hold, so one was made from the caption.");
    return uniqueLabel(`tab:${labelSlug(caption, "table")}`, this.labels);
  }

  /* ---- inline ------------------------------------------------------------ */

  private inline(nodes: MdNode[], state: InlineState): string {
    const parts: string[] = [];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (node.type === "html") {
        const paired = this.inlineHtml(nodes, index, state);
        parts.push(paired.text);
        index = paired.end;
        continue;
      }
      parts.push(this.inlineNode(node, state));
    }
    let out = "";
    for (let index = 0; index < parts.length; index++) {
      if (parts[index] !== BREAK) { out += parts[index]; continue; }
      if (state.moving || state.cell === "nowrap") { out += " "; continue; }
      if (state.cell === "wrap") { out += "\\newline "; continue; }
      const next = parts.slice(index + 1).join("").replace(/^[ \t]+/, "");
      // `\\` followed by `[` would read it as a length.
      out += next.startsWith("[") ? "\\\\{}\n" : "\\\\\n";
      parts[index + 1] = (parts[index + 1] ?? "").replace(/^[ \t]+/, "");
    }
    return out;
  }

  /** Content that becomes another command's argument: `\verb` and the like are not allowed there. */
  private argument(node: MdNode, state: InlineState) {
    return this.inline(nodeChildren(node), { ...state, argument: true });
  }

  /**
   * `soul` (`\hl`, `\st`) typesets its argument letter by letter and only
   * copes with plain text and simple font commands; anything else (links,
   * footnotes, citations, math, code) keeps its text unmarked, with a warning.
   */
  private soul(command: "hl" | "st", content: string) {
    const commands = [...content.matchAll(/\\([A-Za-z@]+)/g)].map((match) => match[1]);
    if (/\$|\\\(/.test(content) || commands.some((name) => !SOUL_SAFE.has(name))) {
      this.warn("soul", 1, () => command === "hl" ? "Highlights around links, footnotes, citations, code or math were dropped: \\hl cannot hold them." : "Strikethrough around links, footnotes, citations, code or math was dropped: \\st cannot hold them.");
      return content;
    }
    this.need("soul", command === "hl" ? "highlights" : "strikethrough");
    return wrap(command, content);
  }

  private inlineNode(node: MdNode, state: InlineState): string {
    switch (node.type) {
      case "text": return this.text(node, state);
      case "emphasis": return wrap(this.choices.italic, this.argument(node, state));
      case "strong": return wrap("textbf", this.argument(node, state));
      case "delete": {
        const content = this.argument(node, state);
        if (this.choices.strike === "st") return this.soul("st", content);
        this.need("ulem", "strikethrough");
        return wrap("sout", content);
      }
      case "inlineCode": return this.inlineCode(node.value ?? "", state);
      case "inlineMath": return this.inlineMath(node.value ?? "");
      case "math": return this.inlineMath(node.value ?? "");
      case "break": return BREAK;
      case "link": return this.link(node.url ?? "", node, state);
      case "linkReference": {
        const definition = node.identifier ? this.structure.definitions.get(node.identifier) : undefined;
        return definition ? this.link(definition.url, node, state) : this.inline(nodeChildren(node), state);
      }
      case "image": case "imageReference": return this.inlineImage(node);
      case "footnoteReference": return this.footnote(node.identifier ?? "", state);
      case "liberaCitation": return this.citation(node);
      case "liberaHighlight": {
        const content = this.argument(node, state);
        if (this.choices.highlight === "drop" || !content.trim()) return content;
        if (this.choices.highlight === "colorbox") { this.need("xcolor", "highlights"); return `\\colorbox{yellow}{${content}}`; }
        return this.soul("hl", content);
      }
      case "liberaTextColor": {
        const content = this.argument(node, state);
        const color = latexHtmlColor(String(node.data?.hProperties?.["data-markdown-color"] ?? ""));
        if (!color || !content.trim()) return content;
        this.need("xcolor", "colored text");
        return `\\textcolor[HTML]{${color}}{${content}}`;
      }
      case "liberaUnderline": return wrap(hasPackage(this.context, "ulem") && !state.moving ? "uline" : "underline", this.argument(node, state));
      case "superscript": return wrap("textsuperscript", this.argument(node, state));
      case "subscript": return wrap("textsubscript", this.argument(node, state));
      case "liberaBibliography": return "";
      default:
        if (node.children) return this.inline(node.children, state);
        return node.value ? this.escape(node.value) : "";
    }
  }

  /** Inline HTML: `<br>`, and `<sup>…</sup>` and the like around Markdown; other tags are dropped. */
  private inlineHtml(nodes: MdNode[], index: number, state: InlineState): { text: string; end: number } {
    const html = (nodes[index].value ?? "").trim();
    if (/^<br\s*\/?>$/i.test(html)) return { text: BREAK, end: index };
    if (/^<!--[\s\S]*-->$/.test(html)) return { text: "", end: index };
    if (/^<img\b/i.test(html)) return { text: this.inlineImage(nodes[index]), end: index };
    const open = /^<([A-Za-z][\w-]*)\b[^>]*>$/.exec(html);
    if (open && !/\/>$/.test(html)) {
      const tag = open[1].toLowerCase();
      let depth = 0;
      for (let end = index + 1; end < nodes.length; end++) {
        const value = nodes[end].type === "html" ? (nodes[end].value ?? "").trim().toLowerCase() : "";
        if (new RegExp(`^<${tag}\\b[^>]*>$`).test(value)) depth++;
        if (value === `</${tag}>` && depth-- === 0) {
          const content = this.inline(nodes.slice(index + 1, end), { ...state, argument: true });
          return { text: this.htmlWrap(tag, content), end };
        }
      }
    }
    if (/^<\/?[A-Za-z]/.test(html)) this.warn("html", 1, () => "Some HTML had no LaTeX equivalent: its tags were dropped and its text kept.");
    return { text: "", end: index };
  }

  private htmlWrap(tag: string, content: string) {
    switch (tag) {
      case "sup": return wrap("textsuperscript", content);
      case "sub": return wrap("textsubscript", content);
      case "b": case "strong": return wrap("textbf", content);
      case "i": case "em": case "cite": case "dfn": return wrap(this.choices.italic, content);
      case "u": case "ins": return wrap("underline", content);
      case "code": case "kbd": case "samp": case "tt": return wrap("texttt", content);
      case "s": case "del": case "strike": this.need("ulem", "strikethrough"); return wrap("sout", content);
      case "mark": return this.choices.highlight === "drop" || !content.trim() ? content : this.soul("hl", content);
      case "small": return content.trim() ? `{\\small ${content}}` : content;
      case "span": case "font": case "a": case "abbr": case "q": return content;
      default:
        this.warn("html", 1, () => "Some HTML had no LaTeX equivalent: its tags were dropped and its text kept.");
        return content;
    }
  }

  private text(node: MdNode, state: InlineState): string {
    let value = this.overrides.get(node) ?? node.value ?? "";
    if (state.moving || state.cell) value = value.replace(/\s*\n\s*/g, " ");
    if (!this.choices.keepLatex || state.link) return this.escape(value);
    const inlineOnly = this.context.inlineOnly || state.moving || !!state.cell || !!state.argument;
    return splitRawLatex(value, { commands: this.context.definedCommands, environments: this.context.definedEnvironments }).map((part) => {
      if (!part.raw) return this.escape(part.text);
      // Environments and block commands cannot stand in an argument, a heading or a table cell.
      if (inlineOnly && BLOCK_COMMAND.test(part.text)) {
        this.warn("raw-block", 1, () => "LaTeX environments or block commands written in the text were kept as text: they cannot stand where the paste goes.");
        return this.escape(part.text);
      }
      if (/\\(?:footnote|url|href)\b/.test(part.text) && state.moving) return `\\protect${part.text}`;
      return part.text;
    }).join("");
  }

  /** Text as LaTeX, with straight quotes made typographic and non-Latin scripts noted under pdfLaTeX. */
  private escape(value: string) {
    if (this.context.engine === "pdflatex" && /[Ѐ-ӿ֐-ۿ฀-๿぀-ヿ㐀-鿿가-힯]/.test(value)) {
      this.warn("script", 1, () => "Some text is in a script pdfLaTeX may not typeset: compile with XeLaTeX or LuaLaTeX if it shows errors.");
    }
    let text = escapeLatexText(value, this.textOptions);
    if (/\\mathbb\{/.test(text)) this.need("amsfonts", "symbols such as ℝ");
    if (this.choices.quotes === "csquotes" && /"[^"\n]+"/.test(text)) {
      this.need("csquotes", "quotations");
      text = text.replace(/(^|[\s([{~-])"([^"\n]+)"/g, (_, before: string, quoted: string) => `${before}\\enquote{${quoted}}`);
    }
    if (this.choices.quotes !== "keep") {
      text = text
        .replace(/(^|[\s([{~-])"(?=\S)/g, "$1``")
        .replace(/"/g, "''")
        .replace(/(^|[\s([{~-])'(?=[\p{L}\p{N}])/gu, "$1`");
    }
    return text;
  }

  private escapeCode(value: string) {
    return escapeLatexText(value, { ...this.textOptions, ot1: false }).replace(/ {2,}/g, (spaces) => "~".repeat(spaces.length));
  }

  private inlineCode(value: string, state: InlineState) {
    if (this.choices.inlineCode === "verb" && !state.moving && !state.cell && !state.footnote && !state.link && !state.argument && !/\n/.test(value)) {
      const delimiter = ["|", "!", "+", "=", "@", "^", "/", ";", ":"].find((candidate) => !value.includes(candidate));
      if (delimiter) return `\\verb${delimiter}${value}${delimiter}`;
    }
    return `\\texttt{${this.escapeCode(value)}}`;
  }

  private link(url: string, node: MdNode, state: InlineState): string {
    const text = this.inline(nodeChildren(node), { ...state, link: true });
    const plain = plainText(node).trim();
    if (url.startsWith("#")) {
      const label = this.headingLabels.get(headingSlug(decodeAnchor(url.slice(1))));
      if (label && !state.moving) { this.need("hyperref", "links to headings"); return `\\hyperref[${label}]{${text}}`; }
      return text;
    }
    if (!/^(?:https?:|ftp:|mailto:)/i.test(url)) return text;
    if (state.moving || this.choices.links === "text") return text || this.escape(url);
    const latexAddress = latexUrl(url);
    const isBare = !plain || plain === url || plain === url.replace(/^mailto:/i, "") || `http://${plain}` === url || `https://${plain}` === url;
    if (isBare && !/^mailto:/i.test(url)) { this.need("url", "web addresses"); return `\\url{${latexAddress}}`; }
    if (this.choices.links === "footnote") {
      if (state.cell || state.footnote) return text;
      this.need("url", "web addresses");
      return `${text}\\footnote{\\url{${latexAddress}}}`;
    }
    this.need("hyperref", "links");
    return `\\href{${latexAddress}}{${text || this.escape(plain)}}`;
  }

  private inlineImage(node: MdNode): string {
    const image = this.imageSource(node);
    if (!image?.src) return "";
    const path = this.resolveImage(image.src);
    if (path === null || this.choices.images === "comment") return this.escape(image.alt);
    this.need("graphicx", "images");
    return `\\includegraphics[height=1em]{${path}}`;
  }

  private footnote(id: string, state: InlineState): string {
    const definition = this.structure.footnotes.get(id);
    if (!definition) return this.escape(`[^${id}]`);
    // A footnote inside a footnote has no reliable number in LaTeX: its text goes in parentheses instead.
    if (state.footnote) {
      this.warn("nested-footnote", 1, () => "A footnote inside another footnote was written in parentheses.");
      const inner = this.blocks(nodeChildren(definition), { itemize: 0, enumerate: 0, other: 0, nested: true, footnote: true }).join(" ");
      return inner.trim() ? ` (${inner.trim()})` : "";
    }
    const label = this.footnoteLabels.get(id);
    if (label && this.footnotesShown.has(id)) return `\\footnotemark[\\ref{${label}}]`;
    this.footnotesShown.add(id);
    const content = this.blocks(nodeChildren(definition), { itemize: 0, enumerate: 0, other: 0, nested: true, footnote: true }).join("\n\\par ");
    const body = `${label ? `\\label{${label}}` : ""}${content}`;
    if (this.pendingFootnoteTexts && state.cell) {
      this.pendingFootnoteTexts.push(`\\footnotetext{${body}}`);
      return "\\footnotemark";
    }
    return `${state.moving ? "\\protect" : ""}\\footnote{${body}}`;
  }

  private citation(node: MdNode): string {
    const raw = node.value ?? node.citation?.raw ?? "";
    // A library alias cites the key the bibliography has (`@old` → `new`).
    const aliases = this.context.bibAliases;
    const citation = node.citation && aliases.size
      ? { ...node.citation, items: node.citation.items.map((item) => aliases.has(item.key) ? { ...item, key: aliases.get(item.key)! } : item) }
      : node.citation;
    if (!citation || !citation.items.length || citation.items.some((item) => !item.key || /[\s,{}\\%#]/.test(item.key))) return this.escape(raw);
    const known = this.context.bibKeys;
    // A narrative `@word` is a citation only when the bibliography knows the key; otherwise it is text (a handle, say).
    if (citation.narrative && (!known || !citation.items.every((item) => known.has(item.key)))) return this.escape(raw);
    if (known) {
      const unknown = citation.items.filter((item) => !known.has(item.key));
      if (unknown.length) this.warn("cite-keys", unknown.length, (n) => `${n} cited key${n === 1 ? " is" : "s are"} not in the bibliography.`);
    }
    return citationLatex(citation, bibliographyDialect(this.context));
  }

  /** Blocks flattened to one line, for a paste inside a command argument or a table. */
  private flatten(nodes: MdNode[]): string {
    const parts: string[] = [];
    for (const node of nodes) {
      if (this.skip.has(node)) continue;
      switch (node.type) {
        case "heading": { const title = this.inline(nodeChildren(node), { moving: true }).trim(); if (title) parts.push(`\\textbf{${title}}`); break; }
        case "paragraph": parts.push(this.inline(nodeChildren(node), { moving: true })); break;
        case "list": parts.push(nodeChildren(node).map((item) => this.flatten(nodeChildren(item))).filter(Boolean).join("; ")); break;
        case "blockquote": case "listItem": parts.push(this.flatten(nodeChildren(node))); break;
        case "code": parts.push(`\\texttt{${this.escapeCode((node.value ?? "").replace(/\n/g, " "))}}`); break;
        case "math": parts.push(this.displayMath(node.value ?? "", null)); break;
        case "table": parts.push(nodeChildren(node).map((row) => nodeChildren(row).map((cell) => this.inline(nodeChildren(cell), { moving: true })).join(", ")).join("; ")); break;
        case "html": { const text = this.htmlBlock(node); if (text && !text.startsWith("%") && !text.startsWith("\\begin")) parts.push(text); break; }
        default: break;
      }
    }
    return parts.filter((part) => part.trim()).join(" ");
  }
}

const SECTION_TARGETS = new Set<HeadingTarget>(["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"]);

function alertColor(kind: string) {
  switch (kind.toLowerCase()) {
    case "warning": case "caution": case "danger": case "failure": case "bug": return "red";
    case "tip": case "success": return "green";
    case "important": case "question": return "violet";
    default: return "blue";
  }
}

/** `#2563eb`, `#25e`, `#2563ebcc` → `2563EB`. */
export function latexHtmlColor(color: string) {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim())?.[1];
  if (!hex) return null;
  if (hex.length === 3 || hex.length === 4) return hex.slice(0, 3).split("").map((digit) => digit + digit).join("").toUpperCase();
  if (hex.length === 6 || hex.length === 8) return hex.slice(0, 6).toUpperCase();
  return null;
}

function decodeAnchor(anchor: string) {
  try { return decodeURIComponent(anchor); } catch { return anchor; }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©" };
function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** The end of the brace or bracket group opening at `index`, or -1. */
function groupEnd(text: string, index: number, open: string, close: string) {
  let depth = 0;
  for (let at = index; at < text.length; at++) {
    const char = text[at];
    if (char === "\\") { at++; continue; }
    if (open === "[" && char === "\n") return -1;
    if (char === open) depth++;
    else if (char === close && --depth === 0) return at + 1;
  }
  return -1;
}

/** Environments of formulas, allowed inside kept math. */
const MATH_ENVIRONMENTS = new Set(["matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "cases", "aligned", "gathered", "alignedat", "split", "array", "subarray"]);

export type DefinedNames = { commands?: ReadonlySet<string>; environments?: ReadonlySet<string> };

/** Whether every command and environment in a piece of hand-written LaTeX is allowed (known, or defined by the document). */
function onlyAllowedNames(segment: string, defined: DefinedNames) {
  for (const match of segment.matchAll(/\\([A-Za-z@]+)/g)) {
    const name = match[1];
    if (name === "begin" || name === "end" || TEXT_COMMANDS.has(name) || MATH_COMMANDS.has(name) || defined.commands?.has(name)) continue;
    return false;
  }
  for (const match of segment.matchAll(/\\begin\s*\{([^}]*)\}/g)) {
    const env = match[1].trim();
    if (!TEXT_ENVIRONMENTS.has(env) && !MATH_ENVIRONMENTS.has(env) && !defined.environments?.has(env)) return false;
  }
  return true;
}

/**
 * Text split into the LaTeX written by hand inside it (`see \ref{eq:1}`,
 * `\newpage`, a `\begin{center}…\end{center}` within the text) and the rest,
 * which is escaped. An allowlist: a piece is kept only when every command and
 * environment in it is a known text (or, inside it, math) command or one the
 * document defines, it is balanced and safe (nothing that reads or writes
 * files, defines macros or uses `^^` notation), and every argument closes.
 */
export function splitRawLatex(text: string, defined: DefinedNames = {}): Array<{ raw: boolean; text: string }> {
  const parts: Array<{ raw: boolean; text: string }> = [];
  let last = 0;
  const pattern = /\\([A-Za-z@]+)(\*?)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const name = match[1];
    let end = match.index + match[0].length;
    let raw = false;
    if (name === "begin") {
      const env = /^\s*\{([A-Za-z*]+)\}/.exec(text.slice(end));
      if (env) {
        const close = findEnvironmentEnd(text, match.index, env[1]);
        if (close > 0) { end = close; raw = true; }
      }
    } else if (name !== "end" && (TEXT_COMMANDS.has(name) || defined.commands?.has(name))) {
      raw = true;
      for (;;) {
        const next = text[end];
        if (next !== "{" && next !== "[") break;
        const close = groupEnd(text, end, next, next === "{" ? "}" : "]");
        // An argument that never closes: the whole command is text, not just its name.
        if (close < 0) { raw = false; break; }
        end = close;
      }
    }
    if (raw) {
      const segment = text.slice(match.index, end);
      raw = isSafeRawLatex(segment) && onlyAllowedNames(segment, defined);
    }
    if (!raw) continue;
    if (match.index > last) parts.push({ raw: false, text: text.slice(last, match.index) });
    parts.push({ raw: true, text: text.slice(match.index, end) });
    last = end;
    pattern.lastIndex = end;
  }
  if (last < text.length) parts.push({ raw: false, text: text.slice(last) });
  return parts;
}

function findEnvironmentEnd(text: string, from: number, env: string) {
  const escaped = env.replace(/\*/g, "\\*");
  const pattern = new RegExp(`\\\\(begin|end)\\s*\\{${escaped}\\}`, "g");
  pattern.lastIndex = from;
  let depth = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[1] === "begin") depth++;
    else if (--depth === 0) return match.index + match[0].length;
  }
  return -1;
}

/** A citation as LaTeX commands for the bibliography package the preamble loads. */
export function citationLatex(citation: Citation, dialect: "biblatex" | "natbib" | "plain"): string {
  if (dialect === "biblatex") {
    const entries: Record<string, ReferenceEntry> = {};
    for (const item of citation.items) entries[item.key] = { key: item.key, id: item.key } as unknown as ReferenceEntry;
    return biblatexCitation(citation, entries);
  }
  const notes = (item: CitationItem) => ({ pre: biblatexPrenote(item), post: biblatexPostnote(item) });
  const keys = (items: CitationItem[]) => [...new Set(items.map((item) => item.key))].join(",");
  if (dialect === "natbib") {
    const command = (items: CitationItem[]) => {
      const star = items[0].suppressAuthor === true;
      const name = star ? citation.narrative ? "citeyear" : "citeyearpar" : citation.narrative ? "citet" : "citep";
      const { pre } = notes(items[0]);
      const { post } = notes(items[items.length - 1]);
      return `\\${name}${pre ? optionalArgument(pre) + optionalArgument(post) : post ? optionalArgument(post) : ""}{${keys(items)}}`;
    };
    // One command holds the keys when only the first has a prenote and only the last a postnote.
    const simple = citation.items.every((item, index) => (!notes(item).pre || index === 0) && (!notes(item).post || index === citation.items.length - 1))
      && citation.items.every((item) => item.suppressAuthor === citation.items[0].suppressAuthor);
    return simple ? command(citation.items) : citation.items.map((item) => command([item])).join("; ");
  }
  // \cite has a postnote only: a prenote is written before it.
  const command = (items: CitationItem[]) => {
    const { pre } = notes(items[0]);
    const { post } = notes(items[items.length - 1]);
    return `${pre ? `${pre}~` : ""}\\cite${post ? optionalArgument(post) : ""}{${keys(items)}}`;
  };
  const simple = citation.items.every((item, index) => (!notes(item).pre || index === 0) && (!notes(item).post || index === citation.items.length - 1));
  return simple ? command(citation.items) : citation.items.map((item) => command([item])).join("; ");
}
