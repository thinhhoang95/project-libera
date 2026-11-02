# Sync boundary review — 1 November 2026

**All five boundary findings (G20–G24) are fixed**, with passing regressions in the normal collaboration suite. Their original severities were four P1 and one P2. This review checks neighboring event orders in [the notebook sync matrices](../features/notebook-sync.md), including a server-identity combination previously marked unverified. The failure descriptions below preserve the pre-fix behavior.

The reproductions use disposable accounts, local collaboration servers and separate cloud-copy directories. They simulate delivery order and pending network responses; they do not run a real OneDrive or iCloud client.

| Finding | Original priority | Original reproduced result | Matrix |
|---|---|---|---|
| G20 | P1 | A binary edit arriving during a download is overwritten without an archive copy. | A: replace binary; B: replace binary; X27 |
| G21 | P1 | Switching servers with matching account/document IDs publishes an A-only acknowledged edit into B. | X24, X29 |
| G22 | P1 | A disk rename queued before an unrelated upload reinserts a blob another device deleted during that upload. | A: rename/move; B: delete; X26 |
| G23 | P1 | A late cloud copy of a deleted text file becomes a new live shared document, including after restart. | A: create/delete; B: shared tombstones; X25 |
| G24 | P2 | A pending lease response holds the global lease pass and blocks the hook used by sign-out/account switching. | X14, X28 |

P1 means fix before relying on the affected behavior; P2 is an availability failure with a narrower trigger. These findings extend the preserved historical descriptions in the two earlier reviews.

## Implemented corrections and regression coverage

| Finding | Correction | Verification |
|---|---|---|
| G20 | Re-read the destination after download and verify its hash at each guarded disk commit. Archive intervening bytes and retain the incomplete-baseline fence if placement fails. | Original separate-root race; injected placement failure after successful archiving, across repeated scans beyond delete grace, followed by successful retry. |
| G21 | Select databases/generations by normalized server plus account, verify persisted ownership and marker authority, and use an independent client namespace for fresh databases. Verified legacy files remain in place with their original client identity and durable pending work. Ambiguous files are pinned for recovery without assigning them to a new server. | Original cloned-server race now also verifies new B edits and return to A; actual schema-1 upgrade; ambiguous legacy persistence; real-server offline-edit replay from a legacy host. |
| G22 | Resolve inferred renames/deletes against the current manifest inside the committing transaction. Preserve current unrelated fields, reject missing/moved targets and occupied destinations, and remember rejected aliases. Recheck new disk input after HTTP waits. | Original delayed rename/deletion race; ordinary sync, rename, share-retry and tree-event suites. |
| G23 | Commit retired paths in profile-local SQLite when observing manifest removals/moves and before discarding layout entries. Archive unexplained returning files; allow deliberate collaborative recreation and ordinary unrelated new-file imports. | Original late-delivery race, fresh host restart, archived recovery copy, explicit same-path recreation and ordinary new-file import. |
| G24 | Bound complete REST operations, including token waits and response bodies; forward native abort signals and bound adapters that ignore them. Cancel host requests before account/shutdown waits. Lease acquisition is at most five seconds and release at most one second. | Original hanging-lease hook; stalled successful/error bodies; stalled token acquisition with no late mutation; cancellation of an uncooperative adapter followed by a successful new request. |

The five original scenarios run through [notebooks-boundary-regressions.test.ts](../../scripts/collab/notebooks-boundary-regressions.test.ts). Six additional cases live in [notebooks-boundary-recovery.test.ts](../../scripts/collab/notebooks-boundary-recovery.test.ts). Matrix requirements were retained while implementing these corrections.

## G20 — binary download commits over an intervening external edit

**Source:** [`SharedProject.placeBlob()`](../../electron/collab/notebooks/project.ts), especially the initial `readIfExists()`, `await blobBytes()`, and final `writeFileAtomic()`.

The decision to preserve external bytes is made before downloading the replacement. After that wait, the write guard rechecks the root, lease, current manifest hash and path, but never re-reads the destination bytes. An external editor or cloud delivery can therefore change the same file while the download is pending. The project queue holds watcher scans behind the download, so the watcher cannot preserve those bytes first.

**Reproduction:** two independent roots of the same account/folder; the follower publishes replacement bytes `[5,6,7,8]`. Pause the writer's download after its initial disk check, replace its existing file with external bytes `[9,10,11,12]`, then finish the download. Disk becomes `[5,6,7,8]`; `_archive/image.png` does not exist. The external input was never uploaded or recorded by the host.

**Correction:** validate the destination's observed version after the network wait and preserve any intervening bytes before replacing it. Keep the root/manifest/lease guards. Include cancellation and failure between preservation and the final write in the eventual regression coverage.

**Test:** `a binary edit arriving during download is preserved before replacement`.

## G21 — local sync state is scoped to account ID without server identity

**Source:** [`databaseKey()`, `CollabRuntime.signedIn()` and `open()`](../../electron/collab/control/runtime.ts); [stored-project loading](../../electron/collab/notebooks/service.ts); [host account reconnect](../../electron/collab/core/host.ts).

The runtime selects its database/generation using only `auth.account.id`. An explicit switch to another server with that ID reuses the old SQLite state and hubs. Existing hubs reconnect to the new server, and stored project loading does not require their markers to match the current server. If document IDs also match, the normal Yjs missing-state exchange publishes the old authority's content into the new authority.

**Reproduction:** create a notebook with `common baseline` on server A, stop A cleanly, and copy its server data to start independent server B. Restart A and acknowledge `private on A` there. B still has only the common baseline. Explicitly sign the same desktop runtime into B using a fresh B session. The local database path is reused, A's marker remains, and B's persisted content digest changes to the digest of `private on A\ncommon baseline\n`. Both servers still report the project as present.

This uses matching identities from a real backup, rather than assuming independently generated IDs happen to collide. The cross-server publication is observed; behavior for arbitrary unrelated ID collisions is not claimed.

**Correction:** scope databases, hub generations and outbound work by normalized server identity plus account ID. Validate that stored bindings belong to the active authority before opening them. Provide a deliberate migration policy for existing account-only database files; simply changing the filename must not strand pending work.

**Test:** `matching account IDs on separate servers do not reuse local sync authority`.

## G22 — a queued disk rename restores a remotely deleted blob

**Source:** [`SharedProject.scan()`](../../electron/collab/notebooks/project.ts), particularly the inferred-rename `operations.push(map => map.set(...))`, later `createFromDisk()` waits, and final operation execution.

The scan's binary-replacement operation re-reads the current entry when it commits, but the inferred-rename operation captures and later writes an entire older entry. The local queue does not prevent incoming Yjs mutations. Root and lease checks at the end of the pass establish neither entry existence nor the continued validity of that rename.

**Reproduction:** with two independent roots, rename `image.png` to `renamed.png` on the writer's disk and add unrelated `new.png`. Pause the scan's upload of `new.png`, after the rename operation has been prepared. From the follower, delete `image.png` and wait until its file ID disappears from the writer's live manifest. Release the unrelated upload. The scan publishes the original deleted file ID at `renamed.png`; the server relays that restored entry back to the follower.

**Correction:** resolve inferred operations against the current manifest inside the commit transaction. Refuse deleted/replaced targets and update only intended fields. Revalidate delayed inferred deletes and creates as well; the reproduction establishes the rename variant, not every neighboring operation.

**Test:** `an inferred rename waiting on another upload cannot resurrect a remotely deleted blob`.

## G23 — forgotten deleted paths turn late cloud bytes into shared creation

**Source:** [manifest removal and layout replacement](../../electron/collab/notebooks/project.ts), followed by the scan's `known`/`fresh` classification and [`createFromDisk()`](../../electron/collab/notebooks/project.ts).

Removing a shared entry archives its current file and drops it from the working layout. The scanner classifies files using that current layout; it retains no durable retired-path/content evidence for the deletion. A later copy arriving from an independent cloud root therefore looks like a new local file. Creating a fresh document ID bypasses the old document's valid server tombstone.

**Reproduction:** preserve a separate cloud snapshot of `note.md`, delete the shared file, wait for the manifest acknowledgement, and restart the notebook service. Deliver only the old file from the snapshot. One complete scan creates a new file ID/document ID at `note.md`. The old server document returns **404**, while the new one returns **200**; the original archive is still present. This demonstrates shared resurrection, rather than failure of the old document tombstone.

**Correction:** retain durable evidence of retired paths/identities and classify their unexplained return as recovery or reconciliation. Require explicit intent to restore them as new shared files. Preserve ordinary intentional file creation; a grace period or finite remembered hash list alone cannot establish the origin of a late delivery.

**Test:** `a late cloud copy cannot recreate a shared-deleted file after restart`.

## G24 — unfinished REST work blocks lifecycle progress

**Source:** [`ApiClient.send()`](../../electron/collab/core/api-client.ts), [the global lease pass and `beforeAccountChange()`](../../electron/collab/notebooks/service.ts), and [`CollabRuntime.signOut()`](../../electron/collab/control/runtime.ts).

The REST client passes no abort signal or application deadline to fetch, including response-body reads. The global lease pass awaits requests serially. `beforeAccountChange()` and service shutdown await that pass, while runtime account operations wait in one serial queue. A response that never finishes can hold that chain indefinitely; subsequent lease passes cannot run either. The monotonic lease fence still prevents the expired installation from continuing automatic disk work.

**Reproduction:** hold one folder-lease request on an otherwise working local server, then invoke the actual `beforeAccountChange()` hook. After 600 ms, the hook is still pending and the request has no abort signal. Release the response and it completes. The runtime's dependency on that hook is inspected in code; this test does not operate the sign-out UI or measure a native transport's default timeout. This is an uncancelled wait chain, rather than a demonstrated cycle of mutually held locks.

**Correction:** give REST operations bounded deadlines, including body consumption, and cancel superseded background work on account change/shutdown. Ensure one stalled project does not indefinitely prevent other lease checks. Preserve durable pending edits and handle aborted requests as uncertain outcomes where appropriate.

**Test:** `a hanging lease response cannot block account changes indefinitely`.

## Validation and limits

The [review script](../../scripts/collab/audit/sync-boundary-review.mjs) now passes all five scenarios. Node reports **6 passing tests** because it also counts the parent of the four shared-fixture cases. Its normal-suite wrapper keeps these regressions in CI. The six recovery/upgrade cases also pass.

```sh
node --require ./scripts/editor/setup.cjs --import tsx --test \
  scripts/collab/audit/sync-boundary-review.mjs
```

The original review baseline, before these fixes, passed **147 tests** across three runs:

- **57:** original/follow-up notebook audit wrappers, follow-up recovery boundaries, sync recovery and host sync.
- **53:** synced folders/peers, share retry, shared sign-in, notebook lifecycle/takedown, control API and storage guards.
- **37:** server membership races, sync documents/connections/rooms/compaction and API/sync integration.

After the corrections, a broad notebook/host/store/Electron selection passed **117 tests**. An expanded selection covering the new boundaries, albums, guards, shared sign-in, proxy and control routes passed **65 tests**. The final six-case recovery run additionally verifies legacy offline replay. These selections overlap and include parent tests; their counts are not additive and do not establish exhaustive matrix coverage.

The scoped application/host/collaboration typecheck, targeted lint and host bundle build pass. The repository-wide typecheck still reports unrelated diagnostics in existing editor tests (document chat/OCR, PDF outline/text-layer mocks, and workspace/tab fixtures); the edited production code and collaboration tests typecheck cleanly.

Unverified combinations still include real provider hydration/conflict behavior, broader clock skew/missing-base cases, account/server changes during interrupted sharing, arbitrary forced root replacement, full process crashes during these races, Windows sharing/rename failures, and production Postgres/distributed-server concurrency. The prior X24 server-identity gap now has passing coverage, including legacy upgrade/replay. The other gaps are not claimed closed. Ambiguous old database files remain intact with a recovery diagnostic rather than being silently assigned to an unproven server.
