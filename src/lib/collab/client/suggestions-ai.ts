// AI features on shared tabs write suggestions, not text (plan M3.4).
//
// Rewrite, Write, Format and Image to Markdown compute a replacement for a
// range of the text they were given. On a shared tab that result becomes an
// overlay suggestion with an AI actor acting for the user, so collaborators
// see it, it shows inline with Accept and Reject, and accepting it is a
// server decision (a commenter's AI suggestion simply stays pending). These
// helpers give each editor the same entry point:
//
// - CodeMirror editors (LaTeX, code, Markdown Source) find it through the
//   `sharedSuggester` facet the shared binding provides;
// - the Visual editor gets it with its bridge, which maps editor positions
//   to source offsets;
// - the Source routes in the workspace hook call the controller directly.

import { Facet } from "@codemirror/state";
import type { AiFeature } from "../protocol/actor";
import type { SnapshotEdit } from "../suggestions/model";
import type { SharedDocRegistry } from "./registry";
import { suggestionsFor, type AiSuggestionHint, type CreateSuggestionsResult } from "./suggestions";

export interface SharedSuggester {
  canSuggest(): boolean;
  suggest(start: number, end: number, replacement: string): CreateSuggestionsResult;
  suggestAi(snapshot: string, edits: readonly SnapshotEdit[], hint: AiSuggestionHint): CreateSuggestionsResult;
}

/** Present on CodeMirror views bound to a shared document. */
export const sharedSuggester = Facet.define<SharedSuggester, SharedSuggester | null>({ combine: (values) => values[0] ?? null });

/**
 * The Source-mode AI routes on a tab: null when the tab is not (yet) a
 * shared document, so the caller takes its regular draft path. `edit` is in
 * offsets of `base`, the draft the AI was given.
 */
export function suggestAiOnSharedTab(registry: SharedDocRegistry, tabId: string, base: string, edit: SnapshotEdit, feature: AiFeature): CreateSuggestionsResult | null {
  const session = registry.sessionForTab(tabId);
  return session ? suggestionsFor(session).suggestAi(base, [edit], { feature }) : null;
}

/** What to tell the user after an AI suggestion was (or was not) created; null when nothing needs saying. */
export function aiSuggestionNotice(result: CreateSuggestionsResult): string | null {
  if (!result.ok) return result.message;
  if (result.conflicted && !result.matched) return "The text changed while AI was working, so its suggestion is marked as conflicted. Review it in the Suggestions panel.";
  if (result.conflicted) return "Part of the text changed while AI was working; those suggestions are marked as conflicted.";
  return null;
}

/**
 * The source range of an image for AI Image to Markdown: the mapped range
 * when it holds the image's Markdown, else the `![…](src)` nearest to it.
 */
export function imageSourceRange(source: string, start: number, end: number, src: string): { start: number; end: number } {
  const slice = source.slice(start, end);
  if (slice.includes("![") && slice.includes(src)) return { start, end };
  const pattern = /!\[[^\]\n]*\]\(([^)\n]*)\)/g;
  let best: { start: number; end: number; distance: number } | null = null;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (!match[1].split(/\s+/)[0].includes(src) && !src.includes(match[1].split(/\s+/)[0])) continue;
    const distance = Math.abs(match.index - start);
    if (!best || distance < best.distance) best = { start: match.index, end: match.index + match[0].length, distance };
  }
  return best ? { start: best.start, end: best.end } : { start, end };
}
