import type { HostEvent } from "@/lib/collab/local-api";

type FileMove = { from: string; to: string };

/**
 * How long shared edits are batched into one tree refresh. Each refresh scans
 * every notebook on disk and re-renders the workspace, so while collaborators
 * type it runs at most this often.
 */
export const SHARED_TREE_REFRESH_MS = 2000;
/** How long one refresh may run before the next is allowed to start anyway. */
export const REFRESH_STUCK_MS = 30_000;

/** Whether the window is hidden, and a way to hear when it is shown again. */
export type WindowVisibility = {
  hidden: () => boolean;
  onVisible: (listener: () => void) => () => void;
};

function documentVisibility(): WindowVisibility | null {
  if (typeof document === "undefined") return null;
  return {
    hidden: () => document.visibilityState === "hidden",
    onVisible: (listener) => {
      const onChange = () => { if (document.visibilityState !== "hidden") listener(); };
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
  };
}

/**
 * Makes each original path map to its final destination (a→b, b→c becomes
 * a→c) and drops moves that end where they began. Order is kept.
 */
export function collapseMoves(moves: readonly FileMove[]): FileMove[] {
  const chains: FileMove[] = [];
  for (const move of moves) {
    const earlier = chains.find((chain) => chain.to === move.from);
    if (earlier) earlier.to = move.to;
    else chains.push({ ...move });
  }
  return chains.filter((chain) => chain.from !== chain.to);
}

/**
 * Batch working-copy writes as well as structural changes for the sidebar's
 * link index. A batch that comes due while the window is hidden waits, and
 * runs once when the window is shown again. Refreshes never overlap: events
 * that arrive during one cause exactly one more when it settles.
 *
 * Moves go to `onMoves` as they happen, even while hidden: a tab must follow
 * its file before the file moves again, and that is one small fetch, unlike
 * the tree refresh.
 */
export function subscribeSharedTreeChanges(
  subscribe: (listener: (event: HostEvent) => void) => () => void,
  refresh: () => void | Promise<unknown>,
  onMoves: (moves: FileMove[]) => void,
  visibility: WindowVisibility | null = documentVisibility(),
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A batch came due while the window was hidden. */
  let deferred = false;
  let running = false;
  /** Events arrived while a refresh was in flight. */
  let rerun = false;
  let closed = false;
  const run = () => {
    deferred = false;
    if (running) { rerun = true; return; }
    running = true;
    let done = false;
    // A refresh that never settles (a hung request) must not hold back every later one.
    const stuck = setTimeout(() => settled(), REFRESH_STUCK_MS);
    const settled = () => {
      if (done) return;
      done = true;
      clearTimeout(stuck);
      running = false;
      if (closed || !rerun) return;
      rerun = false;
      if (visibility?.hidden()) deferred = true;
      else run();
    };
    let result: void | Promise<unknown>;
    try { result = refresh(); } catch { settled(); return; }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(settled, settled);
    } else settled();
  };
  const stop = subscribe((event) => {
    if (event.t !== "tree-changed" && event.t !== "files-changed") return;
    if (event.t === "tree-changed") {
      const collapsed = collapseMoves(event.moves);
      if (collapsed.length) onMoves(collapsed);
    } else if (!event.paths.length) return;
    if (deferred) return;
    // Keep the first deadline so steady shared edits cannot postpone refresh forever.
    timer ??= setTimeout(() => {
      timer = null;
      if (visibility?.hidden()) deferred = true;
      else run();
    }, SHARED_TREE_REFRESH_MS);
  });
  const stopVisibility = visibility?.onVisible(() => { if (deferred) run(); });
  return () => {
    closed = true;
    stop();
    stopVisibility?.();
    if (timer) clearTimeout(timer);
    deferred = false;
  };
}
