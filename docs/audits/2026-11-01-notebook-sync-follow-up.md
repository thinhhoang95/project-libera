# Notebook sync follow-up review — 1 November 2026

**All nine follow-up findings are fixed**, with passing regressions for the eleven originally failing scenarios. They had five P1 and four P2 severities. These extend the ten fixed findings in the [first review](2026-11-01-collaboration-sync-review.md). The descriptions below preserve the original failure mechanisms; they describe behavior before these fixes.

The review focused on the previously unverified X13–X18 combinations in the [feature matrix](../features/notebook-sync.md#interaction-matrix-and-coverage): independent cloud roots, lease partitions, incomplete scans, corrupt bookkeeping, late markers, stale versions and lifecycle identity. Three additional controls pass: follower takedown with a lost success response, real account switching, and sharing again under the same requested notebook name while old offline work exists.

P1 means correct before relying on this behavior in normal collaboration. P2 is a narrower correctness or availability failure. None of the tests establishes behavior of a real OneDrive/iCloud client; they control the delivery order and faults at the application's filesystem/network boundaries.

## Original findings and priority

| ID | Priority | Original breakdown | Matrix |
|---|---|---|---|
| G11 | P1 | An expired writer can publish a shared delete after another cloud root takes over. | X14 |
| G12 | P1 | A capped or incomplete walk deletes unvisited files and tombstones their server documents. | X15 |
| G13 | P2 | One malformed layout record aborts startup before healthy notebooks and lease polling start. | X15, X21 |
| G14 | P2 | A partially valid marker aborts adoption/startup for the library. | X15, X22 |
| G15 | P1 | An unreadable marker makes the storage guard allow a direct write into a known live share. | X15, X23 |
| G16 | P1 | A stale copy older than eight remembered versions becomes an acknowledged text rollback. | X17 |
| G17 | P2 | A same-size overwrite with preserved mtime remains invisible to the watcher and poller. | X17 |
| G18 | P2 | An externally renamed notebook is silently orphaned by its stale stored root. | X16 |
| G19 | P1 | A late unrevoked marker restores the deletion lock after confirmed takedown or member revocation. | X16 |

## Fixes and regression coverage

| Finding | Implemented correction | Verification |
|---|---|---|
| G11 | A conservative monotonic lease deadline fences automatic disk reads/writes and publication, including after uploads. Expired/signed-out installations follow; explicit collaboration remains available. Legacy copies derive a common lease identity, preserving a locally known ID when available. | Original split-root case; upload outliving its lease and explicit follower rename; independent legacy copies; updated signed-out policy test. |
| G12 | Walks report completeness. Incomplete observations reset deletion grace and defer scan mutations; initial sharing refuses an incomplete inventory. | Both capped and missing-subtree cases keep the file live on disk and server. |
| G13 | Validate every layout/history/reconciliation record; preserve invalid input beside the state file before rebuilding a guarded baseline. Contain startup errors per notebook and retry. | Original corrupt-state case plus exact-byte quarantine/healthy-start verification. |
| G14 | Share the complete marker schema between host and storage guard; reject partial identities safely. Contain discovery errors per folder. | Original malformed-marker case; valid neighboring folder starts and lease polling remains installed. |
| G15 | Present unreadable markers and missing/conflicting markers for a known active local binding stay guarded; no routing identity is invented. | Real storage-save regression, plus stale-old-marker/new-project guard checks. |
| G16 | Unexplained older/equal-mtime text becomes reconciliation. Uncertain binary bytes are archived before restoring the current version; failed transfers never turn that gap into deletion. | Original ten-version rollback retains current text/server digest with reconciliation; failed binary download preserves both versions; existing intentional-restore tests remain covered. |
| G17 | Watch events force content verification; ctime participates in the shortcut; periodic hashes run even when all observed metadata stays equal. | Original equal-stat overwrite plus missed-watch/frozen-stat periodic verification. |
| G18 | Remember local root identities, rebind one compatible moved root, require fresh server identity for legacy rows, and flag ambiguous copies. | Original external-root rename restores path resolution and updates the stored root. |
| G19 | Persist identity-scoped terminal decisions outside the cloud folder. Next consults them synchronously; discovery repairs old markers even signed out or revoked. Active newer bindings remain guarded. | Both late-marker cases plus stopped-host persistence, same-root re-sharing, old-marker replay after re-sharing, and the Electron profile/environment seam. |

The [normal-suite wrapper](../../scripts/collab/notebooks-followup-regressions.test.ts) runs all fourteen follow-up scenarios. Six additional [boundary tests](../../scripts/collab/notebooks-followup-recovery.test.ts) cover restart, quarantine, periodic verification, failed binary downloads, legacy identities and in-flight lease expiry. The host and Next share [local-notebook-state](../../src/lib/collab/local-notebook-state.ts), and Electron passes its profile-local directory through `LIBERA_COLLAB_LIFECYCLE_DIR`.

**Behavior change:** a marker naming this installation is no longer enough to authorize automatic folder work. After lease expiry, sign-out, or an unavailable lease implementation, automatic imports/materialization pause. Explicit editor changes remain durable in SQLite, and follower collaboration keeps its existing permission rules. External disk bytes stay available for reconciliation when an authorized writer resumes.

## G11 — expired writer publishes a deletion after takeover

**Source:** [offline writer policy](../../electron/collab/notebooks/service.ts), [lease renewal](../../electron/collab/notebooks/service.ts), [disk scan](../../electron/collab/notebooks/project.ts), [server lease](../../server/src/api/projects.ts).

The lease result has no retained local expiry/fencing generation. If renewal becomes unavailable, `keepsWriting()` continues trusting the local marker. Another installation with an independently delivered cloud folder can acquire the expired server lease and update only its own marker. Both runtimes remain writers. The old runtime still converts disk absence into a manifest delete; ordinary sync authorization checks membership, not whether this disk-derived operation came from an expired folder writer.

**Reproduction:** two separate roots of the same account/project/folder ID; block only the old host's lease endpoint, keeping its WebSocket alive. After the new host acquires the expired lease, remove `note.md` from the old root to simulate uncertain cloud delivery. Both hosts report writer. The server-relayed manifest on the new writer becomes empty, and its existing file moves to `_archive`.

**Required correction:** fence automatic disk imports/deletes using fresh ownership and a folder generation, or suspend them after lease expiry and reconcile the old copy after ownership is re-established. Retain offline bytes and explicit user edits. Rejecting every follower's CRDT update would break the supported follower editing path; the distinction is disk-derived intent.

**Test:** `an expired writer cannot infer shared deletion after another cloud root takes over`.

## G12 — incomplete scan becomes a shared deletion

**Source:** [walk and limit](../../electron/collab/notebooks/fs-ops.ts), [walk result consumption](../../electron/collab/notebooks/project.ts), [missing-file inference](../../electron/collab/notebooks/project.ts).

`walkNotebook()` returns only `entries` and `skipped`. Reaching its 50,000-entry cap returns a prefix without an incomplete indication. A subtree whose `readdir` returns `ENOENT`/`ENOTDIR` also disappears from coverage without marking the walk incomplete. The scanner treats every known file absent from that result as a deletion after the grace period. G02's startup baseline protection does not cover an already established file omitted by a later scan.

**Reproductions:**

- Use the real walker with its public limit lowered to two, on three existing shared files. The unvisited `z.md` is removed from the manifest and archived despite having existed on disk at scan entry. Its server document returns **404**. This is a scaled algorithm reproduction, not a real 50,000-file stress test.
- Inject a transient `ENOENT` for an existing child directory's `readdir`, while the notebook root/marker remain valid. After two scans across the grace period, `nested/note.md` is removed and archived, and its server document returns **404**.

**Required correction:** return scan completeness/failed subtree information. Defer negative conclusions about unvisited paths, and do not allow a time-based grace period to turn repeated incomplete coverage into proof of deletion. Continue handling confirmed changes in fully visited paths where safe.

**Tests:** `a capped walk must not delete an existing unvisited shared file`; `a transient unreadable subtree must not look like a completed scan of deleted files`.

## G13 — malformed layout disables healthy notebooks at startup

**Source:** [state parser](../../electron/collab/notebooks/state.ts), [startup baseline](../../electron/collab/notebooks/project.ts), [service startup/load](../../electron/collab/notebooks/service.ts).

`readState()` validates the version and that `layout` is an object, but does not validate individual records. Valid JSON containing `layout: { broken: null }` reaches `SharedProject.open()`, which reads `record.kind` and throws. The exception aborts the entire project-loading loop. `started` remains true, the lease timer is never installed, and a later `start()` returns immediately. The desktop runtime catches/logs service startup errors, so core routes may work while notebook sync stays broken.

**Reproduction:** share `A-corrupt` and `Z-healthy`; stop the service; replace only the first notebook's state with the shape above; restart. Observed: **`Cannot read properties of null (reading 'kind')`**, healthy runtime absent, `started: true`, lease polling absent. The files themselves remain on disk.

**Required correction:** validate bounded layout records, preserve/quarantine invalid state, isolate failures per notebook, and make failed initialization retryable. Do not infer destructive changes from a fallback baseline whose integrity is unknown.

**Test:** `one malformed layout record cannot prevent healthy notebooks from starting`.

## G14 — partially valid marker aborts library adoption

**Source:** [marker parser](../../electron/collab/notebooks/state.ts), [adoption loop](../../electron/collab/notebooks/service.ts), [service startup](../../electron/collab/notebooks/service.ts).

`readMarker()` accepts any object with string project/manifest IDs. Adoption then calls `marker.serverUrl.replace()` without verifying that `serverUrl` is a string. A marker with the two IDs and the current account, but no URL, throws outside the per-folder adoption operation. As in G13, library startup aborts with `started` true and no lease timer.

**Reproduction:** place `A-broken` with that partially valid marker and an independent valid `Z-healthy` cloud copy in a fresh library. Restart the service. Observed: **`Cannot read properties of undefined (reading 'replace')`**, healthy project not adopted, no lease polling.

**Required correction:** validate the full identity/schema before accessing marker fields, and contain a malformed folder's failure so other folders can start. An invalid marker should produce a visible recoverable state.

**Test:** `a partially valid marker cannot abort adoption of the whole library`.

## G15 — corrupt marker makes storage writes bypass collaboration

**Source:** [Next-side marker parsing/cache](../../src/lib/collab/shared-notebook.ts), [storage save guard](../../src/lib/storage/files.ts), [host root validation](../../electron/collab/notebooks/project.ts).

The Next-side guard conflates a missing marker with a present but unreadable marker: JSON parsing failures return `null`, and `isSharedNotebookPath()` returns false. The host makes a different decision: its root is unavailable, so it stops ordinary disk synchronization. A transient corrupt/partial marker therefore opens a direct filesystem write path while the collaboration host still knows the share.

**Reproduction:** create a real live share, replace its marker with truncated JSON, invalidate the guard cache and call the real `updateMarkdownFile()`. It returns normally. Observed: disk contains **`bypassed collaboration`**, the live hub still contains **`live shared text`**, and the project runtime remains registered. This establishes a guard bypass and divergence; the test does not claim those bytes are irretrievably lost.

**Required correction:** distinguish absent, valid and unreadable/foreign marker states. Keep direct writes guarded while a marker exists but cannot be validated, and reconcile that decision with the host's durable identity/lifecycle state. Apply the same policy to every storage writer, not just text saves.

**Test:** `an unreadable marker cannot silently enable direct storage writes into a known share`.

## G16 — history eviction permits an acknowledged stale rollback

**Source:** [eight-version history](../../electron/collab/notebooks/state.ts), [stale-copy decision](../../electron/collab/notebooks/state.ts), [external edit import](../../electron/collab/notebooks/project.ts).

The stale-copy guard only recognizes hashes in the eight remembered previous versions. An older hash, even with an mtime older than the current baseline, is classified as an ordinary external edit when the shared text still equals the materialized hash. The merge base does not protect this path: `takeExternalEdit()` directly diffs the shared text to the disk bytes.

**Reproduction:** acknowledge ten successive versions, then atomically restore `version 0` with its original old mtime. The previous-hash list has eight entries and excludes that version. Observed: hub and disk become **`version 0`**, reconciliations remain **0**, and the server digest equals the stale text's SHA-256, not `version 10`'s hash. This is a server-persisted rollback, not merely a stale local file view.

**Required correction:** an older unexplained delivery needs reconciliation/quarantine or a verifiable version/generation policy. Increasing the remembered-history count alone only moves the failure boundary. Preserve intentional restores through an explicit action or other trustworthy intent signal.

**Test:** `stale bytes older than the eight-version history cannot silently roll back shared text`.

## G17 — preserved size/mtime hides a real overwrite

**Source:** [scan optimization](../../electron/collab/notebooks/project.ts), watcher scheduling immediately above it.

For a file whose mtime is more than three seconds old, matching size and mtime skip hashing entirely. A watch event schedules this same scan and does not force verification of its changed path. A cloud/restore operation or external tool preserving those attributes can change content without any import, reconciliation or status change. The source condition keeps skipping while those attributes remain equal.

**Reproduction:** share `AAAA`, establish a settled/coarse mtime, overwrite it with equal-length `BBBB`, and restore that exact mtime. After multiple polls, disk is **`BBBB`**, shared text is **`AAAA`**, and reconciliations remain **0**.

**Required correction:** force verification of watch-dirtied paths and add bounded periodic/resume content verification when filesystem metadata cannot prove equality. Size/mtime equality can be an optimization, not a permanent correctness decision.

**Test:** `same-size writes with preserved coarse mtime must not remain silently unsynced`.

## G18 — moved notebook cannot escape its stale stored root

**Source:** [stored-root loading](../../electron/collab/notebooks/service.ts), [adoption suppression](../../electron/collab/notebooks/service.ts), [takedown handle lookup](../../electron/collab/notebooks/service.ts).

A missing old root is skipped when loading the project's store row. When marker discovery finds the moved folder with the same project/folder identity, it also skips it because that store row already exists. The result is neither a running project nor an unjoined-folder recovery entry. The active marker continues guarding the new location, but the control service has no project handle with which to take down the share.

**Reproduction:** share `BeforeRename`, stop the service, rename the folder to `AfterRename`, and restart/tick. Observed: local projects **empty**, `resolvePath("AfterRename/note.md")` **null**, old absolute root still in SQLite, matching active marker in the new folder. A normal control takedown has no handle to act on.

**Required correction:** reconcile stored roots against discovered identities. Rebind a unique compatible match, or expose a recovery action if duplicates/foreign identities make rebinding ambiguous. Do not treat a stale row as proof that a discovered matching copy is already handled.

**Test:** `an externally renamed cloud notebook can be rebound without joining a duplicate`.

## G19 — late active marker restores a deletion lock

**Source:** [terminal-project polling](../../electron/collab/notebooks/service.ts), [signed-in-only adoption](../../electron/collab/notebooks/service.ts), [local removal](../../electron/collab/notebooks/service.ts), [notebook deletion guard](../../src/lib/storage/notebooks.ts).

The previous G04/G05 fixes make the immediate cleanup/marker transition work. They do not keep that decision authoritative over a later old marker delivered by the cloud provider. Owner takedown deletes the store row, leaving no durable local lifecycle record for signed-out marker reconciliation. Member revocation keeps a terminal handle, but polling skips revoked projects and adoption skips known ones. The storage guard subsequently trusts the old marker's missing `revoked` flag over the already confirmed lifecycle outcome.

**Reproductions:**

- Owner takedown succeeds and removes the marker. Sign out, deliver the saved pre-takedown marker, then tick and invoke the real `deleteNotebook()`. The project/store row are absent, but deletion throws **`shared-document`**.
- Remove a member and wait until both the local handle and marker report revoked. Deliver the earlier unrevoked marker while the account stays signed in. After a tick, the handle still says **revoked**, the marker says **not revoked**, and the same real deletion function throws **`shared-document`**.

This is another concrete way for the deletion-lock problem in the original request to recur. A signed-out owner can recover by reconnecting and obtaining a fresh server verdict; the existing revoked member handle also needs a path to repair the stale marker instead of being skipped indefinitely.

**Required correction:** retain account/server/project-scoped lifecycle decisions independently of cloud-controlled markers, reconcile terminal copies as well as active ones, and make the storage guard use that durable decision. Preserve newer/different project and folder identities while repairing old markers.

**Tests:** `a late old marker cannot relock a known taken-down notebook after sign-out`; `a late old marker cannot relock a member copy already known to be revoked`.

## Passing controls and limits

| Scenario | Verified result | Limit |
|---|---|---|
| Real `CollabRuntime` switches A → B → A | Database changes by account; B does not adopt A's folder; A's marker/project survive and its stored project resolves on return. | One server, different account IDs; no same-ID cross-server collision test. |
| Follower takes down a notebook; DELETE commits, response is lost, former writer is stopped | Control returns 204 after confirmation; follower marker is removed, latest local text retained, local project list empty. | Separate roots with simulated lost response; no real cloud provider. |
| Old project has revoked offline text; new project uses the same requested notebook name | New project/document IDs and a separate suffixed folder; old pending work remains recoverable and cannot sync into the new project. | Does not force reuse of the exact old absolute root. |

All tests are in [sync-followup-edge-cases.mjs](../../scripts/collab/audit/sync-followup-edge-cases.mjs). Run from the repository root:

```sh
node --require ./scripts/editor/setup.cjs --import tsx --test \
  scripts/collab/audit/sync-followup-edge-cases.mjs
```

Original review result: **14 scenarios: 11 failed, 3 passed**, covering nine findings. G12 and G19 each had two failing scenarios. After the fixes, **all fourteen scenarios pass** (Node counts their parent too: **15 passing tests**), and the normal collaboration suite runs them automatically.

The original ten-scenario audit passed during the review, and its desktop cases remain part of the notebook regression selection. The broad notebook/album/control/storage-guard/host-sync run passed **143 tests**. A final expanded selection passed **53 tests**, including all follow-up cases, all six boundary tests, the original desktop regressions, legacy upgrades, storage guards, share retries and synced-folder handover. These selections overlap and are not additive. Electron main-process tests passed **2**, including the profile-local directory bridge, and the standalone original server membership race passed **1**. The scoped application/host typecheck, targeted lint and host bundle build pass.

The existing share-retry test caught an old uploaded hash being paired with a newer disk mtime; the initial baseline now leaves those stats unset until verified, and that regression passes. The prior expectation that an apparently lone signed-out folder keeps importing disk edits changed deliberately: its marker cannot prove no other installation may take over. The updated test verifies paused disk imports, preserved external bytes and durable explicit offline editor changes.

Remaining limits include real OneDrive/iCloud hydration/conflict behavior, real network-filesystem faults and clock skew, a full 50,000-entry load, production Postgres/distributed-server concurrency, full process crashes during these transitions, and every Windows sharing/rename failure timing. Same-root re-sharing and stale marker replay now have boundary coverage, but arbitrary forced cross-project root replacement still needs separate tests. A passing control closes only its stated combination; neighboring unverified conditions remain in the feature matrix.
