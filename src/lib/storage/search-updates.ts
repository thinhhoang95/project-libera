// Storage stays independent of the indexer (which itself reads storage). The
// running indexer registers under this key; before it exists, its first scan
// discovers changes. A storage write never creates an index or loads a model.
const INDEXER_KEY = Symbol.for("libera.searchIndexer");

export function notifySearchChanges(paths?: string[], gallery = false) {
  const store = globalThis as { [INDEXER_KEY]?: { notifyChanges(paths?: string[], gallery?: boolean): void } };
  store[INDEXER_KEY]?.notifyChanges?.(paths, gallery);
}
