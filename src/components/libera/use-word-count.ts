"use client";

import { useEffect, useRef, useState } from "react";
import { getMarkdownWordCountStats } from "@/lib/markdown-word-count";

export const WORD_COUNT_DELAY_MS = 750;

export function useWordCount(content: string) {
  const [stats, setStats] = useState(() => getMarkdownWordCountStats(content));
  const countedContent = useRef(content);

  useEffect(() => {
    if (content === countedContent.current) return;
    // Count only after editing pauses; keep the previous totals while typing.
    const timer = setTimeout(() => {
      const nextStats = getMarkdownWordCountStats(content);
      countedContent.current = content;
      setStats(nextStats);
    }, WORD_COUNT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [content]);

  return stats;
}
