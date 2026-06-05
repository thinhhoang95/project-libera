"use client";

import {
  FileText,
  GripVertical,
  Highlighter,
  StickyNote,
  Trash2,
} from "lucide-react";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { MarkdownSlidesOutlinePreview } from "@/components/libera/markdown-slides-outline-preview";
import {
  PDF_ANNOTATIONS_UPDATED_EVENT,
  type PdfAnnotationsUpdatedDetail,
} from "@/components/libera/pdf-annotation-events";
import type { OpenTab } from "@/components/libera/types";
import { isMarkdownSlidesPath } from "@/lib/markdown-slides";
import { scrollTextareaToOffset } from "@/lib/textarea-position";
import type { LiberaFileNode, PdfAnnotation, PdfAnnotationsPayload } from "@/lib/types";

type OutlinePanelProps = {
  activeTab?: OpenTab;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onOpenFile: (
    file: LiberaFileNode,
    options?: { viewState?: OpenTab["viewState"] },
  ) => Promise<void>;
  onSetDraft: (value: string) => void;
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

type MarkdownSectionDropPlacement = "after" | "before";

type MarkdownSectionMoveResult = {
  nextLine: number;
  nextMarkdown: string;
  nextOffset: number;
};

type MarkdownOutlineDropTarget = {
  headingId: string;
  placement: MarkdownSectionDropPlacement;
};

type MarkdownOutlineContextMenuState = {
  headingId: string;
  x: number;
  y: number;
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

function getMarkdownHeadingSectionEnd(
  markdown: string,
  headings: MarkdownHeading[],
  headingIndex: number,
) {
  const heading = headings[headingIndex];

  if (!heading) {
    return markdown.length;
  }

  const nextSection = headings
    .slice(headingIndex + 1)
    .find((candidate) => candidate.level <= heading.level);

  return nextSection?.offset ?? markdown.length;
}

function lineForOffset(value: string, offset: number) {
  return value.slice(0, Math.max(0, Math.min(offset, value.length))).split("\n")
    .length;
}

function getActiveMarkdownHeadingId(
  headings: MarkdownHeading[],
  activeLine: number | undefined,
) {
  if (activeLine === undefined) {
    return null;
  }

  let activeHeadingId: string | null = null;

  for (const heading of headings) {
    if (heading.line > activeLine) {
      break;
    }

    activeHeadingId = heading.id;
  }

  return activeHeadingId;
}

function insertMarkdownSection(
  markdown: string,
  insertionOffset: number,
  section: string,
) {
  const before = markdown.slice(0, insertionOffset);
  const after = markdown.slice(insertionOffset);
  const prefix = before && !before.endsWith("\n") ? "\n" : "";
  const suffix = after && !section.endsWith("\n") ? "\n" : "";
  const nextOffset = before.length + prefix.length;

  return {
    nextMarkdown: `${before}${prefix}${section}${suffix}${after}`,
    nextOffset,
  };
}

function moveMarkdownHeadingSection(
  markdown: string,
  headings: MarkdownHeading[],
  sourceHeadingId: string,
  targetHeadingId: string,
  placement: MarkdownSectionDropPlacement,
): MarkdownSectionMoveResult | null {
  const sourceIndex = headings.findIndex((heading) => heading.id === sourceHeadingId);
  const targetIndex = headings.findIndex((heading) => heading.id === targetHeadingId);

  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return null;
  }

  const sourceHeading = headings[sourceIndex];
  const targetHeading = headings[targetIndex];
  const sourceStart = sourceHeading.offset;
  const sourceEnd = getMarkdownHeadingSectionEnd(markdown, headings, sourceIndex);
  const targetSectionEnd = getMarkdownHeadingSectionEnd(markdown, headings, targetIndex);

  if (
    targetHeading.offset >= sourceStart &&
    targetHeading.offset < sourceEnd
  ) {
    return null;
  }

  const sourceSection = markdown.slice(sourceStart, sourceEnd);
  const markdownWithoutSource = `${markdown.slice(0, sourceStart)}${markdown.slice(
    sourceEnd,
  )}`;
  const targetInsertionOffset =
    placement === "before" ? targetHeading.offset : targetSectionEnd;
  const insertionOffset =
    targetInsertionOffset > sourceStart
      ? targetInsertionOffset - sourceSection.length
      : targetInsertionOffset;
  const insertion = insertMarkdownSection(
    markdownWithoutSource,
    insertionOffset,
    sourceSection,
  );

  if (insertion.nextMarkdown === markdown) {
    return null;
  }

  return {
    ...insertion,
    nextLine: lineForOffset(insertion.nextMarkdown, insertion.nextOffset),
  };
}

function deleteMarkdownHeadingSection(
  markdown: string,
  headings: MarkdownHeading[],
  headingId: string,
): MarkdownSectionMoveResult | null {
  const headingIndex = headings.findIndex((heading) => heading.id === headingId);

  if (headingIndex < 0) {
    return null;
  }

  const heading = headings[headingIndex];
  const sectionEnd = getMarkdownHeadingSectionEnd(markdown, headings, headingIndex);
  const nextMarkdown = `${markdown.slice(0, heading.offset)}${markdown.slice(
    sectionEnd,
  )}`;
  const nextOffset = Math.min(heading.offset, nextMarkdown.length);

  if (nextMarkdown === markdown) {
    return null;
  }

  return {
    nextLine: lineForOffset(nextMarkdown, nextOffset),
    nextMarkdown,
    nextOffset,
  };
}

function canMoveMarkdownHeadingSection(
  markdown: string,
  headings: MarkdownHeading[],
  sourceHeadingId: string,
  targetHeadingId: string,
) {
  const sourceIndex = headings.findIndex((heading) => heading.id === sourceHeadingId);
  const targetIndex = headings.findIndex((heading) => heading.id === targetHeadingId);

  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return false;
  }

  const sourceHeading = headings[sourceIndex];
  const targetHeading = headings[targetIndex];
  const sourceEnd = getMarkdownHeadingSectionEnd(markdown, headings, sourceIndex);

  return !(
    targetHeading.offset >= sourceHeading.offset &&
    targetHeading.offset < sourceEnd
  );
}

function getDropPlacement(event: DragEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();

  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function restoreMarkdownTextareaToSection(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  offset: number,
) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;

      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(offset, offset);
      scrollTextareaToOffset(textarea, offset, { block: "start" });
    });
  });
}

function useMarkdownOutline(activeTab?: OpenTab) {
  const hasActiveTab = Boolean(activeTab);
  const tabId = activeTab?.id ?? "";
  const draft = activeTab?.draft ?? "";
  const updateSequenceRef = useRef(0);
  const [outlineState, setOutlineState] = useState<MarkdownOutlineState>(() => ({
    draft,
    headings: activeTab ? parseMarkdownHeadings(draft) : [],
    tabId,
  }));

  useEffect(() => {
    updateSequenceRef.current += 1;
    const updateSequence = updateSequenceRef.current;

    if (!hasActiveTab) {
      const timeout = window.setTimeout(() => {
        startTransition(() => {
          setOutlineState((current) =>
            updateSequenceRef.current !== updateSequence ||
            (current.tabId === "" &&
              current.draft === "" &&
              current.headings.length === 0)
              ? current
              : { draft: "", headings: [], tabId: "" },
          );
        });
      }, 0);

      return () => window.clearTimeout(timeout);
    }

    if (outlineState.tabId === tabId && outlineState.draft === draft) {
      return;
    }

    const parseDelay =
      outlineState.tabId === tabId ? MARKDOWN_OUTLINE_PARSE_DELAY_MS : 0;
    const timeout = window.setTimeout(() => {
      startTransition(() => {
        setOutlineState((current) => {
          if (
            updateSequenceRef.current !== updateSequence ||
            (current.tabId === tabId && current.draft === draft)
          ) {
            return current;
          }

          return {
            draft,
            headings: parseMarkdownHeadings(draft),
            tabId,
          };
        });
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

  return outlineState.tabId === tabId
    ? outlineState
    : { draft: "", headings: [], tabId: "" };
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
  onSetDraft,
}: OutlinePanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-[52px] items-center justify-between border-b border-border px-4 py-2 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Outlines
        </h2>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3">
        {activeTab?.file.fileType === "markdown" &&
        isMarkdownSlidesPath(activeTab.file.path) ? (
          <MarkdownSlidesOutlinePreview
            activeTab={activeTab}
            textareaRef={textareaRef}
            onOpenFile={onOpenFile}
          />
        ) : activeTab?.file.fileType === "markdown" ? (
          <MarkdownOutline
            activeTab={activeTab}
            textareaRef={textareaRef}
            onOpenFile={onOpenFile}
            onSetDraft={onSetDraft}
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
  onSetDraft,
}: {
  activeTab?: OpenTab;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onOpenFile: (
    file: LiberaFileNode,
    options?: { viewState?: OpenTab["viewState"] },
  ) => Promise<void>;
  onSetDraft: (value: string) => void;
}) {
  const outlineState = useMarkdownOutline(activeTab);
  const headings = outlineState.headings;
  const outlineIsCurrent = outlineState.draft === (activeTab?.draft ?? "");
  const activeMarkdownLine =
    activeTab?.viewState?.markdown?.line ??
    (typeof activeTab?.viewState?.markdown?.selectionStart === "number"
      ? lineForOffset(activeTab.draft, activeTab.viewState.markdown.selectionStart)
      : undefined);
  const activeHeadingId = outlineIsCurrent
    ? getActiveMarkdownHeadingId(headings, activeMarkdownLine)
    : null;
  const [draggingHeadingId, setDraggingHeadingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<MarkdownOutlineDropTarget | null>(
    null,
  );
  const [contextMenu, setContextMenu] =
    useState<MarkdownOutlineContextMenuState | null>(null);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    function closeContextMenu() {
      setContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    }

    window.addEventListener("pointerdown", closeContextMenu);
    window.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", closeContextMenu);
      window.removeEventListener("scroll", closeContextMenu, true);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

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

  function handleHeadingDragStart(
    event: DragEvent<HTMLButtonElement>,
    heading: MarkdownHeading,
  ) {
    setContextMenu(null);

    if (!outlineIsCurrent) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", heading.id);
    setDraggingHeadingId(heading.id);
    setDropTarget(null);
  }

  function handleHeadingDragOver(
    event: DragEvent<HTMLButtonElement>,
    heading: MarkdownHeading,
  ) {
    const sourceHeadingId = draggingHeadingId ?? event.dataTransfer.getData("text/plain");

    if (
      !outlineIsCurrent ||
      !sourceHeadingId ||
      !canMoveMarkdownHeadingSection(
        outlineState.draft,
        headings,
        sourceHeadingId,
        heading.id,
      )
    ) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const placement = getDropPlacement(event);
    setDropTarget((current) =>
      current?.headingId === heading.id && current.placement === placement
        ? current
        : { headingId: heading.id, placement },
    );
  }

  function handleHeadingDragLeave(
    event: DragEvent<HTMLButtonElement>,
    heading: MarkdownHeading,
  ) {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }

    setDropTarget((current) =>
      current?.headingId === heading.id ? null : current,
    );
  }

  function handleHeadingDrop(
    event: DragEvent<HTMLButtonElement>,
    heading: MarkdownHeading,
  ) {
    event.preventDefault();

    const sourceHeadingId = draggingHeadingId ?? event.dataTransfer.getData("text/plain");
    const placement = dropTarget?.headingId === heading.id
      ? dropTarget.placement
      : getDropPlacement(event);

    setDraggingHeadingId(null);
    setDropTarget(null);

    if (!activeTab || !outlineIsCurrent || !sourceHeadingId) {
      return;
    }

    const moveResult = moveMarkdownHeadingSection(
      outlineState.draft,
      headings,
      sourceHeadingId,
      heading.id,
      placement,
    );

    if (!moveResult) {
      return;
    }

    onSetDraft(moveResult.nextMarkdown);

    void onOpenFile(activeTab.file, {
      viewState: {
        markdown: {
          line: moveResult.nextLine,
          selectionEnd: moveResult.nextOffset,
          selectionStart: moveResult.nextOffset,
        },
      },
    });
    restoreMarkdownTextareaToSection(textareaRef, moveResult.nextOffset);
  }

  function handleHeadingDragEnd() {
    setDraggingHeadingId(null);
    setDropTarget(null);
  }

  function openHeadingContextMenu(
    event: ReactMouseEvent<HTMLButtonElement>,
    heading: MarkdownHeading,
  ) {
    if (!outlineIsCurrent) {
      return;
    }

    event.preventDefault();
    const menuWidth = 192;
    const menuHeight = 44;

    setContextMenu({
      headingId: heading.id,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  }

  function deleteHeadingSection(headingId: string) {
    if (!activeTab || !outlineIsCurrent) {
      setContextMenu(null);
      return;
    }

    const deleteResult = deleteMarkdownHeadingSection(
      outlineState.draft,
      headings,
      headingId,
    );

    setContextMenu(null);

    if (!deleteResult) {
      return;
    }

    onSetDraft(deleteResult.nextMarkdown);

    void onOpenFile(activeTab.file, {
      viewState: {
        markdown: {
          line: deleteResult.nextLine,
          selectionEnd: deleteResult.nextOffset,
          selectionStart: deleteResult.nextOffset,
        },
      },
    });
    restoreMarkdownTextareaToSection(textareaRef, deleteResult.nextOffset);
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
          {headings.map((heading) => {
            const activeDropPlacement =
              dropTarget?.headingId === heading.id ? dropTarget.placement : null;
            const isDragging = draggingHeadingId === heading.id;
            const isActive = activeHeadingId === heading.id;

            return (
              <button
                key={heading.id}
                className={`relative flex w-full items-center gap-2 rounded border border-transparent px-2 py-1.5 text-left text-sm hover:bg-muted ${
                  outlineIsCurrent ? "cursor-grab active:cursor-grabbing" : ""
                } ${
                  isDragging ? "opacity-45" : ""
                }`}
                style={{
                  paddingLeft: `${8 + (heading.level - 1) * 12}px`,
                  ...(isActive
                    ? {
                        backgroundColor:
                          "color-mix(in srgb, var(--accent) 12%, transparent)",
                        borderColor:
                          "color-mix(in srgb, var(--accent) 46%, transparent)",
                      }
                    : undefined),
                }}
                aria-current={isActive ? "location" : undefined}
                title={heading.text}
                type="button"
                draggable={outlineIsCurrent}
                onClick={() => void navigateToHeading(heading)}
                onDragEnd={handleHeadingDragEnd}
                onDragLeave={(event) => handleHeadingDragLeave(event, heading)}
                onDragOver={(event) => handleHeadingDragOver(event, heading)}
                onDragStart={(event) => handleHeadingDragStart(event, heading)}
                onDrop={(event) => handleHeadingDrop(event, heading)}
                onContextMenu={(event) => openHeadingContextMenu(event, heading)}
              >
                {activeDropPlacement === "before" ? (
                  <span className="pointer-events-none absolute left-2 right-2 top-0 h-0.5 rounded-full bg-accent" />
                ) : null}
                {activeDropPlacement === "after" ? (
                  <span className="pointer-events-none absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-accent" />
                ) : null}
                <GripVertical
                  aria-hidden
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                />
                <span className="w-8 shrink-0 rounded bg-muted px-1.5 py-0.5 text-center text-[10px] font-semibold text-muted-foreground">
                  H{heading.level}
                </span>
                <span className="min-w-0 flex-1 truncate">{heading.text}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {heading.line}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
          No headings in this Markdown file.
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
            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-medium text-destructive hover:bg-destructive-muted"
            type="button"
            role="menuitem"
            onClick={() => deleteHeadingSection(contextMenu.headingId)}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
            Delete Section
          </button>
        </div>
      ) : null}
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
