import type { LiberaLinkRewrites } from "@/lib/types";

/**
 * The link rewrite that belongs to one moved file of a batch, for its open tab:
 * the links the server attached to the item (when it has them), else the batch's
 * own entry for the file where it is now. Undefined when the move rewrote nothing
 * in it. A moved item has no payload when a step after the move stayed behind, so
 * this never relies on one.
 */
export function moveItemLinks(item: { to: string; links?: LiberaLinkRewrites }, batch: LiberaLinkRewrites | undefined): LiberaLinkRewrites | undefined {
  if (item.links?.rewritten.some((note) => note.path === item.to)) return item.links;
  const own = batch?.rewritten.find((note) => note.path === item.to);
  return own ? { rewritten: [own], skipped: [], unchecked: [] } : undefined;
}
