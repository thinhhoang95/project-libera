/*
 * Caches that are keyed by file path but live outside the workspace hook (the
 * Preview mode of a Markdown tab, ...) learn about moves here, so they follow
 * the file instead of keeping a path that no longer exists. `remap` is pure.
 */

export type PathRemap = (path: string) => string;

const handlers = new Set<(remap: PathRemap) => void>();

export function onPathsMoved(handler: (remap: PathRemap) => void) {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

export function notifyPathsMoved(remap: PathRemap) {
  for (const handler of [...handlers]) handler(remap);
}

/** `path` with the folder (or notebook) prefix `from` replaced by `to`; paths elsewhere are unchanged. */
export function renamePathPrefix(path: string, from: string, to: string) {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

/** The record with its keys remapped, or the same object when no key changed. */
export function remapRecordKeys<T>(record: Record<string, T>, remap: PathRemap): Record<string, T> {
  const entries = Object.entries(record);
  if (!entries.some(([path]) => remap(path) !== path)) return record;
  return Object.fromEntries(entries.map(([path, value]) => [remap(path), value]));
}

/**
 * The open file tabs under `from` and where each goes when `from` becomes `to`
 * (a folder or notebook rename): one batch for planRetargets.
 */
export function prefixRetargets(openPaths: readonly string[], from: string, to: string) {
  return openPaths
    .filter((path) => path.startsWith(`${from}/`))
    .map((path) => ({ from: path, to: renamePathPrefix(path, from, to) }));
}
