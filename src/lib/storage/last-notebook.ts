import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getAdminRoot, notebookPath } from "./paths";
import { StorageError } from "./errors";
import { writeJsonState } from "./json-state";

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
  await writeJsonState(preferencePath(), { notebook });
}
