"use client";

import { useEffect } from "react";
import { subscribeHostEvents } from "@/lib/collab/ui/bridge";

// The collab host writes shared notebooks' working copies itself, outside
// Libera's storage layer, so the search index would not notice collaborators'
// edits until its next full scan. Forward the host's files-changed paths to the
// indexer, batched: the host already coalesces writes, and the indexer dedupes.
const FORWARD_DELAY_MS = 1_000;

export function useForwardSharedFileChanges(): void {
  useEffect(() => {
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const paths = [...pending].slice(0, 500);
      pending.clear();
      if (paths.length === 0) return;
      void fetch("/api/search/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths }),
      }).catch(() => {
        // Best effort: the indexer's periodic scan catches anything missed.
      });
    };
    const stop = subscribeHostEvents((event) => {
      if (event.t !== "files-changed" && event.t !== "tree-changed") return;
      const paths = event.t === "files-changed" ? event.paths : [...event.added, ...event.moves.flatMap((move) => [move.from, move.to]), ...event.removed];
      for (const path of paths) pending.add(path);
      timer ??= setTimeout(flush, FORWARD_DELAY_MS);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
