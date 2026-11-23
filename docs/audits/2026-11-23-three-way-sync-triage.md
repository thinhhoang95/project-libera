# Three-way sync (OneDrive, local, SQLite): triage and fix plan (2026-11-23)

Source: a static Gemini review of `main` at `be5856a`, reproduced verbatim in [2026-11-23-gemini-three-way-sync-review.md](2026-11-23-gemini-three-way-sync-review.md). It has 71 findings: 12 critical (C1–C12), 28 high (H1–H28), 25 medium (M1–M25) and 6 low (L1–L6). Its line citations match `be5856a`; a spot check of C1, C2, C8, C9, C11, H18, H23 and H28 found the code as described. This round follows the shared-notebook integrity round ([2026-11-20-collab-integrity-triage.md](2026-11-20-collab-integrity-triage.md)), whose rules still hold.

## Rules for the round

- Every finding is treated as real until the fixing agent shows otherwise from the code. A finding judged not a bug is reported with the code that rules it out, not skipped silently.
- The rules of the 2026-11-20 round apply unchanged: Check Notebook is the oracle; shared text changes only through the host; destructive steps fail closed; a committed host change is never taken back; no battery drain (no new polling loops or fixed-interval timers; unavoidable timers reschedule themselves, are scaled on battery, unref'd and stop when idle; capped backoff that resets only on progress; no full walks or whole-file hashes where the affected paths suffice).
- Test first: each finding gets a test that fails on the round branch before the fix, unless the agent explains why the harness cannot show it.
- Tests: each agent runs only its own new test file and the few existing files that pin the behaviour it changes, one foreground process at a time. No full suites, builds, lint, `tsc`, e2e or browser checks inside agents (8 GB machine). Type-check, lint and the full suites run centrally after merging.

## Decisions taken in triage

- **A lapsed writer lease is not follower mode (C1).** While a writer's lease has lapsed, the runtime stops touching the disk and defers manifest passes; it never rebuilds its layout the way a follower does. The deferred pass runs when the lease is confirmed again.
- **The layout records only what the manifest accepted (C4, M10, M23).** A file enters `state.layout` when its manifest entry is written, a removal leaves it only once it is archived, and a failed or cancelled manifest write rolls the layout back. Path retirements and transition-log rows that come from local manifest edits are recorded once the server has the edit, never for a pass that is rolled back.
- **An album never deletes bytes the shared album does not have (C4, C8).** Before an album's `archive()` removes a file, the file's hash must be one of that entry's known blob hashes; otherwise the file stays on disk and the scan treats it as the user's.
- **An uncertain binary copy is the user's edit (C8).** Only a strict stale copy (an earlier hash with its own recorded mtime) is put back. Any other changed binary is shared as the user's new version, never reverted.
- **Deleting one file never revokes the notebook (C10).** The server reports a deleted document to a member as `document-deleted` on every path. On the client a file document's closed reason stays per document; only the manifest hub or a membership check from the server can revoke the whole project.
- **An owner is never treated as a removed member (C11).** If the server cannot be reached the owner's revocation is retried later. Album cleanup that cannot tell which photos are the user's own deletes nothing.
- **A definitive 404 ends a project locally (C3).** Only a confirmed 404 records the terminal lifecycle outcome (`local` for an owner, `revoked` for a member). Network errors and 5xx change nothing.
- **A `not-open` reject is transient (C6).** Only a definitive reject of a live document rolls back local work; a document closed as revoked or deleted keeps its text for export.
- **An update that cannot be cut blocks its subdoc (C12).** Later updates of that subdoc are held, not sent past the gap.
- **Takedown fails closed (C5).** If any text document, PDF or comment store cannot be exported in full at the fence, takedown stops before the server deletes the project. The server requires an active fence for a delete that carries recovery data.

## Packages

Agents: Sonnet, one worktree each, reset to `fix/three-way-sync-audit` before starting. Up to 14 may run at once (the user, 2026-11-23), each testing only its own files. The 11 packages without an "After" entry start together; MV, SC2 and PR2 start once their prerequisites are merged. Ownership is by function inside shared files (`electron/collab/notebooks/project.ts`, `service.ts`, `core/doc-hub.ts`, `core/store.ts`, `src/lib/collab/shared-notebook.ts`).

| Package | Findings | Owns | After |
|---|---|---|---|
| WR writer runtime and manifest follow | C1, C4, H2, M10, M23 (layout, retirement and transitions before acknowledgement) | `project.ts`: `follower`, `leaseConfirmed`, `resumed`, entry and layout bookkeeping of `applyManifestPass` (not its move loop), `followManifest`, `archiveRemoved`, the layout insertion in `createFromDisk` and `createFileEntry`, rollback around `writeManifestOperations`, `manifestReady`, `docReady`, the `rebuilt` flags in `start` and `ensureDoc`, the manifest observer's `retirePath` call and `recordTransitions`; in `service.ts` only the call that tells a runtime its lease was renewed | |
| SC1 scanner reads and deferral | C9, H4, H9, M8, M19, L2 | `scan-reads.ts`, `scan-fairness.ts`, `fs-ops.ts` `readIfExists` and `mayStillBeCopying`; `project.ts` `ownWritesOnly`, `startScan`, the read, defer and missing-file hold logic of `scan`, `stripForUpload` and the error handling of its callers in `scan` and `createFromDisk` | |
| K1 doc hub server path | C6, C7, H13, M11 | `core/doc-hub.ts` `handleReject`, `rollback`, `applyServerUpdate`, the persist path of `onDocUpdate`, `processOpened`, the resync timer and open correlation; `core/sync-client.ts` `sendOpen` result | |
| RV revocation | C3, C10, C11, H3, M16 | `service.ts` `revoke`, `doRevoke`, `repairMissingMarker`, `projectGone`, `takeAlbumAway`, `runAlbumCleanup`, `retryAlbumCleanups`; `project.ts` the per-document `onMeta` subscription in `ensureDoc` and `metaChanged`; `core/doc-hub.ts` `handleClosed`; `core/host.ts` `restoreProjectAccess`; server `sync/session.ts`, `sync/server.ts` close and reject reasons, `auth/access.ts` | |
| SC2 scanner classification | C8, H8, M7, M22 | `project.ts` the binary stale and uncertain branch of `scan`, the S43 `emptied` block, transcript companion pairing in `scan`, `takeExternalEdit`, `archive` (album guard), `placeBlob`'s decision to displace | SC1 |
| K2 outbound queue | C12, H11, H12, M12 | `core/outbound.ts`; `core/doc-hub.ts` `pendingCount`, `statusInputs` and the quarantine notice; `core/store.ts` `createBatch` and `docsWithUnacked` | |
| TD takedown export and PDF | C5, H18, H20 | `project.ts` `preserveLatestText`, `prepareLocalConversion`, `exportCommentStores`, `catchUpWithFence`, `whenIdle`; `pdf-marks.ts`; `pdf-comments.ts`; server `api/projects.ts` delete; `src/lib/storage/shared-source.ts` | |
| CT control plane, sleep and leases | C2, H1, H16, H19, H28, M1, M13 | `control/runtime.ts`, `control/databases.ts`, `control/account.ts`, `adapters/utility.ts`; `core/store.ts` callers of `ownsDatabase`; `service.ts` `lease`, `tick`, `resumed`, `checkLease`, `keepsWriting`, `releaseLease`, `beforeAccountChange` | |
| PR1 project registration races | H17, H26, H27, M4, M23 (stale paths and transitions after rejoin), M25 | `service.ts` startup locking in `loadStoredProjects`, `run`, `finishJoin`, `shareAttempt`, `adopt`, the revoked-project case of `adoptMarkers`, `stop`, `accountChanged`, `locked`; `core/store.ts` `deleteProject` and clearing helpers for adoption fences, retired paths and hashes, manifest paths and transitions | |
| PR2 bindings, markers and root transitions | H5, H6, L1, M2, M24 | `src/lib/collab/local-notebook-state.ts`; `shared-notebook.ts` `effectiveMarker`; `service.ts` `matchesMarker`, `movedRoot`, `rebindMovedRoot`, the rebind branch of `loadStoredProjects`, identity checks in `adoptMarkers`; both `root-transitions.ts`; `lifecycle-reservation.ts` | PR1 |
| MV moves, case and respells | H7, M6, M9, M20, L3 | `project.ts` the move loop and `occupied` set of `applyManifestPass`, staged moves, empty-folder pruning, the path comparison before `retirePath` in the manifest observer and `followManifest`, `fileOp` rename and delete batching, `noteRemoteRespells` and the respell block of `scan`; `move-journal.ts`; `manifest-intents.ts` | WR |
| K3 host, registry, divergence, locks | H10, H14, H15, M5, M14, M17, L4, L5 | `core/host.ts` `connectAccount` and `syncPendingDocs`; `core/registry.ts`; `core/divergence.ts`; `core/store.ts` `OwnerLock` (`removeStale`, `touch`), `retirePath`, the constructor; `core/pending-commands.ts`; `core/sync-client.ts` `nudge` and the ping timer | |
| NX1 Next shared writes and identity | H21, H24, H25, M15 | `src/lib/collab/shared-writes.ts`, `tree-file-ids.ts`, the manifest-path comparisons in `src/lib/storage/tree.ts`, `src/app/api/files/batch/route.ts` | |
| NX2 Next guards, record follow-up, state and fs edges | H22, H23, L6, M3, M18, M21 | `markdown-assets.ts`, `src/app/api/python/run/route.ts`, `shared-notebook.ts` `splitLiberaPath` and `sharedNotebookMarker`; `shared-record-follow.ts`; `electron/collab/notebooks/transition-log.ts`; `state.ts`; `fs-ops.ts` `moveExclusive`, `writeFileExclusive` and the claim fallback | |

RV and K2 run next to WR and K1 with function-level ownership (`ensureDoc` and `doc-hub.ts` are split by function); neither waits for the other.

Known failures on `main` that a package may fix: `albums-host` "when access ends, the member keeps the photos they added" (RV), `audit-1119-fs-exclusive` "movePathExclusive refuses a folder onto an existing folder" (NX2, M18), `audit-1119-writer-pass` "finding 29: a move that cannot stage keeps the old path until it can" (MV, M6).

## Results

To be filled in as packages merge.
