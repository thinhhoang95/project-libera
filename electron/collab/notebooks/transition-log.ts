// What the manifest did to each file, by file ID: the durable log of moves and
// removals that Next applies to the records it keeps on this computer
// (src/lib/storage/shared-record-follow.ts). The diff is against the paths last
// recorded in the host's store, not against the layout in memory, which a
// restarted follower rebuilds from empty: a file that moved while the host was
// down is a move, not an addition.

import type { ManifestTransitionRow } from "../core/store";

export type RecordedPath = { path: string; kind: "file" | "folder" };

export interface ManifestDiff {
  upserts: Array<{ fileId: string; path: string; kind: "file" | "folder" }>;
  removals: string[];
  transitions: Array<Omit<ManifestTransitionRow, "seq" | "projectId">>;
}

/**
 * The changes from `recorded` to `next` (the manifest's paths by file ID).
 * An entry not seen before is remembered without a transition. An empty
 * `next` against a recorded manifest is never read as "everything was
 * deleted" (a manifest that has not loaded looks the same): nothing is
 * recorded, and a real emptying shows as removals once any entry is back.
 */
export function diffManifestPaths(recorded: ReadonlyMap<string, RecordedPath>, next: ReadonlyMap<string, RecordedPath>, at: number): ManifestDiff {
  const diff: ManifestDiff = { upserts: [], removals: [], transitions: [] };
  if (next.size === 0 && recorded.size > 0) return diff;
  for (const [fileId, entry] of next) {
    const before = recorded.get(fileId);
    if (before && before.path === entry.path && before.kind === entry.kind) continue;
    diff.upserts.push({ fileId, path: entry.path, kind: entry.kind });
    if (before && before.path !== entry.path) diff.transitions.push({ fileId, kind: entry.kind, from: before.path, to: entry.path, at });
  }
  for (const [fileId, before] of recorded) {
    if (next.has(fileId)) continue;
    diff.removals.push(fileId);
    diff.transitions.push({ fileId, kind: before.kind, from: before.path, to: null, at });
  }
  return diff;
}
