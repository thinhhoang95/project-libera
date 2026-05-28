"use client";

import type { CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

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

export function MarkdownRenderer({
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
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-4 text-[calc(1.875rem*var(--markdown-text-scale))] font-semibold tracking-tight text-zinc-950">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-3 mt-8 text-[calc(1.25rem*var(--markdown-text-scale))] font-semibold text-zinc-900">
              {children}
            </h2>
          ),
          p: ({ children }) => (
            <p className="mb-4 text-[calc(1rem*var(--markdown-text-scale))] leading-7 text-zinc-700">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="mb-4 list-disc space-y-2 pl-5 text-[calc(1rem*var(--markdown-text-scale))] text-zinc-700">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-4 list-decimal space-y-2 pl-5 text-[calc(1rem*var(--markdown-text-scale))] text-zinc-700">
              {children}
            </ol>
          ),
          code: ({ children }) => (
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[calc(0.875rem*var(--markdown-text-scale))] text-zinc-900">
              {children}
            </code>
          ),
          table: ({ children }) => (
            <div className="mb-4 overflow-x-auto rounded-md border border-zinc-200">
              <table className="w-full border-collapse text-left text-[calc(0.875rem*var(--markdown-text-scale))]">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-zinc-100 text-zinc-900">{children}</thead>
          ),
          th: ({ align, children }) => (
            <th
              className="border-b border-r border-zinc-200 px-3 py-2 font-semibold last:border-r-0"
              style={tableCellStyle(align)}
            >
              {children}
            </th>
          ),
          td: ({ align, children }) => (
            <td
              className="border-b border-r border-zinc-200 px-3 py-2 align-top text-zinc-700 last:border-r-0"
              style={tableCellStyle(align)}
            >
              {children}
            </td>
          ),
          tr: ({ children }) => (
            <tr className="last:[&>td]:border-b-0">{children}</tr>
          ),
          img: ({ alt, src }) => (
            // eslint-disable-next-line @next/next/no-img-element -- Markdown images may be authenticated local assets.
            <img
              className="my-4 max-h-[560px] max-w-full rounded-md border border-zinc-200 object-contain"
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
