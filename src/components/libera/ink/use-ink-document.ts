"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { InkHistory } from "@/lib/ink/history";
import type { InkFrame, InkOps, InkStroke, MergedInkStroke } from "@/lib/ink/types";
import { compareInkStrokes } from "@/lib/ink/merge";
import { apiRequest } from "../api-client";
import { registerStateFlusher } from "../deferred-save";
import { OWN_AUTHOR, type InkChange } from "./ink-surface";

/*
 * One chunk of a file's ink, as the surface draws it: loaded from /api/ink,
 * changed optimistically, and saved as batched operations on this author's
 * file (storage/ink.ts) 1.5 s after drawing stops, on blur and before quit.
 * Other windows hear about saves over a BroadcastChannel and reload; ink from
 * collaborators and other computers is picked up when the window regains focus.
 */

type ChunkPayload = { chunk: string; frame: InkFrame | null; strokes: MergedInkStroke[]; revision: number };
type InkPayload = { path: string; author: string; chunks: ChunkPayload[] };

const SAVE_DELAY_MS = 1500;
const RETRY_DELAYS_MS = [1000, 3000, 10_000, 30_000];
const CHANNEL = "libera-ink";

type Options = {
  path: string;
  chunk: string;
  /** The surface's frame, recorded with this author's first stroke. */
  frame: InkFrame;
  /** A Markdown ink block's rendering source, rewritten by the server after each save. */
  rendering?: string;
  /** Write once on load even without strokes, so a new block's rendering exists. */
  ensureRendering?: boolean;
};

/**
 * Pending operations followed by more. Changes that cancel out before
 * saving (a stroke drawn and erased, an erase undone) never reach the disk.
 */
function mergeOps(into: InkOps, ops: InkOps): InkOps {
  const add = new Map((into.add ?? []).map((stroke) => [stroke.id, stroke]));
  const erase = new Set(into.erase ?? []);
  const unerase = new Map((into.unerase ?? []).map((stroke) => [stroke.id, stroke]));
  for (const id of ops.erase ?? []) {
    if (add.delete(id) || unerase.delete(id)) continue;
    erase.add(id);
  }
  for (const stroke of ops.add ?? []) {
    erase.delete(stroke.id);
    add.set(stroke.id, stroke);
  }
  for (const stroke of ops.unerase ?? []) {
    if (!erase.delete(stroke.id)) unerase.set(stroke.id, stroke);
  }
  return { add: [...add.values()], erase: [...erase], unerase: [...unerase.values()] };
}

const isEmpty = (ops: InkOps) => !ops.add?.length && !ops.erase?.length && !ops.unerase?.length;

export function useInkDocument({ path, chunk, frame: initialFrame, rendering, ensureRendering }: Options) {
  const [strokes, setStrokes] = useState<MergedInkStroke[]>([]);
  const [frame, setFrame] = useState<InkFrame>(initialFrame);
  const [author, setAuthor] = useState(OWN_AUTHOR);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const history = useMemo(() => ({ current: null as InkHistory | null }), []);
  const pending = useRef<InkOps>({});
  const frameDirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retries = useRef(0);
  /** Whose file held each stroke this surface removed, so undo gives it back to them. */
  const authors = useRef(new Map<string, string>());
  const latest = useRef({ path, chunk, frame, rendering, author });
  useLayoutEffect(() => { latest.current = { path, chunk, frame, rendering, author }; });

  const apply = useCallback((payload: ChunkPayload) => {
    setStrokes(payload.strokes);
    if (payload.frame) setFrame((current) => (payload.frame!.height > current.height || !frameDirty.current ? { ...current, height: payload.frame!.height } : current));
  }, []);

  const load = useCallback(async () => {
    try {
      const payload = await apiRequest<InkPayload>(`/api/ink?path=${encodeURIComponent(latest.current.path)}&chunks=${latest.current.chunk}`);
      setAuthor(payload.author);
      history.current ??= new InkHistory(payload.author);
      // Unsaved local changes win until they are saved.
      if (isEmpty(pending.current) && !saving.current) apply(payload.chunks[0]);
      setLoaded(true);
      setError(null);
      return payload;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ink could not be loaded.");
      setLoaded(true);
      return null;
    }
  }, [apply, history]);

  const flush = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (saving.current) {
      await saving.current;
      if (!isEmpty(pending.current) || frameDirty.current) return flush();
      return;
    }
    if (isEmpty(pending.current) && !frameDirty.current) return;
    const ops = pending.current;
    pending.current = {};
    const resized = frameDirty.current;
    frameDirty.current = false;
    const { path: file, chunk: name, frame: surface, rendering: source } = latest.current;
    saving.current = (async () => {
      try {
        const payload = await apiRequest<InkPayload>("/api/ink", {
          method: "PATCH",
          body: JSON.stringify({ path: file, chunk: name, frame: surface, ops, ...(source ? { rendering: source } : {}) }),
        });
        retries.current = 0;
        setError(null);
        if (isEmpty(pending.current)) apply(payload.chunks[0]);
        try { new BroadcastChannel(CHANNEL).postMessage({ path: file, chunk: name }); } catch { /* no channel support */ }
      } catch (cause) {
        // Keep the changes for the next attempt, before anything drawn since.
        pending.current = mergeOps(ops, pending.current);
        frameDirty.current ||= resized;
        setError(cause instanceof Error ? cause.message : "Ink could not be saved.");
        const delay = RETRY_DELAYS_MS[Math.min(retries.current, RETRY_DELAYS_MS.length - 1)];
        retries.current += 1;
        timer.current = setTimeout(() => { void flush(); }, delay);
        throw cause;
      } finally {
        saving.current = null;
      }
    })();
    return saving.current;
  }, [apply]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(() => undefined); }, SAVE_DELAY_MS);
  }, [flush]);

  const commit = useCallback((ops: InkOps, removedIds: Set<string>, added: MergedInkStroke[]) => {
    pending.current = mergeOps(pending.current, ops);
    setStrokes((current) => {
      for (const item of current) if (removedIds.has(item.stroke.id)) authors.current.set(item.stroke.id, item.author);
      return [...current.filter((item) => !removedIds.has(item.stroke.id)), ...added].sort((a, b) => compareInkStrokes(a.stroke, b.stroke));
    });
    setHistoryState({ canUndo: history.current?.canUndo ?? false, canRedo: history.current?.canRedo ?? false });
    schedule();
  }, [history, schedule]);

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
  }, [commit, history]);

  const replay = useCallback((ops: InkOps | null | undefined) => {
    if (!ops) return;
    const own = latest.current.author;
    const restored: InkStroke[] = [...(ops.add ?? []), ...(ops.unerase ?? [])];
    commit(ops, new Set(ops.erase ?? []), restored.map((stroke) => ({ stroke, author: authors.current.get(stroke.id) ?? own })));
  }, [commit]);

  const undo = useCallback(() => replay(history.current?.undo()), [history, replay]);
  const redo = useCallback(() => replay(history.current?.redo()), [history, replay]);

  /** A Markdown ink block's new height, in units; saved with the next write. */
  const setHeight = useCallback((height: number) => {
    setFrame((current) => {
      if (current.height === height) return current;
      frameDirty.current = true;
      schedule();
      return { ...current, height };
    });
  }, [schedule]);

  // Load, then create a new block's rendering.
  useEffect(() => {
    let cancelled = false;
    void load().then((payload) => {
      if (cancelled || !payload || !ensureRendering || !latest.current.rendering) return;
      if (payload.chunks[0].revision === 0 && !payload.chunks[0].strokes.length) {
        frameDirty.current = true;
        void flush().catch(() => undefined);
      }
    });
    return () => { cancelled = true; };
    // A new file or chunk is a new document.
  }, [path, chunk]); // eslint-disable-line react-hooks/exhaustive-deps

  // Saved before quitting, closing the tab or switching user.
  useEffect(() => registerStateFlusher(() => flush()), [flush]);
  useEffect(() => () => { void flush().catch(() => undefined); }, [flush]);

  // Other windows' saves, and collaborators' when this window comes back.
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event: MessageEvent<{ path: string; chunk: string }>) => {
        if (event.data?.path === latest.current.path && event.data.chunk === latest.current.chunk) void load();
      };
    } catch { /* no channel support */ }
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => {
      channel?.close();
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  return { strokes, frame, author, loaded, error, change, undo, redo, setHeight, flush, ...historyState };
}
