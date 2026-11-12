// Journal for the files a layout move stages under `.libera/collab/moving/`
// (audit 2026-11-12 STALE-3). A staged file can hold an external edit that was
// never imported, so it must neither be overwritten nor stay invisible: each
// staging gets a small `<staged name>.journal` entry saying where it came from
// and where it was going. The entry is removed once placement succeeds. After a
// crash or a failed placement, `recoverInterruptedMoves` runs at startup: bytes
// that the destination already holds are dropped, anything else goes to the
// notebook's `_archive` under a recognisable name. Staged bytes that are not
// provably duplicated are never deleted.

import fs from "node:fs/promises";
import path from "node:path";

import {
  ARCHIVE_DIRECTORY,
  STATE_DIRECTORY,
  availableName,
  movePath,
  readIfExists,
  resolveInside,
  sha256,
  writeFileAtomic,
  type WriteGuard,
} from "./fs-ops";

const JOURNAL_SUFFIX = ".journal";

export interface MoveJournalEntry {
  fileId: string;
  /** Manifest-style path the file was staged from. */
  source: string;
  /** Manifest-style path it was going to. */
  destination: string;
  /** File name under `moving/`. */
  staged: string;
  /** Last content hash the shared layout knew for it, when any. */
  hash?: string;
  stagedAt: number;
}

function movingDirectory(root: string): string {
  return path.join(root, ...STATE_DIRECTORY, "moving");
}

/** Records an intended move before the file is staged. */
export async function writeMoveJournal(root: string, entry: MoveJournalEntry, guard?: WriteGuard): Promise<void> {
  await writeFileAtomic(path.join(movingDirectory(root), `${entry.staged}${JOURNAL_SUFFIX}`), Buffer.from(JSON.stringify(entry)), guard);
}

/** Forgets a move once its file is placed (or was never staged). */
export async function clearMoveJournal(root: string, staged: string): Promise<void> {
  await fs.rm(path.join(movingDirectory(root), `${staged}${JOURNAL_SUFFIX}`), { force: true });
}

function parseEntry(bytes: Buffer): MoveJournalEntry | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Partial<MoveJournalEntry>;
    if (typeof value.staged !== "string" || value.staged !== path.basename(value.staged) || typeof value.destination !== "string" || typeof value.source !== "string") return null;
    return value as MoveJournalEntry;
  } catch {
    return null;
  }
}

export interface RecoveredMove {
  destination: string;
  outcome: "duplicate-removed" | "archived";
  archivedAs?: string;
}

/**
 * Resolves every journalled move left by an earlier run. Call before the
 * layout is applied. Unreadable journals and staged files without a journal are
 * left exactly as they are.
 */
export async function recoverInterruptedMoves(root: string, guard?: WriteGuard): Promise<RecoveredMove[]> {
  const directory = movingDirectory(root);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return [];
  }
  const recovered: RecoveredMove[] = [];
  for (const name of names.filter((item) => item.endsWith(JOURNAL_SUFFIX)).sort()) {
    const journal = path.join(directory, name);
    const raw = await readIfExists(journal);
    const entry = raw ? parseEntry(raw) : null;
    if (!entry) continue;
    const staged = path.join(directory, entry.staged);
    const bytes = await readIfExists(staged).catch(() => null);
    if (!bytes) {
      // Nothing was staged (the move itself failed) or it was already placed.
      if (!(await fs.stat(staged).catch(() => null))) await fs.rm(journal, { force: true });
      continue;
    }
    const target = await resolveInside(root, entry.destination).catch(() => null);
    const current = target ? await readIfExists(target).catch(() => null) : null;
    if (current && sha256(current) === sha256(bytes)) {
      await fs.rm(staged, { force: true });
      await fs.rm(journal, { force: true });
      recovered.push({ destination: entry.destination, outcome: "duplicate-removed" });
      continue;
    }
    const base = path.posix.basename(entry.destination);
    const extension = path.posix.extname(base);
    const stem = extension ? base.slice(0, -extension.length) : base;
    const archiveRoot = path.join(root, ARCHIVE_DIRECTORY);
    const archivedAs = await availableName(archiveRoot, `${stem} (interrupted move)${extension}`);
    await movePath(staged, path.join(archiveRoot, archivedAs), guard);
    await fs.rm(journal, { force: true });
    recovered.push({ destination: entry.destination, outcome: "archived", archivedAs });
  }
  return recovered;
}
