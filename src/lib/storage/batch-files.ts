import { manifestPathKey } from "@/lib/collab/protocol/schema";
import { isSharedOperationUnfinished } from "@/lib/collab/shared-outcomes";
import { StorageError } from "@/lib/storage/errors";
import { assertLocalFileIdentity, assertNoLeftoverRecords, deleteFile, moveFileToDirectory, MoveCommittedError, readLiberaFile } from "@/lib/storage/files";
import { followMovedLinks } from "@/lib/storage/move-links";
import { assertDirectoryExists, pathExists } from "@/lib/storage/fs-utils";
import { assertSupportedFileName } from "@/lib/storage/file-types";
import { filePathFromParts, itemPath, splitDirectoryPath, splitFilePath } from "@/lib/storage/paths";
import type { LiberaFileMovePayload, LiberaLinkRewrites, LiberaMoveStep } from "@/lib/types";

/**
 * Several files moved or deleted in one request (the notebook rail's multiple
 * selection). A batch never handles records itself: every file goes through the
 * single operation (`moveFileToDirectory`, `deleteFile`), so each keeps every
 * record, gets the same link refactor and leaves the notebook as Check Notebook
 * expects. What a batch adds is checking the whole of it before the first file moves.
 */

/** A file the caller selected: its path, and the identity its tree node had (localFileIdentity or a shared file id). */
export type BatchItem = { path: string; fileId?: string };

/** One thing wrong with a batch: the file it is about, and why. */
export type BatchProblem = { path: string; message: string };

/** The whole batch was refused before anything changed; `problems` says what is wrong. */
export class BatchRefusedError extends StorageError {
  constructor(message: string, readonly problems: BatchProblem[]) {
    super(message, 409);
  }
}

/** `moved`: in order, each with the payload the single move returns. `payload` is null when the move happened but its result could not be read. */
export type BatchMoveResult = {
  moved: {
    from: string;
    to: string;
    payload: LiberaFileMovePayload | null;
    /**
     * A shared move the host committed whose later steps (records kept on this
     * computer, links, indexes) did not all finish: the file is at `to`, and
     * these sentences say what stayed behind. Absent when everything finished.
     */
    unfinished?: string[];
  }[];
  /** The file whose move stopped the batch, and why; null when all moved. */
  failed: { path: string; error: string } | null;
  /** Never tried, because an earlier file failed. */
  notMoved: string[];
  /** Already in the destination folder: nothing to do (as the single move does). */
  unchanged: string[];
  /**
   * What the one links step of the batch did, for every note it rewrote (moved
   * or not, by its path now). Each moved file's payload carries only its own
   * rewrite, for its tab; the app applies the rest once.
   */
  links?: LiberaLinkRewrites;
  /** The links step, when it failed: the files moved, and Check Notebook lists the links that did not follow. */
  unfinished?: LiberaMoveStep[];
};

/**
 * `deleted`: every file that is gone (a shared delete the host committed counts
 * even when a later step stayed behind). `unfinished`: those files again, each
 * with what stayed behind; absent when nothing did.
 */
export type BatchDeleteResult = { deleted: string[]; failed: { path: string; error: string }[]; unfinished?: { path: string; steps: string[] }[] };

/** How one file is handled; local by default, and the route passes the shared wrappers for a shared notebook. */
export type BatchMoveHooks = {
  move?: (item: BatchItem, destinationDirectory: string) => Promise<LiberaFileMovePayload>;
  /** Replaces the local preflight (a shared notebook's operations check themselves). */
  preflight?: (items: BatchItem[], destinationDirectory: string) => Promise<BatchProblem[]>;
};

export type BatchDeleteHooks = {
  remove?: (item: BatchItem) => Promise<unknown>;
};

/** Where a path is stored: a local notebook, the active files of a shared notebook, or the local-only archive of a shared notebook. */
export type BatchDomain = "local" | "shared" | "archive";

const DOMAIN_NOTE: Record<BatchDomain, string> = {
  local: "In a local notebook.",
  shared: "In the shared notebook.",
  archive: "In the notebook's archive, which stays on this computer.",
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function baseName(filePath: string) {
  return filePath.split("/").at(-1) ?? "";
}

function parentOf(filePath: string) {
  return filePath.split("/").slice(0, -1).join("/");
}

/** A batch is one set of distinct files in one notebook. */
function assertDistinctItems(items: BatchItem[]) {
  if (!items.length) throw new StorageError("Choose at least one file.", 400);
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item.path !== "string" || !item.path) throw new StorageError("Every file needs a path.", 400);
    if (seen.has(item.path)) throw new BatchRefusedError(`${item.path} is in the selection twice, so nothing was changed.`, [{ path: item.path, message: "Listed twice." }]);
    seen.add(item.path);
  }
}

/**
 * The checks a single move makes at its destination, made for all files first:
 * no two files land on one name, each name is free of files and of the records
 * of a file that was there before, and each source is still the file chosen.
 * Reads only. A disk that ignores case counts names that differ only in case as one.
 */
export async function preflightLocalMove(items: BatchItem[], destinationDirectory: string): Promise<BatchProblem[]> {
  const destination = splitDirectoryPath(destinationDirectory);
  const problems: BatchProblem[] = [];
  try {
    await assertDirectoryExists(itemPath(destination.notebook, destination.pathParts), "Destination folder was not found.");
  } catch (error) {
    return [{ path: destinationDirectory, message: messageOf(error) }];
  }

  const landing = new Map<string, string>();
  for (const item of items) {
    const current = splitFilePath(item.path);
    if (current.notebook !== destination.notebook) {
      problems.push({ path: item.path, message: "A file moves to another notebook through the notebook migration (Move to notebook)." });
      continue;
    }
    try {
      const fileType = assertSupportedFileName(current.name);
      const nextParts = [...destination.pathParts, current.name];
      if (parentOf(item.path) === destinationDirectory) continue;
      const key = current.name.toLowerCase();
      const clash = landing.get(key);
      if (clash) {
        problems.push({ path: item.path, message: `${clash} and ${item.path} would both be named ${current.name} in ${destinationDirectory}.` });
        continue;
      }
      landing.set(key, item.path);

      if (item.fileId !== undefined) await assertLocalFileIdentity(item.path, item.fileId);
      else if (!(await pathExists(filePathFromParts(current.notebook, current.pathParts)))) throw new StorageError(`${item.path} is no longer there.`, 409);

      if (await pathExists(filePathFromParts(destination.notebook, nextParts))) throw new StorageError(`${destinationDirectory}/${current.name} already exists.`, 409);
      await assertNoLeftoverRecords(destination.notebook, nextParts, fileType, false, current.pathParts);
    } catch (error) {
      problems.push({ path: item.path, message: messageOf(error) });
    }
  }
  return problems;
}

/**
 * The proposed layout of a shared move, checked with the host's own rule (`manifestPathKey`:
 * names equal after Unicode NFC and case folding clash, as they do on disk) against
 * everything the manifest already has in the destination, selected files that stay
 * there included. The host checks the rest (identity, records) per file. When the
 * manifest cannot be read the batch is refused: uniqueness cannot be established.
 * `listEntries` is the shared notebook's authoritative list (Libera paths, as listSharedEntries returns), read once per batch.
 */
export async function preflightSharedMove(items: BatchItem[], destinationDirectory: string, listEntries: () => Promise<{ path: string }[]>): Promise<BatchProblem[]> {
  const prefix = destinationDirectory;
  let entries: { path: string }[];
  try {
    entries = await listEntries();
  } catch (error) {
    return [{ path: destinationDirectory, message: `The shared notebook's file list could not be read (${messageOf(error)}), so the destination cannot be checked.` }];
  }
  const occupied = new Map<string, string>();
  for (const entry of entries) {
    if (manifestPathKey(parentOf(entry.path)) === manifestPathKey(prefix)) occupied.set(manifestPathKey(entry.path), entry.path);
  }
  const selected = new Set(items.map((item) => item.path));
  const problems: BatchProblem[] = [];
  const landing = new Map<string, string>();
  for (const item of items) {
    // Stays where it is; it is an occupant of the destination for the others.
    if (parentOf(item.path) === destinationDirectory) continue;
    const name = baseName(item.path);
    const relative = prefix ? `${prefix}/${name}` : name;
    const key = manifestPathKey(relative);
    const clash = landing.get(key);
    if (clash) {
      problems.push({ path: item.path, message: `${clash} and ${item.path} would both be named ${name} in ${destinationDirectory}.` });
      continue;
    }
    landing.set(key, item.path);
    const occupant = occupied.get(key);
    if (!occupant) continue;
    const there = `${destinationDirectory}/${baseName(occupant)}`;
    problems.push({ path: item.path, message: selected.has(there) ? `${there} is selected too but stays in ${destinationDirectory}, so ${name} would take its name.` : `${there} already exists.` });
  }
  return problems;
}

/**
 * A batch is handled by one storage: the shared notebook's files go through the
 * collaboration host, the archive's files (recovery storage, on this computer only)
 * through local files. Every item (and the destination, for a move) is classified
 * before anything changes, and a selection that mixes them is refused whole, in
 * whatever order it was selected.
 */
export function assertOneStorageDomain(items: BatchItem[], destinationDirectory: string | null, domainOf: (path: string) => BatchDomain) {
  const domains = new Set(items.map((item) => domainOf(item.path)));
  if (domains.size > 1) {
    throw new BatchRefusedError(
      "Nothing was changed: the selection mixes files of the shared notebook with files in its archive, which are handled separately. Select one kind at a time.",
      items.map((item) => ({ path: item.path, message: DOMAIN_NOTE[domainOf(item.path)] })),
    );
  }
  if (destinationDirectory === null) return;
  const domain = [...domains][0];
  const target = domainOf(destinationDirectory);
  if (target === domain) return;
  const message = domain === "shared"
    ? "Files of a shared notebook cannot be moved into its archive: the archive stays on this computer."
    : domain === "archive"
      ? "Files in the archive cannot be moved into the shared notebook from here."
      : "The destination is in a different storage than these files.";
  throw new BatchRefusedError(`Nothing was moved: ${message}`, items.map((item) => ({ path: item.path, message })));
}

function refusal(problems: BatchProblem[]) {
  const first = problems[0];
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
  return new BatchRefusedError(`Nothing was moved: ${first.path}: ${first.message}${more}`, problems);
}

/**
 * Moves the files into one folder of their notebook. The whole batch is
 * checked first and refused, unchanged, when anything is wrong; then the files
 * move one by one through the single move. The first failure stops the batch
 * and the result says which files moved and which did not.
 */
export async function moveFilesToDirectory(items: BatchItem[], destinationDirectory: string, hooks: BatchMoveHooks = {}): Promise<BatchMoveResult> {
  assertDistinctItems(items);
  if (!destinationDirectory) throw new StorageError("Choose a destination folder.", 400);
  const problems = await (hooks.preflight ?? preflightLocalMove)(items, destinationDirectory);
  if (problems.length) throw refusal(problems);

  // Locally, links follow once for the whole batch, after the files moved: links between files moving together keep
  // their form, and no file of the batch is rewritten (and so changed from what was selected) before its own move.
  const local = !hooks.move;
  const move = hooks.move ?? ((item, directory) => moveFileToDirectory(item.path, directory, undefined, { expectedFileId: item.fileId, deferLinks: true }));
  const result: BatchMoveResult = { moved: [], failed: null, notMoved: [], unchanged: [] };
  const pending = items.filter((item) => {
    if (parentOf(item.path) !== destinationDirectory) return true;
    result.unchanged.push(item.path);
    return false;
  });

  for (const [index, item] of pending.entries()) {
    try {
      const payload = await move(item, destinationDirectory);
      result.moved.push({ from: item.path, to: payload.file.path, payload });
    } catch (error) {
      // The host committed this move and a later step stayed behind: the file moved, so it counts as moved with
      // what stayed behind reported, and the batch goes on (the move itself cannot be taken back).
      if (isSharedOperationUnfinished(error)) {
        const change = error.committed.find((entry) => entry.from === item.path && entry.to !== null);
        if (change?.to) {
          result.moved.push({ from: item.path, to: change.to, payload: null, unfinished: error.unfinished });
          continue;
        }
      }
      // The file is at its destination but its result could not be built: it moved, and the batch still stops.
      if (error instanceof MoveCommittedError) result.moved.push({ from: error.moved.from, to: error.moved.to, payload: null });
      result.failed = { path: item.path, error: messageOf(error) };
      result.notMoved = pending.slice(index + 1).map((rest) => rest.path);
      break;
    }
  }
  if (local) await followBatchLinks(result);
  return result;
}

/**
 * The links step of a local batch, once, for every file that moved (also when
 * a later file stopped the batch: those that moved still need their links).
 * Each moved note's payload gets its own rewrite and its text as it is now, as
 * a single move's would.
 */
async function followBatchLinks(result: BatchMoveResult) {
  if (!result.moved.length) return;
  const { links, unfinished } = await followMovedLinks(result.moved.map(({ from, to }) => ({ from, to })));
  for (const entry of result.moved) {
    const own = links.rewritten.find((note) => note.path === entry.to);
    if (!own || !entry.payload) continue;
    const file = await readLiberaFile(entry.to).catch(() => null);
    entry.payload = { ...entry.payload, ...(file ?? {}), links: { rewritten: [own], skipped: [], unchecked: [] } };
  }
  if (links.rewritten.length || links.skipped.length || links.unchecked.length) result.links = links;
  if (unfinished) result.unfinished = [unfinished];
}

/**
 * Deletes the files one by one through the single delete, each after its
 * identity is checked (a path that now holds another file is not deleted).
 * A failure does not stop the others; it is reported.
 */
export async function deleteFiles(items: BatchItem[], hooks: BatchDeleteHooks = {}): Promise<BatchDeleteResult> {
  assertDistinctItems(items);
  const remove = hooks.remove ?? (async (item: BatchItem) => {
    if (item.fileId) await assertLocalFileIdentity(item.path, item.fileId);
    await deleteFile(item.path);
  });
  const result: BatchDeleteResult = { deleted: [], failed: [] };
  for (const item of items) {
    try {
      await remove(item);
      result.deleted.push(item.path);
    } catch (error) {
      // The host committed the delete and a later step stayed behind: the file is gone, reported with what stayed.
      if (isSharedOperationUnfinished(error) && error.committed.some((entry) => entry.from === item.path && entry.to === null)) {
        result.deleted.push(item.path);
        (result.unfinished ??= []).push({ path: item.path, steps: error.unfinished });
        continue;
      }
      result.failed.push({ path: item.path, error: messageOf(error) });
    }
  }
  return result;
}

/** Whether all the paths are in one notebook: a batch never spans two. */
export function sameNotebook(paths: string[]) {
  const notebooks = new Set(paths.map((item) => item.split("/")[0]));
  return notebooks.size === 1;
}

