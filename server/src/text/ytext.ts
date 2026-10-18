// Y.Text helpers shared by restore, suggestion decisions and reviews: the
// content sub-document's source text, anchors stored as RelativePosition
// JSON, and applying minimal edits.

import { createHash } from "node:crypto";

import * as Y from "yjs";

import { ContentKeys, type RelativePositionJSON } from "../protocol.js";
import { diffText, type TextEdit } from "./diff.js";

export function sourceText(content: Y.Doc): Y.Text {
  return content.getText(ContentKeys.source);
}

/** Applies sorted, non-overlapping edits, last first, so earlier offsets stay valid. */
export function applyTextEdits(text: Y.Text, edits: readonly TextEdit[]): void {
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    if (edit.deleteCount > 0) text.delete(edit.start, edit.deleteCount);
    if (edit.insert.length > 0) text.insert(edit.start, edit.insert);
  }
}

/** Replaces text[start, end) with `replacement` through the smallest edits. Returns them. */
export function replaceRange(text: Y.Text, start: number, end: number, replacement: string): TextEdit[] {
  const edits = diffText(text.toString().slice(start, end), replacement).map((edit) => ({ ...edit, start: edit.start + start }));
  applyTextEdits(text, edits);
  return edits;
}

/** Turns `current` into `target` through the smallest edits. Returns them. */
export function rewriteText(text: Y.Text, target: string): TextEdit[] {
  const edits = diffText(text.toString(), target);
  applyTextEdits(text, edits);
  return edits;
}

function isPositionJson(value: unknown): value is RelativePositionJSON {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves one stored position against the source text, or null when it no longer exists. */
export function resolvePosition(content: Y.Doc, json: unknown): number | null {
  if (!isPositionJson(json)) return null;
  // Typing the root first matters: a document loaded from updates holds a
  // placeholder type until getText is called, and positions resolved before
  // that would point at the placeholder instead of the Y.Text.
  const text = sourceText(content);
  let absolute: Y.AbsolutePosition | null;
  try {
    absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), content);
  } catch {
    return null;
  }
  if (!absolute || absolute.type !== text) return null;
  return absolute.index;
}

export interface ResolvedRange {
  start: number;
  end: number;
}

/** Resolves an anchor's start and end, or null when either is gone or they cross. */
export function resolveRange(content: Y.Doc, start: unknown, end: unknown): ResolvedRange | null {
  const from = resolvePosition(content, start);
  const to = resolvePosition(content, end);
  if (from === null || to === null || from > to) return null;
  return { start: from, end: to };
}

// relativePositionToJSON keeps Yjs ID instances; plain objects make a record
// the same value before and after it round-trips a Y.Map (as the client does).
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
 * Anchors for text[start, end), encoded exactly like the client's
 * relativeRange (src/lib/collab/anchors.ts). A non-empty range sticks to its
 * first character (assoc 0) and last character (assoc -1), so text typed
 * just outside stays outside. An empty range (an insertion point) is "after
 * the character on the left" (assoc -1) and "before the character on the
 * right" (assoc 0), so text typed exactly at the point lands between them
 * and can be detected.
 */
export function anchorRange(text: Y.Text, start: number, end: number): { start: RelativePositionJSON; end: RelativePositionJSON } {
  if (start === end) {
    return {
      start: toJSON(Y.createRelativePositionFromTypeIndex(text, start, -1)),
      end: toJSON(Y.createRelativePositionFromTypeIndex(text, start, 0)),
    };
  }
  return {
    start: toJSON(Y.createRelativePositionFromTypeIndex(text, start, 0)),
    end: toJSON(Y.createRelativePositionFromTypeIndex(text, end, -1)),
  };
}

/**
 * What the character a position refers to is now: "none" for a position at
 * the start or end of the text (no character), "unknown" when this replica
 * has not received it, otherwise deleted or live. Undo restores deleted text
 * as new items linked through `redone`, followed as Yjs does when resolving.
 */
export function positionCharacter(content: Y.Doc, json: unknown): "none" | "unknown" | "deleted" | "live" {
  if (!isPositionJson(json) || !json.item) return "none";
  const { client, clock } = json.item;
  if (typeof client !== "number" || typeof clock !== "number") return "unknown";
  if (Y.getState(content.store, client) <= clock) return "unknown";
  let item = Y.getItem(content.store, Y.createID(client, clock)) as Y.Item | Y.AbstractStruct;
  for (let hops = 0; item instanceof Y.Item && item.redone && hops < 1000; hops += 1) {
    item = Y.getItem(content.store, item.redone) as Y.Item;
  }
  return !(item instanceof Y.Item) || item.deleted ? "deleted" : "live";
}

export type SuggestionStaleReason = "text-changed" | "target-removed";

/**
 * Whether a suggestion can still be applied, by the same rules as the
 * client's resolveSuggestion (src/lib/collab/suggestions/model.ts), so the
 * server never decides differently from what the panel shows:
 *
 * - unresolvable anchors: target-removed;
 * - insertion (empty baseQuote): target-removed when the characters on both
 *   sides of the point are gone, text-changed when one is or when text was
 *   typed at the point;
 * - otherwise: target-removed when the range collapsed, text-changed when
 *   the text between the anchors differs from baseQuote.
 */
export function suggestionStaleReason(
  content: Y.Doc,
  record: { start: unknown; end: unknown; baseQuote: string },
): SuggestionStaleReason | null {
  const from = resolvePosition(content, record.start);
  const to = resolvePosition(content, record.end);
  if (from === null || to === null) return "target-removed";
  const end = Math.max(from, to);
  const current = end > from ? sourceText(content).toString().slice(from, end) : "";
  if (record.baseQuote === "") {
    const left = positionCharacter(content, record.start);
    const right = positionCharacter(content, record.end);
    const leftGone = left === "deleted" || left === "unknown";
    const rightGone = right === "deleted" || right === "unknown";
    const hasLeft = left !== "none";
    const hasRight = right !== "none";
    if ((leftGone || !hasLeft) && (rightGone || !hasRight) && (hasLeft || hasRight)) return "target-removed";
    if (leftGone || rightGone || current !== "") return "text-changed";
    return null;
  }
  if (end <= from) return "target-removed";
  return current === record.baseQuote ? null : "text-changed";
}

/** Stable fingerprint of a scope's text; null (the scope is gone) has its own value. */
export function fingerprint(text: string | null): string {
  return createHash("sha256")
    .update(text === null ? "\u0000removed" : `t:${text}`)
    .digest("hex");
}
