import type { PdfQuoteSource } from "@/lib/references/pdf-quote";

// Page labels of the PDFs the viewer has open (pdf.js `getPageLabels`). The
// viewer records them here, so a quote from the PDF outline or a page hit in
// the `@` popup can name the printed page of a PDF without loading it again.

const pageLabels = new Map<string, readonly string[] | null>();

/** The viewer read a PDF's page labels (null: it has none). */
export function rememberPdfPageLabels(path: string, labels: readonly string[] | null) {
  pageLabels.set(path, labels?.some((label) => label?.trim()) ? labels : null);
}

/** The page labels of a PDF the viewer has read; undefined when it has not. */
export function pdfPageLabelsFor(path: string) {
  return pageLabels.get(path);
}

/** A quote source with the PDF's own labels for its pages, when the viewer knows them. */
export function withPageLabels(source: PdfQuoteSource): PdfQuoteSource {
  const labels = pdfPageLabelsFor(source.path);
  if (!labels || source.pageLabel) return source;
  const pageLabel = labels[source.page - 1]?.trim();
  const endPageLabel = source.endPage ? labels[source.endPage - 1]?.trim() : undefined;
  return { ...source, ...(pageLabel ? { pageLabel } : {}), ...(endPageLabel ? { endPageLabel } : {}) };
}

/** Tests: forget recorded labels. */
export function resetPdfPageLabels() {
  pageLabels.clear();
}
