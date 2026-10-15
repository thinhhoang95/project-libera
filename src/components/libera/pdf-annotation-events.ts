import type { PdfAnnotation } from "@/lib/types";

export const PDF_ANNOTATIONS_UPDATED_EVENT = "libera:pdf-annotations-updated";

export type PdfAnnotationsUpdatedDetail = {
  annotations: PdfAnnotation[];
  path: string;
};

// The newest annotations each open PDF has shown, including edits whose
// debounced save is still pending, so exports match what is on screen.
const latestByPath = new Map<string, PdfAnnotation[]>();

export function dispatchPdfAnnotationsUpdated(detail: PdfAnnotationsUpdatedDetail) {
  latestByPath.set(detail.path, detail.annotations);
  window.dispatchEvent(
    new CustomEvent<PdfAnnotationsUpdatedDetail>(PDF_ANNOTATIONS_UPDATED_EVENT, {
      detail,
    }),
  );
}

export function latestPdfAnnotations(path: string) {
  return latestByPath.get(path);
}

/** A closed viewer no longer hears about changes; read from storage instead. */
export function forgetPdfAnnotations(path: string) {
  latestByPath.delete(path);
}
