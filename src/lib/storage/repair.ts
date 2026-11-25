import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { copyFile, link, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { hostOwnsSideFile, manifestFile, manifestHasFile, readManifestView, type ManifestView } from "@/lib/storage/shared-manifest-view";
import { legacyPythonSidecarPath, pythonSidecarDocumentPath, pythonSidecarPath } from "@/lib/python/sidecar";
import { hasReviewEntry, withMovedReview } from "@/lib/agent/review-store";
import { moveTetheredFilesBatch, readTetherTarget } from "@/lib/references/bib-tether";
import { publishReferenceEvent } from "@/lib/references/library-events";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";
import { foldedFileName } from "@/lib/storage/file-names";
import { getFileType } from "@/lib/storage/file-types";
import { pathExists } from "@/lib/storage/fs-utils";
import { fileExistence, libraryNotebookNames } from "@/lib/storage/library-links";
import { readMarkdownAssetDocuments, unreferencedMarkdownAssets, movePythonSidecar } from "@/lib/storage/markdown-assets";
import { moveReviewPaths } from "@/lib/storage/markdown-reviews";
import { readOrphans } from "@/lib/storage/pdf-sidecars";
import { assertSafeSegment, filePathFromParts, getLinkedFolderReadOnly, getStateRoot, notebookPath, orphanedSidecarsDirectoryPath, splitFilePath, withReadOnlyStorage } from "@/lib/storage/paths";
import { inspectReferenceLibrary, moveReferenceAttachmentsBatch, readReferenceLibrary } from "@/lib/storage/references";
import { isEmptyReview, type ReviewDocument } from "@/lib/markdown-review";
import { inspectReviewDocuments, inspectReviewKeys } from "@/lib/storage/review-files";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { listSidecars, SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { inventoryComplete, listNotebookInventory } from "@/lib/storage/integrity";
import { readWorkspaceMetadata, renameFileMetadataPaths } from "@/lib/storage/workspace-metadata";
import { StorageError } from "@/lib/storage/errors";
import { assertLifecycleReservation, withNotebookOperation } from "@/lib/storage/migration-fence";
import { isTextFileType } from "@/lib/types";

// Check Notebook → Try to fix: files moved or renamed into another folder
// outside the app (Finder, a sync client) leave their records at the old
// path: side files, a note's Python code, stars and tags, review comments,
// reference attachments, a tethered .bib, the agent's pending changes and
// undo history. A file is found again by its name, and only by its name
// (names compare under Unicode normalization and case folding): when exactly
// one missing path has the name and exactly one file in the notebook has it,
// and that file has no records of the same kind of its own (stars and
// attachments don't count), the records follow it, as they would have after a
// move in the app (files.ts moveFile, the migration's batch helpers). There is
// no fingerprint: a file of the name that is a different file gets the
// records, so the dialog shows every pair before anything is written, and the
// confirmation covers each pair's records and file.
//
// Side files the tree's upkeep set aside (`.libera/orphaned-sidecars/`, 30 s
// after their file went missing) are records of their original path too: they
// are matched by the same rule and put in place, never over what is there.
//
// A side file is moved by linking it to the new place (never replacing what is
// there) before the old one goes, so a try that stopped in between is told
// from someone else's records by the link, and a retry finishes it.
//
// On a shared notebook only this computer's records are paired (stars, tags,
// review comments, reference attachments, local side files such as image
// annotations and definitions), and only to a file the host's manifest lists
// (read once for the plan, and again right before anything is written) whose
// old path the manifest no longer has. What the host owns (ink, transcripts,
// Python code, live PDF marks) or moves together with the file is refused with
// the reason, and so is everything when the host cannot confirm the manifest.
//
// Like moves in the app, Markdown links are not rewritten
// (docs/features/related-notebooks.md). Runs only when asked; the plan reads
// only (withReadOnlyStorage), and applying writes each store once.

/** What follows a file, in the dialog's words. */
const SIDECAR_RECORDS: Record<string, string | null> = {
  "pdf-annotations": "annotations",
  "image-annotations": "annotations",
  "pdf-outline": "outline",
  definitions: "definitions",
  transcript: "transcript",
  ink: "ink",
  // Caches are made again: they follow a matched file but never make a match.
  "pdf-text": null,
  "audio-peaks": null,
};
const PYTHON = "Python code";
const STARRED = "star";
const TAGS = "tags";
const REVIEWS = "review comments";
const ATTACHMENTS = "reference attachment";
const TETHER = "tethered .bib";
const AGENT = "pending agent changes";
const UNDO = "agent undo history";
/** Records the file found may already have: then the two are not merged and the match is not made. */
const OWN = new Set([...Object.values(SIDECAR_RECORDS).filter(Boolean) as string[], PYTHON, TAGS, REVIEWS, AGENT]);

export type RepairMove = { from: string; to: string; records: string[] };
export type RepairUnmatched = {
  from: string;
  records: string[];
  /** `none`: no file of that name. `several`: more than one could be it. `elsewhere`: no file of that name is in this notebook, but one is in another notebook (the records are kept: they may belong to it, and Acknowledge leaves them). `shared-name`: other missing files have the same name. `own`: the only one has records of its own. `unread`: a store of records could not be read, so uniqueness or ownership can't be known. `conflict`: more than one copy of a side file was set aside for the path. `host`: a shared notebook's record that the host owns (ink, transcripts, Python code, live marks) or that moves only together with the file (agent changes, undo history, the tether): not moved here. */
  reason: "none" | "several" | "shared-name" | "own" | "unread" | "conflict" | "host";
  candidates: string[];
};
export type RepairPlan = { notebook: string; moves: RepairMove[]; unmatched: RepairUnmatched[]; token: string };
/** What happened to one record of a pair: `moved`; `stayed` (something of the destination's own was in the way, or the pair was not applied); `failed` (an error); `waiting` (the pair's side files are not all in place yet, so the rest waits for a retry); `nothing` (it was no longer there to move). */
export type RepairOutcome = { from: string; to: string; record: string; status: "moved" | "stayed" | "failed" | "waiting" | "nothing" };
/** `moved` is the mapping the renderer retargets by: only pairs where at least one record actually moved. */
export type RepairResult = { notebook: string; moved: RepairMove[]; outcomes: RepairOutcome[]; problems: string[] };

/** A side file set aside for a path, in the record's own words (SIDECAR_RECORDS). Ink is a folder with its record; the others one record file holding the side file. */
type SetAside = { record: string; /** The side file kind (sidecars.ts). */ kind: string; /** The record file, or for ink its folder. */ at: string; sidecar?: unknown };
type Fingerprint = { size: number; mtimeMs: number; /** A shared notebook's file: the manifest's identity for it. */ fileId?: string };
/** Where a destination stands for a side file: `free`; `same` (a case-only rename: it is the source itself); `ours` (an earlier try linked all of it there); `taken` (something else is there). */
type Slot = "free" | "same" | "ours" | "taken";
/** The kinds readOrphans lists, by the side file kind that holds them. */
const SET_ASIDE_KINDS: Record<string, string> = { annotations: "pdf-annotations", outline: "pdf-outline", definitions: "definitions" };
/** A hard link that a disk or share can't make: the side file is copied instead. */
const LINK_UNAVAILABLE = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK", "EINVAL"]);
/** Windows holds a file or folder that a scanner, an indexer or a sync client has open: the call is tried again a few times (capped backoff, once per call, no timer left behind) before it is reported. */
const BUSY = new Set(["EPERM", "EBUSY"]);
const BUSY_BACKOFF_MS = [25, 75, 200];
async function whenFree<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await task(); } catch (error) {
      if (!BUSY.has((error as NodeJS.ErrnoException).code ?? "") || attempt >= BUSY_BACKOFF_MS.length) throw error;
      await delay(BUSY_BACKOFF_MS[attempt]);
    }
  }
}

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;
const under = (libraryPath: string, notebook: string) => libraryPath.startsWith(`${notebook}/`);
const baseName = (libraryPath: string) => libraryPath.slice(libraryPath.lastIndexOf("/") + 1);
const nameKey = (libraryPath: string) => foldedFileName(baseName(libraryPath));
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "";
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** A notebook this computer may change records of: connected (a shared one is checked against the host's manifest by the callers). Also used by Acknowledge (cleanup.ts). */
export function assertRepairable(name: string) {
  const notebook = assertSafeSegment(name, "Notebook name");
  if (notebook.startsWith(".")) throw new StorageError("That is not a notebook.", 400);
  // Read without upgrades: finding the folder must not move its stateRoot before the plan's token is checked (applyCleanup, applyNotebookRepair).
  if (getLinkedFolderReadOnly(notebook)?.unresolved) throw new StorageError(`${notebook} is not connected on this computer. Reconnect it first.`, 409);
  return notebook;
}

/** What a file or folder holds right now (sizes and modification times), to tell later whether it is still the version that was copied. */
async function signature(target: string): Promise<string> {
  const stats = await lstat(target).catch(() => null);
  if (!stats) return "absent";
  if (!stats.isDirectory()) return `${stats.size}:${stats.mtimeMs}`;
  try {
    const parts: string[] = [];
    for (const name of (await readdir(target)).sort()) parts.push(`${name}=${await signature(path.join(target, name))}`);
    return `[${parts.join(",")}]`;
  } catch { return "unreadable"; }
}

const signatureAt = (libraryPath: string) => {
  try { const parsed = splitFilePath(libraryPath); return signature(filePathFromParts(parsed.notebook, parsed.pathParts)); } catch { return Promise.resolve(""); }
};

/** Whether every file under `destination` is a hard link to the one at the same place under `source`: what an earlier try of this repair left. */
async function linkedTree(source: string, destination: string): Promise<boolean> {
  const [from, to] = await Promise.all([source, destination].map((target) => lstat(target, { bigint: true }).catch(() => null)));
  if (!from || !to || from.isDirectory() !== to.isDirectory()) return false;
  if (!from.isDirectory()) return from.dev === to.dev && from.ino === to.ino && from.nlink >= BigInt(2);
  try {
    const [names, others] = await Promise.all([source, destination].map(async (directory) => (await readdir(directory)).sort()));
    if (names.join("\0") !== others.join("\0")) return false;
    for (const name of names) if (!(await linkedTree(path.join(source, name), path.join(destination, name)))) return false;
    return true;
  } catch { return false; }
}

const pathSegments = (target: string) => target.split(/[\\/]/);
const listingOf = (segments: string[]) => { const parent = segments.join(path.sep); return /^[A-Za-z]:$/.test(parent) ? `${parent}${path.sep}` : parent || path.sep; };

/** Whether both spellings are listed in their folder as entries of their own (a case-sensitive volume), rather than one entry that two spellings open. Null when the folder can't be listed. */
async function separateNames(source: string, destination: string): Promise<boolean | null> {
  const [from, to] = [pathSegments(source), pathSegments(destination)];
  let at = 0;
  while (at < from.length && at < to.length && from[at] === to[at]) at += 1;
  if (at >= from.length || at >= to.length) return false;
  try { const listing = await readdir(listingOf(from.slice(0, at))); return listing.includes(from[at]) && listing.includes(to[at]); } catch { return null; }
}

/** Where the destination stands for the source (exported for the tests). */
export async function slotOf(source: string, destination: string): Promise<Slot> {
  const [from, to] = await Promise.all([source, destination].map((target) => lstat(target, { bigint: true }).catch(() => null)));
  if (!to) return "free";
  if (!from) return "taken";
  if (from.dev === to.dev && from.ino === to.ino) {
    // One entry under two spellings (a case-only rename, a decomposed name) is the file itself; two names of one file are a link.
    if (from.isDirectory() || from.nlink < BigInt(2)) return "same";
    if (foldedFileName(source) !== foldedFileName(destination)) return "ours";
    // Spellings that fold together may still be two names of one file (a case-sensitive volume, after a try that stopped between its link and the removal of the old name).
    const separate = await separateNames(source, destination);
    return separate === null ? "taken" : separate ? "ours" : "same";
  }
  return await linkedTree(source, destination) ? "ours" : "taken";
}

/**
 * Moves a file or folder to where nothing is, never replacing: a link and then
 * the removal of the old name for a file, a rename for a folder (which does
 * not replace one that has anything in it). False when something is there.
 */
async function placeWithoutReplacing(from: string, to: string): Promise<boolean> {
  if ((await lstat(from)).isDirectory()) {
    try { await whenFree(() => rename(from, to)); return true; } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(errorCode(error))) return false;
      // Windows says EPERM for a folder in the way as well as for one that is held: only something there is "in the way".
      if (BUSY.has(errorCode(error)) && await lstat(to).catch(() => null)) return false;
      throw error;
    }
  }
  try { await link(from, to); } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    if (!LINK_UNAVAILABLE.has(errorCode(error))) throw error;
    if (await lstat(to).catch(() => null)) return false;
    await rename(from, to);
    return true;
  }
  await whenFree(() => rm(from, { force: true }));
  return true;
}

/**
 * Respells the folders and the name of `source` as `destination` spells them, level by level (the two are one entry on a case-insensitive disk, or differ in Unicode form): each level that differs is renamed in place, so a parent folder renamed in case is respelled too, and the path a reader builds from the destination is the one the disk lists. False when a level can't be renamed or the two are not spellings of one another.
 */
async function respellPath(source: string, destination: string): Promise<boolean> {
  const [from, to] = [pathSegments(source), pathSegments(destination)];
  if (from.length !== to.length) return false;
  let at = 0;
  while (at < from.length && from[at] === to[at]) at += 1;
  for (let level = at; level < from.length; level += 1) {
    if (from[level] === to[level]) continue;
    if (foldedFileName(from[level]) !== foldedFileName(to[level])) return false;
    const parent = listingOf(to.slice(0, level));
    // Already spelled so by an earlier pair of the same folder.
    if ((await readdir(parent).catch(() => [] as string[])).includes(to[level])) continue;
    if (!(await aliasRename(path.join(parent, from[level]), path.join(parent, to[level])))) return false;
  }
  return true;
}

/**
 * A case-only (or normalization-only) rename on a case-insensitive disk: the
 * destination is the source itself. It goes through a temporary name (some
 * disks need that to change only the case), is put at the destination without
 * replacing anything created there meanwhile, and is put back when it can't be;
 * if even that fails, the error says where it is.
 */
async function aliasRename(source: string, destination: string): Promise<boolean> {
  const temporary = path.join(path.dirname(source), `.${randomUUID()}.moving`);
  await rename(source, temporary);
  const putBack = async (cause?: unknown) => {
    let back = false;
    try { back = await placeWithoutReplacing(temporary, source); } catch { /* Reported below. */ }
    if (!back) throw new Error(`it could not be renamed and is now at ${temporary}${cause instanceof Error ? ` (${cause.message})` : ""}`);
  };
  try {
    if (await placeWithoutReplacing(temporary, destination)) return true;
  } catch (error) { await putBack(error); throw error; }
  await putBack();
  return false;
}

type Created = { target: string; directory: boolean; ino?: bigint };

/** Takes back what a copy created, last first. A file someone has replaced since (another inode), and a folder they have put something into, are left. */
async function undoCopy(created: Created[]) {
  for (const { target, directory, ino } of [...created].reverse()) {
    if (directory) { await rmdir(target).catch(() => undefined); continue; }
    const now = await lstat(target, { bigint: true }).catch(() => null);
    if (now && now.ino === ino) await rm(target, { force: true }).catch(() => undefined);
  }
}

/** Links (or, where links can't be made, copies) a file or folder to where nothing is, exclusively; false when something is in the way. `mode.linked` turns false once a copy was needed. */
async function publish(source: string, destination: string, created: Created[], mode: { linked: boolean }): Promise<boolean> {
  if ((await lstat(source)).isDirectory()) {
    try { await mkdir(destination); } catch (error) { if (errorCode(error) === "EEXIST") return false; throw error; }
    created.push({ target: destination, directory: true });
    for (const name of await readdir(source)) if (!(await publish(path.join(source, name), path.join(destination, name), created, mode))) return false;
    return true;
  }
  try { await link(source, destination); } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    if (!LINK_UNAVAILABLE.has(errorCode(error))) throw error;
    mode.linked = false;
    try { await copyFile(source, destination, constants.COPYFILE_EXCL); } catch (copyError) { if (errorCode(copyError) === "EEXIST") return false; throw copyError; }
  }
  created.push({ target: destination, directory: false, ino: (await lstat(destination, { bigint: true })).ino });
  return true;
}

/**
 * Moves a side file, or an ink folder, to where nothing is. It is published
 * exclusively (a link, else a copy), so a side file the app saves there
 * meanwhile is never replaced: then the source stays. Renaming would replace
 * it on every platform. The source is retired only while it is still the
 * version that was published (a writer or sync client may have replaced it
 * meanwhile: then the destination's copy is taken back and the pair stops).
 */
async function moveIntoPlace(source: string, destination: string): Promise<boolean> {
  const slot = await slotOf(source, destination);
  if (slot === "same") return respellPath(source, destination);
  if (slot === "taken") return false;
  const before = await signature(source);
  const created: Created[] = [];
  const mode = { linked: true };
  if (slot === "free") {
    await mkdir(path.dirname(destination), { recursive: true });
    // Published whole before anything of the source goes: a part that can't be placed takes back what was, so the destination never holds half of a folder (which a retry would take for the file's own).
    let placed = false;
    try { placed = await publish(source, destination, created, mode); }
    catch (error) { await undoCopy(created); throw error; }
    if (!placed) { await undoCopy(created); return false; }
  }
  // Linked, the source must still be the very file that was linked; copied, unchanged since before the copy.
  const unchanged = (await signature(source)) === before && (!mode.linked || await linkedTree(source, destination));
  if (!unchanged) { await undoCopy(created); throw new Error(`${path.basename(source)} changed while it was being moved, so it stayed where it was`); }
  await whenFree(() => rm(source, { recursive: true, force: true }));
  return true;
}

/** Python code in a case-only rename: its folder (named after the note, shared with the note's images) and the code file are both respelled, as the note's path now reads. */
const movePythonAlias = (source: string, destination: string) => respellPath(source, destination);

/** What would be moved where. Reads only. */
export function planNotebookRepair(name: string): Promise<RepairPlan> {
  return withReadOnlyStorage(async () => (await plan(name)).plan);
}

/** Whether nothing is at this library path, by the check's own presence test (the exact name in its folder's listing); a path that can't be checked is never taken for missing. */
async function absent(disk: ReturnType<typeof fileExistence>, libraryPath: string) {
  await disk.check([libraryPath]);
  return !disk.unknown(libraryPath) && !disk.exists(libraryPath);
}

/** A file's size and modification time: what the confirmation covers of a candidate. Null when it is not a file. */
async function fingerprintOf(libraryPath: string): Promise<Fingerprint | null> {
  try {
    const parsed = splitFilePath(libraryPath);
    const stats = await lstat(filePathFromParts(parsed.notebook, parsed.pathParts));
    return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
  } catch { return null; }
}

type Instance = () => Promise<string>;

async function plan(name: string): Promise<{ plan: RepairPlan; asides: Map<string, SetAside[]>; files: Record<string, Fingerprint | null> }> {
  const notebook = assertRepairable(name);
  if (!(await lstat(notebookPath(notebook)).catch(() => null))?.isDirectory()) throw new StorageError("Notebook not found.", 404);
  const shared = isSharedNotebookPath(notebook);
  // A shared notebook's pending record moves were applied by the repair route before this plan (settleSharedRecordsBeforeCheck).
  // A shared notebook's files are the host's manifest: fail closed when it can't be had.
  let manifest: Extract<ManifestView, { state: "ok" }> | null = null;
  if (shared) {
    const view = await readManifestView(notebook);
    if (view.state !== "ok") throw new StorageError(`The host can't confirm which files ${notebook} has right now (${view.reason}), so no record is matched to a file. Try again when collaboration is connected.`, 409);
    manifest = view;
  }
  /** What a candidate file is, for the confirmation: the disk's size and time, or on a shared notebook the manifest's identity (a file not yet on the disk is still a file the host lists). */
  const fingerprint = async (libraryPath: string): Promise<Fingerprint | null> => {
    if (!manifest) return fingerprintOf(libraryPath);
    const entry = manifest.files.get(libraryPath);
    return entry ? { size: entry.size ?? 0, mtimeMs: entry.updatedAt, fileId: entry.fileId } : null;
  };
  /** Records of a shared notebook that the host owns or moves with the file: never paired here. */
  const hostRecords = new Set<string>();
  const hostKey = (libraryPath: string, record: string) => `${libraryPath}\0${record}`;
  // The archive counts: a file moved there in Finder is a candidate, and a second file of its name there makes "several".
  // A shared notebook's files are the manifest's (the archive is local only there).
  const visible = manifest ? { files: [...manifest.files.keys()].sort(), truncated: false, unreadable: [] as string[] } : await listNotebookInventory(notebook);
  // A name is unique only if every file was seen.
  if (!inventoryComplete(visible) && visible.truncated) throw new StorageError(`${notebook} has too many files to match moved files by name.`, 413);
  if (!inventoryComplete(visible)) throw new StorageError(`${plural(visible.unreadable.length, "folder")} of ${notebook} could not be read (${visible.unreadable.slice(0, 3).join(", ")}${visible.unreadable.length > 3 ? ", ..." : ""}), so a file's name can't be known to be the only one. Fix its permissions or reconnect the drive, then try again.`, 409);

  /** Stores of records that could not be read in full: a pair whose uniqueness or ownership may depend on what is hidden in them is not made. */
  const unread = new Set<string>();
  /** Records kept per path, whether or not the file is there, each with what identifies this instance of it (for the confirmation, never for pairing). */
  const records = new Map<string, Map<string, Instance>>();
  const add = (libraryPath: string, record: string, instance: Instance = async () => "") => {
    if (!under(libraryPath, notebook) || !getFileType(baseName(libraryPath))) return;
    if (!records.has(libraryPath)) records.set(libraryPath, new Map());
    records.get(libraryPath)!.set(record, instance);
  };

  const { sidecars, unreadable } = await listSidecars(notebook);
  if (unreadable.length) unread.add("side files");
  for (const sidecar of sidecars) {
    const record = SIDECAR_RECORDS[sidecar.kind];
    if (!record) continue;
    add(sidecar.filePath, record, () => signature(sidecar.path));
    if (shared && isSharedNotebookPath(sidecar.filePath) && hostOwnsSideFile(sidecar.kind, notebook)) hostRecords.add(hostKey(sidecar.filePath, record));
  }

  // Side files set aside for files that left are records of their original path, unless a live side file of that kind is there.
  const asides = new Map<string, SetAside[]>();
  const aside = (originalPath: string, entry: SetAside) => {
    if (!under(originalPath, notebook) || !getFileType(baseName(originalPath)) || records.get(originalPath)?.has(entry.record)) return;
    asides.set(originalPath, [...asides.get(originalPath) ?? [], entry]);
    if (shared && isSharedNotebookPath(originalPath) && hostOwnsSideFile(entry.kind, notebook)) hostRecords.add(hostKey(originalPath, entry.record));
  };
  // A set-aside record that can't be read could be a second path of the same name: never taken for absent.
  let orphans: Awaited<ReturnType<typeof readOrphans>> = [];
  try { orphans = await readOrphans(notebook); } catch { unread.add("side files set aside"); }
  for (const kind of Object.keys(SET_ASIDE_KINDS)) {
    let listed: string[] = [];
    try { listed = (await readdir(orphanedSidecarsDirectoryPath(notebook, kind))).filter((name) => name.endsWith(".json")); }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) unread.add("side files set aside"); }
    if (listed.length > orphans.filter(({ record }) => record.kind === kind).length) unread.add("side files set aside");
  }
  for (const { file, record } of orphans) {
    if (record.sidecar !== undefined && record.sidecar !== null) aside(record.originalPath, { record: record.kind, kind: SET_ASIDE_KINDS[record.kind], at: file, sidecar: record.sidecar });
  }
  const inkAside = orphanedSidecarsDirectoryPath(notebook, "ink");
  let inkEntries: Dirent[] = [];
  try { inkEntries = await readdir(inkAside, { withFileTypes: true }); } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) unread.add("side files set aside"); }
  for (const entry of inkEntries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(inkAside, entry.name);
    let originalPath: unknown;
    try { ({ originalPath } = JSON.parse(await readFile(path.join(directory, "record.json"), "utf8")) as { originalPath?: unknown }); } catch { unread.add("side files set aside"); continue; }
    if (typeof originalPath === "string" && (await lstat(path.join(directory, "ink")).catch(() => null))?.isDirectory()) aside(originalPath, { record: "ink", kind: "ink", at: directory });
  }
  // Two copies of one side file set aside for one path can't both be put in the one place: reported before anything is written.
  const conflicting = new Set<string>();
  for (const [originalPath, entries] of asides) {
    if (new Set(entries.map((entry) => entry.record)).size < entries.length) conflicting.add(originalPath);
    for (const entry of entries) add(originalPath, entry.record, () => signature(entry.at));
  }

  // A note's Python code lives in _assets, under the note's path.
  const unused = await unreferencedMarkdownAssets(notebook, await readMarkdownAssetDocuments(notebook));
  // Notes that could not all be read hide which Python code is unused: that holds back only pairs of notes.
  const notesUnread = unused === null;
  for (const asset of unused ?? []) {
    if (!asset.toLowerCase().endsWith(".py")) continue;
    const note = pythonSidecarDocumentPath(asset);
    if (note) { add(note, PYTHON, () => signatureAt(asset)); if (shared) hostRecords.add(hostKey(note, PYTHON)); }
  }

  const metadata = await readWorkspaceMetadata();
  for (const starred of metadata.starredFilePaths) add(starred, STARRED);
  for (const tagged of Object.keys(metadata.fileTags)) add(tagged, TAGS, async () => JSON.stringify(metadata.fileTags[tagged]));
  const reviewKeys = await inspectReviewKeys(getStateRoot());
  if (reviewKeys.damaged !== undefined || reviewKeys.legacy) unread.add("review comments");
  for (const key of reviewKeys.keys) add(key, REVIEWS, async () => digest(JSON.stringify(await inspectReviewDocuments(getStateRoot(), key))));
  // Every library's attachments and tether count: a .bib moved in this notebook may be tethered by another notebook's library.
  for (const library of new Set(await libraryNotebookNames())) {
    const inspected = await inspectReferenceLibrary(library).catch(() => null);
    if (!inspected || "damaged" in inspected) unread.add("reference libraries");
    else {
      for (const entry of Object.values(inspected.library?.entries ?? {})) {
        for (const attachment of entry.attachments) if (attachment.kind !== "url") add(attachment.path, ATTACHMENTS, async () => `${library}:${entry.id}`);
      }
    }
    const tether = await readTetherTarget(library).catch(() => ({ damaged: "unreadable" }));
    if (tether && "damaged" in tether) unread.add("reference libraries");
    else if (tether && "libraryPath" in tether) { add(tether.libraryPath, TETHER, async () => library); if (shared) hostRecords.add(hostKey(tether.libraryPath, TETHER)); }
  }
  // The agent's changes waiting for review, and the runs that can still be undone, are the note's records too.
  const agent = await readAgentReviews();
  if (agent.unreadable) unread.add("agent changes");
  for (const entry of agent.found) { add(entry.path, AGENT, async () => entry.stamp); if (shared) hostRecords.add(hostKey(entry.path, AGENT)); }
  const { listRunFiles } = await import("@/lib/agent/snapshots");
  const runs = await listRunFiles();
  if (runs.unreadable) unread.add("agent undo history");
  const runsAt = new Map<string, string[]>();
  for (const file of runs.files) if (!file.shared && !file.reverted) runsAt.set(file.path, [...runsAt.get(file.path) ?? [], file.runId]);
  for (const [filePath, runIds] of runsAt) { add(filePath, UNDO, async () => runIds.sort().join(",")); if (shared) hostRecords.add(hostKey(filePath, UNDO)); }

  // Paths whose records stay behind: not in the notebook, and surely gone
  // (a path that could not be checked is never taken for missing).
  const listed = new Set(visible.files);
  const disk = fileExistence();
  const missing: string[] = [];
  for (const libraryPath of records.keys()) {
    // Decided by the path: the notebook's local `_archive` is not in the manifest, so its files are judged on the disk.
    if (manifest && isSharedNotebookPath(libraryPath) ? !manifestHasFile(manifest, libraryPath) : !listed.has(libraryPath) && await absent(disk, libraryPath)) missing.push(libraryPath);
  }

  const filesByName = new Map<string, string[]>();
  for (const file of visible.files) {
    const key = nameKey(file);
    filesByName.set(key, [...(filesByName.get(key) ?? []), file]);
  }
  const missingByName = new Map<string, number>();
  for (const libraryPath of missing) missingByName.set(nameKey(libraryPath), (missingByName.get(nameKey(libraryPath)) ?? 0) + 1);

  /** Records of the pair that an earlier, interrupted try of this repair already put at the destination (linked to the source's): they are no obstacle to finishing it. */
  const published = async (from: string, candidate: string) => {
    const done = new Set<string>();
    let source: ReturnType<typeof splitFilePath>;
    let destination: ReturnType<typeof splitFilePath>;
    // A path no file can have (a reserved segment) has no side files to have moved.
    try { source = splitFilePath(from); destination = splitFilePath(candidate); } catch { return done; }
    const fileType = getFileType(source.name) ?? "";
    for (const kind of SIDECAR_KINDS) {
      const record = SIDECAR_RECORDS[kind.id];
      if (!record || kind.cache || !kind.appliesTo(fileType)) continue;
      if (await slotOf(kind.filePath(notebook, source.pathParts), kind.filePath(notebook, destination.pathParts)) === "ours") done.add(record);
    }
    for (const entry of asides.get(from) ?? []) {
      if (entry.record !== "ink") continue;
      const kind = SIDECAR_KINDS.find((candidateKind) => candidateKind.id === entry.kind);
      if (kind?.appliesTo(fileType) && await slotOf(path.join(entry.at, "ink"), kind.filePath(notebook, destination.pathParts)) === "ours") done.add("ink");
    }
    return done;
  };

  const ownRecords = async (candidate: string, from: string) => {
    const own = new Set([...records.get(candidate)?.keys() ?? []].filter((record) => OWN.has(record)));
    // Opening the file where it is now made an empty review: it is not the
    // file's own, and applying replaces it (moveReviewPaths, replaceEmpty).
    if (own.has(REVIEWS)) {
      const reviews = await inspectReviewDocuments<ReviewDocument>(getStateRoot(), candidate);
      if (reviews?.every(isEmptyReview)) own.delete(REVIEWS);
    }
    // Python code of a note that is there is in use, so it was not listed above, unless it is the missing note's own code under another spelling of the name.
    if (getFileType(baseName(candidate)) === "markdown") {
      try {
        const destination = splitFilePath(pythonSidecarPath(candidate));
        const destinationFile = filePathFromParts(destination.notebook, destination.pathParts);
        if (await pathExists(destinationFile)) {
          const source = splitFilePath(pythonSidecarPath(from));
          if (await slotOf(filePathFromParts(source.notebook, source.pathParts), destinationFile) !== "same") own.add(PYTHON);
        }
      } catch { own.add(PYTHON); }
      // Code of the original layout (a folder of the notebook's _assets, named after the note's stem) is the note's own too.
      try {
        const legacy = splitFilePath(legacyPythonSidecarPath(candidate));
        const legacyFile = filePathFromParts(legacy.notebook, legacy.pathParts);
        if (await pathExists(legacyFile)) {
          const legacySource = splitFilePath(legacyPythonSidecarPath(from));
          if (await slotOf(filePathFromParts(legacySource.notebook, legacySource.pathParts), legacyFile) !== "same") own.add(PYTHON);
        }
      } catch { own.add(PYTHON); }
    }
    for (const record of await published(from, candidate)) own.delete(record);
    return own;
  };

  const moves: RepairMove[] = [];
  const unmatched: RepairUnmatched[] = [];
  for (const from of missing.sort()) {
    const everything = [...records.get(from)!.keys()].sort();
    // A shared notebook: what the host owns is refused, the rest is paired as below.
    const refused = everything.filter((record) => hostRecords.has(hostKey(from, record)));
    const kept = everything.filter((record) => !refused.includes(record));
    if (!kept.length) { unmatched.push({ from, records: refused, reason: "host", candidates: [] }); continue; }
    const key = nameKey(from);
    const named = [...filesByName.get(key) ?? []].sort();
    // The name is all there is: it must be exactly one missing path's and exactly one file's.
    if ((missingByName.get(key) ?? 0) > 1) { unmatched.push({ from, records: kept, reason: "shared-name", candidates: named }); continue; }
    if (named.length > 1) { unmatched.push({ from, records: kept, reason: "several", candidates: named }); continue; }
    if (!named.length) { unmatched.push({ from, records: kept, reason: "none", candidates: [] }); continue; }
    const target = named[0];
    // A hidden record could be a second missing path of the name, or the file's own.
    if (unread.size || (notesUnread && getFileType(baseName(from)) === "markdown")) { unmatched.push({ from, records: kept, reason: "unread", candidates: [target] }); continue; }
    if (conflicting.has(from)) { unmatched.push({ from, records: kept, reason: "conflict", candidates: [target] }); continue; }
    const own = await ownRecords(target, from);
    if (kept.some((record) => own.has(record))) unmatched.push({ from, records: kept, reason: "own", candidates: [target] });
    else {
      moves.push({ from, to: target, records: kept });
      if (refused.length) unmatched.push({ from, records: refused, reason: "host", candidates: [] });
    }
  }

  // One file takes the records of one path.
  const claimed = new Map<string, number>();
  for (const move of moves) claimed.set(move.to, (claimed.get(move.to) ?? 0) + 1);
  for (const move of [...moves]) {
    if ((claimed.get(move.to) ?? 0) < 2) continue;
    moves.splice(moves.indexOf(move), 1);
    unmatched.push({ from: move.from, records: move.records, reason: "several", candidates: [move.to] });
  }
  unmatched.sort((a, b) => a.from.localeCompare(b.from));

  // The confirmation covers the files that would take records, and the ones
  // named as candidates (replacing one between the preview and the
  // confirmation changes the token), and the instance of every record that
  // would move (a store changed since it was shown does too).
  const watched = [...new Set([...moves.map((move) => move.to), ...unmatched.flatMap((item) => item.candidates)])].sort();
  const files: Record<string, Fingerprint | null> = {};
  for (const file of watched) files[file] = await fingerprint(file);
  const instances: Record<string, string[]> = {};
  for (const move of moves) instances[move.from] = await Promise.all(move.records.map(async (record) => `${record}=${await records.get(move.from)!.get(record)!()}`));
  const token = createHash("sha256").update(JSON.stringify({ moves, unmatched, files, instances })).digest("hex").slice(0, 32);
  return { plan: { notebook, moves, unmatched, token }, asides, files };
}

/** Pending agent changes, read without settling (or dropping) any of them (agent/review-store.ts keeps them, one file each), with a stamp of each entry; how many can't be read. */
async function readAgentReviews() {
  const directory = path.join(getStateRoot(), LIBERA_SYSTEM_DIR, "agent-review");
  const found: Array<{ path: string; stamp: string }> = [];
  let unreadable = 0;
  let names: string[] = [];
  try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) unreadable += 1; }
  for (const name of names) {
    try {
      const text = await readFile(path.join(directory, name), "utf8");
      const entry = JSON.parse(text) as { path?: unknown };
      if (typeof entry.path === "string") found.push({ path: entry.path, stamp: digest(text) });
      else unreadable += 1;
    } catch { unreadable += 1; }
  }
  return { found, unreadable };
}

/** Where the records kept in stores are now: whether a path has the record. Read after the stores were written, to say what actually moved. */
async function recordHolders() {
  const metadata = await readWorkspaceMetadata();
  const attachments = new Set<string>();
  const tethers = new Set<string>();
  for (const library of new Set(await libraryNotebookNames())) {
    const inspected = await inspectReferenceLibrary(library).catch(() => null);
    if (inspected && !("damaged" in inspected)) {
      for (const entry of Object.values(inspected.library?.entries ?? {})) for (const attachment of entry.attachments) if (attachment.kind !== "url") attachments.add(attachment.path);
    }
    const tether = await readTetherTarget(library).catch(() => null);
    if (tether && "libraryPath" in tether) tethers.add(tether.libraryPath);
  }
  const { listRunFiles } = await import("@/lib/agent/snapshots");
  const undo = new Set((await listRunFiles()).files.filter((file) => !file.shared && !file.reverted).map((file) => file.path));
  const sets: Record<string, Set<string>> = {
    [STARRED]: new Set(metadata.starredFilePaths), [TAGS]: new Set(Object.keys(metadata.fileTags)),
    [REVIEWS]: new Set((await inspectReviewKeys(getStateRoot())).keys), [ATTACHMENTS]: attachments, [TETHER]: tethers, [UNDO]: undo,
  };
  return (record: string, libraryPath: string) => sets[record]?.has(libraryPath) ?? false;
}

/** One thing that moves with a file, and where its destination stands before anything is written. */
type Job = { record: string; what: string; cache: boolean; /** False when it may turn out there was nothing to move. */ counted: boolean; state: Slot; move: () => Promise<boolean> };

/** Whether a file holds exactly this text. */
const holdsText = async (target: string, text: string) => (await readFile(target, "utf8").catch(() => null)) === text;

/** Records kept in stores, which are written once for all pairs (after the pairs' side files). */
const STORE_RECORDS = [REVIEWS, STARRED, TAGS, ATTACHMENTS, TETHER, UNDO];

/**
 * Moves the records of the pairs shown in the plan (`token`): planned again
 * first, and refused when anything changed since; each pair is checked again
 * right before it is written (its source still gone, its destination still the
 * file that was shown). Each store is written once. A pair whose destination
 * slots are taken is stopped before anything moves; the stores wait for a pair
 * whose side files are not all in place, and a retry finishes it. `outcomes`
 * says what happened to each record, and `moved` names only the pairs where
 * something actually moved.
 */
export const applyNotebookRepair = (name: string, token: string): Promise<RepairResult> => withNotebookOperation(name, () => applyRepair(name, token));

async function applyRepair(name: string, token: string): Promise<RepairResult> {
  const notebook = assertRepairable(name);
  const { plan: current, asides, files } = await withReadOnlyStorage(() => plan(notebook));
  if (current.token !== token) throw new StorageError("The notebook changed since the fix was prepared. Check it again.", 409);
  const { listInterruptedMigrations } = await import("@/lib/storage/migration");
  if ((await listInterruptedMigrations()).some((migration) => migration.source === notebook || migration.destination.notebook === notebook)) {
    throw new StorageError("A migration involving this notebook did not finish. Finish or stop it in Migration first.", 409);
  }

  const shared = isSharedNotebookPath(notebook);
  let view: ManifestView | null = null;
  const problems: string[] = [];
  const status = new Map<RepairMove, Map<string, RepairOutcome["status"]>>();
  const completed: RepairMove[] = [];
  for (const move of current.moves) {
    // A share that took the notebook over since this run began stops it before it moves anything more.
    assertLifecycleReservation();
    const done = new Map<string, RepairOutcome["status"]>();
    status.set(move, done);
    // All of the pair is in the try: one reserved segment must not stop the other pairs after some side files moved.
    try {
      // Right before writing: nothing may have come back at the source or replaced the file shown.
      if (shared) {
        // The host's manifest decides, read once for the pairs; when it can't be had nothing is written.
        view ??= await readManifestView(notebook);
        if (view.state !== "ok") { problems.push(`The host could not confirm the files of ${notebook} (${view.reason}), so the records of ${move.from} stayed.`); for (const record of move.records) done.set(record, "stayed"); continue; }
        // Decided by the path: a file of the notebook's local `_archive` is not in the manifest, the disk says whether it is back.
        if (isSharedNotebookPath(move.from) ? manifestHasFile(view, move.from) : !(await absent(fileExistence(), move.from))) { problems.push(`${move.from} is back in the shared notebook, so its records stayed.`); for (const record of move.records) done.set(record, "stayed"); continue; }
        if (manifestFile(view, move.to)?.fileId !== files[move.to]?.fileId) { problems.push(`${move.to} is not the file that was shown, so the records of ${move.from} stayed.`); for (const record of move.records) done.set(record, "stayed"); continue; }
      } else {
      if (!(await absent(fileExistence(), move.from))) { problems.push(`${move.from} is back, so its records stayed.`); for (const record of move.records) done.set(record, "stayed"); continue; }
      if (JSON.stringify(await fingerprintOf(move.to)) !== JSON.stringify(files[move.to])) { problems.push(`${move.to} is not the file that was shown, so the records of ${move.from} stayed.`); for (const record of move.records) done.set(record, "stayed"); continue; }
      }
      const from = splitFilePath(move.from);
      const to = splitFilePath(move.to);
      const fileType = getFileType(from.name) ?? "";
      const jobs: Job[] = [];
      for (const kind of SIDECAR_KINDS) {
        if (!kind.appliesTo(fileType) || (shared && hostOwnsSideFile(kind.id, notebook))) continue;
        const source = kind.filePath(notebook, from.pathParts);
        const destination = kind.filePath(notebook, to.pathParts);
        if (!(await pathExists(source))) continue;
        jobs.push({ record: SIDECAR_RECORDS[kind.id] ?? kind.id, what: SIDECAR_RECORDS[kind.id] ?? kind.id, cache: Boolean(kind.cache), counted: true, state: await slotOf(source, destination), move: () => moveIntoPlace(source, destination) });
      }
      for (const entry of asides.get(move.from) ?? []) {
        const kind = SIDECAR_KINDS.find((candidate) => candidate.id === entry.kind);
        if (!kind?.appliesTo(fileType) || (shared && hostOwnsSideFile(kind.id, notebook))) continue;
        const destination = kind.filePath(notebook, to.pathParts);
        if (entry.record === "ink") {
          const source = path.join(entry.at, "ink");
          jobs.push({
            record: "ink", what: "ink set aside", cache: false, counted: true, state: await slotOf(source, destination),
            move: async () => { const went = await moveIntoPlace(source, destination); if (went) await rm(entry.at, { recursive: true, force: true }); return went; },
          });
        } else {
          const restored = `${JSON.stringify(entry.sidecar, null, 2)}\n`;
          jobs.push({
            record: entry.record, what: `${entry.record} set aside`, cache: false, counted: true,
            // What an earlier try already restored (same content) is no obstacle; anything else there is.
            state: (await pathExists(destination)) && !(await holdsText(destination, restored)) ? "taken" : "free",
            move: async () => {
              await mkdir(path.dirname(destination), { recursive: true });
              // Written whole under a name of its own and then published exclusively: a reader never sees half of it, and a file saved there meanwhile is never replaced.
              const temporary = path.join(path.dirname(destination), `.libera-restore-${randomUUID()}.tmp`);
              try {
                await writeFile(temporary, restored, { encoding: "utf8", flag: "wx" });
                try { await link(temporary, destination); } catch (error) {
                  if (errorCode(error) === "EEXIST") { if (!(await holdsText(destination, restored))) return false; }
                  else if (!LINK_UNAVAILABLE.has(errorCode(error))) throw error;
                  else {
                    try { await copyFile(temporary, destination, constants.COPYFILE_EXCL); }
                    catch (copyError) { if (errorCode(copyError) !== "EEXIST") throw copyError; if (!(await holdsText(destination, restored))) return false; }
                  }
                }
              } finally { await rm(temporary, { force: true }).catch(() => undefined); }
              await whenFree(() => rm(entry.at, { force: true }));
              return true;
            },
          });
        }
      }
      if (fileType === "markdown" && !shared) {
        const source = splitFilePath(pythonSidecarPath(move.from));
        const destination = splitFilePath(pythonSidecarPath(move.to));
        const sourceFile = filePathFromParts(source.notebook, source.pathParts);
        const destinationFile = filePathFromParts(destination.notebook, destination.pathParts);
        const has = await pathExists(sourceFile);
        const slot = has ? await slotOf(sourceFile, destinationFile) : "free";
        // Code of the legacy layout is moved too, whether or not it can be told of here.
        jobs.push({
          record: PYTHON, what: PYTHON, cache: false, counted: has, state: slot === "ours" ? "taken" : slot,
          move: () => slot === "same" ? movePythonAlias(sourceFile, destinationFile) : movePythonSidecar(move.from, move.to, { replace: false }),
        });
      }
      if (move.records.includes(AGENT)) {
        jobs.push({
          record: AGENT, what: AGENT, cache: false, counted: true, state: (await hasReviewEntry(move.to)) ? "taken" : "free",
          // Written at the new path before the old one goes: never only at a path with no file.
          move: async () => { await withMovedReview(move.from, move.to, (text) => text, async () => undefined); return true; },
        });
      }
      // Every slot is checked before the first write: what is foreseeably in the way stops the pair.
      const blocked = jobs.filter((job) => job.state === "taken" && !job.cache && job.counted);
      if (blocked.length) {
        for (const job of blocked) { problems.push(`The ${job.what} of ${move.from} stayed: ${move.to} has some of its own.`); done.set(job.record, "stayed"); }
        continue;
      }
      let tried = 0;
      let placed = 0;
      for (const job of jobs) {
        if (job.cache && job.state === "taken") continue;
        let went: boolean;
        try { went = await job.move(); }
        catch (error) { if (!job.cache) { done.set(job.record, "failed"); throw error; } continue; }
        if (job.cache || !job.counted) continue;
        tried += 1;
        if (went) { placed += 1; done.set(job.record, "moved"); }
        // A destination taken meanwhile keeps the old side file where it is, and says so.
        else { problems.push(`The ${job.what} of ${move.from} stayed: ${move.to} has some of its own.`); done.set(job.record, "stayed"); }
      }
      // The stores wait for a pair that is not whole: the rest stays planned, and a retry finishes it.
      if (placed >= tried) completed.push(move);
    } catch (error) {
      problems.push(`The side files of ${move.from} could not follow it to ${move.to}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The records of every whole pair, in one write per store (as the migration does).
  const failedStores = new Set<string>();
  if (completed.length) {
    const having = (records: string[]) => new Map(completed.filter((move) => move.records.some((record) => records.includes(record))).map((move) => [move.from, move.to]));
    const step = async (what: string, records: string[], task: (pairs: Map<string, string>) => Promise<unknown>) => {
      const pairs = having(records);
      if (!pairs.size) return;
      try { await task(pairs); } catch (error) { for (const record of records) failedStores.add(record); problems.push(`${what} could not follow: ${error instanceof Error ? error.message : String(error)}`); }
    };
    await step("Review comments", [REVIEWS], async (pairs) => {
      for (const from of await moveReviewPaths(pairs, { replaceEmpty: true })) problems.push(`The review comments of ${from} stayed there: ${pairs.get(from)} has review comments of its own.`);
    });
    await step("Stars and tags", [STARRED, TAGS], (pairs) => renameFileMetadataPaths(pairs));
    await step("Reference attachments", [ATTACHMENTS], async (pairs) => {
      const { changed, failures, offline } = await moveReferenceAttachmentsBatch(pairs);
      if (offline.length) problems.push(`${offline.join(", ")} ${offline.length === 1 ? "is" : "are"} not connected, so reference attachments or a tethered .bib file there may still point at the old paths.`);
      for (const failure of failures) problems.push(`Reference attachments in ${failure.notebook || "a library"} still point at the old paths.`);
      if (failures.length) failedStores.add(ATTACHMENTS);
      for (const library of changed) {
        try { publishReferenceEvent({ type: "library", notebook: library, revision: (await readReferenceLibrary(library)).revision }); }
        catch { /* The panel catches up when it next loads. */ }
      }
    });
    await step("The tethered .bib", [TETHER], async (pairs) => {
      const failures = await moveTetheredFilesBatch(pairs);
      for (const failure of failures) problems.push(`The tethered .bib file of ${failure.notebook} could not follow.`);
      if (failures.length) failedStores.add(TETHER);
    });
    // The undo history of the agent runs that changed these notes follows them, as after a move in the app (files.ts recordMovedRunFiles).
    await step("The agent's undo history", [UNDO], async (pairs) => {
      const texts = new Map([...pairs].filter(([, to]) => isTextFileType(getFileType(baseName(to)) ?? undefined)).map(([from, to]) => [from, { to }]));
      if (!texts.size) return;
      // Imported here: snapshots reaches back into storage through shared-writes.
      const { recordMovedRunFiles } = await import("@/lib/agent/snapshots");
      await recordMovedRunFiles(texts);
    });
  }

  // What the stores say now decides what moved, not what the steps were asked to do.
  const completedSet = new Set(completed);
  const holds = completed.length ? await recordHolders().catch(() => null) : null;
  const outcomes: RepairOutcome[] = [];
  const moved: RepairMove[] = [];
  for (const move of current.moves) {
    const done = status.get(move)!;
    for (const record of move.records) {
      let result = done.get(record);
      if (!result && STORE_RECORDS.includes(record)) {
        if (!completedSet.has(move)) result = "waiting";
        else if (failedStores.has(record)) result = "failed";
        else if (!holds) result = "failed";
        else result = holds(record, move.to) && !holds(record, move.from) ? "moved" : holds(record, move.from) ? "stayed" : "nothing";
      }
      outcomes.push({ from: move.from, to: move.to, record, status: result ?? "waiting" });
    }
    if (outcomes.some((outcome) => outcome.from === move.from && outcome.status === "moved")) moved.push(move);
  }
  notifySearchChanges(moved.flatMap((move) => [move.from, move.to]));
  return { notebook, moved, outcomes, problems };
}
