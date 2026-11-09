# Notebook check

**Notebook actions → Check Notebook…** checks a notebook against the disk and lists what is not sound, with what would set each finding right. It only reads: nothing is repaired, moved or rewritten, and it does not load the library tree (whose upkeep prunes sidecars and writes indexes). It runs only when asked, shows which check it is on, and can be stopped.

Code: `src/lib/storage/integrity.ts` (`verifyNotebook`, `checkNothingLeftAt`), `src/app/api/notebooks/verify/route.ts`, `src/components/libera/notebook-integrity-dialog.tsx`. Tests: `scripts/editor/notebook-integrity.test.ts`, `scripts/editor/notebook-operations-integrity.test.ts`.

## One common point

The check owns no knowledge of its own. Each kind of state is asked of the module that owns it, and checked against the disk:

| Check | Asks | Finding |
|---|---|---|
| Notebook settings | `notebookMetadataPath` | settings file missing (info) or unreadable (error) |
| Side files | `listSidecars`, `findOrphanedSidecars`, each kind's `inspect` (sidecars.ts, from the owner: `inspectPdfSidecar`, `inspectImageSidecar`, `inspectPdfTextCache`, `inspectAudioPeaksCache`, `inspectInkFolder`, and the outline, definitions and transcript parsers), `matchByIdentity` and `readOrphans` (pdf-sidecars.ts) | a saved side file its owner rejects, or ink files the reader leaves out (error); records its reader silently drops, which the next save loses: annotations, comments, strokes, outline entries, definitions, transcript segments (warning); side files of a file that is gone (warning), or that belong to a file moved outside the app, which they follow the next time the notebook is opened (info); a side file made for another version of its file, by size (info); PDF text caches and waveforms out of date, one line per kind (info); ink of a page or block the file doesn't have, side files set aside for files that may come back (info) |
| Note images and Python code | `unreferencedMarkdownAssets` (markdown-assets.ts) | Python code of a note that is gone (warning); images no note shows (info) |
| Images in notes | `markdownImageTargets` | an embedded image, Markdown or HTML `<img>`, that is missing (error) |
| Links in notes | `linkCandidates`, `resolveLinkTargetWith` (library-links.ts), `markdownHeadingAnchors`, `savedAnnotationIds` (annotations.ts), `hasUnreadableLinkPosition` | a link (inline or reference-style) that finds no file, resolved as the editor resolves it; a heading, in the note or another, that is not there (HTML anchors count); a link to an annotation that is gone; a moment past the end of a recording (by its transcript's or waveform's length); a saved place that can't be read (all warnings) |
| LaTeX | `latexDependencies` (latex/dependencies.ts) | an `\input`/`\include`, figure or bibliography that is not found from the main file's folder (error) |
| Records | workspace metadata, `inspectReviewKeys`, `listReviewEntryPaths`, `listRunFiles` | stars and tags of missing files, pending agent reviews of missing files (warning); review comments and undo history kept for missing files (info); unreadable review records (warning or error) |
| References | `inspectReferenceLibrary` (the app's own parser, without setting a damaged library aside), `readTetherTarget` | a reference attached to a missing file, a missing tethered `.bib` or unreadable tether settings (warning); a library the app can't read (error) |
| Indexes | `readLinkIndex` (notebook-links.ts), `readCitationIndex` (reference-citations.ts), `planBibMirror` (bib-mirror.ts, what `writeBibMirror` would do), `readIndexedLibraryPaths` (search/database.ts) | link and citation index entries whose content hash no longer matches the note, notes not indexed yet, entries of files that are gone; a `.bib` mirror out of date, not written, or protected because it was edited; Global Search rows of files no longer in the notebook (all info, aggregated) |
| Migrations | `listInterruptedMigrations`, `listUnreadableMigrations` | an unfinished migration involving the notebook (error); an unreadable journal, a prepared copy left behind (warning) |

The notebook is walked once and its notes read once per check; files are checked for existence once each, and the side files are listed once. Side files are compared with their file by size only (a stat), never by hashing the PDFs and recordings: a same-size change is left to the owner when the file is opened. Files are hashed only to match side files of a missing file, and only those of the size it recorded. Index entries are compared with hashes of the notes already read. Each check runs on its own: one that can't run is reported as such, and one that could only partly run (very large notebooks, unreadable notes, a folder or file it had no permission to read) says so. A path that could not be checked is never reported as missing. When any check is partial, the dialog says **Partly checked** instead of "No problems found".

## Bounds, progress and stopping

A check runs under limits (`DEFAULT_INTEGRITY_LIMITS`: 20,000 entries, 64 MB read, 30 s, 10,000 findings); reaching one makes the checks it cut short partial, saying which limit. The report carries what the check cost (`statistics`) and its `completeness`. With `?stream=1` the route sends newline-delimited JSON: one `progress` line as each check starts, then the `report` (or an `error`). The dialog shows the check it is on and a **Stop** button; stopping, closing the dialog or the request going away aborts the check between reads.

## Read only

Read-only means no maintenance-capable path is used: not the tree load, not the review store's migrating reader, not the reference library's quarantine, not the readers that upgrade older annotation or ink layouts. Finding where a linked folder is reads its state without its upgrades: `verifyNotebook` runs under `withReadOnlyStorage` (paths.ts), under which `readDirectoryModeState` (electron/directory-mode.cjs) neither rewrites an older state file nor writes a folder's identity marker nor records its location. The search index is opened read-only, and only when that creates nothing (a WAL index needs its shared-memory file to exist already); otherwise it is skipped.

Two tests hold this: one snapshots the whole data folder before and after a check; the other replaces every writing call of `fs` and `fs/promises` (and opening for writing) while checking a notebook with every kind of side file, indexes, a mirror and a linked folder in an older state file without its marker, and fails on any call.

## As a test oracle

`scripts/editor/notebook-test-helpers.ts` exports `assertNotebookSound(notebook)`, which runs this check and fails on any error or warning not explicitly expected. The migration tests assert it after every scenario, and `notebook-operations-integrity.test.ts` runs the everyday file operations (move, rename, archive, copy, delete, folder operations, moves between notebooks) on a notebook seeded with every kind of side file, a star, tags and a reference attachment, asserting each leaves both notebooks sound, notes included (except the link and citation indexes' lag, which the app's next tree load clears and the sweep deliberately never runs). It found that a note that stays and shows a moving image by its library address breaks without warning; the migration review now warns about it.

The migration's final check uses `checkNothingLeftAt` from the same module, so "nothing was left behind" means the same thing in both places. The migration review reuses the same link and LaTeX helpers.

## Not checked

- Shared notebooks are checked as they are on this computer, not against the collaboration host, which keeps their files in step.
- A side file is compared with its file by size; a change that keeps the size is found by its owner when the file is opened.
- Links into other notebooks and LaTeX paths outside the notebook are not judged; a link's line in a text file is not checked.
- Global Search is skipped when its index can't be opened without creating files (no one has it open).
