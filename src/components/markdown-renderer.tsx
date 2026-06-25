"use client";

import type { CSSProperties } from "react";
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  normalizeMarkdownHighlightDelimiters,
  remarkMarkdownHighlights,
} from "@/lib/markdown-highlights";
import {
  isSafeMarkdownTextColor,
  remarkMarkdownTextColors,
} from "@/lib/markdown-colors";
import {
  isExternalMarkdownLink,
  isLikelyWorkspaceMarkdownLink,
} from "@/lib/markdown-file-links";
import { remarkMarkdownSourceMap } from "@/lib/markdown-source-map";
import { remarkMarkdownUnderlines } from "@/lib/markdown-underlines";

type MarkdownRendererProps = {
  className?: string;
  content: string;
  documentPath?: string;
  onOpenExternalLink?: (href: string) => void;
  onOpenFileLink?: (href: string) => Promise<boolean>;
  textScale?: number;
};

const remarkPlugins = [
  remarkGfm,
  remarkMath,
  remarkMarkdownHighlights,
  remarkMarkdownTextColors,
  remarkMarkdownUnderlines,
  remarkMarkdownSourceMap,
];

function resolveMarkdownImageSource(src: string | undefined, documentPath: string | undefined) {
  if (
    !src ||
    !documentPath ||
    src.startsWith("#") ||
    src.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(src)
  ) {
    return src;
  }

  return `/api/markdown-assets/raw?document=${encodeURIComponent(
    documentPath,
  )}&asset=${encodeURIComponent(src)}`;
}

function tableCellStyle(align: unknown): CSSProperties | undefined {
  if (align === "left" || align === "center" || align === "right") {
    return { textAlign: align };
  }

  return undefined;
}

function classNames(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function markdownHeadingClassName(level: number, className: string | undefined) {
  return classNames(
    level === 1
      ? "mb-4 text-[calc(1.875rem*var(--markdown-text-scale))] font-semibold tracking-tight text-foreground"
      : undefined,
    level === 2
      ? "mb-3 mt-8 text-[calc(1.25rem*var(--markdown-text-scale))] font-semibold text-foreground"
      : undefined,
    level === 3
      ? "mb-3 mt-7 text-[calc(1.125rem*var(--markdown-text-scale))] font-semibold text-foreground"
      : undefined,
    level === 4
      ? "mb-2 mt-6 text-[calc(1rem*var(--markdown-text-scale))] font-semibold text-foreground"
      : undefined,
    level >= 5
      ? "mb-2 mt-5 text-[calc(1rem*var(--markdown-text-scale))] font-semibold leading-7 text-foreground"
      : undefined,
    className,
  );
}

function markdownElementProps<T extends { node?: unknown }>(props: T) {
  const { node, ...elementProps } = props;

  void node;

  return elementProps;
}

function dataAttribute(
  props: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = props[key];

  return typeof value === "string" ? value : undefined;
}

function parseExtendedMarkdownHeading(children: unknown) {
  if (typeof children !== "string") {
    return null;
  }

  const match = children.match(/^(#{7,10})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);

  if (!match) {
    return null;
  }

  return {
    level: match[1].length,
    text: match[2],
  };
}

function openExternalLink(href: string) {
  window.open(href, "_blank", "noopener,noreferrer");
}

function MarkdownRendererContent({
  className,
  content,
  documentPath,
  onOpenExternalLink,
  onOpenFileLink,
  textScale = 1,
}: MarkdownRendererProps) {
  const normalizedContent = useMemo(
    () => normalizeMarkdownHighlightDelimiters(content),
    [content],
  );
  const scaledFontStyle = {
    "--markdown-text-scale": textScale,
  } as CSSProperties;

  return (
    <div className={className} style={scaledFontStyle}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeKatex]}
        components={{
          h1: ({ children, className, ...props }) => (
            <h1
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(1, className)}
            >
              {children}
            </h1>
          ),
          h2: ({ children, className, ...props }) => (
            <h2
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(2, className)}
            >
              {children}
            </h2>
          ),
          h3: ({ children, className, ...props }) => (
            <h3
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(3, className)}
            >
              {children}
            </h3>
          ),
          h4: ({ children, className, ...props }) => (
            <h4
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(4, className)}
            >
              {children}
            </h4>
          ),
          h5: ({ children, className, ...props }) => (
            <h5
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(5, className)}
            >
              {children}
            </h5>
          ),
          h6: ({ children, className, ...props }) => (
            <h6
              {...markdownElementProps(props)}
              className={markdownHeadingClassName(6, className)}
            >
              {children}
            </h6>
          ),
          p: ({ children, className, ...props }) => {
            const extendedHeading = parseExtendedMarkdownHeading(children);

            if (extendedHeading) {
              return (
                <div
                  {...markdownElementProps(props)}
                  aria-level={extendedHeading.level}
                  className={markdownHeadingClassName(
                    extendedHeading.level,
                    className,
                  )}
                  role="heading"
                >
                  {extendedHeading.text}
                </div>
              );
            }

            return (
              <p
                {...markdownElementProps(props)}
                className={classNames(
                  "mb-4 text-[calc(1rem*var(--markdown-text-scale))] leading-7 text-foreground",
                  className,
                )}
              >
                {children}
              </p>
            );
          },
          blockquote: ({ children, className, ...props }) => (
            <blockquote
              {...markdownElementProps(props)}
              className={classNames(
                "mb-4 border-l-4 border-input bg-muted py-3 pl-4 pr-5 text-[calc(1rem*var(--markdown-text-scale))] text-foreground [&>p:last-child]:mb-0",
                className,
              )}
            >
              {children}
            </blockquote>
          ),
          ul: ({ children, className, ...props }) => (
            <ul
              {...markdownElementProps(props)}
              className={classNames(
                "mb-4 list-disc space-y-2 pl-5 text-[calc(1rem*var(--markdown-text-scale))] text-foreground",
                className,
              )}
            >
              {children}
            </ul>
          ),
          ol: ({ children, className, ...props }) => (
            <ol
              {...markdownElementProps(props)}
              className={classNames(
                "mb-4 list-decimal space-y-2 pl-5 text-[calc(1rem*var(--markdown-text-scale))] text-foreground",
                className,
              )}
            >
              {children}
            </ol>
          ),
          code: ({ children, className, ...props }) => (
            <code
              {...markdownElementProps(props)}
              className={classNames(
                "rounded bg-muted px-1.5 py-0.5 font-mono text-[calc(0.875rem*var(--markdown-text-scale))] text-foreground",
                className,
              )}
            >
              {children}
            </code>
          ),
          mark: ({ children, className, style, ...props }) => {
            const elementProps = markdownElementProps(props);
            const highlightColor = dataAttribute(
              elementProps as Record<string, unknown>,
              "data-markdown-highlight-color",
            );
            const highlightForeground = dataAttribute(
              elementProps as Record<string, unknown>,
              "data-markdown-highlight-foreground",
            );
            const customHighlightStyle =
              highlightColor &&
              highlightForeground &&
              isSafeMarkdownTextColor(highlightColor) &&
              isSafeMarkdownTextColor(highlightForeground)
                ? {
                    ...style,
                    backgroundColor: highlightColor,
                    color: highlightForeground,
                  }
                : style;

            return (
              <mark
                {...elementProps}
                className={classNames(
                  "box-decoration-clone rounded bg-[var(--markdown-highlight)] px-1 py-0.5 text-[var(--markdown-highlight-foreground)]",
                  className,
                )}
                style={customHighlightStyle}
              >
                {children}
              </mark>
            );
          },
          span: ({ children, className, style, ...props }) => {
            const elementProps = markdownElementProps(props);
            const markdownColor = dataAttribute(
              elementProps as Record<string, unknown>,
              "data-markdown-color",
            );
            const textColor =
              markdownColor && isSafeMarkdownTextColor(markdownColor)
                ? markdownColor
                : undefined;

            return (
              <span
                {...elementProps}
                className={classNames(
                  textColor ? "markdown-text-color" : undefined,
                  className,
                )}
                style={textColor ? { ...style, color: textColor } : style}
              >
                {children}
              </span>
            );
          },
          u: ({ children, className, ...props }) => (
            <u
              {...markdownElementProps(props)}
              className={classNames(
                "underline decoration-foreground/60 underline-offset-2",
                className,
              )}
            >
              {children}
            </u>
          ),
          table: ({ children, className, ...props }) => (
            <div className="mb-4 overflow-x-auto rounded-lg border border-border">
              <table
                {...markdownElementProps(props)}
                className={classNames(
                  "w-full border-collapse text-left text-[calc(0.875rem*var(--markdown-text-scale))]",
                  className,
                )}
              >
                {children}
              </table>
            </div>
          ),
          thead: ({ children, className, ...props }) => (
            <thead
              {...markdownElementProps(props)}
              className={classNames("bg-muted text-foreground", className)}
            >
              {children}
            </thead>
          ),
          th: ({ align, children, className, ...props }) => (
            <th
              {...markdownElementProps(props)}
              className={classNames(
                "border-b border-r border-border px-3 py-2 font-semibold last:border-r-0",
                className,
              )}
              style={tableCellStyle(align)}
            >
              {children}
            </th>
          ),
          td: ({ align, children, className, ...props }) => (
            <td
              {...markdownElementProps(props)}
              className={classNames(
                "border-b border-r border-border px-3 py-2 align-top text-foreground last:border-r-0",
                className,
              )}
              style={tableCellStyle(align)}
            >
              {children}
            </td>
          ),
          tr: ({ children, className, ...props }) => (
            <tr
              {...markdownElementProps(props)}
              className={classNames("last:[&>td]:border-b-0", className)}
            >
              {children}
            </tr>
          ),
          img: ({ alt, className, src, ...props }) => (
            // eslint-disable-next-line @next/next/no-img-element -- Markdown images may be authenticated local assets.
            <img
              {...markdownElementProps(props)}
              className={classNames(
                "my-4 max-h-[560px] max-w-full rounded-lg border border-border object-contain",
                className,
              )}
              src={resolveMarkdownImageSource(
                typeof src === "string" ? src : undefined,
                documentPath,
              )}
              alt={alt ?? ""}
            />
          ),
          a: ({ children, className, href, ...props }) => (
            <a
              {...markdownElementProps(props)}
              className={classNames(
                "font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:text-accent",
                className,
              )}
              href={href}
              onClick={(event) => {
                if (!href) {
                  return;
                }

                if (
                  documentPath &&
                  onOpenFileLink &&
                  isLikelyWorkspaceMarkdownLink(href)
                ) {
                  event.preventDefault();
                  void onOpenFileLink(href);
                  return;
                }

                if (isExternalMarkdownLink(href)) {
                  event.preventDefault();
                  (onOpenExternalLink ?? openExternalLink)(href);
                }
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownRenderer = memo(MarkdownRendererContent);
MarkdownRenderer.displayName = "MarkdownRenderer";
