import type { LiberaLinkRewrites } from "@/lib/types";
import { movesFromRepairMessage, REPAIR_CHANNEL_NAME, WINDOW_ID } from "./repair-channel";

/**
 * Moves reach the other windows of the app here. Try to fix and migrations have their own
 * channels (repair-channel.ts, "libera-notebook-migration"); every other move (Move…, rename,
 * drop, batch, archive, folder rename) is announced on this one, with the link rewrites it made.
 * No timers: a window listens, and a window that moved something posts once.
 */
export const FILE_MOVE_CHANNEL_NAME = "libera-file-moves";
const MIGRATION_CHANNEL_NAME = "libera-notebook-migration";
/** Same-window event: this window's tabs have followed these moves (consumers that live in a main window). */
export const FILES_MOVED_EVENT = "libera-files-moved";

export type FileMove = { from: string; to: string };
export type FileMoveMessage = { sender: string; moves: FileMove[]; links?: LiberaLinkRewrites };

function validMoves(moves: unknown): FileMove[] {
  return Array.isArray(moves) ? moves.filter((move): move is FileMove => !!move && typeof move.from === "string" && typeof move.to === "string").map(({ from, to }) => ({ from, to })) : [];
}

/** The moves in a message from another window, or null for anything else (including our own). */
export function readFileMoveMessage(data: unknown, self: string = WINDOW_ID): { moves: FileMove[]; links?: LiberaLinkRewrites } | null {
  if (!data || typeof data !== "object") return null;
  const { sender, moves, links } = data as { sender?: unknown; moves?: unknown; links?: unknown };
  if (sender === self) return null;
  const valid = validMoves(moves);
  if (!valid.length) return null;
  return { moves: valid, ...(links && typeof links === "object" ? { links: links as LiberaLinkRewrites } : {}) };
}

/** Tells the other windows about moves this window made. Opens a channel for the one message. */
export function announceFileMoves(moves: readonly FileMove[], links?: LiberaLinkRewrites) {
  const real = moves.filter((move) => move.from !== move.to);
  if (typeof BroadcastChannel === "undefined" || !real.length) return;
  try {
    const channel = new BroadcastChannel(FILE_MOVE_CHANNEL_NAME);
    const message: FileMoveMessage = { sender: WINDOW_ID, moves: real.map(({ from, to }) => ({ from, to })), ...(links?.rewritten.length || links?.skipped.length ? { links } : {}) };
    channel.postMessage(message);
    channel.close();
  } catch { /* No channel (or the rewrites could not be cloned): other windows catch up on their next refresh. */ }
}

/** A main window's tabs followed these moves: its own panels (chat contexts, Markdown preview windows) follow too. */
export function noteFilesMoved(moves: readonly FileMove[]) {
  const real = moves.filter((move) => move.from !== move.to);
  if (typeof window === "undefined" || !real.length) return;
  const Event = window.CustomEvent ?? CustomEvent;
  window.dispatchEvent(new Event(FILES_MOVED_EVENT, { detail: { moves: real } }));
}

/** Listens for `noteFilesMoved` in this window. */
export function subscribeFollowedMoves(onMoves: (moves: FileMove[]) => void) {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: Event) => {
    const moves = validMoves((event as CustomEvent<{ moves?: unknown }>).detail?.moves);
    if (moves.length) onMoves(moves);
  };
  window.addEventListener(FILES_MOVED_EVENT, listener);
  return () => window.removeEventListener(FILES_MOVED_EVENT, listener);
}

/**
 * Listens for moves of other windows on every channel that carries them (regular moves, Try to fix,
 * migrations). For windows without a workspace (a detached PDF or image window).
 */
export function subscribeOtherWindowMoves(onMoves: (moves: FileMove[]) => void) {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channels: BroadcastChannel[] = [];
  const open = (name: string, read: (data: unknown) => FileMove[] | null) => {
    const channel = new BroadcastChannel(name);
    channel.onmessage = (event: MessageEvent) => {
      const moves = read(event.data);
      if (moves?.length) onMoves(moves);
    };
    channels.push(channel);
  };
  open(FILE_MOVE_CHANNEL_NAME, (data) => readFileMoveMessage(data)?.moves ?? null);
  open(REPAIR_CHANNEL_NAME, (data) => movesFromRepairMessage(data));
  open(MIGRATION_CHANNEL_NAME, (data) => {
    const result = data as { moved?: unknown; folders?: unknown } | null;
    if (!result || typeof result !== "object" || !Array.isArray(result.moved)) return null;
    return [...validMoves(result.folders), ...validMoves(result.moved)];
  });
  return () => channels.forEach((channel) => channel.close());
}

/** Where `path` is after `moves`: an exact move wins, else the longest moved folder holding it. */
export function remapMovedPath(path: string, moves: readonly FileMove[]): string {
  const exact = moves.find((move) => move.from === path);
  if (exact) return exact.to;
  const folder = [...moves].sort((a, b) => b.from.length - a.from.length).find((move) => path.startsWith(`${move.from}/`));
  return folder ? `${folder.to}${path.slice(folder.from.length)}` : path;
}
