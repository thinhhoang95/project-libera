"use client";

import { writeRichClipboard } from "@/components/libera/references/reference-candidates";
import { contentDispositionFileName, EXPORT_FORMATS, type ExportFormat } from "@/components/libera/references/manage-references-dialog";

// Formatted reference lists and document bibliographies from the panel menu
// (docs/references/plan.md §1.5): the whole library, or only what the active
// document cites, formatted in the notebook's style through
// POST /api/references/bibliography (text, Markdown, HTML) or exported as a
// machine format through POST /api/references/export. Keys the document cites
// that the library lacks come back in the body or the X-Libera-Unresolved-Keys
// header and are reported.

export type BibliographyFormat = "text" | "markdown" | "html";

export const BIBLIOGRAPHY_FORMATS: Array<{ id: BibliographyFormat; label: string; extension: string }> = [
  { id: "text", label: "Plain text", extension: "txt" },
  { id: "markdown", label: "Markdown", extension: "md" },
  { id: "html", label: "HTML", extension: "html" },
];

/** Every format the "For this document" export offers: machine formats first, then formatted lists. */
export type DocumentExportFormat = ExportFormat | BibliographyFormat;
export const DOCUMENT_EXPORT_FORMATS: Array<{ id: DocumentExportFormat; label: string; extension: string }> = [
  ...EXPORT_FORMATS.map((format) => ({ id: format.id as DocumentExportFormat, label: format.label, extension: format.extension as string })),
  ...BIBLIOGRAPHY_FORMATS.map((format) => ({ ...format, label: `Formatted ${format.label.toLowerCase()}` })),
];

export type BibliographyRequest = {
  notebook: string;
  /** The active document's text: only what it cites. Omitted for the whole library. */
  documentText?: string;
  /** Names the download after the document. */
  documentName?: string;
};

export type BibliographyResult = { count: number; unresolvedKeys: string[] };

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return fallback;
}

/** X-Libera-Unresolved-Keys: URI-encoded keys, comma-separated. */
export function unresolvedKeysHeader(header: string | null) {
  if (!header) return [];
  return header.split(",").filter(Boolean).map((key) => {
    try {
      return decodeURIComponent(key);
    } catch {
      return key;
    }
  });
}

function post(url: string, body: Record<string, unknown>) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** The formatted list as `format`: { text, count, unresolvedKeys }. */
export async function fetchBibliography(request: BibliographyRequest & { format: BibliographyFormat }) {
  const response = await post("/api/references/bibliography", { notebook: request.notebook, format: request.format, ...(request.documentText !== undefined ? { documentText: request.documentText } : {}) });
  if (!response.ok) throw new Error(await errorMessage(response, "The reference list could not be formatted."));
  const body = await response.json() as { text?: unknown; count?: unknown; unresolvedKeys?: unknown };
  return {
    text: typeof body.text === "string" ? body.text : "",
    count: typeof body.count === "number" ? body.count : 0,
    unresolvedKeys: Array.isArray(body.unresolvedKeys) ? body.unresolvedKeys.filter((key): key is string => typeof key === "string") : [],
  };
}

/** Copy the formatted list as text/plain and text/html. */
export async function copyBibliography(request: BibliographyRequest): Promise<BibliographyResult> {
  const [text, html] = await Promise.all([
    fetchBibliography({ ...request, format: "text" }),
    fetchBibliography({ ...request, format: "html" }),
  ]);
  await writeRichClipboard(text.text, html.text);
  return { count: text.count, unresolvedKeys: text.unresolvedKeys };
}

/** Save a download response like other downloads in the app: an anchor with a blob URL (the desktop app shows its Save dialog). */
async function saveDownload(response: Response, fallbackName: string) {
  const fileName = contentDispositionFileName(response.headers.get("Content-Disposition")) ?? fallbackName;
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  return fileName;
}

/** Download the library's or the document's reference list, formatted or as BibTeX, BibLaTeX, CSL-JSON or RIS. */
export async function downloadBibliography(request: BibliographyRequest & { format: DocumentExportFormat }): Promise<{ fileName: string; unresolvedKeys: string[] }> {
  const formatted = BIBLIOGRAPHY_FORMATS.some((format) => format.id === request.format);
  const forDocument = request.documentText !== undefined;
  const body: Record<string, unknown> = {
    notebook: request.notebook,
    format: request.format,
    ...(forDocument ? { documentText: request.documentText } : {}),
    ...(request.documentName ? { documentName: request.documentName } : {}),
    ...(formatted ? { download: true } : {}),
  };
  const response = await post(formatted ? "/api/references/bibliography" : "/api/references/export", body);
  if (!response.ok) throw new Error(await errorMessage(response, forDocument ? "The bibliography could not be exported." : "The reference list could not be exported."));
  const extension = DOCUMENT_EXPORT_FORMATS.find((format) => format.id === request.format)?.extension ?? "txt";
  const fileName = await saveDownload(response, `${request.notebook}-${forDocument ? "bibliography" : "references"}.${extension}`);
  return { fileName, unresolvedKeys: unresolvedKeysHeader(response.headers.get("X-Libera-Unresolved-Keys")) };
}

/** " · 2 cited keys are not in the library: a, b" for a notice, or "". */
export function unresolvedNote(keys: string[]) {
  if (!keys.length) return "";
  const shown = keys.slice(0, 5).join(", ");
  return ` ${keys.length === 1 ? "1 cited key is" : `${keys.length} cited keys are`} not in the library: ${shown}${keys.length > 5 ? ", …" : ""}.`;
}
