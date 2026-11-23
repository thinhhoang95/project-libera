// How Next compares a manifest path with a path from the disk or a request.
//
// The host matches manifest paths with `manifestPathKey` (NFC and lower case),
// because a disk may hand a name back in another Unicode form (macOS) or case.
// A plain `===` or `startsWith` here would see two names for one entry, so every
// manifest-versus-disk comparison goes through these helpers.

import { manifestPathKey } from "@/lib/collab/protocol/schema";

const segmentsOf = (path: string) => path.split("/").map(manifestPathKey);

/** Whether two Libera paths name the same manifest entry. */
export function sameManifestPath(left: string, right: string): boolean {
  return manifestPathKey(left) === manifestPathKey(right);
}

/**
 * What `entryPath` holds below `folderPath`, in the entry's own spelling (so a
 * name kept for a file or a move keeps its form), or null when it is not below it.
 * The folder itself is not below itself.
 */
export function manifestPathBelow(entryPath: string, folderPath: string): string | null {
  const entry = segmentsOf(entryPath);
  const folder = segmentsOf(folderPath);
  if (entry.length <= folder.length || folder.some((segment, index) => segment !== entry[index])) return null;
  return entryPath.split("/").slice(folder.length).join("/");
}
