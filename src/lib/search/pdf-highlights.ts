import { readFile } from "node:fs/promises";
import { SEARCH_HIGHLIGHT_SECTION } from "@/lib/global-search";
import { normalizePdfHighlightQuote } from "@/lib/pdf-highlight-quote";
import type { NewChunk } from "@/lib/search/database";
import { readFileSignature } from "@/lib/storage/file-signature";
import { pdfAnnotationsPath, splitFilePath } from "@/lib/storage/paths";

// A PDF's highlight quotes as Global Search passages (docs/references/plan.md
// §4.3, Phase 5: "that paper about sparse attention I highlighted"). Each
// highlight with a quote is one passage on its page, titled "Highlight", so a
// hit says it matched something the user marked. They are read from the PDF's
// annotations sidecar without migrating older sidecars: the viewer does that
// when the PDF opens, and saving annotations notifies the index.

function sidecarPath(relativePath: string) {
  const { notebook, pathParts } = splitFilePath(relativePath);
  return pdfAnnotationsPath(notebook, pathParts);
}

/** The identity of a PDF's annotations sidecar; "" when it has none. */
export async function pdfHighlightSignature(relativePath: string) {
  try {
    return `highlights:${await readFileSignature(sidecarPath(relativePath))}`;
  } catch {
    return "";
  }
}

/** One passage per highlight quote of the PDF at `relativePath`, in page order. */
export async function pdfHighlightChunks(relativePath: string): Promise<NewChunk[]> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(sidecarPath(relativePath), "utf8"));
  } catch {
    return [];
  }
  const annotations = (payload as { annotations?: unknown })?.annotations;
  if (!Array.isArray(annotations)) return [];
  const chunks: NewChunk[] = [];
  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== "object") continue;
    const { type, quote, pageNumber } = annotation as { type?: unknown; quote?: unknown; pageNumber?: unknown };
    if (type !== "highlight" || typeof quote !== "string" || !Number.isInteger(pageNumber) || (pageNumber as number) < 1) continue;
    const text = normalizePdfHighlightQuote(quote);
    if (text) chunks.push({ title: SEARCH_HIGHLIGHT_SECTION, text, context: "", page: pageNumber as number });
  }
  return chunks.sort((left, right) => (left.page ?? 0) - (right.page ?? 0));
}
