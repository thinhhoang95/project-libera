import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, cp, link, mkdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StorageError } from "@/lib/storage/errors";

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

export async function moveFileIfExists(currentPath: string, nextPath: string) {
  if (currentPath === nextPath) {
    return;
  }

  if (!(await pathExists(currentPath))) {
    return;
  }

  await ensureParentDirectory(nextPath);
  await rm(nextPath, { force: true, recursive: true });
  await movePath(currentPath, nextPath);
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
      let directory = path.dirname(targetPath);
      while (directory === createdRoot || directory.startsWith(`${createdRoot}${path.sep}`)) {
        try { await rmdir(directory); } catch { break; }
        if (directory === createdRoot) break;
        directory = path.dirname(directory);
      }
    }
  }
}
