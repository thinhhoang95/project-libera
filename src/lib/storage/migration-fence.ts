import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getStateRoot } from "@/lib/storage/paths";

// What a notebook migration (storage/migration.ts) is moving, for the code
// that must keep its hands off meanwhile: saves and other file operations
// (assertNotMigrating), the tree's sidecar maintenance (which would take a
// sidecar whose file is half way for an orphan), and the agent review store
// (which drops a review whose file is missing).
//
// The source of truth is the migration journals on disk, so another server
// process, or this one after a restart, sees an interrupted migration too.
// They are read again only when the journal folder changed: a check costs
// one stat, never a scan.

type ActiveMigration = { notebooks: Set<string>; paths: Set<string>; folders: string[] };

const CACHE = Symbol.for("libera.migrationFence");
type Cache = { key: string; active: ActiveMigration[] };

export function migrationJournalDirectory() {
  return path.join(getStateRoot(), LIBERA_SYSTEM_DIR, "migrations");
}

/** Journal fields the fence reads; the full shape lives in migration.ts. */
type JournalView = { state?: string; source?: string; destination?: { notebook?: string }; items?: { from: string; to: string }[]; folders?: { from: string; to: string }[] };

async function activeMigrations(): Promise<ActiveMigration[]> {
  const directory = migrationJournalDirectory();
  let key = `${directory}:missing`;
  try {
    const stats = await stat(directory);
    key = `${directory}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch { /* No migration ever ran. */ }
  const holder = globalThis as { [CACHE]?: Cache };
  if (holder[CACHE]?.key === key) return holder[CACHE].active;

  const active: ActiveMigration[] = [];
  let names: string[] = [];
  try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")); } catch { /* None. */ }
  for (const name of names) {
    let journal: JournalView;
    try { journal = JSON.parse(await readFile(path.join(directory, name), "utf8")) as JournalView; }
    catch {
      // Its files are unknown, and blocking every save in the library would be worse:
      // new migrations refuse to start, and the migration dialog offers to set it aside.
      continue;
    }
    if (journal.state === "done") continue;
    const paths = new Set<string>();
    for (const item of journal.items ?? []) { paths.add(item.from); paths.add(item.to); }
    active.push({
      notebooks: new Set([journal.source ?? "", journal.destination?.notebook ?? ""].filter(Boolean)),
      paths,
      folders: (journal.folders ?? []).flatMap((folder) => [folder.from, folder.to]),
    });
  }
  holder[CACHE] = { key, active };
  return active;
}

/** Call after writing or removing a journal from this process, so the next check reads it again. */
export function migrationJournalsChanged() {
  delete (globalThis as { [CACHE]?: Cache })[CACHE];
}

const within = (candidate: string, folder: string) => candidate === folder || candidate.startsWith(`${folder}/`);

/** A migration that has not finished involves this notebook (as source or destination). */
export async function isNotebookMigrating(notebook: string) {
  return (await activeMigrations()).some((migration) => migration.notebooks.has(notebook));
}

/** A migration that has not finished moves this library path (or a folder holding it). */
export async function isPathMigrating(libraryPath: string) {
  return (await activeMigrations()).some((migration) => migration.paths.has(libraryPath) ||
    migration.folders.some((folder) => within(libraryPath, folder)));
}

/** File operations on a path a migration is moving wait until it finishes. */
export async function assertNotMigrating(...libraryPaths: string[]) {
  for (const libraryPath of libraryPaths) {
    if (await isPathMigrating(libraryPath)) {
      throw new StorageError(`${libraryPath.split("/").at(-1)} is being moved to another notebook. Try again when the migration has finished.`, 409);
    }
  }
}

/** The library path of a notebook item, from the arguments the shared-notebook guards take. */
export function itemLibraryPath(notebook: string, pathParts: readonly string[] = []) {
  return [notebook, ...pathParts].join("/");
}
