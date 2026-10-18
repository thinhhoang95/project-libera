// Programmatic writes to a shared document (plan M1.4, "existing consumers of
// tab.draft keep working").
//
// Workspace features compute a whole new text (AI Rewrite splices its result
// into the draft, review applies a result snapshot, an image lands at the
// caret). On a regular tab that text simply becomes the draft. On a shared tab
// replacing the Y.Text would erase every concurrent remote edit and every
// comment anchor, so the new text is turned into the smallest edits that
// produce it, and those edits are applied as one Y transaction with the
// feature's provenance.
//
// Features that await a server (AI) computed their text from an older draft.
// The edits are computed against that `base` and rebased over whatever
// changed since, so a collaborator's sentence typed during the request
// survives.

import { presentableDiff } from "@codemirror/merge";
import { ChangeSet, type ChangeSpec } from "@codemirror/state";
import type * as Y from "yjs";
import type { Provenance } from "../protocol/actor";
import { PROVENANCE_META_KEY } from "../bindings/codemirror";
import { getSharedDocRegistry, undoScopeFor, type SharedDocRegistry, type SharedDocSession } from "./registry";

/** Gives up on a precise diff past this many changed characters in one region (keeps big rewrites linear). */
const DIFF_SCAN_LIMIT = 20_000;

export interface TextEdit {
  /** UTF-16 offsets in the text the edits apply to. */
  from: number;
  to: number;
  insert: string;
}

export type ApplySharedResult =
  | { applied: true; edits: TextEdit[] }
  | { applied: false; reason: "unchanged" | "not-shared" | "not-ready" | "read-only" };

/** Minimal edits turning `before` into `after`, in `before` offsets, sorted and not overlapping. */
export function minimalEdits(before: string, after: string): TextEdit[] {
  if (before === after) return [];
  // presentableDiff merges changes split by one or two equal characters and
  // aligns them to word boundaries: still small, but whole words, which keeps
  // concurrent edits and comment anchors from interleaving mid-word.
  return presentableDiff(before, after, { scanLimit: DIFF_SCAN_LIMIT }).map((change) => ({
    from: change.fromA,
    to: change.toA,
    insert: after.slice(change.fromB, change.toB),
  }));
}

function changeSet(edits: TextEdit[], length: number) {
  return ChangeSet.of(edits.map((edit): ChangeSpec => ({ from: edit.from, to: edit.to, insert: edit.insert })), length);
}

/**
 * The edits that turn `current` into what `next` meant relative to `base`:
 * the changes base→next, moved over the changes base→current. With
 * base === current this is simply minimalEdits(current, next).
 */
export function rebasedEdits(current: string, next: string, base: string = current): TextEdit[] {
  const ours = minimalEdits(base, next);
  if (!ours.length || base === current) return ours;
  const theirs = changeSet(minimalEdits(base, current), base.length);
  const mapped = changeSet(ours, base.length).map(theirs);
  const edits: TextEdit[] = [];
  mapped.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    edits.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return edits;
}

export interface ApplyToYTextOptions {
  /** The text `nextText` was derived from (defaults to the current text). */
  base?: string;
  /** Transaction origin; the tab's undo manager tracks the session's edit origin. */
  origin?: unknown;
}

/**
 * Applies `nextText` to `ytext` as minimal edits in one transaction whose
 * meta carries `provenance` (read by the replica when it sends the update).
 */
export function applyTextToYText(ytext: Y.Text, nextText: string, provenance: Provenance, options: ApplyToYTextOptions = {}): TextEdit[] {
  const doc = ytext.doc;
  if (!doc) throw new Error("The Y.Text must belong to a Y.Doc.");
  const current = ytext.toString();
  const edits = rebasedEdits(current, nextText, options.base ?? current);
  if (!edits.length) return edits;
  doc.transact((transaction) => {
    transaction.meta.set(PROVENANCE_META_KEY, { ...provenance });
    // Last to first, so earlier offsets stay valid.
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index];
      if (edit.to > edit.from) ytext.delete(edit.from, edit.to - edit.from);
      if (edit.insert) ytext.insert(edit.from, edit.insert);
    }
  }, options.origin ?? null);
  return edits;
}

/** Applies a programmatic edit to a session: one undo step, refused when the document is read-only. */
export function applyTextToSession(session: SharedDocSession, nextText: string, provenance: Provenance, base?: string): ApplySharedResult {
  const { replica } = session;
  if (!replica.getSnapshot().attached) return { applied: false, reason: "not-ready" };
  if (!replica.canEditContent()) return { applied: false, reason: "read-only" };
  // Its own undo step in whichever editor undoes it: Undo removes exactly
  // this feature's result, not the typing just before or after it (M1.11).
  const scope = undoScopeFor(session);
  scope.flush?.();
  scope.undoManager.stopCapturing();
  const edits = applyTextToYText(replica.ytext, nextText, provenance, { base, origin: scope.origin });
  scope.undoManager.stopCapturing();
  return edits.length ? { applied: true, edits } : { applied: false, reason: "unchanged" };
}

/**
 * `setTabDraft` for shared tabs: applies `nextText` to the tab's shared
 * document as minimal edits with `provenance`. `base` is the draft the caller
 * derived `nextText` from, when it read it before awaiting something.
 */
export function applyTextToShared(
  tab: { id: string },
  nextText: string,
  provenance: Provenance,
  options: { base?: string; registry?: SharedDocRegistry } = {},
): ApplySharedResult {
  const registry = options.registry ?? getSharedDocRegistry();
  const session = registry.sessionForTab(tab.id);
  if (!session) return { applied: false, reason: registry.isSharedTab(tab.id) ? "not-ready" : "not-shared" };
  return applyTextToSession(session, nextText, provenance, options.base);
}
