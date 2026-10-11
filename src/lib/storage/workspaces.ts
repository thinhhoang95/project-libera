import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contextStateRoot } from "../../../electron/directory-mode.cjs";
import { ensureAdminRoot, getAdminRoot, getStateRoot } from "@/lib/storage/paths";
import { emptyWorkspaceLibrary, parseWorkspaceLibrary } from "@/lib/workspaces";
import { StorageError } from "@/lib/storage/errors";

const storagePath = (stateRoot: string) => path.join(stateRoot, ".libera-workspaces.json");
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Notebook mode and each opened folder keep separate sessions. Clients name the
 * tree root they loaded so a page that is closing after a mode switch still
 * saves into its own session.
 */
export function workspaceStateRoot(contextRoot?: string | null) {
  if (!contextRoot) return getStateRoot();
  const stateRoot = contextStateRoot(getAdminRoot(), contextRoot);
  if (!stateRoot) throw new StorageError("This folder is no longer open in Libera.", 409);
  return stateRoot;
}

export async function readWorkspaces(contextRoot?: string | null) {
  await writeQueue.catch(() => undefined);
  const stateRoot = workspaceStateRoot(contextRoot);
  const read = async (target: string) => {
    try { return parseWorkspaceLibrary(JSON.parse(await readFile(target, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const [disk, recovery] = await Promise.allSettled([
    read(storagePath(stateRoot)), read(path.join(stateRoot, ".libera-workspaces-recovery.json")),
  ]);
  const valid = [disk, recovery].flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  if (valid.length) return valid.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (disk.status === "rejected") throw disk.reason;
  if (recovery.status === "rejected") throw recovery.reason;
  return emptyWorkspaceLibrary();
}

export function writeWorkspaces(value: unknown, contextRoot?: string | null) {
  let library;
  try { library = parseWorkspaceLibrary(value); }
  catch { throw new StorageError("Invalid workspace data."); }
  const body = JSON.stringify(library);
  const stateRoot = workspaceStateRoot(contextRoot);
  const target = storagePath(stateRoot);
  const write = writeQueue.catch(() => undefined).then(async () => {
    await ensureAdminRoot();
    await mkdir(stateRoot, { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  });
  writeQueue = write;
  return write;
}
