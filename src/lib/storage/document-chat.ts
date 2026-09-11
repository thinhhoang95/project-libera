import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAdminRoot } from "./paths";

export type ChatStateKind = "history" | "panel" | "font-size";
function statePath(kind: ChatStateKind) { return path.join(getAdminRoot(), ".libera", `document-chat-${kind}.json`); }
export async function readChatState(kind: ChatStateKind): Promise<unknown> {
  try { return JSON.parse(await readFile(statePath(kind), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function writeChatState(kind: ChatStateKind, value: unknown) {
  const target = statePath(kind);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
