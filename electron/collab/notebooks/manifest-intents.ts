// Field changes this host made to manifest entries, kept until the server has
// the result, so a concurrent change to another field cannot undo them.
//
// An entry is one plain JSON value under its fileId. A rename here and a blob
// replacement on another device each write the whole entry; on merge one whole
// entry wins, so the rename can bring back the old hash or the upload the old
// path. Splitting the entry into per-field keys would be a wire-format change
// that older clients cannot read, so the host remembers what it changed
// ({ fileId, field, from, to }) and, when a merge brings the field back to
// `from` while another field differs from what it wrote, writes `to` again on
// top of the merged entry. Intents are kept in state.json too (export/restore,
// bounded like the memory copy): a rename made offline whose merge happens
// after a restart is still protected, so its companions are not left behind (S-M2).

import type * as Y from "yjs";

/** An entry as stored: plain JSON. Read raw, so a field this version does not know survives a re-apply. */
export type EntryRecord = Record<string, unknown>;

/** The entry fields that change as one unit: a rename changes the path; a replacement changes the bytes. */
export type IntentField = "path" | "blobHash";

const UNIT: Record<IntentField, readonly string[]> = { path: ["path"], blobHash: ["blobHash", "size", "mime"] };

export interface ManifestIntent {
  fileId: string;
  field: IntentField;
  from: string;
  to: string;
  /** What the entry carried beside the field's unit when this host wrote it. */
  other: string;
  /** The field's unit as this host wrote it (and the entry's updatedAt). */
  unit: EntryRecord;
  recordedAt: number;
  /** The server has answered every update of ours, and the state still held `to` then. */
  acknowledged: boolean;
}

/** Intents kept per project: a bulk operation writes many entries, the oldest give way. */
export const MAX_INTENTS = 2000;
/** An intent older than this is dropped: a merge that late is a different story. */
export const MAX_INTENT_AGE_MS = 6 * 60 * 60 * 1000;

function isRecord(value: unknown): value is EntryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The entry without the field's own unit and its timestamp: what a concurrent whole-entry write would differ in. */
function otherPart(entry: EntryRecord, field: IntentField): string {
  const kept: EntryRecord = { ...entry };
  delete kept.updatedAt;
  for (const key of UNIT[field]) delete kept[key];
  return JSON.stringify(Object.keys(kept).sort().map((key) => [key, kept[key]]));
}

function unitOf(entry: EntryRecord, field: IntentField): EntryRecord {
  const unit: EntryRecord = { updatedAt: entry.updatedAt };
  for (const key of UNIT[field]) unit[key] = entry[key];
  return unit;
}

/**
 * Runs a write to the manifest's files map and records, for every entry it
 * changed, which fields it changed (read from the transaction's own diff, so
 * every write site is covered, whatever it writes). `write` must contain the
 * whole transaction: Yjs delivers the map event when the transaction ends.
 */
export function trackEntryWrites(files: Y.Map<unknown>, intents: ManifestIntents, write: () => void): void {
  const watch = (event: Y.YMapEvent<unknown>) => {
    for (const [fileId, change] of event.keys) {
      if (change.action !== "update") continue;
      intents.record(fileId, change.oldValue, files.get(fileId));
    }
  };
  files.observe(watch);
  try {
    write();
  } finally {
    files.unobserve(watch);
  }
}

export class ManifestIntents {
  private readonly intents = new Map<string, ManifestIntent>();
  /** Counts every change to the set, so a caller persists it only when it changed. */
  private changes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.intents.size;
  }

  /** Changes so far; equal numbers mean an unchanged set. */
  get revision(): number {
    return this.changes;
  }

  /** The intents as plain JSON, for state.json (bounded by MAX_INTENTS and MAX_INTENT_AGE_MS). */
  export(): ManifestIntent[] {
    const now = this.now();
    return [...this.intents.values()].filter((intent) => now - intent.recordedAt <= MAX_INTENT_AGE_MS).slice(-MAX_INTENTS).map((intent) => ({ ...intent, unit: { ...intent.unit } }));
  }

  /** Takes back intents saved by an earlier run; anything malformed or too old is left out. */
  restore(saved: unknown): void {
    if (!Array.isArray(saved)) return;
    const now = this.now();
    for (const item of saved.slice(-MAX_INTENTS)) {
      if (!isRecord(item) || typeof item.fileId !== "string" || (item.field !== "path" && item.field !== "blobHash")) continue;
      if (typeof item.from !== "string" || typeof item.to !== "string" || typeof item.other !== "string" || !isRecord(item.unit)) continue;
      if (typeof item.recordedAt !== "number" || !Number.isFinite(item.recordedAt) || now - item.recordedAt > MAX_INTENT_AGE_MS) continue;
      const key = `${item.fileId}\u0000${item.field}`;
      if (this.intents.has(key)) continue;
      // Not acknowledged: the server's answer is awaited again in this run.
      this.intents.set(key, { fileId: item.fileId, field: item.field, from: item.from, to: item.to, other: item.other, unit: { ...item.unit }, recordedAt: item.recordedAt, acknowledged: false });
    }
    this.changes += 1;
  }

  /** What is outstanding (tests and diagnostics). */
  list(): ManifestIntent[] {
    return [...this.intents.values()];
  }

  /** Notes the field changes between an entry as it was and as this host wrote it. */
  record(fileId: string, before: unknown, after: unknown): void {
    if (!isRecord(before) || !isRecord(after) || before.kind !== after.kind) return;
    if (typeof before.path === "string" && typeof after.path === "string" && before.path !== after.path) {
      this.remember(fileId, after, "path", before.path, after.path);
    }
    if (before.kind === "blob" && typeof before.blobHash === "string" && typeof after.blobHash === "string" && before.blobHash !== after.blobHash) {
      this.remember(fileId, after, "blobHash", before.blobHash, after.blobHash);
    }
  }

  private remember(fileId: string, after: EntryRecord, field: IntentField, from: string, to: string): void {
    const key = `${fileId}\u0000${field}`;
    this.changes += 1;
    const earlier = this.intents.get(key);
    // A second change before the first is settled still starts from the first's `from`.
    const start = earlier && earlier.to === from ? earlier.from : from;
    this.intents.delete(key);
    this.intents.set(key, { fileId, field, from: start, to, other: otherPart(after, field), unit: unitOf(after, field), recordedAt: this.now(), acknowledged: false });
    // This write changed the entry beside the other field's unit too: that field's intent now compares against the entry as this host last wrote it, or a collaborator's plain revert of it would look like a concurrent whole-entry write (M20).
    for (const other of Object.keys(UNIT) as IntentField[]) {
      if (other === field) continue;
      const sibling = this.intents.get(`${fileId}\u0000${other}`);
      if (sibling) sibling.other = otherPart(after, other);
    }
    for (const oldest of this.intents.keys()) {
      if (this.intents.size <= MAX_INTENTS) break;
      this.intents.delete(oldest);
    }
  }

  /**
   * Judges every intent against the merged manifest. Returns the records to
   * write again: a concurrent whole-entry write brought a field back to what it
   * was before this host changed it. `acknowledged`: the server has every
   * update of ours, so a state that still holds `to` is settled.
   */
  reconcile(entries: { get(fileId: string): unknown }, acknowledged: boolean): Map<string, EntryRecord> {
    const now = this.now();
    const rewrites = new Map<string, EntryRecord>();
    for (const [key, intent] of [...this.intents]) {
      const entry = entries.get(intent.fileId);
      if (!isRecord(entry) || now - intent.recordedAt > MAX_INTENT_AGE_MS) {
        this.intents.delete(key);
        this.changes += 1;
        continue;
      }
      const current = entry[intent.field];
      if (current === intent.to) {
        if (!acknowledged) intent.acknowledged = false;
        else if (intent.acknowledged) { this.intents.delete(key); this.changes += 1; }
        else intent.acknowledged = true;
        continue;
      }
      // Anything but the old value is someone's later, deliberate change; so is
      // the old value with nothing else different (a plain revert).
      if (current !== intent.from || otherPart(entry, intent.field) === intent.other) {
        this.intents.delete(key);
        this.changes += 1;
        continue;
      }
      const base = rewrites.get(intent.fileId) ?? { ...entry };
      const updatedAt = typeof base.updatedAt === "number" && typeof intent.unit.updatedAt === "number" ? Math.max(base.updatedAt, intent.unit.updatedAt) : intent.unit.updatedAt;
      rewrites.set(intent.fileId, { ...base, ...intent.unit, updatedAt });
      intent.acknowledged = false;
    }
    return rewrites;
  }
}
