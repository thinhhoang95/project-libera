import type { FindMode, FindScope } from "./types";

/* Saved find & replace pairs. Built-in ones are named through i18n
 * (`find.presetNames.<id>`); user presets carry their own name. */

/** One find & replace pair of a recipe. */
export type FindRecipeStep = {
  query: string;
  replacement: string;
  mode: FindMode;
  matchCase?: boolean;
  wholeWord?: boolean;
  flexibleSpacing?: boolean;
  preserveCase?: boolean;
  scope?: FindScope;
  /** TipTap: interpret this step's replacement as Markdown. */
  markdownReplacement?: boolean;
};

export type FindPreset = {
  id: string;
  /** A user preset's name; built-ins are named by `id`. */
  name?: string;
  /** A recipe: steps run in order as one edit. `query`/`replacement` then hold the first step. */
  steps?: FindRecipeStep[];
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
  {
    id: "chatGptMathToDollars",
    query: "\\[*\\]",
    replacement: "$$@1$$",
    mode: "pattern",
    steps: [
      { query: "\\[@x:block\\]", replacement: "$$@x$$", mode: "pattern", markdownReplacement: true },
      { query: "\\(*\\)", replacement: "$@1$", mode: "pattern", markdownReplacement: true },
    ],
  },
];

function isStep(value: unknown): value is FindRecipeStep {
  if (!value || typeof value !== "object") return false;
  const step = value as Partial<FindRecipeStep>;
  return typeof step.query === "string" && typeof step.replacement === "string"
    && (step.mode === "plain" || step.mode === "pattern" || step.mode === "regex");
}

export function isFindPreset(value: unknown): value is FindPreset {
  if (!isStep(value)) return false;
  const preset = value as Partial<FindPreset>;
  return typeof preset.id === "string" && (preset.steps === undefined || (Array.isArray(preset.steps) && preset.steps.every(isStep)));
}
