"use client";

import { AlertTriangle, BookMarked, X } from "lucide-react";
import { useEffect } from "react";
import type { ReferenceMoveResult } from "@/lib/references/moves";

// What a cross-notebook move did to the references (src/lib/references/moves.ts),
// as a notice at the bottom of the window: "Copied 3 references to Beta ·
// 1 key renamed (smith2020 → smith2020a)". A failed copy is a warning; the
// move itself succeeded.

export type ReferenceMoveNoticeState = { id: number; tone: "info" | "warning"; text: string };

export const REFERENCE_MOVE_NOTICE_MS = 8000;

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** The notice for a move's `references` result, or null when the move touched no reference. */
export function referenceMoveSummary(result: ReferenceMoveResult, destinationNotebook: string): Omit<ReferenceMoveNoticeState, "id"> | null {
  if (result.error) {
    return { tone: "warning", text: `Moved, but the references it cites could not be copied to ${destinationNotebook}: ${result.error}` };
  }
  const parts: string[] = [];
  if (result.copied.length) parts.push(`Copied ${plural(result.copied.length, "reference", "references")} to ${destinationNotebook}`);
  else if (result.reused.length) parts.push(`${destinationNotebook} already had the ${plural(result.reused.length, "reference", "references")} it cites`);
  if (result.renamed.length) {
    const shown = result.renamed.slice(0, 3).map((rename) => `${rename.from} → ${rename.to}`).join(", ");
    const more = result.renamed.length > 3 ? `, +${result.renamed.length - 3} more` : "";
    parts.push(`${plural(result.renamed.length, "key", "keys")} renamed (${shown}${more})`);
  }
  return parts.length ? { tone: "info", text: parts.join(" · ") } : null;
}

export function ReferenceMoveNotice({ notice, onDismiss }: { notice: ReferenceMoveNoticeState | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!notice || notice.tone === "warning") return;
    const timer = window.setTimeout(onDismiss, REFERENCE_MOVE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);
  if (!notice) return null;
  const Icon = notice.tone === "warning" ? AlertTriangle : BookMarked;
  return (
    <div
      role={notice.tone === "warning" ? "alert" : "status"}
      aria-label="References moved"
      data-tone={notice.tone}
      className={`fixed bottom-4 left-1/2 z-50 flex max-w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-2xl border px-4 py-2 text-sm shadow-lg ${notice.tone === "warning" ? "border-destructive/40 bg-destructive-muted text-destructive" : "border-border bg-card"}`}
    >
      <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{notice.text}</span>
      <button type="button" className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={onDismiss}>
        <X aria-hidden className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
