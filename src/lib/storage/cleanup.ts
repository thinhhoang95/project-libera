import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { pruneReviews } from "@/lib/agent/review-store";
import { regenerateBibMirror } from "@/lib/references/bib-mirror";
import { readTetherTarget, untetherBibFile } from "@/lib/references/bib-tether";
import { MARKDOWN_ASSETS_DIR, ORPHANED_SIDECARS_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getFileType } from "@/lib/storage/file-types";
import { inkFolderPath } from "@/lib/storage/ink";
import { verifyNotebook, type CleanupAction, type IntegrityFinding } from "@/lib/storage/integrity";
import { deleteReviewKey } from "@/lib/storage/markdown-reviews";
import { assertSafeSegment, notebookPath, notebookSystemDirectoryPath, splitFilePath, withReadOnlyStorage } from "@/lib/storage/paths";
import { refreshNotebookCitations } from "@/lib/storage/reference-citations";
import { readReferenceLibrary, updateReferenceLibrary } from "@/lib/storage/references";
import { assertRepairable, planNotebookRepair } from "@/lib/storage/repair";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { setFileTagsForPath, setStarredFilePath } from "@/lib/storage/workspace-metadata";

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
// refused if the plan changed (a token). Broken links, missing images and
// LaTeX files, unreadable or damaged files and unfinished migrations are not
// stale: they stay listed for you to set right.

export type CleanupItem = {
  path: string;
  /** The finding, as the check put it. */
  message: string;
  /** What removing it costs, in the dialog's words. */
  consequence: string;
  /** Something people made is deleted for good. */
  lost: boolean;
};
export type CleanupPlan = { notebook: string; items: CleanupItem[]; /** Findings Acknowledge leaves: they need you, or clear themselves when the notebook is next opened. */ remaining: number; token: string };
export type CleanupResult = { notebook: string; cleared: number; problems: string[] };

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
    case "ink-files": return { consequence: `${plural(first.names.length, "ink file")} that ${first.names.length === 1 ? "is" : "are"} never shown ${first.names.length === 1 ? "is" : "are"} deleted for good.`, lost: true };
    case "set-aside": return { consequence: `${plural(actions.length, "side file")} (annotations, outlines, definitions) ${actions.length === 1 ? "is" : "are"} deleted for good: ${actions.length === 1 ? "it" : "they"} no longer come back with ${actions.length === 1 ? "its file" : "their files"}.`, lost: true };
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

async function collect(notebook: string) {
  const report = await verifyNotebook(notebook);
  const clearable = report.findings.filter((finding): finding is IntegrityFinding & { clear: CleanupAction[] } => !!finding.clear?.length);
  const actions = new Map<string, CleanupAction>();
  for (const finding of clearable) for (const action of finding.clear) actions.set(keyOf(action), action);
  const token = createHash("sha256").update(JSON.stringify([...actions.keys()].sort())).digest("hex").slice(0, 32);
  return { report, clearable, actions: [...actions.values()], token };
}

async function assertNothingToMove(notebook: string) {
  const { moves } = await planNotebookRepair(notebook);
  if (moves.length) throw new StorageError(`Try to fix can still give ${plural(moves.length, "moved file")} ${moves.length === 1 ? "its" : "their"} records back. Use Try to fix first, so they are not deleted.`, 409);
}

/** What Acknowledge would remove, and what each costs. Reads only, from the first guard on (paths.ts withReadOnlyStorage). */
export function planNotebookCleanup(name: string): Promise<CleanupPlan> {
  return withReadOnlyStorage(async () => {
    const notebook = assertRepairable(name);
    await assertNothingToMove(notebook);
    const { report, clearable, token } = await collect(notebook);
    return {
      notebook,
      items: clearable.map((finding) => ({ path: finding.path, message: finding.message, ...describe(finding.clear) })),
      remaining: report.findings.length - clearable.length,
      token,
    };
  });
}

/** A library path's parts inside `notebook`; anything else is refused. */
function partsIn(notebook: string, libraryPath: string) {
  const parsed = splitFilePath(libraryPath);
  if (parsed.notebook !== notebook) throw new StorageError(`${libraryPath} is not in ${notebook}.`, 400);
  return parsed.pathParts;
}

/** A plain file or folder name, never a way out of its folder. */
function assertName(name: string) {
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) throw new StorageError(`"${name}" is not a file name.`, 400);
  return name;
}

/** Whether a library path is there: `unknown` (no permission, a drive offline) never counts as gone. */
async function presence(libraryPath: string): Promise<"present" | "absent" | "unknown"> {
  const [owner, ...parts] = libraryPath.split("/");
  try { await lstat(path.join(notebookPath(owner), ...parts.map(assertName))); return "present"; }
  catch (error) { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? "absent" : "unknown"; }
}

/**
 * Refuses a removal whose folder is not, once links and junctions are
 * followed, inside the notebook or its system folder: a link planted in
 * .libera must not lead a delete elsewhere. False when the folder is gone
 * (nothing to remove).
 */
async function contained(notebook: string, target: string) {
  const parent = await realpath(path.dirname(target)).catch(() => null);
  if (!parent) return false;
  const roots = await Promise.all([notebookPath(notebook), notebookSystemDirectoryPath(notebook)].map((root) => realpath(root).catch(() => null)));
  const inside = roots.some((root) => root && (parent === root || parent.startsWith(`${root}${path.sep}`)));
  if (!inside) throw new StorageError(`${target} is outside the notebook once links are followed; it is left alone.`, 400);
  return true;
}

async function remove(notebook: string, target: string, options: { recursive?: boolean } = {}) {
  if (await contained(notebook, target)) await rm(target, { force: true, recursive: options.recursive ?? false });
}

/** Empty folders left in _assets once their last file is gone. */
async function removeEmptyParents(file: string, stop: string) {
  for (let directory = path.dirname(file); directory.startsWith(`${stop}${path.sep}`); directory = path.dirname(directory)) {
    if ((await readdir(directory).catch(() => ["?"])).length) return;
    await rmdir(directory).catch(() => undefined);
  }
}

/** An action left alone because what made it stale is no longer so. */
class NoLongerStale extends Error {}

async function perform(notebook: string, action: CleanupAction) {
  // Checked right before acting: a file put back since the check keeps its records.
  if (action.gone && (await presence(action.gone)) !== "absent") throw new NoLongerStale(`${action.gone} is there again (or can't be checked); its records are kept.`);
  switch (action.type) {
    case "side-file": {
      const kind = SIDECAR_KINDS.find((candidate) => candidate.id === action.kind);
      if (!kind) throw new StorageError(`Unknown side file kind ${action.kind}.`, 400);
      await remove(notebook, kind.filePath(notebook, partsIn(notebook, action.filePath)), { recursive: kind.layout === "folder" });
      return;
    }
    case "ink-files": {
      const folder = inkFolderPath(notebook, partsIn(notebook, action.filePath));
      for (const name of action.names) await remove(notebook, path.join(folder, assertName(name)));
      return;
    }
    case "set-aside": {
      const root = path.join(notebookSystemDirectoryPath(notebook), ORPHANED_SIDECARS_DIR);
      await remove(notebook, path.join(root, ...action.file.split("/").map(assertName)));
      return;
    }
    case "asset": {
      // Not through splitFilePath: user paths may not enter _assets (paths.ts), but these files live there.
      const prefix = `${notebook}/${MARKDOWN_ASSETS_DIR}/`;
      if (!action.path.startsWith(prefix)) throw new StorageError(`${action.path} is not a note's image or code.`, 400);
      const assets = path.join(notebookPath(notebook), MARKDOWN_ASSETS_DIR);
      const file = path.join(assets, ...action.path.slice(prefix.length).split("/").map(assertName));
      await remove(notebook, file);
      await removeEmptyParents(file, assets);
      return;
    }
    case "star": partsIn(notebook, action.path); await setStarredFilePath(action.path, false); return;
    case "tags": partsIn(notebook, action.path); await setFileTagsForPath(action.path, []); return;
    // Exactly this path: a folder of the same name made since keeps its files' reviews.
    case "review": partsIn(notebook, action.path); await deleteReviewKey(action.path); return;
    case "agent-review": partsIn(notebook, action.path); await pruneReviews([action.path]); return;
    case "attachment": {
      // This attachment of this reference only, in the library that shows it (which may be another notebook's).
      const library = await readReferenceLibrary(assertSafeSegment(action.library, "Notebook name"));
      const entry = library.entries[action.entry];
      if (!entry?.attachments.some((attachment) => attachment.kind !== "url" && attachment.path === action.path)) return;
      await updateReferenceLibrary(action.library, library.revision, [{ op: "detach", id: entry.id, attachment: { kind: getFileType(action.path) === "markdown" ? "markdown" : "pdf", path: action.path } }]);
      return;
    }
    case "tether": {
      const tether = await readTetherTarget(notebook);
      const current = tether && "libraryPath" in tether ? tether.libraryPath : tether && "absolutePath" in tether ? tether.absolutePath : null;
      if (current !== action.target) throw new NoLongerStale("The library was tethered to another .bib file since the check; the tether is kept.");
      await untetherBibFile(notebook);
      return;
    }
    case "bib-mirror": await regenerateBibMirror(notebook, await readReferenceLibrary(notebook)); return;
    case "citations": await refreshNotebookCitations(notebook); return;
  }
}

const label = (action: CleanupAction) => "path" in action ? action.path : "filePath" in action ? action.filePath : action.type;

/** Removes what the plan the token names listed; planned again first, and refused if anything changed since. */
export async function applyNotebookCleanup(name: string, token: string): Promise<CleanupResult> {
  const notebook = assertRepairable(name);
  const { listInterruptedMigrations } = await import("@/lib/storage/migration");
  if ((await listInterruptedMigrations()).some((migration) => migration.source === notebook || migration.destination.notebook === notebook)) {
    throw new StorageError("A migration involving this notebook did not finish. Finish or stop it in Migration first.", 409);
  }
  await assertNothingToMove(notebook);
  const current = await collect(notebook);
  if (current.token !== token) throw new StorageError("The notebook changed since this was prepared. Check it again.", 409);

  const problems: string[] = [];
  const done = new Set<string>();
  for (const action of current.actions) {
    try { await perform(notebook, action); done.add(keyOf(action)); }
    catch (error) { problems.push(`${label(action)}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const touched = current.actions.flatMap((action) => "path" in action ? [action.path] : "filePath" in action ? [action.filePath] : []);
  if (touched.length) notifySearchChanges(touched);
  const cleared = current.clearable.filter((finding) => finding.clear.every((action) => done.has(keyOf(action)))).length;
  return { notebook, cleared, problems };
}
