// How authors are named in comments and history (map §4: AI actors act on
// behalf of a user and are shown as such).

import type { Actor, AiFeature } from "../protocol/actor";
import type { UserSummary } from "../protocol/api";

const FEATURE_LABELS: Record<AiFeature, string> = {
  rewrite: "AI rewrite",
  write: "AI write",
  format: "AI format",
  "image-to-markdown": "AI image to Markdown",
  "agentic-review": "AI review",
  agent: "AI agent",
  "review-comments": "AI review comments",
};

export function aiFeatureLabel(feature: AiFeature | undefined): string {
  return feature ? FEATURE_LABELS[feature] ?? "AI" : "AI";
}

/** "Minh" for a person, "AI · requested by Minh" for an AI actor on Minh's behalf. */
export function commentAuthorLabel(actor: Actor | null | undefined, author: UserSummary): string {
  if (actor?.kind === "ai") return `AI · requested by ${author.displayName}`;
  return author.displayName;
}

/** One or two initials for an avatar. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? [...words[words.length - 1]][0] ?? "" : "";
  return (first + last).toUpperCase();
}
