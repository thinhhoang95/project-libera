"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { createMarkdownHeadingIndex } from "@/lib/markdown-heading-index";

export function useMarkdownHeadingIndex(markdown: string, onReady: (markdown: string, offsets: number[]) => void) {
  const index = useRef<ReturnType<typeof createMarkdownHeadingIndex> | null>(null);
  const callback = useRef(onReady);
  useLayoutEffect(() => { callback.current = onReady; }, [onReady]);

  useEffect(() => {
    const client = createMarkdownHeadingIndex(
      () => new Worker(new URL("../../lib/markdown-headings.worker.ts", import.meta.url), { type: "module" }),
      (source, offsets) => callback.current(source, offsets),
      async (source) => {
        const { markdownHeadingOffsets } = await import("@/lib/markdown-review");
        return markdownHeadingOffsets(source);
      },
    );
    index.current = client;
    return () => { client.dispose(); index.current = null; };
  }, []);

  useEffect(() => { index.current?.request(markdown); }, [markdown]);

}
