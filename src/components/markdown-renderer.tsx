"use client";

import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

type MarkdownRendererProps = {
  content: string;
};

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
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
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
