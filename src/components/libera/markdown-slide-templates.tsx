import type { CSSProperties, ReactNode } from "react";
import type { MarkdownSlide, MarkdownSlideDeck } from "@/lib/markdown-slides";

export type MarkdownSlideTemplateMode = "presenter" | "preview";

export type MarkdownSlideTemplateProps = {
  children: ReactNode;
  deck: MarkdownSlideDeck;
  fontSize: number;
  mode: MarkdownSlideTemplateMode;
  slide: MarkdownSlide;
  slideCount: number;
  slideNumber: number;
};

export type MarkdownSlideTemplate = (props: MarkdownSlideTemplateProps) => ReactNode;

const TEMPLATE_REGISTRY: Record<string, MarkdownSlideTemplate> = {
  default: DefaultMarkdownSlideTemplate,
};

function classNames(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function DefaultMarkdownSlideTemplate({
  children,
  deck,
  fontSize,
  mode,
  slide,
  slideCount,
  slideNumber,
}: MarkdownSlideTemplateProps) {
  const isPresenter = mode === "presenter";
  const fontScaleStyle = {
    "--markdown-slide-font-scale": fontSize / 16,
  } as CSSProperties;
  const authorLine = deck.author.join(", ");
  const sheetClassName = classNames(
    "flex flex-col border border-zinc-200 bg-white text-zinc-950 shadow-sm",
    isPresenter
      ? "aspect-video overflow-hidden markdown-slide-presenter-sheet"
      : "overflow-visible markdown-slide-preview-sheet",
  );

  if (slide.kind === "title") {
    const details = [
      deck.author.join(", "),
      deck.affiliation.join(", "),
      deck.date,
    ].filter(Boolean);

    return (
      <section
        className={sheetClassName}
        style={fontScaleStyle}
        aria-label={deck.title ?? "Title slide"}
      >
        <div
          className={
            isPresenter
              ? "flex min-h-0 flex-1 items-center justify-center px-14 py-12 text-center"
              : "px-14 py-12 text-center"
          }
        >
          <div className="w-full max-w-[980px]">
            {deck.title ? (
              <h1 className="text-[calc(2.75rem*var(--markdown-slide-font-scale))] font-semibold leading-tight tracking-tight text-zinc-950">
                {deck.title}
              </h1>
            ) : null}
            {details.length ? (
              <div className="mt-6 space-y-2 text-[calc(1rem*var(--markdown-slide-font-scale))] leading-7 text-zinc-600">
                {details.map((detail) => (
                  <p key={detail}>{detail}</p>
                ))}
              </div>
            ) : null}
            {children ? <div className="mt-8 text-left">{children}</div> : null}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className={sheetClassName}
      style={fontScaleStyle}
      aria-label={slide.title ?? `Slide ${slideNumber}`}
    >
      <header className="flex min-h-20 shrink-0 items-start justify-between gap-6 border-b border-zinc-100 px-12 py-7">
        <div className="min-w-0">
          {slide.title ? (
            <h2 className="truncate text-[calc(1.5rem*var(--markdown-slide-font-scale))] font-semibold tracking-tight text-zinc-950">
              {slide.title}
            </h2>
          ) : deck.title ? (
            <p className="truncate text-[calc(0.875rem*var(--markdown-slide-font-scale))] font-medium uppercase text-zinc-500">
              {deck.title}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 text-[calc(0.875rem*var(--markdown-slide-font-scale))] tabular-nums text-zinc-400">
          {slideNumber}/{slideCount}
        </span>
      </header>

      <div
        className={
          isPresenter
            ? "flex min-h-0 flex-1 items-center justify-center overflow-auto px-12 py-8"
            : "px-12 py-8"
        }
      >
        <div className="w-full">
          {children}
        </div>
      </div>

      {slide.title || deck.title || authorLine ? (
        <footer className="flex h-11 shrink-0 items-center justify-between gap-6 border-t border-zinc-100 px-12 text-[calc(0.75rem*var(--markdown-slide-font-scale))] font-medium uppercase text-zinc-400">
          <span className="min-w-0 truncate">{slide.title ?? deck.title}</span>
          {authorLine ? (
            <span className="shrink-0 truncate text-right normal-case">
              {authorLine}
            </span>
          ) : null}
        </footer>
      ) : null}
    </section>
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
