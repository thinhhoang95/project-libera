# File moving and the notebook check: triage and fix plan (2026-11-25)

Source: a static review of `main` at `8a6de26` covering in-app moves, moves made outside Libera, link and path
rewriting, shared notebooks and the notebook check, reproduced verbatim in
[2026-11-25-file-moving-feature-review.md](2026-11-25-file-moving-feature-review.md). Finding IDs (U-C1, L-H4, ...)
are the review's own. This round follows the move-integrity round
([2026-11-20-move-integrity-triage.md](2026-11-20-move-integrity-triage.md)), the shared-notebook integrity round
([2026-11-20-collab-integrity-triage.md](2026-11-20-collab-integrity-triage.md)) and the three-way sync round
([2026-11-23-three-way-sync-triage.md](2026-11-23-three-way-sync-triage.md)); their rules still hold.

## Scope

The user asked for every critical, high and medium finding. The low findings are not part of this round:
U-L1, L-L1, L-L2, R-L1 and E-L1 to E-L5.

## Rules for the round

- Every finding is treated as real until the fixing agent shows otherwise from the code. A finding judged not a bug
  is reported with the code that rules it out, not skipped silently.
- **Check Notebook is the oracle.** `verifyNotebook` (`src/lib/storage/integrity.ts`) decides. An in-app move,
  rename, drop, batch, link rewrite, Try to fix, Acknowledge or automatic upkeep step must leave findings the check
  agrees with. No component keeps its own rule (name matching, case or Unicode presence, archive scope, slot
  occupancy) that differs from the check's; reuse its helpers. Where the check itself is wrong, fix the check and the
  component together so they stay one rule.
- **Try to fix stays name-based** (`docs/features/notebook-integrity.md`): no fingerprints, content stamps, hash
  identity, retention or merge layers. Gaps inside the name rule (case and Unicode aliases of one name) are fixed.
- **Destructive steps fail closed.** When a step cannot establish that something is stale, free, unique or
  acknowledged by the server, it is refused or held, and the report says so. Nothing the user made is deleted on a
  guess.
- **No battery drain.** No new polling loops or fixed-interval timers; an unavoidable timer reschedules itself, is
  scaled on battery, is unref'd and stops when idle. Retries use capped backoff that resets only on real progress.
  No full tree walks, scans or whole-file hashes where the affected paths suffice; reuse recorded hashes; never
  hydrate OneDrive placeholders just to check them; skip identical writes.
- **LaTeX preambles stay the user's.** A move may rewrite a path that is already written in the source; it never adds
  `\usepackage` or other preamble lines.
- Tests: each agent runs only its own new test file and at most two existing files that pin the behaviour it
  changes, once each, one process at a time. No full suites, project-wide `tsc`, lint, builds, e2e, dev servers or
  browser checks inside agents. Type-check, lint and the core suites run once centrally after merging.

## Decisions taken in triage

- **One name rule (E-C1, L-H4, S-H2, S-H3, S-H4, O-H1).** Wherever two paths are compared as "the same file", the
  comparison is `foldedFileName` from `src/lib/storage/file-names.ts` (NFC plus case folding) applied per segment,
  the same rule the check and Try to fix use. A test of "is that slot physically taken" goes through the existing
  alias-aware helpers (`fileExistence`, `physicalState`, `probeFileOnce`), never `access`/`pathExists` on a
  differently spelled path. On a case-sensitive volume two names that fold together are still two files; code that
  must tell them apart asks the disk, not the folded key.
- **A shared notebook's `_archive/` is local (O-C1, E-H5, R-C2, O-M1).** Whether a path is judged against the shared
  manifest or against the disk depends on the path itself (`isSharedNotebookPath(libraryPath)`), never on the
  notebook being checked. `Shared/_archive/...` and attachments in other notebooks are judged against the disk.
- **A shared PDF's local records follow it (S-C1).** A confirmed rename moves the local PDF records (annotations,
  outline, definitions) instead of copying them; a confirmed delete retires them. A deliberate delete never writes a
  fresh sidecar at the deleted path. Anything the check reports as a leftover record must be clearable by Try to fix
  or Acknowledge: `hostOwnsSideFile` and `assertNoLeftoverRecords` / `assertSharedPathFree` follow one rule.
- **Nothing local is destroyed before the server has the change (S-C2).** The M23 rule from the 2026-11-23 round
  stands: transitions from local manifest edits are recorded once the server acknowledges them. An in-app shared
  move or delete must not delete local records through the `uncovered` path before that; a change the server rolls
  back leaves the records where the restored manifest expects them, and an acknowledged change is followed once,
  not twice.
- **The test helper stops hiding move damage (O-H4).** `assertNotebookSound` fails by default on the "info" findings
  that mean a move left something behind (`reviewFileMissing`, `agentRunFileMissing`, `imageLeftBehind`,
  `imageUnused`, `sharedFileNotListed` and stale index rows). A test that expects one names it in `allow`.
- **LaTeX rewrites follow the compiler (R-H3, R-H4, R-H5).** A move writes only paths `src/lib/latex/build.ts` can
  open (no `../` escapes under `openin_any=p`, nothing under `_`-prefixed folders the mirror skips, no commas in
  `\bibliography` keys, no unquoted leading spaces). When no such path exists the reference is reported as not
  rewritten, and the check reports it the same way. Subfiles with a `\documentclass[...]{subfiles}` root are not
  roots.

## Packages

Agents: Sonnet, one worktree each, started from `fix/file-moving-review`. Up to 20 run at once (the user,
2026-11-25); the last seven start as slots free. Ownership is by function inside shared files
(`use-libera-workspace.ts`, `files.ts`, `integrity.ts`, `migration.ts`, `repair.ts`, `cleanup.ts`, `ink.ts`,
`pdf-sidecars.ts`, `shared-writes.ts`, `shared-record-follow.ts`, `project.ts`, `pdf-marks.ts`, `markdown-assets.ts`,
`batch-files.ts`, `move-rewrites.ts`). An agent that must touch a function it does not own keeps the change minimal
and says so in its report.

| Package | Findings | Owns |
|---|---|---|
| W1 editor writers and drafts | U-C1, U-C2, U-H2, U-M4 | `ink/use-ink-document.ts`; `audio/editable-lines.tsx`, `audio/use-voice-memo.ts`; `pending-saves.ts`; `use-annotation-writer.ts`; `tabUnsaved` in `use-libera-workspace.ts` |
| W2 link rewrites into open tabs | U-H3, U-H4, U-H5 (renderer), U-H6 | `use-libera-workspace.ts` `applyLinkRewritesToTabs`, `followFileMove`, `followBatchLinks`, `moveFilesToFolder` and the after-move review/agent-review refresh; `markdown-review-context.tsx`; `src/lib/agent-review/store.ts`; link-rewrite intake in `latex-editor.tsx`, `code-editor.tsx`, `markdown-codemirror-editor.tsx`, `use-tiptap-draft.ts` |
| W3 retarget, folder and notebook rename, panes | U-H9, U-H10, U-M3, U-M6 | `use-libera-workspace.ts` `renameFolder`, `submitNotebookDialog`, `submitWorkspaceInputDialog`, `archiveFolderNode`, `retargetOpenTabs`/`planRetargets` remaps; `src/lib/canvas-layout.ts` |
| W4 other windows, saved workspaces, chat | U-H1, U-H7, U-H8, U-M5 | `use-libera-workspace.ts` move broadcasts, `applyRepairMoves`, `followMigrationFromOtherWindow`; `file-window-page.tsx`; `use-markdown-windows.ts`; `use-saved-workspaces.ts`; `src/lib/workspaces.ts`; `document-chat-panel.tsx` |
| W5 migration dialog and panel drops | U-C4, U-C5, U-M1, U-M2 | `notebook-migration-dialog.tsx`; `notebook-panel.tsx` drag, drop and selection; the cross-notebook drop/move routing in `use-libera-workspace.ts` |
| F1 fs primitives, locks, identity | L-C3, L-H4 (fs-utils, notebooks), U-C3, L-C4 (3) | `fs-utils.ts` `moveWithoutReplacing`, `withPathLocks`, `isCaseOnlyRename`; `notebooks.ts` name comparison; `tree.ts` `getFileNode`/`stampLocalFileIds`; `files.ts` `readLiberaFile`; `GET /api/files`; `ink.ts` `writeInk`; `definitions.ts` `writeDefinitions` |
| F2 single-file ops and destination records | L-C1, L-C4 (2, `archiveFile`), L-H5, L-M4 | `files.ts` `findAvailableCopyPath`, `deleteFile`, `archiveFile`, `moveFile`, `copyFileToDirectory`, `saveEditedImageCopy`, `leftoverRecords`, `finishMarkdownImageMove`; `destination-records.ts`; `DELETE /api/files` |
| F3 folder ops and Python sidecars | L-C4 (1, folders), L-C2 (folders), L-H1 | `files.ts` `renameFolder`, `archiveFolder`, `deleteFolder`, `moveFolderWithRecords`, `moveFolderPythonSidecars`; `markdown-assets.ts` `movePythonSidecar` |
| N1 notebooks and path-keyed stores | R-H2, L-H8, L-C2 (notebook rename), L-C4 (1, `renameNotebook`), S-M3, L-M1 | `notebooks.ts` (not its name comparison); `root-transitions.ts`; `src/app/api/tree/route.ts`; `document-chat.ts`; `where-was-i.ts` |
| M1 migration | L-C4 (4, 5), L-C2 (migration), L-H4 (migration), L-H3 (migration), L-H6, L-M3 (except `checkNothingLeftAt`) | `migration.ts`; `migration-fence.ts` (not `enterOperation`) |
| B1 batch moves and shared writes | L-H7, L-M2, U-H5 (server), S-H5, R-M3, S-M4 (`renameSharedFolder`), L-H4 (batch) | `batch-files.ts`; `src/app/api/files/batch/route.ts`; `shared-writes.ts` `moveSharedFile`, `renameSharedFolder`, `SharedOperationUnfinishedError` paths |
| T1 transcripts and nothing-left check | L-H3 (local ops), O-H3, S-C1 (5), L-M3 (`checkNothingLeftAt`) | `transcripts.ts`; transcript entries in `sidecars.ts`; transcript hooks in `files.ts` and `destination-records.ts`; `integrity.ts` `recordingDuration`, `checkNothingLeftAt` |
| R1 references | L-H2, E-H9 | `references.ts`; `src/lib/references/bib-tether.ts`; bib mirror |
| K1 shared link engine | R-C1, R-C2, R-H1, S-M4 (inbound links) | `shared-move-links.ts`; `markdown-link-occurrences.ts` |
| K2 Markdown rewrites and check parity | R-H6, R-H7, R-M1, R-M2, R-M4 | `move-rewrites.ts` (not `writeLatexPath`); `markdown-image-sources.ts`; `move-links.ts` chart pre-filter; `integrity.ts` link check; `markdown-reviews.ts` `rewriteReviewSnapshots`; `files.ts` rewrite order; `markdown-assets.ts` `copyMarkdownImageAssets` |
| X1 LaTeX | R-H3, R-H4, R-H5 | `src/lib/latex/*`; `move-links.ts` `planLatex`; `move-rewrites.ts` `writeLatexPath`; `integrity.ts` LaTeX check |
| A1 Markdown assets normalization | E-C1, E-H7, E-M5 | `markdown-assets.ts` `unreferencedMarkdownAssets`, `rawEmbedsInOtherNotebooks`, `cleanupMarkdownImageAssets`; `integrity.ts` image check; `cleanup.ts` image clearing; `library-links.ts` |
| D1 linked folders | E-C2, E-M8 | `paths.ts` `getLinkedFolders`; `directory-mode.ts`; `electron/directory-mode.cjs`; `assertRepairable` in `repair.ts` |
| U1 ink upkeep | E-C3 (ink), E-H1 (ink), E-H6, E-M1 | `ink.ts` `reconcileInkFolders` and set-aside; `integrity.ts` ink inspection |
| U2 PDF upkeep and serialisation | E-H1 (PDF), E-H4, E-H8 | `pdf-sidecars.ts` reconcile, set-aside and backfill; `tree.ts` upkeep; `migration-fence.ts` `enterOperation`; the call sites in `repair.ts` and `cleanup.ts` apply |
| P1 Try to fix | E-H2, E-M6, E-M7 | `repair.ts` (not shared authority, not `assertRepairable`); `fs-utils.ts` `renameCaseAlias` |
| C1 Acknowledge and set-aside reads | E-H3, E-M2, E-M3, E-C3 (check) | `cleanup.ts` (not shared authority or image clearing); `integrity.ts` set-aside and orphan reads; `annotations.ts` backups; `sidecars.ts` orphan classification |
| S1 shared authority in check, fix, acknowledge | O-C1, O-H1, E-H5, E-M4, O-M1, O-M2 (shared folders) | shared-path branches of `integrity.ts`, `repair.ts`, `cleanup.ts`; `shared-manifest-view.ts` `files`/`folders` lookups |
| S2 shared PDF records | S-C1 (1 to 4) | `pdf-sidecars.ts` shared follow and retire; `shared-record-follow.ts` `followOneMove`, `moveSharedLocalRecords`; `pdf-marks.ts` `close`; `shared-manifest-view.ts` `hostOwnsSideFile`; `shared-writes.ts` path-free checks |
| S3 shared record follow and acknowledgement | S-C2, S-H3, S-H4 | `electron/collab/notebooks/project.ts` `recordTransitions`, `fileOp`; `shared-record-follow.ts` `followCommittedChange`, `judge`, `orderTransitions`; `shared-owner.ts`; `ink.ts` shared ink paths |
| H1 collab host case and scan | S-H1, S-H2, S-M1, S-M2, S-M4 (host) | `project.ts` `respellFolder`, `noteRespelling`, `scan` folder moves, `scheduleIntents`, `displacedPath`, `placeStagedMoves`; `manifest-intents.ts`; `move-journal.ts`; `pdf-marks.ts` `resolve`; `service.ts` resolve route; `prunePdfTextCaches` |
| O1 the check itself | O-H2, O-H4, O-M2 (the rest), O-M3 | `integrity.ts` sharing check, budget, caches, walk; `shared-manifest-view.ts` `mayBeArriving`; `scripts/editor/notebook-test-helpers.ts`; `src/app/api/notebooks/verify/route.ts` |

First wave (20): W1, W2, W5, F1, F2, F3, N1, M1, B1, T1, K1, A1, D1, U1, U2, P1, C1, S1, S2, S3.
Second wave as slots free: W3, W4, K2, X1, R1, H1, O1.

## Results

To be filled in after merging.
