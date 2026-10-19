// Marker bookkeeping for durability tests: every edit inserts a unique
// "<tag:index>" so a test can say exactly which edits survived, which the
// server acknowledged, and that none was applied twice.

import * as Y from "yjs";

import type { HostStore } from "../../../electron/collab/core/store";

const MARKER = /<[A-Za-z0-9_-]+:\d+>/g;

export function markersIn(text: string): string[] {
  return text.match(MARKER) ?? [];
}

export function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** Markers inserted by one Yjs update. */
export function markersInUpdate(update: Uint8Array): string[] {
  return markersIn(insertedText(update));
}

/** Strings inserted by one Yjs update (decoded, so merged or split items are handled). */
function insertedText(update: Uint8Array): string {
  let text = "";
  for (const struct of Y.decodeUpdate(update).structs) {
    if (struct instanceof Y.Item && struct.content instanceof Y.ContentString) text += struct.content.str;
  }
  return text;
}

/**
 * Markers in this host's local edits that the server acknowledged
 * (updates.acked_server_seq is set only after an ack, plan §3.3).
 */
export function ackedMarkers(store: HostStore, docId: string): Set<string> {
  const acked = new Set<string>();
  for (const row of store.allUpdates(docId)) {
    if (row.origin?.kind !== "local" || row.ackedServerSeq === null) continue;
    for (const marker of markersIn(insertedText(row.update))) acked.add(marker);
  }
  return acked;
}

/** Markers in every local edit committed to SQLite, acknowledged or not. */
export function committedMarkers(store: HostStore, docId: string): Set<string> {
  const committed = new Set<string>();
  for (const row of store.allUpdates(docId)) {
    if (row.origin?.kind !== "local") continue;
    for (const marker of markersIn(insertedText(row.update))) committed.add(marker);
  }
  return committed;
}

/** Asserts-friendly summary: markers missing from `text`, and markers present more than once. */
export function checkMarkers(text: string, expected: Iterable<string>): { missing: string[]; duplicated: string[] } {
  const missing: string[] = [];
  const duplicated: string[] = [];
  for (const marker of expected) {
    const count = occurrences(text, marker);
    if (count === 0) missing.push(marker);
    else if (count > 1) duplicated.push(marker);
  }
  return { missing, duplicated };
}
