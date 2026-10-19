// Comment anchors on a shared Y.Text (map §7.4, plan M2.1 and M2.2).
//
// An anchor is two Yjs RelativePositions stored in the `annotations` doc's
// `anchors` map. They point at characters of the `content` doc's Y.Text, so
// they follow concurrent edits without offset mapping:
//
// - start uses assoc 0: it sticks to the first quoted character, so text typed
//   just before the quote stays outside the anchor;
// - end uses assoc -1: it sticks to the last quoted character, so text typed
//   just after the quote stays outside too.
//
// Consequences (source plan §6.1): splitting a paragraph inside the quote is
// an interior insert, so the anchor spans both parts. Copy/paste creates new
// characters, so anchors are never duplicated. Cut+paste deletes the original
// characters, so the anchor collapses and becomes detached, and
// `findReattachCandidates` offers the pasted copy by quote.

import * as Y from "yjs";
import { AnnotationKeys, ContentKeys, type AnchorRecord, type RelativePositionJSON } from "./protocol/schema";

export type AnchorState = "attached" | "detached";

export interface ResolvedAnchor {
  start: number;
  end: number;
  state: AnchorState;
  /** Why a detached anchor is detached. */
  reason?: "deleted" | "unresolvable";
}

function textOf(target: Y.Text | Y.Doc): Y.Text {
  return target instanceof Y.Doc ? target.getText(ContentKeys.source) : target;
}

function checkRange(ytext: Y.Text, start: number, end: number) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > ytext.length) {
    throw new RangeError(`Range ${start}–${end} is outside the text (length ${ytext.length}).`);
  }
}

// relativePositionToJSON keeps Yjs ID instances; copy them into plain objects
// so a record is the same value before and after it round-trips a Y.Map.
function toJSON(position: Y.RelativePosition): RelativePositionJSON {
  const json = Y.relativePositionToJSON(position) as RelativePositionJSON;
  const plain: RelativePositionJSON = {};
  if (json.type) plain.type = { client: json.type.client, clock: json.type.clock };
  if (json.tname) plain.tname = json.tname;
  if (json.item) plain.item = { client: json.item.client, clock: json.item.clock };
  if (json.assoc !== undefined) plain.assoc = json.assoc;
  return plain;
}

/**
 * Relative positions for `start`–`end`. A non-empty range follows the rule
 * above. An empty range (an insertion point) is stored as "after the
 * character on the left" and "before the character on the right", so text a
 * collaborator types exactly at the point ends up between them and can be
 * detected.
 */
export function relativeRange(ytext: Y.Text, start: number, end: number): { start: RelativePositionJSON; end: RelativePositionJSON } {
  checkRange(ytext, start, end);
  if (start === end) {
    return {
      start: toJSON(Y.createRelativePositionFromTypeIndex(ytext, start, -1)),
      end: toJSON(Y.createRelativePositionFromTypeIndex(ytext, start, 0)),
    };
  }
  return {
    start: toJSON(Y.createRelativePositionFromTypeIndex(ytext, start, 0)),
    end: toJSON(Y.createRelativePositionFromTypeIndex(ytext, end, -1)),
  };
}

/** Absolute index of a stored position in `ytext`, or null when it cannot be resolved there. */
export function resolvePosition(ytext: Y.Text, position: RelativePositionJSON): number | null {
  const doc = ytext.doc;
  if (!doc || !position || typeof position !== "object") return null;
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position), doc);
    return absolute && absolute.type === ytext ? absolute.index : null;
  } catch {
    return null;
  }
}

/**
 * Whether the character a position refers to has been deleted. Undo restores
 * deleted text as new items linked through `redone`, which is followed here
 * as Yjs does when resolving. Positions at the start or end of the text refer
 * to no character and are never deleted.
 */
export function isPositionDeleted(ytext: Y.Text, position: RelativePositionJSON): boolean {
  const doc = ytext.doc;
  const id = position?.item;
  if (!doc || !id) return false;
  if (Y.getState(doc.store, id.client) <= id.clock) return true;
  let item = Y.getItem(doc.store, Y.createID(id.client, id.clock)) as Y.Item | Y.AbstractStruct;
  for (let hops = 0; item instanceof Y.Item && item.redone && hops < 1000; hops++) item = Y.getItem(doc.store, item.redone) as Y.Item;
  return !(item instanceof Y.Item) || item.deleted;
}

/** Resolves a stored range; null when either end cannot be resolved. */
export function resolveRelativeRange(ytext: Y.Text, start: RelativePositionJSON, end: RelativePositionJSON): { start: number; end: number } | null {
  const from = resolvePosition(ytext, start);
  const to = resolvePosition(ytext, end);
  return from === null || to === null ? null : { start: from, end: to };
}

/* ---- Anchor records ----------------------------------------------------------- */

export interface AnchorOptions {
  id: string;
  kind: AnchorRecord["kind"];
  createdBy: string;
  createdAt?: number;
}

/** Builds an anchor record for `start`–`end` (not written anywhere). */
export function createAnchor(ytext: Y.Text, start: number, end: number, options: AnchorOptions): AnchorRecord {
  if (end <= start) throw new RangeError("An anchor must cover at least one character.");
  const range = relativeRange(ytext, start, end);
  return { id: options.id, kind: options.kind, start: range.start, end: range.end, createdBy: options.createdBy, createdAt: options.createdAt ?? Date.now() };
}

/**
 * Current range of an anchor. Detached when its characters were all deleted
 * (the range collapsed) or a position cannot be resolved, for example when it
 * belongs to another document or to updates this replica has not received.
 */
export function resolveAnchor(target: Y.Text | Y.Doc, record: Pick<AnchorRecord, "start" | "end">): ResolvedAnchor {
  const ytext = textOf(target);
  const range = resolveRelativeRange(ytext, record.start, record.end);
  if (!range) return { start: 0, end: 0, state: "detached", reason: "unresolvable" };
  if (range.end <= range.start) return { start: range.start, end: range.start, state: "detached", reason: "deleted" };
  return { ...range, state: "attached" };
}

export function isAnchorRecord(value: unknown): value is AnchorRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && (record.kind === "comment" || record.kind === "review-scope")
    && !!record.start && typeof record.start === "object" && !!record.end && typeof record.end === "object"
    && typeof record.createdBy === "string" && typeof record.createdAt === "number";
}

export function anchorsMap(annotations: Y.Doc): Y.Map<AnchorRecord> {
  return annotations.getMap<AnchorRecord>(AnnotationKeys.anchors);
}

export function writeAnchor(annotations: Y.Doc, record: AnchorRecord, origin?: unknown) {
  annotations.transact(() => anchorsMap(annotations).set(record.id, record), origin);
}

/** Creates an anchor for `start`–`end` and stores it. */
export function addAnchor(annotations: Y.Doc, ytext: Y.Text, start: number, end: number, options: AnchorOptions, origin?: unknown): AnchorRecord {
  const record = createAnchor(ytext, start, end, options);
  writeAnchor(annotations, record, origin);
  return record;
}

export function readAnchor(annotations: Y.Doc, id: string): AnchorRecord | null {
  const value = anchorsMap(annotations).get(id);
  return isAnchorRecord(value) ? value : null;
}

/** Valid anchor records; malformed entries from collaborators are skipped. */
export function listAnchors(annotations: Y.Doc): AnchorRecord[] {
  const records: AnchorRecord[] = [];
  anchorsMap(annotations).forEach((value) => { if (isAnchorRecord(value)) records.push(value); });
  return records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function removeAnchor(annotations: Y.Doc, id: string, origin?: unknown) {
  annotations.transact(() => anchorsMap(annotations).delete(id), origin);
}

/** Moves an existing anchor to a new range ("Reattach to selection"), keeping its id and author. */
export function reattachAnchor(annotations: Y.Doc, ytext: Y.Text, id: string, start: number, end: number, origin?: unknown): AnchorRecord {
  const record = readAnchor(annotations, id);
  if (!record) throw new Error(`Unknown anchor ${id}.`);
  const next = createAnchor(ytext, start, end, { id, kind: record.kind, createdBy: record.createdBy, createdAt: record.createdAt });
  writeAnchor(annotations, next, origin);
  return next;
}

/** Resolves every stored anchor against `ytext`. */
export function resolveAnchors(annotations: Y.Doc, ytext: Y.Text): Map<string, ResolvedAnchor & { record: AnchorRecord }> {
  const result = new Map<string, ResolvedAnchor & { record: AnchorRecord }>();
  for (const record of listAnchors(annotations)) result.set(record.id, { ...resolveAnchor(ytext, record), record });
  return result;
}

/* ---- Reattach candidates --------------------------------------------------------- */

export interface ReattachCandidate {
  start: number;
  end: number;
  /** Characters of the stored prefix and suffix context that match around the candidate. */
  score: number;
  /** False for a whitespace-insensitive match. */
  exact: boolean;
}

export interface ReattachContext {
  /** Text before the quote when the comment was made (thread data keeps it). */
  prefix?: string;
  suffix?: string;
  /** Prefer candidates near this offset (for example where the anchor collapsed). */
  near?: number;
}

function commonSuffixLength(a: string, b: string) {
  let length = 0;
  while (length < a.length && length < b.length && a[a.length - 1 - length] === b[b.length - 1 - length]) length++;
  return length;
}

function commonPrefixLength(a: string, b: string) {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
}

const MAX_CANDIDATES_SCANNED = 1_000;

/**
 * Where a detached quote could be reattached, best first. Like `mapAnchor` in
 * markdown-review.ts, exact quote matches come first and the stored prefix and
 * suffix break ties; when the quote no longer occurs exactly (Markdown
 * normalization changed spacing), a whitespace-insensitive search is tried.
 * Candidates are only offered; the user confirms a reattach, so a repeated
 * passage is never attached by guesswork.
 */
export function findReattachCandidates(text: string, quote: string, context: ReattachContext = {}, limit = 5): ReattachCandidate[] {
  if (!quote) return [];
  const prefix = context.prefix ?? "";
  const suffix = context.suffix ?? "";
  const score = (start: number, end: number) =>
    commonSuffixLength(text.slice(Math.max(0, start - prefix.length), start), prefix) + commonPrefixLength(text.slice(end, end + suffix.length), suffix);
  const candidates: ReattachCandidate[] = [];
  for (let pos = text.indexOf(quote); pos >= 0 && candidates.length < MAX_CANDIDATES_SCANNED; pos = text.indexOf(quote, pos + 1)) {
    candidates.push({ start: pos, end: pos + quote.length, score: score(pos, pos + quote.length), exact: true });
  }
  if (!candidates.length && quote.trim()) {
    const words = quote.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(words.join("\\s+"), "g");
    for (const match of text.matchAll(pattern)) {
      if (candidates.length >= MAX_CANDIDATES_SCANNED) break;
      const start = match.index ?? 0;
      candidates.push({ start, end: start + match[0].length, score: score(start, start + match[0].length), exact: false });
    }
  }
  const near = context.near;
  return candidates
    .sort((a, b) => b.score - a.score || (near === undefined ? 0 : Math.abs(a.start - near) - Math.abs(b.start - near)) || a.start - b.start)
    .slice(0, limit);
}
