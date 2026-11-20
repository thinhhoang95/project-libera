import { canEditSharedContent, listSharedEntries, readSharedEntryBytes, readSharedText, writeSharedText } from "@/lib/collab/shared-writes";
import type { FileListEntry } from "@/lib/collab/local-api";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { applyPathEdits, movedPathEdits, type MovedPathRewrite } from "@/lib/move-rewrites";
import { MARKDOWN_ASSETS_DIR, MARKDOWN_EXTENSIONS } from "@/lib/storage/constants";
import {
  applyMovedLinks,
  diskLinkSource,
  followLinkRewrites,
  hashText,
  planMovedLinks,
  replanMovedNote,
  type AppliedLinkRewrite,
  type LinkSource,
  type PathMove,
  type PlannedLinkRewrite,
} from "@/lib/storage/move-links";
import { getFileType } from "@/lib/storage/file-types";
import { readNotebookLinkIndex } from "@/lib/storage/library-links";
import type { LiberaLinkRewrites, LiberaLinkSkipReason } from "@/lib/types";

// Links follow a move inside a shared notebook as they follow a local one
// (docs/features/move-link-refactor.md, "Shared notebooks"), with three
// differences: the plan is made against the layout the host committed (its
// manifest, not the working copy on disk, which can lag); a shared note's text
// is read from the host and changes only through it, with the text just read
// as a precondition; a note this account cannot edit is reported, not written.
// Local notes (in this notebook's neighbours) are written on disk as a local
// move writes them, and a shared note linking out follows the same rules.

type Skip = LiberaLinkRewrites["skipped"][number];

const HIDDEN_FOLDERS = new Set([MARKDOWN_ASSETS_DIR, "node_modules", "__pycache__", "bower_components"]);
const READS_AT_ONCE = 8;

const notebookOf = (libraryPath: string) => libraryPath.split("/")[0];
const sharedIn = (libraryPath: string) => isSharedNotebookPath(libraryPath);

/** The disk for local notebooks, the host's manifest and live text for shared ones. */
function sharedLinkSource(): LinkSource {
  const disk = diskLinkSource();
  const listings = new Map<string, Promise<FileListEntry[]>>();
  const entriesOf = (notebook: string) => {
    if (!listings.has(notebook)) listings.set(notebook, listSharedEntries(notebook));
    return listings.get(notebook)!;
  };
  const files = new Map<string, Set<string>>();
  const existence: LinkSource["existence"] = {
    async check(libraryPaths) {
      const local: string[] = [];
      for (const libraryPath of libraryPaths) {
        const notebook = notebookOf(libraryPath);
        if (!sharedIn(notebook)) { local.push(libraryPath); continue; }
        if (!files.has(notebook)) files.set(notebook, new Set((await entriesOf(notebook)).filter((entry) => entry.kind !== "folder").map((entry) => entry.path)));
      }
      await disk.existence.check(local);
    },
    exists: (libraryPath) => sharedIn(notebookOf(libraryPath)) ? files.get(notebookOf(libraryPath))?.has(libraryPath) ?? false : disk.existence.exists(libraryPath),
  };
  const textOf = async (entry: FileListEntry) => {
    if (entry.kind === "doc") return (await readSharedText(entry.path)).text;
    const bytes = await readSharedEntryBytes(entry);
    if (!bytes) throw new Error(`${entry.path} could not be read.`);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${entry.path} is not UTF-8 text.`);
    return text;
  };
  return {
    existence,
    async documents(notebook, hint) {
      if (!sharedIn(notebook)) return disk.documents(notebook, hint);
      // Candidates first, from the notebook's link index (no note is read for it): a note is fetched from the host only when it moved, is not indexed yet,
      // or lists a destination that names a moved item (or could spell one). Chart data files are not in the index: moving one reads every note.
      const index = await readNotebookLinkIndex(notebook);
      const charts = hint.names.some((name) => /\.(csv|tsv)$/i.test(name));
      const candidate = (file: string) => {
        if (hint.was(file) !== file || charts) return true;
        const destinations = index[file];
        return !destinations || destinations.some((href) => /[%&\\]/.test(href) || hint.names.some((name) => href.includes(name)));
      };
      const entries = (await entriesOf(notebook)).filter((entry) =>
        candidate(entry.path) &&
        entry.kind !== "folder"
        && MARKDOWN_EXTENSIONS.has(entry.path.slice(entry.path.lastIndexOf(".")).toLowerCase())
        && !entry.path.split("/").slice(1).some((part) => part.startsWith(".") || HIDDEN_FOLDERS.has(part)));
      const documents: { documentPath: string; content: string }[] = [];
      let complete = true;
      for (let index = 0; index < entries.length; index += READS_AT_ONCE) {
        await Promise.all(entries.slice(index, index + READS_AT_ONCE).map(async (entry) => {
          try { documents.push({ documentPath: entry.path, content: await textOf(entry) }); }
          catch (error) { console.error(`[shared-move-links] Could not read ${entry.path}:`, error); complete = false; }
        }));
      }
      return { documents, complete };
    },
    async files(notebook) {
      if (!sharedIn(notebook)) return disk.files(notebook);
      return { files: (await entriesOf(notebook)).filter((entry) => entry.kind !== "folder" && getFileType(entry.path.split("/").at(-1)!)).map((entry) => entry.path), truncated: false };
    },
    async read(libraryPath) {
      if (!sharedIn(libraryPath)) return disk.read(libraryPath);
      const entry = (await entriesOf(notebookOf(libraryPath))).find((candidate) => candidate.path === libraryPath);
      return entry ? textOf(entry) : (await readSharedText(libraryPath)).text;
    },
  };
}

const skipsOf = (note: PlannedLinkRewrite, reason: LiberaLinkSkipReason): Skip[] =>
  Object.values(note.rewrite).flatMap((map) => Object.keys(map ?? {})).map((written) => ({ path: note.path, written, reason }));

/**
 * Writes each planned shared note through the host: its text read now, the
 * rewrite (planned afresh when the text is not what was planned) applied to
 * it, and written only if the text is still the one just read. A note that
 * changed again is read and planned once more, then reported (`edited`).
 */
async function applySharedNotes(notes: readonly PlannedLinkRewrite[], replan: (text: string, note: PlannedLinkRewrite) => Promise<MovedPathRewrite>) {
  const applied: AppliedLinkRewrite[] = [];
  const skipped: Skip[] = [];
  for (const note of notes) {
    const from = note.from ? { from: note.from } : {};
    try {
      for (let attempt = 0; ; attempt += 1) {
        const { doc, text } = await readSharedText(note.path);
        if (!canEditSharedContent(doc)) { skipped.push(...skipsOf(note, "read-only")); break; }
        const hash = hashText(text);
        // Already at the rewritten text (a collaborator, or an earlier run of this step): nothing to write.
        if (hash === note.after) break;
        const rewrite = hash === note.before ? note.rewrite : await replan(text, note);
        const edits = movedPathEdits(text, note.path, rewrite);
        if (!edits.length) break;
        const next = applyPathEdits(text, edits);
        const result = await writeSharedText(note.path, next, { source: "system" }, { doc, expectedBefore: text });
        if (result.conflict) {
          if (attempt >= 1) skipped.push(...skipsOf({ ...note, rewrite }, "edited"));
          else continue;
          break;
        }
        if (result.applied) applied.push({ path: note.path, ...from, rewrite, before: hash, after: hashText(next), textBefore: text, edits });
        break;
      }
    } catch (error) {
      console.error(`[shared-move-links] Could not update the links of ${note.path}:`, error);
      skipped.push(...skipsOf(note, "unreadable"));
    }
  }
  return { applied, skipped };
}

/**
 * After the host committed a move or folder rename in a shared notebook:
 * plans against the committed layout and rewrites the paths that would no
 * longer open the file they opened (notes of shared notebooks through the
 * host, local notes on disk). Never throws (the move cannot be taken back):
 * `links` is the report a local move returns, and `unfinished` has one plain
 * sentence for each step that stayed behind.
 */
export async function followSharedMovedLinks(moves: readonly PathMove[]): Promise<{ links: LiberaLinkRewrites; unfinished: string[] }> {
  const real = moves.filter((move) => move.from !== move.to);
  if (!real.length) return { links: { rewritten: [], skipped: [], unchecked: [] }, unfinished: [] };
  try {
    const plan = await planMovedLinks(real, { source: sharedLinkSource() });
    const replan = replanMovedNote(plan.layout);
    const local = await applyMovedLinks(plan.notes.filter((note) => !sharedIn(note.path)), replan);
    const shared = await applySharedNotes(plan.notes.filter((note) => sharedIn(note.path)), replan);
    const applied = [...local.applied, ...shared.applied];
    const failures = await followLinkRewrites(applied, { history: (filePath) => !sharedIn(filePath) });
    const skipped = [...plan.skipped, ...local.failed, ...shared.skipped];
    const broken = new Set([...local.failed, ...shared.skipped.filter((skip) => skip.reason === "unreadable")].map((skip) => skip.path));
    return {
      links: { rewritten: applied.map((note) => ({ path: note.path, rewrite: note.rewrite })), skipped, unchecked: plan.unchecked },
      unfinished: [
        ...(broken.size ? [`links in ${broken.size} ${broken.size === 1 ? "note" : "notes"} could not be updated`] : []),
        ...failures.map((failure) => `links followed the move, but ${failure}`),
      ],
    };
  } catch (error) {
    console.error("[shared-move-links] Links did not follow the move:", error);
    return {
      links: { rewritten: [], skipped: [], unchecked: [] },
      unfinished: [`links could not follow the move: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
