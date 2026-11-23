import { completeRootTransition, pendingRootTransitions } from "@/lib/collab/root-transitions";
import { sharedNotebookMarker } from "@/lib/collab/shared-notebook";
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

async function apply(directory: string) {
  // Oldest first; a chain A to B to C arrives as one move A to C (pendingRootTransitions).
  for (const transition of pendingRootTransitions(directory)) {
    if (transition.from === transition.to) { completeRootTransition(directory, transition); continue; }
    // Only for the folder the host says it bound the project to: the marker there must name the same project.
    const marker = sharedNotebookMarker(transition.to);
    if (marker?.projectId === transition.projectId) {
      await followNotebookRootRename(transition.from, transition.to);
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
