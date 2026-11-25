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

All 27 packages merged into `fix/file-moving-review`. Of the 89 critical, high and medium findings, 79 are fixed,
9 partly fixed (U-H1, L-C4, L-H1, L-H6, S-M3, S-M4, R-M4, E-H1, O-M2) and 1 left by the user's decision (E-M7);
none was rejected as not a bug. Two sub-items were judged not bugs from the code: L-M4's symlinked
folders (the tree and the check never treat a symlink as a folder) and O-M2's symlink skip (the tree skips them too).
Most packages showed their new tests failing before the fix; the table notes where they could not.

| Package | Fixed | Partly fixed, or left (what) |
|---|---|---|
| W1 editor writers | U-C1, U-C2, U-H2, U-M4 | The live recording tab's segment draft is unchanged (no library file to move). |
| W2 link rewrites into open tabs | U-H3, U-H4, U-H5, U-H6 | U-H4 covers Try to fix and other windows' moves through W4's call to `afterMoveReviewState`. TipTap: text composed mid-IME is replaced by the rewrite. Hook wiring has no test (no DOM). |
| W3 retarget and panes | U-H9, U-H10, U-M3, U-M6 | Single-file moves do not remap `fileInteractions` or heading numbering. |
| W4 other windows | U-H7, U-H8, U-M5 | U-H1: a notebook rename is not broadcast to other windows. A saved-workspace change queued during a workspace switch can be remapped twice (swap or chain). Hook flow has no test. |
| W5 migration dialog and drops | U-C4, U-C5, U-M1, U-M2 | A shared source is refused with the existing "can't be migrated yet" message. |
| F1 fs primitives | L-C3, L-H4 (fs, notebooks), U-C3, L-C4 (3) | none. No real NFD-to-NFC notebook rename test (NTFS keeps both names). |
| F2 single-file ops | L-C1, L-C4 (2), L-H5 | L-M4: symlinked folders are not a bug (see above). `archiveFile` retries a taken name instead of choosing inside the locks. A `.md` → other rename is refused while the note embeds an `_assets` image. |
| F3 folder ops | L-C4 (1), L-C2 (folders) | L-H1: an `_assets/<note>` folder is respelled only when it holds nothing but Python code; with images in it, the code is respelled and the folder keeps its casing. |
| N1 notebooks and path stores | R-H2, L-H8, L-C2 (rename), L-C4 (rename), L-M1 | S-M3: a true swap of two root names is held pending, not resolved. `/api/tree?notebook=` has no route test. |
| M1 migration | L-C4 (5), L-C2, L-H4, L-H3, L-M3 | L-C4 (4): a writer between `assertNotMigrating` and its path lock is not covered. L-H6: a crash between the baseline write and its flag can rewrite baselines twice. L-C2 did not reproduce (the fix is a safety net). |
| B1 batch and shared writes | L-H7, L-M2, U-H5 (server), S-H5, R-M3, S-M4 (folder rename), L-H4 (local batch) | The shared preflight still keys by `manifestPathKey` (pinned by S17). |
| T1 transcripts | L-H3, O-H3, S-C1 (5), L-M3 (tethers) | Try to fix does not move a transcript companion; it is reported for Acknowledge. |
| R1 references | L-H2, E-H9 | `moveReferenceAttachments` can now fail a move (reported as unfinished). |
| K1 shared link engine | R-C1, R-C2, R-H1 | S-M4 (inbound links): a collaborator's move rewrites local notes; a Finder move on the host's disk rewrites local notes only. Cost: one host read per shared Markdown note per shared move. |
| K2 Markdown rewrites | R-H6, R-H7, R-M1, R-M2 | R-M4: when the agent removed every link to the moved file, its baseline and undo original keep the old link; migration and shared moves don't re-plan baselines. Rewrite order was not a bug in effect (same text either way). The links panel's parser still lacks GFM footnotes. |
| X1 LaTeX | R-H3, R-H4, R-H5 | The check now reports an existing `\input{../x}` as an error (the compiler refuses it). Mirror depth caps and `\graphicspath` with `..` are not covered. |
| A1 Markdown assets | E-C1, E-H7, E-M5 | An offline linked folder blocks image deletion in every notebook until it is connected. The case-sensitive branch of E-H7 is a unit test only. |
| D1 linked folders | E-C2, E-M8 | A folder linked by hand without a marker can't be told from a replacement. |
| U1 ink upkeep | E-C3, E-H1 (ink), E-H6, E-M1 | The "folder changed while copying" guard has no test. |
| U2 PDF upkeep | E-H4, E-H8 | E-H1 (PDF): a set-aside record blocked by a newer annotation in its slot stays kept. The backfill-inside-the-fence path has no test. |
| P1 Try to fix | E-H2, E-M6 | E-M7 left by decision: the user chose to keep the 2026-11-20 rule (Try to fix stays name-based within the notebook; records of a file moved to another notebook are reported `none` and Acknowledge offers them). P1's cross-notebook `elsewhere` hold was removed. |
| C1 Acknowledge | E-H3, E-M2, E-M3, E-C3 (check) | none |
| S1 shared authority | O-C1, O-H1, E-H5, E-M4, O-M1 | On pdfLive notebooks, old orphan live-marks sidecars are now clearable by Acknowledge (not Try to fix). O-M2's "starred or tagged shared folders" is not a bug: only files are starred or tagged (`notebook-panel.tsx`, `file-tags-dialog.tsx`), so S1's acceptance of folders was taken back after the core test run. |
| S2 shared PDF records | S-C1 (1–4) | none |
| S3 shared follow and acknowledgement | S-C2, S-H3, S-H4 | A notebook with an in-app move or delete the server hasn't confirmed is checked partly (Try to fix and Acknowledge wait), offline too. Remembered own changes are memory only: after a restart they are followed as a collaborator's. |
| H1 collab host | S-H1, S-H2, S-M1, S-M2, S-M4 (host) | A folder holding very recent empty files can still split (the scan's 3 s settle hold). |
| O1 the check | O-H2, O-H4, O-M3 | O-M2: illustration paths, saved workspaces, where-was-i, document chat, expanded paths and live PDF comments are listed as not checked. Disk-only companions of shared files are not compared with the manifest. |

Decisions made while fixing:

- **S-C2: follow once, at the acknowledgement.** An in-app shared rename or delete moves no local record until the
  host records the transition at the server's acknowledgement (`transitions-recorded` event); a change the server
  rolls back gets no row and its records stay. The manifest view reads `unavailable` while such changes wait.
- **S-C1: host-owned records don't block a name.** `assertNoLeftoverRecords` skips the kinds `hostOwnsSideFile`
  names, through one option on `destinationRecords().at` (F2's single reader).
- **O-H4: leftover info findings fail tests.** `LEFTOVER_INFO_CODES` in `notebook-test-helpers.ts`; a finding's text
  ends with `[code]` so `allow` can name it.
- **Manifest keys stay `manifestPathKey` on the host.** H1, B1 and S3 used the host and server rule (NFC plus lower
  case), which differs from `foldedFileName` for `ß` and `ı`; changing it would touch the server.

Fixed while merging: line endings restored to CRLF in five files that agents had rewritten as LF; conflicts in
`repair.ts` (imports), `files.ts` and `destination-records.ts` (F2's reader with S2's host-owned skip),
`shared-record-follow.ts` (K1's local link follow-up and S3's expected changes), `markdown-reviews.ts` (N1's
`moveWithin` kept), `use-libera-workspace.ts` (`followFileMove` takes `{ report, announce }`; W4's review refresh
uses W2's `afterMoveReviewState`), `integrity.ts` and `sidecars.ts` (`listSidecars` takes `{ companions, onEntry }`).
After the merge: a newline literal one agent's scripted edit broke, two missing imports, a helper renamed out of a
local of the same name, and three type annotations.

Battery: no package added a polling loop or a fixed-interval timer. New waits are event-driven one-shots (the
acknowledgement nudge, the IME composition end) and P1's three-step backoff on busy Windows files. Extra I/O: one
stat per linked folder per `getLinkedFolders` call (D1), one host read per shared Markdown note per shared move
(K1), and `destinationRecords` reading undo manifests, tethers and the older review database per single-file move
(F2).

### Tests

- Each package ran its own new test file and at most two existing ones, once (a few ran three). No full suites,
  builds or browser checks ran, by the user's request to keep testing light.
- Central checks on the merged branch: `npx tsc --noEmit -p tsconfig.json` clean (after the fixes above); eslint on
  the changed files clean (warnings only); `check-messages` reports only `migrationVanishedNotebook` in vi and zh,
  which fails on `main` too.
- Core editor run, once (concurrency 2): every `review-1125-*` file, the existing files the agents changed, and the
  files O1 listed as likely affected by the stricter helper: 424 tests, 411 passed, 11 failed, 2 skipped. All 11
  were fixed and their files run again once (now passing):
  - Seven failed on `linkIndexOutOfDate` or `citationIndexOutOfDate`, which O1 had made strict. Both indexes are
    rebuilt lazily by design, so they were taken out of `LEFTOVER_INFO_CODES`. Search-index staleness and corrupt
    indexes stay strict.
  - `notebook-cleanup` "a stale record whose name is now a folder": S1 had counted a folder as present for stars
    and tags. Only files carry them, so the check is file-only again.
  - `review-1125-m1` L-H3: since T1 a companion transcript moves as its recording's side file, and M1 also moved
    it as an item, so migration moved it twice. Migration now leaves it to the side-file move.
  - `review-1125-s2` path reuse on pdfLive: F2's set-aside check held the name for a live-marks record S2 had
    set aside. Set-aside records of host-owned kinds no longer hold a name, as S2's rule already said for sidecars.
  - `notebook-repair-identity` "records of a note moved to another notebook are not held": P1's E-M7 held
    them while a file of that name was in another notebook, reversing this 2026-11-20 assertion. The user chose
    the 2026-11-20 rule; P1's hold was removed and the test is as it was. The four repair and cleanup files
    then passed 78 of 78.
- Collab: the three `review-1125` collab files, once: 12 of 12 pass.
- Not run: the full editor and collab suites, the server suite, e2e and the app itself.

**Decided by the user (2026-11-25):** E-M7 stays as the 2026-11-20 round left it. Try to fix does not look in
other notebooks; a note moved to another notebook leaves records that Try to fix reports as `none` and Acknowledge
can remove.
