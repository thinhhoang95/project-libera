import type { HostEvent } from "@/lib/collab/local-api";

type FileMove = { from: string; to: string };

/**
 * How long shared edits are batched into one tree refresh. Each refresh scans
 * every notebook on disk and re-renders the workspace, so while collaborators
 * type it runs at most this often.
 */
export const SHARED_TREE_REFRESH_MS = 2000;

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
 * Batch working-copy writes as well as structural changes for the sidebar's
 * link index. A batch that comes due while the window is hidden waits, and
 * runs once when the window is shown again.
 */
export function subscribeSharedTreeChanges(
  subscribe: (listener: (event: HostEvent) => void) => () => void,
  refresh: (moves: FileMove[]) => void,
  visibility: WindowVisibility | null = documentVisibility(),
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A batch came due while the window was hidden. */
  let deferred = false;
  const moves: FileMove[] = [];
  const flush = () => {
    deferred = false;
    refresh(moves.splice(0));
  };
  const stop = subscribe((event) => {
    if (event.t !== "tree-changed" && event.t !== "files-changed") return;
    if (event.t === "tree-changed") moves.push(...event.moves);
    else if (!event.paths.length) return;
    if (deferred) return;
    // Keep the first deadline so steady shared edits cannot postpone refresh forever.
    timer ??= setTimeout(() => {
      timer = null;
      if (visibility?.hidden()) deferred = true;
      else flush();
    }, SHARED_TREE_REFRESH_MS);
  });
  const stopVisibility = visibility?.onVisible(() => { if (deferred) flush(); });
  return () => {
    stop();
    stopVisibility?.();
    if (timer) clearTimeout(timer);
    deferred = false;
    moves.length = 0;
  };
}
