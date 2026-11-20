# Notebook integrity on move: triage and fix plan (2026-11-20)

Source: a static Codex review (gpt-6.2-sol, xhigh) of `main` at `e996943`, covering in-app moves, moves in
Explorer/Finder or by a sync client, Check Notebook, Try to fix and Acknowledge. 99 findings, reproduced verbatim in
[2026-11-20-codex-move-integrity-review.md](2026-11-20-codex-move-integrity-review.md), with a section of inputs for
the link refactor on move that follows this round.

## Rules for the round

- Every finding is treated as real until the fixing agent shows otherwise from the code.
- Try to fix stays name-based (docs/features/notebook-integrity.md): no fingerprints, stamps, retention or merge
  layers. Gaps inside the name rule are fixed.
- Markdown links and image paths are not rewritten on move in this round; the link refactor comes after it.
- Destructive steps fail closed: when a check cannot establish that something is stale, free or unique, the step is
  refused or held, and the report says so.
- Tests: the package's own test files, once; `npx tsc --noEmit -p .` and eslint on changed files, once.

## Packages

Agents: Sonnet, one worktree each, branched from `fix/move-integrity-audit`. Ownership is by function inside the
shared files (`files.ts`, `integrity.ts`, `migration.ts`, `use-libera-workspace.ts`).

| Package | Findings | Owns |
|---|---|---|
| A1 direct moves | 1, 2, 3, 4, 5, 19, 21, 86 | `files.ts` `moveFile`, `moveFileToDirectory`, `archiveFile`, `updateMarkdownFile`, `movePathDerivedRecords`; `fs-utils.ts` publish helpers; `src/app/api/files/route.ts` |
| A2 copy and shared writes | 9, 10, 11, 96, 97, 98 | `files.ts` `copyFileToDirectory` and its helpers; `src/lib/collab/shared-writes.ts` |
| A3 folder operations | 13, 14, 15, 16 | `files.ts` `renameFolder`, `archiveFolder`, `deleteFolder` and folder sidecar moves; `markdown-assets.ts` folder scans |
| A4 record stores | 6, 12, 17, 18, 20, 76 | `workspace-metadata.ts`, `destination-records.ts`, `src/lib/agent/review-store.ts`, `markdown-reviews.ts`, `files.ts` `deleteFile` |
| A5 side file types and legacy layouts | 7, 8, 40, 48 | `sidecars.ts` type guard and inventory, `annotations.ts` legacy layouts, `ink.ts` chunk compatibility |
| B1 renderer saves and retargeting | 22, 23, 24, 25, 26, 27 | `use-libera-workspace.ts` save, retarget, archive completion; `pending-saves.ts` |
| B2 renderer delete, drop, outside changes | 28, 29, 30, 31, 32 | `use-libera-workspace.ts` delete confirm, `moveFileToFolder` path handling, focus refresh, repair mapping delivery; `notebook-panel.tsx` drag state; `workspace-confirm-dialog.tsx` |
| C1 upkeep reattachment | 34, 35, 36, 37, 39 | `pdf-sidecars.ts` reattach and set-aside, `ink.ts` set-aside and reattach |
| C2 tree walk and linked folders | 33, 38, 41, 42, 43, 44 | `tree.ts`, `sidecars.ts` orphan detection, `library-links.ts` exact lookup, `transcripts.ts` prune, `directory-mode.ts`, `electron/directory-mode.cjs` |
| C3 reference reattachment | 45, 46, 95 | `references.ts`, `src/lib/references/bib-tether.ts` |
| D1 verifier scope and completeness | 47, 49, 56, 57, 58 | `integrity.ts` walk, limits, dispatcher, completeness, `checkNothingLeftAt`; verify route |
| D2 verifier record and link checks | 50, 51, 52, 53, 54, 55 | `integrity.ts` review, link, image, LaTeX checks; `review-files.ts`; `annotations.ts` `savedAnnotationIds`; `markdown-link-occurrences.ts`; `latex/dependencies.ts` |
| D3 indexes | 59, 60, 61, 62, 63 | `src/lib/search/*`, `notebook-links.ts`, `reference-citations.ts`, `integrity.ts` index check |
| E1 Try to fix | 64–75 | `repair.ts`, repair route |
| E2 Acknowledge | 78–85 | `cleanup.ts`, cleanup route, `notebook-integrity-dialog.tsx` |
| M1 migration publication and coordination | 77, 87, 88, 89, 93 | `migration.ts` publication, staging, reservation; `migration-fence.ts` |
| M2 migration rewrites, finalization, docs | 90, 91, 92, 94, 99 | `migration.ts` citation step, finalize/resume, plan; `src/lib/references/moves.ts`; `docs/features/notebook-migration.md` |

## Results

(Filled in as packages merge.)
