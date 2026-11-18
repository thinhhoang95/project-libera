import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, cp, link, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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
  await rm(nextPath, { force: true, recursive: true });
  await movePath(currentPath, nextPath);
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
