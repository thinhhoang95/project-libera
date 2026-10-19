import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAdminRoot } from "./paths";
import { writeJsonState } from "./json-state";

export type ChatStateKind = "history" | "panel" | "font-size";
function statePath(kind: ChatStateKind) { return path.join(getAdminRoot(), ".libera", `document-chat-${kind}.json`); }
export async function readChatState(kind: ChatStateKind): Promise<unknown> {
  try { return JSON.parse(await readFile(statePath(kind), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function writeChatState(kind: ChatStateKind, value: unknown) {
  await writeJsonState(statePath(kind), value);
}
