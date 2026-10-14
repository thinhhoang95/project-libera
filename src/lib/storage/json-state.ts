import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const writes = new Map<string, Promise<void>>();

/** Serialize a sidecar's writes and leave its inode/mtime alone if unchanged. */
export function writeJsonState(target: string, value: unknown) {
  const body = JSON.stringify(value);
  const task = (writes.get(target) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    try {
      const existing = await readFile(target, "utf8");
      if (existing.trim() === body) return;
      try { if (JSON.stringify(JSON.parse(existing)) === body) return; } catch { /* Replace malformed state. */ }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  });
  writes.set(target, task);
  void task.finally(() => { if (writes.get(target) === task) writes.delete(target); }).catch(() => undefined);
  return task;
}
