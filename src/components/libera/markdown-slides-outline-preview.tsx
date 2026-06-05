"use client";

import { Presentation } from "lucide-react";
import { useMemo } from "react";
import type { RefObject } from "react";
import type { OpenTab } from "@/components/libera/types";
import {
  parseMarkdownSlides,
  type MarkdownSlide,
  type MarkdownSlideDeck,
} from "@/lib/markdown-slides";
import { scrollTextareaToOffset } from "@/lib/textarea-position";
import type { LiberaFileNode } from "@/lib/types";

type MarkdownSlidesOutlinePreviewProps = {
  activeTab: OpenTab;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onOpenFile: (
    file: LiberaFileNode,
    options?: { viewState?: OpenTab["viewState"] },
  ) => Promise<void>;
};

const SLIDE_CONTENT_PREVIEW_MAX_LENGTH = 150;

function lineForOffset(value: string, offset: number) {
  return value.slice(0, Math.max(0, Math.min(offset, value.length))).split("\n")
    .length;
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncatePreview(value: string) {
  const collapsedValue = collapseWhitespace(value);

  if (collapsedValue.length <= SLIDE_CONTENT_PREVIEW_MAX_LENGTH) {
    return collapsedValue;
  }

  return `${collapsedValue
    .slice(0, SLIDE_CONTENT_PREVIEW_MAX_LENGTH - 3)
    .trimEnd()}...`;
}

function markdownToPreviewText(markdown: string) {
  return collapseWhitespace(
    markdown
      .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^ {0,3}#{1,6}\s+/gm, "")
      .replace(/^ {0,3}>\s?/gm, "")
      .replace(/^ {0,3}[-*+]\s+/gm, "")
      .replace(/^ {0,3}\d+\.\s+/gm, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/[|*_~$]/g, " "),
  );
}

function slideTitle(deck: MarkdownSlideDeck, slide: MarkdownSlide) {
  if (slide.title) {
    return slide.title;
  }

  if (slide.kind === "title" && deck.title) {
    return deck.title;
  }

  return slide.kind === "title" ? "Title Slide" : `Slide ${slide.index + 1}`;
}

function titleSlideMetadataPreview(deck: MarkdownSlideDeck) {
  return [deck.subtitle, deck.author.join(", "), deck.affiliation.join(", "), deck.date]
    .filter(Boolean)
    .join(" - ");
}

function slideContentPreview(deck: MarkdownSlideDeck, slide: MarkdownSlide) {
  const markdownPreview = markdownToPreviewText(slide.content);

  if (markdownPreview) {
    return truncatePreview(markdownPreview);
  }

  if (slide.kind === "title") {
    const metadataPreview = titleSlideMetadataPreview(deck);

    if (metadataPreview) {
      return truncatePreview(metadataPreview);
    }
  }

  return "No body content";
}

function activeSlideIndexForTab(deck: MarkdownSlideDeck, activeTab: OpenTab) {
  const selectionStart = activeTab.viewState?.markdown?.selectionStart;

  if (typeof selectionStart === "number") {
    let nearestSlideIndex: number | null = null;

    for (const slide of deck.slides) {
      if (selectionStart < slide.sourceStart) {
        break;
      }

      nearestSlideIndex = slide.index;

      if (selectionStart <= slide.sourceEnd) {
        return slide.index;
      }
    }

    if (nearestSlideIndex !== null) {
      return nearestSlideIndex;
    }
  }

  const savedSlideIndex = activeTab.viewState?.markdown?.slideIndex;

  return typeof savedSlideIndex === "number" ? savedSlideIndex : 0;
}

function restoreTextareaToSlide(
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

function scrollSlidePreviewIntoView(slideIndex: number) {
  window.requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(
        `[data-markdown-slide-preview-index="${slideIndex}"]`,
      )
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

export function MarkdownSlidesOutlinePreview({
  activeTab,
  textareaRef,
  onOpenFile,
}: MarkdownSlidesOutlinePreviewProps) {
  const deck = useMemo(() => parseMarkdownSlides(activeTab.draft), [activeTab.draft]);
  const activeSlideIndex = activeSlideIndexForTab(deck, activeTab);

  async function navigateToSlide(slide: MarkdownSlide) {
    const offset = Math.max(0, Math.min(slide.sourceStart, activeTab.draft.length));

    await onOpenFile(activeTab.file, {
      viewState: {
        markdown: {
          line: lineForOffset(activeTab.draft, offset),
          selectionEnd: offset,
          selectionStart: offset,
          slideIndex: slide.index,
        },
      },
    });

    restoreTextareaToSlide(textareaRef, offset);
    scrollSlidePreviewIntoView(slide.index);
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Presentation aria-hidden className="h-3.5 w-3.5" />
        Slide Outlines
      </div>
      {deck.slides.length ? (
        <div className="space-y-2">
          {deck.slides.map((slide) => {
            const title = slideTitle(deck, slide);
            const preview = slideContentPreview(deck, slide);
            const isActive = activeSlideIndex === slide.index;

            return (
              <button
                key={`${slide.sourceStart}:${slide.sourceEnd}:${slide.index}`}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition hover:border-input hover:bg-muted ${
                  isActive
                    ? "border-accent bg-accent/10"
                    : "border-border bg-card"
                }`}
                aria-current={isActive ? "location" : undefined}
                title={`${slide.index + 1}. ${title}`}
                type="button"
                onClick={() => void navigateToSlide(slide)}
              >
                <span className="mb-1.5 flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                    {title}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    Slide {slide.index + 1}
                  </span>
                </span>
                <span className="line-clamp-3 block text-xs leading-5 text-muted-foreground">
                  {preview}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
          No slides in this deck.
        </p>
      )}
    </section>
  );
}
