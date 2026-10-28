"use client";

import {
  Circle,
  Highlighter,
  Minus,
  MoveUpRight,
  PenLine,
  Quote,
  Search,
  Square,
  StickyNote,
  Strikethrough,
  Underline,
  UnfoldVertical,
  Waves,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { SidebarNameTooltipButton } from "@/components/libera/sidebar-name-tooltip";
import {
  PDF_ANNOTATIONS_UPDATED_EVENT,
  type PdfAnnotationsUpdatedDetail,
} from "@/components/libera/pdf-annotation-events";
import type { OpenTab } from "@/components/libera/types";
import { normalizePdfHighlightQuote } from "@/lib/pdf-highlight-quote";
import { PDF_QUOTE_CITE_EVENT, type PdfQuoteCiteDetail } from "@/lib/references/pdf-quote";
import type { LiberaFileNode, PdfAnnotation, PdfAnnotationsPayload, PdfHighlightAnnotation } from "@/lib/types";

const MARKUP_LABELS = {
  underline: "Underline",
  strikethrough: "Strikethrough",
  squiggly: "Squiggly underline",
} as const;

const SHAPE_LABELS = {
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  arrow: "Arrow",
} as const;

function annotationLabel(annotation: PdfAnnotation) {
  if (annotation.type === "text") {
    return annotation.text.trim() || "Text annotation";
  }

  if (annotation.type === "shape") {
    return SHAPE_LABELS[annotation.shape];
  }

  if (annotation.type === "ink") {
    return "Pen drawing";
  }

  if (annotation.type === "space") {
    return "Space";
  }

  const quote = annotation.quote ? normalizePdfHighlightQuote(annotation.quote) : "";

  if (quote) {
    return quote;
  }

  return annotation.markup ? MARKUP_LABELS[annotation.markup] : "Highlight";
}

function annotationIcon(annotation: PdfAnnotation) {
  const className = "h-4 w-4 shrink-0 text-muted-foreground";

  if (annotation.type === "text") {
    return <StickyNote aria-hidden className={className} />;
  }

  if (annotation.type === "ink") {
    return <PenLine aria-hidden className={className} />;
  }

  if (annotation.type === "space") {
    return <UnfoldVertical aria-hidden className={className} />;
  }

  if (annotation.type === "shape") {
    const Icon = { rectangle: Square, ellipse: Circle, line: Minus, arrow: MoveUpRight }[annotation.shape];

    return <Icon aria-hidden className={className} />;
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
 * The PDF's annotations — highlights, notes, shapes and drawings — in page
 * order, searchable: the contextual rail tab a PDF tab brings (page-tabs.ts).
 * Click one to show it; right-click a highlight to quote and cite it.
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
      // Spaces are page layout, not annotations to list; what is in them is listed.
      annotations.filter((annotation) => annotation.type !== "space").sort(
        (left, right) =>
          left.pageNumber - right.pageNumber ||
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      ),
    [annotations],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const filteredAnnotations = useMemo(
    () => sortedAnnotations.filter((annotation) =>
      annotationLabel(annotation).toLowerCase().includes(normalizedQuery) ||
      `p. ${annotation.pageNumber}`.includes(normalizedQuery),
    ),
    [sortedAnnotations, normalizedQuery],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-[52px] items-center justify-between gap-2 px-3 py-3">
        <h2 className="text-sm font-semibold text-foreground">Annotations</h2>
        {sortedAnnotations.length ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{sortedAnnotations.length}</span>
        ) : null}
      </div>
      <section className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <div className="relative mb-3">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            aria-label="Search PDF annotations"
            className="libera-sidebar-search-input h-10 w-full rounded-xl border border-input bg-card px-9 text-sm outline-none transition focus:border-ring"
            placeholder="Search annotations"
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
              className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              type="button"
              onClick={() => setQuery("")}
              onMouseDown={(event) => event.preventDefault()}
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold text-muted-foreground">
          <Highlighter aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate" title={activeTab?.file.path}>{activeTab?.file.name ?? "Annotations"}</span>
        </div>
        {!activeTab ? (
          <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
            Open a PDF to see annotations.
          </p>
        ) : loading ? (
          <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
            Loading annotations.
          </p>
        ) : error ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive-muted px-3 py-4 text-sm text-destructive">
            {error}
          </p>
        ) : filteredAnnotations.length ? (
          <div className="space-y-1">
            {filteredAnnotations.map((annotation) => {
              const label = annotationLabel(annotation);

              return (
                <SidebarNameTooltipButton
                  key={annotation.id}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                  fullName={label}
                  type="button"
                  onClick={() => void navigateToAnnotation(annotation)}
                  onContextMenu={(event) => openAnnotationContextMenu(event, annotation)}
                >
                  {annotationIcon(annotation)}
                  <span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">{label}</span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    p. {annotation.pageNumber}
                  </span>
                </SidebarNameTooltipButton>
              );
            })}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
            {sortedAnnotations.length ? "No matching annotations." : "No annotations in this PDF."}
          </p>
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
      </section>
    </div>
  );
}
