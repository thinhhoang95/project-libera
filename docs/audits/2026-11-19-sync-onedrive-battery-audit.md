# Sync, OneDrive and battery audit: triage and fix plan (2026-11-19)

Source: a static Codex review of `main` at `23b8925` that cross-checked the earlier sync audits
([2026-11-12](2026-11-12-codex-onedrive-sync-audit.md) and the 2026-11-01 reviews) against the
current code. 43 findings: 12 P1, 23 P2, 8 P3. OneDrive delivery timing, PostgreSQL concurrency
and power use were not measured. The findings are reproduced verbatim at the end of this file.

## Triage

Every finding is treated as real until the fixing agent shows otherwise from the code. The P1s
group into four failure modes:

- **Identity drift**: a path is trusted where a file id or content hash should be (1, 4, 9, 12, 19, 25).
- **Stale baseline wins**: an older cache, tab or job overwrites newer bytes (2, 9, 11, 21).
- **Lost acknowledged work**: an edit is acknowledged or exported after it was dropped (6, 7, 8).
- **Irreversible local state from a transient condition**: a tombstone or deletion that a rollback cannot undo (3, 12).

Design-heavy items, where the fix shape matters more than the patch:

- 5 (concurrent rename and blob replacement on one manifest key). Changing the entry
  representation is a protocol change. The preferred fix keeps the wire format: the host records
  each field it changed (path or hash, from → to) until the server has the result, and after a
  merge re-applies a change that a concurrent whole-entry write reverted. Done last (round C),
  on top of every other manifest change.
- 6 and 7 (pipeline failure and rollback acknowledgement). The server must tell "depends on an
  update I failed to store" apart from "malformed", and the host must never acknowledge a renderer
  sequence it did not integrate.
- 8 (takedown). Needs a server-side write fence over text, PDF marks and comments, not only the
  manifest sequence.
- 32 (PostgreSQL lock order). Tests run on PGlite (single connection), so the fix is a static,
  documented lock order; it cannot be reproduced in the test suite.

Shared primitive added before the round (integration branch): `movePathExclusive` and
`writeFileExclusive` in `electron/collab/notebooks/fs-ops.ts`, built on the existing hard-link
publication. Packages that need "never replace the destination" (4, 16, 17, 9) use these.

## Packages and rounds

Agents: Sonnet, one worktree each, at most 6 at once, targeted tests only. Ownership is by
function inside the shared files (`project.ts`, `service.ts`, `doc-hub.ts`, `shared-writes.ts`).

| Round | Package | Findings | Owns |
|---|---|---|---|
| A | P1 core pipeline | 6, 7, 43 | `core/doc-hub.ts` receive/ack and rollback paths, `core/outbound.ts` window and retry, `core/sync-client.ts`, `client/replica.ts` durability, server `sync/session.ts`, `sync/room.ts` |
| A | P2 writer pass | 3, 4, 29 | `project.ts` `applyManifest`, `followManifest`, `archiveRemoved`; `move-journal.ts`; `doc-hub.ts` tombstone and reopen gate |
| A | P3 host identity ops | 1, 13, 20, 25 | `project.ts` `fileOp`, `takeStaged`, `createFileEntry`, `assertFree`, `resolveOrRefuse`; `shared-writes.ts` rename/delete/create; `layout.ts` collision layout |
| A | P7a scanner correctness | 12, 19, 22, 28 (scan parts), 34 | `project.ts` `scan`, `archive`, `stripForUpload`, `isLateCopy`, `retirePath`, `conflictCopyOf`, `createFromDisk`; `scan-reads.ts` read validation; `service.ts` initial-share reads; name rules in `schema.ts`/`paths.ts` |
| A | P9 PDF and ink sidecars | 10, 14, 15, 21, 41 | `annotations.ts`, `references.ts`, `paths.ts` state root, `ink.ts`, `pdf-sidecars.ts` (+ route), `forward-search-changes.ts`, `pdf-marks.ts`, `pdf-comments.ts` |
| A | P10 local writes | 9, 11, 16, 17 | `files.ts` save, folder rename/archive; `transcripts.ts` save/segments; `transcription/jobs.ts`; `sidecar-lifecycle.ts`; `fs-utils.ts`; `sidecars.ts`; workspace save path |
| B | P5 leases | 31, 40 | `service.ts` tick, renewal, discovery; `project.ts` `diskGuard`; server lease claim |
| B | P6 share and takedown | 8, 18, 32, 33 | `service.ts` share and takedown; `project.ts` `prepareLocalConversion`, `preserveBinariesAfterTakedown`, `preserveLatestText`; `fs-ops.ts` share walk; server takedown and manifest-update transactions; `outbound.ts` oversized handling |
| B | P7b scanner liveness and battery | 30, 37, 38 (scan) | `scan-reads.ts` pool, `fs-ops.ts` `contentGuard`, `project.ts` `doStop`, watcher and poll pacing, tracked-file budget in `scan` |
| B | P8 promotion and materialization | 2, 23, 28 (materialize part), 38 (placement), 39 | `project.ts` `open`, `isMaterialized`, `await*`, `placeBlob`, `materializeDoc`..`takeExternalEdit`, `saveSoon`, `hubHasState` |
| B | P11 UI refresh and battery | 24, 36, 42 | `tree-changes.ts`, workspace tree fetch and move retargeting, `tree.ts`, `use-voice-memo.ts`, transcript route and freshness |
| B | P12 authoritative exports | 26, 27 | `download.ts`, `shared-source.ts`, `shared-writes.ts` copy, `markdown-assets.ts`, audio copy, `latex/build.ts` |
| C | P4 manifest merge and validation | 5, 35 | `layout.ts` entry parsing, manifest write paths in `fileOp`, server `sync/validate.ts` |

Each round starts from the merged result of the previous one (`fix/sync-audit-1119`).

## Round A results (merged)

All six branches merged into `fix/sync-audit-1119`; one textual conflict (an import line in
`project.ts`). After merging, root `tsc` found only test-typing errors (fixed), server `tsc` was
clean, and eslint on every changed file found one unused import (removed) and one warning that
already exists on `main`. The full suites have not been run yet.

| Package | Status | Gaps carried forward |
|---|---|---|
| P1 (6, 7, 43) | fixed | The server gates updates after a failed write instead of adding a new reject reason (older hosts could not decode one); resends follow the existing backoff with no attempt cap. |
| P2 (3, 4, 29) | fixed | `markDeleted` now means a server-confirmed deletion only. A pending move is the record keeping its old path plus the move journal; `materializeDoc` can still write a doc at its old path while its move is pending (P8). A doc edited externally and renamed before the scan sees the edit stays at the old name and is imported as a new file. |
| P3 (1, 13, 20, 25) | 1 and 13 partly | 1: host and routes accept `expectedFileId`, but tree nodes carry no file id, so the UI sends none (P11). 13: the bibliography tether and per-file records under a renamed shared folder are not moved (P4). 25: a create refused in the race window leaves an orphan server document or blob. |
| P7a (12, 19, 22, 28, 34) | fixed (19: rename + edit still gives two entries) | `manifestNewNameError` (room for sidecar suffixes) is used by the scan only; whether `fileOp` creates and the server enforce it is open (P4). A late copy whose bytes match no retired hash is now imported, not archived. |
| P9 (10, 14, 15, 21, 41) | 10, 14 and 21 partly | 10: the revision check is a narrow window, not an atomic compare-and-swap. 14: pending PDF moves are in memory only; the audio route gets chunking and retry but no pending-move replay (`transcripts.ts`, P12). 21: authors with no ink file on this disk yet are not merged (P12, now possible with the listing). |
| P10 (9, 11, 16, 17) | 17 partly | 9: after a 409 the tab keeps its draft, but every save is refused until the tab's saved text is refreshed from disk (P11). 11: a job finishing after the user's edits ends in error and its result is dropped. 17: rollback is in memory; a crash mid-move is not resumed. |

Added on the integration branch between rounds: `GET /projects/:id/file-entries`
(`listEntries` in `project.ts`, `listProjectEntries` in `host-client.ts`, `listSharedEntries` in
`shared-writes.ts`) — the manifest's entries at the layout's paths, read without the disk or the
project queue. Round B uses it for tree file ids, ink authors and downloads.

## Round B plan (adjusted after round A)

| Package | Findings and carried gaps |
|---|---|
| P5 leases | 31, 40 |
| P6 share and takedown | 8, 18, 32, 33 |
| P7b scanner liveness and battery | 30, 37, 38 (scan side) |
| P8 promotion and materialization | 2, 23, 28 (materialize part), 38 (placement), 39; skip docs whose move is pending (P2 note) |
| P11 UI tree identity and refresh | 1 (UI side: tree nodes in shared notebooks carry the listed file id; rename/delete send it), 24 (retarget by file id), 36; after a refused save, refresh the tab's saved text from disk and keep the draft |
| P12 authoritative reads | 26 (list from `listSharedEntries`), 27, 42; 21 gap (enumerate ink authors from the listing); 14 gap (audio pending-move replay in `transcripts.ts`) |

## Round B results (merged)

No textual conflicts. After merging: root and server `tsc` found two errors (the closing
response's document kinds, and a `Buffer` type on shared image bytes), both fixed; eslint found
one unused binding (fixed). Two detached test harnesses needed a stub for the new catch-up gate.

| Package | Status | Notes and gaps |
|---|---|---|
| P5 (31, 40) | fixed | Discovery runs on its own timer every 2 × lease TTL (×battery scale), so a folder arriving through OneDrive is adopted within ~2 min (~8 on battery), not 20 s. A refused follower re-contests near the holder's expiry; after a clean release the takeover waits for that expiry (up to ~60 s). The server writes the contention timestamp once. |
| P6 (8, 18, 32, 33) | fixed | 8: `POST/DELETE /projects/:id/closing` fence (migration 011); takedown needs a server reporting `takedownFence`. Text documents never opened on the owner's device are still not exported (unchanged). Added centrally: the fence lapses after an hour, a lapsed fence cannot delete, a retried takedown renews it. 18: linked folders are not covered (they cannot be shared). 33: share returns 503 `share-unfinished` instead of success with `synced: false`. |
| P7b (30, 37, 38) | fixed | `contentGuard` gives up after 10 s, so a very large file on a slow drive retries its placement instead of blocking. An own-write is recognised by size and mtime only. |
| P8 (2, 23, 28, 38, 39) | fixed | A writer does no disk work until the manifest and the document have had the server's `opened` in this runtime. Added centrally: the writer's scan waits for the same catch-up. `state.json` can lag a text flush by ~2 s. |
| P11 (1, 24, 36, 9 follow-up) | 36 partly | Tree nodes in shared notebooks carry the listed file id (blobs only when the size matches); rename and delete send it. Moves in one event are one simultaneous mapping. A refresh reads only the affected notebook without sidecar maintenance; there is no cheap signature to skip the fetch, and full refreshes still run maintenance. Host `tree-changed` moves carry no file id yet (round C). |
| P12 (26, 27, 42, 21 gap, 14 gap) | fixed | A shared notebook's ZIP and LaTeX build fail with an error when the host is up but cannot list or read, instead of falling back to disk. New `GET /api/transcripts/progress`. |

Also fixed centrally: a literal NUL byte (a key separator in `pdf-sidecars.ts` from round A) that made git treat the file as binary.

## Round C plan

Three agents:

| Package | Findings |
|---|---|
| P4a concurrent manifest field changes | 5 |
| P4b manifest validation and unresolvable entries | 35; whether new names must pass `manifestNewNameError` in `fileOp` and on the server |
| P4c shared rename leftovers and tree event ids | 13 leftovers (bibliography tether, per-file records under a renamed shared folder); file ids in host `tree-changed` moves |

## Round C results (merged)

No textual conflicts. Central `tsc` found one error (a `Y.Map` passed where a `ReadonlyMap` was typed), fixed.

| Package | Status | Notes and gaps |
|---|---|---|
| P4a (5) | fixed | `writeManifest` records every field change it makes (path; blob hash with size and mime) as an intent; after a merge, the host whose change lost re-applies it on top of the merged entry. No wire-format change. Intents live in memory (lost on restart), are dropped once acknowledged and confirmed, and expire after 6 h; an offline write from another device arriving after that is decided by the merge as before. |
| P4b (35) | fixed | One entry-shape check (`manifestEntryShapeError`) for the desktop parser and the server. The server rejects a changed entry whose new `docId` is not a document of this project (or of another kind) or whose new `blobHash` was not uploaded to this project. Clients already upload or create before writing the entry. An unfetchable blob backs off (to 5 min) and is reported once instead of being retried every 5 s. New and renamed names must leave room for sidecar suffixes, in `fileOp` (400) and on the server (new or renamed entries only). |
| P4c (13 leftovers, event ids) | fixed | The tether already followed single-file renames through the reference "moved" event. A shared folder rename now moves every contained file's local records, reviews and reference attachments, and reports (after the rename) any record it could not move. Host `tree-changed` moves carry `fileId`. |

## Findings (verbatim from the review)

### Highest risk for data and file identity

1. [P1] A stale OneDrive tree can make Rename or Delete act on a different file. The UI can still show file A at a path the server has reassigned to file B. The shared rename and delete handlers send only the path. The host resolves it against the latest manifest and acts on B. The host already accepts an expected file ID, but these callers omit it. `src/lib/collab/shared-writes.ts:644` (shared rename) · `src/lib/collab/shared-writes.ts:665` (shared delete) · `electron/collab/notebooks/project.ts:2484` (host identity check)
2. [P1] A new writer can overwrite a newer OneDrive copy with its older SQLite cache. A writer lease permits disk work before the manifest and text hubs have caught up with the server. Cached state qualifies as ready. If OneDrive already delivered a newer file and its matching bookkeeping, the older hub can treat those bytes as its baseline and replace them. Both text and blobs have this exposure. Require a caught-up baseline before a newly promoted writer starts materializing. `project.ts:374` (runtime startup) · `project.ts:3010` (readiness check) · `project.ts:1359` (text materialization) · `project.ts:1061` (blob placement)
3. [P1] A rejected shared delete can permanently lock a live document on that device. The writer and follower both mark a document deleted as soon as it disappears from their local manifest. That includes an optimistic delete the server may refuse after a role change. A manifest rollback can restore the entry, but the persisted document tombstone prevents the hub from reopening it. A stale cached manifest missing an entry that already arrived in OneDrive bookkeeping can trigger the same outcome. `project.ts:790` (writer removal) · `project.ts:929` (follower removal) · `electron/collab/core/doc-hub.ts:949` (persisted tombstone) · `doc-hub.ts:747` (reopen gate)
4. [P1] A shared move can stage the wrong source or overwrite a newly delivered destination. The two-phase move stages whatever currently occupies the old path, without checking that those bytes belong to the entry being moved. If OneDrive has already reused the old name, the host can move the replacement into the original file's new location. Final placement also uses a replacing rename after a separate destination check. A file arriving in that gap can be overwritten. `project.ts:806` (source staging) · `project.ts:840` (destination placement) · `electron/collab/notebooks/fs-ops.ts:278` (rename primitive)
5. [P1] Concurrent rename and binary replacement can silently undo each other. Each operation writes a complete JSON entry into the same Yjs map key. Two devices can independently change the path and the hash of the same file. On merge, one entire entry wins, so a successful rename can restore the old hash or a successful upload can restore the old path. The host's checks only cover changes that host has already seen. `electron/collab/notebooks/layout.ts:52` (manifest representation) · `project.ts:2539` (blob update) · `project.ts:2565` (rename update)
6. [P1] A transient server write failure can turn later valid edits into a permanent rejection. The client pipelines batches. When the first batch fails to persist, the server reports a retryable error and continues processing the queue. A later batch that depends on the missing first batch can then receive `invalid-update`. The host rolls back the whole subdocument and removes its pending queue. The recovery copy can preserve text, but automatic sync has discarded the edits. `electron/collab/core/outbound.ts:370` (outbound window) · `server/src/sync/session.ts:358` (server failure handling) · `server/src/sync/room.ts:164` (dependency rejection) · `doc-hub.ts:840` (host rollback)
7. [P1] The host can acknowledge a renderer edit it dropped. During rollback, a renderer can still send an update based on the previous document state. The host discards the unresolved portion and sends an error, then the outer handler acknowledges the sequence anyway. The renderer uses that acknowledgement to clear its unsaved state. Edits made after the rollback snapshot can consequently be absent from both SQLite and the recovery copy. `doc-hub.ts:492` (unconditional acknowledgement) · `doc-hub.ts:538` (dropped dependencies) · `src/lib/collab/client/replica.ts:353` (renderer durability tracking)
8. [P1] Takedown can delete the server's latest text, PDF marks, or comments before they are exported. The pre-delete barrier exports blobs and checks only the manifest sequence. A text edit, PDF mark, or comment can commit independently of that sequence while takedown is in progress. The host preserves its local text and PDF state after server deletion, so a late change can be absent from the exported copy. Takedown needs a snapshot or write fence that covers those authorities too. `project.ts:566` (pre-delete export) · `electron/collab/notebooks/service.ts:1251` (takedown order) · `server/src/api/projects.ts:200` (server deletion fence)
9. [P1] A local note save can overwrite a newer OneDrive version. The save request carries a path and replacement text, with no version identifying what the editor opened. Storage writes directly to the path. A stale tab can overwrite newer bytes or, for some text types, recreate the old name after a move. The in-place write also exposes an intermediate file to the provider. `src/components/libera/use-libera-workspace.ts:3096` (editor save) · `src/lib/storage/files.ts:157` (local storage write)
10. [P1] OneDrive can carry lock files whose ownership is interpreted using the wrong machine's PID. PDF sidecars and reference libraries use lock files in the synced library and test the recorded PID on the local machine. A remote lock can look abandoned or appear held by an unrelated local process. Two devices can also acquire separate local copies of the lock before either arrives through OneDrive, then publish competing whole-file JSON updates. Keep process locks local and give cross-device records a version or merge policy. `src/lib/storage/paths.ts:174` (state root) · `src/lib/storage/annotations.ts:503` (PDF lock) · `src/lib/storage/references.ts:105` (reference lock and revision check)
11. [P1] Retranscription and stale transcript edits can erase newer corrections. A transcription job checks the recording's bytes, then saves without a transcript version precondition. It can replace hand edits made while the job ran. The segment editor sends the entire list from its displayed version. The server rereads the latest transcript, then replaces its segments with that older list, so the existing upload precondition still allows the overwrite. `src/lib/transcription/jobs.ts:195` (job save) · `src/lib/storage/transcripts.ts:181` (optional version check) · `src/lib/storage/transcripts.ts:266` (segment replacement)
12. [P1] Shared album scanning can delete or overwrite a legitimate photo. A genuinely new photo copied under a retired name can retain an older modification time and be classified as a late copy. For albums, the archive operation deletes the file. Separately, routine metadata stripping replaces the photo from previously read bytes without a content guard, before the scan checks whether the file has settled. `project.ts:2254` (late-copy classification) · `project.ts:1115` (album deletion) · `project.ts:1222` (metadata rewrite)

### Missing sidecars and path mismatches

13. [P2] Shared renames omit records that local renames carry. The shared path handles ink, transcript companions, and selected PDF/audio records. It omits path-derived Python sidecars, image annotations, definitions for non-PDF files, and the reference attachment and bibliography tether updates used by local moves. For example, a renamed Markdown note's Code action computes the new Python path while the manifest still holds the script under the old one. `shared-writes.ts:650` (shared rename) · `files.ts:240` (local record updates) · `src/app/api/python/run/route.ts:14` (Python lookup)
14. [P2] PDF and audio sidecars can miss a move permanently on a follower. A renderer forwards each move once. The copy requires the destination's bytes to be present and match, so a delayed OneDrive delivery makes the first attempt fail. Later arrival events do not replay the move, and shared PDF reconciliation skips active-path reattachment. The sidecar endpoints also reject batches above 500 changes, while the renderer sends the full batch and ignores the response status. `src/components/libera/collab/forward-search-changes.ts:31` (event forwarding) · `src/lib/storage/pdf-sidecars.ts:106` (PDF move check) · `pdf-sidecars.ts:236` (shared reconciliation) · `src/app/api/pdf-sidecars/route.ts:21` (batch limit)
15. [P2] Reusing a PDF's name can attach the old PDF's notes to the replacement. The local readers load marks and comments by path without checking the stored PDF identity. Shared removals leave the old sidecar in place. The live importer also reads by path and can submit old marks and comments to the new PDF document. An optional source hash can flag mismatched marks later, but it does not gate import, and legacy sidecars may lack it. `annotations.ts:551` (local PDF readers) · `pdf-sidecars.ts:106` (shared removal handling) · `electron/collab/notebooks/pdf-marks.ts:388` (live sidecar import)
16. [P2] Sidecar transfers can still replace a destination that appears during the transfer. `copyLifecycleSidecar` checks for a free destination, then uses a replacing rename. Local `moveWithoutReplacing` checks for records and subsequently removes the destination. A save or cloud arrival between those operations can be overwritten or removed. These need exclusive publication at the filesystem operation itself. `src/lib/storage/sidecar-lifecycle.ts:9` (shared sidecar copy) · `fs-ops.ts:251` (atomic replace) · `src/lib/storage/fs-utils.ts:114` (local sidecar move)
17. [P2] A local folder rename or archive can leave half its records at the old path. The physical folder moves first. Sidecar directories, Python code, reviews, references, and metadata follow in separate operations. A locked or newly occupied sidecar destination can stop the sequence after the folder and some records have already moved. The operation needs a resumable journal or a rollback covering the full move. `files.ts:555` (folder rename) · `files.ts:634` (folder archive) · `src/lib/storage/sidecars.ts:215` (sequential sidecar moves)
18. [P2] Transcripts are stranded when a notebook enters or leaves sharing. Initial share skips the hidden directory holding existing local transcripts, with no conversion to shared `.transcript` companions. Takedown exports companions as ordinary blobs, then removes the sharing marker. The local reader subsequently looks only in the hidden sidecar directory, so the newest transcript can be on disk and disappear from the UI. `fs-ops.ts:555` (share walk exclusions) · `project.ts:579` (blob export) · `service.ts:1318` (marker removal) · `transcripts.ts:44` (transcript path selection)
19. [P2] External rename detection can move the wrong identity and leaves audio companions behind. The scanner pairs a missing file with the first new compatible file with the same hash. A delayed original and an intentional byte-identical copy are enough to make it infer a rename. A real rename combined with an edit fails the match and can produce two entries. When an external audio rename does match, the branch moves ink and omits the transcript companion. `project.ts:2127` (rename inference and companion update) · `project.ts:2584` (explicit audio rename)
20. [P2] Shared extension changes can strand a document or remove its records. The shared rename changes the path while retaining the document or blob kind. A Markdown document renamed to a supported binary extension can become a text document served to the wrong viewer. The same branch removes ink when the extension changes and can remove the transcript when audio becomes another type. It lacks the local move's record-loss preflight. `project.ts:2565` (shared rename and cleanup) · `files.ts:233` (local type-change guard)
21. [P2] Shared ink can be current while its visible SVG is stale. Ink saves merge the current author's blob from the host, but read other authors' strokes from disk. A follower can generate an SVG missing strokes the server already has, then replace the shared rendering without a version precondition. The stroke data survives while previews and exports show an incomplete drawing. `src/lib/storage/ink.ts:323` (ink merge) · `ink.ts:371` (rendering publication)
22. [P2] The manifest and filesystem-facing routes disagree on valid names. Disk scans compare raw paths while manifest collision checks use case-folded NFC keys. The storage routes also trim segments that the manifest accepts with leading whitespace. A cloud-delivered alternate spelling can be treated as a move or routed to another name. Files at the manifest's segment limit can also exceed it when `.transcript` or `.json` is appended. `project.ts:1887` (scan comparisons) · `src/lib/collab/protocol/schema.ts:255` (manifest rules) · `paths.ts:52` (storage normalization) · `paths.ts:251` (sidecar naming)

### Stale views, false success, and recovery

23. [P2] Followers can miss late delivery and still report materialization complete. The initial manifest skips arrival tracking. Later tracking expires after ten minutes without a refresh on timeout. For same-path blob replacements, one hash probe is remembered by size and mtime, so a later delivery with the same observed stats can be missed. `isMaterialized()` also returns true for a follower once the manifest is ready, regardless of disk contents. `project.ts:972` (arrival tracking) · `project.ts:986` (hash probe and expiry) · `project.ts:673` (materialization status)
24. [P2] A batch of moves can retarget open tabs and unsaved records to the wrong file. The UI treats moves in the same event as a sequential chain. A swap can collapse to nothing, and two distinct files moving through the same name can collapse to one destination. Retargeting also moves unsaved ink and annotations by path. A destination fetch that fails during cloud lag gets no move retry. `src/lib/collab/ui/tree-changes.ts:32` (move collapsing) · `use-libera-workspace.ts:3729` (unsaved-record retargeting) · `use-libera-workspace.ts:3781` (one-shot destination lookup)
25. [P2] Concurrent creates can return another user's file as the result. If a path becomes occupied during document creation or a blob upload, `createFileEntry` can return the newly created entry anyway. Its caller publishes it under the requested name and returns that name. The layout can suffix the new entry, while the returned path still opens the existing file. Return the created ID and resolved path, or surface the conflict before publishing. `project.ts:2666` (create collision check) · `project.ts:2494` (create response) · `layout.ts:125` (collision layout)
26. [P2] Notebook downloads can omit current files or include deleted ones. ZIP creation enumerates the working directory first and asks the host for bytes only for paths found there. A new shared file absent from the follower's disk is omitted. A deleted or renamed path still on disk can be included by the disk fallback when the host reports the entry absent. The export needs an authoritative list of entries as well as authoritative bytes. `src/lib/storage/download.ts:22` (ZIP traversal) · `src/lib/storage/shared-source.ts:19` (authority fallback)
27. [P2] Copy and build operations can mix current content with stale dependencies. Markdown copying fetches live text but reads its image assets from disk. Audio copying can commit the new shared recording and then fail when it tries to stat the destination before OneDrive delivers it. LaTeX compilation stages editor drafts but still resolves unopened inputs and bibliography files from the working folder. Each can produce an incomplete result from a mixture of revisions. `shared-writes.ts:749` (shared copy) · `src/lib/storage/markdown-assets.ts:566` (asset reads) · `transcripts.ts:308` (audio copy) · `src/lib/latex/build.ts:263` (LaTeX source staging)
28. [P2] The quiet-period safeguard can be bypassed during import. Text materialization can call external-edit adoption directly on bytes it just read, bypassing the scanner's quiet-period check. In the scanner, the read helper compares byte length with the earlier observation but does not re-stat after the read. An existing blob can also change again during upload, since publication checks the manifest hash and omits revalidation of the disk snapshot. `project.ts:1359` (text materialization) · `electron/collab/notebooks/scan-reads.ts:49` (scan read validation) · `project.ts:2019` (blob upload and publication)
29. [P2] A failed move or archive can leave a stale path with no reliable retry. When staging fails, the layout can advance to the desired path while retaining the previous hash. A placement failure can leave staged bytes hidden until a writer restarts. An archive failure can abort the entire manifest pass before its retry is scheduled, leaving later entries waiting for unrelated activity. A pending materialization state would let retries distinguish these cases from completed work. `project.ts:818` (move failure handling) · `project.ts:870` (layout advancement) · `project.ts:790` (archive loop) · `electron/collab/notebooks/move-journal.ts:71` (journal recovery)
30. [P2] A stalled provider can block a project queue, and stalled reads can block every notebook's scanner. Some initial reads are bounded, but final content guards and recovery still await provider reads directly. Stopping waits for the project queue. The scan read pool is process-wide, and its four slots remain occupied until the underlying reads settle even after callers time out. Four hung reads can therefore make unrelated notebooks defer indefinitely. `fs-ops.ts:195` (content guard) · `project.ts:492` (shutdown wait) · `scan-reads.ts:34` (global read pool)
31. [P2] Discovery and recovery can still make healthy writer leases expire. The service runs stored-project discovery before renewal and waits for every worker and marker-adoption pass before permitting another tick. A slow provider call or recovery operation can hold the global tick past the lease lifetime, even for otherwise healthy projects. The disk guard also checks lease eligibility before awaiting the marker, allowing it to expire during that check. `service.ts:593` (lease tick) · `service.ts:820` (marker discovery) · `project.ts:439` (disk guard)
32. [P2] PostgreSQL has a lock-order deadlock between takedown and a manifest update. Guarded takedown locks the manifest row and later cascades deletion to memberships. An incoming manifest update locks its membership row first, then needs the manifest row. Each transaction can wait for the other, forcing PostgreSQL to abort one. Use a consistent order across both paths. `server/src/api/projects.ts:205` (takedown transaction) · `server/src/sync/store.ts:132` (update transaction) · `server/src/db/migrations/001_initial.sql:41` (membership cascade)
33. [P2] A large share, folder rename, or delete can produce a manifest update that never syncs. These operations can write the whole batch in one Yjs transaction. The outbound queue skips a single update over 4 MiB. Initial sharing still installs the marker and returns after its wait times out with `synced: false`, leaving a locally shared folder whose manifest may be absent on the server. `service.ts:1793` (initial manifest transaction) · `service.ts:1845` (share completion after wait) · `outbound.ts:322` (oversized update handling) · `src/lib/collab/protocol/version.ts:35` (protocol limit)
34. [P2] The live SQLite safeguard covers fresh scan imports only. Initial share reads the main database file even when a WAL or journal is present. A database shared while closed can later be opened and have its main file uploaded by the existing-file branch. The journal family is excluded, so a receiver can get an incomplete or inconsistent database snapshot. `project.ts:2044` (new-file safeguard) · `project.ts:2019` (existing blob upload) · `service.ts:1669` (initial share reads) · `fs-ops.ts:42` (journal exclusions)
35. [P2] The server can acknowledge manifest entries clients cannot resolve. The notebook validator checks path syntax and document ID format. It omits full entry-shape validation and verification that a referenced document or blob belongs to that project and file identity. The desktop may skip the entry or retry downloading indefinitely. Validate those references before accepting the manifest update. `server/src/sync/validate.ts:371` (server validation) · `layout.ts:18` (desktop entry parser) · `project.ts:883` (blob retry)

### Unnecessary battery and background work

36. [P3] One changed file can make every visible window rescan the entire library. A working-copy write emits `files-changed`. Each visible window can then fetch the recursive tree, including archives, on a two-second cadence. The unchanged-result check happens after the fetch, and the tree request also runs sidecar maintenance. Refreshing the affected paths or notebook would avoid most of this work. `tree-changes.ts:90` (refresh cadence) · `use-libera-workspace.ts:601` (full-tree fetch) · `src/lib/storage/tree.ts:358` (tree maintenance)
37. [P3] The writer can trigger a full scan by writing its own working copy. Materialization renames a temporary file onto the live path. The watcher ignores temporary names but schedules a scan for the live path. That scan walks and stats the entire notebook. Battery scaling slows the periodic poll, while watcher-triggered walks retain their normal pace. `fs-ops.ts:251` (atomic write) · `project.ts:1619` (watcher and battery pacing) · `project.ts:1861` (full walk)
38. [P3] Large tracked files escape the scan byte budget, and blob placement hashes the same file repeatedly. The read budget applies to fresh paths. Existing blobs can be read and hashed in full, including files that have grown beyond the upload limit. Placement reads the destination before and after download and rereads it during commit checks. This multiplies disk I/O and can hydrate online-only files unnecessarily. `project.ts:1935` (tracked-file scan) · `project.ts:2044` (fresh-file budget) · `project.ts:1032` (placement reads)
39. [P3] Text materialization rewrites substantially more than the edited file. A text flush writes the working file and full merge base, updates SQLite, and schedules a rewrite of the entire notebook state JSON. Adopting identical disk text still schedules bookkeeping writes. In a OneDrive folder, the extra files also generate provider work. Skip identical writes and checkpoint large notebook state less often. `project.ts:1398` (text write and adoption) · `project.ts:2903` (whole-state save)
40. [P3] Idle followers keep contesting leases on the writer's cadence. The default tick is every 20 seconds and renews or contests leases for each eligible registered folder. It also scans the library and gallery roots for markers. On the server, a refused claim updates the contention timestamp. Followers could schedule their next attempt near the current lease expiry and discovery could run independently. `service.ts:313` (tick cadence) · `service.ts:593` (renewal loop) · `server/src/api/projects.ts:308` (refused-lease write)
41. [P3] Live PDF processing repeats recovery and comment-cache writes. Opening a PDF in a fresh runtime can rewrite the same content-addressed recovery file because the backup writer does not check whether it already exists. Producing a sidecar copy also fetches threads and writes every returned thread to SQLite, even when unchanged. Those costs recur across devices and restarts. `pdf-marks.ts:388` (PDF backup call) · `pdf-marks.ts:513` (recovery write) · `electron/collab/notebooks/pdf-comments.ts:159` (thread cache refresh)
42. [P3] Retranscription progress can hash a long recording every second. The viewer polls the full transcript endpoint during a job. If a prior transcript exists, that endpoint can stream and hash the entire recording to check freshness on every poll. Hash sharing only covers simultaneous requests. A lightweight progress endpoint would remove both the file reads and the repeated transcript payload. `src/components/libera/audio/use-voice-memo.ts:54` (progress polling) · `src/app/api/transcripts/route.ts:16` (full response) · `transcripts.ts:135` (freshness check) · `src/lib/storage/file-signature.ts:39` (hash lifetime)
43. [P3] Some reconnect loops never reach the long-outage backoff. The extended backoff is entered through probes after a connection fails before WebSocket open. If a connection opens but never completes the Libera handshake, retries stay on the short path. A connection that repeatedly welcomes and drops resets the backoff and reopens every registered document each time. Both conditions can cause sustained network and CPU activity on battery. `electron/collab/core/sync-client.ts:388` (handshake timeout) · `sync-client.ts:453` (retry classification) · `sync-client.ts:775` (welcome and document reopen)

Line numbers refer to `23b8925`. Unqualified `project.ts`, `service.ts` and `fs-ops.ts` are under
`electron/collab/notebooks/`; `doc-hub.ts` and `outbound.ts` under `electron/collab/core/`;
`files.ts`, `paths.ts`, `transcripts.ts`, `annotations.ts` and `pdf-sidecars.ts` under `src/lib/storage/`.

## Verification

Full suites on the final branch: editor 3034/3034, server 221/221, collab 808/812 with the last
failure fixed afterwards (below) and its file rerun green, 4 skipped (intermittent, see the
inventory). Root and server `tsc` clean; eslint on every changed file: no errors.

The first full run found three regressions, fixed in code:

- **PDF side-cars on removal** (round A, finding 15): a shared removal set a PDF's notes and
  outline aside, so a refused delete that rolled back (finding 3) lost them. Side-cars now stay
  until other bytes take the name; the readers' identity check covers name reuse.
- **Writer handover after a clean release** (round B, finding 40): a refused follower waited for
  the old lease's expiry. A release now publishes `folder-lease-released` to the account's other
  installations, which claim at once; a live holder is still not contested every tick.
- **Concurrent creates** (round A, finding 25): a create whose name another member took meanwhile
  was refused, losing that document. Both are kept; the answer is the created file's own
  (suffixed) path and id.

## Test inventory

### Broken on `main` before this work (still failing; unrelated to sync)

| File | Tests | Cause |
|---|---|---|
| `scripts/lib/profiles.test.cjs` | 13 (Users IPC, profile creation, removal, switching, startup configs, storage partitions) | The harness loads `electron/main.cjs` in a sandbox without a stub for `createUserFonts`, which 6878b2f (Windows per-user fonts) added: every case throws `ReferenceError`. Needs a user-fonts stub. |
| `scripts/lib/session-shutdown.test.cjs` | 2 ("a failed session save leaves the window and server available for a successful retry"; "a failed pop-out save cancels main closure and leaves every server available for retry") | Expect the save error (`Disk unavailable`, `Annotation disk unavailable`) to surface; it arrives as `undefined`. Either the error path changed or the test is stale; needs a look. |

Pre-existing lint warnings: unused `invite` in `scripts/collab/audit-1112-follower-authority.test.ts`;
missing `refreshTree` dependency in `use-libera-workspace.ts`.

### Skipped as intermittent (opt-in with `LIBERA_COLLAB_INTERMITTENT=1`, since 216340b)

- `scripts/collab/notebooks-boundary-recovery.test.ts:278` — a legacy host's offline edits resume with its original client sequence identity
- `scripts/collab/notebooks-share-lifecycle-recovery.test.ts:209` — terminal text preservation keeps a late external edit and archives the latest shared text
- `scripts/collab/audit/sync-boundary-review.mjs:221` — matching account IDs on separate servers do not reuse local sync authority
- `scripts/collab/audit/sync-edge-cases.mjs:150` — remote takedown preserves text newer than the debounced disk copy

### Flaky under full-suite load

Failed once in the first full run, passed alone (on `main` and the branch) and in the second full run:
`scripts/editor/latex-visual-gaps-text.test.ts` ("boxes, rules, space and symbols in running text are
drawn; \texorpdfstring …") and `scripts/editor/references-editors-source.test.ts` ("textarea: citation
hover uses the shared dismissal rules …").

### Updated because a finding changed the behaviour on purpose (passing)

| Test | Finding | Change |
|---|---|---|
| `review-medium-host` R25 (retype `other.pdf` → `.png`) | 20 | A rename that would drop ink is refused (409); the file and its ink stay. |
| `audit-1112-companions` STALE-2 (`c.m4a` → `.png`) | 20 | Same for a transcript. |
| `ai-shared-writes` folder rename/deletion | 13 (P4c) | The fake host serves the new file-entries route. |
| `audit-1112-follower-authority` DATA-6 | 26 | The export lists from the host; a disk-only file is not exported. |
| `critical-transition-cases` interrupted move | 4 | The edit is imported before the rename (unscanned bytes are no longer staged as the entry's); the injected failure covers hard-link placement too. |
| `sync-followup-edge-cases` eight-version history | 2, 28, 39 | Waits for each adoption and reads the in-memory record (`state.json` is written ~2 s later). |
| `pdf-live-host` F15/F16 | 15 | The fixture records the PDF's real hash (a foreign hash is now never imported). |
| `audit-1112-scan-classification` STALE-7 | 12 | Old-mtime bytes matching no retired hash are imported, not archived. |
| `audit-1112-scan-reads` | 28, 2 | Real mtimes for the post-read re-stat; the detached harness stubs the catch-up gate. |
| `shared-tree-changes` | 24 | Moves in one event are one mapping, not a chain. |
| `notebooks-poll-pacing` | 37 | The detached harness has the fields the own-write check reads. |
| `notebooks-synced-peers` handover | 40 | A tighter wait now that a release is announced. |
| `server/test/sync-documents`, `collab-critical`, `sync-pdf-documents` | 35 | Entries reference real documents and uploaded blobs. |

### New audit tests with weaker evidence

Not seen failing for their own reason before the fix (new exports made the old code fail at
import, or the run stopped at an earlier failure): P10 findings 9 and 11; P7b `contentGuard` and
`doStop`; P8 same-path probe and pending-move cases; P2 finding 29 project-level cases; P6
share/takedown cases; P11 tree-UI cases (the save-409 handler in the hook has no test); P4a merge
cases; P4b's shared-parse case. No test covers the references-library revision check (P9).
`audit-1119-writer-pass` uses `chmod 555`, so its finding 29 cases are POSIX-only.
