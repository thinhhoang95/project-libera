/*
 * Decisions for open tabs when their files move (an in-app move, a repair, a
 * migration, an archive) and for saves that find the disk changed. Pure, so
 * the cases that lose text when they go wrong can be tested without a DOM;
 * use-libera-workspace.ts applies the results.
 */

/** What a tab's text becomes at its file's new path. `conflict` is the disk text when it differs from the tab's baseline. */
export type MovedText = { saved: string; draft: string; conflict: string | null };

/**
 * Reconciles a tab's text with the text now at its destination.
 * - `fetched`: what the destination holds (undefined when it could not be read).
 * - `rewrite`: set when the server rewrote the moved note itself (image URLs,
 *   citation keys). The server's text is then the authority, so there is no
 *   conflict to detect: the saved copy takes it and the draft gets the same rewrites.
 * Without a rewrite, a clean tab reloads from the disk, and a dirty tab keeps its
 * edits on its own baseline with the disk text as a conflict when that differs.
 * Returns null when there is nothing to learn (no text, no rewrite).
 */
export function reconcileMovedText(input: {
  saved: string;
  draft: string;
  fetched?: string;
  rewrite?: (text: string) => string;
}): MovedText | null {
  const { saved, draft, fetched, rewrite } = input;
  const clean = draft === saved;
  if (rewrite) {
    const baseline = rewrite(saved);
    const nextSaved = fetched ?? baseline;
    return { saved: nextSaved, draft: clean ? nextSaved : rewrite(draft), conflict: null };
  }
  if (fetched === undefined) return null;
  if (clean) return { saved: fetched, draft: fetched, conflict: null };
  if (fetched === saved || fetched === draft) return { saved: fetched, draft, conflict: null };
  return { saved, draft, conflict: fetched };
}

/** Text that is not on disk: a draft that differs, or a save that failed or is still running. */
export function hasUnsavedText(tab: { draft: string; saved: string; status: string }) {
  return tab.draft !== tab.saved || tab.status === "error" || tab.status === "saving";
}

export type PlanTab = {
  /** The tab's file path. */
  path: string;
  /** Its current draft (the live editor text). */
  draft: string;
  saved: string;
  status: string;
  /** Unsaved ink or annotations. */
  inkDirty: boolean;
  /** False for tabs that cannot take a destination: untitled, gallery, recording, page. */
  file: boolean;
};

export type PlanItem = {
  from: string;
  to: string;
  /** Moving the ink and annotations of `from` would overwrite what `to` has under the same key. */
  inkCollision: boolean;
};

/**
 * - `retarget`: the tab follows its file.
 * - `merge`: the destination is already open in another tab; this tab folds into it.
 * - `keep`: it would lose or overwrite work (the drafts differ, or the ink keys collide);
 *   the tab stays on its old path with everything it has, and the person decides.
 */
export type RetargetDecision =
  | { kind: "retarget"; from: string; to: string }
  | { kind: "merge"; from: string; to: string }
  | { kind: "keep"; from: string; to: string; reason: "drafts-differ" | "ink-collision" };

/**
 * Decides, for each moved file with an open tab, whether the tab can take its
 * destination. A destination that is another open tab (the person opened the
 * new location before repairing) must never end up as two tabs with one id.
 * A destination that is itself moving away in the same batch (a swap) is free.
 * Items whose source has no open tab are not in the result.
 */
export function planRetargets(tabs: readonly PlanTab[], items: readonly PlanItem[]): RetargetDecision[] {
  const moving = new Set(items.map((item) => item.from));
  const open = new Map<string, PlanTab>();
  for (const tab of tabs) if (tab.file && !open.has(tab.path)) open.set(tab.path, tab);
  // Destinations given to a tab earlier in this batch, with the text that tab brought.
  const claimed = new Map<string, PlanTab>();
  const decisions: RetargetDecision[] = [];
  for (const { from, to, inkCollision } of items) {
    const source = open.get(from);
    if (!source) continue;
    const occupant = moving.has(to) ? undefined : claimed.get(to) ?? open.get(to);
    if (!occupant || occupant === source) {
      claimed.set(to, source);
      decisions.push({ kind: "retarget", from, to });
      continue;
    }
    if (inkCollision) {
      decisions.push({ kind: "keep", from, to, reason: "ink-collision" });
    } else if (hasUnsavedText(source) && source.draft !== occupant.draft) {
      decisions.push({ kind: "keep", from, to, reason: "drafts-differ" });
    } else {
      decisions.push({ kind: "merge", from, to });
    }
  }
  return decisions;
}

/**
 * Where an archived folder's open files went: the archive's path replaces the
 * folder's prefix.
 */
export function pathsUnderMovedFolder(openPaths: readonly string[], folder: { from: string; to: string }) {
  return openPaths
    .filter((path) => path.startsWith(`${folder.from}/`))
    .map((path) => ({ from: path, to: `${folder.to}${path.slice(folder.from.length)}` }));
}

/** What a save that hit a changed file asks of the person. */
export type SaveConflict = { text: string | null };

/**
 * The text a Save sends its version of. Normally the tab's own saved text.
 * After a conflict the person decided to replace what is on disk: that text.
 * `ask` means no such decision exists yet; the Save must not write.
 */
export function saveBase(tab: { saved: string; diskConflict?: SaveConflict }, decided: boolean): { base: string } | { ask: true } | { base: string; gone: true } {
  const conflict = tab.diskConflict;
  if (!conflict) return { base: tab.saved };
  if (conflict.text === null) return { base: tab.saved, gone: true };
  return decided ? { base: conflict.text } : { ask: true };
}

/**
 * Saves of one document run one after another: a second request (Save, or
 * Save all before a migration) waits for the one in flight and then looks at
 * the tab again, so two writes never race on the same baseVersion.
 */
export function createSaveQueue() {
  const running = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous = running.get(key) ?? Promise.resolve();
      const next = previous.then(work, work);
      running.set(key, next);
      const clear = () => { if (running.get(key) === next) running.delete(key); };
      next.then(clear, clear);
      return next;
    },
    busy(key: string) {
      return running.has(key);
    },
  };
}
