// Overlay suggestions in the Visual (Tiptap) editor (plan M3.1).
//
// Each suggestion group becomes one agentic-review style preview: its
// resolved ranges are turned into source-offset edits and handed to
// `tiptapReviewChanges`, which re-parses only the touched blocks and diffs
// them against the live nodes. The result is ordinary `mode: "preview"`
// TrackedChanges, so the change bar, keyboard shortcuts and Accept/Reject
// buttons work unchanged; `group` is the suggestion groupId, which the
// `decide` callback receives and the app turns into server decisions.

import type { Editor } from "@tiptap/core";
import type { ReviewEdit } from "../../markdown-review";
import type { ChangeAuthor, TrackedChange } from "../../tiptap-changes";
import { tiptapReviewChanges } from "../../tiptap-review";
import type * as Y from "yjs";
import type { SuggestionRecord } from "../protocol/schema";
import { groupSuggestions, listSuggestions, resolveSuggestions, type ResolvedSuggestion, type SuggestionsTarget } from "./model";

export interface TiptapSuggestionOptions {
  /** Display name and colour of a suggestion's account (for AI, the user it acted for). */
  author: (record: SuggestionRecord) => { name: string; color: string };
  /** Label shown next to the author; defaults to the suggestion's title. */
  label?: (record: SuggestionRecord) => string;
}

/**
 * The source-offset edit for a resolved suggestion. Insertions are widened
 * by one neighbouring character so they fall inside a source block (an
 * insertion exactly at a block boundary belongs to no block).
 */
export function suggestionEdit(source: string, item: ResolvedSuggestion): ReviewEdit | null {
  const { start, end, record } = item;
  if (end > source.length || source.slice(start, end) !== record.baseQuote) return null;
  if (start < end) return { start, end, before: record.baseQuote, after: record.replacement };
  if (start > 0) return { start: start - 1, end, before: source[start - 1], after: source[start - 1] + record.replacement };
  if (source.length) return { start, end: start + 1, before: source[start], after: record.replacement + source[start] };
  return null;
}

/**
 * Preview TrackedChanges for pending, non-stale suggestions. Stale ones are
 * left to the Suggestions panel rather than drawn over text that changed.
 * `source` must be the Markdown the editor currently shows (the Y.Text).
 */
export function overlaySuggestionsToTrackedChanges(editor: Editor, source: string, resolved: readonly ResolvedSuggestion[], options: TiptapSuggestionOptions): TrackedChange[] {
  const groups = groupSuggestions(resolved.filter((item) => item.record.status === "pending"));
  const proposals: { id: string; label: string; edits: ReviewEdit[] }[] = [];
  const meta = new Map<string, { author: ChangeAuthor; createdAt: number }>();
  for (const group of groups) {
    if (group.isStale) continue;
    const edits = group.suggestions.map((item) => suggestionEdit(source, item));
    if (edits.some((edit) => !edit)) continue;
    const sorted = (edits as ReviewEdit[]).sort((a, b) => a.start - b.start);
    // Widened insertions can overlap a neighbour; such groups stay in the panel.
    if (sorted.some((edit, index) => index > 0 && sorted[index - 1].end > edit.start)) continue;
    const first = group.suggestions[0].record;
    const author = options.author(first);
    meta.set(group.id, {
      author: { name: author.name, color: author.color, kind: first.actor.kind === "ai" ? "ai" : "user" },
      createdAt: Math.min(...group.suggestions.map((item) => item.record.createdAt)),
    });
    proposals.push({ id: group.id, label: options.label?.(first) ?? first.title ?? "", edits: sorted });
  }
  if (!proposals.length) return [];
  return tiptapReviewChanges(editor, source, proposals).map((change) => {
    const info = meta.get(change.group);
    return info ? { ...change, author: info.author, createdAt: info.createdAt } : change;
  });
}

/** Convenience: resolve the annotations doc's suggestions and build the preview. */
export function tiptapSuggestionPreview(editor: Editor, ytext: Y.Text, annotations: SuggestionsTarget, options: TiptapSuggestionOptions): TrackedChange[] {
  const resolved = resolveSuggestions(ytext, listSuggestions(annotations, { status: "pending" }));
  return overlaySuggestionsToTrackedChanges(editor, ytext.toString(), resolved, options);
}
