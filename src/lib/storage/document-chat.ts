import { readFile } from "node:fs/promises";
import path from "node:path";
import { filterGalleryChatPhotos, validateChatStore } from "@/lib/document-chat";
import { getAdminRoot, getDataRoot } from "./paths";
import { writeJsonState } from "./json-state";

export type ChatStateKind = "history" | "panel" | "font-size";
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
