// The bytes of a file in a shared notebook as the collaboration host knows
// them. A follower's working file arrives through OneDrive and can lag the
// manifest, so copies, exports and downloads read the host's version rather
// than the disk (audit 2026-11-12, DATA-6).

import { StorageError } from "@/lib/storage/errors";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";

/**
 * Codes after which there is no shared authority to ask: the disk is the only copy. A revoked notebook keeps
 * its folder (marked revoked) so the person can export it: every caller here only reads.
 */
export const NO_AUTHORITY = new Set(["collab-disabled", "notebook-not-joined", "not-shared", "access-revoked"]);

function authorityFailure(what: string, error: unknown): never {
  if (error instanceof Error && error.name === "SharedWriteError") {
    const { status } = error as Error & { status: number };
    throw new StorageError(`${what} is not yet up to date on this device, so its current shared version was not used (${error.message}). Try again when sync has caught up.`, status);
  }
  throw error;
}

/**
 * The entries of a shared notebook as the host's manifest lists them (Libera
 * paths, folders included); null when no shared authority applies and the
 * disk is the only copy. A host that cannot answer is an error: guessing the
 * list from the disk is how a download omits new files or keeps deleted ones.
 */
export async function listSharedAuthorityEntries(notebook: string) {
  if (!isSharedNotebookPath(`${notebook}/.`)) return null;
  const { SharedWriteError, listSharedEntries } = await import("@/lib/collab/shared-writes");
  try {
    return await listSharedEntries(notebook);
  } catch (error) {
    if (error instanceof SharedWriteError && NO_AUTHORITY.has(error.code)) return null;
    return authorityFailure(`The file list of ${notebook}`, error);
  }
}

/** The bytes of one listed entry from the host (null for a folder or an entry that just left the manifest). */
export async function readSharedAuthorityEntry(entry: import("@/lib/collab/local-api").FileListEntry) {
  const { readSharedEntryBytes } = await import("@/lib/collab/shared-writes");
  try {
    return await readSharedEntryBytes(entry);
  } catch (error) {
    return authorityFailure(entry.path, error);
  }
}

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

/**
 * What the collaboration host holds at a path of a shared notebook, for a copy.
 * `authority: false`: nothing to ask (collaboration is off here, the notebook is
 * not joined), so the disk is the only copy. `absent`: the host answered that the
 * manifest has no such file. That is an answer, not a missing authority: a
 * collaborator deleted or moved it, and whatever a lagging disk still holds is not
 * what to copy. `text` and `blob` carry the identity (manifest file ID, and the
 * blob hash) of the version read, so the copy is of one version of one file.
 */
export type SharedSourceSnapshot =
  | { authority: false }
  | { authority: true; kind: "absent" }
  | { authority: true; kind: "text"; text: string; fileId: string; docId: string }
  | { authority: true; kind: "blob"; bytes: Buffer; fileId: string; blobHash: string };

/** `textFirst`: the file is of a text type, so the shared document is asked for before a blob. */
export async function readSharedSourceSnapshot(liberaPath: string, textFirst: boolean): Promise<SharedSourceSnapshot> {
  if (!isSharedNotebookPath(liberaPath)) return { authority: false };
  const { SharedWriteError, readSharedBlob, readSharedText } = await import("@/lib/collab/shared-writes");
  const asBlob = async (): Promise<SharedSourceSnapshot> => {
    const blob = await readSharedBlob(liberaPath);
    if (blob.contentBase64 === null) return { authority: true, kind: "absent" };
    return { authority: true, kind: "blob", bytes: Buffer.from(blob.contentBase64, "base64"), fileId: blob.fileId as string, blobHash: blob.blobHash as string };
  };
  const asText = async (): Promise<SharedSourceSnapshot> => {
    const { doc, text } = await readSharedText(liberaPath);
    return { authority: true, kind: "text", text, fileId: doc.fileId, docId: doc.docId };
  };
  try {
    if (textFirst) {
      try {
        return await asText();
      } catch (error) {
        // Not a document: a text file the notebook holds as a file, or one that left the manifest.
        if (!(error instanceof SharedWriteError && error.code === "not-shared-document")) throw error;
        return await asBlob();
      }
    }
    try {
      return await asBlob();
    } catch (error) {
      // The host's answer for a path that is a document, not a binary file.
      if (error instanceof SharedWriteError && error.status === 409 && error.code === "conflict") return await asText();
      throw error;
    }
  } catch (error) {
    if (error instanceof SharedWriteError && NO_AUTHORITY.has(error.code)) return { authority: false };
    if (error instanceof SharedWriteError) {
      throw new StorageError(`${liberaPath} is not yet up to date on this device, so its current shared version was not copied (${error.message}). Try again when sync has caught up.`, error.status);
    }
    throw error;
  }
}

/** The refusal for a copy whose source the host no longer lists. */
export function sharedSourceGone(liberaPath: string) {
  return new StorageError(`${liberaPath} was deleted or moved by a collaborator, so it was not copied. Refresh the file list.`, 404);
}
