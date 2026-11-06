// What the PDF viewer talks to in a shared notebook (plan §3): a list of
// annotations that changes under it, a commit that turns the viewer's next
// list into field changes, and undo that only ever touches this person's own
// work. It is plain TypeScript; pdf-viewer.tsx adapts it to React.

import type * as Y from "yjs";
import { applyMarkValues, applyMarksDiff, marksOf, readMark, restoreMark, visibleMarks, writeDeletedText, type MarkChange, type MarkContext, type MarkRecord } from "./model";
import type { PdfAnnotation } from "@/lib/types";

/** Origin of this window's changes to the marks. */
export class PdfEditOrigin {
  constructor(readonly docId: string) {}
}

export interface PdfMarkSource {
  readonly annotations: Y.Doc;
  /** Called after a sub-document was replaced (a reject rollback). */
  onRebuild(listener: (subdoc: string) => void): () => void;
}

export interface PdfStoreChange {
  /** This window made the change. */
  local: boolean;
  /** Marks someone else deleted just now. */
  removed: MarkRecord[];
}

interface HistoryEntry {
  key?: string;
  time: number;
  changes: MarkChange[];
}

const MAX_UNDO_STEPS = 100;
const COALESCE_MS = 800;

function mergeChanges(earlier: MarkChange[], later: MarkChange[]): MarkChange[] {
  const merged = new Map(earlier.map((change) => [change.id, { ...change, before: { ...change.before }, after: { ...change.after } }]));
  for (const change of later) {
    const existing = merged.get(change.id);
    if (!existing) {
      merged.set(change.id, change);
      continue;
    }
    existing.before = { ...change.before, ...existing.before };
    existing.after = { ...existing.after, ...change.after };
  }
  return [...merged.values()];
}

export class SharedPdfStore {
  private records = new Map<string, MarkRecord>();
  private snapshot: PdfAnnotation[] = [];
  private readonly listeners = new Set<(change: PdfStoreChange) => void>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private version = 0;
  private stopObserving: () => void = () => {};
  private readonly stopRebuild: () => void;
  readonly origin: PdfEditOrigin;

  constructor(private readonly source: PdfMarkSource, docId: string, private context: MarkContext) {
    this.origin = new PdfEditOrigin(docId);
    this.bind();
    this.stopRebuild = source.onRebuild((subdoc) => {
      if (subdoc !== "annotations") return;
      // Field values recorded for undo may name state the server refused.
      this.undoStack = [];
      this.redoStack = [];
      this.bind();
      this.publish({ local: false, removed: [] });
    });
  }

  private get doc(): Y.Doc {
    return this.source.annotations;
  }

  private bind() {
    this.stopObserving();
    const marks = marksOf(this.doc);
    const observer = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, transaction: Y.Transaction) => {
      const touched = new Set<string>();
      for (const event of events) {
        const [id] = event.path;
        if (typeof id === "string") touched.add(id);
        else for (const key of event.keys.keys()) touched.add(key);
      }
      const removed: MarkRecord[] = [];
      for (const id of touched) {
        const mark = marks.get(id);
        const before = this.records.get(id);
        const after = mark ? readMark(mark) : null;
        if (after) this.records.set(id, after);
        else this.records.delete(id);
        if (transaction.origin !== this.origin && before && !before.deleted && (!after || after.deleted)) removed.push(after ?? before);
      }
      this.rebuildSnapshot();
      this.publish({ local: transaction.origin === this.origin, removed });
    };
    marks.observeDeep(observer);
    this.stopObserving = () => marks.unobserveDeep(observer);
    this.records = new Map();
    for (const [id, mark] of marks.entries()) {
      const record = readMark(mark);
      if (record) this.records.set(id, record);
    }
    this.rebuildSnapshot();
  }

  private rebuildSnapshot() {
    this.snapshot = visibleMarks(this.records.values());
  }

  private publish(change: PdfStoreChange) {
    this.version += 1;
    for (const listener of [...this.listeners]) listener(change);
  }

  getSnapshot = (): PdfAnnotation[] => this.snapshot;
  getVersion = (): number => this.version;

  subscribe = (listener: (change: PdfStoreChange) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  setContext(context: MarkContext) {
    this.context = context;
  }

  record(id: string): MarkRecord | undefined {
    return this.records.get(id);
  }

  /** Deleted marks, newest deletion first, for Restore. */
  deleted(): MarkRecord[] {
    return [...this.records.values()].filter((record) => record.deleted).sort((a, b) => (b.deleted as { at: string }).at.localeCompare((a.deleted as { at: string }).at));
  }

  /**
   * Makes the marks match `next`. `historyKey` coalesces a gesture into one
   * undo step, as the viewer's own history does; `history: false` leaves no
   * step behind (a note abandoned empty).
   */
  commit(next: readonly PdfAnnotation[], historyKey?: string, options: { history?: boolean } = {}) {
    const previous = this.snapshot;
    if (next === previous) return;
    const changes = applyMarksDiff(this.doc, previous, next, this.context, this.origin);
    if (!changes.length || options.history === false) return;
    const time = Date.now();
    const last = this.undoStack.at(-1);
    if (historyKey && last?.key === historyKey && time - last.time < COALESCE_MS) {
      last.changes = mergeChanges(last.changes, changes);
      last.time = time;
    } else {
      this.undoStack = [...this.undoStack, { key: historyKey, time, changes }].slice(-MAX_UNDO_STEPS);
    }
    this.redoStack = [];
    this.publish({ local: true, removed: [] });
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /**
   * One press is one step. A step someone else has since overwritten applies
   * nothing, and is still used up: reaching past it could undo something
   * larger than the person meant, like the mark's creation.
   */
  private step(from: HistoryEntry[], to: HistoryEntry[], side: "before" | "after", expected: "before" | "after"): boolean {
    const entry = from.pop();
    if (!entry) return false;
    to.push(entry);
    let applied = false;
    for (const change of [...entry.changes].reverse()) {
      if (applyMarkValues(this.doc, change.id, change[side], change[expected], this.context, this.origin)) applied = true;
    }
    this.publish({ local: true, removed: [] });
    return applied;
  }

  undo(): boolean { return this.step(this.undoStack, this.redoStack, "before", "after"); }
  redo(): boolean { return this.step(this.redoStack, this.undoStack, "after", "before"); }

  /** Removes a mark from the history: the viewer's empty note shells never count as steps. */
  forget(id: string) {
    const without = (entry: HistoryEntry) => ({ ...entry, changes: entry.changes.filter((change) => change.id !== id) });
    this.undoStack = this.undoStack.map(without).filter((entry) => entry.changes.length);
    this.redoStack = this.redoStack.map(without).filter((entry) => entry.changes.length);
    this.publish({ local: true, removed: [] });
  }

  restore(id: string): boolean {
    return restoreMark(this.doc, id, this.context, this.origin);
  }

  /** Keeps what was typed into a note someone deleted meanwhile. */
  keepDeletedText(id: string, text: string) {
    if (this.records.get(id)?.deleted) writeDeletedText(this.doc, id, text, this.origin);
  }

  destroy() {
    this.stopObserving();
    this.stopRebuild();
    this.listeners.clear();
  }
}
