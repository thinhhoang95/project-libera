"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { applyReferenceOps } from "@/components/libera/references/use-reference-library";
import type { ReferenceEntry, ReferenceLibrary, ReferenceLibraryOp, ReferenceLibrarySettings, ReferenceLibrarySettingsPatch } from "@/lib/references/types";

// Undo for library transactions made from this window (the References panel
// and the Manage references dialog share one stack per notebook). Each
// transaction records its inverse: `put` the previous version of every entry
// it changed or deleted, `delete` the entries it added, and `set-style` /
// `set-settings` back. Undo applies the inverse as one transaction. It is
// refused once any entry the transaction touched has changed since, for
// example through another window, because the inverse would then overwrite
// that newer change.

export const REFERENCE_UNDO_LIMIT = 20;

export type ReferenceUndoRecord = {
  id: number;
  label: string;
  inverse: ReferenceLibraryOp[];
  /** Each touched entry as the transaction left it; null when it removed the entry. */
  after: Record<string, ReferenceEntry | null>;
  style?: string;
  settings?: ReferenceLibrarySettings;
};

/** JSON with sorted object keys, so key order never counts as a difference. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function same(a: unknown, b: unknown) {
  return stableJson(a) === stableJson(b);
}

/** Entry ids an op names (entries it may change or remove). Added entries are found by comparing libraries. */
export function touchedEntryIds(ops: ReferenceLibraryOp[]) {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.op === "update" || op.op === "rename-key" || op.op === "delete" || op.op === "attach" || op.op === "detach") ids.add(op.id);
    else if (op.op === "merge") [op.keepId, ...op.mergeIds].forEach((id) => ids.add(id));
    else if (op.op === "put") ids.add(op.entry.id);
  }
  return ids;
}

/**
 * The undo record for a transaction that turned `before` into `after`.
 * `touched` limits the comparison to the entries the transaction named
 * (entries added by it are always included); without it every entry is
 * compared. Null when nothing changed.
 */
export function buildUndoRecord(before: ReferenceLibrary, after: ReferenceLibrary, label: string, touched?: Iterable<string>): Omit<ReferenceUndoRecord, "id"> | null {
  const ids = new Set(touched ?? new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]));
  for (const id of Object.keys(after.entries)) if (!Object.hasOwn(before.entries, id)) ids.add(id);

  const deletes: ReferenceLibraryOp[] = [];
  const restoreChanged: ReferenceLibraryOp[] = [];
  const restoreDeleted: ReferenceLibraryOp[] = [];
  const afterEntries: Record<string, ReferenceEntry | null> = {};
  for (const id of ids) {
    const previous = Object.hasOwn(before.entries, id) ? before.entries[id] : undefined;
    const next = Object.hasOwn(after.entries, id) ? after.entries[id] : undefined;
    if (same(previous ?? null, next ?? null)) continue;
    afterEntries[id] = next ? structuredClone(next) : null;
    if (!previous) deletes.push({ op: "delete", id });
    else if (next) restoreChanged.push({ op: "put", entry: structuredClone(previous) });
    else restoreDeleted.push({ op: "put", entry: structuredClone(previous) });
  }
  // Order matters for key checks: added entries free their keys first, then
  // changed entries give back aliases they took over (merge), then removed
  // entries return with their keys.
  const inverse: ReferenceLibraryOp[] = [...deletes, ...restoreChanged, ...restoreDeleted];
  const record: Omit<ReferenceUndoRecord, "id"> = { label, inverse, after: afterEntries };
  if (before.style !== after.style) {
    inverse.push({ op: "set-style", style: before.style });
    record.style = after.style;
  }
  if (!same(before.settings ?? {}, after.settings ?? {})) {
    // set-settings merges, so every setting the transaction changed is written back explicitly (null: it was unset).
    const settings: ReferenceLibrarySettingsPatch = { autoCreateForPdfs: before.settings?.autoCreateForPdfs ?? null };
    inverse.push({ op: "set-settings", settings });
    record.settings = structuredClone(after.settings ?? {});
  }
  return inverse.length ? record : null;
}

/** True when an entry (or the style or settings) the record touched has changed since it was recorded. */
export function isUndoStale(record: Pick<ReferenceUndoRecord, "after" | "style" | "settings">, library: ReferenceLibrary) {
  for (const [id, after] of Object.entries(record.after)) {
    const current = Object.hasOwn(library.entries, id) ? library.entries[id] : null;
    if (!same(current, after)) return true;
  }
  if (record.style !== undefined && library.style !== record.style) return true;
  if (record.settings !== undefined && !same(library.settings ?? {}, record.settings)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Per-notebook stacks shared by every component in this window
// ---------------------------------------------------------------------------

type UndoStore = {
  stack: ReferenceUndoRecord[];
  listeners: Set<() => void>;
  /** Changes recorded here apply one at a time, so each one's "before" is the previous one's result. */
  queue: Promise<unknown>;
  last: ReferenceLibrary | null;
};

const undoStores = new Map<string, UndoStore>();
let nextRecordId = 1;
const EMPTY_STACK: ReferenceUndoRecord[] = [];

function undoStoreFor(notebook: string) {
  let store = undoStores.get(notebook);
  if (!store) {
    store = { stack: [], listeners: new Set(), queue: Promise.resolve(), last: null };
    undoStores.set(notebook, store);
  }
  return store;
}

function setStack(notebook: string, stack: ReferenceUndoRecord[]) {
  const store = undoStoreFor(notebook);
  store.stack = stack;
  for (const listener of store.listeners) listener();
}

function newest(a: ReferenceLibrary | null, b: ReferenceLibrary | null) {
  if (!a) return b;
  if (!b) return a;
  return b.revision > a.revision ? b : a;
}

/** Remember a transaction that turned `before` into `after`. */
export function recordReferenceTransaction(notebook: string, before: ReferenceLibrary, after: ReferenceLibrary, label: string, touched?: Iterable<string>) {
  const store = undoStoreFor(notebook);
  store.last = newest(store.last, after);
  const record = buildUndoRecord(before, after, label, touched);
  if (!record) return;
  setStack(notebook, [...store.stack, { ...record, id: nextRecordId++ }].slice(-REFERENCE_UNDO_LIMIT));
}

/** Forget every undo stack (tests, sign-out). */
export function resetReferenceUndo() {
  undoStores.clear();
}

/** ⌘/Ctrl+Z without Shift or Alt, outside text fields (which keep their own undo). */
export function isReferenceUndoShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target: EventTarget | null }) {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "z") return false;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable);
}

/**
 * Library changes with undo. `apply(ops, label)` commits ops through the
 * client store and records their inverse; `undo()` reverts the last one.
 */
export function useReferenceUndo(notebook: string | null, library: ReferenceLibrary | null) {
  const libraryRef = useRef(library);
  useEffect(() => {
    libraryRef.current = library;
  }, [library]);

  const subscribe = useCallback((listener: () => void) => {
    if (!notebook) return () => undefined;
    const store = undoStoreFor(notebook);
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
  }, [notebook]);
  const getSnapshot = useCallback(() => notebook ? undoStoreFor(notebook).stack : EMPTY_STACK, [notebook]);
  const stack = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_STACK);

  const apply = useCallback((ops: ReferenceLibraryOp[], label: string): Promise<ReferenceLibrary> => {
    if (!notebook) return Promise.reject(new Error("Open a notebook to change its references."));
    const store = undoStoreFor(notebook);
    const run = store.queue.catch(() => undefined).then(async () => {
      const before = newest(libraryRef.current, store.last);
      const after = await applyReferenceOps(notebook, ops);
      if (before) recordReferenceTransaction(notebook, before, after, label, touchedEntryIds(ops));
      else store.last = newest(store.last, after);
      return after;
    });
    store.queue = run;
    return run;
  }, [notebook]);

  /** Record a change committed elsewhere (an import route) so it can be undone too. */
  const record = useCallback((before: ReferenceLibrary, after: ReferenceLibrary, label: string, touched?: Iterable<string>) => {
    if (notebook) recordReferenceTransaction(notebook, before, after, label, touched);
  }, [notebook]);

  const top = stack.at(-1);
  const stale = Boolean(top && library && isUndoStale(top, library));

  const undo = useCallback(async () => {
    if (!notebook) return null;
    const store = undoStoreFor(notebook);
    const record = store.stack.at(-1);
    if (!record) return null;
    const current = libraryRef.current;
    if (current && isUndoStale(record, current)) throw new Error("This change can no longer be undone: the references it touched changed since.");
    setStack(notebook, store.stack.slice(0, -1));
    try {
      const after = await applyReferenceOps(notebook, record.inverse);
      store.last = newest(store.last, after);
      return after;
    } catch (error) {
      setStack(notebook, [...undoStoreFor(notebook).stack, record]);
      throw error;
    }
  }, [notebook]);

  return {
    apply,
    record,
    undo,
    canUndo: Boolean(top) && !stale,
    undoLabel: top?.label ?? null,
    stale,
    depth: stack.length,
  };
}
