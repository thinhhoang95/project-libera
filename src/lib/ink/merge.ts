import type { InkAuthorFile, InkChunk, InkOps, InkStroke, MergedInkStroke } from "@/lib/ink/types";

/*
 * A chunk is the union of every author's file: their strokes, minus the
 * strokes any author erased. Each author writes only their own file, so no
 * two writers ever touch the same file, and files can arrive in any order
 * through the collab host or a sync client (docs/ink-plan.md, "Key decisions").
 *
 * Tombstones: erasing records the id in the eraser's file. Before each write
 * (`compactInkAuthorFile`) an author drops their own strokes that someone
 * erased, and tombstones whose stroke no other file still holds, so files
 * stay small.
 */

/** Strokes paint oldest first; ties break by id so every computer agrees. */
export function compareInkStrokes(a: InkStroke, b: InkStroke) {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const byAuthorKey = (a: InkAuthorFile, b: InkAuthorFile) => (a.author.key < b.author.key ? -1 : a.author.key > b.author.key ? 1 : 0);

export function mergeInkFiles(files: readonly InkAuthorFile[]): InkChunk {
  const ordered = [...files].sort(byAuthorKey);
  const erased = new Set<string>();
  for (const file of ordered) for (const id of file.erased) erased.add(id);

  const byId = new Map<string, MergedInkStroke>();
  for (const file of ordered) {
    for (const stroke of file.strokes) {
      // A stroke can be in two files after an undo (see `applyInkOps`); the
      // first author by key shows it, so every computer picks the same one.
      if (!erased.has(stroke.id) && !byId.has(stroke.id)) byId.set(stroke.id, { stroke, author: file.author.key });
    }
  }

  const strokes = [...byId.values()].sort((a, b) => compareInkStrokes(a.stroke, b.stroke));
  const first = ordered[0]?.frame;
  // A Markdown ink block grows downward; the tallest author's height hides no one's ink.
  const height = Math.max(0, ...ordered.filter((file) => file.frame.width === first?.width).map((file) => file.frame.height));
  return { frame: first ? { ...first, height } : null, strokes };
}

function strokesHeldBy(others: readonly InkAuthorFile[], self: string) {
  const held = new Set<string>();
  for (const other of others) if (other.author.key !== self) for (const stroke of other.strokes) held.add(stroke.id);
  return held;
}

/**
 * Applies changes to one author's file, given every other author's file for
 * the chunk. Returns the same object when nothing changes.
 *
 * - `add` puts new strokes in the file.
 * - `erase` removes the author's own copy and records a tombstone, which
 *   compaction drops at once if no one else holds the stroke.
 * - `unerase` removes the tombstone, and keeps a copy of the stroke when its
 *   own author's file no longer has it.
 */
export function applyInkOps(file: InkAuthorFile, ops: InkOps, others: readonly InkAuthorFile[] = []): InkAuthorFile {
  const own = new Map(file.strokes.map((stroke) => [stroke.id, stroke]));
  const erased = new Set(file.erased);
  const held = strokesHeldBy(others, file.author.key);
  let changed = false;

  for (const id of ops.erase ?? []) {
    if (own.delete(id)) changed = true;
    if (!erased.has(id)) {
      erased.add(id);
      changed = true;
    }
  }

  for (const stroke of ops.unerase ?? []) {
    if (erased.delete(stroke.id)) changed = true;
    if (!held.has(stroke.id) && !own.has(stroke.id)) {
      own.set(stroke.id, stroke);
      changed = true;
    }
  }

  for (const stroke of ops.add ?? []) {
    if (erased.delete(stroke.id)) changed = true;
    if (!own.has(stroke.id)) {
      own.set(stroke.id, stroke);
      changed = true;
    }
  }

  if (!changed) return file;
  const next = compactInkAuthorFile({ ...file, strokes: [...own.values()], erased: [...erased], revision: file.revision + 1 }, others);
  // Retrying an erase of an absent stroke can add then compact away the same
  // tombstone. It must not rewrite an unchanged author file on every retry.
  if (next.strokes.length === file.strokes.length && next.strokes.every((stroke, index) => stroke === file.strokes[index]) && next.erased.length === file.erased.length && next.erased.every((id, index) => id === file.erased[index])) return file;
  return next;
}

/**
 * Drops the author's strokes another author erased, and the author's
 * tombstones for strokes no other file holds. Returns the same object when
 * nothing is dropped.
 */
export function compactInkAuthorFile(file: InkAuthorFile, others: readonly InkAuthorFile[]): InkAuthorFile {
  const erasedByOthers = new Set<string>();
  for (const other of others) if (other.author.key !== file.author.key) for (const id of other.erased) erasedByOthers.add(id);
  const held = strokesHeldBy(others, file.author.key);

  const strokes = file.strokes.filter((stroke) => !erasedByOthers.has(stroke.id));
  const erased = file.erased.filter((id) => held.has(id));
  if (strokes.length === file.strokes.length && erased.length === file.erased.length) return file;
  return { ...file, strokes, erased };
}

/**
 * Pending operations followed by more. Changes that cancel out before
 * saving (a stroke drawn and erased, an erase undone) never reach the disk.
 */
export function mergePendingInkOps(into: InkOps, ops: InkOps): InkOps {
  const add = new Map((into.add ?? []).map((stroke) => [stroke.id, stroke]));
  const erase = new Set(into.erase ?? []);
  const unerase = new Map((into.unerase ?? []).map((stroke) => [stroke.id, stroke]));
  for (const id of ops.erase ?? []) {
    if (add.delete(id) || unerase.delete(id)) continue;
    erase.add(id);
  }
  for (const stroke of ops.add ?? []) {
    // Undoing an erase that was never saved: the stroke is still on disk.
    if (erase.delete(stroke.id)) continue;
    add.set(stroke.id, stroke);
  }
  for (const stroke of ops.unerase ?? []) {
    if (!erase.delete(stroke.id)) unerase.set(stroke.id, stroke);
  }
  return { add: [...add.values()], erase: [...erase], unerase: [...unerase.values()] };
}
