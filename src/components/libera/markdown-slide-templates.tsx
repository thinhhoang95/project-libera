import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import {
  DEFAULT_MARKDOWN_SLIDE_FONT_SIZE,
  type MarkdownSlide,
  type MarkdownSlideDeck,
  type MarkdownSlideSegment,
} from "@/lib/markdown-slides";

export type MarkdownSlideTemplateMode = "export" | "presenter" | "preview";

export type MarkdownSlideTemplateProps = {
  deck: MarkdownSlideDeck;
  fontFamily?: string;
  mode: MarkdownSlideTemplateMode;
  /** Renders a title or other one-line Markdown (math, emphasis) in place. */
  renderInline: (markdown: string) => ReactNode;
  renderSegment: (segment: MarkdownSlideSegment) => ReactNode;
  slide: MarkdownSlide;
  slideCount: number;
  slideNumber: number;
  /** Build steps shown so far; segments of later steps keep their space but stay hidden. */
  step: number;
};

export type MarkdownSlideTemplate = (props: MarkdownSlideTemplateProps) => ReactNode;

const TEMPLATE_REGISTRY: Record<string, MarkdownSlideTemplate> = {
  default: DefaultMarkdownSlideTemplate,
};

/** Body text never shrinks below this share of its size; past it the slide is flagged as overfull. */
const MIN_FIT_SCALE = 0.55;

/**
 * Shrinks its content (scaled at a wider width, so text reflows rather than
 * just getting smaller) until it fits the slide body, and marks the slide
 * `data-overflow` when even the smallest size does not fit. It scales with a
 * transform, not CSS zoom: a zoomed ancestor breaks layout inside live HTML
 * frames. The canvas is a fixed size, so only the content changing (typing,
 * images, math, charts loading) can change the answer.
 */
function FitBody({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const measure = measureRef.current;
    const zoom = zoomRef.current;

    if (!frame || !measure || !zoom) {
      return;
    }

    const sheet = frame.closest<HTMLElement>(".markdown-slide");
    let applied = "";

    /** Lays the content out at `scale`; true when it fits. */
    function fits(scale: number) {
      const scaled = scale < 1;

      // Live HTML frames and diagrams keep their natural width: a responsive
      // chart or a diagram scaled to the column is as tall as it is wide, so
      // widening it to reflow would only grow it.
      if (!scaled) {
        const liveFrames = zoom!.querySelectorAll<HTMLElement>(".markdown-slide-live-frame, .markdown-slide-diagram");
        liveFrames.forEach((liveFrame) => liveFrame.style.removeProperty("max-width"));
        zoom!.style.width = "";
        liveFrames.forEach((liveFrame) => liveFrame.style.setProperty("max-width", `${liveFrame.offsetWidth}px`));
      }

      zoom!.style.width = scaled ? `${frame!.clientWidth / scale}px` : "";
      zoom!.style.transform = scaled ? `scale(${scale})` : "";
      const height = zoom!.offsetHeight * scale;
      measure!.style.height = scaled ? `${height}px` : "";
      return height <= frame!.clientHeight + 0.5;
    }

    function fit() {
      let scale = 1;
      let overflow = false;
      // Diagrams are capped at the body's height, so a tall one shrinks on
      // its own instead of shrinking the slide's text with it.
      frame!.style.setProperty("--markdown-slide-body-height", `${frame!.clientHeight}px`);

      if (enabled && !fits(1)) {
        let low = MIN_FIT_SCALE;
        let high = 1;

        if (!fits(low)) {
          overflow = true;
        } else {
          for (let iteration = 0; iteration < 7; iteration += 1) {
            const middle = (low + high) / 2;
            if (fits(middle)) low = middle;
            else high = middle;
          }
        }

        scale = Math.floor(low * 100) / 100;
      } else if (!enabled) {
        overflow = !fits(1);
      }

      fits(scale);
      const next = `${scale}:${overflow}`;

      if (next === applied) {
        return;
      }

      applied = next;

      if (sheet) {
        sheet.dataset.overflow = overflow ? "true" : "false";
        sheet.dataset.fitScale = String(scale);
      }
    }

    fit();
    const observer = new ResizeObserver(() => fit());
    observer.observe(zoom);
    observer.observe(frame);

    return () => observer.disconnect();
  }, [enabled]);

  return (
    <div ref={frameRef} className="markdown-slide-fit-frame">
      <div ref={measureRef} className="markdown-slide-fit-measure">
        <div ref={zoomRef} className="markdown-slide-fit">
          {children}
        </div>
      </div>
    </div>
  );
}

function SlideBody({ slide, renderSegment, step }: Pick<MarkdownSlideTemplateProps, "renderSegment" | "slide" | "step">) {
  const filled = slide.segments.filter((segment) => segment.content.trim());

  if (!filled.length) {
    return null;
  }

  const renderColumn = (segments: MarkdownSlideSegment[]) =>
    segments.map((segment) => (
      <div
        key={segment.citationIndex}
        className="markdown-slide-segment"
        data-pending={segment.step > step ? "true" : undefined}
        aria-hidden={segment.step > step ? true : undefined}
      >
        {renderSegment(segment)}
      </div>
    ));

  if (slide.columnCount < 2) {
    return <>{renderColumn(filled)}</>;
  }

  const widths =
    slide.columnWidths?.length === slide.columnCount
      ? slide.columnWidths.map((width) => `minmax(0, ${width}fr)`).join(" ")
      : `repeat(${slide.columnCount}, minmax(0, 1fr))`;

  return (
    <div className="markdown-slide-columns" style={{ gridTemplateColumns: widths }}>
      {Array.from({ length: slide.columnCount }, (_, column) => (
        <div key={column} className="markdown-slide-column">
          {renderColumn(filled.filter((segment) => segment.column === column))}
        </div>
      ))}
    </div>
  );
}

function footerText(deck: MarkdownSlideDeck) {
  if (deck.footer === false) {
    return "";
  }

  return deck.footer ?? [deck.author.join(", "), deck.title].filter(Boolean).join(" · ");
}

function DefaultMarkdownSlideTemplate({
  deck,
  fontFamily,
  mode,
  renderInline,
  renderSegment,
  slide,
  slideCount,
  slideNumber,
  step,
}: MarkdownSlideTemplateProps) {
  const fontSize = slide.fontSize ?? deck.fontSize ?? DEFAULT_MARKDOWN_SLIDE_FONT_SIZE;
  const style = {
    "--slide-font-size": `${fontSize}px`,
    "--slide-height": `${deck.aspect.height}px`,
    "--slide-width": `${deck.aspect.width}px`,
    ...(deck.accent ? { "--slide-accent": deck.accent } : {}),
    ...(slide.background ? { "--slide-bg": slide.background } : {}),
    fontFamily,
  } as CSSProperties;
  const fit = slide.fit ?? deck.fit;
  const body = <SlideBody renderSegment={renderSegment} slide={slide} step={step} />;
  const footer = footerText(deck);
  const showFooter = slide.kind !== "title" && slide.layout !== "blank" && Boolean(footer || deck.paginate);
  const sheet = (children: ReactNode, label: string) => (
    <section
      className="markdown-slide"
      data-layout={slide.layout}
      data-mode={mode}
      data-theme={deck.theme}
      style={style}
      aria-label={label}
      aria-roledescription="slide"
    >
      {children}
      {showFooter ? (
        <footer className="markdown-slide-footer">
          <span>{footer ? renderInline(footer) : null}</span>
          {deck.paginate && slideNumber > 0 ? (
            <span className="markdown-slide-page">
              {slideNumber} / {slideCount}
            </span>
          ) : null}
        </footer>
      ) : null}
    </section>
  );

  if (slide.kind === "title") {
    const people = deck.author.join(", ");
    const meta = [deck.affiliation.join(", "), deck.date].filter(Boolean);

    return sheet(
      <div className="markdown-slide-cover">
        {slide.title ? (
          <div className="markdown-slide-cover-title" role="heading" aria-level={1}>
            {renderInline(slide.title)}
          </div>
        ) : null}
        {deck.subtitle ? (
          <div className="markdown-slide-cover-subtitle">{renderInline(deck.subtitle)}</div>
        ) : null}
        {slide.title || deck.subtitle ? <div className="markdown-slide-rule" /> : null}
        {people ? <p className="markdown-slide-cover-people">{people}</p> : null}
        {meta.map((line) => (
          <p key={line} className="markdown-slide-cover-meta">
            {line}
          </p>
        ))}
        {slide.content.trim() ? (
          <div className="markdown-slide-cover-body">
            <FitBody enabled={fit}>{body}</FitBody>
          </div>
        ) : null}
      </div>,
      deck.title ?? "Title slide",
    );
  }

  if (slide.layout === "section") {
    return sheet(
      <div className="markdown-slide-body">
        <FitBody enabled={fit}>
          {slide.title ? (
            <div className="markdown-slide-section-title" role="heading" aria-level={2}>
              {renderInline(slide.title)}
            </div>
          ) : null}
          <div className="markdown-slide-rule" />
          <div className="markdown-slide-section-body">{body}</div>
        </FitBody>
      </div>,
      slide.title ?? `Slide ${slideNumber}`,
    );
  }

  return sheet(
    <>
      {slide.title && slide.layout !== "blank" ? (
        <header className="markdown-slide-header">
          <div className="markdown-slide-title" role="heading" aria-level={2}>
            {renderInline(slide.title)}
          </div>
          <div className="markdown-slide-rule" />
        </header>
      ) : null}
      <div className="markdown-slide-body">
        <FitBody enabled={fit}>{body}</FitBody>
      </div>
    </>,
    slide.title ?? `Slide ${slideNumber}`,
  );
}

export function getMarkdownSlideTemplate(templateId: string) {
  return TEMPLATE_REGISTRY[templateId] ?? TEMPLATE_REGISTRY.default;
}

export function renderMarkdownSlideTemplate(
  templateId: string,
  props: MarkdownSlideTemplateProps,
) {
  return getMarkdownSlideTemplate(templateId)(props);
}

export function hasMarkdownSlideTemplate(templateId: string) {
  return templateId in TEMPLATE_REGISTRY;
}
