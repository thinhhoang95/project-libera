import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, rename, rm, stat } from "node:fs/promises";
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
  await mkdir(path.dirname(targetPath), { recursive: true });
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
  await rm(nextPath, { force: true });
  await movePath(currentPath, nextPath);
}

export async function copyFileIfExists(currentPath: string, nextPath: string) {
  if (currentPath === nextPath) {
    return;
  }

  if (!(await pathExists(currentPath))) {
    return;
  }

  await ensureParentDirectory(nextPath);
  await copyFile(currentPath, nextPath);
}
