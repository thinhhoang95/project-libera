"use client";

import { useEffect, useMemo, useState } from "react";
import { pdfPageLabelsFor } from "@/components/libera/references/pdf-page-labels";
import { SEARCH_HIGHLIGHT_SECTION, snippetWindow, type SearchHit, type SearchRequest, type SearchResponse } from "@/lib/global-search";
import { entryForAttachment, pdfQuoteLocator } from "@/lib/references/pdf-quote";
import type { ReferenceEntry, ReferenceLibrary } from "@/lib/references/types";
import { embeddingText } from "@/lib/search/chunking";

// "From your library's meaning" in the `@` popup (docs/references/plan.md
// §4.3, Phase 5): a query such as "that paper about sparse attention I
// highlighted" goes to Global Search, restricted to this notebook's References
// entries and its entries' attached PDFs and Markdown files (with their PDF
// highlight quotes). File hits map back to their entries by attachment path.
// Each row says why it matched, and a PDF page or highlight hit cites its page.

export const SEMANTIC_SEARCH_DEBOUNCE_MS = 250;
export const SEMANTIC_ROW_LIMIT = 5;
const SNIPPET_CHARS = 140;

/** The words of an `@` query. Typed queries cannot hold spaces, so `-`, `_` and `+` separate words too. */
export function citationQueryWords(query: string) {
  return query.split(/[\s_+]+|-+/u).map((word) => word.trim()).filter(Boolean);
}

/** Whether the popup asks Global Search: three words or more, or two when nothing in the library matches. */
export function wantsSemanticCitationSearch(query: string, prefixMatches: number) {
  const words = citationQueryWords(query).length;
  return words >= 3 || (words >= 2 && prefixMatches === 0);
}

/** The PDF and Markdown files attached to the library's entries. */
export function libraryAttachmentPaths(library: Pick<ReferenceLibrary, "entries">) {
  const paths = new Set<string>();
  for (const entry of Object.values(library.entries)) {
    for (const attachment of entry.attachments) if (attachment.kind !== "url") paths.add(attachment.path);
  }
  return [...paths].sort();
}

/** The Global Search request for an `@` query in `notebook`. */
export function semanticCitationRequest(query: string, notebook: string, library: Pick<ReferenceLibrary, "entries">): SearchRequest {
  return {
    parts: [{ type: "text", text: citationQueryWords(query).join(" ") }],
    kinds: ["reference", "pdf", "markdown"],
    within: { notebooks: [notebook], paths: libraryAttachmentPaths(library) },
    limit: 20,
  };
}

export type SemanticMatchReason =
  /** The entry's own record: its description, abstract or notes. */
  | { kind: "reference"; section?: string; text: string }
  /** A passage of an attached PDF, on a page. */
  | { kind: "page"; page: number; text: string; path: string }
  /** A highlight in an attached PDF, on a page. */
  | { kind: "highlight"; page: number; text: string; path: string }
  /** A passage of an attached Markdown file (or a PDF passage without a page). */
  | { kind: "passage"; section?: string; text: string; path: string };

export type SemanticCitationRow = {
  entry: ReferenceEntry;
  reason: SemanticMatchReason;
  /** The page locator to cite, for a PDF page or highlight hit. */
  pageLocator?: string;
};

type PageLabels = (path: string) => readonly string[] | null | undefined;

function snippet(kind: string, hit: SearchHit, terms: string[]) {
  const window = snippetWindow(embeddingText(kind, hit.text), terms, SNIPPET_CHARS);
  return `${window.clippedStart ? "… " : ""}${window.text}${window.clippedEnd ? " …" : ""}`;
}

/**
 * Rows for a Global Search response: one per entry, in the response's order,
 * with the reason of its best hit. Results that map to no entry of `library`
 * are dropped.
 */
export function semanticCitationRows(
  response: Pick<SearchResponse, "results" | "terms">,
  library: Pick<ReferenceLibrary, "entries">,
  { limit = SEMANTIC_ROW_LIMIT, pageLabels = pdfPageLabelsFor }: { limit?: number; pageLabels?: PageLabels } = {},
): SemanticCitationRow[] {
  const rows: SemanticCitationRow[] = [];
  const seen = new Set<string>();
  for (const result of response.results) {
    if (rows.length >= limit) break;
    const entry = result.source === "references"
      ? (result.reference ? library.entries[result.reference.entryId] : undefined)
      : result.source === "library" ? entryForAttachment(library, result.path) : null;
    if (!entry || seen.has(entry.id)) continue;
    const hit = result.hits[0];
    if (!hit) continue;
    seen.add(entry.id);
    const text = snippet(result.kind, hit, response.terms);
    const page = hit.location.page;
    if (result.source === "references") {
      rows.push({ entry, reason: { kind: "reference", section: hit.location.section, text } });
    } else if (result.kind === "pdf" && page) {
      const labels = pageLabels(result.path);
      const pageLabel = labels?.[page - 1]?.trim();
      const pageLocator = pdfQuoteLocator({ page, ...(pageLabel ? { pageLabel } : {}) }, entry);
      const kind = hit.location.section === SEARCH_HIGHLIGHT_SECTION ? "highlight" : "page";
      rows.push({ entry, reason: { kind, page, text, path: result.path }, pageLocator });
    } else {
      rows.push({ entry, reason: { kind: "passage", section: hit.location.section, text, path: result.path } });
    }
  }
  return rows;
}

export type SemanticCitationState = {
  rows: SemanticCitationRow[];
  /** "keyword" when the index has no usable model: the rows are keyword (BM25) matches. */
  mode: SearchResponse["mode"];
  loading: boolean;
};

type Settled = { signature: string; rows: SemanticCitationRow[]; mode: SearchResponse["mode"] };

/**
 * The popup's semantic section for `query`: null when it does not apply;
 * otherwise `loading` until the debounced, abortable search answers. A failed
 * search, or no index, gives no rows (the section hides).
 */
export function useSemanticCitationSearch(
  { notebook, library, query, enabled }: { notebook: string | null; library: ReferenceLibrary | null; query: string; enabled: boolean },
): SemanticCitationState | null {
  const request = useMemo(() => enabled && notebook && library ? semanticCitationRequest(query, notebook, library) : null, [enabled, library, notebook, query]);
  const signature = request ? JSON.stringify(request) : "";
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (!request || !library) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        let rows: SemanticCitationRow[] = [];
        let mode: SearchResponse["mode"] = "keyword";
        try {
          const response = await fetch("/api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
            signal: controller.signal,
          });
          if (response.ok) {
            const body = await response.json() as SearchResponse;
            rows = semanticCitationRows(body, library);
            mode = body.mode;
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        if (!controller.signal.aborted) setSettled({ signature: JSON.stringify(request), rows, mode });
      })();
    }, SEMANTIC_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [library, request]);

  if (!request) return null;
  if (settled?.signature !== signature) return { rows: [], mode: "keyword", loading: true };
  return { rows: settled.rows, mode: settled.mode, loading: false };
}
