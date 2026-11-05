"use client";

import {
  Highlighter,
  Quote,
  Search,
  StickyNote,
  Strikethrough,
  Underline,
  Waves,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { apiRequest } from "@/components/libera/api-client";
import {
  PDF_ANNOTATIONS_UPDATED_EVENT,
  type PdfAnnotationsUpdatedDetail,
} from "@/components/libera/pdf-annotation-events";
import type { OpenTab } from "@/components/libera/types";
import { plainTextOfMarkdown } from "@/lib/markdown-selection-links";
import { normalizePdfHighlightQuote } from "@/lib/pdf-highlight-quote";
import { PDF_QUOTE_CITE_EVENT, type PdfQuoteCiteDetail } from "@/lib/references/pdf-quote";
import type {
  LiberaFileNode,
  PdfAnnotation,
  PdfAnnotationsPayload,
  PdfHighlightAnnotation,
  PdfTextAnnotation,
} from "@/lib/types";

const MARKUP_LABELS = {
  underline: "Underline",
  strikethrough: "Strikethrough",
  squiggly: "Squiggly underline",
} as const;

/** The annotations the panel lists: the ones that carry words. */
type ListedAnnotation = PdfHighlightAnnotation | PdfTextAnnotation;

function isListedAnnotation(annotation: PdfAnnotation): annotation is ListedAnnotation {
  return annotation.type === "highlight" || annotation.type === "text";
}

/** What the annotation is: the card's title. */
function annotationKind(annotation: ListedAnnotation) {
  if (annotation.type === "text") {
    return "Note";
  }

  return annotation.markup ? MARKUP_LABELS[annotation.markup] : "Highlight";
}

/** The annotation's words, if any; the card clamps them to an excerpt. */
function annotationExcerpt(annotation: ListedAnnotation) {
  if (annotation.type === "text") {
    return plainTextOfMarkdown(annotation.text);
  }

  return annotation.quote ? normalizePdfHighlightQuote(annotation.quote) : "";
}

function annotationIcon(annotation: ListedAnnotation) {
  const className = "h-3.5 w-3.5 shrink-0";

  if (annotation.type === "text") {
    return <StickyNote aria-hidden className={className} />;
  }

  const Icon = annotation.markup
    ? { underline: Underline, strikethrough: Strikethrough, squiggly: Waves }[annotation.markup]
    : Highlighter;

  return <Icon aria-hidden className={className} />;
}

function scrollPdfAnnotationIntoView(annotation: PdfAnnotation) {
  window.requestAnimationFrame(() => {
    const escapedAnnotationId = CSS.escape(annotation.id);
    // With a split canvas several PDFs can be on screen; prefer the focused pane.
    const root = document.querySelector<HTMLElement>('[data-canvas-pane-focused="true"]') ?? document;
    const annotationElement = root.querySelector<HTMLElement>(
      `[data-pdf-annotation-id="${escapedAnnotationId}"]`,
    );

    if (annotationElement) {
      annotationElement.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }

    root
      .querySelector<HTMLElement>(`[data-pdf-page-number="${annotation.pageNumber}"]`)
      ?.scrollIntoView({ block: "start", inline: "nearest" });
  });
}

/**
 * The PDF's highlights and notes in page order, searchable (shapes and pen
 * strokes are not listed): the contextual rail tab a PDF tab brings (page-tabs.ts).
 * Each card shows an excerpt, in the look of a review comment. Click one to
 * show it; right-click a highlight to quote and cite it.
 */
export function PdfAnnotationsPanel({
  activeTab,
  onOpenFile,
}: {
  activeTab?: OpenTab;
  onOpenFile: (
    file: LiberaFileNode,
    options?: { viewState?: OpenTab["viewState"] },
  ) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [outlineState, setOutlineState] = useState<{
    annotations: PdfAnnotation[];
    error: string;
    path: string;
  }>({
    annotations: [],
    error: "",
    path: "",
  });
  const filePath = activeTab?.file.path ?? "";
  const annotations = useMemo(
    () => (outlineState.path === filePath ? outlineState.annotations : []),
    [filePath, outlineState.annotations, outlineState.path],
  );
  const error = outlineState.path === filePath ? outlineState.error : "";
  const loading = Boolean(activeTab) && outlineState.path !== filePath;
  const selectedAnnotationId = activeTab?.viewState?.pdf?.selectedAnnotationId;
  // A highlight's context menu: Quote and cite.
  const [contextMenu, setContextMenu] = useState<{ annotation: PdfHighlightAnnotation; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  function openAnnotationContextMenu(event: ReactMouseEvent<HTMLButtonElement>, annotation: PdfAnnotation) {
    if (annotation.type !== "highlight" || !annotation.quote?.trim()) return;
    event.preventDefault();
    const menuWidth = 192;
    const menuHeight = 44;
    setContextMenu({
      annotation,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  }

  function quoteHighlight(annotation: PdfHighlightAnnotation) {
    setContextMenu(null);
    const quote = normalizePdfHighlightQuote(annotation.quote ?? "");
    if (!quote || !filePath) return;
    window.dispatchEvent(new CustomEvent<PdfQuoteCiteDetail>(PDF_QUOTE_CITE_EVENT, {
      detail: { quote, path: filePath, page: annotation.pageNumber },
    }));
  }

  useEffect(() => {
    if (!filePath) {
      return;
    }

    const abortController = new AbortController();
    const path = filePath;

    apiRequest<PdfAnnotationsPayload>(
      `/api/pdf-annotations?path=${encodeURIComponent(path)}`,
      { signal: abortController.signal },
    )
      .then((payload) =>
        setOutlineState({
          annotations: payload.annotations,
          error: "",
          path,
        }),
      )
      .catch((fetchError) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          return;
        }

        setOutlineState({
          annotations: [],
          error:
            fetchError instanceof Error
              ? fetchError.message
              : "Could not load PDF annotations.",
          path,
        });
      });

    return () => abortController.abort();
  }, [filePath]);

  useEffect(() => {
    function handleAnnotationsUpdated(event: Event) {
      const detail = (event as CustomEvent<PdfAnnotationsUpdatedDetail>).detail;

      if (detail.path === filePath) {
        setOutlineState({
          annotations: detail.annotations,
          error: "",
          path: detail.path,
        });
      }
    }

    window.addEventListener(PDF_ANNOTATIONS_UPDATED_EVENT, handleAnnotationsUpdated);
    return () =>
      window.removeEventListener(PDF_ANNOTATIONS_UPDATED_EVENT, handleAnnotationsUpdated);
  }, [filePath]);

  async function navigateToAnnotation(annotation: PdfAnnotation) {
    if (!activeTab) {
      return;
    }

    await onOpenFile(activeTab.file, {
      viewState: {
        pdf: {
          selectedAnnotationId: annotation.id,
        },
      },
    });
    scrollPdfAnnotationIntoView(annotation);
  }

  const sortedAnnotations = useMemo(
    () =>
      annotations.filter(isListedAnnotation).sort(
        (left, right) =>
          left.pageNumber - right.pageNumber ||
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      ),
    [annotations],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const filteredAnnotations = useMemo(
    () => sortedAnnotations.filter((annotation) =>
      `${annotationKind(annotation)} ${annotationExcerpt(annotation)}`.toLowerCase().includes(normalizedQuery) ||
      `p. ${annotation.pageNumber}`.includes(normalizedQuery),
    ),
    [sortedAnnotations, normalizedQuery],
  );

  const emptyNote = "rounded-lg border border-dashed border-input px-4 py-8 text-center text-sm text-muted-foreground";

  return (
    <section className="review-comments flex min-h-0 flex-1 flex-col" aria-label="PDF annotations">
      <header className="shrink-0 space-y-3 px-3 pb-3 pt-4">
        <div className="libera-notebook-heading flex items-center gap-1">
          <h2 className="min-w-0 flex-1 text-sm font-semibold">Annotations</h2>
          {sortedAnnotations.length ? (
            <span className="mr-1 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{sortedAnnotations.length}</span>
          ) : null}
        </div>
        {sortedAnnotations.length ? (
          <div className="review-comment-search relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              aria-label="Search PDF annotations"
              className="libera-rail-field libera-rail-field--search w-full"
              placeholder="Search annotations"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  setQuery("");
                } else if (event.key === "Enter" && filteredAnnotations[0]) {
                  event.preventDefault();
                  void navigateToAnnotation(filteredAnnotations[0]);
                }
              }}
            />
            {query ? (
              <button
                aria-label="Clear annotation search"
                className="libera-sidebar-icon-button absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md"
                title="Clear search"
                type="button"
                onClick={() => setQuery("")}
                onMouseDown={(event) => event.preventDefault()}
              >
                <X aria-hidden className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {!activeTab ? (
          <p className={emptyNote}>Open a PDF to see annotations.</p>
        ) : loading ? (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">Loading annotations…</p>
        ) : error ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive-muted px-3 py-4 text-sm text-destructive">
            {error}
          </p>
        ) : filteredAnnotations.length ? (
          filteredAnnotations.map((annotation) => {
            const excerpt = annotationExcerpt(annotation);
            
            return (
              <button
                key={annotation.id}
                className="review-comment-card libera-panel-card block w-full p-3 text-left text-[13px] transition focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                data-selected={annotation.id === selectedAnnotationId}
                style={annotation.color ? ({ "--annotation-color": annotation.color } as CSSProperties) : undefined}
                type="button"
                onClick={() => void navigateToAnnotation(annotation)}
                onContextMenu={(event) => openAnnotationContextMenu(event, annotation)}
              >
                <span className="flex items-center gap-2">
                  <span className="pdf-annotation-icon">{annotationIcon(annotation)}</span>
                  <strong className="min-w-0 flex-1 truncate text-xs font-semibold">{annotationKind(annotation)}</strong>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">p. {annotation.pageNumber}</span>
                </span>
                {excerpt ? (
                  <span className="pdf-annotation-excerpt mt-2 line-clamp-3 text-xs leading-relaxed" data-kind={annotation.type}>
                    {excerpt}
                  </span>
                ) : null}
              </button>
            );
          })
        ) : sortedAnnotations.length ? (
          <p className="rounded-lg border border-dashed border-input px-4 py-3 text-sm text-muted-foreground">
            No matching annotations.
          </p>
        ) : (
          <p className={emptyNote}>No highlights or notes in this PDF.</p>
        )}
        {contextMenu ? (
          <div
            className="fixed z-50 w-48 rounded-lg border border-border bg-card p-1 shadow-lg"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium hover:bg-muted"
              type="button"
              role="menuitem"
              onClick={() => quoteHighlight(contextMenu.annotation)}
            >
              <Quote aria-hidden className="h-4 w-4" />
              Quote and cite
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
