# Notebook migration

**Library → Sort menu → Migration…** moves a selection of files and folders from one local notebook to another, or to a new notebook, together with everything Libera keeps for them. Shared (collaborative) notebooks are not supported on either side yet. Linked folders are supported; a move between drives copies and then removes, so files lose their creation date.

Code: `src/lib/storage/migration.ts` (engine), `src/lib/storage/migration-fence.ts` (what other code leaves alone meanwhile), `src/lib/storage/sidecars.ts` (sidecar registry), `src/app/api/notebooks/migrate/route.ts`, `src/components/libera/notebook-migration-dialog.tsx`. Tests: `scripts/editor/notebook-migration.test.ts`.

**Move…** in a tab's file actions uses the same procedure when the destination is another notebook: the dialog opens on the review of that one file, which goes directly into the chosen folder (`destination.flat`, rather than under its source folders). Moves within a notebook, and drag-and-drop, keep the direct move.

## Steps

1. **Choose.** Pick the source notebook and check files and folders, then a destination notebook (and optionally a folder in it), or **New** to fill in the create-notebook dialog. A new notebook is only created when the migration runs, so cancelling leaves nothing behind.
2. **Review.** The server plans the move (`action: "plan"`). Planning only reads: it never loads the library tree (whose upkeep writes indexes and prunes sidecars), never resumes reference jobs, and never cleans up recordings.
   - Selected files keep their folder layout under the destination. A folder whose files are all checked moves whole, including content the panel hides (dotfiles, unknown file types, links, which move as links) and its empty folders. Archived files cannot be selected, and nothing goes into a destination `_archive`.
   - A name is free only when the destination has no file, no sidecar data (kept annotations, ink...) and, for a note, no `_assets` folder at it; files and folders share one namespace, case-insensitively. Otherwise both are kept: `note.md` becomes `note-1.md`.
   - Each file's identity (device, inode, size, modification time) is recorded. The plan's token covers the identities, the size of hidden folders, the new notebook's details and the warnings, so the run refuses if any of them changed since the review.
   - **Blockers**: a shared notebook on either side, the destination is the source (also under another name) or one is inside the other, a path through a link to another folder, a name starting with `.`, a visible name starting or ending with a space, the new notebook's name is taken, reference look-ups running for the source's PDFs, a recording saving into a moving folder, an earlier migration that did not finish, or a journal that can't be read (the dialog can set it aside, renamed, so it stops blocking).
   - **Warnings**: renamed files; notes that stay and link to moving files, and moving notes whose links would no longer find their file from the new place (each link is resolved before and after, as the editor resolves it, against the planned layout; links are not rewritten, as for any move). Other notes' links come from each notebook's link index as the app last wrote it. LaTeX files that need files left behind (with a button to add them), resolved as TeX does: from the main file's folder (`\subimport` from the file's), through `\graphicspath`, `\includegraphics*` and extension-less graphics; a chapter moving without its main file counts too, and the review says when a large project was only partly read. Moves between drives.
   - Open files with unsaved changes must be saved first (**Save all**).
3. **Run** (`action: "run"` with the plan's token). The server plans again (without the link check) and refuses when the plan changed since the review, so nothing moves on stale information. Review decisions not yet sent for the selected files are sent first.

## What moves with a file

| Kind | Where it lives | How |
|---|---|---|
| PDF annotations and comments, image annotations, PDF outline, PDF text cache, transcript, waveform, definitions, ink | `.libera/…/by-path/…`, `_ink/…` | `SIDECAR_KINDS` in `sidecars.ts` |
| A note's Python code | the note's `_assets` folder | `movePythonSidecar` |
| A note's images, uploads and Python figures | `_assets` | copied into the destination's `_assets` while staging, and the note's rewritten text staged. An image shared by several moved notes is copied once, an embedded notebook image that moves in the same batch is followed instead of copied, and source images no other note uses are pruned at the end |
| Markdown reviews, stars, tags, folder expansion | state files | re-keyed once for the whole batch |
| Pending agent reviews | `.libera/agent-review` | written at the new path (baseline rewritten like the file) under the review locks before the file moves, removed from the old one after |
| Agent run undo | `.libera/agent-runs` | `movedTo` recorded, the original and draft rewritten like the file, and the written-content hash carried over, so Undo still works where the file is now. Runs of this process are updated in memory |
| Reference attachments | every notebook's library | remapped once for the whole batch; tethered `.bib` files follow |
| References cited by notes | destination library | copied, citation keys rewritten when they clash (Markdown only: reference features never rewrite LaTeX sources) |
| A moved PDF's reference entry | destination library | copied; PDFs without one are offered to automatic entries |
| Open tabs, unsaved ink and annotations, saved workspaces (including unsaved drafts, rewritten like the files), last-interacted dates, heading numbering, the review list | the app | follow on the client after the run |

The guard test in `notebook-migration.test.ts` fails when `paths.ts` gains a per-file sidecar that is not in `SIDECAR_KINDS`. File moves, renames, archiving and deletion use the same registry.

## How it runs

The journal is `<data>/users/admin/.libera/migrations/<id>.json`. It is written at phase boundaries and once per finalize step, never once per file, so a large migration in a synced folder causes a handful of writes. A lock file next to it keeps a second migration (from any process) from starting.

1. **Staging.** Nothing in the source changes. Selected folders are created in the destination, old sidecar layouts are upgraded, images are copied into each note's own `_assets` folders, and a note whose image paths change is written in full to a hidden `.libera-migrating-<id>-<n>` file beside its destination, with the note's dates. Then the journal is written with every rewrite map. A failure here undoes staging and forgets the migration; after a crash here, resuming undoes it too: the notes' `_assets` folders are new with the migration, so they are removed whole, as are the folders it created and a notebook it created.
2. **Moving.** Images and other files first, notes last, so a note never points at an image that has not arrived. Each file is published without ever replacing anything: a hard link from the source (the same inode, so dates and identity stay), or from its staged copy; on another drive the file is copied to a staged name first. A file system without hard links falls back to a checked rename. Only then is the source removed, after checking it is still the same file. A file's pending review moves before it and its sidecars right after.
3. **Finalizing.** One step at a time, each recorded when it starts and ends: folders (removed from the source only when empty; a folder that received new files stays, with its records), stars/tags/reviews, images, reference attachments (open References panels of the changed libraries are told, once per library), a tethered `.bib` file among the moved files (one awaited pass), cited references, review baselines and undo history, reference entries, and the search index. A step that fails is reported in the result, not retried blindly; one interrupted half way is reported and not run twice.
4. The source is checked for anything left at a moved item's old path (the item, its sidecars) and for prepared copies. The result says `clean`, `incomplete` (files remain, or leftovers) or `unverified` (the source could not be checked). The finished journal keeps the result until the app confirms it applied it, so a lost response is applied the next time the dialog opens. A workspace group chosen for a new notebook is kept with the migration and returned with the result.
5. The app follows the result: open tabs (reloaded a few at a time, then retargeted in one update), saved workspaces, expanded folders, recent-file dates, heading numbering, the review list. Other windows of the app follow it too.

While a journal is open, `migration-fence.ts` keeps other code off its files: saves, uploads, annotation, ink, transcript, definitions and outline writes to them are refused, the tree's sidecar maintenance skips both notebooks (it would take a half-moved file's sidecars for orphans), and the agent review store keeps reviews whose file is in flight. A check costs one `stat` of the journal folder.

## Interruptions

When a run stops (a disk error, the app quitting), no file is half moved: each one is either still in the source, or published at its destination. On resume, where each file is comes from the disk and is checked against the identity recorded in the plan; a destination that holds another file stops the migration without replacing or removing anything. The dialog offers **Move the rest** or **Stop here** (which finishes what moved and leaves the rest), after checking that both notebooks are still the local folders the migration started with. No other migration can start until one is chosen.

## Not handled

- Markdown links between notes are not rewritten (see [related notebooks](related-notebooks.md)); the review lists the notes concerned.
- Chat history keeps the old paths in past messages; they are a record of the conversation.
- "Where was I" recaps and citation-rewrite undo backups of the source notebook keep the old paths.
- The LaTeX build cache is keyed by path; the first compile after a move starts cold.
