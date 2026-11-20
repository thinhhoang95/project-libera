/** Name of the channel that carries Try to fix's committed moves to the other windows. */
export const REPAIR_CHANNEL_NAME = "libera-notebook-repair";

export type RepairMove = { from: string; to: string };

/** Identifies this window, so it ignores its own message (it already got the window event). */
export const WINDOW_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function repairMessage(moves: readonly RepairMove[]) {
  return { sender: WINDOW_ID, moves: moves.map(({ from, to }) => ({ from, to })) };
}

/** The moves in a message from another window, or null for anything else (including our own). */
export function movesFromRepairMessage(data: unknown, self: string = WINDOW_ID): RepairMove[] | null {
  if (!data || typeof data !== "object") return null;
  const { sender, moves } = data as { sender?: unknown; moves?: unknown };
  if (sender === self || !Array.isArray(moves)) return null;
  const valid = moves.filter((move): move is RepairMove => !!move && typeof move.from === "string" && typeof move.to === "string");
  return valid.length ? valid : null;
}

/** Tells the other windows. Opens a channel for the one message: the dialog has no window-wide handle. */
export function announceRepairMoves(moves: readonly RepairMove[]) {
  if (typeof BroadcastChannel === "undefined" || !moves.length) return;
  try {
    const channel = new BroadcastChannel(REPAIR_CHANNEL_NAME);
    channel.postMessage(repairMessage(moves));
    channel.close();
  } catch { /* No channel: other windows catch up on their next refresh. */ }
}
