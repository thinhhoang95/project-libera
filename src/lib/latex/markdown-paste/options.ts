/* Settings for pasting Markdown as LaTeX (docs/latex-markdown-paste-plan.md).
 * `MarkdownPasteOptions` are remembered per user; `MarkdownPasteChoices` add
 * what belongs to one paste (the heading map, captions and labels). */

export const SECTION_COMMANDS = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"] as const;
export type SectionCommand = typeof SECTION_COMMANDS[number];

/** What one heading level becomes. */
export type HeadingTarget = SectionCommand | "bold" | "plain" | "custom";
export const HEADING_TARGETS: readonly HeadingTarget[] = [...SECTION_COMMANDS, "bold", "plain", "custom"];

/** When the dialog opens: only for headings or tables (default), always, never (use the saved settings), or no conversion at all. */
export type MarkdownPasteAsk = "structure" | "always" | "never" | "off";
export type TableEnvironment = "tabular" | "tabularx" | "longtable";
export type TableRules = "booktabs" | "grid" | "simple" | "none";
export type TableFloat = "none" | "table" | "table*";
export type TableSize = "normal" | "small" | "footnotesize" | "scriptsize";

export type MarkdownPasteOptions = {
  ask: MarkdownPasteAsk;
  /** The top heading: "auto" is one level below the section at the cursor. */
  headingTop: "auto" | HeadingTarget;
  /** The custom command (`\frametitle`) or one-line template with `#1` for "custom". */
  headingCustom: string;
  headingStarred: boolean;
  headingLabels: boolean;
  /** Remove "1.2" numbers from headings when every pasted heading has one. */
  stripHeadingNumbers: boolean;
  tableEnvironment: TableEnvironment;
  tableRules: TableRules;
  /** Long columns wrap (`p{…}` or `X`). */
  tableWrap: boolean;
  tableBoldHeader: boolean;
  tableFloat: TableFloat;
  /** Float placement: letters from "htbp!" or "H". */
  tablePlacement: string;
  tableCentering: boolean;
  tableCaptionBelow: boolean;
  tableSize: TableSize;
  /** A "Table 2: …" paragraph just before a table becomes its caption. */
  tableCaptionFromText: boolean;
  italic: "emph" | "textit";
  strike: "sout" | "st";
  inlineCode: "texttt" | "verb";
  codeBlocks: "verbatim" | "lstlisting";
  displayMath: "brackets" | "equation*" | "equation";
  inlineMath: "dollar" | "paren";
  links: "href" | "footnote" | "text";
  images: "figure" | "inline" | "comment";
  /** Figure width as a fraction of `\linewidth`. */
  imageWidth: number;
  quotes: "latex" | "csquotes" | "keep";
  blockquote: "quote" | "quotation" | "displayquote";
  highlight: "hl" | "colorbox" | "drop";
  /** LaTeX commands written in the Markdown's text stay LaTeX. */
  keepLatex: boolean;
};

export type PastedTableChoice = { caption: string; label: string };

export type MarkdownPasteChoices = MarkdownPasteOptions & {
  /** What each heading rank becomes: the distinct depths in the paste, shallowest first. */
  headingMap: HeadingTarget[];
  /** The custom command or template per rank (used where headingMap says "custom"). */
  headingCustoms: string[];
  /** Per table, in document order. */
  tables: PastedTableChoice[];
  /** Write `\usepackage` lines for missing packages into the preamble (never remembered). */
  addPackages?: boolean;
};

export const DEFAULT_MARKDOWN_PASTE_OPTIONS: MarkdownPasteOptions = {
  ask: "structure",
  headingTop: "auto",
  headingCustom: "",
  headingStarred: false,
  headingLabels: false,
  stripHeadingNumbers: true,
  tableEnvironment: "tabular",
  tableRules: "booktabs",
  tableWrap: true,
  tableBoldHeader: false,
  tableFloat: "table",
  tablePlacement: "htbp",
  tableCentering: true,
  tableCaptionBelow: false,
  tableSize: "normal",
  tableCaptionFromText: true,
  italic: "emph",
  strike: "sout",
  inlineCode: "texttt",
  codeBlocks: "verbatim",
  displayMath: "brackets",
  inlineMath: "dollar",
  links: "href",
  images: "figure",
  imageWidth: 0.75,
  quotes: "latex",
  blockquote: "quote",
  highlight: "hl",
  keepLatex: true,
};

const ENUMS: { [K in keyof MarkdownPasteOptions]?: readonly string[] } = {
  ask: ["structure", "always", "never", "off"],
  headingTop: ["auto", ...HEADING_TARGETS],
  tableEnvironment: ["tabular", "tabularx", "longtable"],
  tableRules: ["booktabs", "grid", "simple", "none"],
  tableFloat: ["none", "table", "table*"],
  tableSize: ["normal", "small", "footnotesize", "scriptsize"],
  italic: ["emph", "textit"],
  strike: ["sout", "st"],
  inlineCode: ["texttt", "verb"],
  codeBlocks: ["verbatim", "lstlisting"],
  displayMath: ["brackets", "equation*", "equation"],
  inlineMath: ["dollar", "paren"],
  links: ["href", "footnote", "text"],
  images: ["figure", "inline", "comment"],
  quotes: ["latex", "csquotes", "keep"],
  blockquote: ["quote", "quotation", "displayquote"],
  highlight: ["hl", "colorbox", "drop"],
};

/** A float placement: letters from `htbp!` (each once, at least one position: `!` alone places nothing), or `H` alone. */
export function normalizePlacement(value: string) {
  if (value.trim() === "H") return "H";
  const letters = [...new Set(value.replace(/[^htbp!]/g, ""))];
  if (!letters.some((letter) => letter !== "!")) return DEFAULT_MARKDOWN_PASTE_OPTIONS.tablePlacement;
  const order = "htbp!";
  return letters.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join("");
}

/** Saved settings, with anything missing or invalid replaced by its default (settings from older versions keep working). */
export function parseMarkdownPasteOptions(input: unknown): MarkdownPasteOptions {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const result: Record<string, unknown> = { ...DEFAULT_MARKDOWN_PASTE_OPTIONS };
  for (const key of Object.keys(DEFAULT_MARKDOWN_PASTE_OPTIONS) as Array<keyof MarkdownPasteOptions>) {
    const given = value[key];
    if (given === undefined) continue;
    const fallback = DEFAULT_MARKDOWN_PASTE_OPTIONS[key];
    const allowed = ENUMS[key];
    if (allowed) { if (typeof given === "string" && allowed.includes(given)) result[key] = given; continue; }
    if (typeof fallback === "boolean") { if (typeof given === "boolean") result[key] = given; continue; }
    if (typeof fallback === "number") { if (typeof given === "number" && Number.isFinite(given) && given > 0 && given <= 1) result[key] = given; continue; }
    if (typeof given === "string" && given.length <= 200) result[key] = given;
  }
  result.tablePlacement = normalizePlacement(String(result.tablePlacement));
  return result as MarkdownPasteOptions;
}
