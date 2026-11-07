import { promises as fs } from "node:fs";
import path from "node:path";
import { readIfExists, sha256, statIfExists, writeFileAtomic, type WriteGuard } from "../../../electron/collab/notebooks/fs-ops";

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
  await writeFileAtomic(target, bytes, guard);
  return true;
}

/** Retain path-only audio inputs outside the active-path pruning directories. */
export async function preserveLifecycleSidecar(source: string, root: string): Promise<void> {
  const original = await fs.lstat(root);
  const bytes = await readIfExists(source);
  if (!bytes || !original.isDirectory() || original.isSymbolicLink()) return;
  const record = Buffer.from(JSON.stringify({ version: 1, source, contentBase64: bytes.toString("base64") }));
  const target = path.join(root, ".libera", "collab", "sidecar-recovery", `${sha256(record)}.json`);
  if (await readIfExists(target) !== null) return;
  const guard: WriteGuard = { root, canCommit: async () => {
    const current = await fs.lstat(root).catch(() => null);
    return !!current?.isDirectory() && !current.isSymbolicLink() && current.dev === original.dev && current.ino === original.ino &&
      current.birthtimeMs === original.birthtimeMs && await statIfExists(target) === null;
  } };
  await writeFileAtomic(target, record, guard);
}
