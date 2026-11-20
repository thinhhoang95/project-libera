import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { pythonSidecarDocumentPath, pythonSidecarPath } from "@/lib/python/sidecar";
import { hasReviewEntry, withMovedReview } from "@/lib/agent/review-store";
import { moveTetheredFilesBatch, readTetherTarget } from "@/lib/references/bib-tether";
import { publishReferenceEvent } from "@/lib/references/library-events";
import { LIBERA_SYSTEM_DIR } from "@/lib/storage/constants";
import { getFileType } from "@/lib/storage/file-types";
import { pathExists } from "@/lib/storage/fs-utils";
import { cachedPdfIdentity } from "@/lib/storage/pdf-identity";
import { fileExistence, libraryNotebookNames } from "@/lib/storage/library-links";
import { readMarkdownAssetDocuments, unreferencedMarkdownAssets, movePythonSidecar } from "@/lib/storage/markdown-assets";
import { moveReviewPaths } from "@/lib/storage/markdown-reviews";
import { readOrphans } from "@/lib/storage/pdf-sidecars";
import { assertSafeSegment, filePathFromParts, getLinkedFolder, getStateRoot, notebookPath, orphanedSidecarsDirectoryPath, splitFilePath, withReadOnlyStorage } from "@/lib/storage/paths";
import { inspectReferenceLibrary, moveReferenceAttachmentsBatch, readReferenceLibrary } from "@/lib/storage/references";
import { isEmptyReview, type ReviewDocument } from "@/lib/markdown-review";
import { inspectReviewDocuments, inspectReviewKeys } from "@/lib/storage/review-files";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { listSidecars, SIDECAR_KINDS, type ListedSidecar } from "@/lib/storage/sidecars";
import { listVisibleNotebookFiles } from "@/lib/storage/tree";
import { readWorkspaceMetadata, renameFileMetadataPaths } from "@/lib/storage/workspace-metadata";
import { StorageError } from "@/lib/storage/errors";
import { isTextFileType } from "@/lib/types";

// Check Notebook → Try to fix: files moved or renamed into another folder
// outside the app (Finder, a sync client) leave their records at the old
// path: side files, a note's Python code, stars and tags, review comments,
// reference attachments, a tethered .bib. A file is found again by its name
// by what it is, else by its name. Records that recorded their file's bytes
// (PDF annotations and outline, definitions, ink, a transcript, side files set
// aside) find the one file with those bytes, whatever its name or folder (the
// archive included); a file of the old name whose bytes differ is not the
// file and is never paired. Records that recorded nothing (stars, tags, an
// attachment) are matched by name: when exactly one file in the notebook has
// the name of exactly one missing path, and it has no records of the same
// kind of its own, the records follow it, as they would have after a move in
// the app (files.ts moveFile, the migration's batch helpers). A file of the
// name that is a different file would get the records, so the dialog shows
// every pair before anything is written, and the confirmation covers each
// file's size and modification time (and its hash where one was read).
//
// A file that is in another notebook, or that is probably the one (the base
// text of pending agent changes), is named but never given the records: they
// are not moved between notebooks, and Acknowledge keeps them.
//
// Side files the tree's upkeep set aside (`.libera/orphaned-sidecars/`, 30 s
// after their file went missing) are records of their original path too: they
// are matched by the same rule and put in place, never over what is there.
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
/** Records the file found may already have: then the two are not merged and the match is not made. */
const OWN = new Set([...Object.values(SIDECAR_RECORDS).filter(Boolean) as string[], PYTHON, TAGS, REVIEWS, AGENT]);

export type RepairMove = { from: string; to: string; records: string[] };
export type RepairUnmatched = {
  from: string;
  records: string[];
  /** `none`: no file of that name. `several`: more than one could be it. `shared-name`: other missing files have the same name. `own`: the only one has records of its own. `different`: files of that name exist but their content is not what the records were made for. `elsewhere`: no file here, but one in another notebook or under another name may be it. */
  reason: "none" | "several" | "shared-name" | "own" | "different" | "elsewhere";
  candidates: string[];
};
export type RepairPlan = { notebook: string; moves: RepairMove[]; unmatched: RepairUnmatched[]; token: string };
export type RepairResult = { notebook: string; moved: RepairMove[]; problems: string[] };

/** A side file set aside for a path, in the record's own words (SIDECAR_RECORDS). Ink is a folder with its record; the others one record file holding the side file. */
type SetAside = { record: string; /** The side file kind (sidecars.ts). */ kind: string; /** The record file, or for ink its folder. */ at: string; sidecar?: unknown; /** The file's bytes as the record kept them. */ identity?: Identity | null };
type Identity = { size: number; contentHash: string };
type Fingerprint = { size: number; mtimeMs: number; hash?: string };
/** Where a destination stands for a side file: `free`; `same` (a case-only rename: it is the source itself); `done` (an earlier try already put all of it there); `taken` (something else is there). */
type Slot = "free" | "same" | "done" | "taken";
/** The kinds readOrphans lists, by the side file kind that holds them. */
const SET_ASIDE_KINDS: Record<string, string> = { annotations: "pdf-annotations", outline: "pdf-outline", definitions: "definitions" };

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;
const under = (libraryPath: string, notebook: string) => libraryPath.startsWith(`${notebook}/`);
const baseName = (libraryPath: string) => libraryPath.slice(libraryPath.lastIndexOf("/") + 1);
/** Names are matched as a sync client or the disk may spell them: Unicode form and case do not tell files apart. */
const nameKey = (libraryPath: string) => baseName(libraryPath).normalize("NFC").toLowerCase();

/** A notebook this computer may change records of: not shared, and connected. Also used by Acknowledge (cleanup.ts). */
export function assertRepairable(name: string) {
  const notebook = assertSafeSegment(name, "Notebook name");
  if (notebook.startsWith(".")) throw new StorageError("That is not a notebook.", 400);
  if (isSharedNotebookPath(notebook)) throw new StorageError("Shared notebooks are kept in step by collaboration and can't be fixed here.", 409);
  if (getLinkedFolder(notebook)?.unresolved) throw new StorageError(`${notebook} is not connected on this computer. Reconnect it first.`, 409);
  return notebook;
}

/**
 * Moves a side file, or an ink folder, to where nothing is. Creating the
 * destination is exclusive (COPYFILE_EXCL, mkdir), so a side file the app
 * saves there meanwhile is never replaced: then the source stays. Renaming
 * would replace it on every platform.
 */
async function moveIntoPlace(source: string, destination: string): Promise<boolean> {
  await mkdir(path.dirname(destination), { recursive: true });
  // A case-only rename on a case-insensitive disk: the destination is the
  // source itself, so it is renamed (through a temporary name, which some
  // disks need to change only the case) instead of being taken.
  const [from, to] = await Promise.all([source, destination].map((target) => lstat(target, { bigint: true }).catch(() => null)));
  if (from && to && from.dev === to.dev && from.ino === to.ino) {
    const temporary = `${source}.${randomUUID()}.moving`;
    await rename(source, temporary);
    await rename(temporary, destination);
    return true;
  }
  // Copied whole before anything of the source goes: a part that can't be
  // placed takes back what was copied, so the destination never holds half of
  // a folder (which a retry would take for the file's own).
  const created: Array<{ target: string; directory: boolean }> = [];
  let placed = false;
  try { placed = await copyTree(source, destination, created); }
  catch (error) { await undoCopy(created); throw error; }
  if (!placed) { await undoCopy(created); return false; }
  await rm(source, { recursive: true, force: true });
  return true;
}

/** Copies a file or folder to where nothing is, exclusively; false when something is in the way. What was created is listed in `created`. */
async function copyTree(source: string, destination: string, created: Array<{ target: string; directory: boolean }>): Promise<boolean> {
  const taken = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";
  if ((await lstat(source)).isDirectory()) {
    try { await mkdir(destination); } catch (error) { if (taken(error)) return false; throw error; }
    created.push({ target: destination, directory: true });
    for (const name of await readdir(source)) if (!(await copyTree(path.join(source, name), path.join(destination, name), created))) return false;
    return true;
  }
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); } catch (error) { if (taken(error)) return false; throw error; }
  created.push({ target: destination, directory: false });
  return true;
}

/** Takes back what a copy created, last first; a folder someone has put something into since is left. */
async function undoCopy(created: Array<{ target: string; directory: boolean }>) {
  for (const { target, directory } of [...created].reverse()) {
    if (directory) await rmdir(target).catch(() => undefined);
    else await rm(target, { force: true }).catch(() => undefined);
  }
}

/** What would be moved where. Reads only. */
export function planNotebookRepair(name: string): Promise<RepairPlan> {
  return withReadOnlyStorage(async () => (await plan(name)).plan);
}

async function plan(name: string): Promise<{ plan: RepairPlan; asides: Map<string, SetAside[]> }> {
  const notebook = assertRepairable(name);
  if (!(await lstat(notebookPath(notebook)).catch(() => null))?.isDirectory()) throw new StorageError("Notebook not found.", 404);
  // The archive counts: a file moved there in Finder is a candidate, and a second file of its name there makes "several".
  const visible = await listVisibleNotebookFiles(notebook, { includeArchive: true });
  // A name is unique only if every file was seen.
  if (visible.truncated) throw new StorageError(`${notebook} has too many files to match moved files by name.`, 413);
  if (visible.unreadable.length) throw new StorageError(`${plural(visible.unreadable.length, "folder")} of ${notebook} could not be read (${visible.unreadable.slice(0, 3).join(", ")}${visible.unreadable.length > 3 ? ", ..." : ""}), so a file's name can't be known to be the only one. Fix its permissions or reconnect the drive, then try again.`, 409);

  /** Records kept per path, whether or not the file is there. */
  const records = new Map<string, Set<string>>();
  const add = (libraryPath: string, record: string) => {
    if (!under(libraryPath, notebook) || !getFileType(baseName(libraryPath))) return;
    if (!records.has(libraryPath)) records.set(libraryPath, new Set());
    records.get(libraryPath)!.add(record);
  };

  const { sidecars } = await listSidecars(notebook);
  for (const sidecar of sidecars) { const record = SIDECAR_RECORDS[sidecar.kind]; if (record) add(sidecar.filePath, record); }

  // Side files set aside for files that left are records of their original path, unless a live side file of that kind is there.
  const asides = new Map<string, SetAside[]>();
  const aside = (originalPath: string, entry: SetAside) => {
    if (!under(originalPath, notebook) || !getFileType(baseName(originalPath)) || records.get(originalPath)?.has(entry.record)) return;
    asides.set(originalPath, [...asides.get(originalPath) ?? [], entry]);
  };
  for (const { file, record } of await readOrphans(notebook)) {
    if (record.sidecar !== undefined && record.sidecar !== null) aside(record.originalPath, { record: record.kind, kind: SET_ASIDE_KINDS[record.kind], at: file, sidecar: record.sidecar, identity: record.source ?? null });
  }
  const inkAside = orphanedSidecarsDirectoryPath(notebook, "ink");
  for (const entry of await readdir(inkAside, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(inkAside, entry.name);
    let originalPath: unknown;
    let source: { size?: unknown; sha256?: unknown } | null | undefined;
    try { ({ originalPath, source } = JSON.parse(await readFile(path.join(directory, "record.json"), "utf8")) as { originalPath?: unknown; source?: { size?: unknown; sha256?: unknown } | null }); } catch { continue; }
    const identity = source && typeof source.size === "number" && typeof source.sha256 === "string" ? { size: source.size, contentHash: source.sha256 } : null;
    if (typeof originalPath === "string" && (await lstat(path.join(directory, "ink")).catch(() => null))?.isDirectory()) aside(originalPath, { record: "ink", kind: "ink", at: directory, identity });
  }
  for (const [originalPath, entries] of asides) for (const entry of entries) add(originalPath, entry.record);

  // A note's Python code lives in _assets, under the note's path.
  const unused = await unreferencedMarkdownAssets(notebook, await readMarkdownAssetDocuments(notebook)) ?? [];
  for (const asset of unused) {
    if (!asset.toLowerCase().endsWith(".py")) continue;
    const note = pythonSidecarDocumentPath(asset);
    if (note) add(note, PYTHON);
  }

  const metadata = await readWorkspaceMetadata();
  for (const starred of metadata.starredFilePaths) add(starred, STARRED);
  for (const tagged of Object.keys(metadata.fileTags)) add(tagged, TAGS);
  // A damaged review index is reported by the check; nothing of it is moved.
  for (const key of (await inspectReviewKeys(getStateRoot())).keys) add(key, REVIEWS);
  for (const library of await libraryNotebookNames()) {
    const inspected = await inspectReferenceLibrary(library).catch(() => null);
    if (!inspected || "damaged" in inspected) continue;
    for (const entry of Object.values(inspected.library?.entries ?? {})) {
      for (const attachment of entry.attachments) if (attachment.kind !== "url") add(attachment.path, ATTACHMENTS);
    }
  }
  const tether = await readTetherTarget(notebook).catch(() => null);
  if (tether && "libraryPath" in tether) add(tether.libraryPath, TETHER);
  // The agent's changes waiting for review are the note's records too.
  const agentBaselines = new Map<string, string>();
  for (const entry of await readAgentReviews()) { agentBaselines.set(entry.path, entry.baseline); add(entry.path, AGENT); }

  // Paths whose records stay behind: not in the notebook, and surely gone
  // (a path that could not be checked is never taken for missing).
  const listed = new Set(visible.files);
  const disk = fileExistence();
  /** Whether the folder lists this exact name: on a case-insensitive disk `exists` also says yes to `Paper.pdf` when only `paper.pdf` is there. Null when it can't be told. */
  const listsName = async (libraryPath: string): Promise<boolean | null> => {
    try {
      const { notebook: owner, pathParts } = splitFilePath(libraryPath);
      return (await readdir(path.dirname(filePathFromParts(owner, pathParts)))).includes(pathParts[pathParts.length - 1]);
    } catch (error) { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? false : null; }
  };
  const missing: string[] = [];
  for (const libraryPath of records.keys()) {
    if (listed.has(libraryPath)) continue;
    await disk.check([libraryPath]);
    if (disk.unknown(libraryPath)) continue;
    if (disk.exists(libraryPath) && (await listsName(libraryPath)) !== false) continue;
    missing.push(libraryPath);
  }


  const filesByName = new Map<string, string[]>();
  for (const file of visible.files) {
    const key = nameKey(file);
    filesByName.set(key, [...(filesByName.get(key) ?? []), file]);
  }
  const missingByName = new Map<string, number>();
  for (const libraryPath of missing) missingByName.set(nameKey(libraryPath), (missingByName.get(nameKey(libraryPath)) ?? 0) + 1);

  // What a file is, found without trusting its name: size and modification
  // time for every candidate, and its hash where one was needed.
  const prints = new Map<string, Promise<Fingerprint | null>>();
  const fingerprint = (libraryPath: string) => {
    if (!prints.has(libraryPath)) prints.set(libraryPath, (async () => {
      try {
        const parsed = splitFilePath(libraryPath);
        const stats = await lstat(filePathFromParts(parsed.notebook, parsed.pathParts));
        return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
      } catch { return null; }
    })());
    return prints.get(libraryPath)!;
  };
  const hashes = new Map<string, Promise<string | null>>();
  const hashOf = (libraryPath: string) => {
    if (!hashes.has(libraryPath)) {
      const parsed = splitFilePath(libraryPath);
      hashes.set(libraryPath, cachedPdfIdentity(filePathFromParts(parsed.notebook, parsed.pathParts)).then((found) => found.contentHash, () => null));
    }
    return hashes.get(libraryPath)!;
  };
  /** Every file of the type whose bytes are `identity` (its size, then its hash), whatever its name. */
  const identityMatches = async (identity: Identity, fileType: string, files: readonly string[]) => {
    const matches: string[] = [];
    for (const file of files) {
      if (getFileType(baseName(file)) !== fileType) continue;
      const print = await fingerprint(file);
      if (!print || print.size !== identity.size) continue;
      if (await hashOf(file) === identity.contentHash) matches.push(file);
    }
    return matches;
  };

  // The bytes the records of a missing path were made for, as they kept them.
  const sidecarsAt = new Map<string, ListedSidecar[]>();
  for (const sidecar of sidecars) sidecarsAt.set(sidecar.filePath, [...sidecarsAt.get(sidecar.filePath) ?? [], sidecar]);
  const identityOf = async (from: string): Promise<Identity | null | "conflict"> => {
    const found: Identity[] = [];
    const fileType = getFileType(baseName(from)) ?? "";
    for (const sidecar of sidecarsAt.get(from) ?? []) {
      const kind = sidecar.kindInfo;
      if (kind.cache) continue;
      try {
        if (kind.layout === "folder") {
          for (const source of (await kind.inspectFolder?.(sidecar.path, fileType))?.sources ?? []) found.push({ size: source.size, contentHash: source.sha256 });
        } else {
          const source = kind.inspect?.(JSON.parse(await readFile(sidecar.path, "utf8")))?.source;
          if (source?.contentHash) found.push({ size: source.size, contentHash: source.contentHash });
        }
      } catch { /* A side file that can't be read says nothing of its file. */ }
    }
    for (const entry of asides.get(from) ?? []) if (entry.identity) found.push(entry.identity);
    if (!found.length) return null;
    // Records that name different files can't be given to one.
    return found.every((item) => item.contentHash === found[0].contentHash && item.size === found[0].size) ? found[0] : "conflict";
  };

  /** Records of the pair that an earlier, interrupted try already put at the destination: they are no obstacle to finishing it. */
  const finished = async (from: string, candidate: string) => {
    const done = new Set<string>();
    let source: ReturnType<typeof splitFilePath>;
    let destination: ReturnType<typeof splitFilePath>;
    // A path no file can have (a reserved segment) has no side files to have moved.
    try { source = splitFilePath(from); destination = splitFilePath(candidate); } catch { return done; }
    const fileType = getFileType(source.name) ?? "";
    for (const kind of SIDECAR_KINDS) {
      const record = SIDECAR_RECORDS[kind.id];
      if (!record || kind.cache || !kind.appliesTo(fileType)) continue;
      if (await slotOf(kind.filePath(notebook, source.pathParts), kind.filePath(notebook, destination.pathParts)) === "done") done.add(record);
    }
    for (const entry of asides.get(from) ?? []) {
      const kind = SIDECAR_KINDS.find((candidateKind) => candidateKind.id === entry.kind);
      if (!kind?.appliesTo(fileType)) continue;
      const target = kind.filePath(notebook, destination.pathParts);
      if (entry.record === "ink" ? await slotOf(path.join(entry.at, "ink"), target) === "done" : await sameJson(target, entry.sidecar)) done.add(entry.record);
    }
    return done;
  };

  const ownRecords = async (candidate: string, from: string) => {
    const own = new Set([...records.get(candidate) ?? []].filter((record) => OWN.has(record)));
    // Opening the file where it is now made an empty review: it is not the
    // file's own, and applying replaces it (moveReviewPaths, replaceEmpty).
    if (own.has(REVIEWS)) {
      const reviews = await inspectReviewDocuments<ReviewDocument>(getStateRoot(), candidate);
      if (reviews?.every(isEmptyReview)) own.delete(REVIEWS);
    }
    // Python code of a note that is there is in use, so it was not listed above.
    if (getFileType(baseName(candidate)) === "markdown") {
      const python = splitFilePath(pythonSidecarPath(candidate));
      if (await pathExists(filePathFromParts(python.notebook, python.pathParts))) own.add(PYTHON);
    }
    for (const record of await finished(from, candidate)) own.delete(record);
    return own;
  };

  const moves: RepairMove[] = [];
  const unmatched: RepairUnmatched[] = [];
  const identities = new Map<string, Identity>();
  /** Missing paths with no file in this notebook: another notebook, or another name, may have it. */
  const searching: Array<{ from: string; kept: string[]; identity: Identity | null }> = [];
  for (const from of missing.sort()) {
    const kept = [...records.get(from)!].sort();
    const fileType = getFileType(baseName(from)) ?? "";
    const named = [...filesByName.get(nameKey(from)) ?? []].sort();
    const identity = await identityOf(from);
    let target: string | null = null;
    if (identity === "conflict") { unmatched.push({ from, records: kept, reason: "several", candidates: named }); continue; }
    if (identity) {
      // What the records were made for decides, across names and folders (the archive included).
      const found = (await identityMatches(identity, fileType, visible.files)).sort();
      if (found.length > 1) { unmatched.push({ from, records: kept, reason: "several", candidates: found }); continue; }
      if (found.length === 1) { target = found[0]; identities.set(from, identity); }
      // A file of the name that is not it is not given the records.
      else if (named.length) { unmatched.push({ from, records: kept, reason: "different", candidates: named }); continue; }
    } else {
      // No bytes were recorded: the name is all there is, and it must be exactly one file's.
      // Stars or an attachment alone are worth finding again; caches alone are not listed (they are made again).
      if ((missingByName.get(nameKey(from)) ?? 0) > 1) { unmatched.push({ from, records: kept, reason: "shared-name", candidates: named }); continue; }
      // Exactly one file of that name, or no guess: one of several is never picked for having no records.
      if (named.length > 1) { unmatched.push({ from, records: kept, reason: "several", candidates: named }); continue; }
      if (named.length === 1) target = named[0];
    }
    if (!target) { searching.push({ from, kept, identity: identity || null }); continue; }
    const own = await ownRecords(target, from);
    if (kept.some((record) => own.has(record))) unmatched.push({ from, records: kept, reason: "own", candidates: [target] });
    else moves.push({ from, to: target, records: kept });
  }

  // One file takes the records of one path.
  const claimed = new Map<string, number>();
  for (const move of moves) claimed.set(move.to, (claimed.get(move.to) ?? 0) + 1);
  for (const move of [...moves]) {
    if ((claimed.get(move.to) ?? 0) < 2) continue;
    moves.splice(moves.indexOf(move), 1);
    unmatched.push({ from: move.from, records: move.records, reason: "several", candidates: [move.to] });
  }

  // Before records are called homeless: the file may be in another notebook,
  // or have been given another name (by its bytes, or, for pending agent
  // changes, by the text they started from). Never moved here, only named.
  if (searching.length) {
    const elsewhere: string[] = [];
    for (const other of new Set(await libraryNotebookNames())) {
      if (other === notebook) continue;
      try { elsewhere.push(...(await listVisibleNotebookFiles(other, { includeArchive: true })).files); } catch { /* A notebook that can't be listed has nothing to name. */ }
    }
    const notes = [...visible.files, ...elsewhere].filter((file) => getFileType(baseName(file)) === "markdown");
    let reads = 0;
    for (const { from, kept, identity } of searching) {
      const found = new Set(elsewhere.filter((file) => nameKey(file) === nameKey(from)));
      if (identity) for (const file of await identityMatches(identity, getFileType(baseName(from)) ?? "", [...visible.files, ...elsewhere])) found.add(file);
      const baseline = agentBaselines.get(from);
      if (baseline !== undefined && getFileType(baseName(from)) === "markdown") {
        for (const file of notes) {
          if (found.has(file) || reads >= MAX_CONTENT_READS) continue;
          const print = await fingerprint(file);
          if (!print || print.size > MAX_CONTENT_BYTES) continue;
          reads += 1;
          const parsed = splitFilePath(file);
          const text = await readFile(filePathFromParts(parsed.notebook, parsed.pathParts), "utf8").catch(() => null);
          if (text !== null && recognises(baseline, text)) found.add(file);
        }
      }
      unmatched.push({ from, records: kept, reason: found.size ? "elsewhere" : "none", candidates: [...found].sort() });
    }
  }
  unmatched.sort((a, b) => a.from.localeCompare(b.from));

  // The confirmation covers the files that would take records, and the ones
  // named as candidates: replacing one between the preview and the
  // confirmation changes the token.
  const watched = [...new Set([...moves.map((move) => move.to), ...unmatched.flatMap((item) => item.candidates)])].sort();
  const files: Record<string, Fingerprint | null> = {};
  for (const file of watched) {
    const print = await fingerprint(file);
    const hash = hashes.has(file) ? await hashes.get(file) : null;
    files[file] = print ? { ...print, ...(hash ? { hash } : {}) } : null;
  }
  const token = createHash("sha256").update(JSON.stringify({ moves, unmatched, files, identities: [...identities].sort() })).digest("hex").slice(0, 32);
  return { plan: { notebook, moves, unmatched, token }, asides };
}

/** Files read to recognise a note by its text, and the largest one. */
const MAX_CONTENT_READS = 500;
const MAX_CONTENT_BYTES = 1_000_000;

/** Whether `text` is the note that pending agent changes started from: it holds that text, or most of its lines. */
function recognises(baseline: string, text: string) {
  const wanted = baseline.trim();
  if (wanted.length < 20) return false;
  if (text.includes(wanted)) return true;
  const lines = [...new Set(wanted.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  if (lines.length < 3) return false;
  const have = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  return lines.filter((line) => have.has(line)).length / lines.length >= 0.8;
}

/** Pending agent changes with the text they started from, read without settling (or dropping) any of them (agent/review-store.ts keeps them, one file each). */
async function readAgentReviews() {
  const directory = path.join(getStateRoot(), LIBERA_SYSTEM_DIR, "agent-review");
  const found: Array<{ path: string; baseline: string }> = [];
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(await readFile(path.join(directory, name), "utf8")) as { path?: unknown; baseline?: unknown };
      if (typeof entry.path === "string" && typeof entry.baseline === "string") found.push({ path: entry.path, baseline: entry.baseline });
    } catch { /* A damaged entry is the check's to report. */ }
  }
  return found;
}

/** Whether the file holds exactly this JSON (as a side file set aside was written). */
async function sameJson(target: string, value: unknown) {
  try { return JSON.stringify(JSON.parse(await readFile(target, "utf8"))) === JSON.stringify(value); } catch { return false; }
}

/** Whether everything under `source` is already, byte for byte, under `destination`. */
async function alreadyThere(source: string, destination: string): Promise<boolean> {
  const [from, to] = await Promise.all([source, destination].map((target) => lstat(target).catch(() => null)));
  if (!from || !to) return false;
  if (from.isDirectory() && to.isDirectory()) {
    for (const name of await readdir(source)) if (!(await alreadyThere(path.join(source, name), path.join(destination, name)))) return false;
    return true;
  }
  if (!from.isFile() || !to.isFile() || from.size !== to.size) return false;
  return (await readFile(source)).equals(await readFile(destination));
}

async function slotOf(source: string, destination: string): Promise<Slot> {
  const [from, to] = await Promise.all([source, destination].map((target) => lstat(target, { bigint: true }).catch(() => null)));
  if (!to) return "free";
  if (from && from.dev === to.dev && from.ino === to.ino) return "same";
  return await alreadyThere(source, destination) ? "done" : "taken";
}

/** One thing that moves with a file, and where its destination stands before anything is written. */
type Job = { what: string; cache: boolean; /** False when it may turn out there was nothing to move. */ counted: boolean; state: Slot; move: () => Promise<boolean>; /** What is left of the source once an earlier try put it all at the destination. */ leftover: () => Promise<unknown> };

/**
 * Moves the records of the pairs shown in the plan (`token`): planned again
 * first, and refused when anything changed since. Each store is written once.
 * A pair whose destination slots are taken is stopped before anything moves; a
 * pair only some of whose records moved is not reported moved, and a retry
 * finishes it (records an interrupted try already placed are not obstacles).
 */
export async function applyNotebookRepair(name: string, token: string): Promise<RepairResult> {
  const notebook = assertRepairable(name);
  const { plan: current, asides } = await withReadOnlyStorage(() => plan(notebook));
  if (current.token !== token) throw new StorageError("The notebook changed since the fix was prepared. Check it again.", 409);
  const { listInterruptedMigrations } = await import("@/lib/storage/migration");
  if ((await listInterruptedMigrations()).some((migration) => migration.source === notebook || migration.destination.notebook === notebook)) {
    throw new StorageError("A migration involving this notebook did not finish. Finish or stop it in Migration first.", 409);
  }

  const problems: string[] = [];
  const moved: RepairMove[] = [];
  for (const move of current.moves) {
    // All of the pair is in the try: one reserved segment must not stop the other pairs after some side files moved.
    try {
      const from = splitFilePath(move.from);
      const to = splitFilePath(move.to);
      const fileType = getFileType(from.name) ?? "";
      const jobs: Job[] = [];
      for (const kind of SIDECAR_KINDS) {
        if (!kind.appliesTo(fileType)) continue;
        const source = kind.filePath(notebook, from.pathParts);
        const destination = kind.filePath(notebook, to.pathParts);
        if (!(await pathExists(source))) continue;
        jobs.push({ what: SIDECAR_RECORDS[kind.id] ?? kind.id, cache: Boolean(kind.cache), counted: true, state: await slotOf(source, destination), move: () => moveIntoPlace(source, destination), leftover: () => rm(source, { recursive: true, force: true }) });
      }
      for (const entry of asides.get(move.from) ?? []) {
        const kind = SIDECAR_KINDS.find((candidate) => candidate.id === entry.kind);
        if (!kind?.appliesTo(fileType)) continue;
        const destination = kind.filePath(notebook, to.pathParts);
        if (entry.record === "ink") {
          const source = path.join(entry.at, "ink");
          jobs.push({
            what: "ink set aside", cache: false, counted: true, state: await slotOf(source, destination),
            move: async () => { const went = await moveIntoPlace(source, destination); if (went) await rm(entry.at, { recursive: true, force: true }); return went; },
            leftover: () => rm(entry.at, { recursive: true, force: true }),
          });
        } else {
          jobs.push({
            what: `${entry.record} set aside`, cache: false, counted: true,
            state: (await pathExists(destination)) ? (await sameJson(destination, entry.sidecar) ? "done" : "taken") : "free",
            move: async () => {
              await mkdir(path.dirname(destination), { recursive: true });
              try { await writeFile(destination, `${JSON.stringify(entry.sidecar, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
              await rm(entry.at, { force: true });
              return true;
            },
            leftover: () => rm(entry.at, { force: true }),
          });
        }
      }
      if (fileType === "markdown") {
        const source = splitFilePath(pythonSidecarPath(move.from));
        const destination = splitFilePath(pythonSidecarPath(move.to));
        const has = await pathExists(filePathFromParts(source.notebook, source.pathParts));
        const taken = has && await pathExists(filePathFromParts(destination.notebook, destination.pathParts));
        // Code of the legacy layout is moved too, whether or not it can be told of here.
        jobs.push({ what: PYTHON, cache: false, counted: has, state: taken ? "taken" : "free", move: () => movePythonSidecar(move.from, move.to, { replace: false }), leftover: async () => undefined });
      }
      if (move.records.includes(AGENT)) {
        jobs.push({
          what: AGENT, cache: false, counted: true, state: (await hasReviewEntry(move.to)) ? "taken" : "free",
          // Written at the new path before the old one goes: never only at a path with no file.
          move: async () => { await withMovedReview(move.from, move.to, (text) => text, async () => undefined); return true; },
          leftover: async () => undefined,
        });
      }
      // Every slot is checked before the first write: what is foreseeably in the way stops the pair.
      const blocked = jobs.filter((job) => job.state === "taken" && !job.cache && job.counted);
      if (blocked.length) {
        for (const job of blocked) problems.push(`The ${job.what} of ${move.from} stayed: ${move.to} has some of its own.`);
        continue;
      }
      let tried = 0;
      let placed = 0;
      for (const job of jobs) {
        if (job.state === "done") { await job.leftover(); if (job.counted && !job.cache) { tried += 1; placed += 1; } continue; }
        if (job.cache && job.state === "taken") continue;
        let went: boolean;
        try { went = await job.move(); }
        catch (error) { if (!job.cache) throw error; continue; }
        if (job.cache || !job.counted) continue;
        tried += 1;
        if (went) placed += 1;
        // A destination taken meanwhile keeps the old side file where it is, and says so.
        else problems.push(`The ${job.what} of ${move.from} stayed: ${move.to} has some of its own.`);
      }
      // Reported moved only when all of it moved: the rest stays planned, and a retry finishes it.
      if (placed < tried) continue;
      moved.push(move);
    } catch (error) {
      problems.push(`The side files of ${move.from} could not follow it to ${move.to}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The records of every pair, in one write per store (as the migration does).
  const pairs = new Map(moved.map((move) => [move.from, move.to]));
  if (pairs.size) {
    const step = async (what: string, task: () => Promise<unknown>) => {
      try { await task(); } catch (error) { problems.push(`${what} could not follow: ${error instanceof Error ? error.message : String(error)}`); }
    };
    await step("Review comments", async () => {
      for (const from of await moveReviewPaths(pairs, { replaceEmpty: true })) problems.push(`The review comments of ${from} stayed there: ${pairs.get(from)} has review comments of its own.`);
    });
    await step("Stars and tags", () => renameFileMetadataPaths(pairs));
    await step("Reference attachments", async () => {
      const { changed, failures, offline } = await moveReferenceAttachmentsBatch(pairs);
      if (offline.length) problems.push(`${offline.join(", ")} ${offline.length === 1 ? "is" : "are"} not connected, so reference attachments or a tethered .bib file there may still point at the old paths.`);
      for (const failure of failures) problems.push(`Reference attachments in ${failure.notebook || "a library"} still point at the old paths.`);
      for (const library of changed) {
        try { publishReferenceEvent({ type: "library", notebook: library, revision: (await readReferenceLibrary(library)).revision }); }
        catch { /* The panel catches up when it next loads. */ }
      }
    });
    await step("The tethered .bib", async () => {
      for (const failure of await moveTetheredFilesBatch(pairs)) problems.push(`The tethered .bib file of ${failure.notebook} could not follow.`);
    });
    // The undo history of the agent runs that changed these notes follows them, as after a move in the app (files.ts recordFileMove).
    await step("The agent's undo history", async () => {
      const texts = new Map(moved.filter((move) => isTextFileType(getFileType(baseName(move.to)) ?? undefined)).map((move) => [move.from, { to: move.to }]));
      if (!texts.size) return;
      // Imported here: snapshots reaches back into storage through shared-writes.
      const { recordMovedRunFiles } = await import("@/lib/agent/snapshots");
      await recordMovedRunFiles(texts);
    });
    notifySearchChanges([...pairs.keys(), ...pairs.values()]);
  }
  return { notebook, moved, problems };
}
