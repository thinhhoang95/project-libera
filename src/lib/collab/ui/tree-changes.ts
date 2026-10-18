import type { HostEvent } from "@/lib/collab/local-api";

type FileMove = { from: string; to: string };

/** Batch working-copy writes as well as structural changes for the sidebar's link index. */
export function subscribeSharedTreeChanges(
  subscribe: (listener: (event: HostEvent) => void) => () => void,
  refresh: (moves: FileMove[]) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const moves: FileMove[] = [];
  const stop = subscribe((event) => {
    if (event.t !== "tree-changed" && event.t !== "files-changed") return;
    if (event.t === "tree-changed") moves.push(...event.moves);
    else if (!event.paths.length) return;
    // Keep the first deadline so steady shared edits cannot postpone refresh forever.
    timer ??= setTimeout(() => {
      timer = null;
      refresh(moves.splice(0));
    }, 300);
  });
  return () => {
    stop();
    if (timer) clearTimeout(timer);
    moves.length = 0;
  };
}
