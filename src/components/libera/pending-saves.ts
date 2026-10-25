"use client";

import { useSyncExternalStore } from "react";
import { registerStateFlusher } from "./deferred-save";

/*
 * Ink and annotation changes wait in memory until the person saves, as a
 * note's text does: notebooks are often synced (OneDrive), and every save is
 * an upload. Each view with unsaved changes registers here under its file's
 * library path (gallery photos under `gallery:<id>`); Save, the tab's unsaved
 * dot and the close and quit prompts ask this registry.
 *
 * Unsaved changes are also kept in a recovery journal in IndexedDB, which
 * lives in the app's own profile (Electron's userData), not in the synced
 * master directory. A crash, power cut or restart loses nothing: the changes
 * come back as unsaved when the file is opened again. Only Close without
 * saving (and a successful save) clears them.
 */

type Entry = {
  dirty: boolean;
  save: () => Promise<void>;
  discard?: () => void;
  writer?: unknown;
  /** The file moved: write to `path` from now on; `sources` maps a cross-notebook move's old image sources to new ones. */
  retarget?: (path: string, sources?: Record<string, string>) => void;
};

const entries = new Map<string, Map<string, Entry & { mounted: boolean }>>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

// ---- The recovery journal ------------------------------------------------------

const DATABASE = "libera-unsaved";
const STORE = "changes";
/** Journal writes for one key are coalesced this long; they are local, but still disk writes. */
const JOURNAL_DELAY_MS = 800;

type JournalRecord = { id: string; path: string; key: string; data: unknown; at: number };

let database: Promise<IDBDatabase | null> | null = null;
/** Paths with journal records, so a closed or unmounted view still counts as unsaved. */
const journaled = new Map<string, Set<string>>();
const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; record: JournalRecord }>();
// Keep the latest value after its timer fires too: IndexedDB can be unavailable.
// Null also prevents the initial database scan from resurrecting a removed key.
const records = new Map<string, JournalRecord | null>();
const discardedPaths = new Set<string>();
const writes = new Set<Promise<void>>();

function track(write: Promise<void>) {
  writes.add(write);
  void write.finally(() => writes.delete(write)).catch(() => undefined);
  return write;
}

function open(): Promise<IDBDatabase | null> {
  database ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("path", "path");
    };
    request.onsuccess = () => {
      const db = request.result;
      const all = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      all.onsuccess = () => {
        for (const record of all.result as JournalRecord[]) {
          if (records.has(record.id)) continue;
          if (discardedPaths.has(record.path)) {
            records.set(record.id, null);
            void track(deleteRecords([record.id]));
          } else {
            records.set(record.id, record);
            addJournaled(record.path, record.key);
          }
        }
        changed();
        resolve(db);
      };
      all.onerror = () => resolve(db);
    };
    // Private windows and blocked storage: unsaved changes still work, without recovery.
    request.onerror = () => resolve(null);
  });
  return database;
}

function addJournaled(path: string, key: string) {
  const keys = journaled.get(path) ?? new Set<string>();
  keys.add(key);
  journaled.set(path, keys);
}

function removeJournaled(path: string, key: string) {
  const keys = journaled.get(path);
  keys?.delete(key);
  if (keys && !keys.size) journaled.delete(path);
}

const recordId = (path: string, key: string) => `${path}\u0000${key}`;

async function writeRecord(record: JournalRecord) {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

async function deleteRecords(ids: string[]) {
  const db = await open();
  if (!db || !ids.length) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const id of ids) store.delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

/** Writes every coalesced journal record now: before the window goes away. */
export async function flushJournal() {
  const records = [...waiting.values()].map((item) => {
    clearTimeout(item.timer);
    return item.record;
  });
  waiting.clear();
  for (const record of records) track(writeRecord(record));
  await Promise.all([...writes]);
}

if (typeof window !== "undefined") {
  void open();
  registerStateFlusher(flushJournal);
}

export const unsavedJournal = {
  /** Keeps a view's unsaved changes locally, replacing what it kept before. */
  put(path: string, key: string, data: unknown) {
    const id = recordId(path, key);
    const previous = waiting.get(id);
    if (previous) clearTimeout(previous.timer);
    const record = { id, path, key, data, at: Date.now() };
    records.set(id, record);
    const wasNew = !journaled.get(path)?.has(key);
    addJournaled(path, key);
    waiting.set(id, {
      record,
      timer: setTimeout(() => {
        waiting.delete(id);
        void track(writeRecord(record));
      }, JOURNAL_DELAY_MS),
    });
    if (wasNew) changed();
  },

  async get<T>(path: string, key: string): Promise<T | null> {
    const id = recordId(path, key);
    if (records.has(id)) return (records.get(id)?.data as T | undefined) ?? null;
    const db = await open();
    if (records.has(id)) return (records.get(id)?.data as T | undefined) ?? null;
    if (!db) return null;
    return new Promise((resolve) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      request.onsuccess = () => resolve(((records.has(id) ? records.get(id) : request.result as JournalRecord | undefined)?.data as T | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
  },

  remove(path: string, key: string) {
    const id = recordId(path, key);
    const pending = waiting.get(id);
    if (pending) clearTimeout(pending.timer);
    waiting.delete(id);
    records.set(id, null);
    const had = journaled.get(path)?.has(key);
    removeJournaled(path, key);
    void track(deleteRecords([id]));
    if (had) changed();
  },

  /** Drops every unsaved change kept for a file: Close without saving. */
  removePath(path: string) {
    discardedPaths.add(path);
    const keys = [...(journaled.get(path) ?? [])];
    for (const key of keys) this.remove(path, key);
  },

  /** A file moved or was renamed: its unsaved changes go with it. A newer record already at `to` wins. */
  async movePath(from: string, to: string) {
    if (from === to) return;
    await open();
    const keys = [...(journaled.get(from) ?? [])];
    for (const key of keys) {
      const data = await this.get(from, key);
      this.remove(from, key);
      if (data !== null && !journaled.get(to)?.has(key)) this.put(to, key, data);
    }
  },
};

// ---- The registry ------------------------------------------------------------------

export const pendingSaves = {
  /** A view's unsaved state for a file; returns the function that unregisters it. */
  register(path: string, key: string, entry: Entry) {
    const registered = { ...entry, mounted: true };
    const forPath = entries.get(path) ?? new Map<string, Entry & { mounted: boolean }>();
    forPath.set(key, registered);
    entries.set(path, forPath);
    changed();
    return () => {
      const current = entries.get(path);
      if (current?.get(key) !== registered) return;
      registered.mounted = false;
      // Source mode and tab switches can unmount a dirty view. Save must still
      // be able to write it, and a remount must reuse any request in flight.
      if (registered.dirty) return;
      current.delete(key);
      if (!current.size) entries.delete(path);
      changed();
    };
  },

  getWriter<T>(path: string, key: string): T | undefined {
    return entries.get(path)?.get(key)?.writer as T | undefined;
  },

  setDirty(path: string, key: string, dirty: boolean) {
    const entry = entries.get(path)?.get(key);
    if (!entry || entry.dirty === dirty) return;
    entry.dirty = dirty;
    if (!dirty && !entry.mounted) {
      const current = entries.get(path)!;
      current.delete(key);
      if (!current.size) entries.delete(path);
    }
    changed();
  },

  /** Unsaved ink or annotations for a file, in an open view or kept for recovery. */
  isDirty(path: string) {
    for (const entry of entries.get(path)?.values() ?? []) if (entry.dirty) return true;
    return journaled.has(path);
  },

  anyDirty(openPaths?: string[]) {
    const open = openPaths ? new Set(openPaths) : null;
    for (const [path, forPath] of entries) for (const entry of forPath.values()) if (entry.dirty && (!open || entry.mounted || open.has(path))) return true;
    // Recovery for a deleted file stays available if it returns, but must not
    // block quitting when there is no tab or view in which to save/discard it.
    return open ? [...open].some((path) => journaled.has(path)) : journaled.size > 0;
  },

  /** Saves every open view's unsaved changes for a file. */
  async save(path: string) {
    const dirty = [...(entries.get(path)?.values() ?? [])].filter((entry) => entry.dirty);
    for (const entry of dirty) await entry.save();
  },

  /**
   * A file moved or was renamed (with `prefix`, every file under a folder or
   * notebook): its unsaved changes follow it. Open writers are re-keyed and
   * retargeted, and journal their state under the new path; recovery records
   * of views that are not open move as they are.
   */
  moveUnsaved(from: string, to: string, options: { prefix?: boolean; sources?: Record<string, string> } = {}) {
    if (from === to) return;
    const moved = (path: string) => (path === from ? to : options.prefix && path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null);
    for (const path of [...journaled.keys()]) {
      const next = moved(path);
      if (!next) continue;
      for (const key of [...(journaled.get(path) ?? [])]) {
        const live = entries.get(path)?.has(key);
        const record = records.get(recordId(path, key));
        // Not read from IndexedDB yet: moved once the startup scan has it (below).
        if (!live && record === undefined) continue;
        unsavedJournal.remove(path, key);
        if (!live && record && !journaled.get(next)?.has(key)) unsavedJournal.put(next, key, record.data);
      }
    }
    for (const [path, forPath] of [...entries]) {
      const next = moved(path);
      if (!next) continue;
      entries.delete(path);
      const target = entries.get(next) ?? new Map<string, Entry & { mounted: boolean }>();
      entries.set(next, target);
      for (const [key, entry] of forPath) {
        target.set(key, entry);
        entry.retarget?.(next, options.sources);
      }
    }
    changed();
    void open().then(() => {
      for (const path of [...journaled.keys()]) {
        const next = moved(path);
        if (next) void unsavedJournal.movePath(path, next);
      }
    });
  },

  /** Close without saving: the unsaved changes are dropped, here and in the journal. */
  discard(path: string) {
    for (const [key, entry] of entries.get(path) ?? []) {
      entry.discard?.();
      entry.dirty = false;
      unsavedJournal.remove(path, key);
    }
    unsavedJournal.removePath(path);
    changed();
  },
};

/** For tests: forget every unsaved change, registered or journaled. */
export function resetPendingSavesForTests() {
  for (const item of waiting.values()) clearTimeout(item.timer);
  waiting.clear();
  records.clear();
  discardedPaths.clear();
  database = null;
  journaled.clear();
  entries.clear();
  changed();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-renders when any file's unsaved state changes; read `pendingSaves.isDirty` after it. */
export function usePendingSavesVersion() {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** Whether a file has unsaved ink or annotations. */
export function useHasPendingSaves(path: string) {
  usePendingSavesVersion();
  return pendingSaves.isDirty(path);
}
