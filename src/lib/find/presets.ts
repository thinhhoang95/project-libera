import type { FindMode, FindScope } from "./types";

/* Saved find & replace pairs. Built-in ones are named through i18n
 * (`find.presetNames.<id>`); user presets carry their own name. */

export type FindPreset = {
  id: string;
  /** A user preset's name; built-ins are named by `id`. */
  name?: string;
  query: string;
  replacement: string;
  mode: FindMode;
  matchCase?: boolean;
  wholeWord?: boolean;
  flexibleSpacing?: boolean;
  scope?: FindScope;
  /** TipTap: interpret the replacement as Markdown. */
  markdownReplacement?: boolean;
};

export const BUILT_IN_FIND_PRESETS: readonly FindPreset[] = [
  { id: "inlineToDisplay", query: "\\(*\\)", replacement: "\\[@1\\]", mode: "pattern" },
  { id: "displayToInline", query: "\\[*\\]", replacement: "\\(@1\\)", mode: "pattern" },
  { id: "dollarToParens", query: "(?<![$\\\\])\\$(?!\\$)([^$\\n]+?)\\$(?!\\$)", replacement: "\\(@1\\)", mode: "regex" },
  { id: "parensToDollar", query: "\\(*\\)", replacement: "$@1$", mode: "pattern" },
  { id: "fracToDfrac", query: "\\frac@n:arg@d:arg", replacement: "\\dfrac{@n}{@d}", mode: "pattern" },
  { id: "markdownBoldToLatex", query: "\\*\\*@text\\*\\*", replacement: "\\textbf{@text}", mode: "pattern" },
  { id: "latexBoldToMarkdown", query: "\\textbf{*}", replacement: "**@1**", mode: "pattern", markdownReplacement: true },
  { id: "latexEmphToMarkdown", query: "\\emph{*}", replacement: "*@1*", mode: "pattern", markdownReplacement: true },
  { id: "swapPair", query: "(*,*)", replacement: "(@2,@1)", mode: "pattern" },
];

export function isFindPreset(value: unknown): value is FindPreset {
  if (!value || typeof value !== "object") return false;
  const preset = value as Partial<FindPreset>;
  return typeof preset.id === "string" && typeof preset.query === "string" && typeof preset.replacement === "string"
    && (preset.mode === "plain" || preset.mode === "pattern" || preset.mode === "regex");
}
