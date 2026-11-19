import type { HostEvent } from "@/lib/collab/local-api";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTree } from "@/lib/types";

/** `fileId`, when known, is the file's identity across the move. */
export type FileMove = { from: string; to: string; fileId?: string };

/** What a refresh must read: these notebooks only, or (null) the whole library. */
export type RefreshScope = { notebooks: string[] | null };

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
 * The moves of one event as a simultaneous mapping: each file's old path to
 * its new one, all read against the same before and after. The host computes
 * them from two manifests, so a swap (a→b, b→a) is a swap, and when a→b and
 * b→c both appear they are two different files, not one file that went on to c.
 * Chaining them would drop the swap and send two files to one destination.
 * Only moves that carry the same file id are one file's steps and are joined.
 * Moves that end where they began are dropped; a path moved twice keeps its last.
 */
export function planMoves(moves: readonly FileMove[]): FileMove[] {
  const byIdentity = new Map<string, FileMove>();
  for (const move of moves) {
    const key = move.fileId ? `id:${move.fileId}` : `path:${move.from}`;
    const earlier = byIdentity.get(key);
    byIdentity.set(key, earlier && move.fileId ? { ...move, from: earlier.from } : { ...move });
  }
  return [...byIdentity.values()].filter((move) => move.from !== move.to);
}

/**
 * Whether applying `moves` one after another would go wrong: a destination
 * that is another move's source (a swap, or a file moving into a name that is
 * itself moving away). Such a batch must be applied as a whole.
 */
export function movesOverlap(moves: readonly FileMove[]): boolean {
  const sources = new Set(moves.map((move) => move.from));
  return moves.some((move) => sources.has(move.to));
}

/** Waits between lookups of a moved file's new location: bounded, a few seconds in all. */
export const MOVE_LOOKUP_DELAYS_MS = [400, 1200, 3000] as const;

/** Runs `attempt`, retrying after each wait in `delaysMs` (cloud lag: the destination may arrive late). */
export async function withBackoff<T>(
  attempt: () => Promise<T>,
  delaysMs: readonly number[] = MOVE_LOOKUP_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let tries = 0; ; tries++) {
    try { return await attempt(); }
    catch (error) {
      if (tries >= delaysMs.length) throw error;
      await sleep(delaysMs[tries]);
    }
  }
}

/**
 * Whether a refused rename or delete was the host's identity check (the path
 * now holds another file than the one the list showed), not some other 409
 * such as a name already taken.
 */
export function isIdentityConflict(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 409 &&
    /changed since it was read|identity changed/i.test((error as Error).message ?? "");
}

/** The notebook a Libera path is in. */
function notebookOfPath(path: string): string {
  return path.split("/")[0] ?? "";
}

/** The notebooks an event touches, or null when that cannot be told (refresh everything). */
export function eventNotebooks(event: HostEvent): string[] | null {
  if (event.t === "tree-changed") return event.notebook ? [event.notebook] : null;
  if (event.t !== "files-changed") return null;
  const names = new Set(event.paths.map(notebookOfPath));
  return names.has("") ? null : [...names];
}

/**
 * Which notebooks a window needs to read again. Notebooks the window does not
 * show (hidden, or in a hidden group) need nothing; one it has never seen is a
 * new notebook, so the whole library is read. Null in the result: read all.
 * An empty list: nothing to do.
 */
export function notebooksToRefresh(scope: RefreshScope, tree: LiberaTree | null): string[] | null {
  if (!scope.notebooks || !tree) return null;
  const wanted: string[] = [];
  for (const name of scope.notebooks) {
    const notebook = tree.notebooks.find((candidate) => candidate.name === name);
    if (!notebook) return null;
    const hidden = tree.notebookViewOptions.hiddenNotebookNames.includes(name) ||
      (notebook.groupId !== null && tree.notebookViewOptions.hiddenGroupIds.includes(notebook.groupId));
    if (!hidden) wanted.push(name);
  }
  return wanted;
}

function collectFileNodes(nodes: LiberaNotebookNode["children"], into: Map<string, LiberaFileNode>) {
  for (const node of nodes) {
    if (node.kind === "file") into.set(node.path, node);
    else collectFileNodes(node.children, into);
  }
}

/**
 * Puts a freshly read notebook into the shown tree. The scoped read cannot
 * resolve links into other notebooks, so those (and the notebook's related
 * list) are kept from the earlier node until the next full read.
 */
export function replaceNotebook(tree: LiberaTree, fresh: LiberaNotebookNode): LiberaTree {
  const earlier = tree.notebooks.find((notebook) => notebook.name === fresh.name);
  if (!earlier) return tree;
  const before = new Map<string, LiberaFileNode>();
  collectFileNodes(earlier.children, before);
  const after = new Map<string, LiberaFileNode>();
  collectFileNodes(fresh.children, after);
  for (const [path, file] of after) {
    const crossLinks = (before.get(path)?.linkedFilePaths ?? []).filter((target) => notebookOfPath(target) !== fresh.name);
    const links = [...new Set([...(file.linkedFilePaths ?? []), ...crossLinks])].sort();
    if (links.length) file.linkedFilePaths = links;
    else delete file.linkedFilePaths;
  }
  const related = new Set([...(fresh.relatedNotebookNames ?? []), ...(earlier.relatedNotebookNames ?? [])]);
  const node = { ...fresh, ...(related.size ? { relatedNotebookNames: [...related].sort() } : {}) };
  return { ...tree, notebooks: tree.notebooks.map((notebook) => (notebook.name === fresh.name ? node : notebook)) };
}

/**
 * Batch working-copy writes as well as structural changes for the sidebar's
 * link index. The refresh is told which notebooks the batch touched. A batch that comes due while the window is hidden waits, and
 * runs once when the window is shown again. Refreshes never overlap: events
 * that arrive during one cause exactly one more when it settles.
 *
 * Moves go to `onMoves` as they happen, even while hidden: a tab must follow
 * its file before the file moves again, and that is one small fetch, unlike
 * the tree refresh.
 */
export function subscribeSharedTreeChanges(
  subscribe: (listener: (event: HostEvent) => void) => () => void,
  refresh: (scope: RefreshScope) => void | Promise<unknown>,
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
  /** The notebooks events named since the last refresh started; `pendingAll` when one named none. */
  const pending = new Set<string>();
  let pendingAll = false;
  const run = () => {
    deferred = false;
    if (running) { rerun = true; return; }
    running = true;
    const scope: RefreshScope = { notebooks: pendingAll ? null : [...pending] };
    pending.clear();
    pendingAll = false;
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
    try { result = refresh(scope); } catch { settled(); return; }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(settled, settled);
    } else settled();
  };
  const stop = subscribe((event) => {
    if (event.t !== "tree-changed" && event.t !== "files-changed") return;
    if (event.t === "tree-changed") {
      const planned = planMoves(event.moves);
      if (planned.length) onMoves(planned);
    } else if (!event.paths.length) return;
    const named = eventNotebooks(event);
    if (named) for (const name of named) pending.add(name);
    else pendingAll = true;
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
