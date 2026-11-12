// Fallback recovery for local updates that could not be written to SQLite
// when a hub closed (disk full, locked database). They are written as small
// JSON files next to the database, and replayed into the store on the next
// host start, where the normal outbound path syncs them.

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Provenance } from "../../../src/lib/collab/protocol/actor";
import type { Subdoc } from "../../../src/lib/collab/protocol/roles";
import type { Logger } from "./clock";
import type { HostStore } from "./store";

interface RecoveryFile {
  version: 1;
  docId: string;
  updates: Array<{ subdoc: Subdoc; update: string; provenance?: Provenance }>;
}

const SUFFIX = ".recovery.json";
let counter = 0;

/** The directory a database's recovery files live in. */
export function recoveryDirFor(dbPath: string): string | undefined {
  return dbPath === ":memory:" ? undefined : `${dbPath}.recovery`;
}

/** Writes the updates durably (temp file + rename). Returns false when that failed too. */
export function writeRecoveryFile(
  dir: string,
  docId: string,
  updates: ReadonlyArray<{ subdoc: Subdoc; update: Uint8Array; provenance?: Provenance }>,
  now: number,
  logger: Logger,
): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const body: RecoveryFile = {
      version: 1,
      docId,
      updates: updates.map((entry) => ({
        subdoc: entry.subdoc,
        update: Buffer.from(entry.update).toString("base64"),
        ...(entry.provenance ? { provenance: entry.provenance } : {}),
      })),
    };
    counter += 1;
    const name = `${now}-${process.pid}-${counter}`;
    const tmp = join(dir, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, join(dir, `${name}${SUFFIX}`));
    logger.warn(`Saved ${updates.length} unsaved local updates for ${docId} to ${dir} for recovery on the next start.`);
    return true;
  } catch (error) {
    logger.error(`Could not write a recovery file for ${docId}`, error);
    return false;
  }
}

/** Replays recovery files into the store; returns how many updates were restored. */
export function replayRecoveryFiles(dir: string | undefined, store: HostStore, logger: Logger): number {
  if (!dir) return 0;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(SUFFIX)).sort();
  } catch {
    return 0;
  }
  let restored = 0;
  for (const name of names) {
    const file = join(dir, name);
    try {
      const body = JSON.parse(readFileSync(file, "utf8")) as RecoveryFile;
      if (body.version !== 1 || typeof body.docId !== "string" || !Array.isArray(body.updates)) throw new Error("unrecognised recovery file");
      // Yjs updates are idempotent, so a replay interrupted before the file
      // was removed only repeats work.
      for (const entry of body.updates) {
        store.appendLocal(body.docId, entry.subdoc, new Uint8Array(Buffer.from(entry.update, "base64")), entry.provenance);
        restored += 1;
      }
      unlinkSync(file);
    } catch (error) {
      logger.error(`Could not replay recovery file ${name}; it is kept`, error);
    }
  }
  return restored;
}
