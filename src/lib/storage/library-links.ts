import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
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
 * one check. The match is exact, as the app's own: its tree is built from
 * `readdir` names and stars, tags, reviews, attachments and links match paths
 * by string, so `Paper.pdf` is not there when the file is `paper.pdf` (which
 * macOS and Windows would open), and a name that differs only in Unicode
 * normalization is not there either. Each folder is listed once, and every
 * name on the way must be in its folder's listing. A path that could not be
 * checked (no permission, a drive error) is `unknown`, never reported as
 * missing.
 */
export function fileExistence() {
  const known = new Map<string, "file" | "absent" | "unknown">();
  const listings = new Map<string, Promise<Map<string, Dirent> | "absent" | "unknown">>();
  const list = (directory: string) => {
    if (!listings.has(directory)) {
      listings.set(directory, readdir(directory, { withFileTypes: true }).then(
        (entries) => new Map(entries.map((entry) => [entry.name, entry] as const)),
        (error): "absent" | "unknown" => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? "absent" : "unknown",
      ));
    }
    return listings.get(directory)!;
  };
  const stateOf = async (libraryPath: string): Promise<"file" | "absent" | "unknown"> => {
    const [notebook, ...parts] = libraryPath.split("/");
    if (!notebook || !parts.length || parts.some((part) => !part || part === "." || part === "..")) return "absent";
    let directory = notebookPath(notebook);
    for (const [index, part] of parts.entries()) {
      const entries = await list(directory);
      if (typeof entries === "string") return entries;
      const entry = entries.get(part);
      if (!entry) return "absent";
      if (index === parts.length - 1) return entry.isFile() ? "file" : "absent";
      directory = path.join(directory, part);
    }
    return "absent";
  };
  return {
    async check(libraryPaths: Iterable<string>) {
      for (const libraryPath of libraryPaths) {
        if (!known.has(libraryPath)) known.set(libraryPath, await stateOf(libraryPath));
      }
    },
    exists: (libraryPath: string) => known.get(libraryPath) === "file",
    unknown: (libraryPath: string) => known.get(libraryPath) === "unknown",
  };
}
