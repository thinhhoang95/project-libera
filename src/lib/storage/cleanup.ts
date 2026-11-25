import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { hasReviewEntry, pruneReviews } from "@/lib/agent/review-store";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { pythonSidecarDocumentPath } from "@/lib/python/sidecar";
import { regenerateBibMirror } from "@/lib/references/bib-mirror";
import { untetherBibFile } from "@/lib/references/bib-tether";
import { MARKDOWN_ASSETS_DIR, ORPHANED_SIDECARS_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getFileType } from "@/lib/storage/file-types";
import { inkFolderPath } from "@/lib/storage/ink";
import { sharedMayClear, verifyNotebook, type CleanupAction, type IntegrityFinding, type IntegrityLimits } from "@/lib/storage/integrity";
import { readManifestView, type ManifestView } from "@/lib/storage/shared-manifest-view";
import { fileExistence } from "@/lib/storage/library-links";
import { rawEmbedsInOtherNotebooks, unreferencedMarkdownAssets } from "@/lib/storage/markdown-assets";
import { deleteReviewKey, findReview, reviewVersion } from "@/lib/storage/markdown-reviews";
import { assertSafeSegment, getAdminRoot, notebookPath, notebookSystemDirectoryPath, splitFilePath, withReadOnlyStorage } from "@/lib/storage/paths";
import { refreshNotebookCitations } from "@/lib/storage/reference-citations";
import { readReferenceLibrary, updateReferenceLibrary } from "@/lib/storage/references";
import { assertRepairable, planNotebookRepair, type RepairPlan } from "@/lib/storage/repair";
import { assertLifecycleReservation, withNotebookOperation } from "@/lib/storage/migration-fence";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "@/lib/storage/workspace-metadata";

// Check Notebook → Acknowledge: after Try to fix has found what it can, what
// the check still reports as stale is removed, so that checking again finds
// nothing stale. Stale is what the check marks with `clear` (integrity.ts):
// what is left of files that are gone (side files, set-aside side files,
// Python code, stars, tags, review comments, pending agent changes,
// reference attachments, the .bib tether), side files saved for another
// version of their file, images no note shows, and out-of-date caches and
// indexes. Some of it is what people made (annotations, ink, comments), so
// the dialog lists every item with what removing it costs, and asks for
// confirmation of what is lost for good.
//
// The plan is the check itself, so the two agree on what is stale. It is
// refused while Try to fix can still move records (they would be deleted
// instead of following their file). Applying runs the check again and is
// refused if the plan changed (a token that also names the version of each
// file it would remove: size and time). Right before each removal the same
// decisions are made again (`staleness`: the file is still gone, decided as
// the check does; `remove`: the file is still the version shown), and what
// can no longer be shown stale is held, not removed. Broken links, missing images and
// LaTeX files, unreadable or damaged files and unfinished migrations are not
// stale: they stay listed for you to set right. On a shared notebook only this
// computer's own records are removed (never what the host owns: ink,
// transcripts, live marks, Python code, the notebook's images), and a file is
// gone when the host's manifest does not list it, read again right before the
// removals; when the host can't confirm it, nothing is removed.
// Some things are never offered
// either: records Try to fix could not pair because several files have their
// file's name (they may belong to one of them) or because a store could not be
// read or two copies were set aside (each said as it is); records of a name a
// file with records of its own now has, unless the record names the bytes it
// was made for and no file has them; set-aside files whose record can't be
// read; and anything a check that ran only in part found (it can't tell what
// is stale).

/** One concrete record an item removes, and the file it was kept for (null when the record is not a file's own). */
export type CleanupEntry = { record: string; origin: string | null };
export type CleanupItem = {
  path: string;
  /** The finding, as the check put it. */
  message: string;
  /** What removing it costs, in the dialog's words. */
  consequence: string;
  /** Something people made is deleted for good. */
  lost: boolean;
  /** Every record the item removes, for the dialog to list (grouped when there are many). */
  entries: CleanupEntry[];
};
export type CleanupPlan = {
  notebook: string;
  items: CleanupItem[];
  /** Findings Acknowledge leaves: they need you, or clear themselves when the notebook is next opened. */
  remaining: number;
  /** Why some of them were left out, when it is not obvious. */
  notes: string[];
  token: string;
};
/** What happened to each action: removed, already absent, unreadable (could not be checked or removed) or held (no longer stale, or changed since it was shown). Only the first two count as done. */
export type CleanupOutcomes = { removed: number; alreadyAbsent: number; unreadable: number; held: number };
export type CleanupResult = { notebook: string; cleared: number; problems: string[]; outcomes: CleanupOutcomes };

/** For tests: the check's limits, to reproduce a check that could only partly run. */
export type CleanupOptions = { limits?: Partial<IntegrityLimits> };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Side files by kind: what they are called, and whether they are lost for good (people made them, or making them again loses corrections). */
const SIDE_FILES: Record<string, { what: string; lost: boolean }> = {
  "pdf-annotations": { what: "annotations", lost: true },
  "image-annotations": { what: "annotations", lost: true },
  ink: { what: "ink", lost: true },
  transcript: { what: "transcript", lost: true },
  "pdf-outline": { what: "outline", lost: false },
  definitions: { what: "definitions", lost: false },
  "pdf-text": { what: "PDF text cache", lost: false },
  "audio-peaks": { what: "waveform", lost: false },
};

/** What one finding's actions cost. */
function describe(actions: CleanupAction[]): { consequence: string; lost: boolean } {
  const first = actions[0];
  switch (first.type) {
    case "side-file": {
      const side = SIDE_FILES[first.kind] ?? { what: first.kind.replace(/-/g, " "), lost: true };
      if (first.kind === "pdf-text" || first.kind === "audio-peaks") return { consequence: `${plural(actions.length, side.what)} ${actions.length === 1 ? "is" : "are"} deleted; made again when needed.`, lost: false };
      if (!side.lost) return { consequence: `Its ${side.what} ${side.what.endsWith("s") ? "are" : "is"} deleted; ${side.what.endsWith("s") ? "they" : "it"} can be made again.`, lost: false };
      if (first.kind === "transcript") return { consequence: "Its transcript is deleted for good; transcribing again takes time and loses any corrections.", lost: true };
      if (first.kind === "ink") return { consequence: "All ink drawn on it is deleted for good.", lost: true };
      return { consequence: `Its ${side.what} ${side.what.endsWith("s") ? "are" : "is"} deleted for good.`, lost: true };
    }
    // Ink files of a page the file doesn't have, or drawn on another version of it: the finding says which.
    case "ink-files": return { consequence: `${plural(first.names.length, "ink file")} ${first.names.length === 1 ? "is" : "are"} deleted for good; the file's other ink is kept.`, lost: true };
    case "set-aside": return { consequence: `${plural(actions.length, "side file")} (annotations, outlines, definitions, ink) ${actions.length === 1 ? "is" : "are"} deleted for good: ${actions.length === 1 ? "it" : "they"} no longer come back with ${actions.length === 1 ? "its file" : "their files"}.`, lost: true };
    case "asset": return first.path.toLowerCase().endsWith(".py")
      ? { consequence: "The Python code is deleted for good.", lost: true }
      : { consequence: "The image is deleted for good. An open note that is not saved yet and shows it loses it.", lost: true };
    case "star": return { consequence: "The star is removed.", lost: false };
    case "tags": return { consequence: "Its tags are removed.", lost: false };
    case "review": return { consequence: "Its review comments are deleted for good.", lost: true };
    case "agent-review": return { consequence: "The agent's changes waiting for review are dropped for good.", lost: true };
    case "attachment": return { consequence: "It is detached from its references.", lost: false };
    case "tether": return { consequence: "The library is no longer tethered to a .bib file; the .bib file itself is not changed.", lost: false };
    case "bib-mirror": return { consequence: "references.bib is written again from the library.", lost: false };
    case "citations": return { consequence: "The citation index is brought up to date.", lost: false };
  }
}

const keyOf = (action: CleanupAction) => JSON.stringify(action);

/** A plain file or folder name, never a way out of its folder. */
function assertName(name: string) {
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) throw new StorageError(`"${name}" is not a file name.`, 400);
  return name;
}

/** A library path's parts inside `notebook`; anything else is refused. */
function partsIn(notebook: string, libraryPath: string) {
  const parsed = splitFilePath(libraryPath);
  if (parsed.notebook !== notebook) throw new StorageError(`${libraryPath} is not in ${notebook}.`, 400);
  return parsed.pathParts;
}

const setAsideRoot = (notebook: string) => path.join(notebookSystemDirectoryPath(notebook), ORPHANED_SIDECARS_DIR);
const setAsideFile = (notebook: string, file: string) => path.join(setAsideRoot(notebook), ...file.split("/").map(assertName));

/** The path a set-aside file was kept for, from its record; null when it has none, or the record can't be read (never a reason to delete the file). */
async function setAsideOrigin(notebook: string, file: string) {
  try {
    const parts = file.split("/").map(assertName);
    // Ink: a record next to an ink folder; the others: the record holds the side file.
    const record = parts[0] === "ink" && parts.length > 2 ? path.join(setAsideRoot(notebook), "ink", parts[1], "record.json") : path.join(setAsideRoot(notebook), ...parts);
    const { originalPath } = JSON.parse(await readFile(record, "utf8")) as { originalPath?: unknown };
    return typeof originalPath === "string" ? originalPath : null;
  } catch { return null; }
}

/** A set-aside ink folder is one unit: its record (which says whose ink it is) goes last, and only when its payload is gone. */
const inkUnit = (action: CleanupAction) => action.type === "set-aside" ? /^ink\/[^/]+\//.exec(action.file)?.[0] ?? null : null;
const isInkRecord = (action: CleanupAction) => action.type === "set-aside" && /^ink\/[^/]+\/record\.json$/.test(action.file);
const isImage = (action: CleanupAction) => action.type === "asset" && !action.path.toLowerCase().endsWith(".py");

function assetFile(notebook: string, libraryPath: string) {
  // Not through splitFilePath: user paths may not enter _assets (paths.ts), but these files live there.
  const prefix = `${notebook}/${MARKDOWN_ASSETS_DIR}/`;
  if (!libraryPath.startsWith(prefix)) throw new StorageError(`${libraryPath} is not a note's image or code.`, 400);
  return path.join(notebookPath(notebook), MARKDOWN_ASSETS_DIR, ...libraryPath.slice(prefix.length).split("/").map(assertName));
}

/** The files and folders on disk an action removes (what its version is read from). */
async function targetsOf(notebook: string, action: CleanupAction): Promise<string[]> {
  switch (action.type) {
    case "side-file": {
      const kind = SIDECAR_KINDS.find((candidate) => candidate.id === action.kind);
      if (!kind) throw new StorageError(`Unknown side file kind ${action.kind}.`, 400);
      return [kind.filePath(notebook, partsIn(notebook, action.filePath))];
    }
    case "ink-files": {
      const folder = inkFolderPath(notebook, partsIn(notebook, action.filePath));
      return action.names.map((name) => path.join(folder, assertName(name)));
    }
    case "set-aside": return [setAsideFile(notebook, action.file)];
    case "asset": return [assetFile(notebook, action.path)];
    default: return [];
  }
}

/** A path as it is now, in one string: size and time of a file, of every file in a folder; `absent`, or `unreadable:` and why. */
async function stampOf(target: string): Promise<string> {
  try {
    const info = await lstat(target);
    if (!info.isDirectory()) return `f:${info.size}:${info.mtimeMs}`;
    const lines: string[] = [];
    const walk = async (directory: string, prefix: string) => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${prefix}${entry.name}/`);
        else { const child = await lstat(path.join(directory, entry.name)); lines.push(`${prefix}${entry.name}:${child.size}:${child.mtimeMs}`); }
      }
    };
    await walk(target, "");
    return `d:${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 24)}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    return ["ENOENT", "ENOTDIR"].includes(code) ? "absent" : `unreadable:${code}`;
  }
}

/** What each action removes, as it was when the plan was made: the version the person reviewed. */
type Versions = Map<string, Map<string, string>>;
const reviewTarget = (libraryPath: string) => `review:${libraryPath}`;

async function versionOf(notebook: string, action: CleanupAction) {
  const found = new Map<string, string>();
  try {
    for (const target of await targetsOf(notebook, action)) found.set(target, await stampOf(target));
    // A review is one record in the review store, not a file of its own.
    if (action.type === "review") { const review = await findReview(action.path).catch(() => null); found.set(reviewTarget(action.path), review ? reviewVersion(review) : "none"); }
  } catch { /* An action that names nothing real is refused when it is performed. */ }
  return found;
}

type HoldReason = "ambiguous" | "own" | "unread" | "conflict" | "unattributed" | "back" | "alias" | "unchecked" | "tether" | "image-used" | "images-unscanned" | "shared";
type Hold = { reason: HoldReason; message: string };

/** What a library path physically opens, whatever spelling it is given (a disk that ignores case or Unicode form answers for an alias). */
async function physicalState(libraryPath: string): Promise<"file" | "folder" | "absent" | "unknown"> {
  const [owner, ...parts] = libraryPath.split("/");
  try {
    const info = await lstat(path.join(notebookPath(owner), ...parts.map(assertName)));
    return info.isDirectory() ? "folder" : "file";
  } catch (error) { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? "absent" : "unknown"; }
}

/**
 * Whether the file whose absence made a record stale is still gone, decided as
 * the check decides it (an exact name in its folder's listing, a file, never
 * `unknown`), so the plan and the removal agree. A name the disk opens for a
 * file spelled differently (case, Unicode form) is that file's, so it is kept,
 * not removed through the alias; a folder where the file was does not hold
 * the file's records back.
 */
async function goneHold(disk: ReturnType<typeof fileExistence>, libraryPath: string): Promise<Hold | null> {
  await disk.check([libraryPath]);
  if (disk.exists(libraryPath)) return { reason: "back", message: `${libraryPath} is there again; its records are kept.` };
  const unchecked: Hold = { reason: "unchecked", message: `${libraryPath} can't be checked (no permission, or a drive is offline); its records are kept.` };
  if (disk.unknown(libraryPath)) return unchecked;
  const physical = await physicalState(libraryPath);
  if (physical === "unknown") return unchecked;
  if (physical === "file") return { reason: "alias", message: `${libraryPath} opens a file under another spelling of its name (letter case or accents); its records are kept for that file.` };
  return null;
}

/** The shared version of "still gone": the host's manifest does not list the file (a copy left on the disk does not make it back; a listed file not yet delivered does). */
function sharedGoneHold(view: ManifestView, libraryPath: string): Hold | null {
  if (view.state !== "ok") return { reason: "unchecked", message: `The host can't confirm which files the shared notebook has (${view.reason}); the records of ${libraryPath} are kept.` };
  if (view.files.has(libraryPath)) return { reason: "back", message: `${libraryPath} is in the shared notebook; its records are kept.` };
  return null;
}

/** An absolute tether is stale only when its file is known to be missing from a folder that can be read. */
async function absoluteTetherHold(target: string): Promise<Hold | null> {
  const state = async (candidate: string) => lstat(candidate).then((info) => (info.isDirectory() ? "folder" : "file"), (error: NodeJS.ErrnoException) => (["ENOENT", "ENOTDIR"].includes(error.code ?? "") ? "absent" : "unknown"));
  const file = await state(target);
  if (file === "file" || file === "folder") return { reason: "tether", message: `${target} is there again; the tether is kept.` };
  const parent = await stat(path.dirname(target)).then((info) => (info.isDirectory() ? "folder" : "other"), (error: NodeJS.ErrnoException) => (["ENOENT", "ENOTDIR"].includes(error.code ?? "") ? "absent" : "unknown"));
  if (file === "unknown" || parent !== "folder") return { reason: "tether", message: `${target} is missing, but its folder can't be checked (it may be on a drive that is not connected); the tether is kept.` };
  return null;
}

/** Why an action is not stale (any more), or null: the one decision the plan and the removal share. */
async function staleness(notebook: string, action: CleanupAction, disk = fileExistence(), view: ManifestView | null = null): Promise<Hold | null> {
  if (view && !sharedMayClear(action, notebook)) return { reason: "shared", message: "The host keeps this in the shared notebook; it is kept." };
  const gone = (libraryPath: string) => view ? sharedGoneHold(view, libraryPath) : goneHold(disk, libraryPath);
  if (action.gone) { const hold = await gone(action.gone); if (hold) return hold; }
  if (action.type === "set-aside") {
    const origin = await setAsideOrigin(notebook, action.file);
    // A file whose record can't be read has no known owner: whether that file is back can't be told, so it is held, never removed.
    if (!origin) return { reason: "unattributed", message: `${action.file}: its record is missing or can't be read, so it can't be told what it was kept for; it is kept.` };
    return gone(origin);
  }
  if (action.type === "tether" && !action.gone) return absoluteTetherHold(action.target);
  return null;
}

/** The file whose records an action removes: the one whose absence made it stale. */
async function subjectOf(notebook: string, action: CleanupAction) {
  if (action.gone) return action.gone;
  switch (action.type) {
    case "set-aside": return setAsideOrigin(notebook, action.file);
    case "asset": return action.path.toLowerCase().endsWith(".py") ? pythonSidecarDocumentPath(action.path) : null;
    case "side-file": case "ink-files": return action.filePath;
    case "star": case "tags": case "review": case "agent-review": case "attachment": return action.path;
    default: return null;
  }
}

async function collect(notebook: string, repair: RepairPlan, options: CleanupOptions) {
  const report = await verifyNotebook(notebook, { limits: options.limits });
  // What a check that ran only in part found can't be told stale: a loop that protects records may not have run.
  const partial = new Set(report.checks.filter((check) => check.status === "incomplete" || check.status === "failed").map((check) => check.id));
  // Records of a name Try to fix did not pair though a file has the name, and why: several files have it (one of them may be the file; held), or the one file has records of its own
  // (`own`: stale when the record names the bytes it was made for and no file has them), or Try to fix could not read a store or found two copies (held, with that said).
  const named = new Map(repair.unmatched.filter((item) => item.candidates.length).map((item) => [item.from, item.reason] as const));
  const clearable: Array<IntegrityFinding & { clear: CleanupAction[] }> = [];
  const holds = new Map<HoldReason, number>();
  const hold = (reason: HoldReason) => holds.set(reason, (holds.get(reason) ?? 0) + 1);
  let heldPartial = 0;
  let reduced = 0;
  const disk = fileExistence();
  // A shared notebook: the host's manifest, read once for the plan.
  const view = isSharedNotebookPath(notebook) ? await readManifestView(notebook) : null;
  // Images are looked for in every notebook's notes by address too (the check's own scan sees relative embeds only); one scan, when there are images.
  let embeds: Set<string> | null | undefined;
  for (const finding of report.findings) {
    if (!finding.clear?.length) continue;
    if (partial.has(finding.check)) { heldPartial += 1; continue; }
    const clear: CleanupAction[] = [];
    for (const action of finding.clear) {
      const subject = named.size ? await subjectOf(notebook, action) : null;
      const why = subject ? named.get(subject) : undefined;
      if (why) {
        if (why === "own" && "identified" in action && action.identified) { /* the check found no file with the bytes it was made for: the file now called that is not its file */ }
        else { hold(why === "own" || why === "unread" || why === "conflict" ? why : "ambiguous"); continue; }
      }
      const stale = await staleness(notebook, action, disk, view);
      if (stale) { hold(stale.reason); continue; }
      if (isImage(action)) {
        if (embeds === undefined) embeds = await rawEmbedsInOtherNotebooks(notebook, { includeOwn: true });
        if (!embeds) { hold("images-unscanned"); continue; }
        if (embeds.has((action as { path: string }).path.toLowerCase())) { hold("image-used"); continue; }
      }
      clear.push(action);
    }
    if (clear.length < finding.clear.length) reduced += 1;
    if (clear.length) clearable.push({ ...finding, clear });
  }
  const actions = new Map<string, CleanupAction>();
  for (const finding of clearable) for (const action of finding.clear) actions.set(keyOf(action), action);
  // Each destructive action is tied to what it would remove as it is now: a file saved there since is another version.
  const versions: Versions = new Map();
  for (const [key, action] of actions) versions.set(key, await versionOf(notebook, action));
  const token = createHash("sha256").update(JSON.stringify([...actions.keys()].sort().map((key) => [key, [...versions.get(key)!].sort()]))).digest("hex").slice(0, 32);
  const notes: string[] = [];
  const count = (reason: HoldReason) => holds.get(reason) ?? 0;
  const them = (n: number) => (n === 1 ? "it" : "they");
  if (count("ambiguous")) notes.push(`${plural(count("ambiguous"), "record")} left out: more than one file has the name of the file ${count("ambiguous") === 1 ? "it was" : "they were"} kept for, so ${them(count("ambiguous"))} may belong to one of them.`);
  if (count("own")) notes.push(`${plural(count("own"), "record")} left out: a file now has the name of the file ${count("own") === 1 ? "it was" : "they were"} kept for and has records of its own, so Try to fix can't give ${them(count("own"))} to it, and it can't be told that ${them(count("own"))} ${count("own") === 1 ? "is" : "are"} not that file's.`);
  if (count("unread")) notes.push(`${plural(count("unread"), "record")} left out: some records could not be read, so it can't be ruled out that ${them(count("unread"))} belong${count("unread") === 1 ? "s" : ""} to a file that is there now.`);
  if (count("conflict")) notes.push(`${plural(count("conflict"), "record")} left out: more than one copy was set aside for the same file, and Try to fix can't choose between them. Keep the one you want, and remove the others by hand.`);
  if (count("unattributed")) notes.push(`${plural(count("unattributed"), "set-aside file")} left out: ${count("unattributed") === 1 ? "its record is" : "their records are"} missing or can't be read, so it can't be told what ${count("unattributed") === 1 ? "it was" : "they were"} kept for.`);
  if (heldPartial) notes.push(`${plural(heldPartial, "finding")} left out: a check that ran only in part can't tell what is stale.`);
  // A check the budget kept from starting has no findings to hold back; the plan still says it is not the whole picture.
  else if (partial.size) notes.push(`${plural(partial.size, "check")} ran only in part, so what ${partial.size === 1 ? "it" : "they"} could not look at is not offered.`);
  const aliased = count("alias") + count("back");
  if (aliased) notes.push(`${plural(aliased, "record")} left out: a file is there under another spelling of the name (letter case or accents) or has come back, so ${them(aliased)} may be its own.`);
  if (count("unchecked")) notes.push(`${plural(count("unchecked"), "record")} left out: whether the file is back can't be checked (no permission, or a drive is offline).`);
  if (count("shared")) notes.push(`${plural(count("shared"), "record")} left out: the host keeps ${count("shared") === 1 ? "it" : "them"} in the shared notebook.`);
  if (count("tether")) notes.push("The .bib tether is left out: its file is there, or its folder can't be checked (it may be on a drive that is not connected).");
  if (count("image-used")) notes.push(`${plural(count("image-used"), "image")} left out: a note shows ${count("image-used") === 1 ? "it" : "them"} by address.`);
  if (count("images-unscanned")) notes.push(`${plural(count("images-unscanned"), "image")} left out: the notes of every notebook could not be read, so use of ${count("images-unscanned") === 1 ? "it" : "them"} can't be ruled out.`);
  const remaining = report.findings.length - clearable.length + reduced;
  return { report, clearable, actions: [...actions.values()], versions, token, remaining, notes };
}

/** What Try to fix can still move, which Acknowledge would delete instead; returns what it could not pair. */
async function assertNothingToMove(notebook: string) {
  const repair = await planNotebookRepair(notebook);
  const { moves } = repair;
  if (moves.length) {
    const named = moves.slice(0, 3).map((move) => `${move.from} -> ${move.to}`).join(", ");
    throw new StorageError(`Try to fix can still give ${plural(moves.length, "moved file")} ${moves.length === 1 ? "its" : "their"} records back (${named}${moves.length > 3 ? ", ..." : ""}). Use Try to fix first, so they are not deleted. If it can't move them, fix what it reports first.`, 409);
  }
  return repair;
}

/** A path on disk as the dialog shows it: in the notebook, or in the library's data folder. */
function shown(notebook: string, absolute: string) {
  for (const [root, prefix] of [[notebookPath(notebook), notebook], [getAdminRoot(), ""]] as const) {
    const relative = path.relative(root, absolute);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return [prefix, ...relative.split(path.sep)].filter(Boolean).join("/");
  }
  return absolute;
}

/** Each concrete record an action removes, and the file it was kept for: what the person confirms. */
async function entriesOf(notebook: string, action: CleanupAction): Promise<CleanupEntry[]> {
  try {
    switch (action.type) {
      case "side-file": return [{ record: shown(notebook, (await targetsOf(notebook, action))[0]), origin: action.filePath }];
      case "ink-files": return (await targetsOf(notebook, action)).map((target) => ({ record: shown(notebook, target), origin: action.filePath }));
      case "set-aside": return [{ record: shown(notebook, setAsideFile(notebook, action.file)), origin: await setAsideOrigin(notebook, action.file) }];
      case "asset": return [{ record: action.path, origin: pythonSidecarDocumentPath(action.path) ?? null }];
      case "star": case "tags": case "review": case "agent-review": case "attachment": return [{ record: action.path, origin: null }];
      case "tether": return [{ record: action.target, origin: null }];
      default: return [];
    }
  } catch { return []; }
}

/** What Acknowledge would remove, and what each costs. Reads only, from the first guard on (paths.ts withReadOnlyStorage). */
export function planNotebookCleanup(name: string, options: CleanupOptions = {}): Promise<CleanupPlan> {
  return withReadOnlyStorage(async () => {
    const notebook = assertRepairable(name);
    // A shared notebook's pending record moves were applied by the cleanup route before this plan (settleSharedRecordsBeforeCheck).
    const { clearable, token, remaining, notes } = await collect(notebook, await assertNothingToMove(notebook), options);
    return {
      notebook,
      items: await Promise.all(clearable.map(async (finding) => ({
        path: finding.path,
        message: finding.message,
        ...describe(finding.clear),
        entries: (await Promise.all(finding.clear.map((action) => entriesOf(notebook, action)))).flat(),
      }))),
      remaining,
      notes,
      token,
    };
  });
}

type Outcome = "removed" | "absent" | "unreadable" | "held";

/**
 * Whether a removal's folder is, once links and junctions are followed, inside
 * the notebook or its system folder: a link planted in .libera must not lead a
 * delete elsewhere (refused). `absent` when the folder is gone; `unreadable`
 * when it can't be told (permissions), which is never a reason to say done.
 */
async function containment(notebook: string, target: string): Promise<"inside" | "absent" | "unreadable"> {
  let parent: string;
  try { parent = await realpath(path.dirname(target)); }
  catch (error) { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? "absent" : "unreadable"; }
  const roots = await Promise.all([notebookPath(notebook), notebookSystemDirectoryPath(notebook)].map((root) => realpath(root).catch(() => null)));
  const inside = roots.some((root) => root && (parent === root || parent.startsWith(`${root}${path.sep}`)));
  if (!inside) throw new StorageError(`${target} is outside the notebook once links are followed; it is left alone.`, 400);
  return "inside";
}

/**
 * Removes one path if it is still what the plan showed (`expected`) and still
 * stale (`recheck`): both decided as late as possible, right before the
 * removal, so a file saved there since, or an owner that came back, is kept.
 */
async function remove(notebook: string, target: string, expected: string | undefined, recheck: () => Promise<Hold | null>, options: { recursive?: boolean } = {}): Promise<Outcome> {
  const where = await containment(notebook, target);
  if (where !== "inside") return where;
  const hold = await recheck();
  if (hold) throw new NoLongerStale(hold.message);
  const now = await stampOf(target);
  if (now === "absent") return "absent";
  if (now.startsWith("unreadable")) return "unreadable";
  if (expected !== undefined && now !== expected) throw new NoLongerStale(`${shown(notebook, target)} changed since it was shown; it is kept.`);
  await rm(target, { force: true, recursive: options.recursive ?? false });
  return "removed";
}

/** The outcome of several removals as one: any that could not be read counts, then any removed. */
const combine = (outcomes: Outcome[]): Outcome => outcomes.includes("unreadable") ? "unreadable" : outcomes.includes("removed") ? "removed" : "absent";

/** Empty folders left in _assets once their last file is gone. */
async function removeEmptyParents(file: string, stop: string) {
  for (let directory = path.dirname(file); directory.startsWith(`${stop}${path.sep}`); directory = path.dirname(directory)) {
    if ((await readdir(directory).catch(() => ["?"])).length) return;
    await rmdir(directory).catch(() => undefined);
  }
}

/** An action left alone because what made it stale is no longer so. */
class NoLongerStale extends Error {}

/** Images that no note shows, as the notes are now: read once, as late as the removals allow. */
type FreshImages = { unused: Set<string>; embeds: Set<string> } | null;
type Context = { versions: Versions; images: () => Promise<FreshImages>; /** A shared notebook's manifest as the host gave it right before the removals. */ view: ManifestView | null };

async function perform(notebook: string, action: CleanupAction, context: Context): Promise<Outcome> {
  // Checked right before acting: a file put back since the check keeps its records.
  const hold = await staleness(notebook, action, undefined, context.view);
  if (hold) throw new NoLongerStale(hold.message);
  const expected = context.versions.get(keyOf(action));
  const recheck = () => staleness(notebook, action, undefined, context.view);
  const version = (target: string) => expected?.get(target);
  switch (action.type) {
    case "side-file": {
      const [target] = await targetsOf(notebook, action);
      const kind = SIDECAR_KINDS.find((candidate) => candidate.id === action.kind)!;
      return remove(notebook, target, version(target), recheck, { recursive: kind.layout === "folder" });
    }
    case "ink-files": {
      const outcomes: Outcome[] = [];
      for (const target of await targetsOf(notebook, action)) outcomes.push(await remove(notebook, target, version(target), recheck));
      return combine(outcomes);
    }
    case "set-aside": {
      const [file] = await targetsOf(notebook, action);
      const outcome = await remove(notebook, file, version(file), recheck);
      // Ink is set aside as a folder: its emptied folder goes once its last file does.
      if (outcome === "removed") await removeEmptyParents(file, path.join(setAsideRoot(notebook), action.file.split("/")[0]));
      return outcome;
    }
    case "asset": {
      const [file] = await targetsOf(notebook, action);
      if (isImage(action)) {
        // A note saved since the plan may show it now (or an address in another notebook's note): looked at again, not trusted from the plan.
        const fresh = await context.images();
        if (!fresh) throw new NoLongerStale(`${action.path}: the notes could not all be read, so it can't be ruled out that one shows it; it is kept.`);
        const key = action.path.toLowerCase();
        if (fresh.embeds.has(key) || !fresh.unused.has(key)) throw new NoLongerStale(`${action.path} is shown by a note now; it is kept.`);
      }
      const outcome = await remove(notebook, file, version(file), recheck);
      if (outcome === "removed") await removeEmptyParents(file, path.join(notebookPath(notebook), MARKDOWN_ASSETS_DIR));
      return outcome;
    }
    case "star": {
      partsIn(notebook, action.path);
      if (!(await readWorkspaceMetadata()).starredFilePaths.includes(action.path)) return "absent";
      await setStarredFilePath(action.path, false);
      return "removed";
    }
    case "tags": {
      partsIn(notebook, action.path);
      if (!(await readWorkspaceMetadata()).fileTags[action.path]) return "absent";
      await setFileTagsForPath(action.path, []);
      return "removed";
    }
    case "review": {
      partsIn(notebook, action.path);
      // Exactly this path: a folder of the same name made since keeps its files' reviews. Compared and removed in one transaction.
      const result = await deleteReviewKey(action.path, expected?.get(reviewTarget(action.path)) === "none" ? "" : expected?.get(reviewTarget(action.path)));
      if (result === "changed") throw new NoLongerStale(`The review comments of ${action.path} changed since they were shown; they are kept.`);
      return result === "removed" ? "removed" : "absent";
    }
    case "agent-review": {
      partsIn(notebook, action.path);
      if (!(await hasReviewEntry(action.path))) return "absent";
      await pruneReviews([action.path]);
      // The store drops an entry only when it is settled; one it keeps was not removed.
      if (await hasReviewEntry(action.path)) throw new NoLongerStale(`The agent's changes to ${action.path} are still waiting for review; they are kept.`);
      return "removed";
    }
    case "attachment": {
      // This attachment of this reference only, in the library that shows it (which may be another notebook's).
      const library = await readReferenceLibrary(assertSafeSegment(action.library, "Notebook name"));
      const entry = library.entries[action.entry];
      if (!entry?.attachments.some((attachment) => attachment.kind !== "url" && attachment.path === action.path)) return "absent";
      await updateReferenceLibrary(action.library, library.revision, [{ op: "detach", id: entry.id, attachment: { kind: getFileType(action.path) === "markdown" ? "markdown" : "pdf", path: action.path } }]);
      return "removed";
    }
    case "tether": {
      // Compared and removed under the tether's own lock: another window's change in between is kept, and so is a file that is back.
      let seen = "other" as "none" | "other" | "same";
      const removed = await untetherBibFile(notebook, async (tether) => {
        if (!tether) { seen = "none"; return false; }
        const current = "libraryPath" in tether ? tether.libraryPath : tether.absolutePath;
        if (current !== action.target) return false;
        seen = "same";
        return (await staleness(notebook, action, undefined, context.view)) === null;
      });
      if (removed) return "removed";
      if (seen === "none") return "absent";
      throw new NoLongerStale(seen === "other" ? "The library was tethered to another .bib file since the check; the tether is kept." : `${action.target} is there again, or can't be checked; the tether is kept.`);
    }
    case "bib-mirror": await regenerateBibMirror(notebook, await readReferenceLibrary(notebook)); return "removed";
    // With the archive in the walk: a hidden archive keeps its old entries, and the finding is about them too.
    case "citations": await refreshNotebookCitations(notebook, { includeArchive: true }); return "removed";
  }
}

const label = (action: CleanupAction) => "path" in action ? action.path : "filePath" in action ? action.filePath : action.type;

/** Removes what the plan the token names listed; planned again first, and refused if anything changed since. */
export const applyNotebookCleanup = (name: string, token: string, options: CleanupOptions = {}): Promise<CleanupResult> => withNotebookOperation(name, () => applyCleanup(name, token, options));

async function applyCleanup(name: string, token: string, options: CleanupOptions): Promise<CleanupResult> {
  const notebook = assertRepairable(name);
  const { listInterruptedMigrations } = await import("@/lib/storage/migration");
  if ((await listInterruptedMigrations()).some((migration) => migration.source === notebook || migration.destination.notebook === notebook)) {
    throw new StorageError("A migration involving this notebook did not finish. Finish or stop it in Migration first.", 409);
  }
  const current = await collect(notebook, await assertNothingToMove(notebook), options);
  if (current.token !== token) throw new StorageError("The notebook changed since this was prepared. Check it again.", 409);

  // Right before the removals the host's manifest is read again: what is removed was decided against this view, and with none nothing is removed.
  let view: ManifestView | null = null;
  if (isSharedNotebookPath(notebook)) {
    view = await readManifestView(notebook);
    if (view.state !== "ok") throw new StorageError(`The host can't confirm which files ${notebook} has right now (${view.reason}), so nothing was removed. Try again when collaboration is connected.`, 409);
  }
  const problems: string[] = [];
  const done = new Set<string>();
  const outcomes = { removed: 0, alreadyAbsent: 0, unreadable: 0, held: 0 };
  let fresh: Promise<FreshImages> | null = null;
  const context: Context = {
    view,
    versions: current.versions,
    images: () => fresh ??= (async () => {
      const unused = await unreferencedMarkdownAssets(notebook);
      const embeds = await rawEmbedsInOtherNotebooks(notebook, { includeOwn: true });
      return unused && embeds ? { unused: new Set(unused.map((asset) => asset.toLowerCase())), embeds } : null;
    })(),
  };
  // Images last, so the notes are read as late as possible; an ink folder's record after its payload.
  const rank = (action: CleanupAction) => isImage(action) ? 2 : isInkRecord(action) ? 1 : 0;
  const ordered = [...current.actions].sort((a, b) => rank(a) - rank(b));
  // An ink folder is one unit. Its owner back, or a page changed, holds all of it; a page that could not be removed keeps only its record.
  const held = new Map<string, string>();
  const incomplete = new Set<string>();
  for (const action of ordered) {
    // A share that took the notebook over since this run began stops it before it removes anything more.
    assertLifecycleReservation();
    const unit = inkUnit(action);
    try {
      if (unit && !held.has(unit) && !isInkRecord(action)) { const hold = await staleness(notebook, action, undefined, view); if (hold) held.set(unit, hold.message); }
      if (unit && held.has(unit)) throw new NoLongerStale(held.get(unit)!);
      if (unit && isInkRecord(action) && incomplete.has(unit)) throw new NoLongerStale("Part of this ink could not be removed, so the record that says whose it is stays.");
      const outcome = await perform(notebook, action, context);
      if (outcome === "removed") outcomes.removed += 1;
      else if (outcome === "absent") outcomes.alreadyAbsent += 1;
      else { outcomes.unreadable += 1; problems.push(`${label(action)}: could not be read, so it was not removed.`); if (unit) incomplete.add(unit); }
      if (outcome === "removed" || outcome === "absent") done.add(keyOf(action));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${label(action)}: ${message}`);
      if (error instanceof NoLongerStale) { outcomes.held += 1; if (unit && !held.has(unit)) held.set(unit, message); }
      else { outcomes.unreadable += 1; if (unit) incomplete.add(unit); }
    }
  }
  const touched = current.actions.flatMap((action) => "path" in action ? [action.path] : "filePath" in action ? [action.filePath] : []);
  if (touched.length) notifySearchChanges(touched);
  const cleared = current.clearable.filter((finding) => finding.clear.every((action) => done.has(keyOf(action)))).length;
  return { notebook, cleared, problems, outcomes };
}
