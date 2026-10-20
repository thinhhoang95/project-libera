import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { StorageError } from "./errors";

/** Raw file identity, independent of annotation dates and millisecond rounding. */
export async function readFileSignature(filePath: string) {
  const stats = await stat(filePath, { bigint: true });
  if (!stats.isFile()) throw new Error("Path is not a file.");
  return `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.dev}:${stats.ino}:${filePath}`;
}

export async function assertFileSignature(filePath: string, expected: string) {
  if (await readFileSignature(filePath) !== expected) throw new StorageError("The source file changed while it was being processed. Try again.", 409);
}

export async function assertFileContentHash(filePath: string, expected: string) {
  if (await readFileContentHash(filePath) !== expected) throw new StorageError("The source file changed while it was being processed. Try again.", 409);
}

/** One coherent text snapshot; metadata alone cannot detect preserved-time edits. */
export async function readTextSnapshot(filePath: string) {
  const signature = await readFileSignature(filePath);
  const bytes = await readFile(filePath);
  await assertFileSignature(filePath, signature);
  return { content: bytes.toString("utf8"), contentHash: createHash("sha256").update(bytes).digest("hex") };
}

export async function readDirectorySignature(directory: string) {
  const stats = await stat(directory, { bigint: true });
  if (!stats.isDirectory()) throw new StorageError("Notebook was not found.", 404);
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

export async function assertDirectorySignature(directory: string, expected: string) {
  if (await readDirectorySignature(directory) !== expected) throw new StorageError("The notebook changed while its index was being built. Refresh it again.", 409);
}

// Portable identity for transcripts: copies and synced files can have different
// timestamps. Share simultaneous reads, but re-read on the next request: some
// Windows writes keep size, mtime and ctime unchanged even after replacing bytes.
const contentHashes = new Map<string, Promise<string>>();
export async function readFileContentHash(filePath: string) {
  const signature = await readFileSignature(filePath);
  const known = contentHashes.get(signature);
  if (known) return known;
  const task = (async () => {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(filePath)) hash.update(bytes);
    await assertFileSignature(filePath, signature);
    return hash.digest("hex");
  })();
  contentHashes.set(signature, task);
  void task.finally(() => { if (contentHashes.get(signature) === task) contentHashes.delete(signature); }).catch(() => undefined);
  return task;
}
