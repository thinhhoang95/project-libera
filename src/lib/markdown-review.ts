import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ChatContext } from "./document-chat";

export type ReviewRange = { start: number; end: number };
export type ReviewBlock = ReviewRange & { id: string; type: string; text: string };
export type ReviewAnchor = ReviewRange & { quote: string; prefix: string; suffix: string; state: "attached" | "orphaned" | "ambiguous" };
export type ReviewThread = { id: string; anchor: ReviewAnchor; messages: { id: string; text: string; createdAt: string }[]; status: "open" | "addressed" | "resolved" };
export type ReviewPlan = { version: number; summary: string; steps: { commentIds: string[]; targetBlockIds: string[]; proposedChange: string; rationale: string }[]; dispositions: { commentId: string; reason: string }[]; blockingQuestions: string[]; revisionSummary: string };
export type ReviewEdit = ReviewRange & { before: string; after: string };
export type ReviewSuggestion = { id: string; version: number; title: string; reason: string; commentIds: string[]; edits: ReviewEdit[]; status: "pending" | "accepted" | "rejected" | "superseded" | "conflicted" };
export type ReviewSession = { id: string; phase: "awaiting_confirmation" | "reviewing_changes" | "completed" | "stale"; snapshot: string; commentsKey: string; references: ChatContext[]; selectedIds: string[]; plan: ReviewPlan; suggestions: ReviewSuggestion[]; messages: { role: "user" | "assistant"; text: string }[]; confirmedVersion?: number };
export type ReviewUndo = { id: string; acceptedIds: string[]; planVersion: number; before: string; after: string; threads: ReviewThread[]; suggestions: ReviewSuggestion[] };
export type ReviewDocument = { schemaVersion: 1; id: string; key: string; revision: number; snapshot: string; enabled: boolean; threads: ReviewThread[]; session?: ReviewSession; round?: number; previousRounds?: { number: number; session: ReviewSession }[]; undo: ReviewUndo[]; redo?: ReviewUndo[] };

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
export function mapAnchor(anchor: ReviewAnchor, before: string, after: string): ReviewAnchor {
  if (before === after) return anchor;
  const change = textChange(before, after);
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
    const signature = (text: string) => JSON.stringify(parser.parse(text), (key, value) => key === "position" || key === "spread" ? undefined : value);
    const expected = signature(anchor.quote), count = reviewBlocks(anchor.quote).length;
    const blocks = reviewBlocks(after), semantic: ReviewRange[] = [];
    for (let index = 0; count > 0 && index + count <= blocks.length; index++) {
      const range = { start: blocks[index].start, end: blocks[index + count - 1].end };
      if (signature(after.slice(range.start, range.end)) === expected) semantic.push(range);
    }
    if (semantic.length === 1) return anchorAt(after, semantic[0]);
    if (semantic.length > 1) return { ...anchor, state: "ambiguous" };
  }
  return { ...anchor, state: candidates.length ? "ambiguous" : "orphaned" };
}
export function commentsKey(threads: ReviewThread[], ids: string[]) {
  return JSON.stringify(threads.filter((t) => ids.includes(t.id)).map((t) => ({ id: t.id, messages: t.messages, status: t.status === "resolved" ? "resolved" : "open" })));
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
  const change = textChange(doc.snapshot, snapshot);
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
  return { ...doc, snapshot, redo: [], threads: doc.threads.map((t) => ({ ...t, anchor: mapAnchor(t.anchor, doc.snapshot, snapshot) })), session: doc.session && { ...doc.session, phase: doc.session.phase === "awaiting_confirmation" ? "stale" : doc.session.phase, suggestions: suggestions! } };
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
function coverage(threads: ReviewThread[], suggestions: ReviewSuggestion[]) {
  return threads.map((t) => {
    if (t.status === "resolved") return t;
    const related = suggestions.filter((s) => s.status !== "superseded" && s.commentIds.includes(t.id));
    if (!related.length) return t;
    return { ...t, status: related.length && related.every((s) => s.status === "accepted") ? "addressed" as const : "open" as const };
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
  }
  return { ...mapped, snapshot: after, redo: decision === "accept" ? [] : doc.redo, threads: coverage(mapped.threads, suggestions), session: { ...mapped.session, suggestions, phase: suggestions.some((s) => s.status === "pending" || s.status === "conflicted") ? "reviewing_changes" : "completed" }, undo: decision === "accept" ? [...doc.undo.slice(-19), { id: transactionId, acceptedIds: ids, planVersion: doc.session.plan.version, before: doc.snapshot, after, threads: doc.threads, suggestions: doc.session.suggestions }] : doc.undo };
}
export function undoReview(doc: ReviewDocument): ReviewDocument {
  const entry = doc.undo.at(-1);
  if (!entry || entry.after !== doc.snapshot || !doc.session) throw new Error("The document changed after this acceptance. Undo later edits first.");
  if ((entry.planVersion !== undefined && entry.planVersion !== doc.session.plan.version) || doc.session.suggestions.some((s) => !entry.suggestions.some((prior) => prior.id === s.id && prior.version === s.version))) throw new Error("Changes were revised after this acceptance. Restore through document editing rather than discard newer review decisions.");
  const acceptedIds = entry.acceptedIds ?? entry.suggestions.filter((s) => s.status === "pending" && doc.session!.suggestions.find((now) => now.id === s.id)?.status === "accepted").map((s) => s.id);
  let suggestions = entry.suggestions.map((prior) => acceptedIds.includes(prior.id) ? prior : { ...prior, status: doc.session!.suggestions.find((s) => s.id === prior.id)?.status ?? prior.status });
  if (doc.session.phase === "stale") suggestions = suggestions.map((s) => s.status === "pending" ? { ...s, status: "conflicted" } : s);
  // Undo only this acceptance, retaining subsequent independent rejections.
  const threads = coverage(doc.threads.map((thread) => {
    const prior = entry.threads.find((t) => t.id === thread.id);
    return { ...thread, anchor: prior?.anchor ?? mapAnchor(thread.anchor, entry.after, entry.before), status: thread.status === "resolved" ? "resolved" : prior?.status ?? thread.status };
  }), suggestions);
  return { ...doc, snapshot: entry.before, threads, session: { ...doc.session, suggestions, phase: doc.session.phase === "stale" ? "stale" : "reviewing_changes" }, undo: doc.undo.slice(0, -1), redo: [...(doc.redo ?? []), entry] };
}

export function redoReview(doc: ReviewDocument): ReviewDocument {
  const entry = doc.redo?.at(-1);
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
  const dispositions = list(p.dispositions).map((raw) => { const d = object(raw); return { commentId: validIds([d.commentId], ids)[0], reason: reviewString(d.reason, "disposition") }; });
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
