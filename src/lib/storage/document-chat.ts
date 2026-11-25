import { readFile } from "node:fs/promises";
import path from "node:path";
import { filterGalleryChatPhotos, validateChatStore, type ChatContext, type ChatStore, type DocumentChat } from "@/lib/document-chat";
import { getAdminRoot, getDataRoot } from "./paths";
import { writeJsonState } from "./json-state";

export type ChatStateKind = "history" | "panel" | "font-size" | "model";
function statePath(kind: ChatStateKind) { return path.join(getAdminRoot(), ".libera", `document-chat-${kind}.json`); }
async function readState(target: string): Promise<unknown> {
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

const historyWrites = new Map<string, Promise<unknown>>();
function withHistory<T>(target: string, run: () => Promise<T>): Promise<T> {
  const task = (historyWrites.get(target) ?? Promise.resolve()).catch(() => undefined).then(run);
  historyWrites.set(target, task);
  void task.finally(() => { if (historyWrites.get(target) === task) historyWrites.delete(target); }).catch(() => undefined);
  return task;
}

async function galleryIds(indexPath: string) {
  const index = await readState(indexPath) as { photos?: Record<string, unknown>; archive?: Record<string, unknown> } | null;
  return new Set([...Object.keys(index?.photos ?? {}), ...Object.keys(index?.archive ?? {})]);
}

export async function readChatState(kind: ChatStateKind): Promise<unknown> {
  const target = statePath(kind);
  if (kind !== "history") return readState(target);
  const indexPath = path.join(getDataRoot(), "gallery", ".libera-gallery.json");
  return withHistory(target, async () => {
    const saved = await readState(target);
    if (!validateChatStore(saved)) return saved;
    const ids = await galleryIds(indexPath);
    const cleaned = filterGalleryChatPhotos(saved, (id) => ids.has(id));
    if (cleaned !== saved) await writeJsonState(target, cleaned);
    return cleaned;
  });
}

export async function writeChatState(kind: ChatStateKind, value: unknown) {
  const target = statePath(kind);
  if (kind !== "history") return writeJsonState(target, value);
  const indexPath = path.join(getDataRoot(), "gallery", ".libera-gallery.json");
  await withHistory(target, async () => {
    // Check at commit time, so an old panel snapshot cannot restore deleted images.
    const ids = await galleryIds(indexPath);
    await writeJsonState(target, validateChatStore(value) ? filterGalleryChatPhotos(value, (id) => ids.has(id)) : value);
  });
}

/** One move of library paths: a file, or a folder and everything under it. */
export type ChatPathMove = { from: string; to: string; folder?: boolean };

const withinFolder = (candidate: string, folder: string) => candidate === folder || candidate.startsWith(`${folder}/`);

function movedPath(candidate: string, moves: readonly ChatPathMove[]) {
  for (const move of moves) {
    if (move.folder ? withinFolder(candidate, move.from) : candidate === move.from) return `${move.to}${candidate.slice(move.from.length)}`;
  }
  return candidate;
}

/** Applies `change` to the saved chats, written back only when something changed; nothing is created when no chat was ever saved. */
function changeHistory(change: (store: ChatStore) => ChatStore) {
  const target = statePath("history");
  return withHistory(target, async () => {
    const saved = await readState(target);
    if (!validateChatStore(saved)) return;
    const next = change(saved);
    if (next !== saved) await writeJsonState(target, next);
  });
}

/** Maps every chat of the store, keeping the same object when none changed. */
function mapChats(store: ChatStore, map: (chat: DocumentChat) => DocumentChat): ChatStore {
  const chats = store.chats.map(map);
  return chats.every((chat, index) => chat === store.chats[index]) ? store : { ...store, chats };
}

/**
 * Files moved, renamed or archived: the chats that quote or exclude them follow to the new paths, so a moved
 * file keeps its conversation. The record of what a chat once sent is kept; only where it names the file changes.
 */
export function followChatPaths(moves: readonly ChatPathMove[]) {
  if (!moves.length) return Promise.resolve();
  const next = (candidate: string) => movedPath(candidate, moves);
  const nextContext = (context: ChatContext) => { const path = next(context.path); return path === context.path ? context : { ...context, path }; };
  const nextList = (list: string[] | undefined) => {
    if (!list) return list;
    const mapped = list.map(next);
    return mapped.some((item, index) => item !== list[index]) ? [...new Set(mapped)] : list;
  };
  return changeHistory((store) => mapChats(store, (chat) => {
    const messages = chat.messages.map((message) => {
      const contexts = message.contexts?.map(nextContext);
      return contexts && contexts.some((context, index) => context !== message.contexts![index]) ? { ...message, contexts } : message;
    });
    const selections = chat.selections.map(nextContext);
    const excludedDocumentPaths = nextList(chat.excludedDocumentPaths);
    const excludedCommentPaths = nextList(chat.excludedCommentPaths);
    let documentPages = chat.documentPages;
    if (documentPages && Object.keys(documentPages).some((key) => next(key) !== key)) {
      documentPages = Object.fromEntries(Object.entries(documentPages).map(([key, pages]) => [next(key), pages]));
    }
    const changed = messages.some((message, index) => message !== chat.messages[index]) || selections.some((item, index) => item !== chat.selections[index])
      || excludedDocumentPaths !== chat.excludedDocumentPaths || excludedCommentPaths !== chat.excludedCommentPaths || documentPages !== chat.documentPages;
    if (!changed) return chat;
    return { ...chat, messages, selections,
      ...(excludedDocumentPaths ? { excludedDocumentPaths } : {}), ...(excludedCommentPaths ? { excludedCommentPaths } : {}), ...(documentPages ? { documentPages } : {}) };
  }));
}

/**
 * Files or folders deleted: what a chat keeps about them as live state (a quoted selection waiting to be sent,
 * an exclusion, a page range) is dropped. Messages already sent stay as they were: they are the record of the conversation.
 */
export function dropChatPaths(deleted: readonly string[]) {
  if (!deleted.length) return Promise.resolve();
  const gone = (candidate: string) => deleted.some((folder) => withinFolder(candidate, folder));
  return changeHistory((store) => mapChats(store, (chat) => {
    const selections = chat.selections.filter((item) => !gone(item.path));
    const keep = (list: string[] | undefined) => list && list.some(gone) ? list.filter((item) => !gone(item)) : list;
    const excludedDocumentPaths = keep(chat.excludedDocumentPaths);
    const excludedCommentPaths = keep(chat.excludedCommentPaths);
    const documentPages = Object.keys(chat.documentPages ?? {}).some(gone) ? Object.fromEntries(Object.entries(chat.documentPages!).filter(([key]) => !gone(key))) : chat.documentPages;
    if (selections.length === chat.selections.length && excludedDocumentPaths === chat.excludedDocumentPaths && excludedCommentPaths === chat.excludedCommentPaths && documentPages === chat.documentPages) return chat;
    return { ...chat, selections, ...(excludedDocumentPaths ? { excludedDocumentPaths } : {}), ...(excludedCommentPaths ? { excludedCommentPaths } : {}), ...(documentPages ? { documentPages } : {}) };
  }));
}

/** Share the history write queue with panel saves, preserving unrelated messages and drafts. */
export function pruneGalleryChatPhotos(ids: Set<string>) {
  const target = statePath("history");
  return withHistory(target, async () => {
    const removed = new Set<string>();
    const saved = await readState(target);
    if (validateChatStore(saved)) {
      const cleaned = filterGalleryChatPhotos(saved, (id) => {
        if (ids.has(id)) return true;
        removed.add(id);
        return false;
      });
      if (cleaned !== saved) await writeJsonState(target, cleaned);
    }
    return [...removed];
  });
}
