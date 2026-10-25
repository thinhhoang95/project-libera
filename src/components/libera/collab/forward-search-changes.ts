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
          void fetch("/api/transcripts/sidecars", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ moves, removed }),
          }).catch(() => undefined);
        }
        // PDFs' local side-cars (annotations, outline, definitions) too.
        const pdfMoves = event.moves.filter((move) => PDF_PATH.test(move.from));
        const pdfRemoved = event.removed.filter((path) => PDF_PATH.test(path));
        if (pdfMoves.length || pdfRemoved.length) {
          void fetch("/api/pdf-sidecars", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ moves: pdfMoves, removed: pdfRemoved }),
          }).catch(() => undefined);
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
