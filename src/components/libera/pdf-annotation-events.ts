import type { PdfAnnotation } from "@/lib/types";

export const PDF_ANNOTATIONS_UPDATED_EVENT = "libera:pdf-annotations-updated";

export type PdfAnnotationsUpdatedDetail = {
  annotations: PdfAnnotation[];
  path: string;
};

export function dispatchPdfAnnotationsUpdated(detail: PdfAnnotationsUpdatedDetail) {
  window.dispatchEvent(
    new CustomEvent<PdfAnnotationsUpdatedDetail>(PDF_ANNOTATIONS_UPDATED_EVENT, {
      detail,
    }),
  );
}
