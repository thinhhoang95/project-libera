import type { PdfAnnotation, PdfAnnotationRect } from "@/lib/types";
import { markdownLinkQuoteLabel } from "@/lib/markdown-selection-links";
import { drawingBounds } from "@/lib/pdf-drawing";

// The last annotations each PDF or image viewer showed, by file path. Link
// dialogs label "the selected annotation in tab X" from here, also after X's
// viewer has unmounted.
const knownAnnotations = new Map<string, PdfAnnotation[]>();

export function rememberFileAnnotations(path: string, annotations: PdfAnnotation[]) {
  knownAnnotations.set(path, annotations);
}

export function findRememberedAnnotation(path: string, id: string | undefined) {
  return id ? knownAnnotations.get(path)?.find((annotation) => annotation.id === id) : undefined;
}

/** "Highlight “…”" / "Note “…”", or a generic name when the text is unknown. */
export function annotationLinkLabel(annotation: PdfAnnotation | undefined, fallback: string) {
  if (!annotation || annotation.type === "shape" || annotation.type === "ink" || annotation.type === "space") return fallback;
  const text = annotation.type === "highlight" ? annotation.quote ?? "" : annotation.text;
  return markdownLinkQuoteLabel(text) || fallback;
}

export function annotationAnchorRect(annotation: PdfAnnotation): PdfAnnotationRect {
  if (annotation.type === "text") return annotation.rect;
  if (annotation.type === "shape" || annotation.type === "ink") return drawingBounds(annotation);
  if (annotation.type === "space") return { x: 0, y: annotation.y, width: 1, height: 0 };
  const [first, ...rest] = annotation.rects;
  if (!first) return { x: 0, y: 0, width: 0, height: 0 };
  // The union of a highlight's line boxes.
  return rest.reduce((union, rect) => {
    const x = Math.min(union.x, rect.x), y = Math.min(union.y, rect.y);
    return {
      x,
      y,
      width: Math.max(union.x + union.width, rect.x + rect.width) - x,
      height: Math.max(union.y + union.height, rect.y + rect.height) - y,
    };
  }, first);
}

/** The scroll offset that puts a page-relative rect in the middle of the viewport. */
export function scrollTopCenteringRect(
  pageTop: number,
  pageHeight: number,
  rect: PdfAnnotationRect,
  viewportHeight: number,
) {
  return Math.max(0, pageTop + (rect.y + rect.height / 2) * pageHeight - viewportHeight / 2);
}

/** The pan that centers an image-relative rect, for an image shown at `size` and `zoom` around its center. */
export function panCenteringRect(rect: PdfAnnotationRect, size: { width: number; height: number }, zoom: number) {
  return {
    x: -(rect.x + rect.width / 2 - 0.5) * size.width * zoom,
    y: -(rect.y + rect.height / 2 - 0.5) * size.height * zoom,
  };
}
