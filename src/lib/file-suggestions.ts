import type { LiberaFileNode } from "./types";

export const FILE_SUGGESTION_LIMIT = 50;

// Normalize and sort when the library changes, not on each character or arrow key.
export function indexFileSuggestions(files: LiberaFileNode[]) {
  return [...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({
    file,
    name: file.name.toLocaleLowerCase(),
    search: `${file.name}\n${file.path}`.toLocaleLowerCase(),
  }));
}

export function findFileSuggestions(index: ReturnType<typeof indexFileSuggestions>, query: string) {
  const normalized = query.toLocaleLowerCase();
  const prefix: LiberaFileNode[] = [];
  const other: LiberaFileNode[] = [];
  let count = 0;
  for (const entry of index) {
    if (!entry.search.includes(normalized)) continue;
    count++;
    const bucket = entry.name.startsWith(normalized) ? prefix : other;
    if (bucket.length < FILE_SUGGESTION_LIMIT) bucket.push(entry.file);
  }
  return {
    files: [...prefix, ...other].slice(0, FILE_SUGGESTION_LIMIT),
    hasMore: count > FILE_SUGGESTION_LIMIT,
  };
}
