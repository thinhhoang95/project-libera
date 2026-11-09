import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { hasUnreadableLinkPosition, resolveMarkdownFileLink } from "@/lib/markdown-file-links";
import { getAdminRoot, getLinkedFolders, notebookPath, notebookSystemDirectoryPath } from "@/lib/storage/paths";
import type { LiberaFileNode } from "@/lib/types";

// Markdown links checked against the disk instead of a loaded tree: for the
// migration review (storage/migration.ts) and the notebook check
// (storage/integrity.ts). Both only read: nothing here writes an index.

/** Notebooks and connected linked folders, by name. */
export async function libraryNotebookNames() {
  const entries = await readdir(getAdminRoot(), { withFileTypes: true }).catch(() => []);
  return [
    ...entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name),
    ...getLinkedFolders().filter((folder) => !folder.unresolved).map((folder) => folder.name),
  ];
}

/** Each Markdown file's links, as written, from the notebook's link index (kept by tree loads; read, never written here). */
export async function readNotebookLinkIndex(notebook: string): Promise<Record<string, string[]>> {
  try {
    const index = JSON.parse(await readFile(path.join(notebookSystemDirectoryPath(notebook), "notebook-links.json"), "utf8")) as { version?: number; files?: Record<string, { destinations?: unknown }> };
    if (index.version !== 2 || !index.files) return {};
    return Object.fromEntries(Object.entries(index.files).flatMap(([file, entry]) =>
      Array.isArray(entry?.destinations) ? [[file, entry.destinations.filter((href): href is string => typeof href === "string")]] : []));
  } catch { return {}; }
}

/**
 * The library paths the editor's link resolver would consult for `href`
 * from `sourcePath` (relative first, then from the library root). Empty for
 * external links and anchors.
 */
export function linkCandidates(href: string, sourcePath: string) {
  const asked: string[] = [];
  resolveMarkdownFileLink(href, sourcePath, { get: (candidate: string) => { asked.push(candidate); return undefined; } } as unknown as ReadonlyMap<string, LiberaFileNode>);
  return asked;
}

/** Where a link points, resolved as the editor resolves it, against a given picture of which files exist. */
export function resolveLinkWith(href: string, sourcePath: string, exists: (libraryPath: string) => boolean) {
  return resolveLinkTargetWith(href, sourcePath, exists)?.path ?? null;
}

/**
 * The same, with what the link asks of its file: a heading, or a saved
 * position (an annotation, a moment in a recording), and whether that
 * position can be read at all.
 */
export function resolveLinkTargetWith(href: string, sourcePath: string, exists: (libraryPath: string) => boolean) {
  const lookup = { get: (candidate: string) => exists(candidate) ? { path: candidate, notebook: candidate.split("/")[0] } as LiberaFileNode : undefined };
  const resolved = resolveMarkdownFileLink(href, sourcePath, lookup as unknown as ReadonlyMap<string, LiberaFileNode>);
  if (!resolved) return null;
  return { path: resolved.file.path, headingFragment: resolved.headingFragment, metadata: resolved.metadata, unreadablePosition: hasUnreadableLinkPosition(href) };
}

/**
 * Which library paths are files on disk, checked once each and remembered for
 * one check. A path that could not be checked (no permission, a drive error)
 * is `unknown`, never reported as missing.
 */
export function fileExistence() {
  const known = new Map<string, "file" | "absent" | "unknown">();
  return {
    async check(libraryPaths: Iterable<string>) {
      for (const libraryPath of libraryPaths) {
        if (known.has(libraryPath)) continue;
        let state: "file" | "absent" | "unknown" = "absent";
        const [notebook, ...parts] = libraryPath.split("/");
        if (notebook && parts.length && !parts.some((part) => !part || part === "." || part === "..")) {
          try { state = (await lstat(path.join(notebookPath(notebook), ...parts))).isFile() ? "file" : "absent"; }
          catch (error) { state = ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? "absent" : "unknown"; }
        }
        known.set(libraryPath, state);
      }
    },
    exists: (libraryPath: string) => known.get(libraryPath) === "file",
    unknown: (libraryPath: string) => known.get(libraryPath) === "unknown",
  };
}
