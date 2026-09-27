"use client";

import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { PdfTextContentCache } from "./pdf-rendering";
import { PdfSearchIndex, findPdfMatches, type PdfSearchPage } from "./pdf-find";

export function usePdfFind(pdfDocument: PDFDocumentProxy | null, cache: PdfTextContentCache | null, viewerRef: RefObject<HTMLDivElement | null>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Retain compact strings/offsets, not page canvases or full text content.
  const index = useMemo(() => pdfDocument && cache ? new PdfSearchIndex(pdfDocument, cache) : null, [pdfDocument, cache]);
  const [result, setResult] = useState<{ index: PdfSearchIndex; pages?: PdfSearchPage[]; error?: string } | null>(null);
  const enabled = open && Boolean(query.trim());
  const ready = result?.index === index && Boolean(result?.pages);
  const searchError = result?.index === index ? result?.error : undefined;
  const matches = useMemo(() => enabled && ready && result?.pages ? findPdfMatches(result.pages, query) : [], [enabled, ready, result, query]);
  const activeMatch = matches.length ? matches[activeIndex % matches.length] : undefined;
  const matchesByPage = useMemo(() => {
    const grouped = new Map<number, typeof matches>();
    for (const match of matches) {
      const pageMatches = grouped.get(match.pageNumber) ?? [];
      pageMatches.push(match);
      grouped.set(match.pageNumber, pageMatches);
    }
    return grouped;
  }, [matches]);

  useEffect(() => {
    if (!enabled || !index || ready) return;
    const controller = new AbortController();
    void index.read(controller.signal).then((pages) => {
      if (!controller.signal.aborted) setResult({ index, pages });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ index, error: "Could not search PDF." });
    });
    return () => controller.abort();
  }, [enabled, index, ready]);

  function openFind() {
    const selection = window.getSelection();
    const selected = selection?.anchorNode && viewerRef.current?.contains(selection.anchorNode) ? selection.toString() : "";
    if (selected && !selected.includes("\n")) {
      setQuery(selected);
      setActiveIndex(0);
    }
    setOpen(true);
    // Also refocus/select when the bar is already open.
    inputRef.current?.focus();
    inputRef.current?.select();
  }

  useEffect(() => {
    if (open) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [open]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const viewer = viewerRef.current;
      if (event.defaultPrevented || !viewer || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "f") return;
      if (event.target instanceof Node && !viewer.contains(event.target) && event.target !== document.body) return;
      event.preventDefault();
      openFind();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function closeFind() {
    setOpen(false);
    viewerRef.current?.focus({ preventScroll: true });
  }
  function navigate(direction: number) {
    if (matches.length) setActiveIndex((index) => (index + direction + matches.length) % matches.length);
  }
  const buttonClass = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";

  return {
    openFind, activeMatch, matchesByPage,
    bar: open ? (
      <div role="search" aria-label="Search PDF" className="flex flex-wrap items-center justify-end gap-1 border-b border-input bg-card px-4 py-2"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(); }
        }}>
        <Search aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input ref={inputRef} aria-label="Find in PDF" placeholder="Find in PDF" value={query}
          className="h-8 min-w-24 flex-1 border-0 bg-transparent px-1 text-sm outline-none"
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); }
          }} />
        <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {enabled && searchError ? searchError : enabled && !ready ? "Searching…" : `${activeMatch ? activeIndex % matches.length + 1 : 0}/${matches.length}`}
        </span>
        <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" className={buttonClass} disabled={!matches.length} onClick={() => navigate(-1)}><ChevronUp aria-hidden className="h-4 w-4" /></button>
        <button type="button" aria-label="Next match" title="Next match (Enter)" className={buttonClass} disabled={!matches.length} onClick={() => navigate(1)}><ChevronDown aria-hidden className="h-4 w-4" /></button>
        <button type="button" aria-label="Close find" title="Close (Escape)" className={buttonClass} onClick={closeFind}><X aria-hidden className="h-4 w-4" /></button>
      </div>
    ) : null,
  };
}
