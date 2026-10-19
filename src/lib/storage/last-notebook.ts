import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getAdminRoot, getLinkedFolder, notebookPath } from "./paths";
import { StorageError } from "./errors";
import { writeJsonState } from "./json-state";

function preferencePath() {
  return path.join(getAdminRoot(), ".libera", "last-notebook.json");
}

async function readStoredName(target: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(target, "utf8"));
    return typeof value.notebook === "string" ? value.notebook : "";
  } catch { return ""; }
}

const writes = new Map<string, Promise<unknown>>();
function withPreference<T>(target: string, run: () => Promise<T>) {
  const task = (writes.get(target) ?? Promise.resolve()).catch(() => undefined).then(run);
  writes.set(target, task);
  void task.finally(() => { if (writes.get(target) === task) writes.delete(target); }).catch(() => undefined);
  return task;
}

export async function readLastNotebookName(): Promise<string> {
  const target = preferencePath();
  await writes.get(target)?.catch(() => undefined);
  const name = await readStoredName(target);
  if (!name) return "";
  try {
    // Keep an offline linked folder selected; it remains a member of the library.
    if (getLinkedFolder(name)) return name;
    return (await stat(notebookPath(name))).isDirectory() ? name : "";
  } catch { return ""; }
}

export async function writeLastNotebookName(notebook: string) {
  const target = preferencePath();
  const root = notebookPath(notebook);
  await withPreference(target, async () => {
    // Validate at commit time, after earlier saves and lifecycle updates.
    if (!(await stat(root)).isDirectory()) throw new StorageError("Notebook not found.", 404);
    await writeJsonState(target, { notebook });
  });
}

/** Rename/remove only this selection, preserving a newer choice of another notebook. */
export function remapLastNotebookName(from: string, to = "") {
  const target = preferencePath();
  return withPreference(target, async () => {
    if (await readStoredName(target) === from) await writeJsonState(target, { notebook: to });
  });
}
