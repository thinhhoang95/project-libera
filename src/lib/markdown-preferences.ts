export type MarkdownPreferences = {
  editorFontFamily: string;
  baseFontSize: number;
  baseLineHeight: number;
  pdfExportBaseFontSize: number;
  pdfExportBaseLineHeight: number;
};

export const DEFAULT_MARKDOWN_EDITOR_FONT_FAMILY = "system-monospace";
export const MAX_MARKDOWN_EDITOR_FONT_FAMILY_LENGTH = 256;

const DEFAULT_MARKDOWN_EDITOR_FONT_STACK =
  '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace';

export const DEFAULT_MARKDOWN_BASE_FONT_SIZE = 16;
export const DEFAULT_MARKDOWN_BASE_LINE_HEIGHT = 1.75;
export const MAX_MARKDOWN_BASE_FONT_SIZE = 32;
export const MAX_MARKDOWN_BASE_LINE_HEIGHT = 2.4;
export const MIN_MARKDOWN_BASE_FONT_SIZE = 10;
export const MIN_MARKDOWN_BASE_LINE_HEIGHT = 1.1;

function normalizeNumber(value: unknown, fallback: number) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;

  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeMarkdownBaseFontSize(value: unknown) {
  return clamp(
    normalizeNumber(value, DEFAULT_MARKDOWN_BASE_FONT_SIZE),
    MIN_MARKDOWN_BASE_FONT_SIZE,
    MAX_MARKDOWN_BASE_FONT_SIZE,
  );
}

export function normalizeMarkdownEditorFontFamily(value: unknown) {
  const fontFamily = typeof value === "string" ? value.trim() : "";

  if (
    !fontFamily ||
    fontFamily.length > MAX_MARKDOWN_EDITOR_FONT_FAMILY_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(fontFamily)
  ) {
    return DEFAULT_MARKDOWN_EDITOR_FONT_FAMILY;
  }

  return fontFamily;
}

export function getMarkdownEditorFontStack(fontFamily: string) {
  if (fontFamily === DEFAULT_MARKDOWN_EDITOR_FONT_FAMILY) {
    return DEFAULT_MARKDOWN_EDITOR_FONT_STACK;
  }

  const escapedFontFamily = fontFamily.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

  return `"${escapedFontFamily}", ui-monospace, monospace`;
}

export function normalizeMarkdownBaseLineHeight(value: unknown) {
  return clamp(
    normalizeNumber(value, DEFAULT_MARKDOWN_BASE_LINE_HEIGHT),
    MIN_MARKDOWN_BASE_LINE_HEIGHT,
    MAX_MARKDOWN_BASE_LINE_HEIGHT,
  );
}

export function normalizeMarkdownPreferences(
  input: {
    editorFontFamily?: unknown;
    baseFontSize?: unknown;
    baseLineHeight?: unknown;
    pdfExportBaseFontSize?: unknown;
    pdfExportBaseLineHeight?: unknown;
  } = {},
): MarkdownPreferences {
  return {
    editorFontFamily: normalizeMarkdownEditorFontFamily(input.editorFontFamily),
    baseFontSize: normalizeMarkdownBaseFontSize(input.baseFontSize),
    baseLineHeight: normalizeMarkdownBaseLineHeight(input.baseLineHeight),
    pdfExportBaseFontSize: normalizeMarkdownBaseFontSize(
      input.pdfExportBaseFontSize,
    ),
    pdfExportBaseLineHeight: normalizeMarkdownBaseLineHeight(
      input.pdfExportBaseLineHeight,
    ),
  };
}
