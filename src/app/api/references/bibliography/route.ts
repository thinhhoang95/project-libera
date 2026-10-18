import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { contentDisposition } from "@/lib/content-disposition";
import { BIBLIOGRAPHY_FORMATS, formatNotebookBibliography, type BibliographyFormat } from "@/lib/references/bibliography-export";
import { MAX_TEXT_FILE_BYTES } from "@/lib/storage/constants";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment } from "@/lib/storage/paths";
import { readReferenceLibrary } from "@/lib/storage/references";

export const runtime = "nodejs";

// POST { notebook, format: "text" | "markdown" | "html", documentText?, ids?,
// style?, download?, documentName? } → { text, count, unresolvedKeys }, or a
// file download with `download: true` (docs/references/plan.md §1.5).
//
// - `documentText` formats only the entries it cites, in the style's order;
//   `ids` is then ignored. Otherwise `ids`, or the whole library.
// - `style` is a bundled style id or a `.csl` path; the library's style by default.
// - Markdown keeps italics as `*…*` and escapes Markdown syntax in the text.
// - HTML is citeproc's output through the same allowlist as the preview.
// - The download is `<document>-bibliography.<txt|md|html>`, or
//   `<notebook>-references.<ext>` without a document name; HTML downloads
//   are a complete page.

const EXTENSIONS: Record<BibliographyFormat, { extension: string; contentType: string }> = {
  text: { extension: "txt", contentType: "text/plain; charset=utf-8" },
  markdown: { extension: "md", contentType: "text/markdown; charset=utf-8" },
  html: { extension: "html", contentType: "text/html; charset=utf-8" },
};

const MAX_BODY_BYTES = MAX_TEXT_FILE_BYTES * 2 + 1_000_000;
const MAX_IDS = 100_000;

function downloadName(notebook: string, documentName: string | undefined, format: BibliographyFormat) {
  const base = documentName?.split("/").at(-1)!.replace(/\.[^.]+$/, "").trim();
  return `${base ? `${base}-bibliography` : `${notebook}-references`}.${EXTENSIONS[format].extension}`;
}

function htmlPage(title: string, body: string) {
  const escaped = title.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escaped}</title>
<style>body{font-family:Georgia,serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.5}.csl-entry{margin:0 0 .75em}.csl-hanging-indent .csl-entry{padding-left:2em;text-indent:-2em}.csl-left-margin{float:left;min-width:2.5em}.csl-right-inline{margin-left:2.5em}</style>
</head><body>\n${body}\n</body></html>\n`;
}

function handleError(error: unknown) {
  if (error instanceof StorageError) return jsonError(error.message, error.status);
  const storageError = toStorageError(error);
  if (storageError.status === 500) console.error("[references] Could not format the bibliography.", error);
  return jsonError(storageError.status === 500 ? "Could not format the reference list." : storageError.message, storageError.status);
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonError("The document is too large to format a bibliography from.", 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { notebook, format, documentText, ids, style, download, documentName } = body as Record<string, unknown>;
    if (typeof notebook !== "string") return jsonError("Notebook name is required.");
    const safeNotebook = assertSafeSegment(notebook, "Notebook name");
    if (typeof format !== "string" || !BIBLIOGRAPHY_FORMATS.includes(format as BibliographyFormat)) {
      return jsonError("The format must be text, markdown or html.");
    }
    if (documentText !== undefined && typeof documentText !== "string") return jsonError("Document text must be a string.");
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((id) => typeof id === "string"))) {
      return jsonError("Entry ids must be a list of strings.");
    }
    if (style !== undefined && typeof style !== "string") return jsonError("The style must be a string.");
    if (download !== undefined && typeof download !== "boolean") return jsonError("download must be true or false.");
    if (documentName !== undefined && typeof documentName !== "string") return jsonError("Document name must be a string.");

    const library = await readReferenceLibrary(safeNotebook);
    const bibliographyFormat = format as BibliographyFormat;
    const result = await formatNotebookBibliography({
      notebook: safeNotebook,
      library,
      format: bibliographyFormat,
      documentText: documentText as string | undefined,
      ids: ids as string[] | undefined,
      style: style as string | undefined,
    });

    if (!download) return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    const fileName = downloadName(safeNotebook, documentName as string | undefined, bibliographyFormat);
    const content = bibliographyFormat === "html" ? htmlPage(fileName.replace(/\.html$/, ""), result.text) : `${result.text}\n`;
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Disposition": contentDisposition("attachment", fileName),
      "Content-Type": EXTENSIONS[bibliographyFormat].contentType,
    });
    if (result.unresolvedKeys.length) headers.set("X-Libera-Unresolved-Keys", result.unresolvedKeys.map(encodeURIComponent).join(","));
    return new NextResponse(content, { headers });
  } catch (error) {
    return handleError(error);
  }
}
