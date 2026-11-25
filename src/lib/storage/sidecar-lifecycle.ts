import { promises as fs } from "node:fs";
import path from "node:path";
import { DestinationTakenError, readIfExists, sha256, statIfExists, writeFileAtomic, writeFileExclusive, type WriteGuard } from "../../../electron/collab/notebooks/fs-ops";

/**
 * A path-only host event cannot authorize deleting either path. Transfer an
 * identity-checked snapshot exclusively, retaining its source for recovery.
 */
export async function copyLifecycleSidecar(source: string, target: string, root: string, matchesSource: (bytes: Buffer) => Promise<boolean>): Promise<boolean> {
  if (source === target) return false;
  const original = await fs.lstat(root);
  if (!original.isDirectory() || original.isSymbolicLink()) return false;
  const bytes = await readIfExists(source);
  if (!bytes || !await matchesSource(bytes)) return false;
  const hash = sha256(bytes);
  const guard: WriteGuard = { root, canCommit: async () => {
    const current = await fs.lstat(root).catch(() => null);
    if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || current.birthtimeMs !== original.birthtimeMs) return false;
    const saved = await readIfExists(source);
    return saved !== null && sha256(saved) === hash && await statIfExists(target) === null && await matchesSource(saved);
  } };
  if (await readIfExists(target) !== null) return false;
  // Exclusive at the filesystem call: a save or a cloud arrival under this name between the checks above and now is kept, not replaced.
  try { await writeFileExclusive(target, bytes, guard); }
  catch (error) { if (error instanceof DestinationTakenError) return false; throw error; }
  return true;
}

/**
 * Retain path-only audio inputs outside the active-path pruning directories.
 * True when a recovery copy of the source's bytes is there now (written, or
 * already kept); false when none is (no source, or no safe place), so a caller
 * that retires the source knows it must not.
 */
export async function preserveLifecycleSidecar(source: string, root: string): Promise<boolean> {
  const original = await fs.lstat(root);
  const bytes = await readIfExists(source);
  if (!bytes || !original.isDirectory() || original.isSymbolicLink()) return false;
  const record = Buffer.from(JSON.stringify({ version: 1, source, contentBase64: bytes.toString("base64") }));
  const target = path.join(root, ".libera", "collab", "sidecar-recovery", `${sha256(record)}.json`);
  if (await readIfExists(target) !== null) return true;
  const guard: WriteGuard = { root, canCommit: async () => {
    const current = await fs.lstat(root).catch(() => null);
    return !!current?.isDirectory() && !current.isSymbolicLink() && current.dev === original.dev && current.ino === original.ino &&
      current.birthtimeMs === original.birthtimeMs && await statIfExists(target) === null;
  } };
  await writeFileAtomic(target, record, guard);
  return await readIfExists(target) !== null;
}
