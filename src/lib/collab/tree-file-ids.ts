import { attachFileIds } from "@/lib/storage/tree";
import type { FileListEntry } from "@/lib/collab/local-api";
import type { LiberaNotebookNode } from "@/lib/types";

/** How long the tree waits for the host's listing before it goes without ids. */
export const FILE_LISTING_TIMEOUT_MS = 3000;

export type SharedListing = (notebook: string) => Promise<FileListEntry[]>;

/**
 * Attaches shared file ids to the nodes of the shared notebooks among
 * `notebooks`. A notebook whose listing is unavailable (host offline, not
 * joined, slow) keeps nodes without ids, and nothing fails: the tree is the
 * same as it was before ids existed.
 */
export async function attachSharedFileIds(
  notebooks: LiberaNotebookNode[],
  list: SharedListing,
  isShared: (notebook: string) => boolean,
  timeoutMs = FILE_LISTING_TIMEOUT_MS,
): Promise<void> {
  await Promise.all(notebooks.filter((notebook) => isShared(notebook.name)).map(async (notebook) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const entries = await Promise.race([
        list(notebook.name),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
      ]);
      attachFileIds(notebook.children, entries);
    } catch {
      // No listing: the nodes stay without ids.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
}
