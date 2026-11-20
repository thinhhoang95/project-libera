"use client";

import { useEffect } from "react";
import { subscribeHostEvents } from "@/lib/collab/ui/bridge";

// The collab host writes shared notebooks' working copies itself, outside
// Libera's storage layer, so the search index would not notice collaborators'
// edits until its next full scan. Forward the host's files-changed paths to the
// indexer, batched: the host already coalesces writes, and the indexer dedupes.
const FORWARD_DELAY_MS = 1_000;

/** The sidecar endpoints reject a request with more changes than this. */
export const SIDECAR_CHUNK = 500;
const SIDECAR_RETRY_DELAYS_MS = [1_000, 4_000, 15_000];

type SidecarChanges = { moves: Array<{ from: string; to: string }>; removed: string[] };

/** The changes in requests of at most SIDECAR_CHUNK entries, moves first. */
export function chunkSidecarChanges({ moves, removed }: SidecarChanges): SidecarChanges[] {
  const entries = [
    ...moves.map((move) => ({ move })),
    ...removed.map((path) => ({ path })),
  ];
  const chunks: SidecarChanges[] = [];
  for (let start = 0; start < entries.length; start += SIDECAR_CHUNK) {
    const part = entries.slice(start, start + SIDECAR_CHUNK);
    chunks.push({
      moves: part.flatMap((entry) => ("move" in entry ? [entry.move] : [])),
      removed: part.flatMap((entry) => ("path" in entry ? [entry.path] : [])),
    });
  }
  return chunks;
}

/**
 * Sends sidecar changes in endpoint-sized requests, checks every response, and
 * retries a failed one a few times: a rejected or dropped request would
 * otherwise lose a move for good. Resolves to whether every chunk was accepted.
 */
export async function postSidecarChanges(url: string, changes: SidecarChanges, delays: number[] = SIDECAR_RETRY_DELAYS_MS): Promise<boolean> {
  let allSent = true;
  for (const chunk of chunkSidecarChanges(changes)) {
    let sent = false;
    for (let attempt = 0; attempt <= delays.length && !sent; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
      try {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chunk) });
        sent = response.ok;
      } catch { /* Offline or restarting: try again. */ }
    }
    if (!sent) allSent = false;
  }
  return allSent;
}

/** Tells Next a shared notebook's records may have moves to follow; the host's log carries them, this carries nothing. Failures cost nothing: the next nudge, operation or Check Notebook drains it. */
function nudgeRecords(body: { notebook: string } | { all: true }): void {
  void fetch("/api/shared-records", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
}

export function useForwardSharedFileChanges(): void {
  useEffect(() => {
    const pending = new Set<string>();
    const nudged = new Set<string>();
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A window opened: moves made while none was are in the log.
    nudgeRecords({ all: true });
    const flushNudges = () => {
      nudgeTimer = null;
      for (const notebook of nudged) nudgeRecords({ notebook });
      nudged.clear();
    };
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
      // Every record kept for a moved or removed file follows through the host's durable log: the event only says Next should read it, once per burst.
      if (event.t === "tree-changed" && (event.moves.length || event.removed.length)) {
        nudged.add(event.notebook);
        nudgeTimer ??= setTimeout(flushNudges, FORWARD_DELAY_MS);
      }
      const paths = event.t === "files-changed" ? event.paths : [...event.added, ...event.moves.flatMap((move) => [move.from, move.to]), ...event.removed];
      for (const path of paths) pending.add(path);
      timer ??= setTimeout(flush, FORWARD_DELAY_MS);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
      if (nudgeTimer) clearTimeout(nudgeTimer);
    };
  }, []);
}
