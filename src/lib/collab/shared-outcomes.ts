import { StorageError } from "@/lib/storage/errors";

/**
 * One file the collaboration host has committed in a shared operation: a move
 * (`to` is its new path) or a delete (`to` is null). Paths are Libera paths
 * (`Notebook/dir/file.md`); `fileId` is the manifest file ID when known.
 */
export type SharedCommittedChange = { from: string; to: string | null; fileId?: string };

/**
 * Thrown by a shared file or folder operation (moveSharedFile, deleteSharedFile,
 * renameSharedFolder, deleteSharedFolder) when the host has committed the change
 * but a step after it (the records kept on this computer, links, indexes) did not
 * finish. The change itself cannot be taken back, so a caller (the files route,
 * the batch, the renderer) treats `committed` as done: it retargets tabs, updates
 * saved workspaces and counts the item as moved or deleted, and reports
 * `unfinished` (one plain sentence per step that stayed behind).
 */
export class SharedOperationUnfinishedError extends StorageError {
  readonly committed: SharedCommittedChange[];
  readonly unfinished: string[];

  constructor(message: string, committed: SharedCommittedChange[], unfinished: string[]) {
    super(message, 500);
    this.name = "SharedOperationUnfinishedError";
    this.committed = committed;
    this.unfinished = unfinished;
  }
}

export function isSharedOperationUnfinished(error: unknown): error is SharedOperationUnfinishedError {
  return error instanceof SharedOperationUnfinishedError;
}
