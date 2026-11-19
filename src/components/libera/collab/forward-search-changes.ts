"use client";

import { useEffect } from "react";
import { subscribeHostEvents } from "@/lib/collab/ui/bridge";

// The collab host writes shared notebooks' working copies itself, outside
// Libera's storage layer, so the search index would not notice collaborators'
// edits until its next full scan. Forward the host's files-changed paths to the
// indexer, batched: the host already coalesces writes, and the indexer dedupes.
const FORWARD_DELAY_MS = 1_000;
const AUDIO_PATH = /\.(m4a|mp3|wav|aac|ogg|oga|opus|flac|webm)$/i;
const PDF_PATH = /\.pdf$/i;

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
      // Recordings' local sidecars (waveform, unshared transcript) follow renames and deletions.
      if (event.t === "tree-changed") {
        const moves = event.moves.filter((move) => AUDIO_PATH.test(move.from));
        const removed = event.removed.filter((path) => AUDIO_PATH.test(path));
        if (moves.length || removed.length) {
          void postSidecarChanges("/api/transcripts/sidecars", { moves, removed });
        }
        // PDFs' local side-cars (annotations, outline, definitions) too.
        const pdfMoves = event.moves.filter((move) => PDF_PATH.test(move.from));
        const pdfRemoved = event.removed.filter((path) => PDF_PATH.test(path));
        if (pdfMoves.length || pdfRemoved.length) {
          void postSidecarChanges("/api/pdf-sidecars", { moves: pdfMoves, removed: pdfRemoved });
        }
      }
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
