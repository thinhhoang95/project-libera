"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import {
  hasMarkdownSlideTemplate,
  renderMarkdownSlideTemplate,
} from "@/components/libera/markdown-slide-templates";
import type { MarkdownSlide, MarkdownSlideDeck } from "@/lib/markdown-slides";

type MarkdownSlidesViewerProps = {
  deck: MarkdownSlideDeck;
  documentPath?: string;
  onOpenFileLink?: (href: string) => Promise<boolean>;
  textScale?: number;
};

type MarkdownSlidesPreviewProps = MarkdownSlidesViewerProps & {
  activeSlideIndex: number;
};

type MarkdownSlidesPresenterProps = MarkdownSlidesViewerProps & {
  initialSlideIndex: number;
  onExit: () => void;
  onSlideIndexChange: (slideIndex: number) => void;
};

function clampSlideIndex(deck: MarkdownSlideDeck, slideIndex: number) {
  return Math.min(Math.max(0, slideIndex), Math.max(0, deck.slides.length - 1));
}

function slideKey(slide: MarkdownSlide, index: number) {
  return `${slide.sourceStart}:${slide.sourceEnd}:${index}`;
}

function MarkdownSlideContent({
  deck,
  documentPath,
  mode,
  onOpenFileLink,
  slide,
  slideNumber,
  textScale = 1,
}: MarkdownSlidesViewerProps & {
  mode: "presenter" | "preview";
  slide: MarkdownSlide;
  slideNumber: number;
}) {
  const slideFontSize = slide.fontSize ?? deck.fontSize ?? 21;
  const slideTextScale = textScale * (slideFontSize / 16);

  return renderMarkdownSlideTemplate(deck.template, {
    children: slide.content.trim() ? (
      <MarkdownRenderer
        className="[&>*:last-child]:mb-0"
        content={slide.content}
        documentPath={documentPath}
        onOpenFileLink={onOpenFileLink}
        textScale={slideTextScale}
      />
    ) : null,
    deck,
    fontSize: slideFontSize,
    mode,
    slide,
    slideCount: deck.slides.length,
    slideNumber,
  });
}

function MarkdownSlidesDiagnostics({ deck }: { deck: MarkdownSlideDeck }) {
  const unknownTemplate =
    deck.template && !hasMarkdownSlideTemplate(deck.template)
      ? `Unknown slide template "${deck.template}"; using default.`
      : "";
  const messages = [
    unknownTemplate,
    ...deck.diagnostics.map((diagnostic) =>
      diagnostic.line
        ? `Line ${diagnostic.line}: ${diagnostic.message}`
        : diagnostic.message,
    ),
  ].filter(Boolean);

  if (!messages.length) {
    return null;
  }

  return (
    <div className="w-full max-w-5xl rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-medium">Slide deck warnings</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

export function MarkdownSlidesPreview({
  activeSlideIndex,
  deck,
  documentPath,
  onOpenFileLink,
  textScale,
}: MarkdownSlidesPreviewProps) {
  const clampedActiveSlideIndex = clampSlideIndex(deck, activeSlideIndex);

  return (
    <div className="flex min-h-full flex-col items-center gap-6 bg-zinc-100 px-6 py-6">
      <MarkdownSlidesDiagnostics deck={deck} />
      {deck.slides.length ? (
        deck.slides.map((slide, index) => (
          <div
            key={slideKey(slide, index)}
            className="w-full max-w-[960px]"
            data-markdown-slide-preview-index={index}
          >
            <div
              className={
                index === clampedActiveSlideIndex
                  ? "rounded-sm ring-2 ring-teal-400 ring-offset-2 ring-offset-zinc-100"
                  : ""
              }
            >
              <MarkdownSlideContent
                deck={deck}
                documentPath={documentPath}
                mode="preview"
                onOpenFileLink={onOpenFileLink}
                slide={slide}
                slideNumber={index + 1}
                textScale={textScale}
              />
            </div>
          </div>
        ))
      ) : (
        <div className="flex min-h-64 w-full max-w-3xl items-center justify-center rounded-md border border-dashed border-zinc-300 bg-white px-6 text-center text-sm text-zinc-500">
          No slides found. Add deck metadata or a line containing only --- followed by slide content.
        </div>
      )}
    </div>
  );
}

export function MarkdownSlidesPresenter({
  deck,
  documentPath,
  initialSlideIndex,
  onExit,
  onOpenFileLink,
  onSlideIndexChange,
  textScale,
}: MarkdownSlidesPresenterProps) {
  const [slideIndex, setSlideIndex] = useState(() =>
    clampSlideIndex(deck, initialSlideIndex),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const exitingRef = useRef(false);
  const latestSlideIndexRef = useRef(slideIndex);
  const activeSlide = deck.slides[slideIndex];

  useEffect(() => {
    latestSlideIndexRef.current = slideIndex;
  }, [slideIndex]);

  const goToSlide = useCallback(
    (nextSlideIndex: number) => {
      const clampedSlideIndex = clampSlideIndex(deck, nextSlideIndex);

      setSlideIndex(clampedSlideIndex);
      onSlideIndexChange(clampedSlideIndex);
    },
    [deck, onSlideIndexChange],
  );

  const finishExit = useCallback(() => {
    if (exitingRef.current) {
      return;
    }

    exitingRef.current = true;
    onSlideIndexChange(latestSlideIndexRef.current);
    onExit();
  }, [onExit, onSlideIndexChange]);

  const exitPresenter = useCallback(() => {
    const root = rootRef.current;

    if (root && document.fullscreenElement === root) {
      document.exitFullscreen().catch(() => finishExit());
      return;
    }

    finishExit();
  }, [finishExit]);

  useEffect(() => {
    const root = rootRef.current;

    if (!root || !root.requestFullscreen) {
      return;
    }

    root.requestFullscreen().catch(() => undefined);
  }, []);

  useEffect(() => {
    function handleFullscreenChange() {
      const root = rootRef.current;

      if (root && document.fullscreenElement === null && !exitingRef.current) {
        finishExit();
      }
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, [finishExit]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key === " " ||
        event.key === "Enter" ||
        event.key === "ArrowRight" ||
        event.key === "PageDown"
      ) {
        event.preventDefault();
        goToSlide(slideIndex + 1);
        return;
      }

      if (
        event.key === "ArrowLeft" ||
        event.key === "PageUp" ||
        event.key === "Backspace"
      ) {
        event.preventDefault();
        goToSlide(slideIndex - 1);
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        goToSlide(0);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        goToSlide(deck.slides.length - 1);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        exitPresenter();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [deck.slides.length, exitPresenter, goToSlide, slideIndex]);

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[100] flex min-h-0 items-center justify-center overflow-hidden bg-zinc-950 text-white"
      role="dialog"
      aria-modal="true"
      aria-label={deck.title ? `${deck.title} presentation` : "Markdown slides presentation"}
    >
      {activeSlide ? (
        <MarkdownSlideContent
          deck={deck}
          documentPath={documentPath}
          mode="presenter"
          onOpenFileLink={onOpenFileLink}
          slide={activeSlide}
          slideNumber={slideIndex + 1}
          textScale={textScale}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-white text-center text-sm text-zinc-500">
          No slides found.
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-4 bg-gradient-to-b from-black/45 to-transparent px-4 py-3">
        <p className="min-w-0 truncate text-sm font-medium text-white drop-shadow">
          {deck.title ?? "Markdown Slides"}
        </p>
        <p className="shrink-0 text-sm tabular-nums text-white drop-shadow">
          {deck.slides.length ? slideIndex + 1 : 0} / {deck.slides.length}
        </p>
      </div>

      <button
        className="absolute right-4 bottom-4 inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-black/35 text-white shadow-lg backdrop-blur hover:bg-black/50"
        type="button"
        aria-label="Exit presentation"
        title="Exit presentation"
        onClick={exitPresenter}
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
