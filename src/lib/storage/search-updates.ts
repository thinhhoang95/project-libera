// Storage stays independent of the indexer (which itself reads storage). The
// running indexer registers under this key; before it exists, its first scan
// discovers changes. A storage write never creates an index or loads a model.
const INDEXER_KEY = Symbol.for("libera.searchIndexer");

type IndexerHooks = {
  notifyChanges?(paths?: string[], gallery?: boolean): void;
  notifyReferenceChanges?(notebooks?: string[]): void;
};

export function notifySearchChanges(paths?: string[], gallery = false) {
  const store = globalThis as { [INDEXER_KEY]?: IndexerHooks };
  store[INDEXER_KEY]?.notifyChanges?.(paths, gallery);
}

/** A notebook's References library changed (every library without `notebooks`); Global Search indexes entries. */
export function notifySearchReferenceChanges(notebooks?: string[]) {
  const store = globalThis as { [INDEXER_KEY]?: IndexerHooks };
  store[INDEXER_KEY]?.notifyReferenceChanges?.(notebooks);
}
