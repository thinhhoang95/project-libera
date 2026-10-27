"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { InkHistory } from "@/lib/ink/history";
import type { PhotoInkView as PhotoView } from "@/lib/ink/frame";
import type { InkFrame, InkOps, InkStroke, MergedInkStroke } from "@/lib/ink/types";
import { compareInkStrokes, mergePendingInkOps } from "@/lib/ink/merge";
import { apiRequest } from "../api-client";
import { pendingSaves, unsavedJournal } from "../pending-saves";
import { OWN_AUTHOR, type InkChange } from "./ink-surface";

/*
 * One chunk of a file's ink, as the surface draws it: loaded from /api/ink,
 * changed in memory, and written to this author's file (storage/ink.ts) only
 * when the person saves, as a note's text is (pending-saves.ts). Unsaved
 * changes are kept in the local recovery journal meanwhile, and the file
 * counts as unsaved for the tab's dot and the close and quit prompts.
 *
 * Other windows hear about saves over a BroadcastChannel and reload; ink from
 * collaborators and other computers is picked up when the window regains
 * focus. Neither replaces unsaved changes here.
 */

type ChunkPayload = { chunk: string; frame: InkFrame | null; strokes: MergedInkStroke[]; revision: number; renderingMissing?: boolean };
/** A gallery photo's ink also says how the photo shown today is made from the one it was drawn on (gallery-ink.ts). */
export type PhotoInkView = {
  original: { width: number; height: number };
  view: PhotoView;
  viewSize: { width: number; height: number };
  changed: boolean;
};
type InkPayload = { path: string; author: string; chunks: ChunkPayload[]; photo?: PhotoInkView };

const CHANNEL = "libera-ink";

const isEmpty = (ops: InkOps) => !ops.add?.length && !ops.erase?.length && !ops.unerase?.length;

/** A notebook file's chunk, or (with `photoId`) a gallery photo's ink. */
type WriterTarget = { path: string; chunk: string; frame: InkFrame; rendering?: string; photoId?: string };

/** Where unsaved changes are registered: the file's library path, or `gallery:<id>`. */
export const inkSavePath = ({ path, photoId }: Pick<WriterTarget, "path" | "photoId">) => (photoId ? `gallery:${photoId}` : path);
const inkSaveKey = (chunk: string) => `ink:${chunk}`;

function readUrl({ path, chunk, photoId, rendering }: WriterTarget) {
  if (photoId) return `/api/gallery/photos/ink?id=${encodeURIComponent(photoId)}`;
  return `/api/ink?path=${encodeURIComponent(path)}&chunks=${chunk}${rendering ? `&rendering=${encodeURIComponent(rendering)}` : ""}`;
}

/** What the recovery journal keeps for a chunk: a batch that may or may not have landed, then newer changes. */
type JournalEntry = { retry: InkOps | null; pending: InkOps; resized: boolean; frame: InkFrame; retryFrame?: InkFrame; retryResized?: boolean };

/** A chunk's unsaved changes, written on Save; a failed batch is sent again as-is before newer ones. */
export class InkWriter {
  private pending: InkOps = {};
  private retry: { ops: InkOps; resized: boolean; target: WriterTarget } | null = null;
  private inFlight: typeof this.retry = null;
  private saving: Promise<void> | null = null;
  private resizing = false;
  private generation = 0;
  private target: WriterTarget;
  private onSaved: (payload: InkPayload, idle: boolean) => void = () => {};
  private onError: (message: string | null) => void = () => {};

  constructor(target: WriterTarget) {
    this.target = target;
  }

  setTarget(target: WriterTarget) {
    this.target = target;
  }

  /**
   * The file moved (pending-saves.ts): unsaved changes, and a failed batch
   * waiting to be sent again, go to `path`. An ink block's rendering source
   * follows a cross-notebook move's new image sources.
   */
  retarget(path: string, sources?: Record<string, string>) {
    if (this.target.photoId) return;
    const moved = (target: WriterTarget): WriterTarget => ({
      ...target,
      path,
      ...(target.rendering && sources?.[target.rendering] ? { rendering: sources[target.rendering] } : {}),
    });
    this.target = moved(this.target);
    if (this.retry) this.retry = { ...this.retry, target: moved(this.retry.target) };
    this.remember();
  }

  get frame() {
    return this.target.frame;
  }

  setCallbacks(onSaved: (payload: InkPayload, idle: boolean) => void, onError: (message: string | null) => void) {
    this.onSaved = onSaved;
    this.onError = onError;
  }

  /** A new height waits to be saved. */
  get frameDirty() {
    return this.resizing || Boolean(this.retry?.resized || this.inFlight?.resized);
  }

  /** Nothing waiting and nothing in flight: the disk has every change. */
  get idle() {
    return isEmpty(this.pending) && !this.retry && !this.inFlight && !this.frameDirty && !this.saving;
  }

  private get savePath() {
    return inkSavePath(this.target);
  }

  /** Records the unsaved state: the tab's dot, and the recovery journal. */
  private remember() {
    const batch = this.retry ?? this.inFlight;
    const dirty = !isEmpty(this.pending) || this.resizing || Boolean(batch);
    pendingSaves.setDirty(this.savePath, inkSaveKey(this.target.chunk), dirty);
    if (!dirty) {
      unsavedJournal.remove(this.savePath, inkSaveKey(this.target.chunk));
      return;
    }
    const entry: JournalEntry = { retry: batch?.ops ?? null, pending: this.pending, resized: this.resizing, frame: this.target.frame, ...(batch ? { retryFrame: batch.target.frame, retryResized: batch.resized } : {}) };
    unsavedJournal.put(this.savePath, inkSaveKey(this.target.chunk), entry);
  }

  push(ops: InkOps) {
    this.pending = mergePendingInkOps(this.pending, ops);
    this.remember();
  }

  markFrame() {
    this.resizing = true;
    this.remember();
  }

  /** Unsaved changes from the recovery journal, after a crash or restart. */
  restore(entry: JournalEntry) {
    // A retained writer already owns these changes (and possibly a request).
    if (!this.idle) return;
    this.retry = entry.retry ? { ops: entry.retry, resized: entry.retryResized ?? entry.resized, target: { ...this.target, frame: entry.retryFrame ?? entry.frame } } : null;
    this.pending = mergePendingInkOps(this.pending, entry.pending);
    this.resizing ||= entry.resized && (!entry.retry || entry.retryResized !== undefined);
    this.remember();
  }

  /** Close without saving. */
  discard() {
    this.generation += 1;
    this.pending = {};
    this.retry = null;
    this.inFlight = null;
    this.resizing = false;
    this.remember();
  }

  async save(): Promise<void> {
    while (this.saving) await this.saving.catch(() => undefined);
    if (!this.retry && isEmpty(this.pending) && !this.resizing) return;

    // A failed response may follow a successful write. Retry that batch as-is
    // before newer changes, which must still reach disk even if they undo it.
    const batch = this.retry ?? { ops: this.pending, resized: this.resizing, target: this.target };
    const generation = this.generation;
    if (this.retry) this.retry = null;
    else {
      this.pending = {};
      this.resizing = false;
    }
    const { ops } = batch;
    this.inFlight = batch;
    this.remember();
    const { path, chunk, frame, rendering, photoId } = batch.target;
    this.saving = (async () => {
      try {
        const payload = photoId
          ? await apiRequest<InkPayload>("/api/gallery/photos/ink", { method: "PATCH", body: JSON.stringify({ id: photoId, ops }) })
          : await apiRequest<InkPayload>("/api/ink", {
            method: "PATCH",
            body: JSON.stringify({ path, chunk, frame, ops, ...(rendering ? { rendering } : {}) }),
          });
        if (generation !== this.generation) return;
        this.onError(null);
        this.onSaved(payload, isEmpty(this.pending) && !this.resizing);
        try {
          const channel = new BroadcastChannel(CHANNEL);
          try { channel.postMessage({ path: photoId ?? path, chunk }); } finally { channel.close(); }
        } catch { /* no channel support */ }
      } catch (cause) {
        // Kept for the next Save; the journal still has it.
        if (generation === this.generation) {
          this.retry = batch;
          this.onError(cause instanceof Error ? cause.message : "Ink could not be saved.");
        }
        throw cause;
      } finally {
        this.inFlight = null;
        this.saving = null;
        this.remember();
      }
    })();
    await this.saving;
    if (!isEmpty(this.pending) || this.resizing) await this.save();
  }
}

/** Strokes as shown after unsaved changes from the journal (their authors are not known: this author's). */
function withOps(strokes: readonly MergedInkStroke[], ops: InkOps, author: string): MergedInkStroke[] {
  const erased = new Set(ops.erase ?? []);
  const kept = strokes.filter((item) => !erased.has(item.stroke.id));
  const known = new Set(kept.map((item) => item.stroke.id));
  const added = [...(ops.add ?? []), ...(ops.unerase ?? [])].filter((stroke) => !known.has(stroke.id)).map((stroke) => ({ stroke, author }));
  return [...kept, ...added].sort((a, b) => compareInkStrokes(a.stroke, b.stroke));
}

export function useInkDocument({ path, chunk, frame: initialFrame, rendering, photoId }: WriterTarget) {
  // Frame and rendering are updated below; identity follows the file and chunk.
  const writer = useMemo(() => pendingSaves.getWriter<InkWriter>(inkSavePath({ path, photoId }), inkSaveKey(chunk)) ?? new InkWriter({ path, chunk, frame: initialFrame, rendering, photoId }), [path, chunk, photoId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [strokes, setStrokes] = useState<MergedInkStroke[]>([]);
  const [frame, setFrame] = useState<InkFrame>(() => writer.frame);
  const [author, setAuthor] = useState(OWN_AUTHOR);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [photo, setPhoto] = useState<PhotoInkView | null>(null);
  const history = useRef<InkHistory | null>(null);
  const loadVersion = useRef(0);
  const recovered = useRef<InkWriter | null>(null);
  /** Whose file held each stroke this surface removed, so undo gives it back to them. */
  const authors = useRef(new Map<string, string>());
  const latest = useRef({ path, chunk, frame, rendering, author, photoId });
  useLayoutEffect(() => { latest.current = { path, chunk, frame, rendering, author, photoId }; });
  useLayoutEffect(() => { writer.setTarget({ path, chunk, frame, rendering, photoId }); });

  const apply = useCallback((whole: InkPayload, includeStrokes = true) => {
    const payload = whole.chunks[0];
    if (includeStrokes) setStrokes(payload.strokes);
    if (whole.photo) {
      const { original } = whole.photo;
      setPhoto(whole.photo);
      setFrame({ unit: "px", width: original.width, height: original.height });
      return;
    }
    const height = payload.frame?.height;
    // A height chosen here and not yet saved wins over an older one on disk.
    if (height) setFrame((current) => (height > current.height || !writer.frameDirty ? { ...current, height } : current));
  }, [writer]);

  useLayoutEffect(() => {
    writer.setCallbacks((payload, idle) => {
      loadVersion.current += 1;
      if (idle) apply(payload);
    }, setError);
    return () => { writer.setCallbacks(() => {}, () => {}); };
  }, [writer, apply]);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const target = latest.current;
    try {
      const payload = await apiRequest<InkPayload>(readUrl(target));
      const firstLoad = recovered.current !== writer;
      const kept = firstLoad ? await unsavedJournal.get<JournalEntry>(inkSavePath(target), inkSaveKey(target.chunk)) : null;
      if (version !== loadVersion.current || target.path !== latest.current.path || target.chunk !== latest.current.chunk || target.photoId !== latest.current.photoId) return null;
      setAuthor(payload.author);
      history.current ??= new InkHistory(payload.author);
      // Unsaved local changes win until they are saved.
      apply(payload, writer.idle && !kept);
      if (kept) {
        writer.restore(kept);
        setStrokes(withOps(withOps(payload.chunks[0].strokes, kept.retry ?? {}, payload.author), kept.pending, payload.author));
        if (kept.resized || kept.retryResized) setFrame(kept.frame);
      }
      recovered.current = writer;
      if (firstLoad && payload.chunks[0].renderingMissing) writer.markFrame();
      setLoaded(true);
      setError(null);
      return payload;
    } catch (cause) {
      if (version !== loadVersion.current) return null;
      setError(cause instanceof Error ? cause.message : "Ink could not be loaded.");
      setLoaded(true);
      return null;
    }
  }, [apply, writer]);

  const commit = useCallback((ops: InkOps, removedIds: Set<string>, added: MergedInkStroke[]) => {
    writer.push(ops);
    setStrokes((current) => {
      for (const item of current) if (removedIds.has(item.stroke.id)) authors.current.set(item.stroke.id, item.author);
      return [...current.filter((item) => !removedIds.has(item.stroke.id)), ...added].sort((a, b) => compareInkStrokes(a.stroke, b.stroke));
    });
    setHistoryState({ canUndo: history.current?.canUndo ?? false, canRedo: history.current?.canRedo ?? false });
  }, [writer]);

  /** A change made on the surface. */
  const change = useCallback((event: InkChange) => {
    const own = latest.current.author;
    const removed = event.removed.map((item) => (item.author === OWN_AUTHOR ? { ...item, author: own } : item));
    history.current?.record({ added: event.add, removed, gesture: event.gesture });
    commit(
      { add: event.add, erase: removed.map((item) => item.stroke.id) },
      new Set(removed.map((item) => item.stroke.id)),
      event.add.map((stroke) => ({ stroke, author: own })),
    );
  }, [commit]);

  const replay = useCallback((ops: InkOps | null | undefined) => {
    if (!ops) return;
    const own = latest.current.author;
    const restored: InkStroke[] = [...(ops.add ?? []), ...(ops.unerase ?? [])];
    commit(ops, new Set(ops.erase ?? []), restored.map((stroke) => ({ stroke, author: authors.current.get(stroke.id) ?? own })));
  }, [commit]);

  const undo = useCallback(() => replay(history.current?.undo()), [replay]);
  const redo = useCallback(() => replay(history.current?.redo()), [replay]);

  /** A Markdown ink block's new height, in units; saved with the next Save. */
  const setHeight = useCallback((height: number) => {
    setFrame((current) => (current.height === height ? current : { ...current, height }));
    writer.markFrame();
  }, [writer]);

  const save = useCallback(() => writer.save(), [writer]);

  // Unsaved changes count for this file while the view is open.
  useEffect(() => pendingSaves.register(inkSavePath({ path, photoId }), inkSaveKey(chunk), {
    dirty: !writer.idle,
    writer,
    save: () => writer.save(),
    discard: () => writer.discard(),
    retarget: (next, sources) => writer.retarget(next, sources),
  }), [writer, path, chunk, photoId]);

  // Load; bring back unsaved changes kept from before a crash or restart; and
  // give a new ink block a rendering with the note's next Save.
  useEffect(() => {
    void load();
    return () => { loadVersion.current += 1; };
    // A new file or chunk is a new document.
  }, [path, chunk, photoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Other windows' saves, and collaborators' when this window comes back.
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event: MessageEvent<{ path: string; chunk: string }>) => {
        if (event.data?.path === (latest.current.photoId ?? latest.current.path) && event.data.chunk === latest.current.chunk) void load();
      };
    } catch { /* no channel support */ }
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => {
      channel?.close();
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  return { strokes, frame, author, loaded, error, change, undo, redo, setHeight, save, reload: load, photo, ...historyState };
}
