"use client";

import { FileText, Highlighter, StickyNote } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { apiRequest } from "@/components/libera/api-client";
import {
  PDF_ANNOTATIONS_UPDATED_EVENT,
  type PdfAnnotationsUpdatedDetail,
} from "@/components/libera/pdf-annotation-events";
import type { OpenTab } from "@/components/libera/types";
import { scrollTextareaToOffset } from "@/lib/textarea-position";
import type { LiberaFileNode, PdfAnnotation, PdfAnnotationsPayload } from "@/lib/types";

type OutlinePanelProps = {
  activeTab?: OpenTab;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onOpenFile: (
    file: LiberaFileNode,
    options?: { viewState?: OpenTab["viewState"] },
  ) => Promise<void>;
};

type MarkdownHeading = {
  id: string;
  level: number;
  line: number;
  offset: number;
  text: string;
};

const MARKDOWN_OUTLINE_PARSE_DELAY_MS = 250;

type MarkdownOutlineState = {
  draft: string;
  headings: MarkdownHeading[];
  tabId: string;
};

function stripInlineMarkdown(value: string) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim();
}

function parseMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = markdown.split("\n");
  let offset = 0;
  let fence: string | null = null;

  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? null;

      if (!fence) {
        fence = marker;
      } else if (marker === fence) {
        fence = null;
      }
    }

    if (!fence) {
      const headingMatch = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      const text = stripInlineMarkdown(headingMatch?.[2] ?? "");

      if (headingMatch && text) {
        headings.push({
          id: `${index + 1}:${offset}`,
          level: headingMatch[1]?.length ?? 1,
          line: index + 1,
          offset,
          text,
        });
      }
    }

    offset += line.length + 1;
  });

  return headings;
}

function useMarkdownOutlineHeadings(activeTab?: OpenTab) {
  const hasActiveTab = Boolean(activeTab);
  const tabId = activeTab?.id ?? "";
  const draft = activeTab?.draft ?? "";
  const [outlineState, setOutlineState] = useState<MarkdownOutlineState>(() => ({
    draft,
    headings: activeTab ? parseMarkdownHeadings(draft) : [],
    tabId,
  }));

  useEffect(() => {
    if (!hasActiveTab) {
      const timeout = window.setTimeout(() => {
        setOutlineState((current) =>
          current.tabId === "" &&
          current.draft === "" &&
          current.headings.length === 0
            ? current
            : { draft: "", headings: [], tabId: "" },
        );
      }, 0);

      return () => window.clearTimeout(timeout);
    }

    if (outlineState.tabId === tabId && outlineState.draft === draft) {
      return;
    }

    const parseDelay =
      outlineState.tabId === tabId ? MARKDOWN_OUTLINE_PARSE_DELAY_MS : 0;
    const timeout = window.setTimeout(() => {
      setOutlineState({
        draft,
        headings: parseMarkdownHeadings(draft),
        tabId,
      });
    }, parseDelay);

    return () => window.clearTimeout(timeout);
  }, [
    draft,
    hasActiveTab,
    outlineState.draft,
    outlineState.tabId,
    tabId,
  ]);

  return outlineState.tabId === tabId ? outlineState.headings : [];
}

function annotationLabel(annotation: PdfAnnotation) {
  if (annotation.type === "text") {
    return annotation.text.trim() || "Text annotation";
  }

  return annotation.rects.length > 1
    ? `Highlight (${annotation.rects.length} areas)`
    : "Highlight";
}

function annotationIcon(annotation: PdfAnnotation) {
  if (annotation.type === "text") {
    return <StickyNote aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }

  return <Highlighter aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function scrollPdfAnnotationIntoView(annotation: PdfAnnotation) {
  window.requestAnimationFrame(() => {
    const escapedAnnotationId = CSS.escape(annotation.id);
    const annotationElement = document.querySelector<HTMLElement>(
      `[data-pdf-annotation-id="${escapedAnnotationId}"]`,
    );

    if (annotationElement) {
      annotationElement.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }

    document
      .querySelector<HTMLElement>(`[data-pdf-page-number="${annotation.pageNumber}"]`)
      ?.scrollIntoView({ block: "start", inline: "nearest" });
  });
}

export function OutlinePanel({
  activeTab,
  textareaRef,
  onOpenFile,
}: OutlinePanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-[52px] items-center justify-between border-b border-border px-4 py-2 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Outlines
        </h2>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3">
        {activeTab?.file.fileType === "markdown" ? (
          <MarkdownOutline
            activeTab={activeTab}
            textareaRef={textareaRef}
            onOpenFile={onOpenFile}
          />
        ) : activeTab?.file.fileType === "pdf" ? (
          <PdfOutline activeTab={activeTab} onOpenFile={onOpenFile} />
        ) : (
          <EmptyOutline />
        )}
      </div>
    </div>
  );
}

function EmptyOutline() {
  return (
    <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
      Open a Markdown or PDF file to see its outline.
    </p>
  );
}

function MarkdownOutline({
  activeTab,
  textareaRef,
  onOpenFile,
}: {
  activeTab?: OpenTab;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onOpenFile: (
    file: LiberaFileNode,
    options?: { viewState?: OpenTab["viewState"] },
  ) => Promise<void>;
}) {
  const headings = useMarkdownOutlineHeadings(activeTab);

  async function navigateToHeading(heading: MarkdownHeading) {
    if (!activeTab) {
      return;
    }

    await onOpenFile(activeTab.file, {
      viewState: {
        markdown: {
          line: heading.line,
          selectionEnd: heading.offset,
          selectionStart: heading.offset,
        },
      },
    });

    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;

      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(heading.offset, heading.offset);
      scrollTextareaToOffset(textarea, heading.offset, { block: "start" });
    });
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <FileText aria-hidden className="h-3.5 w-3.5" />
        Markdown Outlines
      </div>
      {!activeTab ? (
        <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
          Open a Markdown file to see headings.
        </p>
      ) : headings.length ? (
        <div className="space-y-1">
          {headings.map((heading) => (
            <button
              key={heading.id}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              style={{ paddingLeft: `${8 + (heading.level - 1) * 12}px` }}
              title={heading.text}
              type="button"
              onClick={() => void navigateToHeading(heading)}
            >
              <span className="w-8 shrink-0 rounded bg-muted px-1.5 py-0.5 text-center text-[10px] font-semibold text-muted-foreground">
                H{heading.level}
              </span>
              <span className="min-w-0 flex-1 truncate">{heading.text}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {heading.line}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
          No headings in this Markdown file.
        </p>
      )}
    </section>
  );
}

function PdfOutline({
  activeTab,
  onOpenFile,
}: {
  activeTab?: OpenTab;
  onOpenFile: (
    file: LiberaFileNode,
    options?: { viewState?: OpenTab["viewState"] },
  ) => Promise<void>;
}) {
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
      [...annotations].sort(
        (left, right) =>
          left.pageNumber - right.pageNumber ||
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      ),
    [annotations],
  );

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Highlighter aria-hidden className="h-3.5 w-3.5" />
        PDF Outlines
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
      ) : sortedAnnotations.length ? (
        <div className="space-y-1">
          {sortedAnnotations.map((annotation) => {
            const label = annotationLabel(annotation);

            return (
              <button
                key={annotation.id}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                title={label}
                type="button"
                onClick={() => void navigateToAnnotation(annotation)}
              >
                {annotationIcon(annotation)}
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  p. {annotation.pageNumber}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
          No annotations in this PDF.
        </p>
      )}
    </section>
  );
}
