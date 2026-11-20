import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, cp, link, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DestinationTakenError, movePathExclusive } from "../../../electron/collab/notebooks/fs-ops";
import { StorageError } from "@/lib/storage/errors";
import { assertFileContentHash, assertFileSignature } from "./file-signature";

export async function pathExists(targetPath: string) {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function assertDirectoryExists(targetPath: string, message: string) {
  const stats = await stat(targetPath);

  if (!stats.isDirectory()) {
    throw new StorageError(message, 400);
  }

  return stats;
}

export async function ensureParentDirectory(targetPath: string) {
  return mkdir(path.dirname(targetPath), { recursive: true });
}

export async function findAvailableFilePath(directory: string, fileName: string) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let candidateName = fileName;
  let candidatePath = path.join(directory, candidateName);
  let index = 1;

  while (await pathExists(candidatePath)) {
    candidateName = `${stem}-${index}${extension}`;
    candidatePath = path.join(directory, candidateName);
    index += 1;
  }

  return {
    name: candidateName,
    path: candidatePath,
  };
}

/**
 * Rename, falling back to copy and delete when the target is on another drive,
 * as it is when a file moves between a notebook and a linked folder.
 */
export async function movePath(currentPath: string, nextPath: string) {
  try {
    await rename(currentPath, nextPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(currentPath, nextPath, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await rm(currentPath, { recursive: true, force: true });
  }
}

/**
 * Moves a file to a destination that must not exist, so a file that arrives
 * there after the caller's check is never replaced (409 instead). `caseOnly`:
 * the caller found the destination to be the file itself under another
 * spelling of its name; that is confirmed again here (same device and inode)
 * and only then renamed over, since an exclusive move would find it taken.
 */
export async function moveFileWithoutReplacing(currentPath: string, nextPath: string, { caseOnly = false } = {}) {
  if (caseOnly && await isCaseOnlyRename(currentPath, nextPath)) {
    await rename(currentPath, nextPath);
    return;
  }
  const taken = () => new StorageError("Destination file already exists.", 409);
  try { await movePathExclusive(currentPath, nextPath); }
  catch (error) {
    if (error instanceof DestinationTakenError) throw taken();
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Another drive: copy (which refuses an existing destination), then drop the source.
    try { await cp(currentPath, nextPath, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }); }
    catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code === "ERR_FS_CP_EEXIST") throw taken();
      throw copyError;
    }
    await rm(currentPath, { recursive: true, force: true });
  }
}

const PATH_LOCKS_KEY = Symbol.for("libera.pathLocks");
const lockHolder = globalThis as { [PATH_LOCKS_KEY]?: Map<string, Promise<void>> };
const pathLocks = lockHolder[PATH_LOCKS_KEY] ??= new Map<string, Promise<void>>();

/**
 * Runs `task` while no other task holds any of these paths (a save and a move
 * of one file, or two moves to one name, never interleave). All paths are
 * queued in one step, in arrival order, so tasks that share several can't
 * wait on each other. Names are compared ignoring case: over-serializing a
 * pair of names is harmless, missing a case-only alias is not.
 */
export async function withPathLocks<T>(paths: string[], task: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths.map((target) => path.resolve(target).toLowerCase()))];
  const before = keys.map((key) => pathLocks.get(key));
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  for (const key of keys) pathLocks.set(key, mine);
  try {
    await Promise.all(before.map((earlier) => earlier?.catch(() => undefined)));
    return await task();
  } finally {
    release();
    for (const key of keys) if (pathLocks.get(key) === mine) pathLocks.delete(key);
  }
}

/**
 * Replaces an existing file with new bytes (staged in a temporary file, then
 * renamed, as writeFileAtomic does) only while it still holds `expected`: the
 * file is read again right before the rename, so a file that was put at the
 * name meanwhile is refused (409) instead of overwritten. Node has no
 * compare-and-swap rename; this narrows the window from the whole save to the
 * gap between that read and the rename. A file that is gone is refused too.
 */
export async function replaceFileIfUnchanged(absolute: string, bytes: Uint8Array, expected: Buffer, messages: { gone: string; changed: string }) {
  const previous = await stat(absolute).catch(() => null);
  if (!previous) throw new StorageError(messages.gone, 409);
  const temporary = path.join(path.dirname(absolute), `.libera-tmp-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: previous.mode & 0o7777 });
    await chmod(temporary, previous.mode & 0o7777).catch(() => undefined);
    for (let attempt = 0; ; attempt += 1) {
      const current = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new StorageError(messages.gone, 409);
        throw error;
      });
      if (!current.equals(expected)) throw new StorageError(messages.changed, 409);
      try { await rename(temporary, absolute); return; }
      catch (error) {
        // Windows refuses to replace a file another program holds open: retry briefly.
        if (!["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt >= 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Whether two spellings name one file or folder on a case-insensitive disk
 * (same device and inode, names equal ignoring case): a case-only rename.
 */
export async function isCaseOnlyRename(currentPath: string, nextPath: string) {
  if (currentPath === nextPath || currentPath.toLowerCase() !== nextPath.toLowerCase()) return false;
  try {
    const [current, next] = await Promise.all([stat(currentPath, { bigint: true }), stat(nextPath, { bigint: true })]);
    return current.ino !== BigInt(0) && current.ino === next.ino && current.dev === next.dev;
  } catch {
    return false;
  }
}

/** Replaces whatever is at the destination. For a record that is meant to be replaced (a cache, a copy being refreshed); never for a person's records (see moveWithoutReplacing). */
export async function moveFileIfExists(currentPath: string, nextPath: string) {
  if (currentPath === nextPath) {
    return;
  }

  if (!(await pathExists(currentPath))) {
    return;
  }

  await ensureParentDirectory(nextPath);
  // The destination is the source under another spelling: removing it would remove the source.
  if (await isCaseOnlyRename(currentPath, nextPath)) {
    await rename(currentPath, nextPath);
    return;
  }
  await rm(nextPath, { force: true, recursive: true });
  await movePath(currentPath, nextPath);
}

/** Whether a path is a file or holds one anywhere below it (empty folders hold nothing). */
export async function holdsFiles(targetPath: string): Promise<boolean> {
  let stats;
  try { stats = await lstat(targetPath); } catch { return false; }
  if (!stats.isDirectory()) return true;
  let names: string[];
  try { names = await readdir(targetPath); } catch { return true; }
  for (const name of names) if (await holdsFiles(path.join(targetPath, name))) return true;
  return false;
}

/**
 * Like moveFileIfExists, but never deletes content at the destination: a
 * destination that holds a file (or a folder with files) is refused; one that
 * is only empty folders is replaced.
 */
export async function moveWithoutReplacing(currentPath: string, nextPath: string) {
  if (currentPath === nextPath || !(await pathExists(currentPath))) return;
  await ensureParentDirectory(nextPath);
  if (await isCaseOnlyRename(currentPath, nextPath)) {
    await rename(currentPath, nextPath);
    return;
  }
  if (await holdsFiles(nextPath)) throw new StorageError("A record of another file is already at the destination, so it was left where it is.", 409);
  // Only empty folders are cleared; the move itself publishes exclusively, so a record that arrives after the check above is kept, not removed.
  await rm(nextPath, { force: true, recursive: true });
  try { await movePathExclusive(currentPath, nextPath); }
  catch (error) {
    if (error instanceof DestinationTakenError) throw new StorageError("A record of another file is already at the destination, so it was left where it is.", 409);
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await movePath(currentPath, nextPath);
  }
}

/** Throws when something that is not a folder is in the way of creating the folders above a path. */
export async function assertCanCreateParents(targetPath: string, message: string) {
  let directory = path.dirname(targetPath);
  for (;;) {
    try {
      if (!(await stat(directory)).isDirectory()) throw new StorageError(message, 409);
      return;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") throw new StorageError(message, 409);
      if (code !== "ENOENT") return;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/** Copy sidecars atomically too, so concurrent readers never see a partial copy. */
export async function copyFileIfExists(currentPath: string, nextPath: string, { exclusive = false } = {}) {
  if (currentPath === nextPath || !(await pathExists(currentPath))) return;
  await ensureParentDirectory(nextPath);
  const temporary = `${nextPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(currentPath, temporary);
    if (exclusive) {
      try { await link(temporary, nextPath); } catch (error) {
        // FAT/exFAT has no hard links. Preserve exclusive ownership there.
        if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await copyFile(temporary, nextPath, constants.COPYFILE_EXCL);
      }
    } else await rename(temporary, nextPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Publish complete JSON in one rename; readers never see a truncated document. */
export async function writeJsonAtomically(targetPath: string, value: unknown, beforePublish?: () => Promise<void>) {
  const createdRoot = await ensureParentDirectory(targetPath);
  const temporary = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await beforePublish?.();
    await rename(temporary, targetPath);
    published = true;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
    // A source deletion can race recursive mkdir. Remove only empty directories
    // this call created, so an aborted cache write cannot resurrect a notebook.
    if (!published && createdRoot) {
      // Windows mkdir can return a \\?\ path while targetPath uses a drive
      // letter. Compare the same representation before removing empty parents.
      const createdDirectory = path.toNamespacedPath(createdRoot);
      let directory = path.toNamespacedPath(path.dirname(targetPath));
      while (directory === createdDirectory || directory.startsWith(`${createdDirectory}${path.sep}`)) {
        try { await rmdir(directory); } catch { break; }
        if (directory === createdDirectory) break;
        directory = path.dirname(directory);
      }
    }
  }
}

const sourceWrites = new Map<string, Promise<void>>();
/** A background result must still belong to the same source when it is published. */
export function writeJsonForSource(targetPath: string, value: object, sourcePath: string, signature: string, contentHash?: string) {
  const task = (sourceWrites.get(targetPath) ?? Promise.resolve()).catch(() => undefined)
    .then(() => publishSourceJson(targetPath, value, sourcePath, signature, contentHash));
  sourceWrites.set(targetPath, task);
  void task.finally(() => { if (sourceWrites.get(targetPath) === task) sourceWrites.delete(targetPath); }).catch(() => undefined);
  return task;
}

async function publishSourceJson(targetPath: string, value: object, sourcePath: string, signature: string, contentHash?: string) {
  await assertFileSignature(sourcePath, signature);
  const verify = async () => {
    await assertFileSignature(sourcePath, signature);
    if (contentHash) await assertFileContentHash(sourcePath, contentHash);
  };
  const publication = randomUUID();
  await writeJsonAtomically(targetPath, { ...value, _liberaWriteId: publication }, verify);
  try { await verify(); }
  catch (error) {
    // A deletion can race the final rename. Do not remove a newer writer's result.
    try {
      const current = JSON.parse(await readFile(targetPath, "utf8"));
      if (current._liberaWriteId === publication) await rm(targetPath, { force: true });
    } catch { /* Missing or superseded sidecar. */ }
    throw error;
  }
}
