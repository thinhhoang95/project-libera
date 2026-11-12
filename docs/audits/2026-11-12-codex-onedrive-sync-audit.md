# Collaborative notebook sync audit

This was a **read-only review of the current working tree**. I did not modify repository files, start the application, run sync operations, or run tests against notebook data. I used one purely in-memory probe to check path traversal, filename parsing, and lease arithmetic.

The most serious findings are an unchecked manifest document ID reaching filesystem deletion, renderer replicas surviving a host crash without reconnecting, authorization races in REST mutations, and several remaining paths that trust lagging OneDrive files.

**Confidence terminology:** “confirmed by reading the code” means the control flow or missing safeguard is established statically. It does **not** mean I reproduced the scenario with a real OneDrive client. Provider-dependent behavior is identified separately.

## 1. How sync works

### Authorities and storage

The collaborative server stores Yjs updates, document metadata, project membership, comments, revisions, and file manifests in its database. Binary content is uploaded separately to content-addressed blob storage.

Electron runs a collaboration utility process. Its account/server-scoped SQLite databases normally live under the active Electron profile’s `userData/collab/`, **outside the configured notebook directory**. SQLite uses WAL mode and `synchronous=FULL`; it stores document updates, snapshots, outbound batches, commands, cached comments, and project bindings.

Notebook working files live under:

```text
<LIBERA_DATA_DIR>/users/admin/<notebook>/
```

The notebook also contains:

```text
.libera-shared.json
.libera/collab/state.json
.libera/collab/base/
.libera/collab/moving/
.libera/collab/incoming/
.libera/collab/rejected-pdf/
_archive/
```

These directories may be excluded from **collaborative** file import, but they remain physically inside the OneDrive folder. Calling them “local-only” does not prevent OneDrive from transferring them.

Relevant code: `electron/collab/adapters/utility.ts:161`, `electron/collab/control/databases.ts:12`, `electron/collab/control/runtime.ts:202`, `electron/collab/core/store.ts:488`, `electron/collab/notebooks/fs-ops.ts:14`.

### Editing, materialization, and import

1. An editor changes a renderer Yjs replica.
2. The renderer batches updates over a MessagePort to the host.
3. The host persists updates in SQLite, batches outbound updates, and sends them over WebSocket.
4. The server validates and persists updates, acknowledges them, and broadcasts them.
5. One installation holding a server lease materializes the shared state into notebook files.
6. Other installations following the same folder leave working-file delivery to OneDrive.
7. The writer scans external disk changes and may import them into shared documents or upload new blob versions.

Text files have CRDT authority. Binary versions are represented by hashes in the manifest. PDF marks use separate collaborative documents; PDF sidecars are imported/exported recovery copies. Audio transcripts are companion `.transcript` blobs.

Relevant code: `src/lib/collab/client/replica.ts:225`, `electron/collab/core/doc-hub.ts:552`, `electron/collab/core/outbound.ts:277`, `electron/collab/notebooks/project.ts:1184`, `electron/collab/notebooks/project.ts:1638`.

### Watchers and timers

| Mechanism | Current behavior |
|---|---|
| Writer lease | Default 60-second TTL; service checks approximately every 20 seconds, serially across projects. |
| Filesystem watcher | Recursive `fs.watch`; approximately 250-ms settling, with a maximum scan delay. |
| Safety scan | Normally 30 seconds with a trusted watcher, 5 seconds otherwise; slower on battery. |
| Content verification | Approximately 60 seconds for smaller files; around 30 minutes, spread per file, for files at least 1 MiB. |
| Text materialization | After 2 seconds of quiet, at most 15 seconds under continuous editing. |
| Bookkeeping save | Normally debounced by 100 ms; failed saves retry with backoff. |
| PDF sidecars | Periodic discovery/import and delayed export, normally 60 seconds. |
| Follower disk checks | Approximately every second for expected path appearances/disappearances, for up to 10 minutes. |
| WebSocket | Pings, reconnect backoff, outbound acknowledgement retries, and periodic divergence checks. |
| Pending REST commands | Durable FIFO replay with retries and backoff. |

Relevant code: `electron/collab/notebooks/service.ts:291`, `electron/collab/notebooks/service.ts:303`, `electron/collab/notebooks/project.ts:148`, `electron/collab/notebooks/project.ts:826`, `electron/collab/notebooks/pdf-marks.ts:191`, `electron/collab/core/outbound.ts:217`.

**Important current policy:** missing files are restored from collaborative authority; disk absence no longer authorizes a collaborative deletion. That closes several earlier data-loss paths, but means Explorer/Finder/OneDrive deletion does not necessarily remove a shared file.

### Relationship to previous audits

I reviewed all five November 1 audits and the later [critical/high fix report](docs/collaboration/critical-high-fix-report.md). I have not carried forward the original reproductions where the current code demonstrably fixes them—for example, missing-file inferred deletion, the original download-wait overwrite, deterministic staging-name overwrite, unguarded initial join, and silently dropped queued explicit operations.

Below, **STILL PRESENT** identifies a remaining portion of an earlier issue or a documented mitigation limitation. **NEW** identifies a distinct current failure path, including new variants adjacent to previously fixed code.

## 2. Findings

## Deadlock / stall

### DL-1 — Unbounded filesystem operations can hold project and account lifecycle work

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/fs-ops.ts:118`, `electron/collab/notebooks/project.ts:453`, `electron/collab/notebooks/project.ts:575`, `electron/collab/notebooks/project.ts:1203`, `electron/collab/notebooks/project.ts:934`, `electron/collab/notebooks/service.ts:570`, `electron/collab/notebooks/service.ts:698`.

**Scenario:** 1. Materialization or cached-blob access reads an online-only file. 2. The filesystem/provider does not complete the read promptly. 3. A handoff, takedown, shutdown, or account change waits for that project queue to drain.

**Effect:** those operations can wait indefinitely. Filesystem metadata calls are also unbounded. The bounded scan-read helper does not cover these other paths. Whether OneDrive hangs or returns an error in a particular situation needs testing; the unbounded wait chain is present.

**Fix direction:** bound and cancel filesystem work where supported; isolate provider IO from lifecycle queues; retain durable operation state so cancellation is recoverable. G24 fixed the HTTP boundary, not this filesystem boundary.

### DL-2 — Failed runtime replacement leaves a project that subsequent ticks refuse to restart

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/service.ts:382`, `electron/collab/notebooks/service.ts:673`, `electron/collab/notebooks/service.ts:694`, `electron/collab/notebooks/service.ts:783`, `electron/collab/notebooks/service.ts:1768`.

**Scenario:** 1. A lease handoff sets `handle.runtime = null`. 2. Stopping or reopening fails—for example, OneDrive makes state temporarily unreadable or replaces the marker during the transition. 3. The tick logs that it will retry.

**Effect:** `checkLease()` returns immediately for a null runtime, while stored-project loading skips projects already present in the map. The project can remain registered but inactive until restart. Similar partially registered states are possible during adoption/join.

**Fix direction:** represent failed initialization explicitly and retry it; remove or repair the partial handle on failure. Install the replacement runtime only after successful construction.

### DL-3 — Waiting for total idleness can prevent takedown or join from finishing

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:548`, `electron/collab/notebooks/project.ts:634`, `electron/collab/notebooks/project.ts:1427`, `electron/collab/notebooks/service.ts:1121`, `electron/collab/notebooks/service.ts:1774`.

**Scenario:** 1. Takedown calls `whenIdle()`, or join reaches its final idle wait. 2. Another contributor continues editing, or OneDrive continuously produces watcher events. 3. New write/scan/manifest timers keep appearing while the wait runs.

**Effect:** the operation can remain pending indefinitely despite a healthy server and usable files. The join materialization timeout does not bound the subsequent `whenIdle()` call.

**Fix direction:** drain work through a captured generation or barrier rather than requiring global silence. Freeze or defer new background work during the lifecycle transition and use a bounded retryable result.

### DL-4 — One project can delay renewal of every other project’s lease

**STILL PRESENT — incomplete isolation requirement from G24 · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/service.ts:575`, `electron/collab/notebooks/service.ts:584`, `electron/collab/notebooks/service.ts:520`, `electron/collab/notebooks/service.ts:1115`; earlier audit: `docs/audits/2026-11-01-sync-boundary-review.md:79`.

**Scenario:** 1. The lease pass waits for one project’s lifecycle lock or slow checks. 2. That lock is held by takedown or another operation waiting on filesystem work. Alternatively, enough individual five-second lease requests accumulate. 3. Later projects miss their renewal deadline.

**Effect:** unrelated notebooks lose disk-writing availability. The monotonic lease fence correctly stops expired writers, but cannot prevent this availability failure. HTTP deadlines fixed G24’s original infinite HTTP wait; serial scheduling and lock coupling remain.

**Fix direction:** renew leases independently with bounded concurrency and reserved renewal deadlines. Keep renewal outside long project lifecycle locks.

### DL-5 — A sufficiently fast client clock makes successfully acquired leases immediately unusable

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/service.ts:518`, `electron/collab/notebooks/service.ts:522`, `electron/collab/notebooks/service.ts:448`, `server/src/api/projects.ts:313`.

**Scenario:** 1. The client wall clock is more than a lease TTL ahead of the server. 2. The server grants a lease with an absolute expiry. 3. The client subtracts its own `Date.now()` and computes zero remaining lifetime.

**Effect:** the runtime immediately becomes a follower. Repeated successful acquisitions do not restore materialization; handoff/reopen churn may continue.

**Fix direction:** derive the usable monotonic deadline from a server-provided duration, with network-time allowance, or maintain a measured server clock offset. Do not subtract unrelated wall clocks.

### DL-6 — Missing bookkeeping can permanently and silently disable external-file adoption

**STILL PRESENT — R08 mitigation limitation · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/state.ts:153`, `electron/collab/notebooks/project.ts:336`, `electron/collab/notebooks/project.ts:1874`, `electron/collab/core/store.ts:1142`; previous report: `docs/collaboration/critical-high-fix-report.md:54`, `docs/collaboration/critical-high-fix-report.md:97`.

**Scenario:** 1. A device becomes writer before OneDrive delivers `state.json`, or reads invalid bookkeeping. 2. It records an adoption fence in profile-local SQLite. 3. Correct bookkeeping subsequently arrives.

**Effect:** unexplained files dropped into the notebook never become shared automatically, including after restart. There is no normal clear/review workflow and no corresponding visible state.

**Fix direction:** expose the fence and its reason; provide explicit review/adoption. A verified identity-bound recovery checkpoint may support safe recovery, but arbitrary later cloud state should not silently clear the fence.

### DL-7 — Single oversized CRDT transactions cannot be transmitted successfully

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:1335`, `electron/collab/notebooks/service.ts:1551`, `electron/collab/core/outbound.ts:289`, `electron/collab/core/sync-client.ts:603`, `server/src/sync/server.ts:343`, `src/lib/collab/protocol/version.ts:35`.

**Scenario:** 1. An existing shared text file receives a very large external edit, or initial sharing creates a large manifest in one transaction. 2. The resulting individual update exceeds the server’s 4-MiB update limit or the client’s 8-MiB frame limit. 3. Batching preserves that indivisible first update.

**Effect:** updates below the frame limit are rejected and rolled back into recovery; larger frames are refused locally and retried without progress. Initial text classification limits do not protect later external edits or a large manifest.

**Fix direction:** size transactions before applying them; chunk text changes and manifest publication. Surface an actionable permanent size failure instead of endlessly retrying an unsendable frame.

### DL-8 — The walk cap disables all external reconciliation in an oversized notebook

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/fs-ops.ts:333`, `electron/collab/notebooks/fs-ops.ts:347`, `electron/collab/notebooks/project.ts:1645`, `electron/collab/notebooks/project.ts:863`.

**Scenario:** 1. A notebook exceeds 50,000 counted files/directories, potentially through generated files. 2. Every walk reports incomplete. 3. The scanner abandons the entire pass and retries.

**Effect:** external changes to otherwise ordinary files stop importing, while repeated full walks continue. This safely avoids G12’s inferred deletions, but supplies no progressing reconciliation strategy for the oversized tree.

**Fix direction:** expose the limit and blocked state; support partitioned scans with completeness recorded per subtree. Exclude generated trees before they consume the walk budget.

### DL-9 — Follower operations unnecessarily require OneDrive to have delivered filesystem objects

**NEW · medium · confirmed by reading the code**

**References:** `src/lib/collab/shared-writes.ts:547`, `src/lib/collab/shared-writes.ts:603`, `src/lib/collab/shared-writes.ts:629`, `src/lib/collab/shared-writes.ts:658`, `src/lib/storage/tree.ts:207`, `electron/collab/notebooks/project.ts:2293`.

**Scenario:** 1. A follower knows a file or folder through the manifest. 2. OneDrive is paused or has not delivered it. 3. The user renames/deletes that file or creates content inside that folder through the standard wrapper.

**Effect:** disk `stat`/directory checks reject an operation the collaborative manifest could resolve. Conversely, a stale disk file can block recreation at a manifest-free path.

**Fix direction:** obtain shared existence, type, and identity from the host manifest. Treat disk arrivals as separate external input requiring preservation, rather than as shared-operation prerequisites.

## Excessive sync attempts / scanning

### SYNC-1 — Fresh-file scanning eagerly hydrates and retains all candidate contents

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:1802`, `electron/collab/notebooks/project.ts:1813`, `electron/collab/notebooks/project.ts:1831`, `electron/collab/notebooks/project.ts:1874`, `electron/collab/notebooks/fs-ops.ts:274`, `server/src/config.ts:45`.

**Scenario:** 1. OneDrive exposes many new online-only files. 2. A scan reads each file and accumulates its full bytes in `fresh[]`. 3. Upload/adoption happens only afterward—even the permanent adoption fence is checked afterward.

**Effect:** large hydration/download bursts and memory growth, potentially host OOM. Files above the server’s configured upload limit are still read and retried rather than rejected before hydration. Windows does not receive the dataless optimization.

**Fix direction:** stream or process bounded batches, apply size/adoption policy before expensive reads where possible, and cache unresolved candidate observations.

### SYNC-2 — Timed-out reads keep running and subsequent scans start additional reads

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/fs-ops.ts:281`, `electron/collab/notebooks/fs-ops.ts:293`, `electron/collab/notebooks/project.ts:1723`, `electron/collab/notebooks/project.ts:1813`, `electron/collab/notebooks/project.ts:1928`.

**Scenario:** 1. A provider read exceeds the ten-second scan wait. 2. `readWithin()` stops waiting but leaves the read running. 3. Retry/poll scans start another read of the same path.

**Effect:** concurrent outstanding reads, provider work, buffers, and filesystem worker usage can accumulate. OneDrive may coalesce downloads internally; the application does not coalesce the reads.

**Fix direction:** retain one in-flight read per file identity, with resource limits and cancellation where available. Reuse its eventual result only after validating the current file observation.

### SYNC-3 — Watcher filtering does not match scan exclusions

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:1427`, `electron/collab/notebooks/fs-ops.ts:34`, `electron/collab/notebooks/fs-ops.ts:58`, `electron/collab/notebooks/fs-ops.ts:350`.

**Scenario:** 1. A build, editor, or OneDrive changes `_archive`, `.git`, OS droppings, temporary files, or generated output. 2. The watcher filters only `.libera*` path segments. 3. It schedules full notebook scans for files the import subsequently ignores.

**Effect:** unnecessary directory walks and verification activity, potentially continuously during builds or cloud recovery. Unchanged-file hashing prevents many uploads; this finding is about extra scans, not a proven upload loop for every event.

**Fix direction:** share an exclusion predicate between watcher and scanner, including excluded ancestor directories. Handle unknown-name events conservatively but with rate limits.

### SYNC-4 — Identical blob writes still upload and mutate the manifest

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:2175`, `electron/collab/notebooks/project.ts:2182`, `src/lib/storage/ink.ts:372`, `src/lib/storage/ink.ts:388`, `server/src/api/blobs.ts:76`.

**Scenario:** 1. A follower repeatedly saves an unchanged rendered ink SVG while its disk copy remains stale. 2. The rendering comparison uses disk bytes. 3. `write-blob` uploads identical bytes and updates manifest metadata each time.

**Effect:** redundant PUT bodies, CRDT traffic, acknowledgements, and database writes. Server content-addressing can avoid another blob-file write, but does not avoid receiving the upload or the manifest mutation.

**Fix direction:** return early when the authoritative current blob hash already equals the submitted hash. Compare generated output with host authority rather than lagging disk.

### SYNC-5 — OneDrive conflict-copy detection misses common ambiguous copies

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:1968`, `electron/collab/notebooks/project.ts:1977`, `electron/collab/notebooks/project.ts:1986`, `electron/collab/notebooks/state.ts:77`.

**Scenario:** 1. OneDrive creates `note-DESKTOP-ABC.md` beside `note.md`. 2. The regex strips only the last hyphen component and searches for `note-DESKTOP.md`. Alternatively, a numbered/device copy contains divergent bytes or a version outside remembered hashes. 3. The file enters ordinary fresh-file creation.

**Effect:** stale or conflicting copies become new shared documents/blobs and generate additional uploads. Microsoft documents computer-name duplicate files; the application’s narrower recognizer is established in code. [Microsoft: duplicate files](https://support.microsoft.com/en-au/onedrive/duplicate-files-in-onedrive).

**Fix direction:** quarantine ambiguous provider-style copies for review; do not rely on a one-component device suffix and short hash history to establish creation intent.

### SYNC-6 — Reconnect sends the whole backlog and retries it despite partial progress

**NEW · medium · likely**

**References:** `electron/collab/core/outbound.ts:179`, `electron/collab/core/outbound.ts:223`, `electron/collab/core/outbound.ts:311`, `electron/collab/core/outbound.ts:329`, `electron/collab/core/sync-client.ts:603`.

**Scenario:** 1. Offline editing accumulates many outbound batches. 2. Reconnect sends all unsent batches without an outstanding-byte window. 3. The server progresses slowly enough that batches remain pending at the retry deadline. 4. The retry clears sent tracking and resends every remaining batch.

**Effect:** duplicate traffic and server duplicate-check work can amplify an already slow catch-up. Individual acknowledgements do not reset the retry while other batches remain. Actual overload depends on backlog and server throughput.

**Fix direction:** bound outstanding bytes/batches, retry the oldest timed-out work, and account for acknowledgement progress.

## Excessive disk writes

### WRITE-1 — Initial notebook sharing repeatedly rewrites the entire share plan

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/service.ts:1481`, `electron/collab/notebooks/service.ts:1519`, `electron/collab/notebooks/service.ts:1537`, `electron/collab/notebooks/state.ts:225`, `electron/collab/notebooks/state.ts:267`.

**Scenario:** 1. A notebook contains many text files. 2. The plan contains all immutable initial text payloads. 3. After each successful document creation or notebook blob upload, the entire plan is rewritten both profile-locally and in the cloud folder.

**Effect:** approximately quadratic checkpoint write volume. OneDrive may coalesce some transfers, but local serialization and writes still occur. Albums already have a smaller upload journal; notebooks do not.

**Fix direction:** persist immutable payloads once and append compact completion records, with durable checkpoint compaction.

### WRITE-2 — Ordinary PDF startup rewrites already existing recovery backups

**NEW · low · confirmed by reading the code**

**References:** `electron/collab/notebooks/pdf-marks.ts:251`, `electron/collab/notebooks/pdf-marks.ts:295`, `electron/collab/notebooks/pdf-marks.ts:299`, `electron/collab/notebooks/pdf-marks.ts:409`.

**Scenario:** 1. A host restarts and opens an existing shared PDF. 2. Its new runtime has `imported = false`. 3. The normal sidecar is passed to `keepRejected()` before checking whether the content-addressed recovery file already exists.

**Effect:** an unchanged recovery file is rewritten through a temporary file and rename on each such startup. A current exported sidecar is treated this way too. Runtime hash tracking avoids every normal rewrite repeating this, but does not survive restart.

**Fix direction:** use exclusive creation or verify an existing content-addressed backup before writing it.

### WRITE-3 — Reading PDF comments rewrites every cached thread

**NEW · low · confirmed by reading the code**

**References:** `electron/collab/notebooks/pdf-comments.ts:159`, `electron/collab/notebooks/pdf-comments.ts:167`, `electron/collab/core/store.ts:1043`, `electron/collab/notebooks/pdf-marks.ts:377`.

**Scenario:** 1. A panel or PDF export requests comments. 2. The server returns unchanged threads. 3. Every thread is unconditionally upserted with a new cache timestamp.

**Effect:** read operations generate SQLite WAL traffic proportional to thread count. This database is normally outside OneDrive, so the direct issue is local write amplification.

**Fix direction:** update only changed serialized content; store refresh metadata separately or once per collection.

### WRITE-4 — Deleting unchanged text creates two identical archive copies

**NEW · low · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:973`, `electron/collab/notebooks/project.ts:989`, `electron/collab/notebooks/project.ts:990`.

**Scenario:** 1. A shared text file matches disk exactly. 2. It is deleted collaboratively. 3. `archiveRemoved()` writes the shared text to a new archive file, then archives the identical live file under another name.

**Effect:** duplicate archive storage and potentially duplicate OneDrive transfers for ordinary deletion.

**Fix direction:** preserve the observed live file first, then create a second recovery copy only when its retained bytes differ from the shared snapshot. Preserve R11/G30’s protection for intervening edits.

### WRITE-5 — Command effects and idempotency results are not committed together

**NEW · medium · confirmed by reading the code**

**References:** `server/src/api/commands.ts:116`, `server/src/api/commands.ts:124`, `server/src/api/commands.ts:126`, `server/src/api/revisions.ts:81`, `server/src/api/revisions.ts:162`.

**Scenario:** 1. A queued named-revision command creates its revision. 2. The server crashes before inserting the command result. 3. The desktop retries the same command ID. 4. No stored result exists, so the handler creates another revision.

**Effect:** the claimed once-only replay is not guaranteed for non-idempotent handlers. Duplicate revisions/events and repeated side effects can occur. Stable IDs separately protect thread/message creation, so those cases are better covered.

**Fix direction:** atomically reserve/execute/store the command, or make every handler’s durable effect uniquely keyed by command ID.

### WRITE-6 — Adopting already identical text still writes bookkeeping

**NEW · low · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:1212`, `electron/collab/notebooks/project.ts:1266`, `electron/collab/notebooks/project.ts:1273`, `electron/collab/notebooks/project.ts:2523`.

**Scenario:** 1. Startup or handoff schedules materialization for existing documents. 2. Disk and shared text already match. 3. `adopt()` still upserts document metadata and schedules a full state-file write.

**Effect:** avoidable SQLite and OneDrive-folder bookkeeping writes on otherwise unchanged notebooks. The base-file write is correctly conditional; the other writes are not.

**Fix direction:** compare the complete persisted observation before updating metadata or marking state dirty.

## Permission violations / authority boundaries

### PERM-1 — A collaborator-controlled document ID can delete a `.txt` file outside the notebook

**NEW · critical · confirmed by reading the code**

**References:** `server/src/sync/validate.ts:337`, `server/src/sync/validate.ts:378`, `electron/collab/notebooks/layout.ts:29`, `electron/collab/notebooks/project.ts:751`, `electron/collab/notebooks/project.ts:685`, `electron/collab/notebooks/state.ts:198`, `electron/collab/notebooks/state.ts:211`.

**Scenario:**

1. An editor submits a notebook manifest entry with a valid visible path and document kind, but a document ID containing traversal segments.
2. Server manifest validation checks the visible path, not the document ID’s syntax or project ownership.
3. The live client manifest parser also accepts that document ID.
4. After the client records the entry, its removal reaches `deleteBase(root, docId)`.
5. That function joins the unchecked ID into a path and removes it without a containment guard.

For example, a document ID equivalent to `../../../../Private/victim` makes the base-file path resolve to a sibling notebook’s `victim.txt`. The appended `.txt` suffix constrains this particular deletion primitive.

**Effect:** an editor of one shared notebook can cause deletion outside that notebook on a materializing client. OneDrive can then propagate the private-file deletion.

**Fix direction:** immediately validate all manifest IDs on both server and client; verify document/project relationships; enforce containment independently in every base-file operation. Persisted-state validation does not protect the live manifest path.

### PERM-2 — REST mutations can commit after removal or demotion

**NEW variant of G01’s authorization class · high · confirmed by reading the code**

**References:** `server/src/api/documents.ts:186`, `server/src/api/threads.ts:363`, `server/src/api/threads.ts:410`, `server/src/api/revisions.ts:247`, `server/src/api/revisions.ts:258`, `server/src/api/suggestions.ts:427`, `server/src/api/suggestions.ts:505`, `server/src/api/reviews.ts:345`, `server/src/sync/store.ts:134`.

**Scenario:** 1. An editor passes a REST action’s authorization check. 2. The operation waits on database IO or the document queue. 3. The owner removes or demotes that contributor. 4. The operation resumes and writes using its earlier authorization.

**Effect:** text restore, suggestion acceptance/reversion, document deletion, and several thread/review mutations can outlive permission changes. The text-restore and suggestion paths omit the optional commit-time `requiredAccess` fence. PDF restore already supplies that fence.

**Fix direction:** apply fresh authorization at queue admission and lock the membership/required authority through commit for every mutation. G01’s WebSocket fix should be extended to these REST paths. Earlier comparison: `docs/audits/2026-11-01-collaboration-sync-review.md:26`.

### PERM-3 — Album attribution used for revocation retention is forgeable

**NEW · medium · confirmed by reading the code**

**References:** `server/src/sync/validate.ts:394`, `server/src/sync/validate.ts:404`, `electron/collab/notebooks/project.ts:2395`, `electron/collab/notebooks/service.ts:1203`.

**Scenario:** 1. An album editor changes another photo’s `addedBy` to their own account. 2. Validation accepts any nonempty string for that field. 3. That editor later leaves or is removed.

**Effect:** cleanup treats the photo as their own and retains it. Attribution is also false. Contributors already able to read photos can save copies, but the application’s stated ownership/cleanup rule is not enforced by these fields.

**Fix direction:** bind initial attribution to authenticated creation and make it immutable; derive retention from trusted server metadata.

## Stale files / abandoned resources

### STALE-1 — Followers ignore same-path blob replacements

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:795`, `electron/collab/notebooks/project.ts:802`, `electron/collab/notebooks/project.ts:813`, `electron/collab/notebooks/project.ts:826`.

**Scenario:** 1. Another contributor replaces an image, recording, or PDF without renaming it. 2. A follower receives the new manifest hash. 3. Its derived layout contains only path/kind for blobs, so comparison finds no layout change. 4. OneDrive delivers bytes later.

**Effect:** no follower watcher or hash-based arrival tracking invalidates the open file. Existing views can remain stale; path checks also treat an existing old file as “arrived.”

**Fix direction:** retain expected blob hashes in follower state and emit content-version events. Verify the actual version before declaring disk caught up.

### STALE-2 — Audio companion rename/delete is separate, disk-dependent, and best-effort

**STILL PRESENT — remaining R20 lifecycle limitation · medium · confirmed by reading the code**

**References:** `src/lib/collab/shared-writes.ts:484`, `src/lib/collab/shared-writes.ts:610`, `src/lib/collab/shared-writes.ts:632`, `src/lib/storage/transcripts.ts:200`; previous report: `docs/collaboration/critical-high-fix-report.md:78`.

**Scenario:** 1. A follower renames a recording whose `.transcript` exists in the manifest but not yet on disk. 2. The recording rename succeeds. 3. The companion helper skips the rename because disk existence fails. Alternatively, the second operation fails or the process crashes between requests.

**Effect:** the old transcript remains live at a detached path. Deletion has similar split-operation behavior; some errors are swallowed.

**Fix direction:** identify companions in the host manifest and move/delete them in the recording’s single manifest transaction, as ink companions already are.

### STALE-3 — Interrupted move artifacts have no replay or discoverable recovery workflow

**STILL PRESENT — R12/G31 recovery limitation; original overwrite fixed · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:708`, `electron/collab/notebooks/project.ts:724`; earlier audit: `docs/audits/2026-11-01-sync-transition-review.md:37`; later limitation: `docs/collaboration/critical-high-fix-report.md:62`.

**Scenario:** 1. A move stages a file containing an unimported external edit. 2. Final placement fails or the process crashes. 3. The destination is rematerialized from collaborative authority.

**Effect:** the distinct external bytes remain under an opaque unique name in `.libera/collab/moving/`. Later moves no longer overwrite them, but restart does not resume placement or expose their intended destination.

**Fix direction:** persist a move journal containing identity, source, destination, and hashes; replay or present recovery explicitly.

### STALE-4 — Crash-only temporary and cleanup artifacts have no general reconciliation

**NEW · low · confirmed by reading the code**

**References:** `electron/collab/notebooks/fs-ops.ts:203`, `electron/collab/notebooks/fs-ops.ts:224`, `src/lib/collab/shared-writes.ts:436`, `electron/collab/notebooks/service.ts:1180`, `electron/collab/notebooks/state.ts:164`.

**Scenario:** 1. The process exits between temporary-file creation and its `finally` cleanup, or between album detachment and recursive removal. 2. It restarts. 3. No general startup inventory resolves those artifacts.

**Effect:** ignored `.libera-tmp-*`, incoming UUID files, detached cleanup directories, and recovery artifacts accumulate. OneDrive may transfer notebook-resident artifacts to other devices.

**Fix direction:** distinguish disposable staging from user recovery data, inventory both, safely expire completed/disposable work, and provide recovery visibility. Do not indiscriminately delete interrupted-move or rejected-input copies.

### STALE-5 — Album cleanup failures can become permanent

**STILL PRESENT — R14 best-effort limitation; replacement-root deletion fixed · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/service.ts:1183`, `electron/collab/notebooks/service.ts:1191`, `electron/collab/notebooks/service.ts:1206`, `electron/collab/notebooks/service.ts:1212`, `electron/collab/notebooks/service.ts:1218`; previous report: `docs/collaboration/critical-high-fix-report.md:66`.

**Scenario:** 1. Album cleanup tries to rename files from a OneDrive/external volume to profile-local cleanup storage. 2. Rename fails with `EXDEV`, or a photo is busy. 3. Photo failures are swallowed; marker failure can occur after runtime removal.

**Effect:** other contributors’ photos/bookkeeping can remain indefinitely. Successful bookkeeping removal forgets failed cleanup; marker failure can leave the null-runtime state from DL-2.

**Fix direction:** persist cleanup progress and retry failures. Support an identity-guarded same-volume quarantine before later removal.

### STALE-6 — Failed automatic imports leave server resources with no durable owner intent

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:2059`, `electron/collab/notebooks/project.ts:2068`, `electron/collab/notebooks/project.ts:2070`, `server/src/api/blobs.ts:84`, `server/src/api/blobs.ts:89`, `server/src/blobs/gc.ts:20`.

**Scenario:** 1. An automatic import creates a server document. 2. The response is lost, or OneDrive changes the source before `stillCurrent()`. 3. Retry chooses fresh IDs. Separately, blob object creation can succeed before authorization/database insertion fails.

**Effect:** unpublished documents and blob objects can persist without manifest references. The blob collector tracks hashes orphaned by project removal; it does not inventory every object created without a row.

**Fix direction:** journal import identities before requests, reuse them across uncertain outcomes, and collect abandoned unpublished resources with a grace period.

### STALE-7 — Retired paths still accept sufficiently old or unknown returning content

**STILL PRESENT — incomplete G23 fix · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/project.ts:1931`, `electron/collab/notebooks/project.ts:1945`, `electron/collab/notebooks/project.ts:2608`, `electron/collab/notebooks/state.ts:77`; earlier audit: `docs/audits/2026-11-01-sync-boundary-review.md:67`.

**Scenario:** 1. A file has more versions than the remembered hash history. 2. It is deleted collaboratively. 3. OneDrive later delivers an older, unremembered version at the retired path. 4. The adoption fence is not set.

**Effect:** `isLateCopy()` rejects only known hashes when its retired-path set is nonempty. The returning file receives a new file/document ID, bypassing the old identity’s valid tombstone.

**Fix direction:** require explicit recreation intent at retired paths, or place unknown returning bytes in review/recovery. G23 explicitly warned that finite hashes cannot prove late-delivery origin.

## Data loss / corruption / incorrect recovery

### DATA-1 — Host restart does not reconnect existing renderer replicas

**NEW · high · confirmed by reading the code**

**References:** `electron/collab-host.cjs:189`, `electron/collab-host.cjs:253`, `src/lib/collab/client/replica.ts:119`, `src/lib/collab/client/replica.ts:210`, `src/lib/collab/client/replica.ts:251`, `src/lib/collab/client/registry.ts:186`, `src/lib/collab/client/registry.ts:298`, `src/lib/collab/client/workspace.ts:67`.

**Scenario:** 1. A shared tab is attached. 2. The utility process crashes; Electron restarts it. 3. The renderer retains its existing session/MessagePort and cached document resolution. 4. The user continues editing.

**Effect:** there is no port-close recovery or host-generation rebinding path. Updates are removed from the renderer send queue without a durability acknowledgement and can remain only in renderer memory. Shared tabs also omit text from the normal draft journal and dirty-document count. Reload/close can lose these edits.

**Fix direction:** publish host generations and disconnects, reattach surviving replicas, replay missing Yjs state, and keep recovery data until host durability is acknowledged.

### DATA-2 — A failed remote SQLite append drops that update without arranging recovery

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/core/doc-hub.ts:799`, `electron/collab/core/doc-hub.ts:730`, `electron/collab/core/doc-hub.ts:716`, `electron/collab/core/sync-client.ts:656`, `electron/collab/core/divergence.ts:109`, `electron/collab/core/divergence.ts:299`.

**Scenario:** 1. A remote update arrives while SQLite is temporarily full or busy. 2. `persistAcked()` throws before the update is applied. 3. The sync dispatch catch logs the failure but keeps the connection. 4. Storage recovers without a reconnect.

**Effect:** the server does not resend that broadcast. Later updates can depend on missing structures. The divergence checker treats unequal state vectors as inconclusive rather than initiating recovery. Initial-open diff failures also can be swallowed while open processing advances.

**Fix direction:** enter a persistence-failed state and reopen from the last durable vector after recovery. Do not mark initial loading complete after applying only part of its state.

### DATA-3 — Closing a hub can discard still-unpersisted local edits

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/core/doc-hub.ts:559`, `electron/collab/core/doc-hub.ts:596`, `electron/collab/core/doc-hub.ts:951`, `electron/collab/control/routes-docs.ts:199`, `src/lib/collab/client/workspace.ts:67`.

**Scenario:** 1. Local SQLite persistence fails. 2. The edit is broadcast and retained in the in-memory retry queue; callers can still receive `applied: true`. 3. Closing/account switching/shutdown makes one final unsuccessful persistence attempt. 4. The hub destroys its documents and stops retrying.

**Effect:** the error is reported, but the accepted edit lacks durable recovery. Shared-tab journaling does not provide an independent copy.

**Fix direction:** distinguish “applied in memory” from durable success. Preserve failed updates in a separate durable recovery mechanism and make closure explicitly handle unpersisted work.

### DATA-4 — Live SQLite databases and their WAL/journal files can be shared as unrelated blobs

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/fs-ops.ts:34`, `electron/collab/notebooks/fs-ops.ts:69`, `electron/collab/notebooks/documents.ts:35`, `electron/collab/notebooks/project.ts:1779`, `electron/collab/notebooks/project.ts:2050`.

**Scenario:** 1. A user/application keeps an active SQLite database inside the notebook. 2. Its database, WAL, SHM, or rollback journal changes. 3. OneDrive and the collaborative scanner observe and transfer the files independently. 4. Materialization may replace them while a database connection remains open.

**Effect:** inconsistent snapshots, missing committed transactions, or corruption. No database-family snapshot protocol or exclusion protects these files. SQLite documents the danger of copying a database during transactions and separating it from its journal/WAL. [SQLite corruption guidance](https://www.sqlite.org/howtocorrupt.html).

**Fix direction:** exclude active database families by default; use an application-consistent export/SQLite backup operation. The host’s own database is normally outside OneDrive; this finding concerns databases placed inside notebooks or explicitly relocated storage.

### DATA-5 — New uploads and generated image copies can replace an existing shared blob

**NEW · high · confirmed by reading the code**

**References:** `src/lib/collab/shared-writes.ts:755`, `src/lib/collab/shared-writes.ts:773`, `src/lib/collab/shared-writes.ts:789`, `electron/collab/notebooks/project.ts:2155`, `electron/collab/notebooks/project.ts:2160`.

**Scenario:** 1. A follower’s disk lacks an existing manifest file because OneDrive lags. 2. Upload, Markdown image insertion, or edited-image-copy chooses that apparently free disk name. 3. The helper calls `writeSharedBlob()` without `createOnly`. 4. The host finds the existing manifest blob and replaces it.

**Effect:** a “new file” action silently overwrites another shared binary’s current version.

**Fix direction:** use exclusive creation for every new-artifact action; resolve names against the host manifest and retry collisions explicitly.

### DATA-6 — Copy, edited-image, raw-download, and notebook-export paths can use stale disk versions

**NEW · high · confirmed by reading the code**

**References:** `src/lib/storage/files.ts:543`, `src/lib/storage/files.ts:554`, `src/lib/storage/files.ts:740`, `src/lib/storage/files.ts:696`, `src/lib/collab/shared-writes.ts:744`, `src/lib/collab/shared-writes.ts:798`, `src/lib/storage/download.ts:21`.

**Scenario:** 1. Shared authority contains a newer version while OneDrive is paused or materialization is delayed. 2. The user copies a binary, edits an image copy, downloads raw content, or exports the notebook ZIP. 3. The operation reads working files directly. Text-copy fallback also returns to disk when the host lookup fails.

**Effect:** successful-looking copies/backups can contain obsolete or missing content. A PDF copy may combine current collaborative marks with older PDF bytes. ZIP export does not capture a consistent shared snapshot.

**Fix direction:** export from host document/blob authority, verify source hashes, and use a captured manifest version. Report unavailable current content instead of silently substituting stale disk data.

### DATA-7 — Transcript edits can overwrite newer shared transcript content

**NEW · high · confirmed by reading the code**

**References:** `src/lib/storage/transcripts.ts:111`, `src/lib/storage/transcripts.ts:153`, `src/lib/storage/transcripts.ts:169`, `src/lib/storage/transcripts.ts:188`, `src/lib/collab/shared-writes.ts:417`.

**Scenario:** 1. Another device updates a transcript. 2. The follower still has the previous `.transcript` bytes on disk. 3. Speaker renaming or segment editing reads that disk version. 4. It replaces the shared blob without an expected file/hash precondition.

**Effect:** the small local edit can replace the whole newer transcript and discard unrelated corrections.

**Fix direction:** read authoritative host bytes and conditionally replace their exact version, following the approach already implemented for author ink.

### DATA-8 — Transcript fallback can save a correction that subsequent reads hide

**NEW · medium · confirmed by reading the code**

**References:** `src/lib/storage/transcripts.ts:118`, `src/lib/storage/transcripts.ts:153`, `src/lib/storage/transcripts.ts:158`, `src/lib/storage/transcripts.ts:162`.

**Scenario:** 1. A companion transcript exists on disk. 2. Sharing a correction fails or the role cannot modify files. 3. The correction is saved in the local sidecar. 4. The next read prefers the older companion unconditionally.

**Effect:** the user’s successfully retained local correction disappears from normal viewing and editing. A later edit can continue from the wrong version.

**Fix direction:** track an explicit pending/private local version and expose it until resolved. Do not hide recovery work solely because a companion file exists.

### DATA-9 — Valid bookkeeping is not bound to project/folder authority

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/state.ts:108`, `electron/collab/notebooks/state.ts:153`, `electron/collab/notebooks/state.ts:176`, `electron/collab/notebooks/project.ts:336`, `electron/collab/notebooks/project.ts:422`, `electron/collab/notebooks/project.ts:674`.

**Scenario:** 1. A folder is reshared or reused for a different project. 2. OneDrive later delivers structurally valid `state.json` from its previous identity. 3. A writer restart trusts that layout and opens its old document IDs. 4. Manifest application treats those old layout entries as removals.

**Effect:** current files can be archived according to foreign/stale bookkeeping, obsolete hubs can be marked deleted, and reconciliation bases can belong to the wrong project. Structural validation fixes G13’s malformed-state crash but not authority binding.

**Fix direction:** version bookkeeping with server/account/project/manifest/folder identity and reject mismatches before opening hubs or mutating disk.

### DATA-10 — Missing-marker repair can adopt a replacement directory at the old path

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/service.ts:644`, `electron/collab/notebooks/service.ts:651`, `electron/collab/notebooks/service.ts:666`, `src/lib/collab/local-notebook-state.ts:96`.

**Scenario:** 1. A bound notebook directory disappears. 2. OneDrive or the user installs an unrelated directory at the same path without a marker. 3. After the repair delay, the server confirms the old project still exists. 4. Repair writes the old marker into the replacement directory.

**Effect:** the unrelated directory becomes governed by the old collaborative project and may have matching paths archived/rematerialized. The binding records a path and marker identity, not directory incarnation. This differs from the now-guarded initial share/join paths.

**Fix direction:** persist/check directory incarnation where meaningful; require explicit recovery when the original directory cannot be established. Root existence plus marker absence is insufficient.

### DATA-11 — Several destructive cleanup operations lack the surrounding identity fence

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/service.ts:751`, `electron/collab/notebooks/service.ts:1154`, `electron/collab/notebooks/state.ts:145`, `electron/collab/notebooks/state.ts:211`, `electron/collab/notebooks/project.ts:685`, `electron/collab/notebooks/fs-ops.ts:372`.

**Scenario:** 1. Cleanup validates an old root/marker. 2. It waits on archiving, plan removal, or other IO. 3. OneDrive replaces the root or sharing identity. 4. Unguarded marker/base deletion or directory pruning continues at the pathname.

**Effect:** cleanup can remove a replacement project’s marker, base file, or empty directories. Marker loss can then disable ordinary saves and sync until repaired.

**Fix direction:** carry the captured identity/incarnation into cleanup, revalidate after waits, and detach owned objects before asynchronous removal. Do not treat an earlier check as authorization for later pathname deletion.

### DATA-12 — Final content checks are still check-then-act; archive destinations are not exclusive

**STILL PRESENT — explicitly acknowledged residual G26 race · high · likely**

**References:** `electron/collab/notebooks/fs-ops.ts:164`, `electron/collab/notebooks/fs-ops.ts:211`, `electron/collab/notebooks/fs-ops.ts:234`, `electron/collab/notebooks/fs-ops.ts:245`, `electron/collab/notebooks/project.ts:968`; earlier audit: `docs/audits/2026-11-01-sync-lifecycle-review.md:41`.

**Scenario:** 1. A content guard validates the destination. 2. An external process changes it before the replacement syscall executes. 3. Rename replaces that new content. An archive variant occurs when another actor occupies an `availableName()` destination before `movePath()`.

**Effect:** intervening input or a recovery file can still be overwritten. The earlier guard fixes the much larger temp-IO window, but is not a filesystem compare-and-swap; the earlier audit explicitly states that limitation at line 43.

**Fix direction:** use exclusive publication/detachment primitives and durable recovery versions. Where the filesystem cannot provide the required atomic condition, expose that limitation and preserve both versions.

### DATA-13 — Busy-file fallback abandons atomic replacement

**NEW · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/fs-ops.ts:192`, `electron/collab/notebooks/fs-ops.ts:209`, `electron/collab/notebooks/fs-ops.ts:219`.

**Scenario:** 1. OneDrive, antivirus, or another application repeatedly prevents rename. 2. Eight retries fail. 3. `writeFileAtomic()` copies over the live destination in place.

**Effect:** readers can observe incomplete replacement bytes; a failure or crash during copying can leave a damaged working file. Whether OneDrive publishes such an intermediate version depends on its behavior, but the application’s atomic-write guarantee is explicitly dropped.

**Fix direction:** retain the complete staged version and retry later. Never turn an atomic-save failure into an in-place overwrite of the sole live file.

### DATA-14 — Takedown can delete server authority before exported files are power-loss durable

**NEW · high · likely**

**References:** `electron/collab/notebooks/project.ts:525`, `electron/collab/notebooks/project.ts:539`, `electron/collab/notebooks/service.ts:1124`, `electron/collab/notebooks/fs-ops.ts:199`, `src/lib/collab/local-notebook-state.ts:69`.

**Scenario:** 1. Takedown downloads and writes current binaries. 2. Writes/renames complete without file or directory fsync. 3. The server project is deleted. 4. Power loss occurs before dirty filesystem state reaches stable storage.

**Effect:** local exported bytes can be missing/old after reboot while the project is already inaccessible. Profile lifecycle records use stronger flush handling than these file exports.

**Fix direction:** require a durable export barrier before destructive server deletion: sync file contents and directory changes where supported, and retain a durable recovery manifest. Ordinary process termination and actual power loss should be tested separately.

### DATA-15 — Blob garbage collection races with a new reference/upload

**NEW · high · likely**

**References:** `server/src/blobs/gc.ts:36`, `server/src/blobs/gc.ts:39`, `server/src/blobs/gc.ts:41`, `server/src/api/blobs.ts:76`, `server/src/api/blobs.ts:84`, `server/src/api/blobs.ts:89`.

**Scenario:** 1. GC finds an old orphan hash with no database references. 2. Another project uploads/reuses that hash and commits its blob row. 3. GC’s previously authorized deletion completes.

**Effect:** a live project can reference a missing blob object. A OneDrive-delivered old file can trigger reuse, but the race does not require OneDrive.

**Fix direction:** serialize object deletion and reference creation by hash, or use a deletion-generation/tombstone protocol with a final synchronized recheck.

### DATA-16 — Nonempty partial writes can be imported as complete files

**NEW · high · likely**

**References:** `electron/collab/notebooks/fs-ops.ts:312`, `electron/collab/notebooks/fs-ops.ts:318`, `electron/collab/notebooks/project.ts:1703`, `electron/collab/notebooks/project.ts:1811`, `electron/collab/notebooks/project.ts:2061`.

**Scenario:** 1. An external writer exposes a nonempty destination while copying and pauses. 2. It does not use Finder’s special busy birthtime. 3. Two immediate content observations see the same partial bytes, so import succeeds. 4. The writer later finishes, possibly restoring an old mtime.

**Effect:** collaborators receive an incomplete file. A completed binary with an older/equal mtime can subsequently be classified as uncertain/stale and replaced by the partial authoritative version, with recovery relegated to archive.

**Fix direction:** use stable observations over a meaningful interval and provider hydration state, then verify again at publication. Actual OneDrive destination-publication behavior must be measured; atomic provider publication would avoid this trigger.

### DATA-17 — Remote takedown still does not preserve current binaries on every receiving device

**STILL PRESENT — binary recovery gap adjacent to G03/R15; text and initiating-device fixes work · high · confirmed by reading the code**

**References:** `electron/collab/notebooks/service.ts:1071`, `electron/collab/notebooks/service.ts:1085`, `electron/collab/notebooks/service.ts:1148`, `electron/collab/notebooks/project.ts:458`, `electron/collab/notebooks/project.ts:511`, `server/src/api/projects.ts:219`; earlier audit: `docs/audits/2026-11-01-collaboration-sync-review.md:50`; later fix: `docs/collaboration/critical-high-fix-report.md:68`.

**Scenario:** 1. A receiving device has current manifest state but missing/old binaries because OneDrive lags. 2. Another device takes the project down. 3. Server deletion removes project/blob access. 4. The receiver stops with text preservation, without performing the initiating device’s binary export.

**Effect:** its resulting local/recovery notebook can permanently lack the latest binaries. Same-user OneDrive may later supply them; an independent contributor’s folder has no such guarantee.

**Fix direction:** define and implement a recipient recovery/download grace protocol, or continuously maintain verified local binary availability before promising a complete retained copy.

### DATA-18 — REST commands can outrun the CRDT state they depend on

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/core/sync-client.ts:747`, `electron/collab/core/host.ts:390`, `electron/collab/core/pending-commands.ts:123`, `electron/collab/control/routes-suggestions.ts:131`, `electron/collab/control/routes-revisions.ts:63`, `server/src/api/suggestions.ts:437`, `server/src/api/revisions.ts:146`.

**Scenario:** 1. Offline edits create a suggestion or change text, and a decision/checkpoint is queued. 2. Reconnect marks the connection online before document opens and outbound CRDT catch-up finish. 3. The REST queue executes immediately.

**Effect:** a suggestion decision can receive a definitive “not found” before the suggestion arrives. A revision can capture the pre-offline server state. The command can then be considered settled even though its causal prerequisite arrives later.

**Fix direction:** attach required document versions/state vectors to commands, and gate execution on those prerequisites. A global “connected” state is insufficient.

### DATA-19 — Ordinary PDF sidecar reconciliation bypasses the safer shared-lifecycle path

**NEW variant exposing an incomplete R20 boundary · high · confirmed by reading the code**

**References:** `src/lib/storage/tree.ts:365`, `src/lib/storage/pdf-sidecars.ts:194`, `src/lib/storage/pdf-sidecars.ts:232`, `src/lib/storage/pdf-sidecars.ts:239`, `src/lib/storage/pdf-sidecars.ts:82`, `src/lib/storage/pdf-sidecars.ts:272`; previous mitigation: `docs/collaboration/critical-high-fix-report.md:78`.

**Scenario A:** 1. OneDrive temporarily removes PDF A. 2. PDF B has identical bytes and no sidecar. 3. A tree refresh matches A’s sidecar to B by content and moves it, without consulting shared file IDs.

**Scenario B:** 1. A sidecar is being set aside after its PDF appears absent. 2. The routine reads old sidecar JSON and waits while writing its recovery record. 3. The host or OneDrive writes newer sidecar bytes. 4. Unconditional removal deletes those newer bytes.

**Effect:** annotations can move to the wrong shared identity, or intervening private/unimported annotations can be lost. Orphan records can eventually expire after 90 days despite cloud absence being unresolved.

**Fix direction:** route shared notebooks through stable-identity reconciliation with content/incarnation guards. The guarded `followSharedPdfChanges()` implementation does not protect this separate refresh-time routine.

## Other correctness / robustness issues

### MISC-1 — Accepted paths and collision suffixes can exceed actual filesystem/OneDrive limits

**NEW · medium · confirmed by reading the code**

**References:** `src/lib/collab/protocol/schema.ts:238`, `electron/collab/notebooks/layout.ts:69`, `electron/collab/notebooks/layout.ts:127`, `electron/collab/notebooks/project.ts:662`.

**Scenario:** 1. A manifest path passes the 1,024-character/255-JavaScript-character checks. 2. Its full cloud path, UTF-8 component length, or suffix-expanded filename exceeds the destination limit. 3. Materialization repeatedly attempts placement.

**Effect:** files can remain permanently unmaterialized or OneDrive-unsynced. A valid maximum-length name can become invalid after ` (2)` is added; that result is not revalidated. Microsoft documents a 400-character decoded cloud-path limit and additional filesystem limits. [Microsoft path limits](https://support.microsoft.com/en-us/onedrive/what-are-file-path-length-limits).

**Fix direction:** validate complete destination paths and component byte lengths, reserve suffix space, and surface permanent placement refusal.

### MISC-2 — Scan identity comparisons disagree with normalized manifest identity

**NEW · low · likely**

**References:** `src/lib/collab/protocol/schema.ts:256`, `electron/collab/notebooks/project.ts:1661`, `electron/collab/notebooks/project.ts:1670`, `electron/collab/notebooks/project.ts:1696`, `electron/collab/notebooks/project.ts:1804`, `electron/collab/notebooks/project.ts:1854`.

**Scenario:** 1. A filesystem/provider returns a different Unicode normalization or case spelling from the stored path. 2. Layout collision handling treats the spellings as one identity, but scan maps/known-path tests compare raw strings. 3. The same logical file appears missing and fresh.

**Effect:** unnecessary inferred renames, path retirement, or document-creation attempts that are subsequently rejected by normalized collision checks. Exact behavior depends on filesystem spelling and simultaneous content changes; silent corruption is not established here.

**Fix direction:** index scan observations by the same canonical key, retaining display spelling separately and handling multiple observations of one key explicitly.

### MISC-3 — Duplicate cloud roots of an already registered project are silently skipped

**NEW · medium · confirmed by reading the code**

**References:** `electron/collab/notebooks/service.ts:353`, `electron/collab/notebooks/service.ts:620`, `electron/collab/notebooks/service.ts:741`, `src/lib/collab/shared-notebook.ts:128`.

**Scenario:** 1. OneDrive or the user creates another notebook directory carrying the same project marker. 2. The original registered root still exists. 3. Adoption skips the duplicate because that project is already registered; moved-root recovery runs only when the original root is missing.

**Effect:** the duplicate remains guarded as shared but has no corresponding active runtime/index. Its files can become a confusing stale/locked copy without the ambiguity diagnosis used during missing-root recovery.

**Fix direction:** detect and expose duplicate roots even when the registered root exists; provide explicit selection, detachment, or recovery.

### MISC-4 — Collaborative roles do not control a second writable OneDrive sharing channel

**NEW architectural risk · medium · likely; conditional on OneDrive ACLs**

**References:** `electron/collab/notebooks/project.ts:1283`, `electron/collab/notebooks/project.ts:1309`, `electron/collab/notebooks/project.ts:1683`, `electron/collab/notebooks/project.ts:1779`, `electron/collab/notebooks/fs-ops.ts:14`.

**Scenario:** 1. Different contributors have write access to the same physical OneDrive folder. 2. A collaborative viewer changes files through OneDrive. 3. An editor/owner installation receives those changes and imports them as its own external edits.

**Effect:** the viewer’s changes can reach the collaborative server under the writer account’s valid authority. Private sidecars, archives, and recovery copies also follow OneDrive ACLs rather than collaborative roles. This is a boundary between two permission systems, not a direct server role bypass.

**Fix direction:** require independent per-contributor folders, make this constraint explicit, or require review of externally originated changes in folders with cross-contributor cloud write access.

## 3. What reading alone could not verify

The following experiments would settle the remaining uncertainties. They should use disposable libraries, accounts, and databases.

| Area | Experiment |
|---|---|
| Real OneDrive hydration | On Windows and macOS, exercise online-only files while offline, reconnecting, dehydrating, and under provider failure. Measure whether reads/stat calls block, fail, or continue after the application timeout. Relevant: DL-1, SYNC-1/2. |
| File publication and locking | Record actual watcher events and readable bytes during OneDrive delivery, conflict resolution, rename, and locked-file retries. Establish whether intermediate nonempty bytes are visible. Relevant: DATA-12/13/16. |
| Real renderer recovery | Kill only the utility process while a shared editor remains open; type before, during, and after restart; reload afterward. Assert each edit’s host persistence and server delivery. Relevant: DATA-1. Core-host restart tests do not establish this renderer lifecycle. |
| Storage failures | Inject SQLite `FULL`, `BUSY`, and IO errors separately for local appends, remote appends, initial diffs, and acknowledgements. Recover storage without reconnecting. Relevant: DATA-2/3. |
| Lifecycle isolation | Hold a project queue or lifecycle lock while other notebooks renew leases; continuously edit during join/takedown. Assert bounded completion and unrelated lease availability. Relevant: DL-2/3/4. |
| Clock behavior | Run devices with substantial positive/negative wall-clock offsets and suspend/resume them across lease expiry. Relevant: DL-5. |
| Power-loss durability | Use a VM/storage fault harness that loses unflushed writes immediately after export and server deletion. Process-kill tests alone cannot establish power-loss durability. Relevant: DATA-14. |
| Server concurrency | On real PostgreSQL, pause REST mutations after authorization, revoke membership, then release them. Separately interleave blob GC/reference creation and crash command execution before result insertion. Relevant: PERM-2, DATA-15, WRITE-5. |
| Manifest trust boundary | In an isolated fixture, submit malformed IDs, foreign document references, invalid kinds/hashes, and duplicate document references. Assert that clients reject them before filesystem work. Test PERM-1 using a disposable sentinel only. |
| Cloud copies and history | Deliver conflict copies with multi-hyphen device names, divergent bytes, and versions older than remembered history; repeat after deletion and restart. Relevant: SYNC-5, STALE-7. |
| Unicode/case/length | Exchange NFC/NFD and case-only names between Windows, APFS, and a case-sensitive filesystem; include maximum-length names and collisions requiring suffixes. Relevant: MISC-1/2. |
| Live SQLite inside notebooks | Modify a disposable database while OneDrive and collaborative blob materialization run; verify logical integrity and committed rows after restore. Relevant: DATA-4. |
| Follower disk lag | Delay file contents independently of manifests, markers, and sidecars. Exercise replacement, upload, copy/export, transcript edits, rename/delete, and remote takedown. Relevant: DL-9, STALE-1/2, DATA-5–8/17. |
| PDF recovery | Race ordinary tree refresh/set-aside with sidecar saves and identical PDFs at different stable IDs. Include prolonged missing files and orphan expiry. Relevant: DATA-19. |
| Resource scale | Measure peak memory, outstanding reads, write bytes, and duplicate outbound traffic for large fresh-file sets, oversized files, large manifests, and slow catch-up. Relevant: DL-7/8, SYNC-1/2/6, WRITE-1. |
| Cleanup across volumes | Put notebooks and Electron profile storage on different volumes; inject busy-file failures and crashes during detachment. Verify durable retries and recovery visibility. Relevant: STALE-3/4/5. |

Microsoft confirms that accessing online-only files can download them, but that documentation does not establish this application’s timeout, locking, or publication behavior under every failure mode. Those portions require the provider experiments above. [Microsoft Files On-Demand documentation](https://learn.microsoft.com/en-us/sharepoint/files-on-demand-windows).