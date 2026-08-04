import {
  normalizeMarkdownPreferences,
  type MarkdownPreferences,
} from "@/lib/markdown-preferences";

export function getConfiguredMarkdownPreferences(): MarkdownPreferences {
  return normalizeMarkdownPreferences({
    editorFontFamily: process.env.LIBERA_MARKDOWN_EDITOR_FONT_FAMILY,
    baseFontSize: process.env.LIBERA_MARKDOWN_BASE_FONT_SIZE,
    baseLineHeight: process.env.LIBERA_MARKDOWN_BASE_LINE_HEIGHT,
    pdfExportBaseFontSize: process.env.LIBERA_MARKDOWN_PDF_BASE_FONT_SIZE,
    pdfExportBaseLineHeight: process.env.LIBERA_MARKDOWN_PDF_BASE_LINE_HEIGHT,
  });
}
