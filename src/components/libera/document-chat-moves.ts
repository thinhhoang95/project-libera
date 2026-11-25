import type { ChatContext, ChatStore, DocumentChat } from "@/lib/document-chat";
import { remapMovedPath, type FileMove } from "./file-move-channel";

const basename = (path: string) => path.split("/").at(-1) ?? path;

function remapContext(context: ChatContext, moves: readonly FileMove[]): ChatContext {
  const path = remapMovedPath(context.path, moves);
  if (path === context.path) return context;
  // A renamed file shows its new name; a name the person never saw as the file's name stays.
  return { ...context, path, name: context.name === basename(context.path) ? basename(path) : context.name };
}

/**
 * A chat with the paths it holds after files moved: the attached contexts (what is sent for them is read
 * from the new path), the sent messages' contexts, and the per-path exclusions and page budgets. The server
 * rewrites its copy of the saved chats the same way (storage/document-chat.ts followChatPaths); the renderer
 * remaps its in-memory copy with the same map, so a later save never writes the old paths back.
 */
export function remapChatPaths(chat: DocumentChat, moves: readonly FileMove[]): DocumentChat {
  const path = (value: string) => remapMovedPath(value, moves);
  const paths = (values: string[] | undefined) => values?.map(path);
  const pages = chat.documentPages && Object.fromEntries(Object.entries(chat.documentPages).map(([key, value]) => [path(key), value]));
  const next: DocumentChat = {
    ...chat,
    selections: chat.selections.map((context) => remapContext(context, moves)),
    messages: chat.messages.map((message) => message.contexts ? { ...message, contexts: message.contexts.map((context) => remapContext(context, moves)) } : message),
    ...(chat.excludedDocumentPaths ? { excludedDocumentPaths: paths(chat.excludedDocumentPaths) } : {}),
    ...(chat.excludedCommentPaths ? { excludedCommentPaths: paths(chat.excludedCommentPaths) } : {}),
    ...(pages ? { documentPages: pages } : {}),
  };
  return JSON.stringify(next) === JSON.stringify(chat) ? chat : next;
}

export function remapChatStorePaths(store: ChatStore, moves: readonly FileMove[]): ChatStore {
  const chats = store.chats.map((chat) => remapChatPaths(chat, moves));
  return chats.every((chat, index) => chat === store.chats[index]) ? store : { ...store, chats };
}

/** The new paths of attached note contexts (text, not PDF or audio) that a move touched, from the chat as it was before: their text is read again. */
export function movedNotePaths(before: DocumentChat, moves: readonly FileMove[]): string[] {
  return [...new Set(before.selections.flatMap((context) => {
    const path = remapMovedPath(context.path, moves);
    return context.kind === "document" && !context.excerpt && context.text && path !== context.path && !/\.(pdf|mp3|m4a|wav|aac|ogg|oga|opus|flac|webm)$/i.test(path) ? [path] : [];
  }))];
}
