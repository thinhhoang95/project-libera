import { slideSeriesPalette, type SlideChartTheme } from "./slide-charts";

// Settings for ```mermaid blocks: Mermaid's "base" theme with its colors
// taken from the slide theme (or the app theme, in notes), so diagrams sit
// on the page like charts do. slide-live-blocks.tsx draws them.

/** `color` laid over `base` at `amount` (0–1), as #rrggbb. Both are #rrggbb. */
export function mixHex(color: string, base: string, amount: number) {
  const channel = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2]
    .map((index) => Math.round(channel(color, index) * amount + channel(base, index) * (1 - amount)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Mermaid's configuration for one theme. Strict security: no scripts, clicks
 * or raw HTML in labels. `fontSize` is the surrounding text's, so a diagram
 * on a slide is lettered like the slide.
 */
export function buildSlideDiagramConfig(tokens: SlideChartTheme, fontFamily: string, fontSize = "16px") {
  const palette = slideSeriesPalette(tokens.dark);
  // Node fills are pale tints of the series palette, so the theme's text stays readable on them.
  const tint = (color: string, amount = tokens.dark ? 0.3 : 0.16) => mixHex(color, tokens.surface, amount);
  const [primary, secondary, tertiary] = palette;
  const themeVariables: Record<string, string | boolean> = {
    background: tokens.surface,
    darkMode: tokens.dark,
    fontFamily,
    fontSize,
    primaryColor: tint(primary),
    primaryBorderColor: primary,
    primaryTextColor: tokens.foreground,
    secondaryColor: tint(secondary),
    secondaryBorderColor: secondary,
    secondaryTextColor: tokens.foreground,
    tertiaryColor: tint(tertiary),
    tertiaryBorderColor: tertiary,
    tertiaryTextColor: tokens.foreground,
    lineColor: tokens.muted,
    textColor: tokens.foreground,
    mainBkg: tint(primary),
    nodeBorder: primary,
    clusterBkg: mixHex(tokens.rule, tokens.surface, 0.35),
    clusterBorder: tokens.rule,
    edgeLabelBackground: tokens.surface,
    noteBkgColor: tint(palette[3]),
    noteBorderColor: palette[3],
    noteTextColor: tokens.foreground,
    actorBkg: tint(primary),
    actorBorder: primary,
    actorTextColor: tokens.foreground,
    signalColor: tokens.foreground,
    signalTextColor: tokens.foreground,
    labelBoxBkgColor: tint(primary),
    labelBoxBorderColor: primary,
    labelTextColor: tokens.foreground,
    titleColor: tokens.foreground,
    pieTitleTextColor: tokens.foreground,
    pieLegendTextColor: tokens.foreground,
    pieSectionTextColor: tokens.dark ? tokens.foreground : "#ffffff",
    pieStrokeColor: tokens.surface,
    pieOuterStrokeColor: tokens.rule,
    // Mermaid draws slices at 70% opacity; the palette is validated at full strength.
    pieOpacity: "1",
  };

  palette.forEach((color, index) => {
    themeVariables[`pie${index + 1}`] = color;
    themeVariables[`git${index}`] = color;
    themeVariables[`cScale${index}`] = tint(color, tokens.dark ? 0.45 : 0.3);
    themeVariables[`cScaleLabel${index}`] = tokens.foreground;
  });

  return {
    fontFamily,
    // Sequence diagrams ignore the theme's size: they copy this top-level one
    // over their actor, message and note sizes on every draw.
    fontSize: parseFloat(fontSize) || 16,
    securityLevel: "strict" as const,
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: "base" as const,
    themeVariables,
  };
}

/**
 * Mermaid's parse errors span several lines, with the source excerpt and a
 * caret in between; the first line says where, the last what was expected.
 */
export function slideDiagramErrorMessage(reason: unknown) {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "Diagram error.";
  const summary = lines.length > 1 ? `${lines[0].replace(/:$/, "")}. ${lines[lines.length - 1]}` : lines[0];
  return `Diagram error: ${summary}`;
}
