import { dropChatPaths, followChatPaths } from "@/lib/storage/document-chat";
import { dropRecapPaths, followRecapPaths } from "@/lib/storage/where-was-i";

// The small stores that name files by path and that no operation owns: the saved document chats and the
// "where was I" recap. One call from the place each operation already follows its path-keyed records, so a
// moved file keeps its conversation and its position, and a deleted one leaves no live state behind.
// Both are idempotent; neither creates a record that was not there. They never throw: a chat or a recap that
// lags is not a reason to refuse or undo a move that happened (the next open of the file simply starts fresh).

async function settle(what: string, tasks: Promise<unknown>[]) {
  for (const result of await Promise.allSettled(tasks)) {
    if (result.status === "rejected") console.error(`[path-keyed-stores] ${what} did not follow:`, result.reason);
  }
}

/** Files or folders moved, renamed or archived (library paths). */
export function followPathKeyedStores(moves: readonly { from: string; to: string; folder?: boolean }[]) {
  return settle("moved paths", [followChatPaths(moves), followRecapPaths(moves)]);
}

/** Files or folders deleted (library paths; a folder drops everything under it). */
export function dropPathKeyedStores(deleted: readonly string[]) {
  return settle("deleted paths", [dropChatPaths(deleted), dropRecapPaths(deleted)]);
}
