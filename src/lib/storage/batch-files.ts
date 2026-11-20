import { StorageError } from "@/lib/storage/errors";
import { assertLocalFileIdentity, assertNoLeftoverRecords, deleteFile, moveFileToDirectory, MoveCommittedError } from "@/lib/storage/files";
import { assertDirectoryExists, pathExists } from "@/lib/storage/fs-utils";
import { assertSupportedFileName } from "@/lib/storage/file-types";
import { filePathFromParts, itemPath, splitDirectoryPath, splitFilePath } from "@/lib/storage/paths";
import type { LiberaFileMovePayload } from "@/lib/types";

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
  moved: { from: string; to: string; payload: LiberaFileMovePayload | null }[];
  /** The file whose move stopped the batch, and why; null when all moved. */
  failed: { path: string; error: string } | null;
  /** Never tried, because an earlier file failed. */
  notMoved: string[];
  /** Already in the destination folder: nothing to do (as the single move does). */
  unchanged: string[];
};

export type BatchDeleteResult = { deleted: string[]; failed: { path: string; error: string }[] };

/** How one file is handled; local by default, and the route passes the shared wrappers for a shared notebook. */
export type BatchMoveHooks = {
  move?: (item: BatchItem, destinationDirectory: string) => Promise<LiberaFileMovePayload>;
  /** Replaces the local preflight (a shared notebook's operations check themselves). */
  preflight?: (items: BatchItem[], destinationDirectory: string) => Promise<BatchProblem[]>;
};

export type BatchDeleteHooks = {
  remove?: (item: BatchItem) => Promise<unknown>;
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

/** Only name uniqueness can be known without the host: the shared move checks the rest itself. */
export async function preflightSharedMove(items: BatchItem[], destinationDirectory: string): Promise<BatchProblem[]> {
  const problems: BatchProblem[] = [];
  const landing = new Map<string, string>();
  for (const item of items) {
    if (parentOf(item.path) === destinationDirectory) continue;
    const key = baseName(item.path).toLowerCase();
    const clash = landing.get(key);
    if (clash) problems.push({ path: item.path, message: `${clash} and ${item.path} would both be named ${baseName(item.path)} in ${destinationDirectory}.` });
    else landing.set(key, item.path);
  }
  return problems;
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

  const move = hooks.move ?? ((item, directory) => moveFileToDirectory(item.path, directory, undefined, { expectedFileId: item.fileId }));
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
      // The file is at its destination but its result could not be built: it moved, and the batch still stops.
      if (error instanceof MoveCommittedError) result.moved.push({ from: error.moved.from, to: error.moved.to, payload: null });
      result.failed = { path: item.path, error: messageOf(error) };
      result.notMoved = pending.slice(index + 1).map((rest) => rest.path);
      break;
    }
  }
  return result;
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

