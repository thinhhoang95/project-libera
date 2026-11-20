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
 * The files being dragged in the notebook rail: the one under the pointer, or
 * every file of the selection when the drag started on a selected row. A list,
 * never empty while a drag is on, and null when none is.
 * It lives in a ref beside the React state: a drop consumes it synchronously, before
 * any await, so a slow move can never clear a drag that began after it.
 */
export type DragSlot = { current: LiberaFileNode[] | null };

export function beginDrag(slot: DragSlot, files: LiberaFileNode[]) {
  slot.current = files.length ? files : null;
}

/** Takes the dragged files out of the slot. A second drop of the same drag gets nothing. */
export function consumeDrag(slot: DragSlot): LiberaFileNode[] | null {
  const files = slot.current;
  slot.current = null;
  return files;
}
