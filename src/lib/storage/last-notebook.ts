import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAdminRoot, notebookPath } from "./paths";
import { StorageError } from "./errors";

function preferencePath() {
  return path.join(getAdminRoot(), ".libera", "last-notebook.json");
}

export async function readLastNotebookName(): Promise<string> {
  try {
    const value = JSON.parse(await readFile(preferencePath(), "utf8"));
    return typeof value.notebook === "string" ? value.notebook : "";
  } catch { return ""; }
}

export async function writeLastNotebookName(notebook: string) {
  if (!(await stat(notebookPath(notebook))).isDirectory()) throw new StorageError("Notebook not found.", 404);
  const target = preferencePath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ notebook }) + "\n", { mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
