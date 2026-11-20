// A shared notebook's folder was renamed outside Libera and the host rebound the project to the new
// name. The host records that once, here, in the lifecycle folder; Next applies it to the library-level
// records that name the folder (stars, tags, review keys, agent history, reference attachments, saved
// workspace paths) and then deletes the record. Nothing polls: Next looks when it builds the tree, and
// the folder it looks in does not exist until a rebind has happened.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RootTransition {
  version: 1;
  id: string;
  projectId: string;
  /** Top-level notebook folder names, as in Libera paths. */
  from: string;
  to: string;
  at: string;
}

const folder = (directory: string) => path.join(directory, "root-transitions");

/** Records the transition once: the same project, from and to produce the same file, so a repeat writes nothing. */
export function recordRootTransition(directory: string, input: { projectId: string; from: string; to: string }): void {
  const id = createHash("sha256").update(JSON.stringify([input.projectId, input.from, input.to])).digest("hex").slice(0, 32);
  const file = path.join(folder(directory), `${id}.json`);
  try { readFileSync(file); return; } catch { /* Not recorded yet. */ }
  mkdirSync(folder(directory), { recursive: true, mode: 0o700 });
  const record: RootTransition = { version: 1, id, ...input, at: new Date().toISOString() };
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Not written. */ }
    throw error;
  }
}

/** The transitions not yet applied. An unreadable record is left alone. */
export function pendingRootTransitions(directory: string | undefined): RootTransition[] {
  if (!directory) return [];
  let names: string[];
  try { names = readdirSync(folder(directory)); } catch { return []; }
  const found: RootTransition[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(readFileSync(path.join(folder(directory), name), "utf8")) as RootTransition;
      if (value.version === 1 && typeof value.id === "string" && typeof value.projectId === "string" && typeof value.from === "string" && typeof value.to === "string") found.push(value);
    } catch { /* Left for a later look. */ }
  }
  return found;
}

export function completeRootTransition(directory: string, id: string): void {
  try { unlinkSync(path.join(folder(directory), `${id}.json`)); } catch { /* Already applied. */ }
}
