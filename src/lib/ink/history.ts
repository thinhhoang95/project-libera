import type { InkOps, InkStroke, MergedInkStroke } from "@/lib/ink/types";

/*
 * Undo and redo for one surface, as operations on the author's own file
 * (`applyInkOps`), never as snapshots: undoing an erase of someone else's
 * stroke removes this author's tombstone instead of rewriting their file.
 */

export type InkHistoryEntry = {
  added: InkStroke[];
  /** What was erased, with whose file held it. */
  removed: MergedInkStroke[];
  /** Entries with the same key (one eraser drag) undo as one step. */
  gesture?: string;
};

const MAX_ENTRIES = 200;

export class InkHistory {
  private undoStack: InkHistoryEntry[] = [];
  private redoStack: InkHistoryEntry[] = [];

  constructor(private readonly author: string) {}

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  record(entry: InkHistoryEntry) {
    if (!entry.added.length && !entry.removed.length) return;
    const last = this.undoStack.at(-1);
    if (entry.gesture && last?.gesture === entry.gesture) {
      const added = new Map(last.added.map((stroke) => [stroke.id, stroke]));
      for (const item of entry.removed) {
        // A partial eraser can cut a piece it made earlier in this gesture.
        if (!added.delete(item.stroke.id)) last.removed.push(item);
      }
      for (const stroke of entry.added) added.set(stroke.id, stroke);
      last.added = [...added.values()];
    } else {
      this.undoStack.push({ added: [...entry.added], removed: [...entry.removed], gesture: entry.gesture });
      if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /** The operations that undo the last step, or null. */
  undo(): InkOps | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return {
      erase: entry.added.map((stroke) => stroke.id),
      add: entry.removed.filter((item) => item.author === this.author).map((item) => item.stroke),
      unerase: entry.removed.filter((item) => item.author !== this.author).map((item) => item.stroke),
    };
  }

  /** The operations that redo the last undone step, or null. */
  redo(): InkOps | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return { add: entry.added, erase: entry.removed.map((item) => item.stroke.id) };
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
