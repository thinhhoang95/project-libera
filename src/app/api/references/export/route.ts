import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { contentDisposition } from "@/lib/content-disposition";
import { serializeBibtex } from "@/lib/references/bibtex";
import { citedKeys } from "@/lib/references/citation-syntax";
import { serializeCslJson } from "@/lib/references/csl-json";
import { serializeRis } from "@/lib/references/ris";
import type { ReferenceEntry } from "@/lib/references/types";
import { MAX_TEXT_FILE_BYTES } from "@/lib/storage/constants";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment } from "@/lib/storage/paths";
import { readReferenceLibrary } from "@/lib/storage/references";

export const runtime = "nodejs";

// POST { notebook, format, ids?, documentText?, documentName?,
// abbreviateJournals?, includeAliases? } → a file download (the "Import and
// export" contract in docs/references/lanes.md).
//
// - `ids` limits the export to those entries; ids no longer in the library are ignored.
// - `documentText` limits it to the keys the document cites, aliases resolved,
//   in citation order. Keys the library does not know are listed, each
//   URI-encoded and comma-separated, in X-Libera-Unresolved-Keys, and in a
//   comment at the top of BibTeX and RIS files.
// - `documentName` names the download `<document>-bibliography.<ext>`;
//   otherwise it is `<notebook>-references.<ext>`, or `<notebook>-bibliography.<ext>`
//   for a document's text without a name.
// - `abbreviateJournals` (BibTeX and BibLaTeX) writes the short journal title.
// - `includeAliases` (BibTeX and BibLaTeX) writes `@comment{alias: old -> key}` lines.

const FORMATS = {
  bibtex: { extension: "bib", contentType: "application/x-bibtex; charset=utf-8" },
  biblatex: { extension: "bib", contentType: "application/x-bibtex; charset=utf-8" },
  "csl-json": { extension: "json", contentType: "application/vnd.citationstyles.csl+json; charset=utf-8" },
  ris: { extension: "ris", contentType: "application/x-research-info-systems; charset=utf-8" },
} as const;
type ExportFormat = keyof typeof FORMATS;

const MAX_BODY_BYTES = MAX_TEXT_FILE_BYTES * 2 + 1_000_000;
const MAX_IDS = 100_000;

/** Entries for the keys a document cites, in citation order, and the keys no entry or alias matches. */
function entriesForKeys(entries: ReferenceEntry[], keys: string[]) {
  const exact = new Map<string, ReferenceEntry>();
  const folded = new Map<string, ReferenceEntry>();
  for (const entry of entries) {
    for (const key of [entry.key, ...entry.aliases]) {
      if (!exact.has(key)) exact.set(key, entry);
      if (!folded.has(key.toLowerCase())) folded.set(key.toLowerCase(), entry);
    }
  }
  const selected = new Set<ReferenceEntry>();
  const unresolved: string[] = [];
  for (const key of keys) {
    const entry = exact.get(key) ?? folded.get(key.toLowerCase());
    if (entry) selected.add(entry); else unresolved.push(key);
  }
  return { selected: [...selected], unresolved };
}

function serialize(format: ExportFormat, entries: ReferenceEntry[], options: { abbreviateJournals: boolean; includeAliases: boolean }) {
  if (format === "csl-json") return serializeCslJson(entries);
  if (format === "ris") return serializeRis(entries);
  return serializeBibtex(entries, { dialect: format, ...options });
}

function unresolvedComment(format: ExportFormat, keys: string[]) {
  if (!keys.length || format === "csl-json") return "";
  const text = `Citation keys not found in the References library: ${keys.join(", ")}`;
  // RIS has no comment syntax; readers skip lines outside TY … ER records.
  return format === "ris" ? `${text}\r\n\r\n` : `% ${text}\n\n`;
}

function downloadBaseName(notebook: string, documentName: string | undefined, forDocument: boolean) {
  if (documentName === undefined) return `${notebook}-${forDocument ? "bibliography" : "references"}`;
  const base = documentName.split("/").at(-1)!.replace(/\.[^.]+$/, "").trim();
  return `${base || notebook}-bibliography`;
}

function handleError(error: unknown) {
  if (error instanceof StorageError) return jsonError(error.message, error.status);
  const storageError = toStorageError(error);
  if (storageError.status === 500) console.error("[references] Could not export references.", error);
  return jsonError(storageError.status === 500 ? "Could not export the references." : storageError.message, storageError.status);
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonError("The document is too large to export a bibliography from.", 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { notebook, format, ids, documentText, documentName, abbreviateJournals, includeAliases } = body as Record<string, unknown>;
    if (typeof notebook !== "string") return jsonError("Notebook name is required.");
    const safeNotebook = assertSafeSegment(notebook, "Notebook name");
    if (typeof format !== "string" || !Object.hasOwn(FORMATS, format)) return jsonError("Export format must be bibtex, biblatex, csl-json or ris.");
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((id) => typeof id === "string"))) {
      return jsonError("Entry ids must be a list of strings.");
    }
    if (documentText !== undefined && typeof documentText !== "string") return jsonError("Document text must be a string.");
    if (documentName !== undefined && typeof documentName !== "string") return jsonError("Document name must be a string.");
    for (const [label, value] of [["abbreviateJournals", abbreviateJournals], ["includeAliases", includeAliases]] as const) {
      if (value !== undefined && typeof value !== "boolean") return jsonError(`${label} must be true or false.`);
    }

    const library = await readReferenceLibrary(safeNotebook);
    let entries = Object.values(library.entries);
    let unresolved: string[] = [];
    if (typeof documentText === "string") {
      ({ selected: entries, unresolved } = entriesForKeys(entries, citedKeys(documentText)));
    }
    if (ids) {
      const wanted = new Set(ids as string[]);
      entries = entries.filter((entry) => wanted.has(entry.id));
    }

    const exportFormat = format as ExportFormat;
    const content = unresolvedComment(exportFormat, unresolved) + serialize(exportFormat, entries, {
      abbreviateJournals: abbreviateJournals === true,
      includeAliases: includeAliases === true,
    });
    const { extension, contentType } = FORMATS[exportFormat];
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Disposition": contentDisposition("attachment", `${downloadBaseName(safeNotebook, documentName as string | undefined, typeof documentText === "string")}.${extension}`),
      "Content-Type": contentType,
    });
    if (unresolved.length) headers.set("X-Libera-Unresolved-Keys", unresolved.map(encodeURIComponent).join(","));
    return new NextResponse(content, { headers });
  } catch (error) {
    return handleError(error);
  }
}
