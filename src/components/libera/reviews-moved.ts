import { REVIEWS_MOVED_EVENT } from "@/lib/markdown-review";
import type { WorkspaceFileChange } from "@/lib/workspaces";

/**
 * Whether a reviews-moved event concerns the review stored under `key`: a path
 * it names, or a file under a folder it names (a renamed folder or notebook is
 * announced by its new path).
 */
export function reviewsMovedAffect(paths: readonly string[] | undefined, key: string) {
  return !!paths?.some((path) => key === path || key.startsWith(`${path}/`));
}

/**
 * Registers a tab's leave-sync write, for the next tab's load to wait for. It waits for the write, never for its
 * failure: when a move rewrote the snapshot on the server the leave sync is refused (the text changed under it),
 * and the load reads the stored review itself.
 */
export function trackLeavingWrite(leaving: Set<Promise<unknown>>, write: Promise<unknown>) {
  const settled: Promise<void> = write.then(() => undefined, () => undefined).finally(() => { leaving.delete(settled); });
  leaving.add(settled);
  return settled;
}

/**
 * The paths whose stored review a file operation may have changed on the server:
 * where files went, the notes whose links were rewritten (their review snapshot
 * was rewritten with them), and the paths the operation reports as written.
 */
export function reviewPathsTouchedBy(change: WorkspaceFileChange, links?: { rewritten: readonly { path: string }[] }) {
  const moved = change.moved ? (Array.isArray(change.moved) ? change.moved : [change.moved]) : [];
  return [...new Set([...moved.map((item) => item.to), ...(links?.rewritten.map((item) => item.path) ?? [])])];
}

/**
 * Open reviews of these paths read their stored review again. Dispatched after
 * every move, rename or migration that moved a review or rewrote the links of
 * an open note (the server rewrote that note's review snapshot with it), so the
 * tab does not keep a stale revision and snapshot.
 */
export function announceReviewsMoved(paths: readonly string[]) {
  if (!paths.length || typeof window === "undefined") return;
  window.dispatchEvent(new (window.CustomEvent ?? CustomEvent)(REVIEWS_MOVED_EVENT, { detail: { paths: [...paths] } }));
}
