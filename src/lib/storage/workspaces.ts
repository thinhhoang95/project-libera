import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureAdminRoot, getAdminRoot } from "@/lib/storage/paths";
import { emptyWorkspaceLibrary, parseWorkspaceLibrary } from "@/lib/workspaces";
import { StorageError } from "@/lib/storage/errors";

const storagePath = () => path.join(getAdminRoot(), ".libera-workspaces.json");
let writeQueue: Promise<unknown> = Promise.resolve();

export async function readWorkspaces() {
  await writeQueue.catch(() => undefined);
  const read = async (target: string) => {
    try { return parseWorkspaceLibrary(JSON.parse(await readFile(target, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const [disk, recovery] = await Promise.allSettled([
    read(storagePath()), read(path.join(getAdminRoot(), ".libera-workspaces-recovery.json")),
  ]);
  const valid = [disk, recovery].flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  if (valid.length) return valid.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (disk.status === "rejected") throw disk.reason;
  if (recovery.status === "rejected") throw recovery.reason;
  return emptyWorkspaceLibrary();
}

export function writeWorkspaces(value: unknown) {
  let library;
  try { library = parseWorkspaceLibrary(value); }
  catch { throw new StorageError("Invalid workspace data."); }
  const body = JSON.stringify(library);
  const target = storagePath();
  const write = writeQueue.catch(() => undefined).then(async () => {
    await ensureAdminRoot();
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  });
  writeQueue = write;
  return write;
}
