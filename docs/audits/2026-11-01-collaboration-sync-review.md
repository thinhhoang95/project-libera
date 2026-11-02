# Collaboration and cross-device sync review — 1 November 2026

Ten distinct failures were reproduced in the original review: five P1 and five P2. **All ten findings are now fixed**, with passing regressions. The descriptions below preserve the original failure mechanisms and evidence; they describe behavior before the fixes.

The [feature behavior reference](../features/notebook-sync.md) describes the two transports, required invariants, operation/condition matrices, and combinations still awaiting tests. Its `Gxx` findings and `Xxx` scenarios refer to this report. P1 means fix before relying on this behavior in normal collaboration; P2 still requires a correction, but is more limited in impact or trigger.

## Fixes and regression coverage

| Finding | Correction | Regression coverage |
|---|---|---|
| G01 | Recheck access at queued admission; invalidate in-flight lookups on membership changes; lock the validated membership role through update commit. | [Server membership races](../../server/test/sync-membership-races.test.ts): removal, demotion, and no sequence allocated after access changes. |
| G02 | Treat startup/takeover disk absence as an incomplete baseline; materialize current shared files before ordinary disk-delete inference is enabled for them. | Original separate-root takeover regression. |
| G03 | Stop disk tasks, preserve current hub text and distinct external bytes, then remove share markers/mappings; guard final writes too. | Original remote-takedown regression and the existing takedown/lifecycle suites. |
| G04 | Mark every matching local copy revoked after confirmed access loss, including followers; preserve other project/folder identities. | Original follower regression and updated [synced-folder test](../../scripts/collab/notebooks-synced-folder.test.ts). |
| G05 | A locally recorded manifest is a known share even at sequence zero; confirmed not-found triggers lifecycle cleanup. | Original stopped-device / empty-project regression. |
| G06 | Serialize join with revocation, restore authorized hubs/roles, and quarantine pre-revocation pending updates before opening the current server state. | Original rejoin regression plus [offline recovery and editor attachment](../../scripts/collab/notebooks-sync-recovery.test.ts). |
| G07 | Re-read blob entries after upload; preserve the current path, reject deleted/replaced targets, and avoid stale manifest writes from disk scans. | Original rename race plus deletion during upload in [recovery tests](../../scripts/collab/notebooks-sync-recovery.test.ts). |
| G08 | Guard root identity and runtime lifetime at disk commits/retries; create descendants without recreating the root; fence stale blob paths/hashes. | Original deleted-root regression plus foreign-root replacement in [recovery tests](../../scripts/collab/notebooks-sync-recovery.test.ts). |
| G09 | Update stored/open hub roles and notify existing replicas immediately; refresh server admission after a role change. | Original live role regression now checks downgrade and promotion. |
| G10 | Retry identical persisted batches after transient errors or missing acknowledgements, with bounded backoff and cancellation on disconnect/revocation. | Original internal-error regression plus healthy-connection acknowledgement timeout in [host-sync](../../scripts/collab/host-sync.test.ts). |

The desktop review cases run automatically through [notebooks-sync-regressions.test.ts](../../scripts/collab/notebooks-sync-regressions.test.ts). A standalone command remains available below.

## Original findings and reproductions

### G01 — P1: a queued document open can outlive membership removal

**Location:** [session open](../../server/src/sync/session.ts), especially the queued admission callback; [membership handling](../../server/src/sync/server.ts) updates/closes documents already registered on the session.

`open()` reads document access before waiting for the room and its queue. If membership is removed while the open waits, `membershipChanged()` sees no open document to close. The queued callback subsequently installs the old role without checking membership again. Later updates trust that installed role. This was an authorization failure, beyond stale client UI.

**Reproduction:** hold a room queue, start an editor's open, wait until it is enqueued, remove the editor through the actual REST endpoint, then release the queue. Removal returns **204**; the open still returns role **editor**; the removed account's next content update is **acknowledged**, and the server text becomes `written after removal`.

**Correction:** serialize authorization and room admission with membership changes, or use a membership generation plus a fresh check at admission/commit. Cover removal and demotion while both open and persistence are waiting. Rechecking only before an asynchronous queue wait is insufficient.

**Evidence:** [server-membership-race.mjs](../../scripts/collab/audit/server-membership-race.mjs), X01.

### G02 — P1: taking over a partially delivered cloud folder publishes a shared deletion

**Location:** [writer takeover](../../electron/collab/notebooks/service.ts), [missing-file materialization](../../electron/collab/notebooks/project.ts), and disk-scan deletion in the same materializer.

A newly promoted writer loads the cloud copy's `state.json`. A recorded hash plus an absent file is treated as a user delete; the watcher removes the manifest entry after the grace period. Independent OneDrive deliveries can put state/marker ahead of a file. The follower can have the complete, current CRDT and still delete that file from the shared project after promotion. The server then tombstones the text document.

**Reproduction:** copy a shared folder to a separate device root, omit one text file but retain its state/marker, let the second host follow, then stop the first writer. After takeover, `resolvePath()` for the file becomes **null**. Its text survives in `_archive`, but it is removed from the live shared notebook.

**Correction:** distinguish an established local deletion from an incomplete incoming copy. Takeover needs a validated baseline/materialization stage before disk absence can become destructive intent; time elapsed alone cannot establish cloud completeness. Include binaries and directory entries in the same policy.

**Evidence:** `writer takeover does not interpret a not-yet-synced file as a deletion` in [sync-edge-cases.mjs](../../scripts/collab/audit/sync-edge-cases.mjs), X02.

### G03 — P1: remote takedown returns an older local notebook

**Location:** [remote owner revocation](../../electron/collab/notebooks/service.ts), [local removal](../../electron/collab/notebooks/service.ts), [runtime stop](../../electron/collab/notebooks/project.ts).

The initiating takedown waits for `whenIdle()`, but an owner receiving deletion from another device goes directly to `removeLocally()`. `stop()` cancels debounced materialization timers; cleanup then removes the marker and project/path mapping. The resulting ordinary notebook can therefore contain older disk text even though newer text was acknowledged by the server.

**Reproduction:** save `latest\noriginal\n` through a host with a pending disk debounce, wait for server acknowledgement, and delete the project through another device's API. Local cleanup completes and the marker disappears, but `note.md` still contains **`original\n`**. The newer text remains in the hub/SQLite; it is not irretrievably erased, but it is detached from the normal notebook and recovery mapping.

**Correction:** stop new shared mutations, flush/export the current hub content (preserving external conflicts), then remove lifecycle markers/mappings. Apply that ordering on receiving devices and followers, not only the device requesting takedown. Do not use `whenIdle()` after canceling timers that it expects to drain.

**Evidence:** `remote takedown preserves text newer than the debounced disk copy`, X03.

### G04 — P2: a revoked follower can remain unable to delete its local copy

**Location:** [revocation marker write](../../electron/collab/notebooks/service.ts), [notebook deletion guard](../../src/lib/storage/notebooks.ts).

Revocation sets the follower's in-memory handle to revoked but only a writer updates the disk marker. Revoked handles are skipped by lease polling. If the former writer is off, no one necessarily delivers a revoked marker to this independent cloud copy. `deleteNotebook()` consults the unrevoked marker and still throws `shared-document`, despite the host already reporting access ended.

**Reproduction:** join as a member, copy that folder to another root and adopt it as a follower, stop the original writer, then remove the account before its follower's next takeover. The follower reports `revoked: true`, while its local marker has **no `revoked` field**. That is the exact marker condition that blocks local notebook deletion. This test checks the marker/guard disagreement rather than invoking the full Next storage route.

**Correction:** expose durable, account-scoped local recovery/deletion state independent of a former writer's eventual marker delivery. Ensure local deletion is allowed after confirmed revocation without overwriting a newer project's marker.

**Evidence:** `revoked follower can delete its local notebook without its former writer`, X04. This was a remaining variant of the deletion-lock problem described in the request; G04 closes it.

### G05 — P2: an empty notebook taken down while a device is stopped stays shared on return

**Location:** [not-found handling](../../electron/collab/core/doc-hub.ts), [lease handling](../../electron/collab/notebooks/service.ts), and existing-project loading in the notebook service.

The not-found branch only marks access revoked if the hub has previous server sequence/data. A truly empty manifest can have sequence zero and no stored updates. After restart it has neither indicator, even though the local projects table and marker prove this is an established share. Lease lookup confirms the project is absent but does not complete lifecycle cleanup; marker adoption skips projects already in the store.

**Reproduction:** share an empty folder, close the device, take down the project through another device, and reopen the first device. Its local project remains **owner / revoked: false**, the marker remains, and manifest metadata stays at **server sequence 0 / readOnlyReason: null**, despite server 404 responses.

**Correction:** distinguish known local projects from unknown document IDs independently of update count. Reconcile a confirmed project 404 into the owner's local notebook state even when no content update ever existed.

**Evidence:** `a returning device cleans up an empty notebook taken down while it was stopped`, X05. This was another concrete deletion-lock variant; G05 closes it.

### G06 — P1: accepting a new invitation does not restore revoked hubs

**Location:** [join after revocation](../../electron/collab/notebooks/service.ts), hub sync eligibility in [doc-hub](../../electron/collab/core/doc-hub.ts), and [project access restoration](../../electron/collab/core/host.ts).

The join flow creates a fresh folder and active project handle but reuses the old document IDs. Their persisted hub metadata still says `access-revoked`; no join path clears it. `canSync()` therefore remains false. Cached CRDT data can make the join return success and `materialized: true`, hiding that the notebook is no longer live. Restarting preserves the same metadata.

**Reproduction:** remove an editor, wait for revocation, send a fresh invitation and accept it. Join returns **200**, role **editor**, `materialized: true`, in a new folder. The document still has **`readOnlyReason: access-revoked`**, and **`canSync() === false`**.

**Correction:** after fresh server authorization, reset/reopen the manifest and document hubs with current roles. Quarantine/export pre-revocation pending edits before re-enabling outbound synchronization; indiscriminately clearing flags and replaying old work needs its own test.

**Evidence:** `rejoining after removal clears the persisted access revocation`, X06.

### G07 — P2: an upload completing after a rename restores the old path

**Location:** [write-blob](../../electron/collab/notebooks/project.ts), particularly the manifest entry selected before upload; analogous captured-entry updates occur in disk scanning.

Blob replacement captures the entire manifest entry before awaiting HTTP upload. Remote manifest updates can arrive during that wait, even though local project tasks use a queue. Once upload completes, the host writes/publishes the captured old path with the new hash. The queue serializes local tasks but does not stop remote Yjs mutation.

**Reproduction:** delay a replacement upload for `image.png`, rename that file to `renamed.png` from another member, wait until the rename reaches the uploading host's manifest, then release upload. The completed replacement publishes **`image.png`**, undoing the completed rename. Blob deletion during upload is now separately tested: the late replacement returns a conflict and does not restore the entry.

**Correction:** re-read the current entry by stable file ID after upload; verify it still exists and apply only intended fields to its current path/version. Do not write disk bytes at the captured old path. Preserve conflicting replacement input if the target disappeared.

**Evidence:** `a delayed blob replacement respects a completed remote rename`, X07.

### G08 — P2: an in-flight download recreates a deleted notebook without its marker

**Location:** [placeBlob](../../electron/collab/notebooks/project.ts), especially its download/write sequence; [atomic write](../../electron/collab/notebooks/fs-ops.ts) previously created parent directories recursively.

The runtime checks root identity before its manifest pass, then can await a slow blob download. It does not check root identity again before writing. Deleting the root during that wait causes `writeFileAtomic()` to recreate it. The folder now contains shared bytes but no marker, so the host and ordinary storage guards disagree about its identity.

**Reproduction:** hold a member's replacement-blob download, remove its notebook root, then release the download. **Root exists: true; downloaded file exists: true; marker exists: false.** This also explains the root-recreation symptom seen in the existing lifecycle suite during this review. The follow-up replacement-root regression also passes: the foreign marker and bytes remain untouched.

**Correction:** fence delayed disk commits by runtime/folder generation and writer status; validate identity immediately before commit and avoid creating a missing notebook root as part of ordinary materialization. Apply the same rule to marker, base and state writes.

**Evidence:** `an in-flight blob download never recreates a deleted notebook root`, X08.

### G09 — P2: a live role change does not update document/editor permissions

**Location:** [setRole](../../electron/collab/notebooks/service.ts), [renderer permission check](../../src/lib/collab/client/replica.ts), [registry rebind](../../src/lib/collab/client/registry.ts).

The membership event updates the service handle, runtime role and projects table, but not the open hubs' metadata or attached replicas. Renderer editability uses replica metadata. Re-resolving the path does not replace a session with the same document ID. A downgraded editor can continue typing until rejection/rollback; a promotion can leave the editor read-only until a reopen/reconnect refreshes metadata.

**Reproduction:** downgrade a connected editor to viewer. Path resolution reports **viewer / readOnly: true**, while its held document hub reports **editor / readOnly: false** after the role event has arrived. The original reproduction checked downgrade; the regression now also checks promotion back to editor.

**Correction:** update current role/read-only metadata on every affected hub and broadcast to replicas (or deliberately reopen them); keep pending edits recoverable across the transition. Test both promotion and demotion while an editor is mounted.

**Evidence:** `live role changes reach document metadata used by the editors`, X09.

### G10 — P1: one transient persistence failure can stall a batch on a healthy connection

**Location:** server update error handling in [session](../../server/src/sync/session.ts), [client error dispatch](../../electron/collab/core/sync-client.ts), [hub handleError](../../electron/collab/core/doc-hub.ts), and the sent-batch set in [outbound](../../electron/collab/core/outbound.ts).

When persistence throws, the server sends an `internal` error and expects a resend after reconnect. The client only broadcasts that error. Its outbound queue considers the batch sent for the connection's lifetime; it has no acknowledgement timeout/retry for it. Successful pings and a normal nudge keep the socket alive, so the batch is never retried. The divergence checker skips pending documents, so it does not repair this condition.

**Reproduction:** use the existing encoded-frame fake server to swallow one update and send the same `internal` error as the real persistence catch. Advance two minutes of successful ping/pong traffic and nudge. Result: **connection connected; pending 1; sends 1; server text empty**. Real database failure injection is not part of this client reproduction; the real server's error path was inspected.

**Correction:** retry the same persisted batch safely after transient errors, or reconnect/reopen the affected document with bounded backoff and an acknowledgement deadline. Preserve client sequence and bytes for deduplication; distinguish transient failures from permissions/schema rejections.

**Evidence:** `an internal save error retries on an otherwise healthy connection`, X10.

## Validation and reproduction

The checked-in audit scripts assert the required behavior and now pass. A normal-suite wrapper runs all desktop cases; the normal server suite covers the authorization races directly. They use temporary libraries/databases and local test servers, without connecting to production or changing application data.

From the repository root:

```sh
node --require ./scripts/editor/setup.cjs --import tsx --test \
  scripts/collab/audit/sync-edge-cases.mjs \
  scripts/collab/audit/server-membership-race.mjs
```

The desktop script contains nine independent scenarios; the server script contains one. Node also counts the parent desktop test, so the standalone command reports eleven passing tests for the ten original scenarios.

Original review baseline (before fixes):

| Selection | Result | Qualification |
|---|---|---|
| Server auth, projects, sync documents, connections, rooms, compaction and API/sync integration | **60 passed** | Real local server/PGlite; no production Postgres, S3, or distributed deployment. |
| Notebook guard/lifecycle/reconciliation/share retry/sync/synced folders/synced peers/takedown/tree/unit suites plus offline comments | **51 passed; 2 aggregate failures** | One leaf failure: `deleting the local notebook folder does not delete its shared files` recreated the root; the parent test accounts for the second failure. G08 separately reproduces root recreation with a controlled download. |
| First sandboxed selection including host-sync and shared-sign-in | **64 passed; 9 could not run** | The nine integration failures were loopback `listen EPERM`, then rerun with local-network permission in the selection above. They are not counted as product failures. |
| New audit cases | **10 distinct required behaviors fail** | Nine desktop/client cases and one server permission race, as detailed above. |

At the original review, no full-app build, full repository test suite, live Electron UI test, real OneDrive/iCloud propagation, multi-process production Postgres race, or OS/network-filesystem matrix was performed. The source and test review covered the notebook service/materializer/watcher, marker/state/lease logic, storage guards, account/grant lifecycle, hub/queue/reconnect path, server admission/membership/manifest/tombstone/blob handling, and relevant existing tests. Album-specific retention, all editor bridges, and unrelated feature sidecars were not exhaustively audited.

### Post-fix validation

| Check | Result | Scope / qualification |
|---|---|---|
| Original ten findings | **All ten scenarios pass** | Nine desktop cases plus the standalone real-server membership race. The normal server suite additionally checks demotion and commit-time denial. |
| Focused final sync run | **36 passed** | Normal-suite desktop regressions, recovery/transfer fencing, and host-sync including missing acknowledgements. |
| Full server suite | **161 passed** | Local PGlite and real HTTP/WebSocket test servers; no production Postgres or distributed deployment. |
| Full collaboration client suite | **476 passed; 11 failed** | Includes the new regressions. Failures and the terminated benchmark are detailed below; this is not a clean full-suite result. |
| Typechecks | **Server and scoped client checks pass** | The scoped check includes application source, collaboration host and collaboration tests. The repository-wide check reports eight diagnostics in unchanged editor tests. |
| Host bundle and targeted lint | **Pass** | `npm run collab:build-host` and ESLint for changed desktop source/tests and audit scripts. |

The broader client run used `node --require ./scripts/editor/setup.cjs --import tsx --test --test-concurrency=3 scripts/collab/*.test.ts`. Its eleven failed test counts consist of:

- Seven counts in the unchanged review UI suite (six subtests plus their parent). The initial request dialog never closes; subsequent cases cannot find the missing review. The standalone rerun also fails. The request-button helper searches the whole document and can select the toolbar trigger before the dialog submit button.
- One sandbox/preload assertion: its expected API list omits the existing `liberaReferences` API. Neither the preload nor its test was changed for these fixes.
- Two unchanged Tiptap undo tests, also failing when run on their own. Their editor bridge does not use the host/materializer files changed here.
- One performance-test file terminated after several minutes of CPU use in Node's native environment cleanup. A process sample showed `FreeEnvironment` / `CleanupHandles` / `uv_run`, without application JavaScript. Its benchmark result is **inconclusive**.

The eight repository-wide type diagnostics are in `document-chat-panel`, `document-ocr-loop`, `pdf-outline-panel`, `pdf-text-layer-styles`, `tab-lifecycle`, and `workspace-panel-performance` editor tests. They remain outside these sync fixes. No full Next/Electron distribution build, real OneDrive/iCloud run, production Postgres concurrency test, or cross-platform filesystem matrix was completed. The remaining interaction rows below continue to require separate verification.

## Remaining unverified combinations

G01–G10 are closed by the fixes and original regressions above. The next review tested X13–X18 and identified nine more findings (G11–G19), now also fixed: expired-writer deletes, incomplete scans, corrupt metadata, stale rollback, missed overwrites, moved roots, and late-marker deletion locks. See the [follow-up report](2026-11-01-notebook-sync-follow-up.md) for the implemented corrections and evidence, and the updated [feature matrix](../features/notebook-sync.md#interaction-matrix-and-coverage) for passing controls and combinations still unverified. Durable local lifecycle records now preserve deletion-unlock decisions across stale marker delivery as well as immediate cleanup.
