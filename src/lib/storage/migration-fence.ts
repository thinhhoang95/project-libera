import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isReservedBy, reserveLifecycle, ReservationConflictError, ReservationLostError, type Reservation } from "@/lib/collab/lifecycle-reservation";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getAdminRoot, getStateRoot } from "@/lib/storage/paths";

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
type Cache = { key: string; active: ActiveMigration[]; unreadable: number };

export function migrationJournalDirectory() {
  return path.join(getStateRoot(), LIBERA_SYSTEM_DIR, "migrations");
}

/** Journal fields the fence reads; the full shape lives in migration.ts. */
type JournalView = { state?: string; source?: string; destination?: { notebook?: string }; items?: { from: string; to: string }[]; folders?: { from: string; to: string }[] };

async function readFence(): Promise<{ active: ActiveMigration[]; unreadable: number }> {
  const directory = migrationJournalDirectory();
  let key = `${directory}:missing`;
  try {
    const stats = await stat(directory);
    key = `${directory}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch { /* No migration ever ran. */ }
  const holder = globalThis as { [CACHE]?: Cache };
  if (holder[CACHE]?.key === key) return holder[CACHE];

  const active: ActiveMigration[] = [];
  let unreadable = 0;
  let names: string[] = [];
  try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")); } catch { /* None. */ }
  for (const name of names) {
    let journal: JournalView;
    try { journal = JSON.parse(await readFile(path.join(directory, name), "utf8")) as JournalView; }
    catch {
      // Its files are unknown, and blocking every save in the library would be worse:
      // new migrations refuse to start, and the migration dialog offers to set it aside.
      // Operations that rewrite records wholesale (notebook operations below) fail closed on it.
      unreadable += 1;
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
  holder[CACHE] = { key, active, unreadable };
  return holder[CACHE];
}

const activeMigrations = async () => (await readFence()).active;

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

/**
 * A migration that has not finished moves something inside this folder (a file
 * or folder, as source or destination), or the folder lies inside a folder it
 * moves. Renaming, archiving or deleting such a folder would strand the journal.
 */
export async function isAnythingMigratingWithin(libraryFolder: string) {
  return (await activeMigrations()).some((migration) =>
    [...migration.paths].some((candidate) => within(candidate, libraryFolder)) ||
    migration.folders.some((folder) => within(folder, libraryFolder) || within(libraryFolder, folder)));
}

/** Folder operations that rename, move, archive or delete a folder wait while a migration works inside it. */
export async function assertNothingMigratingWithin(libraryFolder: string) {
  if (await isAnythingMigratingWithin(libraryFolder)) {
    throw new StorageError(`${libraryFolder.split("/").at(-1)} holds files that are being moved to another notebook. Try again when the migration has finished.`, 409);
  }
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

// ---- Notebook operations ------------------------------------------------------
//
// Try to fix, Acknowledge and the tree's sidecar upkeep rewrite or delete a
// notebook's records, which a migration that starts meanwhile has staged or
// still needs. The journals alone cannot order them: an operation can pass the
// "no migration" check and a migration then start before it is done. So both
// sides register here, in this process, before they look at anything else:
//   - an operation registers its notebook, then checks the claims and the
//     journals (a migration that claimed first, or a journal on disk, refuses it);
//   - a migration claims its notebooks synchronously (an operation that
//     registered first refuses it), and holds the claim until its journal is
//     written, from where the journals above keep the others away.
// An unreadable journal could involve any notebook, so operations refuse while
// one exists instead of guessing (the migration dialog offers to set it aside).
// Another server process is only seen through the journals.

const OPERATIONS = Symbol.for("libera.notebookOperations");
type Operations = { running: Map<string, number>; claimed: Map<string, number> };

function operations(): Operations {
  const holder = globalThis as { [OPERATIONS]?: Operations };
  return (holder[OPERATIONS] ??= { running: new Map(), claimed: new Map() });
}

const bump = (counts: Map<string, number>, notebook: string, by: number) => {
  const next = (counts.get(notebook) ?? 0) + by;
  if (next > 0) counts.set(notebook, next); else counts.delete(notebook);
};

/** Why a notebook operation may not start now, or null. */
async function operationBlocker(notebook: string): Promise<string | null> {
  if (operations().claimed.has(notebook)) return `${notebook} is about to be migrated. Try again when the migration has finished.`;
  const { active, unreadable } = await readFence();
  if (active.some((migration) => migration.notebooks.has(notebook))) return "A migration involving this notebook did not finish. Finish or stop it in Migration first.";
  if (unreadable) return "An earlier migration's journal can't be read, so it can't be told whether it involves this notebook. Set it aside in the Migration dialog first.";
  return null;
}

async function enterOperation(notebook: string) {
  const running = operations().running;
  bump(running, notebook, 1);
  try {
    const blocker = await operationBlocker(notebook);
    if (blocker) throw new StorageError(blocker, 409);
  } catch (error) {
    bump(running, notebook, -1);
    throw error;
  }
  return () => bump(running, notebook, -1);
}

// ---- Cross-process lifecycle reservation -----------------------------------------
//
// The claims above only see this process. Sharing runs in the collaboration
// host, another process, which snapshots the notebook and installs the shared
// marker. A migration, Try to fix or Acknowledge therefore also holds a
// reservation (lib/collab/lifecycle-reservation.ts) for the notebooks it works
// on, and revalidates it at its destructive commits: a share that holds one
// refuses them (and they refuse it); a lease that lapsed or was taken over
// stops the operation before it removes anything.

const RESERVATIONS = new AsyncLocalStorage<Reservation>();

const lifecycleDirectory = () => process.env.LIBERA_COLLAB_LIFECYCLE_DIR || undefined;
const notebookRoot = (notebook: string) => path.join(getAdminRoot(), notebook);

function asStorageError(error: unknown): unknown {
  return error instanceof ReservationConflictError || error instanceof ReservationLostError ? new StorageError(error.message, 409) : error;
}

/** Holds a local-operation reservation on `notebooks` while `work` runs. Refused (409) while a share holds one. */
export async function withLifecycleReservation<T>(notebooks: string[], work: () => Promise<T>): Promise<T> {
  if (RESERVATIONS.getStore()) return work();
  let reservation: Reservation;
  try { reservation = reserveLifecycle(lifecycleDirectory(), notebooks.map(notebookRoot), "local"); }
  catch (error) { throw asStorageError(error); }
  try { return await RESERVATIONS.run(reservation, work); } finally { reservation.release(); }
}

/**
 * Call at a destructive commit of an operation running under a reservation:
 * throws (409) when a share took the notebook over meanwhile. Outside a reservation it does nothing.
 */
export function assertLifecycleReservation(): void {
  const reservation = RESERVATIONS.getStore();
  if (!reservation) return;
  try { reservation.revalidate(); } catch (error) { throw asStorageError(error); }
}

/** Runs a record-rewriting operation on a notebook (Try to fix, Acknowledge), refused while a migration involves it or is about to, or while a share holds it. */
export async function withNotebookOperation<T>(notebook: string, work: () => Promise<T>): Promise<T> {
  const leave = await enterOperation(notebook);
  try { return await withLifecycleReservation([notebook], work); } finally { leave(); }
}

/** Like `withNotebookOperation`, for routine upkeep: when it may not run now it is skipped (`false`) and tried again on a later pass. */
export async function whenNotebookIdle(notebook: string, work: () => Promise<void>): Promise<boolean> {
  let leave: () => void;
  try { leave = await enterOperation(notebook); } catch (error) { if (error instanceof StorageError) return false; throw error; }
  try {
    // Routine upkeep only looks: it steps aside for a share, and tries again on a later pass.
    if (isReservedBy(lifecycleDirectory(), notebookRoot(notebook), "share")) return false;
    await work();
    return true;
  } finally { leave(); }
}

/**
 * A migration claims its notebooks before it plans its journal and releases
 * them once the journal is on disk. Refused when an operation is running on
 * one of them. Synchronous, so no operation can register in between.
 */
export function claimNotebooksForMigration(notebooks: string[]): () => void {
  const state = operations();
  const names = [...new Set(notebooks)];
  if (names.some((name) => state.running.has(name))) throw new StorageError("Another operation is working on this notebook. Try again in a moment.", 409);
  for (const name of names) bump(state.claimed, name, 1);
  return () => { for (const name of names) bump(state.claimed, name, -1); };
}
