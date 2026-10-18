import { entryForKey, libraryEntriesByKey } from "@/lib/references/format";
import { planReferenceCopy, type ReferenceCopyPlan } from "@/lib/references/moves";
import { readReferenceLibrary, ReferenceRevisionConflict, updateReferenceLibrary } from "@/lib/storage/references";

// Copy entries into another notebook's library by key (POST
// /api/references/copy), for a quote cited into a note of another notebook.
// It is the copy half of copy-on-move (moves.ts): the destination entry for
// the same work is reused (identifier, else a ≥ 0.95 fuzzy match), otherwise
// the entry is copied with its key when that key is free there, or a
// generated one. Nothing else changes; the caller writes the citation with
// the destination key.

export type ReferenceCopyResult = {
  /** Each requested key the source library resolves → the key to cite in the destination. */
  keys: Record<string, string>;
  copied: ReferenceCopyPlan["copied"];
  reused: ReferenceCopyPlan["reused"];
  /** Requested keys the source library does not have. */
  missing: string[];
  /** The destination library's revision after the copy; null when nothing was written. */
  destinationRevision: number | null;
};

const LIBRARY_ATTEMPTS = 3;

export async function copyReferenceEntries(from: string, to: string, keys: string[]): Promise<ReferenceCopyResult> {
  const unique = [...new Set(keys)];
  const source = await readReferenceLibrary(from);
  const sourceByKey = libraryEntriesByKey(source);
  const found = unique.filter((key) => entryForKey(sourceByKey, key));
  const missing = unique.filter((key) => !found.includes(key));
  if (from === to) {
    // Same library: every resolvable key cites as it is.
    return { keys: Object.fromEntries(found.map((key) => [key, key])), copied: [], reused: [], missing, destinationRevision: null };
  }

  let plan: ReferenceCopyPlan | null = null;
  let destinationRevision: number | null = null;
  for (let attempt = 1; !plan; attempt += 1) {
    const destination = await readReferenceLibrary(to);
    const candidate = planReferenceCopy(source, destination, found);
    if (!candidate.ops.length) { plan = candidate; break; }
    try {
      destinationRevision = (await updateReferenceLibrary(to, destination.revision, candidate.ops)).revision;
      plan = candidate;
    } catch (error) {
      // Another writer changed the destination meanwhile: plan again against its new state.
      if (!(error instanceof ReferenceRevisionConflict) || attempt >= LIBRARY_ATTEMPTS) throw error;
    }
  }

  const { keyMap, copied, reused } = plan as ReferenceCopyPlan;
  return {
    keys: Object.fromEntries(found.map((key) => [key, keyMap.get(key) ?? key])),
    copied,
    reused,
    missing,
    destinationRevision,
  };
}
