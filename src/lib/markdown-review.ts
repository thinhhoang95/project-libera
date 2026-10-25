import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ChatContext } from "./document-chat";

export type ReviewRange = { start: number; end: number };
export type ReviewBlock = ReviewRange & { id: string; type: string; text: string };
export type ReviewAnchor = ReviewRange & { quote: string; prefix: string; suffix: string; state: "attached" | "orphaned" | "ambiguous" };
/**
 * `author` is "agent" for comments Agent mode left; the user's own have none.
 * `by` names who wrote a shared thread's message, for Agentic Review's model.
 */
export type ReviewMessage = { id: string; text: string; createdAt: string; author?: "agent"; by?: string };
export type ReviewThread = { id: string; anchor: ReviewAnchor; messages: ReviewMessage[]; status: "open" | "addressed" | "resolved" };
export type ReviewPlan = { version: number; summary: string; steps: { commentIds: string[]; targetBlockIds: string[]; proposedChange: string; rationale: string }[]; dispositions: { commentId: string; reason: string; reply?: string }[]; blockingQuestions: string[]; revisionSummary: string };
export type ReviewEdit = ReviewRange & { before: string; after: string };
export type ReviewSuggestion = { id: string; version: number; title: string; reason: string; commentIds: string[]; edits: ReviewEdit[]; status: "pending" | "accepted" | "rejected" | "superseded" | "conflicted" };
export type ReviewSession = { id: string; phase: "awaiting_confirmation" | "reviewing_changes" | "completed" | "stale"; snapshot: string; commentsKey: string; references: ChatContext[]; selectedIds: string[]; plan: ReviewPlan; suggestions: ReviewSuggestion[]; messages: { role: "user" | "assistant"; text: string }[]; confirmedVersion?: number; replies?: ReviewReply[] };
/**
 * A reply Agentic Review posted in a comment thread when its plan was
 * confirmed: the plan's `reply` for a comment it settled without an edit.
 * `messageId` is the posted message, which `commentsKey` skips so the
 * session's own replies do not make its plan stale. `queued` when a shared
 * document's server could not be reached and the host sends it later.
 */
export type ReviewReply = { commentId: string; messageId: string; text: string; queued?: boolean };
/**
 * A suggested edit the agent left outside any Agentic Review session (the
 * SuggestEdit tool). Same shape as a ReviewSuggestion, plus one anchor per
 * edit, which syncReview maps like a comment's: when an edit's passage can no
 * longer be found exactly, the suggestion is "conflicted".
 *
 * Mapping to the collab overlay's SuggestionRecord (src/lib/collab/suggestions):
 * - one record per edit; several edits share a `groupId` (= this id)
 * - `edits[i].before` -> `baseQuote`, `edits[i].after` -> `replacement`
 * - `anchors[i]` -> `start`/`end` relative positions, resolved from its offsets
 *   (or its quote, prefix and suffix) in the shared text
 * - `commentIds` -> `threadIds`; `title` and `reason` carry over
 * - `author: "agent"` and `runId` -> actor `{ kind: "ai", feature: "agent", runId, onBehalfOf: <user> }`
 * - `createdAt`/`decidedAt` (ISO strings) -> epoch milliseconds
 * - status: pending, accepted and rejected are the same; conflicted -> stale
 *   (`target-removed` when the anchor is orphaned, otherwise `text-changed`);
 *   superseded -> withdrawn.
 */
export type AgentSuggestion = ReviewSuggestion & { anchors: ReviewAnchor[]; author: "agent"; createdAt: string; decidedAt?: string; runId?: string };
/** `kind: "agent"`: an acceptance of agent suggestions, outside any session. */
export type ReviewUndo = { id: string; acceptedIds: string[]; planVersion: number; before: string; after: string; threads: ReviewThread[]; suggestions: ReviewSuggestion[]; kind?: "agent"; agentSuggestions?: AgentSuggestion[] };
export type ReviewDocument = { schemaVersion: 1; id: string; key: string; revision: number; snapshot: string; enabled: boolean; threads: ReviewThread[]; session?: ReviewSession; agentSuggestions?: AgentSuggestion[]; round?: number; previousRounds?: { number: number; session: ReviewSession }[]; undo: ReviewUndo[]; redo?: ReviewUndo[] };

export function startReviewRound(doc: ReviewDocument): ReviewDocument {
  return {
    ...doc,
    round: (doc.round ?? 1) + 1,
    previousRounds: doc.session ? [...(doc.previousRounds ?? []), { number: doc.round ?? 1, session: doc.session }] : doc.previousRounds,
    session: undefined,
    // Acceptance transactions belong to their original round's proposals.
    undo: [],
    redo: [],
  };
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

type MarkdownAstNode = {
  children?: MarkdownAstNode[];
  position?: { start?: { offset?: number } };
  type?: string;
};

export function markdownHeadingOffsets(text: string) {
  const offsets: number[] = [];

  function visit(node: MarkdownAstNode) {
    const offset = node.position?.start?.offset;

    if (node.type === "heading" && typeof offset === "number") {
      offsets.push(offset);
    }

    node.children?.forEach(visit);
  }

  visit(parser.parse(text) as MarkdownAstNode);
  return offsets;
}

export function reviewBlocks(text: string): ReviewBlock[] {
  return parser.parse(text).children.flatMap((node, index) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    return start === undefined || end === undefined ? [] : [{ id: `b${index + 1}`, start, end, type: node.type, text: text.slice(start, end) }];
  });
}
export function paragraphRange(text: string, selection: ReviewRange): ReviewRange | null {
  const blocks = reviewBlocks(text).filter((b) => selection.start === selection.end
    ? b.start <= selection.start && b.end >= selection.start
    : b.start < selection.end && b.end > selection.start);
  return blocks.length ? { start: blocks[0].start, end: blocks.at(-1)!.end } : null;
}
// Non-Markdown sources (LaTeX) have no Markdown block structure: expand the
// selection to the blank-line separated paragraphs it touches instead.
export function plainParagraphRange(text: string, selection: ReviewRange): ReviewRange | null {
  const blocks: ReviewRange[] = [];
  const separator = /\n[ \t]*\n/g;
  let cursor = 0;
  for (const match of [...text.matchAll(separator), null]) {
    const end = match ? match.index : text.length;
    const raw = text.slice(cursor, end), lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) blocks.push({ start: cursor + lead, end: cursor + lead + trimmed.length });
    if (match) cursor = match.index + match[0].length;
  }
  const hit = blocks.filter((b) => selection.start === selection.end ? b.start <= selection.start && b.end >= selection.start : b.start < selection.end && b.end > selection.start);
  return hit.length ? { start: hit[0].start, end: hit.at(-1)!.end } : null;
}
/**
 * The passage a comment attaches to: exactly the selected text (without the
 * whitespace around it), or the whole paragraph under a bare caret (or a
 * selection of only whitespace, taken at its start).
 */
export function commentRange(text: string, selection: ReviewRange, expand: (text: string, selection: ReviewRange) => ReviewRange | null = paragraphRange): ReviewRange | null {
  let { start, end } = selection;
  if (start > end) [start, end] = [end, start];
  start = Math.max(0, start); end = Math.min(text.length, end);
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? { start, end } : expand(text, { start: selection.start, end: selection.start });
}
export function anchorAt(text: string, range: ReviewRange): ReviewAnchor {
  if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > text.length) throw new Error("Select a passage to comment on.");
  return { ...range, quote: text.slice(range.start, range.end), prefix: text.slice(Math.max(0, range.start - 80), range.start), suffix: text.slice(range.end, range.end + 80), state: "attached" };
}
// A conservative single replacement map. Exact matches recover moved blocks;
// ambiguous duplicates are retained as unattached threads, never guessed.
export function textChange(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { start, oldEnd, newEnd, delta: newEnd - oldEnd };
}
// Bounded semantic cache: unchanged candidate blocks keep their parse across
// edits. Source text, including reference definitions, is the exact cache key.
const semanticCache = new Map<string, { signature: string; count: number }>();
let semanticCacheCharacters = 0;
function blockSemantics(text: string) {
  const cached = semanticCache.get(text);
  if (cached) return cached;
  const tree = parser.parse(text);
  const result = {
    signature: JSON.stringify(tree, (key, value) => key === "position" || key === "spread" ? undefined : value),
    count: tree.children.filter((node) => node.position?.start.offset !== undefined && node.position?.end.offset !== undefined).length,
  };
  if (text.length <= 100_000) {
    semanticCache.set(text, result);
    semanticCacheCharacters += text.length + result.signature.length;
    while (semanticCache.size > 2048 || semanticCacheCharacters > 2_000_000) {
      const oldest = semanticCache.keys().next().value!;
      semanticCacheCharacters -= oldest.length + semanticCache.get(oldest)!.signature.length;
      semanticCache.delete(oldest);
    }
  }
  return result;
}
function anchorMappingContext(before: string, after: string) {
  let blocks: ReviewBlock[] | undefined;
  const indexes = new Map<number, Map<string, ReviewRange[]>>();
  return {
    change: textChange(before, after),
    semanticMatches(quote: string) {
      const { signature, count } = blockSemantics(quote);
      if (!count) return [];
      let index = indexes.get(count);
      if (!index) {
        index = new Map();
        blocks ??= reviewBlocks(after);
        for (let i = 0; i + count <= blocks.length; i++) {
          const range = { start: blocks[i].start, end: blocks[i + count - 1].end };
          const key = blockSemantics(after.slice(range.start, range.end)).signature;
          const matches = index.get(key) ?? [];
          matches.push(range);
          index.set(key, matches);
        }
        indexes.set(count, index);
      }
      return index.get(signature) ?? [];
    },
  };
}
export function mapAnchor(anchor: ReviewAnchor, before: string, after: string, context = anchorMappingContext(before, after)): ReviewAnchor {
  if (before === after) return anchor;
  const change = context.change;
  if (anchor.state === "attached" && before.slice(anchor.start, anchor.end) === anchor.quote) {
    if (anchor.end <= change.start) return anchorAt(after, anchor);
    if (anchor.start >= change.oldEnd) return anchorAt(after, { start: anchor.start + change.delta, end: anchor.end + change.delta });
    // Preserve an edited paragraph only when some of its original text survives.
    if (change.start >= anchor.start && change.oldEnd <= anchor.end && (change.start > anchor.start || change.oldEnd < anchor.end)) {
      const end = anchor.end + change.delta;
      if (end > anchor.start) return anchorAt(after, { start: anchor.start, end });
    }
  }
  const matches: number[] = [];
  for (let pos = after.indexOf(anchor.quote); anchor.quote && pos >= 0; pos = after.indexOf(anchor.quote, pos + 1)) matches.push(pos);
  const contextual = matches.filter((pos) => (!anchor.prefix || after.slice(Math.max(0, pos - anchor.prefix.length), pos) === anchor.prefix) && (!anchor.suffix || after.slice(pos + anchor.quote.length, pos + anchor.quote.length + anchor.suffix.length) === anchor.suffix));
  const candidates = contextual.length ? contextual : matches;
  if (candidates.length === 1) return anchorAt(after, { start: candidates[0], end: candidates[0] + anchor.quote.length });
  if (!candidates.length) {
    // Markdown serialization may change delimiters or list spacing without
    // changing the selected blocks. Recover only a unique structural match.
    const semantic = context.semanticMatches(anchor.quote);
    if (semantic.length === 1) return anchorAt(after, semantic[0]);
    if (semantic.length > 1) return { ...anchor, state: "ambiguous" };
  }
  return { ...anchor, state: candidates.length ? "ambiguous" : "orphaned" };
}
/**
 * Maps agent suggestions from one text to the next. An open suggestion is
 * pending only while every edit's passage is found exactly; otherwise it is
 * conflicted (and pending again if the passage comes back, e.g. after undo).
 */
function mapAgentSuggestions(suggestions: AgentSuggestion[], before: string, after: string, context = anchorMappingContext(before, after)): AgentSuggestion[] {
  return suggestions.map((s) => {
    const anchors = s.anchors.map((anchor) => mapAnchor(anchor, before, after, context));
    const edits = s.edits.map((edit, index) => {
      const anchor = anchors[index];
      return anchor?.state === "attached" ? { ...edit, start: anchor.start, end: anchor.end } : edit;
    });
    const open = s.status === "pending" || s.status === "conflicted";
    const intact = anchors.length === edits.length && anchors.every((anchor, index) => anchor.state === "attached" && after.slice(anchor.start, anchor.end) === edits[index].before);
    return { ...s, anchors, edits, status: open ? (intact ? "pending" as const : "conflicted" as const) : s.status };
  });
}
export function commentsKey(threads: ReviewThread[], ids: string[], replies: readonly Pick<ReviewReply, "messageId">[] = []) {
  const own = new Set(replies.map((reply) => reply.messageId));
  return JSON.stringify(threads.filter((t) => ids.includes(t.id)).map((t) => ({ id: t.id, messages: t.messages.filter((m) => !own.has(m.id)), status: t.status === "resolved" ? "resolved" : "open" })));
}
/**
 * The replies a confirmed plan still has to post: its dispositions' replies,
 * except in threads that are gone or resolved (a resolved thread takes no
 * more replies) and threads that already end with the same text.
 */
export function dueReviewReplies(plan: ReviewPlan, threads: readonly ReviewThread[]): { commentId: string; text: string }[] {
  const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
  return plan.dispositions.flatMap((d) => {
    const thread = threads.find((t) => t.id === d.commentId);
    if (!d.reply || !thread || thread.status === "resolved") return [];
    const last = thread.messages.at(-1);
    return last && same(last.text, d.reply) ? [] : [{ commentId: d.commentId, text: d.reply }];
  });
}
export function syncReview(doc: ReviewDocument, snapshot: string, detectHistory = true): ReviewDocument {
  if (doc.snapshot === snapshot) return doc;
  if (detectHistory) {
    const undo = doc.undo.at(-1), redo = doc.redo?.at(-1);
    try {
      if (undo?.after === doc.snapshot && undo.before === snapshot) return undoReview(doc);
      if (redo?.before === doc.snapshot && redo.after === snapshot) return redoReview(doc);
    } catch { /* A newer plan or decision prevents restoration; map conservatively. */ }
  }
  const context = anchorMappingContext(doc.snapshot, snapshot);
  const change = context.change;
  const suggestions = doc.session?.suggestions.map((s) => {
    if (s.status !== "pending" && s.status !== "rejected") return s;
    let conflict = false;
    const edits = s.edits.map((e) => {
      if (e.end <= change.start) return e;
      if (e.start >= change.oldEnd) return { ...e, start: e.start + change.delta, end: e.end + change.delta };
      conflict = true; return e;
    });
    return { ...s, edits, status: conflict && s.status === "pending" ? "conflicted" as const : s.status };
  });
  return { ...doc, snapshot, redo: [], threads: doc.threads.map((t) => ({ ...t, anchor: mapAnchor(t.anchor, doc.snapshot, snapshot, context) })), session: doc.session && { ...doc.session, phase: doc.session.phase === "awaiting_confirmation" ? "stale" : doc.session.phase, suggestions: suggestions! },
    ...(doc.agentSuggestions ? { agentSuggestions: mapAgentSuggestions(doc.agentSuggestions, doc.snapshot, snapshot, context) } : {}) };
}
/**
 * A text change since a review's snapshot: `[start, end)` of the text before
 * it, replaced by `text`. The editor records them as you type, so anchors are
 * mapped through each change in turn (replayReviewEdits) rather than through
 * one change spanning every edit since the review was last stored.
 */
export type ReviewTextEdit = { start: number; end: number; text: string };
export const MAX_REVIEW_EDITS = 200;
/** `edits` plus the change from `before` to `after`, merged into the last edit when the two touch (continuous typing). */
export function addReviewEdit(edits: readonly ReviewTextEdit[], before: string, after: string): ReviewTextEdit[] {
  if (before === after) return [...edits];
  const change = textChange(before, after);
  const last = edits.at(-1);
  // The last edit's replacement text sits at [last.start, lastEnd) of `before`.
  const lastEnd = last ? last.start + last.text.length : -1;
  if (last && change.start <= lastEnd && change.oldEnd >= last.start) {
    const start = Math.min(last.start, change.start);
    const end = change.oldEnd <= lastEnd ? last.end : last.end + change.oldEnd - lastEnd;
    // Everything after `end` in the text before `last` is unchanged in `after`.
    const original = before.length - last.text.length + last.end - last.start;
    return [...edits.slice(0, -1), { start, end, text: after.slice(start, after.length - (original - end)) }];
  }
  return [...edits, { start: change.start, end: change.oldEnd, text: after.slice(change.start, change.newEnd) }];
}
/**
 * `doc` mapped onto `snapshot` through `edits` in turn when they lead from its
 * snapshot to `snapshot`, else (none, too many, or ones that do not apply)
 * through the single change between the two texts.
 */
export function replayReviewEdits(doc: ReviewDocument, edits: unknown, snapshot: string): ReviewDocument {
  if (!Array.isArray(edits) || !edits.length || edits.length > MAX_REVIEW_EDITS) return syncReview(doc, snapshot);
  const texts: string[] = [];
  let text = doc.snapshot;
  for (const edit of edits as Partial<ReviewTextEdit>[]) {
    const { start, end } = edit ?? {};
    if (!Number.isInteger(start) || !Number.isInteger(end) || typeof edit.text !== "string" || start! < 0 || end! < start! || end! > text.length) return syncReview(doc, snapshot);
    text = text.slice(0, start) + edit.text + text.slice(end);
    texts.push(text);
  }
  return text === snapshot ? texts.reduce((mapped, next) => syncReview(mapped, next), doc) : syncReview(doc, snapshot);
}
/**
 * Follows a stored review through the editor's draft: `advance` maps it onto
 * each new draft one small change at a time, so anchors stay as precise as if
 * every change were stored, and records the edits for the server to replay
 * when the review is next written. Calling it again with the same review and
 * draft returns the same result, so it is safe during render.
 */
export class ReviewDraftTracker {
  private base: ReviewDocument | null = null;
  private text = "";
  private mapped: ReviewDocument | null = null;
  private recorded: ReviewTextEdit[] = [];
  advance(doc: ReviewDocument, draft: string): ReviewDocument {
    if (this.base !== doc) { this.base = doc; this.text = doc.snapshot; this.mapped = doc; this.recorded = []; }
    if (this.text !== draft) {
      const edits = addReviewEdit(this.recorded, this.text, draft);
      // Past the limit the server maps the whole change at once; this copy stays precise.
      this.recorded = edits.length > MAX_REVIEW_EDITS ? addReviewEdit([], doc.snapshot, draft) : edits;
      this.mapped = syncReview(this.mapped!, draft);
      this.text = draft;
    }
    return this.mapped!;
  }
  /** How many edits are waiting to be stored. */
  get count() { return this.recorded.length; }
  /** The followed draft: the text `edits()` leads to by default. */
  get draft() { return this.text; }
  /** The edits from `doc`'s snapshot to `text`; none when `doc` is not the review being followed. */
  edits(doc: ReviewDocument, text = this.text): ReviewTextEdit[] {
    if (this.base !== doc) return [];
    const edits = addReviewEdit(this.recorded, this.text, text);
    return edits.length > MAX_REVIEW_EDITS ? [] : edits;
  }
}
export function newReview(key: string, snapshot: string, id: string): ReviewDocument {
  return { schemaVersion: 1, key, id, snapshot, revision: 0, enabled: false, threads: [], undo: [] };
}
export function applyReviewEdits(text: string, edits: ReviewEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  sorted.forEach((e, index) => {
    if (e.start < 0 || e.end <= e.start || e.end > text.length || text.slice(e.start, e.end) !== e.before || (index > 0 && sorted[index - 1].end > e.start)) throw new Error("A proposed passage changed or overlaps another change. Request a revision.");
  });
  return sorted.reverse().reduce((result, e) => result.slice(0, e.start) + e.after + result.slice(e.end), text);
}
// Only threads linked to the decided changes are recomputed, so a comment the
// user reopened is not re-completed by an unrelated decision.
function coverage(threads: ReviewThread[], suggestions: ReviewSuggestion[], decided: string[]) {
  const touched = new Set(suggestions.filter((s) => decided.includes(s.id)).flatMap((s) => s.commentIds));
  return threads.map((t) => {
    if (t.status === "resolved" || !touched.has(t.id)) return t;
    const related = suggestions.filter((s) => s.status !== "superseded" && s.commentIds.includes(t.id));
    if (!related.length) return t;
    return { ...t, status: related.length && related.every((s) => s.status === "accepted") ? "addressed" as const : "open" as const };
  });
}
// An accepted change usually replaces the very passage its comment quoted.
// Attach such comments to the replacement text instead of leaving them orphaned.
function anchorToReplacements(threads: ReviewThread[], prior: ReviewThread[], accepted: ReviewSuggestion[], after: string) {
  let shift = 0;
  const placed = accepted.flatMap((s) => s.edits.map((edit) => ({ edit, commentIds: s.commentIds }))).sort((a, b) => a.edit.start - b.edit.start).map(({ edit, commentIds }) => {
    const start = edit.start + shift;
    shift += edit.after.length - (edit.end - edit.start);
    return { edit, commentIds, start, end: start + edit.after.length };
  });
  return threads.map((t) => {
    if (t.anchor.state === "attached") return t;
    const own = placed.filter((p) => p.commentIds.includes(t.id) && p.end > p.start);
    const was = prior.find((p) => p.id === t.id)?.anchor;
    const target = own.find((p) => was && p.edit.start < was.end && p.edit.end > was.start) ?? own[0];
    return target ? { ...t, anchor: anchorAt(after, target) } : t;
  });
}
export function decideSuggestions(doc: ReviewDocument, ids: string[], decision: "accept" | "reject" | "reopen", transactionId: string): ReviewDocument {
  if (!doc.session || !ids.length || new Set(ids).size !== ids.length) throw new Error("Choose changes to review.");
  const chosen = ids.map((id) => doc.session!.suggestions.find((s) => s.id === id));
  if (chosen.some((s) => !s || (decision === "reopen" ? s.status !== "rejected" : decision === "reject" ? !["pending", "conflicted"].includes(s.status) : s.status !== "pending"))) throw new Error("This change has already been decided or needs revision.");
  const edits = chosen.flatMap((s) => s!.edits);
  const after = decision === "accept" ? applyReviewEdits(doc.snapshot, edits) : doc.snapshot;
  if (decision === "reopen") applyReviewEdits(doc.snapshot, edits);
  let suggestions = doc.session.suggestions.map((s) => ids.includes(s.id) ? { ...s, status: decision === "accept" ? "accepted" as const : decision === "reject" ? "rejected" as const : "pending" as const } : s);
  // Map each independent edit, rather than a single broad diff that would
  // incorrectly conflict pending changes between two accepted replacements.
  let mapped = { ...doc, session: { ...doc.session, suggestions } };
  if (decision === "accept") {
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) mapped = syncReview(mapped, applyReviewEdits(mapped.snapshot, [edit]), false) as typeof mapped;
    suggestions = mapped.session.suggestions;
    mapped.threads = anchorToReplacements(mapped.threads, doc.threads, chosen as ReviewSuggestion[], after);
  }
  return { ...mapped, snapshot: after, redo: decision === "accept" ? [] : doc.redo, threads: coverage(mapped.threads, suggestions, ids), session: { ...mapped.session, suggestions, phase: suggestions.some((s) => s.status === "pending" || s.status === "conflicted") ? "reviewing_changes" : "completed" }, undo: decision === "accept" ? [...doc.undo.slice(-19), { id: transactionId, acceptedIds: ids, planVersion: doc.session.plan.version, before: doc.snapshot, after, threads: doc.threads, suggestions: doc.session.suggestions }] : doc.undo };
}
export function undoReview(doc: ReviewDocument): ReviewDocument {
  const entry = doc.undo.at(-1);
  if (entry?.kind === "agent") return undoAgentAcceptance(doc, entry);
  if (!entry || entry.after !== doc.snapshot || !doc.session) throw new Error("The document changed after this acceptance. Undo later edits first.");
  if ((entry.planVersion !== undefined && entry.planVersion !== doc.session.plan.version) || doc.session.suggestions.some((s) => !entry.suggestions.some((prior) => prior.id === s.id && prior.version === s.version))) throw new Error("Changes were revised after this acceptance. Restore through document editing rather than discard newer review decisions.");
  const acceptedIds = entry.acceptedIds ?? entry.suggestions.filter((s) => s.status === "pending" && doc.session!.suggestions.find((now) => now.id === s.id)?.status === "accepted").map((s) => s.id);
  let suggestions = entry.suggestions.map((prior) => acceptedIds.includes(prior.id) ? prior : { ...prior, status: doc.session!.suggestions.find((s) => s.id === prior.id)?.status ?? prior.status });
  if (doc.session.phase === "stale") suggestions = suggestions.map((s) => s.status === "pending" ? { ...s, status: "conflicted" } : s);
  // Undo only this acceptance, retaining subsequent independent rejections.
  const threads = coverage(doc.threads.map((thread) => {
    const prior = entry.threads.find((t) => t.id === thread.id);
    return { ...thread, anchor: prior?.anchor ?? mapAnchor(thread.anchor, entry.after, entry.before), status: thread.status === "resolved" ? "resolved" : prior?.status ?? thread.status };
  }), suggestions, acceptedIds);
  return { ...doc, snapshot: entry.before, threads, session: { ...doc.session, suggestions, phase: doc.session.phase === "stale" ? "stale" : "reviewing_changes" }, undo: doc.undo.slice(0, -1), redo: [...(doc.redo ?? []), entry],
    ...(doc.agentSuggestions ? { agentSuggestions: mapAgentSuggestions(doc.agentSuggestions, doc.snapshot, entry.before) } : {}) };
}

export function redoReview(doc: ReviewDocument): ReviewDocument {
  const entry = doc.redo?.at(-1);
  if (entry?.kind === "agent") {
    if (entry.before !== doc.snapshot) throw new Error("The document changed after undo. Accept the suggestion again.");
    return { ...decideAgentSuggestions(doc, entry.acceptedIds, "accept", `redo-${entry.id}`), redo: doc.redo!.slice(0, -1) };
  }
  if (!entry || entry.before !== doc.snapshot || doc.session?.plan.version !== entry.planVersion) throw new Error("The document changed after undo. Review the pending proposal again.");
  const next = decideSuggestions(doc, entry.acceptedIds, "accept", `redo-${entry.id}`);
  return { ...next, redo: doc.redo!.slice(0, -1) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}
export function reviewString(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${label}.`);
  return value;
}
function list(value: unknown, max = 200): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid review list.");
  return value;
}
function strings(value: unknown) { return list(value).map((v) => reviewString(v, "text")); }
function validIds(value: unknown, allowed: string[]) {
  const ids = strings(value);
  if (ids.some((id) => !allowed.includes(id))) throw new Error("The response refers to an unknown comment or block.");
  return ids;
}
export function parseReviewJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
}
export function validatePlan(value: unknown, version: number, ids: string[], blocks: ReviewBlock[]): ReviewPlan {
  const p = object(value);
  const steps = list(p.steps).map((raw) => {
    const s = object(raw);
    return { commentIds: validIds(s.commentIds, ids), targetBlockIds: validIds(s.targetBlockIds, blocks.map((b) => b.id)), proposedChange: reviewString(s.proposedChange, "proposed change"), rationale: reviewString(s.rationale, "rationale") };
  });
  const dispositions = list(p.dispositions).map((raw) => {
    const d = object(raw);
    const reply = d.reply === undefined || d.reply === null ? "" : reviewString(d.reply, "reply", 4_000).trim();
    return { commentId: validIds([d.commentId], ids)[0], reason: reviewString(d.reason, "disposition"), ...(reply ? { reply } : {}) };
  });
  if (ids.some((id) => !steps.some((s) => s.commentIds.includes(id)) && !dispositions.some((d) => d.commentId === id))) throw new Error("The plan must address every selected comment.");
  return { version, summary: reviewString(p.summary, "summary"), steps, dispositions, blockingQuestions: strings(p.blockingQuestions), revisionSummary: reviewString(p.revisionSummary, "revision summary") };
}
export function validateSuggestions(value: unknown, text: string, ids: string[], makeId: () => string): ReviewSuggestion[] {
  const blocks = reviewBlocks(text);
  const root = object(value);
  const proposals = list(root.proposals).map((raw): ReviewSuggestion => {
    const p = object(raw);
    const commentIds = validIds(p.commentIds, ids);
    if (!commentIds.length) throw new Error("Each proposal must address a comment.");
    const edits = list(p.edits).map((raw) => {
      const e = object(raw), block = blocks.find((b) => b.id === e.targetBlockId);
      const before = reviewString(e.before, "original passage", 500_000), after = reviewString(e.after, "replacement", 500_000);
      if (!block || !before || before === after) throw new Error("Edits must identify a block and change an exact passage.");
      const index = block.text.indexOf(before);
      if (index < 0 || block.text.indexOf(before, index + 1) >= 0) throw new Error("Original text must match exactly once within its block.");
      return { start: block.start + index, end: block.start + index + before.length, before, after };
    });
    if (!edits.length) throw new Error("A proposal has no edits.");
    return { id: makeId(), version: 1, title: reviewString(p.title, "title", 500), reason: reviewString(p.reason, "reason"), commentIds, edits, status: "pending" };
  });
  if (applyReviewEdits(text, proposals.flatMap((p) => p.edits)).length > 500_000) throw new Error("The proposed document exceeds the 500,000 character review limit.");
  return proposals;
}
export type ReviewIntent = { action: "confirm" } | { action: "accept" | "reject"; numbers: number[] | "all" } | { action: "revise" };
export function reviewIntent(text: string): ReviewIntent {
  const clean = text.trim().replace(/[.!]+$/, "");
  if (/^(?:I\s+)?confirm(?:\s+(?:this|the|latest))?\s+plan(?:\s+\d+)?$/i.test(clean)) return { action: "confirm" };
  const match = /^(accept|reject)\s+(?:all(?:\s+remaining)?(?:\s+changes)?|changes?\s+(\d+(?:(?:\s*,\s*|\s+and\s+)\d+)*))$/i.exec(clean);
  return match ? { action: match[1].toLowerCase() as "accept" | "reject", numbers: match[2] ? match[2].split(/\s*,\s*|\s+and\s+/).map(Number) : "all" } : { action: "revise" };
}

// ---- Agent suggestions: decisions outside any Agentic Review session.

export function agentSuggestionTitle(reason: string) {
  const sentence = reason.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence || "Suggested edit";
}

/**
 * Accept or reject agent suggestions. Accepting applies their edits to the
 * snapshot in one step (the client applies the new snapshot to the editor as
 * one undoable change), remaps everything else, attaches linked comments to
 * the replacement and marks them addressed, and records an undo entry.
 */
export function decideAgentSuggestions(doc: ReviewDocument, ids: string[], decision: "accept" | "reject", transactionId: string, now = new Date().toISOString()): ReviewDocument {
  const all = doc.agentSuggestions ?? [];
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("Choose suggested edits to review.");
  const chosen = ids.map((id) => all.find((s) => s.id === id));
  if (chosen.some((s) => !s || (decision === "accept" ? s.status !== "pending" : s.status !== "pending" && s.status !== "conflicted"))) {
    throw new Error(decision === "accept" ? "This suggested edit was already decided, or its passage changed. Reject it or request a revision." : "This suggested edit was already decided.");
  }
  const picked = chosen as AgentSuggestion[];
  const decided = (s: AgentSuggestion): AgentSuggestion => ids.includes(s.id) ? { ...s, status: decision === "accept" ? "accepted" : "rejected", decidedAt: now } : s;
  if (decision === "reject") return { ...doc, agentSuggestions: all.map(decided) };
  const edits = picked.flatMap((s) => s.edits);
  const after = applyReviewEdits(doc.snapshot, edits);
  // Map each edit separately, last first, so suggestions between two accepted
  // edits keep their passages (as decideSuggestions does).
  let mapped: ReviewDocument = { ...doc, agentSuggestions: all.map(decided) };
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) mapped = syncReview(mapped, applyReviewEdits(mapped.snapshot, [edit]), false);
  const linked = new Set(picked.flatMap((s) => s.commentIds));
  const threads = anchorToReplacements(mapped.threads, doc.threads, picked, after)
    .map((t) => linked.has(t.id) && t.status === "open" ? { ...t, status: "addressed" as const } : t);
  return {
    ...mapped, snapshot: after, threads, redo: [],
    undo: [...doc.undo.slice(-19), { id: transactionId, kind: "agent", acceptedIds: ids, planVersion: doc.session?.plan.version ?? 0, before: doc.snapshot, after, threads: doc.threads, suggestions: doc.session?.suggestions ?? [], agentSuggestions: all }],
  };
}

function undoAgentAcceptance(doc: ReviewDocument, entry: ReviewUndo): ReviewDocument {
  if (entry.after !== doc.snapshot) throw new Error("The document changed after this acceptance. Undo later edits first.");
  const current = doc.agentSuggestions ?? [];
  // Restore the accepted suggestions as they were; keep later decisions on the others.
  const prior = entry.agentSuggestions ?? [];
  const restored = prior.map((s) => entry.acceptedIds.includes(s.id) ? s : { ...s, status: current.find((now) => now.id === s.id)?.status ?? s.status });
  const added = mapAgentSuggestions(current.filter((s) => !prior.some((p) => p.id === s.id)), doc.snapshot, entry.before);
  const threads = doc.threads.map((thread) => {
    const before = entry.threads.find((t) => t.id === thread.id);
    return { ...thread, anchor: before?.anchor ?? mapAnchor(thread.anchor, entry.after, entry.before), status: thread.status === "resolved" ? "resolved" as const : before?.status ?? thread.status };
  });
  const session = doc.session && { ...doc.session, suggestions: entry.suggestions.length ? entry.suggestions.map((s) => ({ ...s, status: doc.session!.suggestions.find((now) => now.id === s.id)?.status ?? s.status })) : doc.session.suggestions };
  return { ...doc, snapshot: entry.before, threads, session, agentSuggestions: [...restored, ...added], undo: doc.undo.slice(0, -1), redo: [...(doc.redo ?? []), entry] };
}

function quoteBlock(text: string) {
  return text ? text.split(/\r?\n/).map((line) => `> ${line}`).join("\n") : "> (nothing: delete the passage)";
}

/**
 * The user asks for a different version of an agent suggestion: a comment
 * thread on its passage quotes the suggestion (as the agent's message) and
 * the request (as the user's reply), and is linked to the suggestion, which
 * stays open. The agent, or Agentic Review, follows up from the thread.
 */
export function requestAgentRevision(doc: ReviewDocument, id: string, request: string, makeId: () => string, now = new Date().toISOString()): ReviewDocument {
  const suggestion = doc.agentSuggestions?.find((s) => s.id === id);
  if (!suggestion || (suggestion.status !== "pending" && suggestion.status !== "conflicted")) throw new Error("This suggested edit was already decided.");
  const text = request.trim();
  if (!text) throw new Error("Describe the revision you want.");
  const anchor = suggestion.anchors.find((a) => a.state === "attached");
  if (!anchor) throw new Error("The passage this edit was about is no longer in the document. Reject the suggestion instead.");
  const quoted = suggestion.edits.map((edit) => `${quoteBlock(edit.before)}\n\nwould become\n\n${quoteBlock(edit.after)}`).join("\n\n");
  const thread: ReviewThread = {
    id: makeId(), anchor: anchorAt(doc.snapshot, anchor), status: "open",
    messages: [
      { id: makeId(), text: `Suggested edit: ${suggestion.title}\n\n${quoted}${suggestion.reason ? `\n\nReason: ${suggestion.reason}` : ""}`, createdAt: now, author: "agent" },
      { id: makeId(), text: `Revision requested: ${text}`, createdAt: now },
    ],
  };
  return {
    ...doc, threads: [...doc.threads, thread],
    agentSuggestions: doc.agentSuggestions!.map((s) => s.id === id ? { ...s, commentIds: [...s.commentIds, thread.id] } : s),
  };
}
