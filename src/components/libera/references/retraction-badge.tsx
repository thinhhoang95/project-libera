"use client";

import type { ReferenceEntry, RetractionStatus } from "@/lib/references/types";
import {
  isConcerningRetraction,
  RETRACTION_LABELS,
  retractionBadgeState,
  retractionDescription,
  retractionNoticeUrl,
} from "@/lib/references/retraction";

// Retraction and correction badges (retraction.ts). RetractionBadge is for
// any place that lists entries (the References panel, its cards, the hover
// card); the helpers below give citation chips and bibliography entries
// their classes. Retracted, withdrawn and expression-of-concern entries get
// the warning style, corrected ones a softer note.

/** "warning" for retracted, withdrawn and concern; "note" for corrected; null otherwise. */
export function retractionTone(status: RetractionStatus | undefined | null): "warning" | "note" | null {
  if (isConcerningRetraction(status)) return "warning";
  return status?.state === "corrected" ? "note" : null;
}

/** The class a citation chip adds for its cited entries: the strongest tone among them. */
export function citationRetractionClass(entries: Array<Pick<ReferenceEntry, "retraction"> | undefined>) {
  const tones = entries.map((entry) => retractionTone(entry?.retraction));
  if (tones.includes("warning")) return "libera-citation-retracted";
  if (tones.includes("note")) return "libera-citation-corrected";
  return null;
}

/**
 * A small badge: "Retracted", "Corrected", "Expression of concern" or
 * "Withdrawn", linked to the notice when there is one. Renders nothing for
 * an entry without a notice. `compact` shows the bibliography form
 * ("[Retracted]").
 */
export function RetractionBadge({ status, compact = false, className }: { status: RetractionStatus | undefined | null; compact?: boolean; className?: string }) {
  const state = retractionBadgeState(status);
  if (!state) return null;
  const tone = retractionTone(status);
  const label = compact ? `[${RETRACTION_LABELS[state]}]` : RETRACTION_LABELS[state];
  const url = retractionNoticeUrl(status);
  const title = [retractionDescription(status), status?.checkedAt ? `Checked ${status.checkedAt.slice(0, 10)}` : ""].filter(Boolean).join(" · ");
  const classes = ["libera-retraction-badge", `libera-retraction-${tone}`, compact ? "libera-retraction-compact" : "", className ?? ""].filter(Boolean).join(" ");
  return url ? (
    <a className={classes} data-retraction-state={state} href={url} target="_blank" rel="noopener noreferrer" title={title}>{label}</a>
  ) : (
    <span className={classes} data-retraction-state={state} title={title}>{label}</span>
  );
}
