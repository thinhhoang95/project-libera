import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { directoryMachineKey } from "../../../electron/directory-mode.cjs";
import { sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { writeJsonState } from "@/lib/storage/json-state";
import { assertSafeSegment, notebookPath, notebookSystemDirectoryPath } from "@/lib/storage/paths";
import {
  decodeKnownFiles,
  hashRecapPath,
  isRecapDate,
  MAX_KNOWN_FILES,
  normalizeKnownFiles,
  normalizeRecapFileEntry,
  rankRecapFiles,
  type RecapFileEntry,
  type RecapSession,
  type RecapSessionUpdate,
  type RecapSummary,
  type RecapView,
} from "@/lib/where-was-i";

// Each installation writes only its own file, `.libera/where-was-i/<device>.json`.
// A notebook in a synced folder (OneDrive and the like) then never has two
// computers writing one file, and a collaboration host ignores `.libera*`
// names, so shared notebooks keep this record local to each person.

type RecapFile = {
  version: 1;
  device: { id: string; name: string };
  /** Newest first: the session in progress (or just ended) and the one before it. */
  sessions: RecapSession[];
  /** The newest summary this installation made, for a session from any device. */
  summary?: RecapSummary;
};

const RECAP_DIRECTORY = "where-was-i";
const MAX_SESSIONS = 2;
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

function deviceId() {
  return String(directoryMachineKey());
}

function deviceName() {
  return os.hostname().replace(/\.(local|lan|home)$/i, "").slice(0, 80) || "another computer";
}

function recapDirectory(notebook: string) {
  return path.join(notebookSystemDirectoryPath(notebook), RECAP_DIRECTORY);
}

function ownFilePath(notebook: string) {
  return path.join(recapDirectory(notebook), `${deviceId()}.json`);
}

export function isRecapSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

function normalizeSession(input: unknown): RecapSession | null {
  const value = input as Partial<RecapSession> | null;
  if (!isRecapSessionId(value?.id) || !isRecapDate(value.startedAt) || !isRecapDate(value.endedAt)) return null;
  const files = (Array.isArray(value.files) ? value.files : []).flatMap((file) => normalizeRecapFileEntry(file) ?? []);
  const knownFiles = normalizeKnownFiles(value.knownFiles);
  return { id: value.id, startedAt: value.startedAt, endedAt: value.endedAt, files: rankRecapFiles(files), ...(knownFiles ? { knownFiles } : {}) };
}

function normalizeSummary(input: unknown): RecapSummary | undefined {
  const value = input as Partial<RecapSummary> | null;
  if (!isRecapSessionId(value?.sessionId) || !Array.isArray(value.bullets)) return undefined;
  const bullets = value.bullets.filter((bullet): bullet is string => typeof bullet === "string" && !!bullet.trim()).slice(0, 4);
  return bullets.length ? {
    sessionId: value.sessionId,
    bullets,
    model: typeof value.model === "string" ? value.model : "",
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : "",
  } : undefined;
}

async function readRecapFile(filePath: string): Promise<RecapFile | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<RecapFile>;
    if (value?.version !== 1 || typeof value.device?.id !== "string") return null;
    const summary = normalizeSummary(value.summary);
    return {
      version: 1,
      device: { id: value.device.id, name: typeof value.device.name === "string" ? value.device.name : "" },
      sessions: (Array.isArray(value.sessions) ? value.sessions : []).flatMap((session) => normalizeSession(session) ?? []).slice(0, MAX_SESSIONS),
      ...(summary ? { summary } : {}),
    };
  } catch {
    return null;
  }
}

async function readAllRecapFiles(notebook: string) {
  const directory = recapDirectory(notebook);
  const names = await readdir(directory).catch(() => [] as string[]);
  const files = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readRecapFile(path.join(directory, name))));
  return files.filter((file): file is RecapFile => !!file);
}

async function notebookExists(notebook: string) {
  try {
    return (await stat(notebookPath(notebook))).isDirectory();
  } catch {
    return false;
  }
}

// Read-modify-write of this installation's file, one at a time per notebook.
const updates = new Map<string, Promise<unknown>>();

function updateOwnFile(notebook: string, update: (file: RecapFile) => RecapFile, { existingOnly = false } = {}) {
  const target = ownFilePath(notebook);
  const task = (updates.get(target) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const existing = await readRecapFile(target);
    // A record kept up with a move or a delete is never started by one.
    if (existingOnly && !existing) return;
    const next = update(existing ?? { version: 1, device: { id: deviceId(), name: deviceName() }, sessions: [] });
    await writeJsonState(target, { ...next, device: { id: deviceId(), name: deviceName() } });
  });
  updates.set(target, task);
  void task.finally(() => { if (updates.get(target) === task) updates.delete(target); }).catch(() => undefined);
  return task;
}

/**
 * Records a window's session for the notebooks it touched. Called when a file
 * closes and when the app quits, never while typing.
 */
export async function recordRecapSessions(input: RecapSessionUpdate) {
  if (!isRecapSessionId(input?.sessionId) || !isRecapDate(input.startedAt)) throw new Error("Invalid session.");
  const endedAt = new Date().toISOString();
  const entries = Object.entries(input.notebooks ?? {}).slice(0, 50);
  await Promise.all(entries.map(async ([name, files]) => {
    let notebook: string;
    try { notebook = assertSafeSegment(name, "Notebook name"); } catch { return; }
    if (!(await notebookExists(notebook))) return;
    const incoming = (Array.isArray(files) ? files : []).flatMap((file) => normalizeRecapFileEntry(file) ?? []);
    if (!incoming.length) return;
    const inventory = input.knownFiles?.[name];
    const knownFiles = normalizeKnownFiles(inventory);
    await updateOwnFile(notebook, (file) => {
      const current = file.sessions.find((session) => session.id === input.sessionId);
      const byPath = new Map((current?.files ?? []).map((entry) => [entry.path, entry]));
      for (const entry of incoming) byPath.set(entry.path, entry);
      const session: RecapSession = {
        id: input.sessionId,
        startedAt: current?.startedAt ?? input.startedAt,
        endedAt,
        files: rankRecapFiles([...byPath.values()]),
        // Null explicitly invalidates an older list when the tree is too large
        // or truncated. A client omitting the field preserves the old list.
        ...((inventory === null ? undefined : knownFiles ?? current?.knownFiles)
          ? { knownFiles: knownFiles ?? current?.knownFiles } : {}),
      };
      return { ...file, sessions: [session, ...file.sessions.filter((item) => item.id !== input.sessionId)].slice(0, MAX_SESSIONS) };
    });
  }));
}

/** The newest session on any device that is not the one still in progress. */
export async function readRecapView(notebookName: string, currentSessionId: string, summariesEnabled: boolean): Promise<RecapView> {
  const notebook = assertSafeSegment(notebookName, "Notebook name");
  const shared = sharedNotebookMarker(notebook) !== null;
  const files = await readAllRecapFiles(notebook);
  let latest: { session: RecapSession; device: RecapFile["device"] } | null = null;
  for (const file of files) {
    for (const session of file.sessions) {
      if (session.id === currentSessionId || !session.files.length) continue;
      if (!latest || session.endedAt > latest.session.endedAt) latest = { session, device: file.device };
    }
  }
  const summary = latest
    ? files.map((file) => file.summary).find((item) => item?.sessionId === latest.session.id) ?? null
    : null;
  return {
    session: latest?.session ?? null,
    ...(latest && latest.device.id !== deviceId() && latest.device.name ? { deviceName: latest.device.name } : {}),
    summary,
    shared,
    summariesEnabled,
  };
}

export async function readRecapSession(notebookName: string, sessionId: string) {
  const notebook = assertSafeSegment(notebookName, "Notebook name");
  for (const file of await readAllRecapFiles(notebook)) {
    const session = file.sessions.find((item) => item.id === sessionId);
    if (session) return session;
  }
  return null;
}

/** Look up the requested session's cache even when a newer session exists. */
export async function readRecapSummary(notebookName: string, sessionId: string) {
  const notebook = assertSafeSegment(notebookName, "Notebook name");
  const files = await readAllRecapFiles(notebook);
  return files.map((file) => file.summary).find((summary) => summary?.sessionId === sessionId) ?? null;
}

export async function saveRecapSummary(notebookName: string, summary: RecapSummary) {
  const notebook = assertSafeSegment(notebookName, "Notebook name");
  if (!(await notebookExists(notebook))) return;
  await updateOwnFile(notebook, (file) => ({ ...file, summary }));
}

// ---- Following the library -------------------------------------------------------
//
// Entries name files by path inside the notebook. A move, rename, archive or delete in the app updates this
// installation's own file (never another device's: a synced notebook must not have two computers writing one
// file), so a moved file keeps its position in the recap and is not reported as new. Nothing is started by it:
// a notebook without a recap file is left alone, and one pass serves all the moves of one operation.

/** One move of library paths: a file, or a folder and everything under it. */
export type RecapPathChange = { from: string; to: string; folder?: boolean };

type RelativeChange = { from: string; to: string; folder: boolean; toNotebook: string };

const insideFolder = (relative: string, folder: string) => relative === folder || relative.startsWith(`${folder}/`);

function splitLibraryPath(libraryPath: string) {
  const slash = libraryPath.indexOf("/");
  return slash <= 0 || slash === libraryPath.length - 1 ? null : { notebook: libraryPath.slice(0, slash), relative: libraryPath.slice(slash + 1) };
}

function changeFor(relative: string, changes: readonly RelativeChange[]) {
  return changes.find((change) => change.folder ? insideFolder(relative, change.from) : relative === change.from);
}

/** The notebook's files under a folder, by path inside the notebook; null when there are too many to list. Looks only at that folder. */
async function filesUnder(notebook: string, folder: string): Promise<string[] | null> {
  const found: string[] = [];
  const queue = [folder];
  while (queue.length) {
    const current = queue.pop()!;
    const entries = await readdir(path.join(notebookPath(notebook), ...current.split("/")), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) queue.push(`${current}/${entry.name}`);
      else if (entry.isFile() && found.push(`${current}/${entry.name}`) > MAX_KNOWN_FILES) return null;
    }
  }
  return found;
}

function encodeHashes(hashes: Set<number>) {
  if (hashes.size > MAX_KNOWN_FILES) return undefined;
  let binary = "";
  for (const hash of [...hashes].sort((a, b) => a - b)) binary += String.fromCharCode(hash >>> 24, (hash >>> 16) & 255, (hash >>> 8) & 255, hash & 255);
  return btoa(binary);
}

/** The session's inventory with the moved files' new names added (the old hashes stay: they only hide a new file by the old name). Omitted when it can't be kept right. */
function knownAfter(session: RecapSession, additions: readonly { from: string; to: string }[] | null) {
  if (!session.knownFiles) return {};
  const known = decodeKnownFiles(session.knownFiles);
  if (!known || !additions) return {};
  for (const { from, to } of additions) if (known.has(hashRecapPath(from))) known.add(hashRecapPath(to));
  const encoded = encodeHashes(known);
  return encoded ? { knownFiles: encoded } : {};
}

/**
 * Files moved, renamed or archived: the recap entries follow, in the same notebook or to another one
 * (a migration), and the inventory of known files learns the new names.
 */
export async function followRecapPaths(changes: readonly RecapPathChange[]) {
  const bySource = new Map<string, RelativeChange[]>();
  for (const change of changes) {
    const from = splitLibraryPath(change.from);
    const to = splitLibraryPath(change.to);
    if (!from || !to) continue; // A notebook's own rename: its record is inside the folder that moved.
    bySource.set(from.notebook, [...bySource.get(from.notebook) ?? [], { from: from.relative, to: to.relative, folder: change.folder === true, toNotebook: to.notebook }]);
  }
  const carried = new Map<string, { entry: RecapFileEntry; from: string }[]>();
  for (const [notebook, list] of bySource) {
    const existing = await readRecapFile(ownFilePath(notebook));
    if (!existing) continue;
    list.sort((a, b) => b.from.length - a.from.length);
    // The new names of moved files, for the inventories; only listed when a session has one.
    const additions: { from: string; to: string }[] = [];
    let complete = true;
    if (existing.sessions.some((session) => session.knownFiles)) {
      for (const change of list.filter((item) => item.toNotebook === notebook)) {
        if (!change.folder) { additions.push({ from: change.from, to: change.to }); continue; }
        const files = await filesUnder(notebook, change.to);
        if (!files) { complete = false; break; }
        for (const file of files) additions.push({ from: `${change.from}${file.slice(change.to.length)}`, to: file });
      }
    }
    await updateOwnFile(notebook, (file) => ({
      ...file,
      sessions: file.sessions.map((session) => {
        const entries = new Map<string, RecapFileEntry>();
        const moved: RecapFileEntry[] = [];
        for (const entry of session.files) {
          const change = changeFor(entry.path, list);
          if (!change) { entries.set(entry.path, entry); continue; }
          const next = `${change.to}${entry.path.slice(change.from.length)}`;
          if (change.toNotebook !== notebook) { carried.set(change.toNotebook, [...carried.get(change.toNotebook) ?? [], { entry: { ...entry, path: next }, from: entry.path }]); continue; }
          moved.push({ ...entry, path: next, name: !change.folder && entry.name === change.from.split("/").at(-1) ? next.split("/").at(-1)! : entry.name });
        }
        // A moved file takes the place of an old entry at its new name (a file can't land on a live one).
        for (const entry of moved) entries.set(entry.path, entry);
        const { knownFiles: _old, ...rest } = session;
        return { ...rest, files: rankRecapFiles([...entries.values()]), ...knownAfter(session, complete ? additions : null) };
      }),
    }), { existingOnly: true });
  }
  for (const [notebook, items] of carried) {
    await updateOwnFile(notebook, (file) => {
      const [newest, ...older] = file.sessions;
      if (!newest) return file;
      const entries = new Map(newest.files.map((entry) => [entry.path, entry]));
      for (const { entry } of items) entries.set(entry.path, entry);
      const known = decodeKnownFiles(newest.knownFiles);
      if (known) for (const { entry } of items) known.add(hashRecapPath(entry.path));
      const encoded = known ? encodeHashes(known) : undefined;
      const { knownFiles: _old, ...rest } = newest;
      return { ...file, sessions: [{ ...rest, files: rankRecapFiles([...entries.values()]), ...(encoded ? { knownFiles: encoded } : {}) }, ...older] };
    }, { existingOnly: true });
  }
}

/** Files or folders deleted: their entries leave the recap, so it never offers a file that is gone. */
export async function dropRecapPaths(deleted: readonly string[]) {
  const byNotebook = new Map<string, string[]>();
  for (const libraryPath of deleted) {
    const split = splitLibraryPath(libraryPath);
    if (split) byNotebook.set(split.notebook, [...byNotebook.get(split.notebook) ?? [], split.relative]);
  }
  for (const [notebook, folders] of byNotebook) {
    const existing = await readRecapFile(ownFilePath(notebook));
    if (!existing?.sessions.some((session) => session.files.some((entry) => folders.some((folder) => insideFolder(entry.path, folder))))) continue;
    await updateOwnFile(notebook, (file) => ({
      ...file,
      sessions: file.sessions.map((session) => ({ ...session, files: session.files.filter((entry) => !folders.some((folder) => insideFolder(entry.path, folder))) })),
    }), { existingOnly: true });
  }
}
