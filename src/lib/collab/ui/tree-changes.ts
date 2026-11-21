import type { HostEvent } from "@/lib/collab/local-api";
import { inheritUnknownFileIds } from "@/lib/tree-merge";
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
/** A batch touching more files than this is cheaper to read as a whole tree. */
export const MAX_INCREMENTAL_PATHS = 100;
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

type WithFile = { file: { path: string; fileId?: string } };

/** How the current location of a moved file is read: a file's `file.fileId` is set only when its bytes were verified to be that manifest entry. */
export type MovedFileRead<P extends WithFile> = {
  /** The file at a path; rejects when it is not on disk yet. */
  atPath: (path: string) => Promise<P>;
  /** The file the manifest lists under this id, wherever it is now: null when the manifest no longer has it, rejects when it is not on disk yet. */
  byId: (fileId: string, notebook: string) => Promise<P | null>;
};

export type MoveResolution<P> = { state: "found"; payload: P } | { state: "pending" } | { state: "gone" };

/**
 * Finds where a moved file is now, by its identity. The destination counts
 * only when the file there is verified to be the event's file: another file
 * that took the name, or a copy the disk has not brought up to date, does not.
 * Then the manifest is asked where that file is (a chain of moves, or a name
 * taken since). A destination that has not arrived (cloud lag) or cannot be
 * verified yet is "pending": the caller keeps the move and asks again.
 * "gone": the manifest no longer has the file. A move without an id (an older
 * host) can only be read by path.
 */
export async function resolveMovedFile<P extends WithFile>(move: FileMove, read: MovedFileRead<P>): Promise<MoveResolution<P>> {
  if (!move.fileId) {
    try { return { state: "found", payload: await withBackoff(() => read.atPath(move.to)) }; }
    catch { return { state: "gone" }; }
  }
  try {
    const atDestination = await read.atPath(move.to);
    if (atDestination.file.fileId === move.fileId) return { state: "found", payload: atDestination };
  } catch { /* not arrived yet */ }
  try {
    const current = await read.byId(move.fileId, notebookOfPath(move.to));
    if (current === null) return { state: "gone" };
    if (current.file.fileId === move.fileId) return { state: "found", payload: current };
  } catch { /* not arrived yet, or the manifest could not be read */ }
  return { state: "pending" };
}

/** A move whose destination is verified: the tab or draft of `from` goes to `payload.file.path`. */
export type ConfirmedMove<P> = { from: string; fileId?: string; payload: P };

/**
 * The file record a tab holds after it re-read or saved its file: the identity
 * the tab had stays unless the read says the path now holds another file
 * (fileIdState "mismatch"), so a save response without an id does not make the
 * tab anonymous.
 */
export function keepFileIdentity(current: LiberaFileNode, next: LiberaFileNode): LiberaFileNode {
  if (next.fileId || !current.fileId || next.path !== current.path || next.fileIdState === "mismatch") return next;
  return { ...next, fileId: current.fileId };
}

/** Moves kept at most this many; the oldest are dropped first. */
const MAX_PENDING_MOVES = 500;

/**
 * Follows moves in the order they happened. A move whose destination cannot be
 * confirmed yet is kept by file id (a later move of the same file continues
 * from where the kept one began) and looked up again on `retry`, which the
 * caller runs when a file arrives or the manifest is read again. There is no
 * timer: nothing runs while nothing happens. Confirmed moves of one step go to
 * `apply` together.
 */
export function createMoveFollower<P extends WithFile>(options: {
  read: MovedFileRead<P>;
  apply: (moves: ConfirmedMove<P>[]) => void | Promise<void>;
  isActive?: () => boolean;
}) {
  const pending = new Map<string, FileMove>();
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  const active = () => !stopped && (options.isActive?.() ?? true);
  const keyOf = (move: FileMove) => move.fileId ? `id:${move.fileId}` : `path:${move.from}`;
  async function settle(moves: FileMove[]) {
    const resolved = await Promise.all(moves.map(async (move) => ({ move, resolution: await resolveMovedFile(move, options.read) })));
    if (!active()) return;
    const confirmed: ConfirmedMove<P>[] = [];
    for (const { move, resolution } of resolved) {
      if (resolution.state === "pending") {
        pending.delete(keyOf(move));
        pending.set(keyOf(move), move);
        if (pending.size > MAX_PENDING_MOVES) pending.delete(pending.keys().next().value!);
      } else {
        pending.delete(keyOf(move));
        if (resolution.state === "found") confirmed.push({ from: move.from, fileId: move.fileId, payload: resolution.payload });
      }
    }
    if (confirmed.length) await options.apply(confirmed);
  }
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch(() => undefined);
    return queue;
  };
  function follow(moves: FileMove[]) {
    return enqueue(() => {
      // A kept move of the same file continues: it began where the kept one did.
      const continued = moves.map((move) => {
        const kept = move.fileId ? pending.get(keyOf(move)) : undefined;
        return kept ? { ...move, from: kept.from } : move;
      });
      // A file that came back to where it began has nothing left to follow.
      for (const move of continued) if (move.from === move.to) pending.delete(keyOf(move));
      return settle(continued.filter((move) => move.from !== move.to));
    });
  }
  function retry() {
    return enqueue(() => pending.size ? settle([...pending.values()]) : Promise.resolve());
  }
  return {
    follow,
    retry,
    /** Resolves when every move given so far has been tried. */
    settled: () => queue,
    pending: () => [...pending.values()],
    stop() { stopped = true; pending.clear(); },
  };
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
  inheritUnknownFileIds(before.values(), after.values());
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
 * link index. A batch of only writes goes to `onFilesChanged` with the written
 * paths (when given), a light check of those files; any structural change in
 * the batch makes it a `refresh`, told which notebooks the batch touched. A batch that comes due while the window is hidden waits, and
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
  onFilesChanged?: (paths: string[]) => void | Promise<unknown>,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A batch came due while the window was hidden. */
  let deferred = false;
  let running = false;
  /** Events arrived while a refresh was in flight. */
  let rerun = false;
  let closed = false;
  /** What the pending batch holds: a structural change needs a refresh, writes only their files. */
  let structural = false;
  const written = new Set<string>();
  /** The notebooks events named since the last refresh started; `pendingAll` when one named none. */
  const pending = new Set<string>();
  let pendingAll = false;
  const run = () => {
    deferred = false;
    if (running) { rerun = true; return; }
    running = true;
    const paths = [...written];
    const incremental = !structural && paths.length > 0 && paths.length <= MAX_INCREMENTAL_PATHS && onFilesChanged !== undefined;
    const scope: RefreshScope = { notebooks: pendingAll ? null : [...pending] };
    structural = false;
    written.clear();
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
    try { result = incremental ? onFilesChanged!(paths) : refresh(scope); } catch { settled(); return; }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(settled, settled);
    } else settled();
  };
  const stop = subscribe((event) => {
    if (event.t !== "tree-changed" && event.t !== "files-changed") return;
    if (event.t === "tree-changed") {
      const planned = planMoves(event.moves);
      if (planned.length) onMoves(planned);
      structural = true;
    } else if (!event.paths.length) return;
    else for (const changed of event.paths) written.add(changed);
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
