import {
  normalizeMarkdownPreferences,
  type MarkdownPreferences,
} from "@/lib/markdown-preferences";

export function getConfiguredMarkdownPreferences(): MarkdownPreferences {
  return normalizeMarkdownPreferences({
    inlineMathMarkers: process.env.LIBERA_MARKDOWN_INLINE_MATH_MARKERS,
    blockMathMarkers: process.env.LIBERA_MARKDOWN_BLOCK_MATH_MARKERS,
    editorFontFamily: process.env.LIBERA_MARKDOWN_EDITOR_FONT_FAMILY,
    wysiwygEditorFontFamily: process.env.LIBERA_WYSIWYG_EDITOR_FONT_FAMILY,
    renderedMarkdownFontFamily: process.env.LIBERA_RENDERED_MARKDOWN_FONT_FAMILY,
    baseFontSize: process.env.LIBERA_MARKDOWN_BASE_FONT_SIZE,
    baseLineHeight: process.env.LIBERA_MARKDOWN_BASE_LINE_HEIGHT,
    pdfExportBaseFontSize: process.env.LIBERA_MARKDOWN_PDF_BASE_FONT_SIZE,
    pdfExportBaseLineHeight: process.env.LIBERA_MARKDOWN_PDF_BASE_LINE_HEIGHT,
  });
}
