import type { LiberaFileNode } from "@/lib/types";

/**
 * Where a drag from the notebook rail is going, as the move code needs it.
 *
 * Tree node paths are used exactly as the tree gives them: a folder may be named
 * " Drafts" (a leading space is a valid name), and trimming it would send the file
 * to a sibling "Drafts". Only text a person typed is trimmed, by the caller.
 * Empty segments (a stray "/") are dropped; nothing else is changed.
 */
export function splitDropDestination(destination: string): { notebook: string; folder: string } {
  const [notebook = "", ...folder] = destination.split("/").filter(Boolean);
  return { notebook, folder: folder.join("/") };
}

/**
 * The file being dragged in the notebook rail. Shape is deliberately plain (one file
 * or nothing) so a multi-file selection can later widen `current` to a list.
 * It lives in a ref beside the React state: a drop consumes it synchronously, before
 * any await, so a slow move can never clear a drag that began after it.
 */
export type DragSlot = { current: LiberaFileNode | null };

export function beginDrag(slot: DragSlot, file: LiberaFileNode) {
  slot.current = file;
}

/** Takes the dragged file out of the slot. A second drop of the same drag gets nothing. */
export function consumeDrag(slot: DragSlot): LiberaFileNode | null {
  const file = slot.current;
  slot.current = null;
  return file;
}
