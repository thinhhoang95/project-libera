// The bytes of a file in a shared notebook as the collaboration host knows
// them. A follower's working file arrives through OneDrive and can lag the
// manifest, so copies, exports and downloads read the host's version rather
// than the disk (audit 2026-11-12, DATA-6).

import { StorageError } from "@/lib/storage/errors";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";

/** Codes after which there is no shared authority to ask: the disk is the only copy. */
const NO_AUTHORITY = new Set(["collab-disabled", "notebook-not-joined", "not-shared"]);

/**
 * The host's current bytes for a file of a shared notebook; null when no
 * shared authority applies (not a shared notebook, collaboration is not
 * running here, the manifest has no such file) and the disk copy is the
 * only one. A host that cannot answer is an error, never a silent fall back
 * to a working file that may be out of date.
 */
export async function readSharedAuthorityBytes(liberaPath: string): Promise<Buffer | null> {
  if (!isSharedNotebookPath(liberaPath)) return null;
  const { SharedWriteError, readSharedBlob, readSharedText } = await import("@/lib/collab/shared-writes");
  try {
    try {
      const blob = await readSharedBlob(liberaPath);
      return blob.contentBase64 === null ? null : Buffer.from(blob.contentBase64, "base64");
    } catch (error) {
      // A text file the notebook holds as a shared document: its live text.
      if (error instanceof SharedWriteError && error.status === 409 && error.code === "conflict") {
        return Buffer.from((await readSharedText(liberaPath)).text, "utf8");
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof SharedWriteError && NO_AUTHORITY.has(error.code)) return null;
    if (error instanceof SharedWriteError) {
      throw new StorageError(`${liberaPath} is not yet up to date on this device, so its current shared version was not used (${error.message}). Try again when sync has caught up.`, error.status);
    }
    throw error;
  }
}
