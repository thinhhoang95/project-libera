"use client";

import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

type MarkdownRendererProps = {
  content: string;
  documentPath?: string;
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

export function MarkdownRenderer({ content, documentPath }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        h1: ({ children }) => (
          <h1 className="mb-4 text-3xl font-semibold tracking-tight text-zinc-950">
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className="mb-3 mt-8 text-xl font-semibold text-zinc-900">
            {children}
          </h2>
        ),
        p: ({ children }) => (
          <p className="mb-4 leading-7 text-zinc-700">{children}</p>
        ),
        ul: ({ children }) => (
          <ul className="mb-4 list-disc space-y-2 pl-5 text-zinc-700">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-4 list-decimal space-y-2 pl-5 text-zinc-700">
            {children}
          </ol>
        ),
        code: ({ children }) => (
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-sm text-zinc-900">
            {children}
          </code>
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
  );
}
