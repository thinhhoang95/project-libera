import type { ResolvedEditorTheme } from "../../electron/editor-themes.cjs";

// Black ink keeps at least 7:1 contrast on a page this light.
const MIN_PAPER_LUMINANCE = 0.3;

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The paper color PDF pages are drawn on, from the visual editor's theme, or
 * "" for pdf.js's white. Only the page fill changes (pdf.js `background`):
 * PDF ink is nearly always dark, so a page too dark for black text is skipped
 * for the theme's light page, and failing that, white. Recoloring the ink as
 * well (`pageColors`) would posterize every page into six gray tones.
 */
export function pdfPaperColor(theme: ResolvedEditorTheme | null, dark: boolean) {
  if (!theme) return "";
  const candidates = dark ? [theme.dark.background, theme.light.background] : [theme.light.background];
  const paper = candidates.find((color) => luminance(color) >= MIN_PAPER_LUMINANCE);
  return !paper || paper === "#ffffff" ? "" : paper;
}

/** Whether a color sampled from a rendered page is the themed paper itself. */
export function isPdfPaperColor(color: string, paper: string) {
  if (!paper || !/^#[0-9a-f]{6}$/i.test(color)) return false;
  let distance = 0;
  for (const index of [1, 3, 5]) {
    distance += Math.abs(Number.parseInt(color.slice(index, index + 2), 16) - Number.parseInt(paper.slice(index, index + 2), 16));
  }
  return distance <= 6;
}
