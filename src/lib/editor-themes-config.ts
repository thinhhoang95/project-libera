import { readFileSync } from "node:fs";
import { resolveEditorThemes, type ResolvedEditorThemes } from "../../electron/editor-themes.cjs";

type ThemeConfig = {
  markdownEditorThemes?: unknown;
  markdownHeadingColor?: unknown;
  markdownHeadingPalette?: unknown;
  wysiwygEditorFontFamily?: unknown;
  markdownEditorFontFamily?: unknown;
};

// Read on each page load rather than at server start: Preferences applies
// editor themes without a restart.
export function getConfiguredEditorThemes(): ResolvedEditorThemes {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (configPath) {
    let config: ThemeConfig = {};
    try {
      config = JSON.parse(readFileSync(configPath, "utf8")) as ThemeConfig;
    } catch {}
    return resolveEditorThemes(config.markdownEditorThemes, {
      headingColor: config.markdownHeadingColor,
      headingPalette: config.markdownHeadingPalette,
      textFont: config.wysiwygEditorFontFamily,
      codeFont: config.markdownEditorFontFamily,
    });
  }
  return resolveEditorThemes(process.env.LIBERA_MARKDOWN_EDITOR_THEMES, {
    headingColor: process.env.LIBERA_MARKDOWN_HEADING_COLOR,
    headingPalette: process.env.LIBERA_MARKDOWN_HEADING_PALETTE,
    textFont: process.env.LIBERA_WYSIWYG_EDITOR_FONT_FAMILY,
    codeFont: process.env.LIBERA_MARKDOWN_EDITOR_FONT_FAMILY,
  });
}
