// The manifest ID of the file a companion (ink, transcript) belongs to, read
// when a save starts. The save carries it to the host, which refuses it when
// the owner moved, was removed or is another file by then (it never creates a
// companion at a vacated owner path).

import { sameManifestPath } from "./manifest-paths";

/** The owner file's ID in a shared notebook, or undefined when the host cannot say. Paths are compared as the manifest does (NFC, case), so a disk that spells the name another way still finds its owner (S-H3). */
export async function sharedOwnerFileId(liberaPath: string): Promise<string | undefined> {
  // Imported here: shared-writes reaches back into storage.
  const { listSharedEntries } = await import("./shared-writes");
  const notebook = liberaPath.split("/")[0];
  try {
    return (await listSharedEntries(notebook)).find((entry) => entry.kind !== "folder" && sameManifestPath(entry.path, liberaPath))?.fileId;
  } catch {
    return undefined;
  }
}
