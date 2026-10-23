"use client";

import {
  ChevronLeft,
  ChevronRight,
  EyeOff,
  Keyboard,
  LayoutGrid,
  MonitorPlay,
  NotebookText,
  Play,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { MarkdownRenderer, type MarkdownCodeBlock } from "@/components/markdown-renderer";
import { markdownMacroScopes, mayUseMarkdownMacros, type MarkdownMacroScope } from "@/lib/markdown-macros";
import { SlideLiveBlock, isLiveCodeBlock } from "@/components/libera/slide-live-blocks";
import {
  CitationScope,
  ReferenceRenderProvider,
  referenceNotebookForPath,
  useReferenceRender,
} from "@/components/libera/references/reference-render-context";
import {
  hasMarkdownSlideTemplate,
  renderMarkdownSlideTemplate,
  type MarkdownSlideTemplateMode,
} from "@/components/libera/markdown-slide-templates";
import {
  visibleMarkdownSlides,
  type MarkdownSlide,
  type MarkdownSlideDeck,
  type MarkdownSlideSegment,
} from "@/lib/markdown-slides";
import type { MathMarkerSettings } from "@/lib/math-markers";
import { DOCUMENT_STYLE_FIELD, isDocumentStyleSetting } from "@/lib/references/document-style";

type MarkdownSlidesViewerProps = {
  baseLineHeight?: number;
  deck: MarkdownSlideDeck;
  documentPath?: string;
  fontFamily?: string;
  mathMarkers?: MathMarkerSettings;
  onOpenFileLink?: (href: string) => Promise<boolean>;
};

type MarkdownSlidesPreviewProps = MarkdownSlidesViewerProps & {
  activeSlideIndex: number;
  /** Present starting at this slide. */
  onPresentFrom?: (slideIndex: number) => void;
  /** A slide was clicked: put the editor on it. */
  onSelectSlide?: (slide: MarkdownSlide) => void;
};

type MarkdownSlidesPresenterProps = MarkdownSlidesViewerProps & {
  initialSlideIndex: number;
  onExit: () => void;
  onSlideIndexChange: (slideIndex: number) => void;
};

const ALL_STEPS = Number.MAX_SAFE_INTEGER;
const CONTROLS_IDLE_MS = 2200;

function clampSlideIndex(deck: MarkdownSlideDeck, slideIndex: number) {
  return Math.min(Math.max(0, slideIndex), Math.max(0, deck.slides.length - 1));
}

function slideKey(slide: MarkdownSlide, index: number) {
  return `${slide.sourceStart}:${slide.sourceEnd}:${index}`;
}

/** Titles render as Markdown, so `1. Intro` must not become a list. */
function inlineMarkdown(text: string) {
  return text.replace(/^(\d+)([.)])(\s)/, "$1\\$2$3").replace(/^([-*+>])(\s)/, "\\$1$2");
}

/** A title as plain text (labels, not slides): emphasis and code marks dropped. */
function plainText(markdown: string) {
  return markdown.replace(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2");
}

/** The latest callback behind a stable identity, so memoized slides skip re-rendering. */
function useStableCallback<Args extends unknown[], Result>(callback: ((...args: Args) => Result) | undefined) {
  const ref = useRef(callback);
  useLayoutEffect(() => {
    ref.current = callback;
  });
  return useCallback((...args: Args) => ref.current?.(...args) as Result, []);
}

/**
 * Citations in a deck: formatted with the notebook's references (the
 * workspace's provider, or one for the deck's notebook) and numbered across
 * all slides; the bibliography goes where a slide has `:::bibliography`.
 * Each build step or column renders separately, so each is its own source.
 */
export function SlideDeckReferences({
  children,
  deck,
  documentPath,
  mathMarkers,
}: {
  children: ReactNode;
  deck: MarkdownSlideDeck;
  documentPath?: string;
  mathMarkers?: MathMarkerSettings;
}) {
  const outer = useReferenceRender();
  const sources = useMemo(
    () => deck.slides.flatMap((slide) => slide.segments.map((segment) => segment.content)),
    [deck],
  );
  // The deck's front matter may name its own style (`citation-style: ieee`).
  const style = deck.metadata[DOCUMENT_STYLE_FIELD];
  const documentStyle = typeof style === "string" && isDocumentStyleSetting(style.trim()) ? style.trim() : null;
  const scoped = (
    <CitationScope sources={sources} mathMarkers={mathMarkers} documentStyle={documentStyle}>
      {children}
    </CitationScope>
  );
  if (outer || !documentPath) return scoped;
  return <ReferenceRenderProvider notebook={referenceNotebookForPath(documentPath)}>{scoped}</ReferenceRenderProvider>;
}

const deckMacroScopes = new WeakMap<MarkdownSlideDeck, MarkdownMacroScope[] | null>();

/**
 * Each segment's macro scope, so a deck's macro block applies to every slide
 * and counters run on from slide to slide (markdown-macros.ts).
 */
function slideMacroScopes(deck: MarkdownSlideDeck, mathMarkers?: MathMarkerSettings) {
  if (!deckMacroScopes.has(deck)) {
    const sources = deck.slides.flatMap((slide) => slide.segments.map((segment) => segment.content));
    const document = sources.join("\n\n");
    deckMacroScopes.set(deck, mayUseMarkdownMacros(document) ? markdownMacroScopes(document, sources, mathMarkers) : null);
  }
  return deckMacroScopes.get(deck) ?? null;
}

type SlideRenderOptions = MarkdownSlidesViewerProps & {
  mode: MarkdownSlideTemplateMode;
  slide: MarkdownSlide;
  slideCount: number;
  slideNumber: number;
  step: number;
};

/** One slide at its canvas size (unscaled). */
export function MarkdownSlideSheet({
  baseLineHeight,
  deck,
  documentPath,
  fontFamily,
  mathMarkers,
  mode,
  onOpenFileLink,
  slide,
  slideCount,
  slideNumber,
  step,
}: SlideRenderOptions) {
  const fontSize = slide.fontSize ?? deck.fontSize ?? 21;
  const theme = deck.theme;
  // ```chart, ```mermaid and ```html live blocks render as charts, diagrams and live frames.
  const renderCodeBlock = useCallback(
    ({ code, language, meta }: MarkdownCodeBlock) => {
      if (!isLiveCodeBlock(language, meta)) return null;
      return <SlideLiveBlock documentPath={documentPath} fontFamily={fontFamily} language={language} meta={meta} mode={mode} source={code} theme={theme} />;
    },
    [documentPath, fontFamily, mode, theme],
  );
  const macroScopes = slideMacroScopes(deck, mathMarkers);
  const renderSegment = (segment: MarkdownSlideSegment) => (
    <MarkdownRenderer
      macroScope={macroScopes?.[segment.citationIndex]}
      baseFontSize={fontSize}
      baseLineHeight={baseLineHeight}
      citationScopeIndex={segment.citationIndex}
      content={segment.content}
      documentPath={documentPath}
      fontFamily={fontFamily}
      mathMarkers={mathMarkers}
      onOpenFileLink={onOpenFileLink}
      renderCodeBlock={renderCodeBlock}
    />
  );
  const renderInline = (markdown: string) => (
    <MarkdownRenderer
      className="markdown-slide-inline"
      content={inlineMarkdown(markdown)}
      documentPath={documentPath}
      macroScope={macroScopes?.[0]}
      mathMarkers={mathMarkers}
      onOpenFileLink={onOpenFileLink}
      renderImages={false}
    />
  );

  return renderMarkdownSlideTemplate(deck.template, {
    deck,
    fontFamily,
    mode,
    renderInline,
    renderSegment,
    slide,
    slideCount,
    slideNumber,
    step,
  });
}

/**
 * A slide scaled to fit its box: the full width (preview, thumbnails) or the
 * whole box (presenter). The scale is written straight to a CSS variable, so
 * resizing re-renders nothing.
 */
function ScaledSlide({
  children,
  className,
  deck,
  fill = false,
}: {
  children: ReactNode;
  className?: string;
  deck: MarkdownSlideDeck;
  fill?: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const { height, width } = deck.aspect;

  useLayoutEffect(() => {
    const frame = frameRef.current;

    if (!frame) {
      return;
    }

    function measure() {
      const scale = Math.min(frame!.clientWidth / width, frame!.clientHeight / height);
      frame!.style.setProperty("--slide-scale", String(Number.isFinite(scale) && scale > 0 ? scale : 0));
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [height, width]);

  return (
    <div
      ref={frameRef}
      className={`markdown-slide-frame${className ? ` ${className}` : ""}`}
      style={fill ? undefined : { aspectRatio: `${width} / ${height}` }}
    >
      <div className="markdown-slide-scaler">{children}</div>
    </div>
  );
}


function MarkdownSlidesDiagnostics({ deck }: { deck: MarkdownSlideDeck }) {
  const unknownTemplate =
    deck.template && !hasMarkdownSlideTemplate(deck.template)
      ? `Unknown slide template "${deck.template}"; using default.`
      : "";
  const messages = [
    unknownTemplate,
    ...deck.diagnostics.map((diagnostic) =>
      diagnostic.line ? `Line ${diagnostic.line}: ${diagnostic.message}` : diagnostic.message,
    ),
  ].filter(Boolean);

  if (!messages.length) {
    return null;
  }

  return (
    <div className="w-full max-w-[960px] rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-medium">Slide deck warnings</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {Array.from(new Set(messages)).map((message) => (
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
  mathMarkers,
  onOpenFileLink,
  onPresentFrom,
  onSelectSlide,
  ...rest
}: MarkdownSlidesPreviewProps) {
  const clampedActiveSlideIndex = clampSlideIndex(deck, activeSlideIndex);
  const openFileLink = useStableCallback(onOpenFileLink);
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => visibleMarkdownSlides(deck), [deck]);

  // Follow the editor: keep the slide being edited in view.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-markdown-slide-preview-index="${clampedActiveSlideIndex}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [clampedActiveSlideIndex]);

  function handleSlideClick(event: ReactMouseEvent, slide: MarkdownSlide) {
    if ((event.target as HTMLElement).closest("a, button, summary")) {
      return;
    }

    onSelectSlide?.(slide);
  }

  return (
    <SlideDeckReferences deck={deck} documentPath={documentPath} mathMarkers={mathMarkers}>
      <div ref={listRef} className="flex min-h-full flex-col items-center gap-7 bg-zinc-100 px-6 py-6">
        <MarkdownSlidesDiagnostics deck={deck} />
        {deck.slides.length ? (
          deck.slides.map((slide, index) => {
            const count = visible.length;
            const number = visible.indexOf(slide) + 1;
            const isActive = index === clampedActiveSlideIndex;

            return (
              <div
                key={slideKey(slide, index)}
                className="markdown-slide-preview-item group w-full max-w-[960px]"
                data-markdown-slide-preview-index={index}
              >
                <div className="mb-1.5 flex h-6 items-center gap-2 px-0.5 text-xs text-zinc-500">
                  <span className="font-semibold tabular-nums text-zinc-700">{slide.hidden ? "Hidden" : number}</span>
                  {slide.stepCount > 1 ? <span>{slide.stepCount} steps</span> : null}
                  {slide.hidden ? <EyeOff aria-label="Hidden from the presentation" className="h-3.5 w-3.5" /> : null}
                  <span className="markdown-slide-overflow-badge items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900">
                    <TriangleAlert aria-hidden className="h-3 w-3" />
                    Too much content to fit
                  </span>
                  {onPresentFrom && !slide.hidden ? (
                    <button
                      className="ml-auto inline-flex h-6 items-center gap-1 rounded px-1.5 font-medium text-zinc-600 opacity-0 transition hover:bg-zinc-200 hover:text-zinc-900 focus-visible:opacity-100 group-hover:opacity-100"
                      type="button"
                      title={`Present from slide ${number} of ${count}`}
                      onClick={() => onPresentFrom(index)}
                    >
                      <Play aria-hidden className="h-3 w-3" />
                      Present from here
                    </button>
                  ) : null}
                </div>
                <div
                  className={`cursor-text overflow-hidden rounded-[3px] shadow-[0_1px_3px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.06)] transition ${
                    isActive ? "ring-2 ring-teal-500 ring-offset-2 ring-offset-zinc-100" : "hover:shadow-md"
                  } ${slide.hidden ? "opacity-50" : ""}`}
                  onClick={(event) => handleSlideClick(event, slide)}
                >
                  <ScaledSlide deck={deck}>
                    <MarkdownSlideSheet
                      {...rest}
                      deck={deck}
                      documentPath={documentPath}
                      mathMarkers={mathMarkers}
                      mode="preview"
                      onOpenFileLink={openFileLink}
                      slide={slide}
                      slideCount={count}
                      slideNumber={number}
                      step={ALL_STEPS}
                    />
                  </ScaledSlide>
                </div>
                {slide.notes ? (
                  <p className="mt-2 line-clamp-3 whitespace-pre-line px-0.5 text-xs leading-5 text-zinc-500">
                    <NotebookText aria-hidden className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                    {slide.notes}
                  </p>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="flex min-h-64 w-full max-w-3xl items-center justify-center rounded-md border border-dashed border-zinc-300 bg-white px-6 text-center text-sm text-zinc-500">
            No slides yet. Add a line containing only --- and write the first slide below it.
          </div>
        )}
      </div>
    </SlideDeckReferences>
  );
}

type PresenterPosition = { index: number; step: number };

function formatElapsed(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Elapsed time and the clock; ticks on its own so the slides do not re-render. */
function SpeakerClock({ startedAt, onReset }: { startedAt: number; onReset: () => void }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex items-baseline gap-4">
      <button
        className="rounded px-1 text-3xl font-semibold tabular-nums text-white hover:bg-white/10"
        type="button"
        title="Reset timer (T)"
        onClick={onReset}
      >
        {formatElapsed(Math.max(0, now - startedAt))}
      </button>
      <span className="text-lg tabular-nums text-zinc-400">
        {new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["→  Space  PageDown  N", "Next step or slide"],
  ["←  PageUp  Backspace  P", "Previous step or slide"],
  ["↓  ↑", "Next / previous slide, skipping steps"],
  ["Home  End", "First / last slide"],
  ["Number, then Enter", "Go to slide"],
  ["G", "Overview of all slides"],
  ["S", "Speaker view: notes, next slide, timer"],
  ["T", "Reset the timer"],
  ["B  or  .", "Black screen"],
  ["W  or  ,", "White screen"],
  ["?", "These shortcuts"],
  ["Esc", "Close, or end the presentation"],
];

export function MarkdownSlidesPresenter({
  deck,
  documentPath,
  initialSlideIndex,
  mathMarkers,
  onExit,
  onOpenFileLink,
  onSlideIndexChange,
  ...rest
}: MarkdownSlidesPresenterProps) {
  const [position, setPosition] = useState<PresenterPosition>(() => ({
    index: clampSlideIndex(deck, initialSlideIndex),
    step: 0,
  }));
  const [direction, setDirection] = useState<"backward" | "forward">("forward");
  const [overlay, setOverlay] = useState<"black" | "help" | "overview" | "white" | null>(null);
  const [speakerView, setSpeakerView] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [jumpBuffer, setJumpBuffer] = useState("");
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const exitingRef = useRef(false);
  const idleTimerRef = useRef(0);
  const openFileLink = useStableCallback(onOpenFileLink);
  const visible = useMemo(() => {
    const slides = visibleMarkdownSlides(deck);
    return slides.length ? slides : deck.slides;
  }, [deck]);
  const index = clampSlideIndex(deck, position.index);
  const activeSlide = deck.slides[index];
  const step = activeSlide ? Math.min(position.step, activeSlide.stepCount - 1) : 0;
  const visiblePosition = activeSlide ? visible.indexOf(activeSlide) : -1;
  const latestIndexRef = useRef(index);

  useEffect(() => {
    latestIndexRef.current = index;
  }, [index]);

  const moveTo = useCallback(
    (next: PresenterPosition, nextDirection?: "backward" | "forward") => {
      const nextIndex = clampSlideIndex(deck, next.index);
      setDirection(nextDirection ?? (nextIndex < latestIndexRef.current ? "backward" : "forward"));
      setPosition({ index: nextIndex, step: next.step });
      onSlideIndexChange(nextIndex);
    },
    [deck, onSlideIndexChange],
  );

  /** The visible slide `delta` places from the current one (hidden slides are skipped). */
  const neighbor = useCallback(
    (delta: number) => {
      if (!activeSlide) return undefined;
      if (visiblePosition !== -1) return visible[visiblePosition + delta];
      // Presenting from a hidden slide: carry on with the visible ones around it.
      return delta > 0
        ? visible.find((slide) => slide.index > activeSlide.index)
        : [...visible].reverse().find((slide) => slide.index < activeSlide.index);
    },
    [activeSlide, visible, visiblePosition],
  );

  const goNext = useCallback(() => {
    if (activeSlide && step < activeSlide.stepCount - 1) {
      setPosition({ index, step: step + 1 });
      return;
    }
    const next = neighbor(1);
    if (next) moveTo({ index: next.index, step: 0 }, "forward");
  }, [activeSlide, index, moveTo, neighbor, step]);

  const goPrevious = useCallback(() => {
    if (step > 0) {
      setPosition({ index, step: step - 1 });
      return;
    }
    const previous = neighbor(-1);
    if (previous) moveTo({ index: previous.index, step: previous.stepCount - 1 }, "backward");
  }, [index, moveTo, neighbor, step]);

  const goToVisible = useCallback(
    (position: number, atLastStep = false) => {
      const slide = visible[Math.min(Math.max(0, position), visible.length - 1)];
      if (slide) moveTo({ index: slide.index, step: atLastStep ? slide.stepCount - 1 : 0 });
    },
    [moveTo, visible],
  );

  const finishExit = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    onSlideIndexChange(latestIndexRef.current);
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
    // Keystrokes must not reach the editor underneath.
    root?.focus({ preventScroll: true });
    root?.requestFullscreen?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    function handleFullscreenChange() {
      if (rootRef.current && document.fullscreenElement === null && !exitingRef.current) {
        finishExit();
      }
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [finishExit]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
  }, []);

  // Controls start visible, then fade until the mouse moves.
  useEffect(() => {
    idleTimerRef.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
    return () => window.clearTimeout(idleTimerRef.current);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Keys typed into an overlay above the slides (the command palette) are its own.
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target instanceof Element && event.target.closest("[data-libera-overlay]"))) {
        return;
      }

      const key = event.key;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      if (/^[0-9]$/.test(key)) {
        handled();
        setJumpBuffer((buffer) => (buffer + key).slice(-4));
        return;
      }

      if (key === "Enter" && jumpBuffer) {
        handled();
        goToVisible(Number(jumpBuffer) - 1);
        setJumpBuffer("");
        setOverlay(null);
        return;
      }

      if (jumpBuffer) setJumpBuffer("");

      if (key === "Escape") {
        handled();
        if (overlay) setOverlay(null);
        else exitPresenter();
        return;
      }

      // A blank screen comes back on any key; the key does nothing else.
      if (overlay === "black" || overlay === "white") {
        handled();
        setOverlay(null);
        return;
      }

      switch (key) {
        case " ":
        case "Enter":
        case "ArrowRight":
        case "PageDown":
        case "n":
        case "N":
          handled();
          if (overlay !== "overview") goNext();
          return;
        case "ArrowLeft":
        case "PageUp":
        case "Backspace":
        case "p":
        case "P":
          handled();
          if (overlay !== "overview") goPrevious();
          return;
        case "ArrowDown":
          handled();
          goToVisible((visiblePosition === -1 ? 0 : visiblePosition) + 1);
          return;
        case "ArrowUp":
          handled();
          goToVisible((visiblePosition === -1 ? 0 : visiblePosition) - 1);
          return;
        case "Home":
          handled();
          goToVisible(0);
          return;
        case "End":
          handled();
          goToVisible(visible.length - 1, true);
          return;
        case "g":
        case "G":
        case "o":
        case "O":
          handled();
          setOverlay((current) => (current === "overview" ? null : "overview"));
          return;
        case "s":
        case "S":
          handled();
          setSpeakerView((current) => !current);
          return;
        case "t":
        case "T":
          handled();
          setStartedAt(Date.now());
          return;
        case "b":
        case "B":
        case ".":
          handled();
          setOverlay("black");
          return;
        case "w":
        case "W":
        case ",":
          handled();
          setOverlay("white");
          return;
        case "?":
        case "h":
        case "H":
          handled();
          setOverlay((current) => (current === "help" ? null : "help"));
          return;
        default:
          // Nothing typed here belongs to the editor underneath.
          if (key.length === 1) handled();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [exitPresenter, goNext, goPrevious, goToVisible, jumpBuffer, overlay, visible.length, visiblePosition]);

  function handleStageClick(event: ReactMouseEvent) {
    if ((event.target as HTMLElement).closest("a, button, summary, input")) return;
    goNext();
  }

  function handleStageContextMenu(event: ReactMouseEvent) {
    event.preventDefault();
    goPrevious();
  }

  const slideCount = visible.length;
  const slideNumber = visiblePosition === -1 ? index + 1 : visiblePosition + 1;
  const sheetProps = { ...rest, deck, documentPath, mathMarkers, onOpenFileLink: openFileLink };
  const progress = slideCount
    ? ((Math.max(0, visiblePosition) + (activeSlide ? (step + 1) / activeSlide.stepCount : 1)) / slideCount) * 100
    : 0;
  const nextPreview: PresenterPosition | null = activeSlide
    ? step < activeSlide.stepCount - 1
      ? { index, step: step + 1 }
      : neighbor(1)
        ? { index: neighbor(1)!.index, step: 0 }
        : null
    : null;

  const stage = activeSlide ? (
    <ScaledSlide deck={deck} fill className="h-full w-full">
      <div
        key={index}
        className="markdown-slide-presenter-sheet"
        data-transition={deck.transition}
        data-direction={direction}
      >
        <MarkdownSlideSheet
          {...sheetProps}
          mode="presenter"
          slide={activeSlide}
          slideCount={slideCount}
          slideNumber={slideNumber}
          step={step}
        />
      </div>
    </ScaledSlide>
  ) : (
    <div className="flex h-full w-full items-center justify-center text-sm text-zinc-400">No slides yet.</div>
  );

  // On the body, above every panel, even when full screen is refused.
  return createPortal(
    <SlideDeckReferences deck={deck} documentPath={documentPath} mathMarkers={mathMarkers}>
      <div
        ref={rootRef}
        className="fixed inset-0 z-[1000] flex min-h-0 flex-col overflow-hidden bg-black text-white outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={deck.title ? `${deck.title} presentation` : "Markdown slides presentation"}
        tabIndex={-1}
        style={{ cursor: controlsVisible || overlay ? undefined : "none" } as CSSProperties}
        onMouseMove={revealControls}
      >
        {speakerView ? (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] gap-6 bg-zinc-950 p-6">
            <div className="flex min-h-0 flex-col gap-3">
              <div className="flex items-center justify-between text-sm text-zinc-400">
                <span>
                  Slide <span className="font-semibold tabular-nums text-white">{slideNumber}</span> of {slideCount}
                  {activeSlide && activeSlide.stepCount > 1 ? ` · step ${step + 1} of ${activeSlide.stepCount}` : ""}
                </span>
                <SpeakerClock startedAt={startedAt} onReset={() => setStartedAt(Date.now())} />
              </div>
              <div
                className="min-h-0 flex-1"
                onClick={handleStageClick}
                onContextMenu={handleStageContextMenu}
              >
                {stage}
              </div>
            </div>
            <div className="flex min-h-0 flex-col gap-4">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Next</p>
                {nextPreview ? (
                  <div className="overflow-hidden rounded">
                    <ScaledSlide deck={deck}>
                      <MarkdownSlideSheet
                        {...sheetProps}
                        mode="presenter"
                        slide={deck.slides[nextPreview.index]}
                        slideCount={slideCount}
                        slideNumber={Math.max(1, visible.indexOf(deck.slides[nextPreview.index]) + 1)}
                        step={nextPreview.step}
                      />
                    </ScaledSlide>
                  </div>
                ) : (
                  <div className="flex aspect-video items-center justify-center rounded border border-zinc-800 text-sm text-zinc-500">
                    End of presentation
                  </div>
                )}
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Notes</p>
                <div className="markdown-slide-notes-panel min-h-0 flex-1 overflow-auto rounded border border-zinc-800 bg-zinc-900 p-4 text-[19px] leading-relaxed text-zinc-100">
                  {activeSlide?.notes ? (
                    <MarkdownRenderer
                      baseFontSize={19}
                      className="markdown-slide-notes [&>*:last-child]:mb-0"
                      content={activeSlide.notes}
                      documentPath={documentPath}
                      mathMarkers={mathMarkers}
                    />
                  ) : (
                    <p className="text-base text-zinc-500">No notes for this slide. Add a line with ??? and write them below it.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1" onClick={handleStageClick} onContextMenu={handleStageContextMenu}>
            {stage}
          </div>
        )}

        {!speakerView ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-white/10">
            <div
              className="h-full transition-[width] duration-300"
              style={{ backgroundColor: deck.accent ?? "#2dd4bf", width: `${progress}%` }}
            />
          </div>
        ) : null}

        <div
          className={`absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-white/10 bg-zinc-900/85 p-1 text-white shadow-xl backdrop-blur transition-opacity duration-300 ${
            controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <PresenterButton label="Previous (←)" onClick={goPrevious}>
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </PresenterButton>
          <span className="min-w-16 px-1 text-center text-sm tabular-nums text-zinc-200">
            {jumpBuffer ? `Go to ${jumpBuffer}…` : `${slideCount ? slideNumber : 0} / ${slideCount}`}
          </span>
          <PresenterButton label="Next (→)" onClick={goNext}>
            <ChevronRight aria-hidden className="h-4 w-4" />
          </PresenterButton>
          <span className="mx-1 h-5 w-px bg-white/15" />
          <PresenterButton
            label="Overview (G)"
            pressed={overlay === "overview"}
            onClick={() => setOverlay((current) => (current === "overview" ? null : "overview"))}
          >
            <LayoutGrid aria-hidden className="h-4 w-4" />
          </PresenterButton>
          <PresenterButton label="Speaker view (S)" pressed={speakerView} onClick={() => setSpeakerView((current) => !current)}>
            <MonitorPlay aria-hidden className="h-4 w-4" />
          </PresenterButton>
          <PresenterButton
            label="Keyboard shortcuts (?)"
            pressed={overlay === "help"}
            onClick={() => setOverlay((current) => (current === "help" ? null : "help"))}
          >
            <Keyboard aria-hidden className="h-4 w-4" />
          </PresenterButton>
          <PresenterButton label="End presentation (Esc)" onClick={exitPresenter}>
            <X aria-hidden className="h-4 w-4" />
          </PresenterButton>
        </div>

        {overlay === "overview" ? (
          <div className="absolute inset-0 overflow-auto bg-zinc-950 p-8" onClick={() => setOverlay(null)}>
            <div className="mx-auto grid max-w-[1400px] grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-5">
              {visible.map((slide, position) => (
                <button
                  key={slideKey(slide, slide.index)}
                  className={`group text-left outline-none ${slide.index === index ? "" : "opacity-80 hover:opacity-100"}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    goToVisible(position);
                    setOverlay(null);
                  }}
                >
                  <div
                    className={`pointer-events-none overflow-hidden rounded ring-offset-2 ring-offset-zinc-950 group-focus-visible:ring-2 group-focus-visible:ring-white ${
                      slide.index === index ? "ring-2 ring-teal-400" : ""
                    }`}
                  >
                    <ScaledSlide deck={deck}>
                      <MarkdownSlideSheet
                        {...sheetProps}
                        mode="presenter"
                        slide={slide}
                        slideCount={slideCount}
                        slideNumber={position + 1}
                        step={ALL_STEPS}
                      />
                    </ScaledSlide>
                  </div>
                  <span className="mt-1.5 block truncate text-xs text-zinc-400">
                    <span className="mr-1.5 font-semibold tabular-nums text-zinc-200">{position + 1}</span>
                    {slide.title ? plainText(slide.title) : slide.kind === "title" ? "Title slide" : ""}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {overlay === "black" || overlay === "white" ? (
          <div
            className={`absolute inset-0 ${overlay === "black" ? "bg-black" : "bg-white"}`}
            onClick={() => setOverlay(null)}
          />
        ) : null}

        {overlay === "help" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70" onClick={() => setOverlay(null)}>
            <div className="w-[min(92vw,520px)] rounded-xl border border-white/10 bg-zinc-900 p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <p className="mb-4 text-base font-semibold">Presentation shortcuts</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                {SHORTCUTS.map(([keys, action]) => (
                  <div key={keys} className="contents">
                    <dt className="font-mono text-zinc-300">{keys}</dt>
                    <dd className="text-zinc-400">{action}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 text-xs text-zinc-500">Click to advance; right-click to go back.</p>
            </div>
          </div>
        ) : null}
      </div>
    </SlideDeckReferences>,
    document.body,
  );
}

function PresenterButton({
  children,
  label,
  onClick,
  pressed,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-200 hover:bg-white/10 hover:text-white ${
        pressed ? "bg-white/15 text-white" : ""
      }`}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

/** Every slide at full size, one per printed page, all build steps shown (PDF export). */
export function MarkdownSlidesPrintDocument(props: MarkdownSlidesViewerProps) {
  const { deck } = props;
  const visible = visibleMarkdownSlides(deck);

  return (
    <SlideDeckReferences deck={deck} documentPath={props.documentPath} mathMarkers={props.mathMarkers}>
      <style>{`@page { size: ${deck.aspect.width}px ${deck.aspect.height}px; margin: 0; }`}</style>
      {visible.map((slide, position) => (
        <div key={slideKey(slide, slide.index)} className="markdown-slide-print-page">
          <MarkdownSlideSheet
            {...props}
            mode="export"
            slide={slide}
            slideCount={visible.length}
            slideNumber={position + 1}
            step={ALL_STEPS}
          />
        </div>
      ))}
    </SlideDeckReferences>
  );
}
