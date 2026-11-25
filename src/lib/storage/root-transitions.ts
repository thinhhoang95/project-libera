import { completeRootTransition, pendingRootTransitions } from "@/lib/collab/root-transitions";
import { sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { withMovedReviewsUnder } from "@/lib/agent/review-store";
import { followNotebookRootRename } from "@/lib/storage/notebooks";
import { readWorkspaces, writeWorkspaces } from "@/lib/storage/workspaces";
import { trackWorkspaceFileChange } from "@/lib/workspaces";

// The host rebound a shared notebook to a folder that was renamed outside Libera (lib/collab/root-transitions.ts).
// The library-level records that still name the former folder (stars and tags, review keys, agent run history,
// reference attachments, saved workspaces, the last notebook) are moved to the new name here, once, and the
// record is then deleted. Every step is idempotent, so a crash between them only repeats what is already done.
// Looked at when the tree is built: no timer, and no work at all unless a rebind happened.

let running: Promise<void> | null = null;

// A record that stays unproven this long is dropped: the folder it names is not coming back.
const ABANDONED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The pending transitions in an order that never merges two notebooks' records: a transition waits while
 * another one (of a different project) still moves records away from the name it moves them to. A cycle
 * (two folders that swapped names) has no safe order with one-step moves, so it is held whole: its records
 * stay where they are, and the next look finds it again. Same-project chains were already folded into one move.
 */
function applicable(transitions: ReturnType<typeof pendingRootTransitions>) {
  const order: typeof transitions = [];
  let remaining = transitions.filter((transition) => transition.from !== transition.to);
  while (remaining.length) {
    const free = remaining.filter((transition) => !remaining.some((other) => other !== transition && other.from === transition.to));
    if (!free.length) break; // Only cycles are left: held.
    order.push(...free);
    remaining = remaining.filter((transition) => !free.includes(transition));
  }
  return order;
}

async function apply(directory: string) {
  const all = pendingRootTransitions(directory);
  for (const transition of all) if (transition.from === transition.to) completeRootTransition(directory, transition);
  for (const transition of applicable(all)) {
    // Only for the folder the host says it bound the project to: the marker there must name the same project.
    const marker = sharedNotebookMarker(transition.to);
    if (marker?.projectId === transition.projectId) {
      await followNotebookRootRename(transition.from, transition.to);
      // The pending agent reviews of its files: the folder moved on its own, so their entries follow now. A review the destination already has stays, and is Check Notebook's to report.
      await withMovedReviewsUnder(transition.from, transition.to, async () => undefined).catch((error) => console.error(`[root-transitions] Pending reviews of ${transition.from} did not follow:`, error));
      const library = await readWorkspaces();
      const next = trackWorkspaceFileChange(library, null, { moved: { from: transition.from, to: transition.to } });
      if (JSON.stringify({ ...next, updatedAt: 0 }) !== JSON.stringify({ ...library, updatedAt: 0 })) await writeWorkspaces(next);
      completeRootTransition(directory, transition);
    } else if (marker?.projectId) {
      // The folder belongs to another project now: there is nothing to move to, for good.
      completeRootTransition(directory, transition);
    } else if (!marker && Date.now() - Date.parse(transition.at) > ABANDONED_AFTER_MS) {
      completeRootTransition(directory, transition);
    }
    // An unreadable marker (a cloud provider mid-delivery), or one not there yet: kept for the next look.
  }
}

/** Applies the root renames the host recorded since the last look. Safe to call often: a folder that does not exist costs one failed read. */
export function applyPendingRootTransitions(): Promise<void> {
  const directory = process.env.LIBERA_COLLAB_LIFECYCLE_DIR;
  if (!directory) return Promise.resolve();
  if (!pendingRootTransitions(directory).length) return Promise.resolve();
  running ??= apply(directory).finally(() => { running = null; });
  return running;
}
