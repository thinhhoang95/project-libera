export type MarkdownDisplayPreferences = {
  /** The page-width triangle of the Markdown editors (Visual and source). */
  textWidth: number;
  /** The page-width triangle of the LaTeX editor (source and Visual). */
  latexTextWidth: number;
  /** The page-width triangle of the plain CodeMirror editor for other text files. */
  codeTextWidth: number;
  textScale: number;
  outlineExpansionLevel: number;
  /** Spellcheck in the LaTeX editor's Visual mode (Source mode never checks: command names would be flagged). */
  latexSpellcheck: boolean;
};

/** Which editor family a width triangle belongs to; each keeps its own saved width. */
export type TextWidthKind = "markdown" | "latex" | "code";

export const TEXT_WIDTH_PREFERENCE_KEY = {
  markdown: "textWidth",
  latex: "latexTextWidth",
  code: "codeTextWidth",
} as const satisfies Record<TextWidthKind, keyof MarkdownDisplayPreferences>;

export const DEFAULT_MARKDOWN_DISPLAY_PREFERENCES: MarkdownDisplayPreferences = {
  textWidth: 75,
  latexTextWidth: 75,
  codeTextWidth: 75,
  textScale: 100,
  outlineExpansionLevel: 6,
  latexSpellcheck: true,
};

export function normalizeMarkdownDisplayPreferences(input: Partial<MarkdownDisplayPreferences> = {}): MarkdownDisplayPreferences {
  const normalize = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value)))
      : fallback;
  const textWidth = normalize(input.textWidth, 75, 0, 100);
  return {
    textWidth,
    // Settings saved before the widths were split start from the shared width.
    latexTextWidth: normalize(input.latexTextWidth, textWidth, 0, 100),
    codeTextWidth: normalize(input.codeTextWidth, textWidth, 0, 100),
    textScale: normalize(input.textScale, 100, 75, 250),
    outlineExpansionLevel: normalize(input.outlineExpansionLevel, 6, 1, 6),
    latexSpellcheck: typeof input.latexSpellcheck === "boolean" ? input.latexSpellcheck : true,
  };
}
