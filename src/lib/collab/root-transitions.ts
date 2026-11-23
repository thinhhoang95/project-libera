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
  /** Set on a pending transition that folds earlier ones in (A to B, B to C is A to C): their ids, completed with it. */
  covers?: string[];
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

/**
 * The transitions not yet applied, oldest first, with a chain A to B, B to C of one project folded into A to C
 * (`covers` names the folded ids). An unreadable record is left alone.
 */
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
  found.sort((left, right) => left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : 1);
  const chained: RootTransition[] = [];
  for (const next of found) {
    const earlier = chained.find((item) => item.projectId === next.projectId && item.to === next.from);
    if (earlier) {
      earlier.to = next.to;
      earlier.at = next.at;
      earlier.covers = [...(earlier.covers ?? []), next.id];
    } else chained.push({ ...next });
  }
  return chained;
}

/** Deletes the record, and the earlier records a chain folded into it. */
export function completeRootTransition(directory: string, id: string | Pick<RootTransition, "id" | "covers">): void {
  const ids = typeof id === "string" ? [id] : [id.id, ...(id.covers ?? [])];
  for (const each of ids) {
    try { unlinkSync(path.join(folder(directory), `${each}.json`)); } catch { /* Already applied. */ }
  }
}
