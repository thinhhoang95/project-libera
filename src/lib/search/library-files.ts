import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getFileType } from "@/lib/storage/file-types";
import { filePathFromParts, getAdminRoot, getLinkedFolders } from "@/lib/storage/paths";
import { isVisibleTreeEntry } from "@/lib/storage/tree";
import type { LiberaFileNode } from "@/lib/types";

/** Search needs raw file metadata, without annotation dates or UI cache work. */
export async function readSearchFile(notebook: string, pathParts: string[]): Promise<LiberaFileNode> {
  const name = pathParts.at(-1)!;
  const fileType = getFileType(name);
  if (!fileType) throw new Error("Unsupported search file.");
  const stats = await stat(filePathFromParts(notebook, pathParts));
  if (!stats.isFile()) throw new Error("Path is not a file.");
  return {
    kind: "file", name, fileType, notebook, path: [notebook, ...pathParts].join("/"),
    size: stats.size, createdAt: stats.birthtime.toISOString(), updatedAt: stats.mtime.toISOString(),
  };
}

/** No UI entry limit, link parsing, PDF cache pruning, or metadata migrations. */
export async function readSearchLibrary(shouldContinue: () => boolean) {
  const files: LiberaFileNode[] = [];
  const unavailable = new Set<string>();
  const linked = getLinkedFolders();
  const linkedNames = new Set(linked.map((folder) => folder.name));
  // A missing Master directory may be an unplugged drive. Never recreate it
  // here and mistake the new empty directory for a deletion of every notebook.
  const notebooks = (await readdir(getAdminRoot(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !linkedNames.has(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(getAdminRoot(), entry.name), linked: false, unresolved: false }));
  const roots = [...notebooks, ...linked.map((folder) => ({ ...folder, linked: true }))];

  async function visit(notebook: string, directory: string, parts: string[], isLinked: boolean) {
    if (!shouldContinue()) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch {
      // An unplugged drive or an unreadable subtree is not proof of deletion.
      unavailable.add([notebook, ...parts].join("/"));
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!isVisibleTreeEntry(entry.name, isLinked)) continue;
      if (!entry.isDirectory() && !(entry.isFile() && getFileType(entry.name))) continue;
      if (!shouldContinue()) return;
      const nextParts = [...parts, entry.name];
      if (entry.isDirectory()) await visit(notebook, path.join(directory, entry.name), nextParts, isLinked);
      else if (entry.isFile() && getFileType(entry.name)) {
        try { files.push(await readSearchFile(notebook, nextParts)); }
        catch { unavailable.add([notebook, ...nextParts].join("/")); }
      }
    }
  }

  for (const root of roots.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!shouldContinue()) break;
    if (root.unresolved) unavailable.add(root.name);
    else await visit(root.name, root.path, [], root.linked);
  }
  return { files, unavailable, cancelled: !shouldContinue() };
}
