import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { pythonSidecarDocumentPath, pythonSidecarPath } from "@/lib/python/sidecar";
import { moveTetheredFilesBatch, readTetherTarget } from "@/lib/references/bib-tether";
import { publishReferenceEvent } from "@/lib/references/library-events";
import { getFileType } from "@/lib/storage/file-types";
import { pathExists } from "@/lib/storage/fs-utils";
import { fileExistence, libraryNotebookNames } from "@/lib/storage/library-links";
import { readMarkdownAssetDocuments, unreferencedMarkdownAssets, movePythonSidecar } from "@/lib/storage/markdown-assets";
import { moveReviewPaths } from "@/lib/storage/markdown-reviews";
import { readOrphans } from "@/lib/storage/pdf-sidecars";
import { assertSafeSegment, filePathFromParts, getLinkedFolder, getStateRoot, notebookPath, orphanedSidecarsDirectoryPath, splitFilePath, withReadOnlyStorage } from "@/lib/storage/paths";
import { inspectReferenceLibrary, moveReferenceAttachmentsBatch, readReferenceLibrary } from "@/lib/storage/references";
import { isEmptyReview, type ReviewDocument } from "@/lib/markdown-review";
import { inspectReviewDocuments, inspectReviewKeys } from "@/lib/storage/review-files";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { listSidecars, SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { listVisibleNotebookFiles } from "@/lib/storage/tree";
import { readWorkspaceMetadata, renameFileMetadataPaths } from "@/lib/storage/workspace-metadata";
import { StorageError } from "@/lib/storage/errors";

// Check Notebook → Try to fix: files moved or renamed into another folder
// outside the app (Finder, a sync client) leave their records at the old
// path: side files, a note's Python code, stars and tags, review comments,
// reference attachments, a tethered .bib. A file is found again by its name
// alone: when exactly one file in the notebook has the name of exactly one
// missing path, and it has no records of the same kind of its own, the
// records follow it, as they would have after a move in the app (files.ts
// moveFile, the migration's batch helpers). There is no fingerprint: a
// different file that happens to have the same name gets the records, so the
// dialog shows every pair before anything is written.
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
/** Records the file found may already have: then the two are not merged and the match is not made. */
const OWN = new Set([...Object.values(SIDECAR_RECORDS).filter(Boolean) as string[], PYTHON, TAGS, REVIEWS]);

export type RepairMove = { from: string; to: string; records: string[] };
export type RepairUnmatched = {
  from: string;
  records: string[];
  /** `none`: no file of that name. `several`: more than one could be it. `shared-name`: other missing files have the same name. `own`: the only one has records of its own. */
  reason: "none" | "several" | "shared-name" | "own";
  candidates: string[];
};
export type RepairPlan = { notebook: string; moves: RepairMove[]; unmatched: RepairUnmatched[]; token: string };
export type RepairResult = { notebook: string; moved: RepairMove[]; problems: string[] };

/** A side file set aside for a path, in the record's own words (SIDECAR_RECORDS). Ink is a folder with its record; the others one record file holding the side file. */
type SetAside = { record: string; /** The side file kind (sidecars.ts). */ kind: string; /** The record file, or for ink its folder. */ at: string; sidecar?: unknown };
/** The kinds readOrphans lists, by the side file kind that holds them. */
const SET_ASIDE_KINDS: Record<string, string> = { annotations: "pdf-annotations", outline: "pdf-outline", definitions: "definitions" };
/** Records that are files (side files, Python code), as against stars, comments and the like that follow in their stores. */
const FILE_RECORDS = new Set([...Object.values(SIDECAR_RECORDS).filter(Boolean) as string[], PYTHON]);

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
  const taken = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";
  if ((await lstat(source)).isDirectory()) {
    try { await mkdir(destination); } catch (error) { if (taken(error)) return false; throw error; }
    for (const name of await readdir(source)) await moveIntoPlace(path.join(source, name), path.join(destination, name));
    await rmdir(source).catch(() => undefined);
    return true;
  }
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); } catch (error) { if (taken(error)) return false; throw error; }
  await rm(source, { force: true });
  return true;
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
    if (record.sidecar !== undefined && record.sidecar !== null) aside(record.originalPath, { record: record.kind, kind: SET_ASIDE_KINDS[record.kind], at: file, sidecar: record.sidecar });
  }
  const inkAside = orphanedSidecarsDirectoryPath(notebook, "ink");
  for (const entry of await readdir(inkAside, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(inkAside, entry.name);
    let originalPath: unknown;
    try { originalPath = (JSON.parse(await readFile(path.join(directory, "record.json"), "utf8")) as { originalPath?: unknown }).originalPath; } catch { continue; }
    if (typeof originalPath === "string" && (await lstat(path.join(directory, "ink")).catch(() => null))?.isDirectory()) aside(originalPath, { record: "ink", kind: "ink", at: directory });
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

  const ownRecords = async (candidate: string) => {
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
    return own;
  };

  const moves: RepairMove[] = [];
  const unmatched: RepairUnmatched[] = [];
  for (const from of missing.sort()) {
    const kept = [...records.get(from)!].sort();
    // Stars or an attachment alone are worth finding again; caches alone are not listed (they are made again).
    const found = [...filesByName.get(nameKey(from)) ?? []].sort();
    if ((missingByName.get(nameKey(from)) ?? 0) > 1) { unmatched.push({ from, records: kept, reason: "shared-name", candidates: found }); continue; }
    // Exactly one file of that name, or no guess: one of several is never picked for having no records.
    if (found.length !== 1) { unmatched.push({ from, records: kept, reason: found.length ? "several" : "none", candidates: found }); continue; }
    const own = await ownRecords(found[0]);
    if (kept.some((record) => own.has(record))) unmatched.push({ from, records: kept, reason: "own", candidates: found });
    else moves.push({ from, to: found[0], records: kept });
  }

  const token = createHash("sha256").update(JSON.stringify(moves)).digest("hex").slice(0, 32);
  return { plan: { notebook, moves, unmatched, token }, asides };
}

/**
 * Moves the records of the pairs shown in the plan (`token`): planned again
 * first, and refused when anything changed since. Each store is written once.
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
      let tried = 0;
      let placed = 0;
      /** A destination taken meanwhile keeps the old side file where it is, and says so. */
      const place = (what: string, went: boolean) => {
        tried += 1;
        if (went) placed += 1;
        else problems.push(`The ${what} of ${move.from} stayed: ${move.to} has some of its own.`);
      };
      for (const kind of SIDECAR_KINDS) {
        if (!kind.appliesTo(fileType)) continue;
        const source = kind.filePath(notebook, from.pathParts);
        const destination = kind.filePath(notebook, to.pathParts);
        // Never over what the file found has, even if it saves one meanwhile.
        if (!(await pathExists(source))) continue;
        let went: boolean;
        try { went = await moveIntoPlace(source, destination); }
        catch (error) { if (!kind.cache) throw error; continue; }
        if (!kind.cache) place(SIDECAR_RECORDS[kind.id] ?? kind.id, went);
      }
      for (const entry of asides.get(move.from) ?? []) {
        const kind = SIDECAR_KINDS.find((candidate) => candidate.id === entry.kind);
        if (!kind?.appliesTo(fileType)) continue;
        const destination = kind.filePath(notebook, to.pathParts);
        if (entry.record === "ink") {
          const went = await moveIntoPlace(path.join(entry.at, "ink"), destination);
          if (went) await rm(entry.at, { recursive: true, force: true });
          place("ink set aside", went);
        } else {
          await mkdir(path.dirname(destination), { recursive: true });
          let went = true;
          try { await writeFile(destination, `${JSON.stringify(entry.sidecar, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; went = false; }
          if (went) await rm(entry.at, { force: true });
          place(`${entry.record} set aside`, went);
        }
      }
      if (fileType === "markdown") {
        const own = splitFilePath(pythonSidecarPath(move.to));
        if (!(await pathExists(filePathFromParts(own.notebook, own.pathParts)))) await movePythonSidecar(move.from, move.to);
      }
      // Nothing of it moved: all it had were side files, and each found its place taken.
      if (tried && !placed && move.records.every((record) => FILE_RECORDS.has(record))) continue;
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
      const { changed, failures } = await moveReferenceAttachmentsBatch(pairs);
      for (const failure of failures) problems.push(`Reference attachments in ${failure.notebook || "a library"} still point at the old paths.`);
      for (const library of changed) {
        try { publishReferenceEvent({ type: "library", notebook: library, revision: (await readReferenceLibrary(library)).revision }); }
        catch { /* The panel catches up when it next loads. */ }
      }
    });
    await step("The tethered .bib", async () => {
      for (const failure of await moveTetheredFilesBatch(pairs)) problems.push(`The tethered .bib file of ${failure.notebook} could not follow.`);
    });
    notifySearchChanges([...pairs.keys(), ...pairs.values()]);
  }
  return { notebook, moved, problems };
}
