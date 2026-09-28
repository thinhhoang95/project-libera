export type MarkdownDisplayPreferences = { textWidth: number; textScale: number; outlineExpansionLevel: number };

export const DEFAULT_MARKDOWN_DISPLAY_PREFERENCES: MarkdownDisplayPreferences = {
  textWidth: 75,
  textScale: 100,
  outlineExpansionLevel: 6,
};

export function normalizeMarkdownDisplayPreferences(input: Partial<MarkdownDisplayPreferences> = {}): MarkdownDisplayPreferences {
  const normalize = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value)))
      : fallback;
  return {
    textWidth: normalize(input.textWidth, 75, 0, 100),
    textScale: normalize(input.textScale, 100, 75, 150),
    outlineExpansionLevel: normalize(input.outlineExpansionLevel, 6, 1, 6),
  };
}
