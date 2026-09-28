/** Return the part of a PDF text selection that belongs to one page. */
export function pdfHighlightQuote(range: Range, textLayer: Element): string {
  const pageRange = range.cloneRange();

  if (!textLayer.contains(range.startContainer)) {
    pageRange.setStart(textLayer, 0);
  }

  if (!textLayer.contains(range.endContainer)) {
    pageRange.setEnd(textLayer, textLayer.childNodes.length);
  }

  return normalizePdfHighlightQuote(pageRange.toString());
}

export function normalizePdfHighlightQuote(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 10_000);
}
