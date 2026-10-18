// Overlay suggestions (map §7.5, plan M3.1 and M3.4).
//
// A suggestion lives in the `annotations` doc's `suggestions` map, never in
// `content`: builds, exports and the disk copy see the accepted truth. The
// server applies accepted suggestions (M3.3); clients only create, edit,
// withdraw and render them. The pure helpers here (`applySuggestionToText`,
// `validateDecision`) back optimistic UI; the server keeps its own copy.

import * as Y from "yjs";
import { actorAccountId, type Actor } from "../protocol/actor";
import { can, roleAtLeast, type Role } from "../protocol/roles";
import { AnnotationKeys, type SuggestionRecord, type SuggestionStatus } from "../protocol/schema";
import { isPositionDeleted, relativeRange, resolveRelativeRange } from "../anchors";
import { diffTexts } from "../../text-hunks";

export type StaleReason = NonNullable<SuggestionRecord["staleReason"]>;

export interface ResolvedSuggestion {
  record: SuggestionRecord;
  /** Current range in the live text. For an insertion, start === end unless text was typed at the point. */
  start: number;
  end: number;
  /** Live text between start and end. */
  currentText: string;
  /** True when the target changed or was removed (or the record is stored as stale). */
  isStale: boolean;
  staleReason?: StaleReason;
  /** True when the suggestion only inserts (empty baseQuote). */
  isInsertion: boolean;
}

export type SuggestionsTarget = Y.Doc | Y.Map<SuggestionRecord>;

export function suggestionsMap(target: SuggestionsTarget): Y.Map<SuggestionRecord> {
  return target instanceof Y.Doc ? target.getMap<SuggestionRecord>(AnnotationKeys.suggestions) : target;
}

function transact(map: Y.Map<SuggestionRecord>, fn: () => void, origin?: unknown) {
  if (map.doc) map.doc.transact(fn, origin);
  else fn();
}

const STATUSES: readonly SuggestionStatus[] = ["pending", "accepted", "rejected", "stale", "withdrawn"];

export function isSuggestionRecord(value: unknown): value is SuggestionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.createdBy === "string"
    && !!record.actor && typeof record.actor === "object"
    && !!record.start && typeof record.start === "object" && !!record.end && typeof record.end === "object"
    && typeof record.baseQuote === "string" && typeof record.replacement === "string"
    && STATUSES.includes(record.status as SuggestionStatus)
    && typeof record.createdAt === "number" && typeof record.updatedAt === "number";
}

let idCounter = 0;
export function newSuggestionId(prefix = "sg"): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${(idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

export interface CreateSuggestionInput {
  ytext: Y.Text;
  start: number;
  end: number;
  replacement: string;
  actor: Actor;
  /** Defaults to the actor's account (the user, or the user an AI acts for). */
  createdBy?: string;
  id?: string;
  groupId?: string;
  reason?: string;
  title?: string;
  threadIds?: string[];
  /** Overrides the quote captured from the live text (snapshot mapping uses this). */
  baseQuote?: string;
  status?: Extract<SuggestionStatus, "pending" | "stale">;
  staleReason?: StaleReason;
  now?: number;
}

/** Builds a record without storing it. */
export function buildSuggestion(input: CreateSuggestionInput): SuggestionRecord {
  const createdBy = input.createdBy ?? actorAccountId(input.actor);
  if (!createdBy) throw new Error("A suggestion needs an account to act for.");
  const range = relativeRange(input.ytext, input.start, input.end);
  const now = input.now ?? Date.now();
  const record: SuggestionRecord = {
    id: input.id ?? newSuggestionId(),
    actor: input.actor,
    createdBy,
    start: range.start,
    end: range.end,
    baseQuote: input.baseQuote ?? input.ytext.toString().slice(input.start, input.end),
    replacement: input.replacement,
    status: input.status ?? "pending",
    createdAt: now,
    updatedAt: now,
  };
  if (input.groupId) record.groupId = input.groupId;
  if (input.reason) record.reason = input.reason;
  if (input.title) record.title = input.title;
  if (input.threadIds?.length) record.threadIds = [...input.threadIds];
  if (record.status === "stale") record.staleReason = input.staleReason ?? "text-changed";
  return record;
}

/** Creates a pending suggestion over `start`–`end`, with baseQuote taken from the live text. */
export function createSuggestion(target: SuggestionsTarget, input: CreateSuggestionInput, origin?: unknown): SuggestionRecord {
  const record = buildSuggestion(input);
  const map = suggestionsMap(target);
  transact(map, () => map.set(record.id, record), origin);
  return record;
}

export function getSuggestion(target: SuggestionsTarget, id: string): SuggestionRecord | null {
  const value = suggestionsMap(target).get(id);
  return isSuggestionRecord(value) ? value : null;
}

export interface ListFilter {
  status?: SuggestionStatus | readonly SuggestionStatus[];
  groupId?: string;
  createdBy?: string;
}

/** Valid records (malformed entries from collaborators are skipped), oldest first. */
export function listSuggestions(target: SuggestionsTarget, filter: ListFilter = {}): SuggestionRecord[] {
  const statuses = filter.status === undefined ? null : typeof filter.status === "string" ? [filter.status] : filter.status;
  const records: SuggestionRecord[] = [];
  suggestionsMap(target).forEach((value) => {
    if (!isSuggestionRecord(value)) return;
    if (statuses && !statuses.includes(value.status)) return;
    if (filter.groupId !== undefined && value.groupId !== filter.groupId) return;
    if (filter.createdBy !== undefined && value.createdBy !== filter.createdBy) return;
    records.push(value);
  });
  return records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * Where a suggestion applies now, and whether it still can.
 *
 * - Non-empty target: stale (target-removed) when the range collapsed, stale
 *   (text-changed) when the live text differs from baseQuote.
 * - Insertion: stale (target-removed) when the characters on both sides of
 *   the point were deleted, stale (text-changed) when one was or when text
 *   was typed at the point.
 * - A record stored as stale stays stale with its stored reason.
 */
export function resolveSuggestion(ytext: Y.Text, record: SuggestionRecord): ResolvedSuggestion {
  const isInsertion = record.baseQuote === "";
  const range = resolveRelativeRange(ytext, record.start, record.end);
  if (!range) return { record, start: 0, end: 0, currentText: "", isStale: true, staleReason: "target-removed", isInsertion };
  const start = range.start;
  const end = Math.max(range.start, range.end);
  const currentText = end > start ? ytext.toString().slice(start, end) : "";
  let staleReason: StaleReason | undefined;
  if (record.status === "stale") staleReason = record.staleReason ?? "text-changed";
  else if (isInsertion) {
    const leftGone = isPositionDeleted(ytext, record.start);
    const rightGone = isPositionDeleted(ytext, record.end);
    const hasLeft = !!record.start.item;
    const hasRight = !!record.end.item;
    if ((leftGone || !hasLeft) && (rightGone || !hasRight) && (hasLeft || hasRight)) staleReason = "target-removed";
    else if (leftGone || rightGone || currentText !== "") staleReason = "text-changed";
  } else if (end <= start) staleReason = "target-removed";
  else if (currentText !== record.baseQuote) staleReason = "text-changed";
  const isStale = staleReason !== undefined && (record.status === "pending" || record.status === "stale");
  return { record, start, end, currentText, isStale, staleReason: isStale ? staleReason : undefined, isInsertion };
}

/** Resolves every suggestion, in document order. */
export function resolveSuggestions(ytext: Y.Text, records: readonly SuggestionRecord[]): ResolvedSuggestion[] {
  return records.map((record) => resolveSuggestion(ytext, record)).sort((a, b) => a.start - b.start || a.end - b.end || a.record.createdAt - b.record.createdAt);
}

export type OwnershipResult =
  | { ok: true; record: SuggestionRecord }
  | { ok: false; reason: "not-found" | "not-owner" | "not-pending" };

function updateOwned(target: SuggestionsTarget, id: string, by: string, change: (record: SuggestionRecord) => SuggestionRecord | null, allowStale: boolean, origin?: unknown): OwnershipResult {
  const map = suggestionsMap(target);
  const record = getSuggestion(map, id);
  if (!record) return { ok: false, reason: "not-found" };
  if (record.createdBy !== by) return { ok: false, reason: "not-owner" };
  if (record.status !== "pending" && !(allowStale && record.status === "stale")) return { ok: false, reason: "not-pending" };
  const next = change(record);
  transact(map, () => (next ? map.set(id, next) : map.delete(id)), origin);
  return { ok: true, record: next ?? record };
}

/** Withdraws a pending or stale suggestion. Only its creator may (an AI's suggestions belong to the user it acted for). */
export function withdrawSuggestion(target: SuggestionsTarget, id: string, by: string, now = Date.now(), origin?: unknown): OwnershipResult {
  return updateOwned(target, id, by, (record) => ({ ...record, status: "withdrawn", updatedAt: now }), true, origin);
}

/** Changes the proposed text of a pending suggestion. Creator only (plan M3.2). */
export function editSuggestionReplacement(target: SuggestionsTarget, id: string, by: string, replacement: string, now = Date.now(), origin?: unknown): OwnershipResult {
  return updateOwned(target, id, by, (record) => ({ ...record, replacement, updatedAt: now }), false, origin);
}

/** Removes a pending suggestion outright, for suggest-mode typing that was backspaced away. Creator only. */
export function discardSuggestion(target: SuggestionsTarget, id: string, by: string, origin?: unknown): OwnershipResult {
  return updateOwned(target, id, by, () => null, false, origin);
}

/**
 * Re-bases a stale suggestion on the current text ("Refresh suggestion", hard
 * case 1): the anchor and baseQuote move to what is there now and the status
 * returns to pending. Its creator or an editor may refresh.
 */
export function refreshSuggestion(target: SuggestionsTarget, ytext: Y.Text, id: string, by: { accountId: string; role: Role }, now = Date.now(), origin?: unknown): OwnershipResult {
  const map = suggestionsMap(target);
  const record = getSuggestion(map, id);
  if (!record) return { ok: false, reason: "not-found" };
  if (record.createdBy !== by.accountId && !roleAtLeast(by.role, "editor")) return { ok: false, reason: "not-owner" };
  if (record.status !== "pending" && record.status !== "stale") return { ok: false, reason: "not-pending" };
  const resolved = resolveSuggestion(ytext, { ...record, status: "pending" });
  const range = relativeRange(ytext, resolved.start, resolved.end);
  const next: SuggestionRecord = { ...record, start: range.start, end: range.end, baseQuote: resolved.currentText, status: "pending", updatedAt: now };
  delete next.staleReason;
  transact(map, () => map.set(id, next), origin);
  return { ok: true, record: next };
}

/* ---- Groups ------------------------------------------------------------------- */

export interface SuggestionGroup {
  /** The groupId, or the suggestion id for an ungrouped suggestion. */
  id: string;
  suggestions: ResolvedSuggestion[];
  /** Linked suggestions are accepted together, so one stale member blocks the group. */
  isStale: boolean;
  start: number;
  end: number;
  actor: Actor;
  createdBy: string;
}

export function groupKey(record: SuggestionRecord): string {
  return record.groupId ?? record.id;
}

/** Groups resolved suggestions by groupId, in document order. */
export function groupSuggestions(resolved: readonly ResolvedSuggestion[]): SuggestionGroup[] {
  const groups = new Map<string, SuggestionGroup>();
  for (const item of resolved) {
    const key = groupKey(item.record);
    const group = groups.get(key);
    if (group) {
      group.suggestions.push(item);
      group.isStale ||= item.isStale;
      group.start = Math.min(group.start, item.start);
      group.end = Math.max(group.end, item.end);
    } else groups.set(key, { id: key, suggestions: [item], isStale: item.isStale, start: item.start, end: item.end, actor: item.record.actor, createdBy: item.record.createdBy });
  }
  for (const group of groups.values()) group.suggestions.sort((a, b) => a.start - b.start || a.end - b.end);
  return [...groups.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

/* ---- Pure helpers for optimistic UI --------------------------------------------- */

/**
 * The text with one suggestion applied, or null when it cannot be applied
 * (stale, or the text at the range is not baseQuote).
 */
export function applySuggestionToText(text: string, resolved: Pick<ResolvedSuggestion, "start" | "end" | "isStale"> & { record: Pick<SuggestionRecord, "baseQuote" | "replacement"> }): string | null {
  if (resolved.isStale || resolved.start < 0 || resolved.end < resolved.start || resolved.end > text.length) return null;
  if (text.slice(resolved.start, resolved.end) !== resolved.record.baseQuote) return null;
  return text.slice(0, resolved.start) + resolved.record.replacement + text.slice(resolved.end);
}

export type DecisionCheck =
  | { ok: true; outcome: "applied" | "rejected" }
  | { ok: false; code: "forbidden" | "ai-cannot-decide" | "already-decided" | "stale" | "not-found" };

/**
 * Whether `actor` with `role` may make `decision` on a suggestion, mirroring
 * the server (M3.3): AI never decides, deciding needs editor rights, only
 * pending suggestions can be decided, and a stale one can be rejected but
 * not accepted.
 */
export function validateDecision(input: { role: Role; actor: Actor; decision: "accept" | "reject"; suggestion: ResolvedSuggestion | null }): DecisionCheck {
  if (input.actor.kind === "ai") return { ok: false, code: "ai-cannot-decide" };
  if (!can(input.role, "decide", input.actor)) return { ok: false, code: "forbidden" };
  const suggestion = input.suggestion;
  if (!suggestion) return { ok: false, code: "not-found" };
  const status = suggestion.record.status;
  if (status !== "pending" && status !== "stale") return { ok: false, code: "already-decided" };
  if (input.decision === "reject") return { ok: true, outcome: "rejected" };
  return suggestion.isStale ? { ok: false, code: "stale" } : { ok: true, outcome: "applied" };
}

/** Group form: linked suggestions are decided together, and one stale member makes accepting the group stale. */
export function validateGroupDecision(input: { role: Role; actor: Actor; decision: "accept" | "reject"; group: SuggestionGroup }): DecisionCheck {
  let result: DecisionCheck = { ok: true, outcome: input.decision === "accept" ? "applied" : "rejected" };
  for (const suggestion of input.group.suggestions) {
    const check = validateDecision({ role: input.role, actor: input.actor, decision: input.decision, suggestion });
    if (!check.ok) return check;
    result = check;
  }
  return result;
}

/**
 * The document as if every pending, non-stale suggestion were accepted.
 * Groups with a stale member are skipped as a whole, like the server's
 * accept-all; overlapping suggestions keep the earlier one in the document.
 */
export function previewAcceptedText(ytext: Y.Text, suggestions: SuggestionsTarget | readonly SuggestionRecord[]): { text: string; applied: string[]; skipped: string[] } {
  const records = Array.isArray(suggestions) ? (suggestions as readonly SuggestionRecord[]) : listSuggestions(suggestions as SuggestionsTarget);
  const live = records.filter((record) => record.status === "pending" || record.status === "stale");
  const resolved = resolveSuggestions(ytext, live);
  const blocked = new Set(groupSuggestions(resolved).filter((group) => group.isStale).map((group) => group.id));
  const chosen: ResolvedSuggestion[] = [];
  const skipped: string[] = [];
  let lastEnd = -1;
  for (const item of resolved) {
    const overlaps = item.start < lastEnd || (item.start === lastEnd && item.isInsertion && chosen.at(-1)?.isInsertion);
    if (item.isStale || blocked.has(groupKey(item.record)) || overlaps) { skipped.push(item.record.id); continue; }
    chosen.push(item);
    lastEnd = Math.max(lastEnd, item.end);
  }
  let text = ytext.toString();
  for (const item of [...chosen].reverse()) text = text.slice(0, item.start) + item.record.replacement + text.slice(item.end);
  return { text, applied: chosen.map((item) => item.record.id), skipped };
}

/* ---- Agentic review edits on an old snapshot (hard case 7) ------------------------- */

export interface SnapshotEdit {
  start: number;
  end: number;
  before: string;
  after: string;
}

export interface MappedSnapshotEdit {
  edit: SnapshotEdit;
  /** Range in the live text. For a conflicted edit, the best estimate (may not hold `before`). */
  start: number;
  end: number;
  matched: boolean;
  /** How a matched edit was located. */
  via?: "diff" | "quote";
}

const CONTEXT = 40;

/**
 * Maps edits made against `snapshotText` onto `liveText`. An edit maps
 * through the diff when the text it touches did not change; otherwise its
 * `before` text is searched for, and only a unique match (using the
 * snapshot's surrounding text to break ties) counts. Anything else is
 * conflicted, the state agentic review already shows for changed passages.
 */
export function mapSnapshotEdits(liveText: string, snapshotText: string, edits: readonly SnapshotEdit[]): MappedSnapshotEdit[] {
  const hunks = liveText === snapshotText ? [] : diffTexts(snapshotText, liveText);
  const mapPos = (pos: number, assoc: -1 | 1) => {
    let delta = 0;
    for (const hunk of hunks) {
      // A pure insertion exactly at `pos` lands before a start (assoc 1) and
      // after an end (assoc -1), so the edit never absorbs it.
      if (hunk.toA < pos || (hunk.toA === pos && (hunk.fromA < pos || assoc > 0))) delta += (hunk.toB - hunk.fromB) - (hunk.toA - hunk.fromA);
      else if (hunk.fromA < pos) {
        // Inside a changed region: estimate through the region's unchanged
        // head and tail, so a conflicted suggestion still points at the
        // passage that replaced what it was made for.
        const a = snapshotText.slice(hunk.fromA, hunk.toA), b = liveText.slice(hunk.fromB, hunk.toB);
        let head = 0;
        while (head < a.length && head < b.length && a[head] === b[head]) head++;
        let tail = 0;
        while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
        const offset = pos - hunk.fromA;
        if (offset <= head) return { pos: hunk.fromB + offset, clean: false };
        if (a.length - offset <= tail) return { pos: hunk.toB - (a.length - offset), clean: false };
        return { pos: assoc > 0 ? hunk.fromB + head : hunk.toB - tail, clean: false };
      }
      else break;
    }
    return { pos: pos + delta, clean: true };
  };
  const touched = (edit: SnapshotEdit) => hunks.some((hunk) => (hunk.fromA === hunk.toA
    ? hunk.fromA > edit.start && hunk.fromA < edit.end
    : hunk.fromA < edit.end && hunk.toA > edit.start) || (edit.start === edit.end && hunk.fromA <= edit.start && hunk.toA >= edit.start));
  return edits.map((edit) => {
    const valid = edit.start >= 0 && edit.end >= edit.start && edit.end <= snapshotText.length && snapshotText.slice(edit.start, edit.end) === edit.before;
    const start = mapPos(edit.start, 1);
    const end = edit.start === edit.end ? start : mapPos(edit.end, -1);
    const estimate = { start: Math.min(start.pos, liveText.length), end: Math.min(Math.max(start.pos, end.pos), liveText.length) };
    if (!valid) return { edit, ...estimate, matched: false };
    if (!touched(edit) && start.clean && end.clean && liveText.slice(estimate.start, estimate.end) === edit.before) return { edit, ...estimate, matched: true, via: "diff" as const };
    if (!edit.before) return { edit, ...estimate, matched: false };
    const prefix = snapshotText.slice(Math.max(0, edit.start - CONTEXT), edit.start);
    const suffix = snapshotText.slice(edit.end, edit.end + CONTEXT);
    const positions: number[] = [];
    for (let pos = liveText.indexOf(edit.before); pos >= 0 && positions.length < 1000; pos = liveText.indexOf(edit.before, pos + 1)) positions.push(pos);
    const withContext = positions.filter((pos) => liveText.slice(Math.max(0, pos - prefix.length), pos).endsWith(prefix.slice(-Math.min(prefix.length, 12)))
      && liveText.slice(pos + edit.before.length).startsWith(suffix.slice(0, Math.min(suffix.length, 12))));
    const unique = positions.length === 1 ? positions : withContext.length === 1 ? withContext : [];
    if (unique.length === 1) return { edit, start: unique[0], end: unique[0] + edit.before.length, matched: true, via: "quote" as const };
    return { edit, ...estimate, matched: false };
  });
}

export interface SnapshotSuggestionOptions {
  ytext: Y.Text;
  /** Where to store the records; omit to only build them. */
  target?: SuggestionsTarget;
  actor: Actor;
  createdBy?: string;
  groupId?: string;
  reason?: string;
  title?: string;
  threadIds?: string[];
  makeId?: () => string;
  now?: number;
  origin?: unknown;
}

/**
 * Turns agentic-review edits made against an older snapshot into overlay
 * suggestions on the live text (plan §6.2 hard case 7). Edits whose `before`
 * still matches become pending suggestions; the others are created stale
 * (text-changed) with the snapshot's `before` as baseQuote, so the panel can
 * show what the AI saw next to what is there now.
 */
export function suggestionsFromSnapshotEdits(liveText: string, snapshotText: string, edits: readonly SnapshotEdit[], options: SnapshotSuggestionOptions): { suggestions: SuggestionRecord[]; matched: SuggestionRecord[]; conflicted: SuggestionRecord[] } {
  if (options.ytext.toString() !== liveText) throw new Error("liveText must be the current text of ytext.");
  const mapped = mapSnapshotEdits(liveText, snapshotText, edits);
  const records = mapped.map((item) => buildSuggestion({
    ytext: options.ytext,
    start: item.start,
    end: item.end,
    replacement: item.edit.after,
    actor: options.actor,
    createdBy: options.createdBy,
    id: options.makeId?.(),
    groupId: options.groupId,
    reason: options.reason,
    title: options.title,
    threadIds: options.threadIds,
    baseQuote: item.matched ? liveText.slice(item.start, item.end) : item.edit.before,
    status: item.matched ? "pending" : "stale",
    staleReason: "text-changed",
    now: options.now,
  }));
  if (options.target) {
    const map = suggestionsMap(options.target);
    transact(map, () => { for (const record of records) map.set(record.id, record); }, options.origin);
  }
  return { suggestions: records, matched: records.filter((record) => record.status === "pending"), conflicted: records.filter((record) => record.status === "stale") };
}
