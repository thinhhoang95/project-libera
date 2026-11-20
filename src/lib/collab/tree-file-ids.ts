import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { attachFileIds, markFileIdsUnknown } from "@/lib/storage/tree";
import { StorageError } from "@/lib/storage/errors";
import { filePathFromParts } from "@/lib/storage/paths";
import type { FileListEntry } from "@/lib/collab/local-api";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTreeNode } from "@/lib/types";

/** How long the tree waits for the host's listing before it goes without ids. */
export const FILE_LISTING_TIMEOUT_MS = 3000;

export type SharedListing = (notebook: string) => Promise<FileListEntry[]>;

/**
 * Identity is verified lazily, one file at a time, when it matters: when a tab
 * opens the file (from the bytes that read already has) and when the person
 * acts on it (one read of that file). A tree load or an incremental refresh
 * reads nothing: it only recognises copies verified earlier and unchanged since.
 *
 * A verified copy is remembered by entry, path, size, change time and blob hash.
 * The memory is only a cache, never filled by a bulk pass.
 */
const verifiedCopies = new Set<string>();
const MAX_VERIFIED_COPIES = 20_000;

type CopyStat = { size: number; changedAt: string };

function copyKey(entry: FileListEntry, copy: CopyStat) {
  return [entry.fileId, entry.path, copy.size, copy.changedAt, entry.kind === "blob" ? entry.blobHash ?? "" : ""].join("|");
}

function rememberCopy(entry: FileListEntry, copy: CopyStat) {
  if (verifiedCopies.size >= MAX_VERIFIED_COPIES) verifiedCopies.clear();
  verifiedCopies.add(copyKey(entry, copy));
}

/** Whether this copy of the node's file was already shown to be the entry, and has not changed since. */
export function isVerifiedCopy(entry: FileListEntry, node: LiberaFileNode): boolean {
  return node.changedAt !== undefined && verifiedCopies.has(copyKey(entry, { size: node.size, changedAt: node.changedAt }));
}

/** Whether `bytes` are the entry's bytes: a blob's SHA-256 is its blobHash, a document's bytes are the host's live text. */
async function bytesAreEntry(entry: FileListEntry, bytes: Buffer): Promise<boolean> {
  if (entry.kind === "blob") return Boolean(entry.blobHash) && createHash("sha256").update(bytes).digest("hex") === entry.blobHash;
  const { readSharedEntryBytes } = await import("@/lib/collab/shared-writes");
  const live = await readSharedEntryBytes(entry);
  return live !== null && live.equals(bytes);
}

/**
 * Attaches ids to \`nodes\`, the rows of one shared notebook, for the copies
 * already verified. No file is read. A listing that is unavailable or not
 * there within \`timeoutMs\` leaves the rows without ids, marked unknown.
 */
export async function attachSharedFileIdsTo(
  notebook: string,
  nodes: LiberaTreeNode[],
  list: SharedListing,
  timeoutMs = FILE_LISTING_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = { live: true };
  try {
    await Promise.race([
      list(notebook).then((entries) => { if (signal.live) attachFileIds(nodes, entries, isVerifiedCopy); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
  } catch {
    // No listing in time: the rows stay without ids.
  } finally {
    signal.live = false;
    if (timer) clearTimeout(timer);
    markFileIdsUnknown(nodes);
  }
}

/** Attaches ids (of verified copies only) to the shared notebooks among \`notebooks\`. */
export async function attachSharedFileIds(
  notebooks: LiberaNotebookNode[],
  list: SharedListing,
  isShared: (notebook: string) => boolean,
  timeoutMs = FILE_LISTING_TIMEOUT_MS,
): Promise<void> {
  await Promise.all(notebooks.filter((notebook) => isShared(notebook.name)).map((notebook) =>
    attachSharedFileIdsTo(notebook.name, notebook.children, list, timeoutMs)));
}

/** The Libera path the manifest now lists for \`fileId\`, or null when the notebook does not have that file. */
export async function sharedPathOfFileId(notebook: string, fileId: string, list: SharedListing): Promise<string | null> {
  const entry = (await list(notebook)).find((candidate) => candidate.fileId === fileId && candidate.kind !== "folder");
  return entry?.path ?? null;
}

/**
 * The identity of a file a tab opens. \`content\` is the text that read already
 * returned (nothing is read again); a file read without its bytes (a PDF, an
 * image) is verified from the cache or stays unknown, and its id is resolved
 * when it is acted on.
 */
export async function attachSharedFileIdTo(
  file: LiberaFileNode,
  content: string | undefined,
  list: SharedListing,
  timeoutMs = FILE_LISTING_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = { live: true };
  const work = async () => {
    const entry = (await list(file.notebook)).find((candidate) => candidate.path === file.path && candidate.kind !== "folder");
    if (!signal.live) return;
    if (!entry) { file.fileIdState = "mismatch"; return; }
    let verified = isVerifiedCopy(entry, file);
    if (!verified && content !== undefined) {
      verified = await bytesAreEntry(entry, Buffer.from(content, "utf8"));
      if (!signal.live) return;
      if (verified && file.changedAt !== undefined) rememberCopy(entry, { size: file.size, changedAt: file.changedAt });
      else if (!verified) { file.fileIdState = "mismatch"; return; }
    }
    if (verified) file.fileId = entry.fileId;
  };
  try {
    await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })]);
  } catch {
    // Not verified: the file has no id.
  } finally {
    signal.live = false;
    if (timer) clearTimeout(timer);
    if (!file.fileId && !file.fileIdState) file.fileIdState = "unknown";
  }
}

/**
 * The file id a rename, move or delete from the UI acts on. A request that
 * names one (the row or tab had a verified id) is passed on: the host refuses
 * when its entry at the path is another file. Without one it is resolved here,
 * for the one file the person acted on, from the manifest's entry at that path:
 *
 * - No entry: undefined. The host has no file there, so nothing can be acted on
 *   and the operation's own validation says why (its errors come first).
 * - A binary file whose copy on this disk is not the entry's bytes (one listing,
 *   one read and hash of that file; the cache spares a repeat) is refused: the
 *   path may hold another file than the one shown, or the disk is behind sync.
 * - A copy that has not reached this disk, or an online-only placeholder
 *   (macOS/Linux report no blocks for it; reading downloads it): the entry's id
 *   is taken and the host's own expectedFileId check is the guard, since it
 *   refuses when its entry at the path changed. Nobody saw a different file in
 *   a tree built from a disk that has no file there. Windows cannot tell a
 *   placeholder, so there the one file acted on is read.
 * - A document: its working copy trails the live text by design (the host
 *   writes it after edits), so a difference proves nothing about identity and
 *   no read is made; the entry's id is taken (a tab that opened it, or a row
 *   verified before, sends its own id and the host checks that).
 */
export async function resolveSharedActionFileId(
  liberaPath: string,
  given: string | undefined,
  action: string,
  list: SharedListing,
): Promise<string | undefined> {
  if (given) return given;
  const refused = () => new StorageError(`${liberaPath.split("/").at(-1) || liberaPath} is still being brought up to date by sync, so it cannot be ${action} yet. Try again once sync has caught up.`, 409);
  const notebook = liberaPath.split("/")[0];
  const entry = (await list(notebook)).find((candidate) => candidate.path === liberaPath && candidate.kind !== "folder");
  if (!entry) return undefined;
  if (entry.kind !== "blob") return entry.fileId;
  const disk = filePathFromParts(notebook, liberaPath.split("/").slice(1));
  let stats;
  try { stats = await stat(disk); } catch { return entry.fileId; }
  if (!stats.isFile()) return entry.fileId;
  if (process.platform !== "win32" && stats.size > 0 && stats.blocks === 0) return entry.fileId;
  const copy = { size: stats.size, changedAt: stats.ctime.toISOString() };
  if (verifiedCopies.has(copyKey(entry, copy))) return entry.fileId;
  if (!entry.blobHash || (entry.size !== undefined && stats.size !== entry.size)) throw refused();
  let same = false;
  try { same = await bytesAreEntry(entry, await readFile(disk)); } catch { throw refused(); }
  if (!same) throw refused();
  rememberCopy(entry, copy);
  return entry.fileId;
}
