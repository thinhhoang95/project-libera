"use client";

import type { CSSProperties } from "react";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkMarkdownSourceMap } from "@/lib/markdown-source-map";

type MarkdownRendererProps = {
  content: string;
  documentPath?: string;
  textScale?: number;
};

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

function markdownElementProps<T extends { node?: unknown }>(props: T) {
  const { node, ...elementProps } = props;

  void node;

  return elementProps;
}

function MarkdownRendererContent({
  content,
  documentPath,
  textScale = 1,
}: MarkdownRendererProps) {
  const scaledFontStyle = {
    "--markdown-text-scale": textScale,
  } as CSSProperties;

  return (
    <div style={scaledFontStyle}>
      <ReactMarkdown
        remarkPlugins={[remarkMarkdownSourceMap, remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          h1: ({ children, className, ...props }) => (
            <h1
              {...markdownElementProps(props)}
              className={classNames(
                "mb-4 text-[calc(1.875rem*var(--markdown-text-scale))] font-semibold tracking-tight text-zinc-950",
                className,
              )}
            >
              {children}
            </h1>
          ),
          h2: ({ children, className, ...props }) => (
            <h2
              {...markdownElementProps(props)}
              className={classNames(
                "mb-3 mt-8 text-[calc(1.25rem*var(--markdown-text-scale))] font-semibold text-zinc-900",
                className,
              )}
            >
              {children}
            </h2>
          ),
          p: ({ children, className, ...props }) => (
            <p
              {...markdownElementProps(props)}
              className={classNames(
                "mb-4 text-[calc(1rem*var(--markdown-text-scale))] leading-7 text-zinc-700",
                className,
              )}
            >
              {children}
            </p>
          ),
          blockquote: ({ children, className, ...props }) => (
            <blockquote
              {...markdownElementProps(props)}
              className={classNames(
                "mb-4 border-l-4 border-zinc-300 bg-zinc-50 py-3 pl-4 pr-5 text-[calc(1rem*var(--markdown-text-scale))] text-zinc-700 [&>p:last-child]:mb-0",
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
                "mb-4 list-disc space-y-2 pl-5 text-[calc(1rem*var(--markdown-text-scale))] text-zinc-700",
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
                "mb-4 list-decimal space-y-2 pl-5 text-[calc(1rem*var(--markdown-text-scale))] text-zinc-700",
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
                "rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[calc(0.875rem*var(--markdown-text-scale))] text-zinc-900",
                className,
              )}
            >
              {children}
            </code>
          ),
          table: ({ children, className, ...props }) => (
            <div className="mb-4 overflow-x-auto rounded-md border border-zinc-200">
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
              className={classNames("bg-zinc-100 text-zinc-900", className)}
            >
              {children}
            </thead>
          ),
          th: ({ align, children, className, ...props }) => (
            <th
              {...markdownElementProps(props)}
              className={classNames(
                "border-b border-r border-zinc-200 px-3 py-2 font-semibold last:border-r-0",
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
                "border-b border-r border-zinc-200 px-3 py-2 align-top text-zinc-700 last:border-r-0",
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
                "my-4 max-h-[560px] max-w-full rounded-md border border-zinc-200 object-contain",
                className,
              )}
              src={resolveMarkdownImageSource(
                typeof src === "string" ? src : undefined,
                documentPath,
              )}
              alt={alt ?? ""}
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownRenderer = memo(MarkdownRendererContent);
MarkdownRenderer.displayName = "MarkdownRenderer";
