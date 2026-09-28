import type { PdfAnnotationRect, PdfTextAnnotationFont } from "@/lib/types";

export type AnnotationSwatch = {
  label: string;
  value: `#${string}`;
};

/**
 * Highlighter inks. They are painted opaque inside a multiply-blended layer,
 * so white paper takes the ink color while glyphs stay black, like a real
 * highlighter. Values are pastel enough to keep dark text readable.
 */
export const PDF_HIGHLIGHT_COLORS = [
  { label: "Yellow", value: "#ffe45c" },
  { label: "Green", value: "#b4eea0" },
  { label: "Blue", value: "#a8d8ff" },
  { label: "Pink", value: "#ffb8d9" },
  { label: "Orange", value: "#ffc987" },
  { label: "Purple", value: "#d7c6ff" },
] as const satisfies readonly AnnotationSwatch[];

/** Pen inks for text notes. PDF pages are white paper in every app theme. */
export const PDF_TEXT_COLORS = [
  { label: "Blue ink", value: "#1d4ed8" },
  { label: "Black ink", value: "#1f2328" },
  { label: "Red ink", value: "#c62828" },
  { label: "Green ink", value: "#17753a" },
  { label: "Purple ink", value: "#6d28d9" },
  { label: "Orange ink", value: "#c2410c" },
] as const satisfies readonly AnnotationSwatch[];

export const DEFAULT_PDF_HIGHLIGHT_COLOR = PDF_HIGHLIGHT_COLORS[0].value;
export const DEFAULT_PDF_TEXT_COLOR = PDF_TEXT_COLORS[0].value;
export const DEFAULT_PDF_TEXT_FONT: PdfTextAnnotationFont = "sans";

export const PDF_TEXT_FONTS: readonly {
  label: string;
  stack: string;
  value: PdfTextAnnotationFont;
}[] = [
  {
    value: "sans",
    label: "Sans",
    stack: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  },
  {
    value: "serif",
    label: "Serif",
    stack: 'Charter, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
  },
  {
    value: "hand",
    label: "Handwriting",
    stack: '"Bradley Hand", Noteworthy, "Segoe Print", "Ink Free", "Comic Sans MS", cursive',
  },
  {
    value: "mono",
    label: "Mono",
    stack: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  },
];

export function pdfTextFontStack(font: PdfTextAnnotationFont | undefined) {
  return (PDF_TEXT_FONTS.find((item) => item.value === font) ?? PDF_TEXT_FONTS[0]).stack;
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

type Box = { left: number; top: number; right: number; bottom: number };

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Collapses the ragged rectangles a DOM selection produces (one per text run,
 * often duplicated or overlapping) into one clean band per contiguous run on
 * each line. Merging happens in display pixels so the thresholds are relative
 * to line height regardless of page aspect ratio. Rects are page fractions.
 */
export function mergeHighlightRects(
  rects: readonly PdfAnnotationRect[],
  pageWidth = 1,
  pageHeight = 1,
): PdfAnnotationRect[] {
  const boxes: Box[] = rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      left: rect.x * pageWidth,
      top: rect.y * pageHeight,
      right: (rect.x + rect.width) * pageWidth,
      bottom: (rect.y + rect.height) * pageHeight,
    }))
    .sort((a, b) => (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2 || a.left - b.left);

  if (boxes.length < 2) {
    return rects.filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => ({ ...rect }));
  }

  const lines: { band: Box; boxes: Box[] }[] = [];

  for (const box of boxes) {
    const height = box.bottom - box.top;
    const line = lines.find(({ band }) => {
      const overlap = Math.min(band.bottom, box.bottom) - Math.max(band.top, box.top);

      return overlap >= 0.5 * Math.min(height, band.bottom - band.top);
    });

    if (line) {
      line.boxes.push(box);
      line.band = {
        left: Math.min(line.band.left, box.left),
        top: Math.min(line.band.top, box.top),
        right: Math.max(line.band.right, box.right),
        bottom: Math.max(line.band.bottom, box.bottom),
      };
    } else {
      lines.push({ band: { ...box }, boxes: [box] });
    }
  }

  const merged: PdfAnnotationRect[] = [];

  for (const line of lines) {
    // A shared top/bottom keeps every segment of a line the same height even
    // when a superscript or a taller run stretched one of the source rects.
    const top = median(line.boxes.map((box) => box.top));
    const bottom = median(line.boxes.map((box) => box.bottom));
    const gap = 0.45 * (bottom - top);
    const sorted = [...line.boxes].sort((a, b) => a.left - b.left);
    let left = sorted[0].left;
    let right = sorted[0].right;

    const flush = () => {
      merged.push({
        x: left / pageWidth,
        y: top / pageHeight,
        width: (right - left) / pageWidth,
        height: (bottom - top) / pageHeight,
      });
    };

    for (const box of sorted.slice(1)) {
      if (box.left <= right + gap) {
        right = Math.max(right, box.right);
      } else {
        flush();
        left = box.left;
        right = box.right;
      }
    }

    flush();
  }

  return merged.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Client rects for the text a range covers, measured per text node so element
 * boxes (a whole fully-selected text layer, for instance) never leak in.
 */
export function rangeTextClientRects(range: Range, withinSelector: string): DOMRect[] {
  const root = range.commonAncestorContainer;
  const ownerDocument = root.ownerDocument ?? document;

  if (root.nodeType === 3) {
    return root.parentElement?.closest(withinSelector) ? Array.from(range.getClientRects()) : [];
  }

  const walker = ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const rects: DOMRect[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent || !range.intersectsNode(node) || !node.parentElement?.closest(withinSelector)) {
      continue;
    }

    const nodeRange = ownerDocument.createRange();
    nodeRange.selectNodeContents(node);

    if (node === range.startContainer) {
      nodeRange.setStart(node, range.startOffset);
    }

    if (node === range.endContainer) {
      nodeRange.setEnd(node, range.endOffset);
    }

    if (!nodeRange.collapsed) {
      rects.push(...Array.from(nodeRange.getClientRects()));
    }
  }

  return rects;
}
